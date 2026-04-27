/**
 * Admin slash-command handlers for read-only listings:
 * `/list-users`, `/list-roles`, `/list-groups`.
 *
 * All three are owner/admin-gated via `command-gate`. The dispatcher
 * pre-normalises the command (strips `@<botname>` and folds `_` → `-`)
 * before reaching here, so we match against canonical hyphenated names.
 *
 * Mirrors the lifecycle-admin-commands.ts pattern.
 */
import { getDb } from './db/init.js';
import { checkCommandPermission } from './command-gate.js';
import { logger } from './logger.js';
import { getAllAgentGroups } from './db/agent-groups.js';

export interface ListAdminCommandArgs {
  /** First whitespace-delimited token from the user's message. */
  command: string;
  /** Resolved user id of the message sender. Undefined → unauthenticated. */
  userId: string | undefined;
  /** Agent-group context for scoped-admin gating. */
  agentGroupId: string;
}

export interface ListAdminCommandResult {
  handled: boolean;
  reply?: string;
  permissionReason?: string;
}

const LIST_COMMANDS = new Set(['/list-users', '/list-roles', '/list-groups']);

export function tryHandleListAdminCommand(
  args: ListAdminCommandArgs,
): ListAdminCommandResult {
  if (!LIST_COMMANDS.has(args.command)) {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, args.command, args.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      { command: args.command, userId: args.userId, reason: decision.reason },
      'List admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${args.command} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  let reply: string;
  switch (args.command) {
    case '/list-users':
      reply = formatUsersList();
      break;
    case '/list-roles':
      reply = formatRolesList();
      break;
    case '/list-groups':
      reply = formatGroupsList();
      break;
    default:
      // Unreachable — set membership above guards this.
      return { handled: false };
  }

  return { handled: true, reply, permissionReason: decision.reason };
}

function formatUsersList(): string {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.kind, u.display_name,
              GROUP_CONCAT(ur.role) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       GROUP BY u.id
       ORDER BY u.id`,
    )
    .all() as Array<{ id: string; kind: string; display_name: string | null; roles: string | null }>;

  if (rows.length === 0) return 'No users found.';

  const lines = rows.map((r) => {
    const roles = r.roles ? ` [${r.roles}]` : '';
    const name = r.display_name ? ` (${r.display_name})` : '';
    return `• ${r.id}${name}${roles}`;
  });
  return `Users (${rows.length}):\n${lines.join('\n')}`;
}

function formatRolesList(): string {
  const rows = getDb()
    .prepare(
      `SELECT role, GROUP_CONCAT(user_id) AS user_ids, COUNT(*) AS count
       FROM user_roles
       GROUP BY role
       ORDER BY role`,
    )
    .all() as Array<{ role: string; user_ids: string; count: number }>;

  const definitions = [
    '*owner* — full access to everything; can grant/revoke roles',
    '*admin* — can run admin commands within scope (global or per-agent-group)',
  ].join('\n');

  if (rows.length === 0) {
    return `Roles:\n${definitions}\n\nNobody currently holds any role.`;
  }

  const heldBy = rows.map((r) => `*${r.role}* (${r.count}): ${r.user_ids}`).join('\n');
  return `Roles:\n${definitions}\n\nHeld by:\n${heldBy}`;
}

function formatGroupsList(): string {
  const ags = getAllAgentGroups();
  if (ags.length === 0) return 'No agent groups registered.';

  const lines: string[] = [];
  for (const ag of ags) {
    const wirings = getDb()
      .prepare(
        `SELECT mg.platform_id, mg.channel_type, mg.name, mga.engage_mode
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ?
         ORDER BY mg.channel_type, mg.platform_id`,
      )
      .all(ag.id) as Array<{
      platform_id: string;
      channel_type: string;
      name: string | null;
      engage_mode: string;
    }>;

    if (wirings.length === 0) {
      lines.push(`• *${ag.folder}* — no chats wired`);
      continue;
    }
    const chatLines = wirings
      .map((w) => {
        const display = w.name ? `${w.name} (${w.platform_id})` : w.platform_id;
        return `    └ ${w.channel_type}: ${display} [${w.engage_mode}]`;
      })
      .join('\n');
    lines.push(`• *${ag.folder}*\n${chatLines}`);
  }
  return `Agent groups (${ags.length}):\n${lines.join('\n')}`;
}
