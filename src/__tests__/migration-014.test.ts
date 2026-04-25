import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Build a pre-014 schema: all Phase 4A entity-model tables + all four Phase 4B
 * RBAC tables exist. Migrations 001-013 are pre-marked as applied so
 * runMigrations starts at 014 only.
 */
function buildPre014Schema(db: Database.Database): void {
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
    CREATE INDEX IF NOT EXISTS idx_messaging_group_agents_mg ON messaging_group_agents(messaging_group_id);
    CREATE INDEX IF NOT EXISTS idx_messaging_group_agents_ag ON messaging_group_agents(agent_group_id);

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
    CREATE INDEX IF NOT EXISTS idx_user_roles_scope ON user_roles(agent_group_id, role);
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
  ]) {
    stmt.run(v, new Date().toISOString());
  }
}

describe('migration 014_seed_sender_allowlist_to_members', () => {
  let tempDir: string;
  let allowlistPath: string;
  const originalEnv = process.env.NANOCLAW_SENDER_ALLOWLIST_PATH;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-m014-test-'));
    allowlistPath = path.join(tempDir, 'sender-allowlist.json');
    process.env.NANOCLAW_SENDER_ALLOWLIST_PATH = allowlistPath;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.NANOCLAW_SENDER_ALLOWLIST_PATH = originalEnv;
    } else {
      delete process.env.NANOCLAW_SENDER_ALLOWLIST_PATH;
    }
  });

  it('seeds users + agent_group_members from legacy JSON when file exists', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);

    const now = new Date().toISOString();
    // Pre-create agent_group, messaging_group, and wiring
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ag-1', 'main', 'main', null, null, now);
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('mg-1', 'whatsapp', 'alice@s.whatsapp.net', null, 0, 'public', now);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-1', 'ag-1', 'pattern', null, 'all', 'drop', 'shared', 0, now);

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        default: { allow: '*', mode: 'trigger' },
        chats: {
          'alice@s.whatsapp.net': { allow: ['alice123', 'bob456'], mode: 'drop' },
        },
        logDenied: true,
      }),
    );

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const users = db.prepare('SELECT id, kind FROM users ORDER BY id').all() as Array<{
      id: string;
      kind: string;
    }>;
    expect(users.find((u) => u.id === 'whatsapp:alice123')).toBeDefined();
    expect(users.find((u) => u.id === 'whatsapp:bob456')).toBeDefined();
    expect(users.find((u) => u.id === 'whatsapp:alice123')?.kind).toBe('whatsapp');

    const members = db
      .prepare('SELECT user_id, agent_group_id FROM agent_group_members ORDER BY user_id')
      .all() as Array<{ user_id: string; agent_group_id: string }>;
    expect(
      members.find((m) => m.user_id === 'whatsapp:alice123' && m.agent_group_id === 'ag-1'),
    ).toBeDefined();
    expect(
      members.find((m) => m.user_id === 'whatsapp:bob456' && m.agent_group_id === 'ag-1'),
    ).toBeDefined();

    // 014 is recorded in schema_version
    const versions = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('014_seed_sender_allowlist_to_members');
  });

  it('seeds members for multiple chat entries', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ag-1', 'main', 'main', null, null, now);
    // Two messaging groups wired to the same agent group
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('mg-1', 'whatsapp', 'chat1@s.whatsapp.net', null, 0, 'public', now);
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('mg-2', 'whatsapp', 'chat2@s.whatsapp.net', null, 1, 'public', now);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-1', 'ag-1', 'pattern', null, 'all', 'drop', 'shared', 0, now);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mga-2', 'mg-2', 'ag-1', 'pattern', null, 'all', 'drop', 'shared', 0, now);

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        default: { allow: '*', mode: 'trigger' },
        chats: {
          'chat1@s.whatsapp.net': { allow: ['userA'], mode: 'trigger' },
          'chat2@s.whatsapp.net': { allow: ['userB', 'userC'], mode: 'drop' },
        },
      }),
    );

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const members = db
      .prepare('SELECT user_id FROM agent_group_members ORDER BY user_id')
      .all() as Array<{ user_id: string }>;
    const ids = members.map((m) => m.user_id);
    expect(ids).toContain('whatsapp:userA');
    expect(ids).toContain('whatsapp:userB');
    expect(ids).toContain('whatsapp:userC');
  });

  it('skips chats whose platform_id is not in messaging_groups', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ag-1', 'main', 'main', null, null, now);
    // No messaging_group inserted — so the jid lookup will return undefined

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        default: { allow: '*', mode: 'trigger' },
        chats: {
          'unknown@s.whatsapp.net': { allow: ['someone'], mode: 'trigger' },
        },
      }),
    );

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const users = db.prepare('SELECT id FROM users').all();
    expect(users).toHaveLength(0);
    const members = db.prepare('SELECT user_id FROM agent_group_members').all();
    expect(members).toHaveLength(0);
  });

  it('is a no-op when the JSON file does not exist', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);
    // Do NOT write the JSON file

    const { runMigrations } = await import('../db/init.js');
    expect(() => runMigrations(db)).not.toThrow();

    const users = db.prepare('SELECT id FROM users').all();
    expect(users).toHaveLength(0);
    const members = db.prepare('SELECT user_id FROM agent_group_members').all();
    expect(members).toHaveLength(0);

    // Migration still records itself in schema_version
    const versions = (
      db.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>
    ).map((r) => r.version);
    expect(versions).toContain('014_seed_sender_allowlist_to_members');
  });

  it('skips malformed JSON gracefully without throwing', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);

    fs.writeFileSync(allowlistPath, 'not valid json { at all');

    const { runMigrations } = await import('../db/init.js');
    expect(() => runMigrations(db)).not.toThrow();

    const users = db.prepare('SELECT id FROM users').all();
    expect(users).toHaveLength(0);
  });

  it('skips JSON with no chats key gracefully', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({ default: { allow: '*', mode: 'trigger' }, logDenied: true }),
    );

    const { runMigrations } = await import('../db/init.js');
    expect(() => runMigrations(db)).not.toThrow();

    const users = db.prepare('SELECT id FROM users').all();
    expect(users).toHaveLength(0);
  });

  it('skips chat entries with non-array allow value', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ag-1', 'main', 'main', null, null, now);
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('mg-1', 'whatsapp', 'chat@s.whatsapp.net', null, 0, 'public', now);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-1', 'ag-1', 'pattern', null, 'all', 'drop', 'shared', 0, now);

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        default: { allow: '*', mode: 'trigger' },
        chats: {
          // allow='*' is not an array — should be skipped by the migration
          'chat@s.whatsapp.net': { allow: '*', mode: 'trigger' },
        },
      }),
    );

    const { runMigrations } = await import('../db/init.js');
    expect(() => runMigrations(db)).not.toThrow();

    // allow='*' means all senders are allowed — migration correctly skips it
    // since there's no explicit member list to seed
    const users = db.prepare('SELECT id FROM users').all();
    expect(users).toHaveLength(0);
  });

  it('is idempotent: re-running migrations does not duplicate rows', async () => {
    const db = new Database(':memory:');
    buildPre014Schema(db);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ag-1', 'main', 'main', null, null, now);
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('mg-1', 'whatsapp', 'chat@s.whatsapp.net', null, 0, 'public', now);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-1', 'ag-1', 'pattern', null, 'all', 'drop', 'shared', 0, now);

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        default: { allow: '*', mode: 'trigger' },
        chats: { 'chat@s.whatsapp.net': { allow: ['user1'], mode: 'trigger' } },
      }),
    );

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const membersBefore = db.prepare('SELECT user_id FROM agent_group_members').all();
    expect(membersBefore).toHaveLength(1);

    // Re-run — migration is skipped because 014 is already in schema_version
    expect(() => runMigrations(db)).not.toThrow();

    const membersAfter = db.prepare('SELECT user_id FROM agent_group_members').all();
    expect(membersAfter).toHaveLength(1); // no duplicates
  });
});
