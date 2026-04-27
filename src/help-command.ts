/**
 * Slice 5 — admin slash-command handler for `/help`.
 *
 * Renders the metadata in `command-gate.ts`'s ADMIN_COMMANDS map as a
 * single text block. Admin-gated via the same `checkCommandPermission`
 * path the other admin handlers use. Pure function — no DB writes, no
 * IPC, no side effects. Wired into the dispatch chain in
 * `admin-command-dispatch.ts`.
 */
import { checkCommandPermission, listAdminCommands } from './command-gate.js';

export interface HelpCommandArgs {
  /** First whitespace-delimited token from the user's message (e.g. "/help"). */
  command: string;
  /**
   * Resolved user id of the message sender. Pass `undefined` for legacy
   * paths that have not yet threaded a sender; the call will be denied.
   */
  userId: string | undefined;
  /** Agent group context (used for scoped-admin gating). */
  agentGroupId: string;
}

export interface HelpCommandResult {
  handled: boolean;
  /** Reply text to send back to the user. Present when handled === true. */
  reply?: string;
  /** Decision reason from command-gate (e.g. 'owner', 'admin-only'). */
  permissionReason?: string;
}

export function tryHandleHelpCommand(args: HelpCommandArgs): HelpCommandResult {
  if (args.command !== '/help') {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, '/help', args.agentGroupId);
  if (!decision.allowed) {
    return {
      handled: true,
      reply: `Sorry — /help is admin-only (${decision.reason}).`,
      permissionReason: decision.reason,
    };
  }

  const lines = ['*Admin commands:*'];
  for (const meta of listAdminCommands()) {
    const usagePart = meta.usage ? ` ${meta.usage}` : '';
    lines.push(`${meta.name}${usagePart} — ${meta.description}`);
  }

  return {
    handled: true,
    reply: lines.join('\n'),
    permissionReason: decision.reason,
  };
}
