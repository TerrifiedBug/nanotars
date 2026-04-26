import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './permissions/user-roles.js';

/**
 * Slash-commands that require admin privileges.
 *
 * Phase 4B introduces this gate to replace v1's implicit "main group only"
 * convention. Commands sent from non-admin users are refused with a
 * clear "admin-only" message instead of silently working in the main group.
 *
 * Extend this set as new admin commands are added.
 */
const ADMIN_COMMANDS = new Set<string>([
  '/grant',
  '/revoke',
  '/list-users',
  '/list-roles',
  '/register-group',
  '/delete-group',
  '/restart',
  // Phase 5D: soft-pause / resume the host. Layered on top of the existing
  // GroupQueue.emergencyStop kill-now path — see src/lifecycle.ts and
  // src/lifecycle-handlers.ts.
  '/pause',
  '/resume',
  // Phase 5B: force-rebuild a per-agent-group image. Handler lives in
  // src/rebuild-image-admin-command.ts; pairs with buildAgentGroupImage in
  // src/container-runner.ts.
  '/rebuild-image',
  // Cross-channel pairing-codes primitive — generate a 4-digit code that
  // the operator echoes from the chat they want to register. Handler lives
  // in src/pair-admin-command.ts; pairs with src/pending-codes.ts and the
  // marketplace telegram plugin's inbound interceptor.
  '/pair-telegram',
]);

export function isAdminCommand(text: string): boolean {
  if (!text) return false;
  const first = text.trim().split(/\s+/)[0];
  return ADMIN_COMMANDS.has(first);
}

export interface CommandPermissionDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a user can run an admin command for a given agent group.
 *
 * Decision order: owner → global admin → scoped admin → deny.
 * Returns { allowed: false, reason: 'unauthenticated' } when userId is undefined.
 */
export function checkCommandPermission(
  userId: string | undefined,
  command: string,
  agentGroupId: string,
): CommandPermissionDecision {
  if (!userId) return { allowed: false, reason: 'unauthenticated' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global-admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'scoped-admin' };
  return { allowed: false, reason: 'admin-only' };
}
