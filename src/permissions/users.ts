import { getDb } from '../db/init.js';
import type { User } from '../types.js';

export function ensureUser(args: { id: string; kind: string; display_name?: string | null }): User {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM users WHERE id = ?`).get(args.id) as User | undefined;
  if (existing) {
    if (args.display_name !== undefined && args.display_name !== existing.display_name) {
      db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(args.display_name, args.id);
      return { ...existing, display_name: args.display_name ?? null };
    }
    return existing;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run(args.id, args.kind, args.display_name ?? null, now);
  return { id: args.id, kind: args.kind, display_name: args.display_name ?? null, created_at: now };
}

export function getUserById(id: string): User | undefined {
  return getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function listUsersByKind(kind: string): User[] {
  return getDb().prepare(`SELECT * FROM users WHERE kind = ? ORDER BY created_at`).all(kind) as User[];
}
