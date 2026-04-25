import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Build a pre-015 schema: Phase 4A entity-model + Phase 4B RBAC tables exist;
 * pending_approvals does not. Migrations 001-014 are pre-marked as applied so
 * runMigrations starts at 015.
 */
function buildPre015Schema(db: Database.Database): void {
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
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      display_name TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE user_roles (
      user_id        TEXT NOT NULL REFERENCES users(id),
      role           TEXT NOT NULL,
      agent_group_id TEXT REFERENCES agent_groups(id),
      granted_by     TEXT REFERENCES users(id),
      granted_at     TEXT NOT NULL,
      PRIMARY KEY (user_id, role, agent_group_id)
    );
    CREATE TABLE agent_group_members (
      user_id        TEXT NOT NULL REFERENCES users(id),
      agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      added_by       TEXT REFERENCES users(id),
      added_at       TEXT NOT NULL,
      PRIMARY KEY (user_id, agent_group_id)
    );
    CREATE TABLE user_dms (
      user_id            TEXT NOT NULL REFERENCES users(id),
      channel_type       TEXT NOT NULL,
      messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
      resolved_at        TEXT NOT NULL,
      PRIMARY KEY (user_id, channel_type)
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
    '010_add_users',
    '011_add_user_roles',
    '012_add_agent_group_members',
    '013_add_user_dms',
    '014_seed_sender_allowlist_to_members',
  ]) {
    stmt.run(v, new Date().toISOString());
  }
}

describe('migration 015_add_pending_approvals (Phase 4C approval primitive)', () => {
  it('creates the pending_approvals table with the right columns and index', async () => {
    const db = new Database(':memory:');
    buildPre015Schema(db);

    // Sanity: table absent pre-migration
    const beforeTables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(beforeTables).not.toContain('pending_approvals');

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('pending_approvals');

    // Column shape
    const cols = db.pragma('table_info(pending_approvals)') as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const colNames = cols.map((c) => c.name);
    for (const expected of [
      'approval_id',
      'session_id',
      'request_id',
      'action',
      'payload',
      'created_at',
      'agent_group_id',
      'channel_type',
      'platform_id',
      'platform_message_id',
      'expires_at',
      'status',
      'title',
      'options_json',
    ]) {
      expect(colNames).toContain(expected);
    }

    // NOT NULL constraints (per spec): request_id, action, payload, created_at, status, title, options_json
    // Note: SQLite's pragma table_info does not flag PRIMARY KEY columns
    // (approval_id) as notnull=1 in the pragma output — the PK constraint
    // enforces non-null implicitly. Only explicit NOT NULL constraints show.
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.session_id.notnull).toBe(0);
    expect(byName.request_id.notnull).toBe(1);
    expect(byName.action.notnull).toBe(1);
    expect(byName.payload.notnull).toBe(1);
    expect(byName.created_at.notnull).toBe(1);
    expect(byName.agent_group_id.notnull).toBe(0);
    expect(byName.status.notnull).toBe(1);
    expect(byName.title.notnull).toBe(1);
    expect(byName.options_json.notnull).toBe(1);

    // Index exists
    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pending_approvals'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_pending_approvals_action_status');

    // session_id has NO foreign-key reference (v1-archive divergence from v2)
    const fks = db.pragma('foreign_key_list(pending_approvals)') as Array<{ from: string; table: string }>;
    expect(fks.find((fk) => fk.from === 'session_id')).toBeUndefined();
    // agent_group_id retains its FK to agent_groups(id)
    expect(fks.find((fk) => fk.from === 'agent_group_id' && fk.table === 'agent_groups')).toBeDefined();

    // schema_version row recorded
    const versions = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('015_add_pending_approvals');
  });

  it('is idempotent: re-running migrations is a no-op (no errors, no duplicate rows)', async () => {
    const db = new Database(':memory:');
    buildPre015Schema(db);

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const versionsBefore = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);

    // Re-run — every migration short-circuits on appliedSet.has
    expect(() => runMigrations(db)).not.toThrow();

    const versionsAfter = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versionsAfter).toHaveLength(versionsBefore.length);
    expect(new Set(versionsAfter)).toEqual(new Set(versionsBefore));
  });

  it('fresh-install path via _initTestDatabaseFrom creates pending_approvals from createSchema', async () => {
    const db = new Database(':memory:');
    const { _initTestDatabaseFrom } = await import('../db/init.js');
    _initTestDatabaseFrom(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('pending_approvals');

    // Index also present on fresh install
    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pending_approvals'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_pending_approvals_action_status');

    const versions = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('015_add_pending_approvals');
  });
});
