import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Build a pre-010 schema: the Phase 4A entity-model tables exist (agent_groups,
 * messaging_groups, messaging_group_agents) but the four Phase 4B RBAC tables
 * do not. Migrations 001-009 are pre-marked as applied so runMigrations starts
 * at 010.
 */
function buildPre010Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);

    CREATE TABLE agent_groups (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      folder          TEXT NOT NULL UNIQUE,
      agent_provider  TEXT,
      container_config TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE messaging_groups (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'public',
      created_at            TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE messaging_group_agents (
      id                     TEXT PRIMARY KEY,
      messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
      engage_mode            TEXT NOT NULL DEFAULT 'pattern',
      engage_pattern         TEXT,
      sender_scope           TEXT NOT NULL DEFAULT 'all',
      ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
      session_mode           TEXT DEFAULT 'shared',
      priority               INTEGER DEFAULT 0,
      created_at             TEXT NOT NULL,
      UNIQUE(messaging_group_id, agent_group_id)
    );
  `);

  const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (const v of [
    '001_add_context_mode',
    '002_add_model',
    '003_add_channel',
    '004_add_is_bot_message',
    '005_add_reply_context',
    '006_add_task_script',
    '007_add_engage_mode_axes',
    '008_split_registered_groups',
    '009_drop_registered_groups',
  ]) {
    stmt.run(v, new Date().toISOString());
  }
}

describe('migrations 010-014 (Phase 4B RBAC tables)', () => {
  it('creates users + user_roles + agent_group_members + user_dms with the right columns and index', async () => {
    const db = new Database(':memory:');
    buildPre010Schema(db);

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('users');
    expect(tables).toContain('user_roles');
    expect(tables).toContain('agent_group_members');
    expect(tables).toContain('user_dms');

    // users columns
    const userCols = (db.pragma('table_info(users)') as Array<{ name: string }>).map((c) => c.name);
    expect(userCols).toEqual(expect.arrayContaining(['id', 'kind', 'display_name', 'created_at']));

    // user_roles columns
    const roleCols = (db.pragma('table_info(user_roles)') as Array<{ name: string }>).map((c) => c.name);
    expect(roleCols).toEqual(
      expect.arrayContaining(['user_id', 'role', 'agent_group_id', 'granted_by', 'granted_at']),
    );

    // agent_group_members columns
    const memberCols = (db.pragma('table_info(agent_group_members)') as Array<{ name: string }>).map((c) => c.name);
    expect(memberCols).toEqual(
      expect.arrayContaining(['user_id', 'agent_group_id', 'added_by', 'added_at']),
    );

    // user_dms columns
    const dmCols = (db.pragma('table_info(user_dms)') as Array<{ name: string }>).map((c) => c.name);
    expect(dmCols).toEqual(
      expect.arrayContaining(['user_id', 'channel_type', 'messaging_group_id', 'resolved_at']),
    );

    // index on user_roles(agent_group_id, role)
    const indexes = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_roles'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_user_roles_scope');

    // schema_version contains all five new entries (014 included even though it's a no-op)
    const versions = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('010_add_users');
    expect(versions).toContain('011_add_user_roles');
    expect(versions).toContain('012_add_agent_group_members');
    expect(versions).toContain('013_add_user_dms');
    expect(versions).toContain('014_seed_sender_allowlist_to_members');
  });

  it('is idempotent: re-running migrations is a no-op (no double-inserts, no errors)', async () => {
    const db = new Database(':memory:');
    buildPre010Schema(db);

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const versionsBefore = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);

    // Re-run — should short-circuit on appliedSet.has(name) for every migration
    expect(() => runMigrations(db)).not.toThrow();

    const versionsAfter = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);

    // Same number of rows, same set of names — no duplicates
    expect(versionsAfter).toHaveLength(versionsBefore.length);
    expect(new Set(versionsAfter)).toEqual(new Set(versionsBefore));
  });

  it('fresh-install path via _initTestDatabaseFrom creates all four RBAC tables', async () => {
    const db = new Database(':memory:');
    const { _initTestDatabaseFrom } = await import('../db/init.js');
    _initTestDatabaseFrom(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('users');
    expect(tables).toContain('user_roles');
    expect(tables).toContain('agent_group_members');
    expect(tables).toContain('user_dms');

    const versions = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('010_add_users');
    expect(versions).toContain('011_add_user_roles');
    expect(versions).toContain('012_add_agent_group_members');
    expect(versions).toContain('013_add_user_dms');
    expect(versions).toContain('014_seed_sender_allowlist_to_members');
  });
});
