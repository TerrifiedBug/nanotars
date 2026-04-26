/**
 * Phase 5D — admin slash-command handlers for `/pause` and `/resume`.
 *
 * v1-archive does not yet ship a centralised host-side slash-command
 * dispatcher (Phase 4B introduced the `command-gate.ts` registry but
 * left actual command interpretation to the agent). This module sits
 * between the gate and the handler so a future dispatcher can wire it
 * in with one import:
 *
 *   const result = tryHandleLifecycleAdminCommand({ command, userId, agentGroupId });
 *   if (result.handled) return reply(result.reply!);
 *
 * Returns `{ handled: false }` when the command isn't `/pause` or
 * `/resume`. Callers that have already gated on `isAdminCommand` +
 * `checkCommandPermission` can pass through directly.
 */
import { pausedGate } from './lifecycle.js';
import { logger } from './logger.js';
import { checkCommandPermission } from './command-gate.js';

export interface LifecycleAdminCommandArgs {
  /** First whitespace-delimited token from the user's message (e.g. "/pause"). */
  command: string;
  /** Optional free-form reason — typically the rest of the message text. */
  reason?: string;
  /**
   * Resolved user id of the message sender. Pass `undefined` for legacy
   * paths that have not yet threaded a sender; the call will be denied.
   */
  userId: string | undefined;
  /** Agent group context (used for scoped-admin gating). */
  agentGroupId: string;
  /** Optional user handle for the pausedGate audit log line. */
  userHandle?: string;
}

export interface LifecycleAdminCommandResult {
  handled: boolean;
  /** Reply text to send back to the user. Present when handled === true. */
  reply?: string;
  /** Decision reason from command-gate (e.g. 'owner', 'admin-only'). */
  permissionReason?: string;
}

export function tryHandleLifecycleAdminCommand(
  args: LifecycleAdminCommandArgs,
): LifecycleAdminCommandResult {
  const cmd = args.command;
  if (cmd !== '/pause' && cmd !== '/resume') {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, cmd, args.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      { command: cmd, userId: args.userId, agentGroupId: args.agentGroupId, reason: decision.reason },
      'Lifecycle admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${cmd} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  const auditTag = args.userHandle
    ? `admin: ${args.userHandle}`
    : `admin: ${args.userId}`;
  const reasonText = args.reason ? `${auditTag} — ${args.reason}` : auditTag;

  if (cmd === '/pause') {
    pausedGate.pause(reasonText);
    return { handled: true, reply: 'Host paused.', permissionReason: decision.reason };
  }

  // cmd === '/resume'
  pausedGate.resume(reasonText);
  return { handled: true, reply: 'Host resumed.', permissionReason: decision.reason };
}
