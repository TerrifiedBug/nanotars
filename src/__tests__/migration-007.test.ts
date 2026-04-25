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

    // A7 follow-up: runMigrations now applies 008+009 in the same sweep, so
    // the legacy registered_groups table is gone by the time runMigrations
    // returns. We verify 007's effects indirectly: the schema_version row,
    // and the migrated data in the entity-model tables (008 read from the
    // 007-shaped registered_groups before the drop in 009).
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>).map(
      (r) => r.version,
    );
    expect(versions).toContain('007_add_engage_mode_axes');
    expect(versions).toContain('008_split_registered_groups');
    expect(versions).toContain('009_drop_registered_groups');

    const wiring = db
      .prepare(`SELECT w.engage_mode, w.engage_pattern
                FROM messaging_groups mg
                JOIN messaging_group_agents w ON w.messaging_group_id = mg.id
                WHERE mg.platform_id = ?`)
      .get('test@s.whatsapp.net') as { engage_mode: string; engage_pattern: string };
    // requires_trigger=0 + trigger_pattern='hi' → engage_mode='always',
    // pattern='hi'. 008 carries those values into the wiring row.
    expect(wiring.engage_mode).toBe('always');
    expect(wiring.engage_pattern).toBe('hi');
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
