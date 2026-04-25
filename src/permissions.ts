/**
 * Phase 4A stubs. Phase 4B replaces these with real implementations
 * against users / user_roles / agent_group_members tables.
 *
 * The callsites are anchored in the orchestrator's inbound-routing path
 * (see orchestrator.ts: processGroupMessages, startMessageLoop) so 4B
 * can drop in real implementations without churning the routing shape.
 */

export interface SenderInfo {
  channel: string;
  platform_id: string;
  sender_handle: string;
  sender_name?: string;
}

/**
 * Resolve a platform-level sender to a users.id.
 * Phase 4A stub: always returns undefined (no users table yet).
 * Phase 4B: real implementation against the users table + user_dms cache.
 */
export function resolveSender(_info: SenderInfo): string | undefined {
  return undefined;
}

/**
 * Gate access to an agent group.
 * Phase 4A stub: always returns true (no RBAC yet).
 * Phase 4B: real implementation against user_roles + agent_group_members.
 */
export function canAccessAgentGroup(
  _userId: string | undefined,
  _agentGroupId: string,
): boolean {
  return true;
}
