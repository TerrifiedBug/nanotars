import type Database from 'better-sqlite3';
import { getDb } from './init.js';

export interface UnregisteredSenderRow {
  channel: string;
  platform_id: string;
  sender_name: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Record (or coalesce) a sighting of an inbound sender that doesn't
 * match any registered group. Increments `count` and updates `last_seen`
 * + `sender_name` on conflict.
 *
 * Adopted from upstream nanoclaw v2 unregistered_senders accessor.
 */
export function recordUnregisteredSender(
  channel: string,
  platformId: string,
  senderName: string,
  db: Database.Database = getDb(),
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO unregistered_senders (channel, platform_id, sender_name, count, first_seen, last_seen)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(channel, platform_id) DO UPDATE SET
      count = count + 1,
      sender_name = excluded.sender_name,
      last_seen = excluded.last_seen
  `).run(channel, platformId, senderName, now, now);
}

export function listUnregisteredSenders(
  db: Database.Database = getDb(),
): UnregisteredSenderRow[] {
  return db
    .prepare(`SELECT channel, platform_id, sender_name, count, first_seen, last_seen FROM unregistered_senders ORDER BY last_seen DESC`)
    .all() as UnregisteredSenderRow[];
}

export function clearUnregisteredSender(
  channel: string,
  platformId: string,
  db: Database.Database = getDb(),
): void {
  db.prepare(`DELETE FROM unregistered_senders WHERE channel = ? AND platform_id = ?`).run(channel, platformId);
}
