import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../db/init.js';

describe('migration 007_add_engage_mode_axes', () => {
  it('adds the four engage-axis columns and copies legacy values', () => {
    const db = new Database(':memory:');

    // Build the PRE-1e086d2 registered_groups schema: has the legacy
    // requires_trigger + trigger_pattern columns, no engage_mode etc.
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        channel TEXT
      );
    `);
    db.exec(`CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);

    // Pre-populate migrations 001-006 as already applied so only 007 runs.
    const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
    for (const v of [
      '001_add_context_mode',
      '002_add_model',
      '003_add_channel',
      '004_add_is_bot_message',
      '005_add_reply_context',
      '006_add_task_script',
    ]) {
      stmt.run(v, new Date().toISOString());
    }

    // Insert a legacy row with requires_trigger=0 + trigger_pattern='hi'.
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('test@s.whatsapp.net', 'Test Group', 'main', 'hi', new Date().toISOString(), null, 0, 'whatsapp');

    runMigrations(db);

    const cols = (db.pragma('table_info(registered_groups)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('engage_mode');
    expect(cols).toContain('pattern');
    expect(cols).toContain('sender_scope');
    expect(cols).toContain('ignored_message_policy');

    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>).map(
      (r) => r.version,
    );
    expect(versions).toContain('007_add_engage_mode_axes');

    const row = db
      .prepare('SELECT engage_mode, pattern FROM registered_groups WHERE jid = ?')
      .get('test@s.whatsapp.net') as { engage_mode: string; pattern: string };
    expect(row.engage_mode).toBe('always');
    expect(row.pattern).toBe('hi');
  });

  it('is idempotent — re-running runMigrations does not fail or duplicate', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        channel TEXT
      );
    `);
    db.exec(`CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
    const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
    for (const v of [
      '001_add_context_mode',
      '002_add_model',
      '003_add_channel',
      '004_add_is_bot_message',
      '005_add_reply_context',
      '006_add_task_script',
    ]) {
      stmt.run(v, new Date().toISOString());
    }

    runMigrations(db);
    // Second run should be a no-op (007 already applied).
    expect(() => runMigrations(db)).not.toThrow();

    const rows = db
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .all('007_add_engage_mode_axes') as Array<{ version: string }>;
    expect(rows.length).toBe(1);
  });
});
