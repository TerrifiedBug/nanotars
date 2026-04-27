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
import { tryHandlePairAdminCommand } from './pair-admin-command.js';

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

  // /rebuild-image — async (image build).
  const rebuildResult = await tryHandleRebuildImageAdminCommand({
    command: args.command,
    args: args.args,
    userId: args.userId ?? '',
    agentGroupId: args.agentGroupId,
  });
  if (rebuildResult.handled) return rebuildResult;

  // /pair-telegram — async (pairing-code allocation).
  const pairResult = await tryHandlePairAdminCommand({
    command: args.command,
    userId: args.userId,
    agentGroupId: args.agentGroupId,
  });
  if (pairResult.handled) return pairResult;

  return { handled: false };
}
