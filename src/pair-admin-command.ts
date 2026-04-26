/**
 * Admin slash-command handler for `/pair-telegram`.
 *
 * Operator runs `/pair-telegram` from an existing admin chat. We allocate
 * a 4-digit pending code for `intent='main'` via the cross-channel pairing
 * primitive (src/pending-codes.ts) and reply with the code + instructions.
 * The operator then echoes the digits from the chat they want to register;
 * the marketplace telegram plugin's inbound interceptor calls
 * `config.consumePendingCode` to short-circuit delivery and confirm.
 *
 * Mirrors the lifecycle-admin-commands.ts pattern from Phase 5D.
 */
import { checkCommandPermission } from './command-gate.js';
import { logger } from './logger.js';
import { createPendingCode } from './pending-codes.js';

export interface PairAdminCommandArgs {
  /** First whitespace-delimited token from the user's message. */
  command: string;
  /** Resolved user id of the message sender. Undefined → unauthenticated. */
  userId: string | undefined;
  /** Agent-group context for scoped-admin gating. */
  agentGroupId: string;
}

export interface PairAdminCommandResult {
  handled: boolean;
  /** Reply text to send back. Present when handled === true. */
  reply?: string;
  /** Decision reason from command-gate (e.g. 'owner', 'admin-only'). */
  permissionReason?: string;
}

/**
 * Try to handle a `/pair-telegram` admin command. Returns
 * `{ handled: false }` for any other command so the dispatcher can fall
 * through.
 */
export async function tryHandlePairAdminCommand(
  args: PairAdminCommandArgs,
): Promise<PairAdminCommandResult> {
  if (args.command !== '/pair-telegram') {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, args.command, args.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      { command: args.command, userId: args.userId, agentGroupId: args.agentGroupId, reason: decision.reason },
      'Pair admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${args.command} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  const result = await createPendingCode({ channel: 'telegram', intent: 'main' });
  const reply =
    `Pairing code: ${result.code}\n\n` +
    `Send this 4-digit code from the Telegram chat you want to register. ` +
    `The bot will confirm pairing once it sees the code (no other text).`;
  logger.info(
    { command: args.command, userId: args.userId, code: result.code, agentGroupId: args.agentGroupId },
    'Pairing code issued',
  );
  return { handled: true, reply, permissionReason: decision.reason };
}
