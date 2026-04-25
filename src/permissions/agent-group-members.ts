import { getDb } from '../db/init.js';
import type { User } from '../types.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './user-roles.js';

export function isMember(userId: string, agentGroupId: string): boolean {
  // Owner / global admin / scoped admin are implicit members per spec.
  if (isOwner(userId)) return true;
  if (isGlobalAdmin(userId)) return true;
  if (isAdminOfAgentGroup(userId, agentGroupId)) return true;
  const row = getDb()
    .prepare(`SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1`)
    .get(userId, agentGroupId);
  return row !== undefined;
}

export function addMember(args: {
  user_id: string;
  agent_group_id: string;
  added_by?: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(`INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)`)
    .run(args.user_id, args.agent_group_id, args.added_by ?? null, now);
}

export function removeMember(args: { user_id: string; agent_group_id: string }): void {
  getDb()
    .prepare(`DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?`)
    .run(args.user_id, args.agent_group_id);
}

export function listMembers(agentGroupId: string): User[] {
  return getDb()
    .prepare(`SELECT u.* FROM users u JOIN agent_group_members m ON m.user_id = u.id WHERE m.agent_group_id = ? ORDER BY m.added_at`)
    .all(agentGroupId) as User[];
}
