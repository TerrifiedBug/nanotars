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

let pluginRegistry: PluginRegistry | null = null;

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

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  modelOverride?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  // Core agent skills — mount each subdirectory individually so plugin skill
  // mounts can coexist (mounting the parent as read-only blocks child mounts)
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      const entryPath = path.join(skillsDir, entry);
      if (fs.statSync(entryPath).isDirectory()) {
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
  if (pluginRegistry) {
    for (const sp of pluginRegistry.getSkillPaths(scopeChannel, scopeGroup)) {
      const containerSkillPath = `/workspace/.claude/skills/${sp.name}`;
      mounts.push({
        hostPath: sp.hostPath,
        containerPath: containerSkillPath,
        readonly: true,
      });
    }
  }

  // Plugin container hooks — JS files loaded by agent-runner at startup
  if (pluginRegistry) {
    for (const hp of pluginRegistry.getContainerHookPaths(scopeChannel, scopeGroup)) {
      mounts.push({
        hostPath: hp.hostPath,
        containerPath: `/workspace/plugin-hooks/${hp.name}`,
        readonly: true,
      });
    }
  }

  // Plugin-declared container mounts (read-only)
  if (pluginRegistry) {
    for (const pm of pluginRegistry.getContainerMounts(scopeChannel, scopeGroup)) {
      mounts.push({
        hostPath: pm.hostPath,
        containerPath: pm.containerPath,
        readonly: true,
      });
    }
  }

  // MCP server config — merge root .mcp.json with plugin mcp.json fragments
  const mcpJsonFile = path.join(projectRoot, '.mcp.json');
  if (pluginRegistry) {
    const mergedMcp = pluginRegistry.getMergedMcpConfig(mcpJsonFile, scopeChannel, scopeGroup);
    if (Object.keys(mergedMcp.mcpServers).length > 0) {
      const mergedMcpDir = path.join(DATA_DIR, 'env', group.folder);
      fs.mkdirSync(mergedMcpDir, { recursive: true });
      const mergedMcpPath = path.join(mergedMcpDir, 'merged-mcp.json');
      fs.writeFileSync(mergedMcpPath, JSON.stringify(mergedMcp, null, 2));
      mounts.push({
        hostPath: mergedMcpPath,
        containerPath: '/workspace/.mcp.json',
        readonly: true,
      });
    }
  } else if (fs.existsSync(mcpJsonFile)) {
    mounts.push({
      hostPath: mcpJsonFile,
      containerPath: '/workspace/.mcp.json',
      readonly: true,
    });
  }

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Global directory (read-only) — available to all groups for IDENTITY.md and shared config
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
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
  if (fs.existsSync(skillsDst)) {
    fs.rmSync(skillsDst, { recursive: true });
  }

  // Sync host credentials for automatic OAuth token refresh
  // Claude Code SDK reads ~/.claude/.credentials.json natively and handles refresh
  const hostCredsFile = path.join(getHomeDir(), '.claude', '.credentials.json');
  if (fs.existsSync(hostCredsFile)) {
    const destCredsFile = path.join(groupSessionsDir, '.credentials.json');
    fs.copyFileSync(hostCredsFile, destCredsFile);
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file directory (workaround for Apple Container -i env var bug)
  // Only expose specific auth variables needed by Claude Code, not the entire .env
  // Per-group directory prevents race conditions during concurrent container spawns
  buildEnvMount(mounts, group, modelOverride, projectRoot);

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
function buildEnvMount(
  mounts: VolumeMount[],
  group: RegisteredGroup,
  modelOverride: string | undefined,
  projectRoot: string,
): void {
  const envDir = path.join(DATA_DIR, 'env', group.folder);
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (!fs.existsSync(envFile)) return;

  const envContent = fs.readFileSync(envFile, 'utf-8');
  const allowedVars = pluginRegistry
    ? pluginRegistry.getContainerEnvVars(group.channel, group.folder)
    : ['ANTHROPIC_API_KEY', 'ASSISTANT_NAME', 'CLAUDE_MODEL'];
  const filteredLines = envContent.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    return allowedVars.some((v) => trimmed.startsWith(`${v}=`));
  });

  // Override CLAUDE_MODEL from store file if it exists (set via /set-model skill)
  const modelFile = path.join(projectRoot, 'store', 'claude-model');
  if (fs.existsSync(modelFile)) {
    const model = fs.readFileSync(modelFile, 'utf-8').trim();
    if (model) {
      const idx = filteredLines.findIndex((l) => l.trim().startsWith('CLAUDE_MODEL='));
      if (idx >= 0) filteredLines[idx] = `CLAUDE_MODEL=${model}`;
      else filteredLines.push(`CLAUDE_MODEL=${model}`);
    }
  }

  // Per-task model override takes highest priority
  if (modelOverride) {
    const idx = filteredLines.findIndex((l) => l.trim().startsWith('CLAUDE_MODEL='));
    if (idx >= 0) filteredLines[idx] = `CLAUDE_MODEL=${modelOverride}`;
    else filteredLines.push(`CLAUDE_MODEL=${modelOverride}`);
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
    fs.writeFileSync(
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
