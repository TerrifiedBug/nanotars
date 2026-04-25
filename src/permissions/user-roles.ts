import { getDb } from '../db/init.js';
import type { UserRole } from '../types.js';

export function isOwner(userId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'owner' AND agent_group_id IS NULL LIMIT 1`).get(userId);
  return row !== undefined;
}

export function isGlobalAdmin(userId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin' AND agent_group_id IS NULL LIMIT 1`).get(userId);
  return row !== undefined;
}

export function isAdminOfAgentGroup(userId: string, agentGroupId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin' AND agent_group_id = ? LIMIT 1`).get(userId, agentGroupId);
  return row !== undefined;
}

export function grantRole(args: {
  user_id: string;
  role: 'owner' | 'admin';
  agent_group_id?: string | null;
  granted_by?: string | null;
}): void {
  if (args.role === 'owner' && args.agent_group_id != null) {
    throw new Error('owner role must be global (agent_group_id = NULL)');
  }
  const db = getDb();
  const agentGroupId = args.agent_group_id ?? null;
  const now = new Date().toISOString();

  // SQLite does not consider two NULLs equal in a composite PRIMARY KEY, so
  // INSERT OR IGNORE fails to deduplicate rows where agent_group_id IS NULL.
  // Use an explicit existence check for the global case to enforce idempotency.
  if (agentGroupId === null) {
    const existing = db
      .prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1`)
      .get(args.user_id, args.role);
    if (existing) return;
    db.prepare(`INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, NULL, ?, ?)`)
      .run(args.user_id, args.role, args.granted_by ?? null, now);
  } else {
    db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`)
      .run(args.user_id, args.role, agentGroupId, args.granted_by ?? null, now);
  }
}

export function revokeRole(args: { user_id: string; role: 'owner' | 'admin'; agent_group_id?: string | null }): void {
  if (args.agent_group_id == null) {
    getDb().prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL`).run(args.user_id, args.role);
  } else {
    getDb().prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?`).run(args.user_id, args.role, args.agent_group_id);
  }
}

export function listOwners(): UserRole[] {
  return getDb().prepare(`SELECT * FROM user_roles WHERE role = 'owner'`).all() as UserRole[];
}

export function listGlobalAdmins(): UserRole[] {
  return getDb().prepare(`SELECT * FROM user_roles WHERE role = 'admin' AND agent_group_id IS NULL`).all() as UserRole[];
}

export function listAdminsOfAgentGroup(agentGroupId: string): UserRole[] {
  return getDb().prepare(`SELECT * FROM user_roles WHERE role = 'admin' AND agent_group_id = ?`).all(agentGroupId) as UserRole[];
}
