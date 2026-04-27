/**
 * Admin slash-command handlers for `/grant` and `/revoke` — role
 * management. Owner/admin-gated via command-gate.
 *
 * Usage:
 *   /grant <user_id> <role>
 *   /revoke <user_id> <role>
 *
 * Where <role> is 'owner' or 'admin'. <user_id> follows the
 * `<channel>:<handle>` convention (e.g. `telegram:8236653927`).
 *
 * Role grants are global (agent_group_id NULL). Per-group grants are not
 * exposed to chat — operators wanting scoped admin should use the host's
 * `grantRole` primitive directly, or wait for a future `/grant-scoped`.
 */
import { checkCommandPermission } from './command-gate.js';
import { logger } from './logger.js';
import { getUserById } from './permissions/users.js';
import { grantRole, revokeRole } from './permissions/user-roles.js';

export interface RoleAdminCommandArgs {
  command: string;
  /** Whitespace-split args — `[user_id, role]` for grant/revoke. */
  args: string[];
  userId: string | undefined;
  agentGroupId: string;
}

export interface RoleAdminCommandResult {
  handled: boolean;
  reply?: string;
  permissionReason?: string;
}

const VALID_ROLES = new Set(['owner', 'admin']);

export function tryHandleRoleAdminCommand(
  args: RoleAdminCommandArgs,
): RoleAdminCommandResult {
  if (args.command !== '/grant' && args.command !== '/revoke') {
    return { handled: false };
  }

  const decision = checkCommandPermission(args.userId, args.command, args.agentGroupId);
  if (!decision.allowed) {
    logger.warn(
      { command: args.command, userId: args.userId, reason: decision.reason },
      'Role admin command denied by command-gate',
    );
    return {
      handled: true,
      reply: `Command ${args.command} is admin-only.`,
      permissionReason: decision.reason,
    };
  }

  if (args.args.length !== 2) {
    return {
      handled: true,
      reply: `Usage: ${args.command} <user_id> <role>\n  e.g. ${args.command} telegram:8236653927 admin\n  Roles: owner, admin`,
      permissionReason: decision.reason,
    };
  }

  const [targetUserId, role] = args.args;
  if (!VALID_ROLES.has(role)) {
    return {
      handled: true,
      reply: `Unknown role "${role}". Valid roles: owner, admin`,
      permissionReason: decision.reason,
    };
  }

  if (args.command === '/grant') {
    // Confirm the target user exists — granting roles to phantom users is
    // a foot-gun (typo in user_id silently creates orphan rows).
    const target = getUserById(targetUserId);
    if (!target) {
      return {
        handled: true,
        reply:
          `No user "${targetUserId}" found. Users are auto-created on first message; ` +
          `the target needs to message the bot at least once before you can grant.`,
        permissionReason: decision.reason,
      };
    }
    grantRole({ user_id: targetUserId, role: role as 'owner' | 'admin' });
    logger.info({ command: args.command, by: args.userId, target: targetUserId, role }, 'Role granted');
    return {
      handled: true,
      reply: `Granted *${role}* to ${targetUserId}.`,
      permissionReason: decision.reason,
    };
  }

  // /revoke
  revokeRole({ user_id: targetUserId, role: role as 'owner' | 'admin' });
  logger.info({ command: args.command, by: args.userId, target: targetUserId, role }, 'Role revoked');
  return {
    handled: true,
    reply: `Revoked *${role}* from ${targetUserId}.`,
    permissionReason: decision.reason,
  };
}
