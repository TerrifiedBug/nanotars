import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('migration 008_split_registered_groups', () => {
  it('splits a populated registered_groups into agent_groups + messaging_groups + messaging_group_agents', async () => {
    const db = new Database(':memory:');

    // Build the pre-008 schema (registered_groups with 4-axis engage cols + Phase 3 backfill applied)
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        pattern TEXT,
        added_at TEXT NOT NULL,
        container_config TEXT,
        engage_mode TEXT NOT NULL DEFAULT 'pattern',
        sender_scope TEXT NOT NULL DEFAULT 'all',
        ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
        channel TEXT
      );
      CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    `);

    const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
    for (const v of [
      '001_add_context_mode', '002_add_model', '003_add_channel',
      '004_add_is_bot_message', '005_add_reply_context', '006_add_task_script',
      '007_add_engage_mode_axes',
    ]) stmt.run(v, new Date().toISOString());

    // Seed two registered_groups rows on the same channel but distinct folders
    db.prepare(`INSERT INTO registered_groups (jid, name, folder, pattern, added_at, container_config, engage_mode, sender_scope, ignored_message_policy, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('alice@s.whatsapp.net', 'Alice', 'alice', '\\bhi\\b', '2026-01-01T00:00:00Z', '{"foo":1}', 'pattern', 'all', 'drop', 'whatsapp');
    db.prepare(`INSERT INTO registered_groups (jid, name, folder, pattern, added_at, container_config, engage_mode, sender_scope, ignored_message_policy, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('bob@s.whatsapp.net', 'Bob', 'bob', null, '2026-01-02T00:00:00Z', null, 'always', 'known', 'observe', 'whatsapp');

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    // Verify three new tables exist
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{name: string}>).map(r => r.name);
    expect(tables).toContain('agent_groups');
    expect(tables).toContain('messaging_groups');
    expect(tables).toContain('messaging_group_agents');

    // agent_groups: one row per legacy folder
    const ags = db.prepare(`SELECT * FROM agent_groups ORDER BY folder`).all() as any[];
    expect(ags).toHaveLength(2);
    expect(ags[0].folder).toBe('alice');
    expect(ags[0].name).toBe('Alice');
    expect(ags[0].container_config).toBe('{"foo":1}');

    // messaging_groups: one row per (channel, jid) pair
    const mgs = db.prepare(`SELECT * FROM messaging_groups ORDER BY platform_id`).all() as any[];
    expect(mgs).toHaveLength(2);
    expect(mgs[0].channel_type).toBe('whatsapp');
    expect(mgs[0].platform_id).toBe('alice@s.whatsapp.net');
    expect(mgs[0].unknown_sender_policy).toBe('public');

    // messaging_group_agents: one wiring row per legacy registered_groups row
    const mga = db.prepare(`SELECT * FROM messaging_group_agents`).all() as any[];
    expect(mga).toHaveLength(2);
    const aliceWiring = mga.find((r: any) => ags.find((a: any) => a.id === r.agent_group_id)?.folder === 'alice');
    expect(aliceWiring.engage_mode).toBe('pattern');
    expect(aliceWiring.engage_pattern).toBe('\\bhi\\b');
    expect(aliceWiring.sender_scope).toBe('all');
    expect(aliceWiring.ignored_message_policy).toBe('drop');

    // schema_version row
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{version: string}>).map(r => r.version);
    expect(versions).toContain('008_split_registered_groups');

    // registered_groups still present (drop is in A7)
    expect(tables).toContain('registered_groups');
  });

  it('is idempotent on a DB created via createSchema (fresh install — no legacy rows)', async () => {
    // Drive the live createSchema so the test catches drift between createSchema and the migration.
    const db = new Database(':memory:');
    const { _initTestDatabaseFrom } = await import('../db/init.js');
    _initTestDatabaseFrom(db);

    // Migration must be a no-op (registered_groups exists empty); new tables exist (from createSchema).
    const ags = db.prepare(`SELECT * FROM agent_groups`).all();
    expect(ags).toHaveLength(0);
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{version: string}>).map(r => r.version);
    expect(versions).toContain('008_split_registered_groups');
  });
});
