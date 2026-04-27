/**
 * Slice 5 — host-side admin slash-command dispatcher.
 *
 * Calls each `tryHandle*AdminCommand` in sequence. First handler to
 * return `{ handled: true }` wins; the dispatcher returns its result
 * verbatim. If no handler matched, returns `{ handled: false }` so the
 * caller (typically `orchestrator.processGroupMessages`) can fall
 * through to the agent.
 *
 * The dispatch order is deterministic but isn't load-bearing — each
 * handler's first check is `if command !== '/foo' return { handled: false }`,
 * so two handlers can never both claim the same command. The order is
 * primarily for readability + cheap-handlers-first (sync /help before
 * async /rebuild-image).
 *
 * Wiring point: `src/orchestrator.ts:processGroupMessages`. See Task 4.
 */
import { tryHandleHelpCommand } from './help-command.js';
import { tryHandleLifecycleAdminCommand } from './lifecycle-admin-commands.js';
import { tryHandleRebuildImageAdminCommand } from './rebuild-image-admin-command.js';
import { tryHandleListAdminCommand } from './list-admin-commands.js';
import { tryHandleHealthAdminCommand } from './health-admin-command.js';
import { tryHandleRoleAdminCommand } from './role-admin-commands.js';
import { tryHandleRestartAdminCommand } from './restart-admin-command.js';
import { tryHandleRegisterGroupAdminCommand } from './register-group-admin-command.js';

export interface AdminCommandArgs {
  /** First whitespace-delimited token from the user's message (e.g. "/help"). */
  command: string;
  /** Tokenized rest of the message after the command. */
  args: string[];
  /** Optional free-form rest-of-message text — used by /pause as a reason. */
  rest?: string;
  /** Resolved user id of the message sender (undefined for legacy paths). */
  userId: string | undefined;
  /** Agent group context for scoped-admin gating. */
  agentGroupId: string;
  /** Optional sender handle for audit log lines (passed to lifecycle/pause). */
  userHandle?: string;
}

export interface AdminCommandResult {
  /** True if any handler claimed the command. */
  handled: boolean;
  /** Reply text to send back. Present when handled === true. */
  reply?: string;
  /** Decision reason from command-gate (e.g. 'owner', 'admin-only'). */
  permissionReason?: string;
}

export async function dispatchAdminCommand(
  args: AdminCommandArgs,
): Promise<AdminCommandResult> {
  // /help — sync, cheapest first.
  const helpResult = tryHandleHelpCommand({
    command: args.command,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
  });
  if (helpResult.handled) return helpResult;

  // /pause, /resume — sync.
  const lifecycleResult = tryHandleLifecycleAdminCommand({
    command: args.command,
    reason: args.rest,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
    userHandle: args.userHandle,
  });
  if (lifecycleResult.handled) return lifecycleResult;

  // Slice 8: read-only listers (sync).
  const listResult = tryHandleListAdminCommand({
    command: args.command,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
  });
  if (listResult.handled) return listResult;

  // Slice 8: /health (sync).
  const healthResult = tryHandleHealthAdminCommand({
    command: args.command,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
  });
  if (healthResult.handled) return healthResult;

  // Slice 8: /grant, /revoke (sync — DB mutations).
  const roleResult = tryHandleRoleAdminCommand({
    command: args.command,
    args: args.args,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
  });
  if (roleResult.handled) return roleResult;

  // Slice 8: /restart — async (kicks per-group restarts).
  const restartResult = await tryHandleRestartAdminCommand({
    command: args.command,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
  });
  if (restartResult.handled) return restartResult;

  // /rebuild-image — async (image build).
  const rebuildResult = await tryHandleRebuildImageAdminCommand({
    command: args.command,
    args: args.args,
    userId: args.userId ?? '',
    agentGroupId: args.agentGroupId,
  });
  if (rebuildResult.handled) return rebuildResult;

  // Slice 8: /register-group + /pair-telegram alias — async (pairing-code
  // allocation + optional agent_group create).
  const registerResult = await tryHandleRegisterGroupAdminCommand({
    command: args.command,
    args: args.args,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
  });
  if (registerResult.handled) return registerResult;

  return { handled: false };
}
