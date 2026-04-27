/**
 * Phase 5C — `install_packages` / `add_mcp_server` MCP tools (container side).
 *
 * The agent calls these tools to ask the host to mutate its per-agent-group
 * container_config and (for install_packages) rebuild the per-group image
 * before the next spawn. Container writes an IPC payload to
 * `/workspace/ipc/<group>/tasks/`; host's `processTaskIpc` dispatches to
 * `permissions/install-packages.ts:handleInstallPackagesRequest` /
 * `permissions/add-mcp-server.ts:handleAddMcpServerRequest`, which validate,
 * queue an admin approval card via the Phase 4C primitive, and (on approve)
 * apply the change.
 *
 * Validation is duplicated host-side as defense in depth — the container is
 * not a trust boundary against compromised agent containers.
 *
 * Module is split out from `ipc-mcp-stdio.ts` so it can be unit-tested
 * without booting the full MCP stdio transport, mirroring the
 * `lifecycle.ts` / `create-agent.ts` shapes from Phase 5D / 5E.
 *
 * Fire-and-forget: the tool returns immediately. Decision (approve / reject /
 * timeout / error) is delivered back via the host's `notifyAgent` path — a
 * logger-warn stub today; wired to a real chat injection in 5C-05.
 */
import { z } from 'zod';

// ── install_packages ────────────────────────────────────────────────────────

/**
 * apt package names: lowercase alphanumeric, may contain `.`, `_`, `+`, `-`.
 * No version specs (`pkg=1.2.3`) and no shell metacharacters.
 */
export const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9._+-]*$/;
/**
 * npm package names: optional `@scope/` followed by lowercase alphanumeric
 * with `.`, `_`, `-`. No version specs (`pkg@1.2.3`).
 */
export const NPM_PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const MAX_PACKAGES = 20;

export const installPackagesInputSchema = {
  apt: z
    .array(z.string())
    .optional()
    .describe(
      'apt package names (lowercase, no version specs, no spaces). Example: ["curl", "ripgrep"]',
    ),
  npm: z
    .array(z.string())
    .optional()
    .describe(
      'npm packages to install globally (no version specs). Example: ["typescript", "@anthropic-ai/sdk"]',
    ),
  reason: z.string().describe('Why these packages are needed (surfaced on the approval card)'),
};

export const installPackagesInput = z.object(installPackagesInputSchema);

export type InstallPackagesInput = z.infer<typeof installPackagesInput>;

export interface InstallPackagesPayload {
  type: 'install_packages';
  apt: string[];
  npm: string[];
  reason: string;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

export interface ValidationError {
  ok: false;
  error: string;
}

export interface ValidationOk<T> {
  ok: true;
  payload: T;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationError;

/**
 * Validate + build the IPC payload for an `install_packages` request.
 *
 * Returns a discriminated result so the calling MCP-tool registration can
 * surface errors back to the agent as `isError: true` content. Pure function
 * so tests can pin the timestamp.
 */
export function buildInstallPackagesPayload(
  input: InstallPackagesInput,
  ctx: { groupFolder: string; isMain: boolean; now?: Date },
): ValidationResult<InstallPackagesPayload> {
  const apt = input.apt ?? [];
  const npm = input.npm ?? [];

  if (apt.length === 0 && npm.length === 0) {
    return { ok: false, error: 'at least one apt or npm package required' };
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    return {
      ok: false,
      error: `too many packages (max ${MAX_PACKAGES}; got ${apt.length + npm.length})`,
    };
  }
  const badApt = apt.find((p) => !APT_PACKAGE_RE.test(p));
  if (badApt !== undefined) {
    return { ok: false, error: `invalid apt package name: "${badApt}"` };
  }
  const badNpm = npm.find((p) => !NPM_PACKAGE_RE.test(p));
  if (badNpm !== undefined) {
    return { ok: false, error: `invalid npm package name: "${badNpm}"` };
  }

  const now = ctx.now ?? new Date();
  return {
    ok: true,
    payload: {
      type: 'install_packages',
      apt,
      npm,
      reason: input.reason,
      groupFolder: ctx.groupFolder,
      isMain: ctx.isMain,
      timestamp: now.toISOString(),
    },
  };
}

// ── add_mcp_server ──────────────────────────────────────────────────────────

export const addMcpServerInputSchema = {
  name: z.string().min(1).describe('Unique name for the MCP server'),
  command: z
    .string()
    .min(1)
    .describe(
      'Command to launch the MCP server (e.g. "npx", "node", or an absolute path under /usr/local/bin/ or /workspace/)',
    ),
  args: z.array(z.string()).optional().describe('Command arguments'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Environment variables to pass to the server process'),
};

export const addMcpServerInput = z.object(addMcpServerInputSchema);

export type AddMcpServerInput = z.infer<typeof addMcpServerInput>;

export interface AddMcpServerPayload {
  type: 'add_mcp_server';
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

/**
 * Validate + build the IPC payload for an `add_mcp_server` request.
 *
 * Container-side validation is intentionally minimal — required fields
 * only. The command-allowlist check is host-side (`add-mcp-server.ts`) so
 * the policy can evolve without a container rebuild.
 */
export function buildAddMcpServerPayload(
  input: AddMcpServerInput,
  ctx: { groupFolder: string; isMain: boolean; now?: Date },
): ValidationResult<AddMcpServerPayload> {
  if (!input.name || !input.command) {
    return { ok: false, error: 'name and command are required' };
  }
  const now = ctx.now ?? new Date();
  return {
    ok: true,
    payload: {
      type: 'add_mcp_server',
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      groupFolder: ctx.groupFolder,
      isMain: ctx.isMain,
      timestamp: now.toISOString(),
    },
  };
}

// ── create_skill_plugin ─────────────────────────────────────────────────────

/** Plugin name regex: lowercase, dash-separated, 2-31 chars. */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** Env var name regex: UPPER_SNAKE_CASE, 1-64 chars. */
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Env var names that may not be set by chat-created plugins. */
export const RESERVED_ENV_VAR_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ASSISTANT_NAME',
  'CLAUDE_MODEL',
]);

/** Env var name prefixes reserved for the host. */
export const RESERVED_ENV_VAR_PREFIXES = ['NANOCLAW_'];

/** Channel names accepted in the plugin's channels filter. */
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

const archetypeEnum = z.enum(['skill-only', 'mcp']);

const pluginJsonShape = z
  .object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    containerEnvVars: z.array(z.string()).optional(),
    publicEnvVars: z.array(z.string()).optional(),
    channels: z.array(z.string()).default(['*']),
    groups: z.array(z.string()).default(['*']),
    hooks: z.array(z.string()).optional(),
    containerHooks: z.array(z.string()).optional(),
    dependencies: z.boolean().optional(),
  })
  .strict();

export const createSkillPluginInputSchema = {
  name: z.string().describe('Plugin name (lowercase, 2-31 chars)'),
  description: z.string().describe('Plugin description (1-200 chars)'),
  archetype: archetypeEnum.describe('Plugin archetype: skill-only or mcp'),
  pluginJson: pluginJsonShape.describe('Plugin manifest (will be written to plugins/{name}/plugin.json)'),
  containerSkillMd: z.string().describe('Agent-facing SKILL.md content (max 20 KB)'),
  mcpJson: z.string().optional().describe('MCP server config JSON (required for mcp archetype, max 4 KB)'),
  envVarValues: z
    .record(z.string(), z.string())
    .optional()
    .describe('Optional credential values. Names must be UPPER_SNAKE_CASE; reserved prefixes blocked.'),
};

export const createSkillPluginInput = z.object(createSkillPluginInputSchema);

export type CreateSkillPluginInput = z.infer<typeof createSkillPluginInput>;

export interface CreateSkillPluginPayload {
  type: 'create_skill_plugin';
  name: string;
  description: string;
  archetype: 'skill-only' | 'mcp';
  pluginJson: z.infer<typeof pluginJsonShape>;
  containerSkillMd: string;
  mcpJson?: string;
  envVarValues?: Record<string, string>;
  groupFolder: string;
  isMain: boolean;
  timestamp: string;
}

/**
 * Validate + build the IPC payload for a `create_skill_plugin` request.
 *
 * Defense-in-depth: the host re-runs the same checks plus filesystem-level
 * uniqueness. This is the in-container fast feedback path.
 */
export function buildCreateSkillPluginPayload(
  input: CreateSkillPluginInput,
  ctx: { groupFolder: string; isMain: boolean; now?: Date },
): ValidationResult<CreateSkillPluginPayload> {
  if (!PLUGIN_NAME_RE.test(input.name)) {
    return { ok: false, error: `invalid name "${input.name}" (lowercase, 2-31 chars, [a-z0-9-])` };
  }
  if (input.description.length < 1 || input.description.length > 200) {
    return { ok: false, error: `description length must be 1-200 (got ${input.description.length})` };
  }
  if (!archetypeEnum.options.includes(input.archetype)) {
    return { ok: false, error: `invalid archetype "${input.archetype}" (must be skill-only or mcp)` };
  }
  if (Array.isArray(input.pluginJson.hooks) && input.pluginJson.hooks.length > 0) {
    return { ok: false, error: 'pluginJson.hooks not allowed (host-process hooks must be built on the host)' };
  }
  if (Array.isArray(input.pluginJson.containerHooks) && input.pluginJson.containerHooks.length > 0) {
    return { ok: false, error: 'pluginJson.containerHooks not allowed (container hooks must be built on the host)' };
  }
  if (input.pluginJson.dependencies === true) {
    return { ok: false, error: 'pluginJson.dependencies=true not allowed (no npm install in chat-creation flow)' };
  }
  if (Buffer.byteLength(input.containerSkillMd, 'utf8') > MAX_CONTAINER_SKILL_MD_BYTES) {
    return { ok: false, error: `containerSkillMd exceeds ${MAX_CONTAINER_SKILL_MD_BYTES} bytes` };
  }
  if (input.mcpJson && Buffer.byteLength(input.mcpJson, 'utf8') > MAX_MCP_JSON_BYTES) {
    return { ok: false, error: `mcpJson exceeds ${MAX_MCP_JSON_BYTES} bytes` };
  }
  if (input.archetype === 'mcp' && !input.mcpJson) {
    return { ok: false, error: 'archetype=mcp requires mcpJson' };
  }
  if (input.envVarValues) {
    for (const name of Object.keys(input.envVarValues)) {
      if (!ENV_VAR_NAME_RE.test(name)) {
        return { ok: false, error: `invalid env var name "${name}" (UPPER_SNAKE_CASE, 1-64 chars)` };
      }
      if (RESERVED_ENV_VAR_NAMES.has(name)) {
        return { ok: false, error: `env var name "${name}" is reserved` };
      }
      for (const prefix of RESERVED_ENV_VAR_PREFIXES) {
        if (name.startsWith(prefix)) {
          return { ok: false, error: `env var name prefix "${prefix}" is reserved` };
        }
      }
    }
  }
  for (const ch of input.pluginJson.channels) {
    if (!ALLOWED_CHANNEL_NAMES.has(ch)) {
      return { ok: false, error: `unknown channel "${ch}"` };
    }
  }
  // groups must be ['*'] OR contain only the originating folder
  const groups = input.pluginJson.groups;
  const isWildcard = groups.length === 1 && groups[0] === '*';
  const isSelfOnly = groups.every((g) => g === ctx.groupFolder);
  if (!isWildcard && !isSelfOnly) {
    return { ok: false, error: `groups scope must be ["*"] or ["${ctx.groupFolder}"]` };
  }

  const now = ctx.now ?? new Date();
  return {
    ok: true,
    payload: {
      type: 'create_skill_plugin',
      name: input.name,
      description: input.description,
      archetype: input.archetype,
      pluginJson: input.pluginJson,
      containerSkillMd: input.containerSkillMd,
      mcpJson: input.mcpJson,
      envVarValues: input.envVarValues,
      groupFolder: ctx.groupFolder,
      isMain: ctx.isMain,
      timestamp: now.toISOString(),
    },
  };
}
