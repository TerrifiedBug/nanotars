import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('migration 009_drop_registered_groups', () => {
  it('drops the legacy table when present (post-008 brownfield)', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY);
      CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    const stmt = db.prepare('INSERT INTO schema_version VALUES (?, ?)');
    for (const v of [
      '001_add_context_mode',
      '002_add_model',
      '003_add_channel',
      '004_add_is_bot_message',
      '005_add_reply_context',
      '006_add_task_script',
      '007_add_engage_mode_axes',
      '008_split_registered_groups',
    ]) {
      stmt.run(v, new Date().toISOString());
    }

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).not.toContain('registered_groups');
    const versions = (
      db
        .prepare('SELECT version FROM schema_version')
        .all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('009_drop_registered_groups');
  });

  it('is idempotent on a fresh install (table never existed)', async () => {
    const db = new Database(':memory:');
    const { _initTestDatabaseFrom, runMigrations } = await import('../db/init.js');
    _initTestDatabaseFrom(db);
    // Re-run migrations — should be a no-op since 009 already applied.
    expect(() => runMigrations(db)).not.toThrow();
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).not.toContain('registered_groups');
    const versions = (
      db
        .prepare('SELECT version FROM schema_version')
        .all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('009_drop_registered_groups');
  });
});
