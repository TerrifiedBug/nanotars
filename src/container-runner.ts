/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC.
 */
import { ChildProcess, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  INSTALL_SLUG,
  ONECLI_API_KEY,
  ONECLI_URL,
} from './config.js';
import { buildVolumeMounts, getHomeDir, readSecrets, VolumeMount } from './container-mounts.js';
import * as containerRuntime from './container-runtime.js';
import { getAgentGroupById, updateAgentGroupContainerConfig } from './db/agent-groups.js';
import { generateAgentGroupDockerfile } from './image-build.js';
import { logger } from './logger.js';
import { redactSecrets } from './secret-redact.js';
import type { AgentGroup, ContainerConfig } from './types.js';

import { createOutputParser, makeMarkers, OUTPUT_START_MARKER, OUTPUT_END_MARKER } from './output-parser.js';
import {
  getProviderContainerConfig,
  resolveProviderName,
} from './providers/provider-container-registry.js';
import {
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from './permissions/user-roles.js';

/**
 * Per-agent-group image tag prefix. Mirrors the install-slug naming used for
 * the base image so multi-install hosts don't collide. Example tags:
 *   nanoclaw-agent:<groupId>                  (default install)
 *   nanoclaw-<slug>-agent:<groupId>           (slugged install)
 */
export const CONTAINER_IMAGE_BASE = INSTALL_SLUG
  ? `nanoclaw-${INSTALL_SLUG}-agent`
  : 'nanoclaw-agent';

// OneCLI gateway client — module-scoped so it's initialized once per host
// process and reused across container spawns.
const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// Re-export for consumers that still import from container-runner
export { setPluginRegistry, VolumeMount } from './container-mounts.js';
export { AvailableGroup, mapTasksToSnapshot, writeGroupsSnapshot, writeTasksSnapshot } from './snapshots.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;
  secrets?: Record<string, string>;
  outputNonce?: string;
  taskScript?: string;
  taskId?: string;
  /**
   * Phase 5E: optional resolved user id for the sender that triggered this
   * container spawn. When present, the host computes admin status against
   * the agent group and injects `NANOCLAW_IS_ADMIN=1` so admin-only MCP
   * tools (e.g. `create_agent`) register inside the container. Scheduled
   * tasks omit this — they default to `NANOCLAW_IS_ADMIN=0`.
   */
  senderUserId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  resumeAt?: string;
  error?: string;
}

/** Resolve a container promise from a streaming parser's settled state. */
function resolveFromParser(
  parser: { settled(): Promise<void>; newSessionId: string | undefined },
  resolve: (output: ContainerOutput) => void,
  groupName: string,
  errorContext: string,
  onSuccess?: () => void,
): void {
  parser.settled().then(() => {
    onSuccess?.();
    resolve({ status: 'success', result: null, newSessionId: parser.newSessionId });
  }).catch((err) => {
    logger.error({ group: groupName, err }, errorContext);
    resolve({ status: 'error', result: null, error: String(err) });
  });
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
  group?: AgentGroup,
  senderUserId?: string,
): Promise<string[]> {
  const args: string[] = [
    'run', '-i', '--rm', '--name', containerName,
    '--label', `nanoclaw.install=${INSTALL_SLUG}`,
    ...containerRuntime.extraRunArgs(),
  ];

  // Phase 5A: pass the agent group's provider into the container.
  // Resolution: agent_groups.agent_provider → 'claude' fallback. Container's
  // resolveProviderNameFromEnv() reads this at startup.
  const providerName = resolveProviderName(group?.agent_provider);
  args.push('-e', `NANOCLAW_AGENT_PROVIDER=${providerName}`);

  // Phase 5E: gate admin-only container-side MCP tools (e.g. `create_agent`)
  // on the sender's role at spawn time. Defaults to '0' for scheduled tasks
  // and any path where senderUserId is not threaded through. The host re-
  // validates admin status when the IPC payload arrives, so this flag only
  // controls whether the tool is *visible* to the agent — not whether the
  // action is *authorized*.
  let isAdmin = false;
  if (senderUserId && group) {
    isAdmin =
      isOwner(senderUserId) ||
      isGlobalAdmin(senderUserId) ||
      isAdminOfAgentGroup(senderUserId, group.id);
  }
  args.push('-e', `NANOCLAW_IS_ADMIN=${isAdmin ? '1' : '0'}`);

  // Allow non-default providers to contribute extra mounts/env (Codex,
  // OpenCode, Ollama plugins). Default 'claude' has no contribution.
  if (group) {
    const contributor = getProviderContainerConfig(providerName);
    if (contributor) {
      try {
        const contrib = contributor({
          agentGroupId: group.id,
          groupFolder: group.folder,
          hostEnv: process.env,
        });
        for (const m of contrib.mounts ?? []) {
          if (m.readonly) {
            args.push('--mount', `type=bind,source=${m.hostPath},target=${m.containerPath},readonly`);
          } else {
            args.push('-v', `${m.hostPath}:${m.containerPath}`);
          }
        }
        for (const [k, v] of Object.entries(contrib.env ?? {})) {
          args.push('-e', `${k}=${v}`);
        }
      } catch (err) {
        logger.warn({ provider: providerName, err }, 'Provider container-config contributor threw; ignoring');
      }
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + CA cert mount so outbound API
  // calls from the container are routed through the agent vault for
  // credential injection. Falls through silently when OneCLI is not
  // reachable; v1's existing readSecrets stdin pipe (below, in
  // runContainerAgent) is the no-OneCLI fallback for Anthropic creds, so
  // non-OneCLI installs keep working unchanged.
  try {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentIdentifier, identifier: agentIdentifier });
    }
    const applied = await onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: agentIdentifier,
    });
    if (applied) {
      logger.info({ containerName }, 'OneCLI gateway applied');
    } else {
      logger.warn({ containerName }, 'OneCLI gateway not applied — falling back to .env credentials');
    }
  } catch (err) {
    logger.warn({ containerName, err }, 'OneCLI gateway error — falling back to .env credentials');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Mask .env inside any project mount to prevent raw secret access.
  // Env vars are delivered via the filtered /workspace/env-dir/ mount.
  const projectMount = mounts.find(m => m.containerPath === '/workspace/project');
  if (projectMount) {
    const hostEnv = path.join(projectMount.hostPath, '.env');
    if (fs.existsSync(hostEnv)) {
      args.push(
        '--mount',
        'type=bind,source=/dev/null,target=/workspace/project/.env,readonly',
      );
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: AgentGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  channel?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Read model file once — used for both logging and buildVolumeMounts
  const storeModelFile = path.join(process.cwd(), 'store', 'claude-model');
  const storedModel = fs.existsSync(storeModelFile)
    ? fs.readFileSync(storeModelFile, 'utf-8').trim()
    : '';
  const effectiveModel = input.model || storedModel || 'sdk-default';

  // Parse the per-group container config (timeout, additionalMounts) — same
  // shape as orchestrator-side parsing. Invalid JSON is logged and ignored.
  let containerConfig: ContainerConfig | undefined;
  if (group.container_config) {
    try {
      containerConfig = JSON.parse(group.container_config) as ContainerConfig;
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        'Failed to parse agent_groups.container_config; using defaults',
      );
    }
  }

  const mounts = await buildVolumeMounts(group, input.isMain, input.model || storedModel || undefined, channel);

  // Fix permissions on writable mounts (Docker only — Apple Container handles this natively)
  await Promise.all(
    mounts.filter(m => !m.readonly).map(m => containerRuntime.fixMountPermissions(m.hostPath)),
  );

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // agentIdentifier is the group folder — stable across container restarts
  // and unique per agent group, matching v1's per-group keying.
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    group.folder,
    group,
    input.senderUserId,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
      model: effectiveModel,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = containerRuntime.run(containerArgs);

    onProcess(container, containerName);

    let stderr = '';
    let stderrTruncated = false;

    // Create log file and stream early so stdout is written to disk, not RAM
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `container-${timestamp}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'w' });
    let stdoutSize = 0;

    // Generate per-run nonce for output markers (prevents injection)
    const outputNonce = crypto.randomBytes(16).toString('hex');
    input.outputNonce = outputNonce;
    const noncedMarkers = makeMarkers(outputNonce);

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;
    delete input.outputNonce;

    let timedOut = false;
    let settled = false;  // Guard: only one of timeout/close handles cleanup
    const configTimeout = containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      if (settled) return;  // close handler already ran
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      containerRuntime.stop(containerName, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Streaming output parser (only created when onOutput is provided)
    const parser = onOutput
      ? createOutputParser({
          onOutput,
          onActivity: () => resetTimeout(),
          onParseError: (err) => {
            logger.warn({ group: group.name, error: err }, 'Failed to parse streamed output chunk');
          },
        }, noncedMarkers)
      : null;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdoutSize += chunk.length;

      // Write to log file (no size limit — disk is cheaper than RAM)
      logStream.write(chunk);

      // Stream-parse for output markers
      parser?.feed(chunk);
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      clearTimeout(timeout);
      settled = true;  // Prevent timeout from running cleanup
      logStream.end();
      const duration = Date.now() - startTime;

      // No credentials sync-back needed — credentials file is bind-mounted
      // directly from the host. SDK writes inside the container are immediately
      // visible on the host and vice versa.

      if (timedOut) {
        // Append timeout metadata to the existing log file
        fs.appendFileSync(logFile, [
          `\n=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${parser?.hadOutput ?? false}`,
        ].join('\n'));

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (parser?.hadOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          resolveFromParser(parser, resolve, group.name, 'Output chain error after timeout');
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      const isError = code !== 0;

      // Build metadata header — stdout is already in the log file from streaming
      const headerLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Size: ${stdoutSize} bytes`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      if (isVerbose || isError) {
        headerLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout (${stdoutSize} bytes) ===`,
        );
      } else {
        headerLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      // Read back the raw stdout from the log file, prepend metadata header,
      // then rewrite with redacted content
      const rawStdout = fs.readFileSync(logFile, 'utf-8');
      if (isVerbose || isError) {
        // Header already includes "=== Stdout ===" label; append the raw stdout
        fs.writeFileSync(logFile, redactSecrets(headerLines.join('\n') + '\n' + rawStdout));
      } else {
        // Non-verbose success: just write metadata (stdout stays out of logs)
        fs.writeFileSync(logFile, redactSecrets(headerLines.join('\n')));
      }
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        const stdout = rawStdout;
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: redactSecrets(stderr),
            stdout: redactSecrets(stdout.slice(-2000)),
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${redactSecrets(stderr.slice(-200))}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (parser) {
        resolveFromParser(parser, resolve, group.name, 'Output chain error on exit', () => {
          logger.info(
            { group: group.name, duration, newSessionId: parser.newSessionId },
            'Container completed (streaming mode)',
          );
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from file-backed stdout
      try {
        const stdout = rawStdout;
        // Extract JSON between nonce-based sentinel markers for robust parsing
        const startIdx = stdout.indexOf(noncedMarkers.start);
        const endIdx = stdout.indexOf(noncedMarkers.end);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + noncedMarkers.start.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout: rawStdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logStream.end();
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

/** @internal Test-only shim for unit tests — DO NOT use in production code. */
export const buildContainerArgsForTesting = buildContainerArgs;

/**
 * Phase 5B — build a per-agent-group image that layers apt/npm packages and
 * Dockerfile.partials on top of `CONTAINER_IMAGE` (the shared base, which
 * already has plugin partials baked in).
 *
 * IO surface (paired with the pure `generateAgentGroupDockerfile`):
 *  1. Read the group's container_config.
 *  2. Generate the per-group Dockerfile string.
 *  3. Write to a temp file under DATA_DIR.
 *  4. Spawn `<runtime> build -t nanoclaw-<slug>-agent:<groupId> -f <tmp> .`
 *  5. Persist the resulting tag back to container_config.imageTag.
 *
 * Throws when the agent group has nothing to build (no apt, no npm, no
 * partials) — callers should guard this before invoking.
 *
 * Build context is `process.cwd()` (the repo root) so partials referenced
 * by relative path resolve correctly during `docker build`.
 */
export async function buildAgentGroupImage(agentGroupId: string): Promise<string> {
  const ag = getAgentGroupById(agentGroupId);
  if (!ag) throw new Error(`Agent group not found: ${agentGroupId}`);

  const cfg: ContainerConfig = ag.container_config
    ? (JSON.parse(ag.container_config) as ContainerConfig)
    : {};
  const apt = cfg.packages?.apt ?? [];
  const npm = cfg.packages?.npm ?? [];
  const partials = cfg.dockerfilePartials ?? [];

  if (apt.length === 0 && npm.length === 0 && partials.length === 0) {
    throw new Error(
      'Nothing to build. Add apt/npm packages via install_packages, or set dockerfilePartials.',
    );
  }

  const dockerfile = generateAgentGroupDockerfile({
    baseImage: CONTAINER_IMAGE,
    apt,
    npm,
    partials,
    projectRoot: process.cwd(),
  });

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);

  logger.info(
    { agentGroupId, imageTag, apt, npm, partials },
    'Building per-agent-group image',
  );
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    const cli = containerRuntime.cli();
    execSync(
      `${cli} build -t ${imageTag} --label nanoclaw.agent_group=${agentGroupId} -f ${tmpDockerfile} .`,
      { cwd: process.cwd(), stdio: 'pipe', timeout: 300_000 },
    );
  } finally {
    try {
      fs.unlinkSync(tmpDockerfile);
    } catch {
      /* best-effort cleanup */
    }
  }

  updateAgentGroupContainerConfig(agentGroupId, (c) => ({ ...c, imageTag }));
  logger.info({ agentGroupId, imageTag }, 'Per-agent-group image built');
  return imageTag;
}
