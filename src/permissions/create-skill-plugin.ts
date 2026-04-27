/**
 * Slice 6 — host-side handler for the `create_skill_plugin` IPC task emitted
 * by the container's `create_skill_plugin` MCP tool.
 *
 * Mirrors `add-mcp-server.ts` exactly. The container is not a trust boundary
 * against compromised agent containers, so all validation runs again here.
 *
 * Restricted archetypes: skill-only and mcp ONLY. Host-process hooks
 * (archetype 3) and container hooks (archetype 4) MUST be built on the host
 * via `/create-skill-plugin` because their JS code runs unattended (host
 * process or every agent turn) and warrants editor-grade review.
 *
 * Flow:
 *   1. Resolve the calling agent group from `groupFolder`.
 *   2. Validate the full payload (every rule from the spec).
 *   3. Filesystem-uniqueness: refuse if plugins/{name}/ or
 *      .claude/skills/add-skill-{name}/ already exists.
 *   4. Call `requestApproval({ action: 'create_skill_plugin', ... })`.
 *   5. On admin click, `applyDecision` writes files + restarts the
 *      originating group's container (Task 5).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getAgentGroupById,
  getAgentGroupByFolder,
} from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
  getPendingApproval,
  notifyAgent,
  registerApprovalHandler,
  requestApproval,
} from './approval-primitive.js';

/** Plugin name regex: lowercase, dash-separated, 2-31 chars. */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** Env var name regex: UPPER_SNAKE_CASE, 1-64 chars. */
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export const RESERVED_ENV_VAR_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ASSISTANT_NAME',
  'CLAUDE_MODEL',
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
]);

export const RESERVED_ENV_VAR_PREFIXES = ['NANOCLAW_', 'LD_', 'DYLD_', 'NODE_'];

export const ALLOWED_CHANNEL_NAMES = new Set([
  '*',
  'whatsapp',
  'discord',
  'telegram',
  'slack',
  'webhook',
]);

export const MAX_CONTAINER_SKILL_MD_BYTES = 20000;
export const MAX_MCP_JSON_BYTES = 4096;

const ALLOWED_ARCHETYPES = new Set(['skill-only', 'mcp']);

export interface CreateSkillPluginPluginJson {
  name: string;
  description: string;
  version: string;
  containerEnvVars?: string[];
  publicEnvVars?: string[];
  channels: string[];
  groups: string[];
  hooks?: string[];
  containerHooks?: string[];
  dependencies?: boolean;
}

export interface CreateSkillPluginRequestTask {
  name: string;
  description: string;
  archetype: 'skill-only' | 'mcp';
  pluginJson: CreateSkillPluginPluginJson;
  containerSkillMd: string;
  mcpJson?: string;
  envVarValues?: Record<string, string>;
  groupFolder: string;
}

interface ValidationFail {
  ok: false;
  error: string;
}
interface ValidationPass {
  ok: true;
}

/** Pure validator — returns ok/fail with reason. Used by the request handler. */
export function validateCreateSkillPluginPayload(
  task: CreateSkillPluginRequestTask,
  ctx: { projectRoot?: string } = {},
): ValidationFail | ValidationPass {
  const projectRoot = ctx.projectRoot ?? process.cwd();

  if (!PLUGIN_NAME_RE.test(task.name)) {
    return { ok: false, error: `invalid name "${task.name}"` };
  }
  if (!task.description || task.description.length < 1 || task.description.length > 200) {
    return { ok: false, error: `description length must be 1-200` };
  }
  if (!ALLOWED_ARCHETYPES.has(task.archetype)) {
    return { ok: false, error: `invalid archetype "${task.archetype}" (must be skill-only or mcp)` };
  }
  if (Array.isArray(task.pluginJson.hooks) && task.pluginJson.hooks.length > 0) {
    return { ok: false, error: 'pluginJson.hooks not allowed' };
  }
  if (Array.isArray(task.pluginJson.containerHooks) && task.pluginJson.containerHooks.length > 0) {
    return { ok: false, error: 'pluginJson.containerHooks not allowed' };
  }
  if (task.pluginJson.dependencies === true) {
    return { ok: false, error: 'pluginJson.dependencies=true not allowed' };
  }
  if (Buffer.byteLength(task.containerSkillMd, 'utf8') > MAX_CONTAINER_SKILL_MD_BYTES) {
    return { ok: false, error: `containerSkillMd exceeds ${MAX_CONTAINER_SKILL_MD_BYTES} bytes` };
  }
  if (task.mcpJson && Buffer.byteLength(task.mcpJson, 'utf8') > MAX_MCP_JSON_BYTES) {
    return { ok: false, error: `mcpJson exceeds ${MAX_MCP_JSON_BYTES} bytes` };
  }
  if (task.archetype === 'mcp' && !task.mcpJson) {
    return { ok: false, error: 'archetype=mcp requires mcpJson' };
  }
  if (task.envVarValues) {
    for (const name of Object.keys(task.envVarValues)) {
      if (!ENV_VAR_NAME_RE.test(name)) return { ok: false, error: `invalid env var name "${name}"` };
      if (RESERVED_ENV_VAR_NAMES.has(name)) return { ok: false, error: `env var "${name}" is reserved` };
      for (const prefix of RESERVED_ENV_VAR_PREFIXES) {
        if (name.startsWith(prefix)) return { ok: false, error: `env var prefix "${prefix}" is reserved` };
      }
    }
  }
  for (const ch of task.pluginJson.channels) {
    if (!ALLOWED_CHANNEL_NAMES.has(ch)) return { ok: false, error: `unknown channel "${ch}"` };
  }
  const groups = task.pluginJson.groups;
  const isWildcard = groups.length === 1 && groups[0] === '*';
  const isSelfOnly = groups.length > 0 && groups.every((g) => g === task.groupFolder);
  if (!isWildcard && !isSelfOnly) {
    return { ok: false, error: `groups must be ["*"] or ["${task.groupFolder}"]` };
  }
  // Filesystem uniqueness — relative to projectRoot
  const pluginDir = path.join(projectRoot, 'plugins', task.name);
  if (fs.existsSync(pluginDir)) {
    return { ok: false, error: `plugins/${task.name}/ already exists` };
  }
  const skillDir = path.join(projectRoot, '.claude', 'skills', `add-skill-${task.name}`);
  if (fs.existsSync(skillDir)) {
    return { ok: false, error: `.claude/skills/add-skill-${task.name}/ already exists` };
  }
  return { ok: true };
}

/**
 * Process a `create_skill_plugin` IPC task: validate + queue an approval card.
 * Returns the resulting `approvalId` on success; undefined when dropped.
 */
export async function handleCreateSkillPluginRequest(
  task: CreateSkillPluginRequestTask,
  originatingChannel: string,
): Promise<string | undefined> {
  const ag = getAgentGroupByFolder(task.groupFolder);
  if (!ag) {
    logger.warn(
      { folder: task.groupFolder },
      'create_skill_plugin dropped: agent group not found',
    );
    return undefined;
  }

  const v = validateCreateSkillPluginPayload(task);
  if (!v.ok) {
    notifyAgent(ag.id, `create_skill_plugin failed: ${v.error}`);
    logger.warn({ error: v.error, name: task.name, folder: task.groupFolder }, 'create_skill_plugin validation failed');
    return undefined;
  }

  const result = await requestApproval({
    action: 'create_skill_plugin',
    agentGroupId: ag.id,
    payload: {
      name: task.name,
      description: task.description,
      archetype: task.archetype,
      pluginJson: task.pluginJson,
      containerSkillMd: task.containerSkillMd,
      mcpJson: task.mcpJson,
      envVarValues: task.envVarValues,
    },
    originatingChannel,
  });

  logger.info(
    {
      approvalId: result.approvalId,
      agentGroupId: ag.id,
      pluginName: task.name,
      archetype: task.archetype,
      hasApprover: result.approvers.length > 0,
    },
    'create_skill_plugin approval queued',
  );
  return result.approvalId;
}

/** Deps the apply path needs at runtime (Task 5). */
export interface CreateSkillPluginDeps {
  /** Stop the active container for `folder` so the next inbound respawns. */
  restartGroup: (folder: string, reason: string) => Promise<void>;
}

/**
 * Write the plugin to disk in the order required by the spec, with rollback
 * if any non-restart step fails. Returns ok/error.
 */
async function writePluginFiles(
  task: {
    name: string;
    pluginJson: CreateSkillPluginPluginJson;
    containerSkillMd: string;
    mcpJson?: string;
    envVarValues?: Record<string, string>;
  },
  ctx: { projectRoot: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { projectRoot } = ctx;
  const pluginDir = path.join(projectRoot, 'plugins', task.name);
  const skillDir = path.join(projectRoot, '.claude', 'skills', `add-skill-${task.name}`);
  const skillFilesDir = path.join(skillDir, 'files');
  const groups = task.pluginJson.groups ?? ['*'];
  const targetEnvFile =
    groups.length === 1 && groups[0] !== '*'
      ? path.join(projectRoot, 'groups', groups[0], '.env')
      : path.join(projectRoot, '.env');

  let pluginsWritten = false;
  let skillsWritten = false;

  try {
    // 1. plugins/{name}/
    fs.mkdirSync(path.join(pluginDir, 'container-skills'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(task.pluginJson, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'container-skills', 'SKILL.md'),
      task.containerSkillMd.endsWith('\n') ? task.containerSkillMd : task.containerSkillMd + '\n',
    );
    if (task.mcpJson) {
      fs.writeFileSync(path.join(pluginDir, 'mcp.json'), task.mcpJson + '\n');
    }
    pluginsWritten = true;

    // 2. .claude/skills/add-skill-{name}/
    fs.mkdirSync(path.join(skillFilesDir, 'container-skills'), { recursive: true });
    const skillRootMd =
      `---\nname: add-skill-${task.name}\ndescription: Install the ${task.name} plugin (auto-generated by chat-driven creation).\n---\n\n# Install ${task.name}\n\nThis skill was generated automatically. Run \`/add-skill-${task.name}\` to install.\n`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillRootMd);
    fs.writeFileSync(
      path.join(skillFilesDir, 'plugin.json'),
      JSON.stringify(task.pluginJson, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(skillFilesDir, 'container-skills', 'SKILL.md'),
      task.containerSkillMd.endsWith('\n') ? task.containerSkillMd : task.containerSkillMd + '\n',
    );
    if (task.mcpJson) {
      fs.writeFileSync(path.join(skillFilesDir, 'mcp.json'), task.mcpJson + '\n');
    }
    skillsWritten = true;

    // 3. .env append (only if envVarValues present)
    if (task.envVarValues && Object.keys(task.envVarValues).length > 0) {
      fs.mkdirSync(path.dirname(targetEnvFile), { recursive: true });
      const lines = Object.entries(task.envVarValues)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      const existing = fs.existsSync(targetEnvFile) ? fs.readFileSync(targetEnvFile, 'utf8') : '';
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(targetEnvFile, existing + sep + lines + '\n');
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (skillsWritten) {
      try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
    if (pluginsWritten) {
      try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
    return { ok: false, error: msg };
  }
}

let _registeredDeps: CreateSkillPluginDeps | undefined;

/**
 * Register the `create_skill_plugin` approval handler. Pass `deps` to wire
 * the full apply path (write files + restart). Omit for render-only
 * registration (request-flow tests).
 */
export function registerCreateSkillPluginHandler(deps?: CreateSkillPluginDeps): void {
  _registeredDeps = deps;
  registerApprovalHandler('create_skill_plugin', {
    render({ payload }) {
      const name = (payload.name as string | undefined) ?? '<unknown>';
      const description = (payload.description as string | undefined) ?? '';
      const archetype = (payload.archetype as string | undefined) ?? 'unknown';
      const pluginJson = (payload.pluginJson ?? {}) as CreateSkillPluginPluginJson;
      const envVarValues = (payload.envVarValues as Record<string, string> | undefined) ?? {};
      const channels = pluginJson.channels?.join(', ') ?? '*';
      const groups = pluginJson.groups?.join(', ') ?? '*';

      const credLines = Object.entries(envVarValues).map(([k, v]) => {
        const masked = v.length <= 4 ? '****' : `${v.slice(0, 2)}****${v.slice(-2)}`;
        const dest =
          pluginJson.groups?.length === 1 && pluginJson.groups[0] !== '*'
            ? `groups/${pluginJson.groups[0]}/.env`
            : 'root .env';
        return `  ${k} = ${masked}   → ${dest}`;
      });
      const credsBlock =
        credLines.length === 0 ? 'Credentials: none' : `Credentials:\n${credLines.join('\n')}`;

      return {
        title: 'Create Skill Plugin Request',
        body:
          `TARS wants to install a new plugin: "${name}"\n\n` +
          `Description: ${description}\n\n` +
          `Archetype: ${archetype}\n` +
          `Channels: [${channels}]   Groups: [${groups}]\n\n` +
          `${credsBlock}\n\nRestart: per-group container only`,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      };
    },

    async applyDecision({ approvalId, payload, decision }) {
      const approval = getPendingApproval(approvalId);
      const agentGroupId =
        typeof approval?.agent_group_id === 'string' ? approval.agent_group_id : null;
      if (!agentGroupId) return;
      const ag = getAgentGroupById(agentGroupId);
      if (!ag) return;
      const name = (payload.name as string) ?? '<unknown>';

      if (decision === 'rejected' || decision === 'expired') {
        const verb = decision === 'expired' ? 'expired' : 'rejected';
        notifyAgent(agentGroupId, `create_skill_plugin ${verb} for "${name}". Plugin NOT installed.`);
        return;
      }
      if (decision !== 'approved') return;

      const writeResult = await writePluginFiles(
        {
          name,
          pluginJson: payload.pluginJson as CreateSkillPluginPluginJson,
          containerSkillMd: payload.containerSkillMd as string,
          mcpJson: payload.mcpJson as string | undefined,
          envVarValues: payload.envVarValues as Record<string, string> | undefined,
        },
        { projectRoot: process.cwd() },
      );
      if (!writeResult.ok) {
        notifyAgent(agentGroupId, `create_skill_plugin failed during install: ${writeResult.error}. No files written.`);
        return;
      }

      if (!_registeredDeps) {
        notifyAgent(agentGroupId, `Plugin "${name}" written; container will pick it up on next restart.`);
        return;
      }
      try {
        await _registeredDeps.restartGroup(ag.folder, 'create_skill_plugin applied');
        notifyAgent(agentGroupId, `Plugin "${name}" installed. Container restarting; tools will be live on next turn.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notifyAgent(
          agentGroupId,
          `Plugin "${name}" persisted but restart failed: ${msg}. It will load on the next normal restart.`,
        );
        logger.error({ err, agentGroupId, approvalId }, 'create_skill_plugin restart failed');
      }
    },
  });
}

/** Test-only helper: drive applyDecision directly without going through the click router. */
export async function applyDecisionForTest(
  approvalId: string,
  decision: 'approved' | 'rejected' | 'expired',
): Promise<void> {
  const approval = getPendingApproval(approvalId);
  if (!approval) throw new Error(`approval ${approvalId} not found`);
  const payload = JSON.parse(approval.payload as string);
  const { getApprovalHandler } = await import('./approval-primitive.js');
  const handler = getApprovalHandler('create_skill_plugin');
  if (!handler) throw new Error('create_skill_plugin handler not registered');
  await handler.applyDecision?.({ approvalId, payload, decision });
}
