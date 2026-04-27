/**
 * Admin slash-command handler for `/register-group <folder>`.
 *
 * Generalises the legacy `/pair-telegram` (which was hardcoded to
 * folder='main' AND telegram-the-channel — both wrong: pairing codes are
 * channel-agnostic, and operators may want to register chats for any
 * folder). This handler:
 *
 *   1. Resolves the agent_group by folder. If absent, creates it and
 *      scaffolds the host-side filesystem (groups/<folder>/ via
 *      group-init).
 *   2. Allocates a 4-digit pending code via `createPendingCode` with intent
 *      `{kind:'agent_group', target: <agent_group_id>}` so any channel can
 *      claim it.
 *   3. Replies with channel-agnostic instructions.
 *
 * `/pair-telegram` becomes a literal alias for `/register-group main` —
 * zero behaviour change for existing flows.
 *
 * Owner/admin-gated via command-gate.
 */
import { checkCommandPermission } from './command-gate.js';
import { logger } from './logger.js';
import { createPendingCode } from './pending-codes.js';
import {
  createAgentGroup,
  getAgentGroupByFolder,
} from './db/agent-groups.js';
import { initGroupFilesystem } from './group-init.js';

const FOLDER_RE = /^[a-z][a-z0-9-]{0,30}$/;

export interface RegisterGroupAdminCommandArgs {
  command: string;
  /** Whitespace-split args — `[folder]` for /register-group; empty for /pair-telegram alias. */
  args: string[];
  userId: string | undefined;
  agentGroupId: string;
}

export interface RegisterGroupAdminCommandResult {
  handled: boolean;
  reply?: string;
  permissionReason?: string;
}

export async function tryHandleRegisterGroupAdminCommand(
  args: RegisterGroupAdminCommandArgs,
): Promise<RegisterGroupAdminCommandResult> {
  // Accept both canonical /register-group and legacy /pair-telegram alias.
  let folder: string;
  if (args.command === '/register-group') {
    if (args.args.length !== 1) {
      return {
        handled: true,
        reply:
          'Usage: /register-group <folder>\n  e.g. /register-group main\n' +
          '       /register-group work\n' +
          'Folder names are lowercase, dash-separated, 1-31 chars.',
      };
    }
    folder = args.args[0];
  } else if (args.command === '/pair-telegram') {
    folder = 'main';
  } else {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, args.command, args.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      { command: args.command, userId: args.userId, reason: decision.reason },
      'Register-group admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${args.command} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  if (!FOLDER_RE.test(folder)) {
    return {
      handled: true,
      reply: `Invalid folder "${folder}" (lowercase, dash-separated, 1-31 chars).`,
      permissionReason: decision.reason,
    };
  }

  // Resolve or create the agent group.
  let ag = getAgentGroupByFolder(folder);
  let createdGroup = false;
  if (!ag) {
    try {
      ag = createAgentGroup({ name: capitalise(folder), folder });
      initGroupFilesystem(ag, {});
      createdGroup = true;
      logger.info({ command: args.command, folder, by: args.userId }, 'Agent group created via /register-group');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        handled: true,
        reply: `Failed to create agent group "${folder}": ${msg}`,
        permissionReason: decision.reason,
      };
    }
  }

  // Allocate the pairing code with the agent_group target intent so any
  // channel that sees the code can claim it for this folder.
  const code = await createPendingCode({
    channel: 'any',
    intent: { kind: 'agent_group', target: ag.id },
  });

  const groupNote = createdGroup ? ` (just created)` : '';
  const reply =
    `Pairing code: *${code.code}*${groupNote}\n\n` +
    `Folder: ${folder}\n` +
    `Type the code as a single message in the chat you want to wire to this folder. ` +
    `Works in any channel (Telegram / WhatsApp / Discord / Slack / webhook) ` +
    `as long as the bot is present in that chat. Code expires in 1 hour.`;

  logger.info(
    { command: args.command, folder, code: code.code, by: args.userId, createdGroup },
    'Register-group pairing code issued',
  );
  return { handled: true, reply, permissionReason: decision.reason };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
