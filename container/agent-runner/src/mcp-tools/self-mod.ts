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
