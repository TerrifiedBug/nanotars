/**
 * Container Mount Building for NanoClaw
 * Constructs the volume mount list for agent containers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import type { PluginRegistry } from './plugin-loader.js';

/** Verify that a resolved path stays within the expected parent directory. */
function assertPathWithin(resolved: string, parent: string, label: string): void {
  const normalizedResolved = path.resolve(resolved);
  const normalizedParent = path.resolve(parent);
  if (!normalizedResolved.startsWith(normalizedParent + path.sep) && normalizedResolved !== normalizedParent) {
    throw new Error(`Path traversal blocked: ${label} resolved to ${normalizedResolved} outside ${normalizedParent}`);
  }
}

/** Replace or append an env line by key. */
function upsertEnvLine(lines: string[], key: string, value: string): void {
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
}

/** Parse .env file content into a Map of key → raw line. */
function parseEnvLines(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    entries.set(key, trimmed);
  }
  return entries;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

let pluginRegistry: PluginRegistry | null = null;

/** Cached global .env parse — file doesn't change during process lifetime. */
let globalEnvCache: Map<string, string> | null = null;

/** Set the plugin registry for dynamic env vars and skill mounting */
export function setPluginRegistry(registry: PluginRegistry): void {
  pluginRegistry = registry;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export async function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  modelOverride?: string,
): Promise<VolumeMount[]> {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  // Core agent skills — mount each subdirectory individually so plugin skill
  // mounts can coexist (mounting the parent as read-only blocks child mounts)
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  if (await fileExists(skillsDir)) {
    for (const entry of await fs.promises.readdir(skillsDir)) {
      const entryPath = path.join(skillsDir, entry);
      if ((await fs.promises.stat(entryPath)).isDirectory()) {
        mounts.push({
          hostPath: entryPath,
          containerPath: `/workspace/.claude/skills/${entry}`,
          readonly: true,
        });
      }
    }
  }

  // Plugin skill directories — each plugin's container-skills/ mounted individually
  // Scoped by channel and group so plugins only inject into matching containers
  const scopeChannel = group.channel;
  const scopeGroup = group.folder;
  const mcpJsonFile = path.join(projectRoot, '.mcp.json');
  if (pluginRegistry) {
    for (const sp of pluginRegistry.getSkillPaths(scopeChannel, scopeGroup)) {
      mounts.push({
        hostPath: sp.hostPath,
        containerPath: `/workspace/.claude/skills/${sp.name}`,
        readonly: true,
      });
    }

    // Plugin container hooks — JS files loaded by agent-runner at startup
    for (const hp of pluginRegistry.getContainerHookPaths(scopeChannel, scopeGroup)) {
      mounts.push({
        hostPath: hp.hostPath,
        containerPath: `/workspace/plugin-hooks/${hp.name}`,
        readonly: true,
      });
    }

    // Plugin-declared container mounts (read-only, validated against allowlist)
    const pluginMounts = pluginRegistry.getContainerMounts(scopeChannel, scopeGroup);
    if (pluginMounts.length > 0) {
      const validated = validateAdditionalMounts(
        pluginMounts.map(pm => ({ hostPath: pm.hostPath, containerPath: pm.containerPath, readonly: true })),
        group.name,
        isMain,
      );
      mounts.push(...validated);
    }

    // MCP server config — merge root .mcp.json with plugin mcp.json fragments
    const mergedMcp = pluginRegistry.getMergedMcpConfig(mcpJsonFile, scopeChannel, scopeGroup);
    if (Object.keys(mergedMcp.mcpServers).length > 0) {
      const mergedMcpDir = path.join(DATA_DIR, 'env', group.folder);
      await fs.promises.mkdir(mergedMcpDir, { recursive: true });
      const mergedMcpPath = path.join(mergedMcpDir, 'merged-mcp.json');
      await fs.promises.writeFile(mergedMcpPath, JSON.stringify(mergedMcp, null, 2));
      mounts.push({
        hostPath: mergedMcpPath,
        containerPath: '/workspace/.mcp.json',
        readonly: true,
      });
    }
  } else if (await fileExists(mcpJsonFile)) {
    mounts.push({
      hostPath: mcpJsonFile,
      containerPath: '/workspace/.mcp.json',
      readonly: true,
    });
  }

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json) which would bypass the sandbox on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    const mainGroupPath = path.join(GROUPS_DIR, group.folder);
    assertPathWithin(mainGroupPath, GROUPS_DIR, 'main group mount');
    mounts.push({
      hostPath: mainGroupPath,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    const groupPath = path.join(GROUPS_DIR, group.folder);
    assertPathWithin(groupPath, GROUPS_DIR, 'group mount');
    mounts.push({
      hostPath: groupPath,
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Global directory (read-only) — available to all groups for IDENTITY.md and shared config
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (await fileExists(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const sessionsBase = path.join(DATA_DIR, 'sessions');
  const groupSessionsDir = path.join(
    sessionsBase,
    group.folder,
    '.claude',
  );
  assertPathWithin(groupSessionsDir, sessionsBase, 'sessions dir');
  await fs.promises.mkdir(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!(await fileExists(settingsFile))) {
    await fs.promises.writeFile(settingsFile, JSON.stringify({
      env: {
        // Enable agent swarms (subagent orchestration)
        // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        // Load CLAUDE.md from additional mounted directories
        // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        // Enable Claude's memory feature (persists user preferences between sessions)
        // https://code.claude.com/docs/en/memory#manage-auto-memory
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Clean stale skills from session directory — all skills are now
  // delivered via plugin bind-mounts at /workspace/.claude/skills/
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (await fileExists(skillsDst)) {
    await fs.promises.rm(skillsDst, { recursive: true });
  }

  // Clean up stale credentials copy from pre-bind-mount era
  const staleCredsFile = path.join(groupSessionsDir, '.credentials.json');
  if (await fileExists(staleCredsFile)) {
    try { await fs.promises.unlink(staleCredsFile); } catch { /* non-fatal */ }
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Bind mount host credentials directly so containers always have the freshest token.
  // File-level mount overlays the directory mount at this specific path.
  // Must be read-write: the SDK needs write access to refresh tokens and update auth state.
  const hostCredsFile = path.join(getHomeDir(), '.claude', '.credentials.json');
  if (await fileExists(hostCredsFile)) {
    mounts.push({
      hostPath: hostCredsFile,
      containerPath: '/home/node/.claude/.credentials.json',
      readonly: false,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const ipcBase = path.join(DATA_DIR, 'ipc');
  const groupIpcDir = path.join(ipcBase, group.folder);
  assertPathWithin(groupIpcDir, ipcBase, 'IPC dir');
  await fs.promises.mkdir(path.join(groupIpcDir, 'messages'), { recursive: true });
  await fs.promises.mkdir(path.join(groupIpcDir, 'tasks'), { recursive: true });
  await fs.promises.mkdir(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file directory (workaround for Apple Container -i env var bug)
  // Only expose specific auth variables needed by Claude Code, not the entire .env
  // Per-group directory prevents race conditions during concurrent container spawns
  await buildEnvMount(mounts, group, modelOverride, projectRoot);

  // Mount agent-runner source from host — recompiled on container startup.
  // Allows code changes without rebuilding the Docker image.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/** Build the per-group env file mount with filtered variables and model overrides. */
async function buildEnvMount(
  mounts: VolumeMount[],
  group: RegisteredGroup,
  modelOverride: string | undefined,
  projectRoot: string,
): Promise<void> {
  const envDir = path.join(DATA_DIR, 'env', group.folder);
  await fs.promises.mkdir(envDir, { recursive: true });

  // Parse global .env (cached — doesn't change during process lifetime)
  if (globalEnvCache === null) {
    const envFile = path.join(projectRoot, '.env');
    if (await fileExists(envFile)) {
      globalEnvCache = parseEnvLines(await fs.promises.readFile(envFile, 'utf-8'));
    } else {
      globalEnvCache = new Map();
    }
  }
  // Clone so group overlays don't mutate the cache
  const envMap = new Map(globalEnvCache);
  const groupEnvFile = path.join(GROUPS_DIR, group.folder, '.env');
  try {
    for (const [key, line] of parseEnvLines(await fs.promises.readFile(groupEnvFile, 'utf-8'))) {
      envMap.set(key, line);
    }
  } catch {
    // No group .env — use global only
  }
  if (envMap.size === 0) return;

  const allowedVars = pluginRegistry
    ? pluginRegistry.getContainerEnvVars(group.channel, group.folder)
    : ['ANTHROPIC_API_KEY', 'ASSISTANT_NAME', 'CLAUDE_MODEL'];
  const filteredLines = [...envMap.entries()]
    .filter(([key]) => allowedVars.includes(key))
    .map(([, line]) => line);

  // Override CLAUDE_MODEL from store file if it exists (set via /set-model skill)
  const modelFile = path.join(projectRoot, 'store', 'claude-model');
  if (await fileExists(modelFile)) {
    const model = (await fs.promises.readFile(modelFile, 'utf-8')).trim();
    if (model) upsertEnvLine(filteredLines, 'CLAUDE_MODEL', model);
  }

  // Per-task model override takes highest priority
  if (modelOverride) {
    upsertEnvLine(filteredLines, 'CLAUDE_MODEL', modelOverride);
  }

  // Quote env values to prevent shell injection (# truncation, $() execution, etc.)
  const quotedLines = filteredLines.map((line) => {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) return line;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    const escaped = value.replace(/'/g, "'\\''");
    return `${key}='${escaped}'`;
  });

  if (quotedLines.length > 0) {
    await fs.promises.writeFile(
      path.join(envDir, 'env'),
      quotedLines.join('\n') + '\n',
    );
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  }
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
export function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}
