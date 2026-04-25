import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './user-roles.js';
import { isMember } from './agent-group-members.js';

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Decision order: owner → global admin → scoped admin → explicit member → deny.
 *
 * Phase 4B: replaces the 4A stub permissions.ts:canAccessAgentGroup.
 */
export function canAccessAgentGroup(
  userId: string | undefined,
  agentGroupId: string,
): AccessDecision {
  if (!userId) return { allowed: false, reason: 'unauthenticated' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global-admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'scoped-admin' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not-a-member' };
}
