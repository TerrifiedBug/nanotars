import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Build a pre-016 schema: Phase 4A entity-model + Phase 4B RBAC tables +
 * Phase 4C pending_approvals exist; the three Phase 4D tables do not.
 * Migrations 001-015 are pre-marked as applied so runMigrations starts
 * at 016.
 *
 * Two variants are exercised below: with and without `messaging_groups.denied_at`
 * already present, to confirm migration 017's idempotent ALTER guard.
 */
function buildPre016Schema(db: Database.Database, opts: { withDeniedAt?: boolean } = {}): void {
  const deniedAtCol = opts.withDeniedAt ? `denied_at TEXT,` : '';
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
      ${deniedAtCol}
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
    CREATE TABLE pending_approvals (
      approval_id          TEXT PRIMARY KEY,
      session_id           TEXT,
      request_id           TEXT NOT NULL,
      action               TEXT NOT NULL,
      payload              TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      agent_group_id       TEXT REFERENCES agent_groups(id),
      channel_type         TEXT,
      platform_id          TEXT,
      platform_message_id  TEXT,
      expires_at           TEXT,
      status               TEXT NOT NULL DEFAULT 'pending',
      title                TEXT NOT NULL DEFAULT '',
      options_json         TEXT NOT NULL DEFAULT '[]'
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
    '015_add_pending_approvals',
  ]) {
    stmt.run(v, new Date().toISOString());
  }
}

describe('migrations 016-018 (Phase 4D multi-user-flow tables)', () => {
  it('creates pending_sender_approvals with the right columns, PK, UNIQUE, and index', async () => {
    const db = new Database(':memory:');
    buildPre016Schema(db);

    // Sanity: tables absent pre-migration
    const beforeTables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(beforeTables).not.toContain('pending_sender_approvals');
    expect(beforeTables).not.toContain('pending_channel_approvals');
    expect(beforeTables).not.toContain('pending_questions');

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('pending_sender_approvals');

    const cols = db.pragma('table_info(pending_sender_approvals)') as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    for (const expected of [
      'id',
      'messaging_group_id',
      'agent_group_id',
      'sender_identity',
      'sender_name',
      'original_message',
      'approver_user_id',
      'approval_id',
      'title',
      'options_json',
      'created_at',
    ]) {
      expect(colNames).toContain(expected);
    }

    // PK on id
    expect(cols.find((c) => c.name === 'id')!.pk).toBe(1);

    // UNIQUE(messaging_group_id, sender_identity)
    const indexes = db.pragma('index_list(pending_sender_approvals)') as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    const uniqueIdx = indexes.find((i) => i.unique === 1 && i.origin === 'u');
    expect(uniqueIdx).toBeDefined();
    const uniqueCols = (db.pragma(`index_info(${uniqueIdx!.name})`) as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(uniqueCols).toEqual(['messaging_group_id', 'sender_identity']);

    // Named index on messaging_group_id
    const indexNames = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pending_sender_approvals'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexNames).toContain('idx_pending_sender_approvals_mg');

    // FK shape
    const fks = db.pragma('foreign_key_list(pending_sender_approvals)') as Array<{ from: string; table: string }>;
    expect(fks.find((fk) => fk.from === 'messaging_group_id' && fk.table === 'messaging_groups')).toBeDefined();
    expect(fks.find((fk) => fk.from === 'agent_group_id' && fk.table === 'agent_groups')).toBeDefined();
    expect(fks.find((fk) => fk.from === 'approver_user_id' && fk.table === 'users')).toBeDefined();
    expect(fks.find((fk) => fk.from === 'approval_id' && fk.table === 'pending_approvals')).toBeDefined();
  });

  it('creates pending_channel_approvals with the right columns, PK, and FK shape', async () => {
    const db = new Database(':memory:');
    buildPre016Schema(db);

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('pending_channel_approvals');

    const cols = db.pragma('table_info(pending_channel_approvals)') as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    for (const expected of [
      'messaging_group_id',
      'agent_group_id',
      'original_message',
      'approver_user_id',
      'approval_id',
      'title',
      'options_json',
      'created_at',
    ]) {
      expect(colNames).toContain(expected);
    }

    // PK on messaging_group_id
    expect(cols.find((c) => c.name === 'messaging_group_id')!.pk).toBe(1);

    // FK shape
    const fks = db.pragma('foreign_key_list(pending_channel_approvals)') as Array<{ from: string; table: string }>;
    expect(fks.find((fk) => fk.from === 'messaging_group_id' && fk.table === 'messaging_groups')).toBeDefined();
    expect(fks.find((fk) => fk.from === 'agent_group_id' && fk.table === 'agent_groups')).toBeDefined();
    expect(fks.find((fk) => fk.from === 'approver_user_id' && fk.table === 'users')).toBeDefined();
    expect(fks.find((fk) => fk.from === 'approval_id' && fk.table === 'pending_approvals')).toBeDefined();
  });

  it('creates pending_questions with the right columns and PK; session_id has NO foreign-key (v1-archive divergence)', async () => {
    const db = new Database(':memory:');
    buildPre016Schema(db);

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('pending_questions');

    const cols = db.pragma('table_info(pending_questions)') as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    for (const expected of [
      'question_id',
      'session_id',
      'message_out_id',
      'platform_id',
      'channel_type',
      'thread_id',
      'title',
      'options_json',
      'approval_id',
      'created_at',
    ]) {
      expect(colNames).toContain(expected);
    }

    // PK on question_id
    expect(cols.find((c) => c.name === 'question_id')!.pk).toBe(1);

    // session_id is NOT NULL but has no FK reference — v1-archive lacks the
    // per-session sessions table that v2 has (Phase 6 territory).
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.session_id.notnull).toBe(1);
    expect(byName.message_out_id.notnull).toBe(1);
    expect(byName.title.notnull).toBe(1);
    expect(byName.options_json.notnull).toBe(1);

    const fks = db.pragma('foreign_key_list(pending_questions)') as Array<{ from: string; table: string }>;
    expect(fks.find((fk) => fk.from === 'session_id')).toBeUndefined();
    // approval_id retains its FK to pending_approvals (unified card-expiry sweep)
    expect(fks.find((fk) => fk.from === 'approval_id' && fk.table === 'pending_approvals')).toBeDefined();
  });

  it('migration 017 idempotently adds messaging_groups.denied_at when absent', async () => {
    const db = new Database(':memory:');
    buildPre016Schema(db, { withDeniedAt: false });

    const beforeCols = (db.pragma('table_info(messaging_groups)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(beforeCols).not.toContain('denied_at');

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const afterCols = (db.pragma('table_info(messaging_groups)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(afterCols).toContain('denied_at');
  });

  it('migration 017 skips the ALTER when messaging_groups.denied_at already exists', async () => {
    const db = new Database(':memory:');
    buildPre016Schema(db, { withDeniedAt: true });

    const beforeCols = (db.pragma('table_info(messaging_groups)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(beforeCols).toContain('denied_at');

    // Should not throw "duplicate column name"
    const { runMigrations } = await import('../db/init.js');
    expect(() => runMigrations(db)).not.toThrow();

    const afterCols = (db.pragma('table_info(messaging_groups)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(afterCols).toContain('denied_at');
  });

  it('all three migrations are idempotent: re-running is a no-op', async () => {
    const db = new Database(':memory:');
    buildPre016Schema(db);

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const versionsBefore = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);

    expect(() => runMigrations(db)).not.toThrow();

    const versionsAfter = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versionsAfter).toHaveLength(versionsBefore.length);
    expect(new Set(versionsAfter)).toEqual(new Set(versionsBefore));

    // schema_version should record all three new migrations
    expect(versionsAfter).toContain('016_add_pending_sender_approvals');
    expect(versionsAfter).toContain('017_add_pending_channel_approvals');
    expect(versionsAfter).toContain('018_add_pending_questions');
  });

  it('fresh-install path via _initTestDatabaseFrom creates all three Phase 4D tables from createSchema', async () => {
    const db = new Database(':memory:');
    const { _initTestDatabaseFrom } = await import('../db/init.js');
    _initTestDatabaseFrom(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('pending_sender_approvals');
    expect(tables).toContain('pending_channel_approvals');
    expect(tables).toContain('pending_questions');

    // Fresh install also has denied_at on messaging_groups (from
    // ENTITY_MODEL_DDL — migration 017's PRAGMA guard skips the ALTER)
    const mgCols = (db.pragma('table_info(messaging_groups)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(mgCols).toContain('denied_at');

    // Index on pending_sender_approvals also present on fresh install
    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pending_sender_approvals'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_pending_sender_approvals_mg');

    const versions = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('016_add_pending_sender_approvals');
    expect(versions).toContain('017_add_pending_channel_approvals');
    expect(versions).toContain('018_add_pending_questions');
  });
});
