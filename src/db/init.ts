import crypto from 'crypto';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { runStartupTasks } from './migrate.js';

/**
 * Shared DDL for the Phase 4A entity-model tables. Used by both createSchema
 * (fresh-install path) and migration 008 (existing-DB path) so column-level
 * divergence between the two is structurally impossible.
 */
const ENTITY_MODEL_DDL = `
  CREATE TABLE IF NOT EXISTS agent_groups (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    folder          TEXT NOT NULL UNIQUE,
    agent_provider  TEXT,
    container_config TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messaging_groups (
    id                    TEXT PRIMARY KEY,
    channel_type          TEXT NOT NULL,
    platform_id           TEXT NOT NULL,
    name                  TEXT,
    is_group              INTEGER DEFAULT 0,
    unknown_sender_policy TEXT NOT NULL DEFAULT 'public',
    created_at            TEXT NOT NULL,
    UNIQUE(channel_type, platform_id)
  );
  CREATE TABLE IF NOT EXISTS messaging_group_agents (
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
`;

/**
 * Shared DDL for the Phase 4B RBAC tables. Mirrors the ENTITY_MODEL_DDL
 * pattern: createSchema (fresh-install path) and migrations 010-013
 * (existing-DB path) reference the same per-table sub-constants so column-level
 * divergence is structurally impossible.
 *
 * Migration 014 is reserved for B8 (sender-allowlist subsumption into
 * agent_group_members) and ships as a no-op for now.
 */
const USERS_DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    display_name TEXT,
    created_at   TEXT NOT NULL
  );
`;
const USER_ROLES_DDL = `
  CREATE TABLE IF NOT EXISTS user_roles (
    user_id        TEXT NOT NULL REFERENCES users(id),
    role           TEXT NOT NULL,
    agent_group_id TEXT REFERENCES agent_groups(id),
    granted_by     TEXT REFERENCES users(id),
    granted_at     TEXT NOT NULL,
    PRIMARY KEY (user_id, role, agent_group_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_roles_scope ON user_roles(agent_group_id, role);
`;
const AGENT_GROUP_MEMBERS_DDL = `
  CREATE TABLE IF NOT EXISTS agent_group_members (
    user_id        TEXT NOT NULL REFERENCES users(id),
    agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
    added_by       TEXT REFERENCES users(id),
    added_at       TEXT NOT NULL,
    PRIMARY KEY (user_id, agent_group_id)
  );
`;
const USER_DMS_DDL = `
  CREATE TABLE IF NOT EXISTS user_dms (
    user_id            TEXT NOT NULL REFERENCES users(id),
    channel_type       TEXT NOT NULL,
    messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
    resolved_at        TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_type)
  );
`;
const RBAC_DDL = USERS_DDL + USER_ROLES_DDL + AGENT_GROUP_MEMBERS_DDL + USER_DMS_DDL;

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

/** Event emitter for database changes. Emits 'new-message' with chatJid after inserts. */
export const dbEvents = new EventEmitter();
dbEvents.setMaxListeners(50);

export function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      model TEXT DEFAULT 'claude-sonnet-4-5',
      script TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unregistered_senders (
      channel TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (channel, platform_id)
    );
    CREATE INDEX IF NOT EXISTS idx_unregistered_last_seen ON unregistered_senders(last_seen);

  `);

  database.exec(ENTITY_MODEL_DDL);
  database.exec(RBAC_DDL);

  runMigrations(database);
}

/**
 * Check whether a table exists in the connected database.
 *
 * `name` must be a SQL-identifier-shaped string ([A-Za-z_][A-Za-z0-9_]*);
 * unsafe input throws. The underlying lookup uses `?` parameter binding so
 * SQLite already treats `name` as a string literal — the regex is a
 * caller-error guard (catches typos and SQL fragments accidentally passed
 * as identifiers), not the injection defense.
 *
 * Ported from upstream nanoclaw v2 src/db/connection.ts hasTable utility.
 */
export function hasTable(db: Database.Database, name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name: ${JSON.stringify(name)}`);
  }
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** Safely add a column, ignoring "duplicate column name" errors. */
function safeAddColumn(db: Database.Database, sql: string): void {
  try { db.exec(sql); } catch (err: any) {
    if (!String(err.message).includes('duplicate column')) throw err;
  }
}

/** Ordered list of schema migrations. Each entry runs once, in order. */
const MIGRATIONS: Array<{ name: string; up: (db: Database.Database) => void }> = [
  {
    name: '001_add_context_mode',
    up: (db) => safeAddColumn(db, `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`),
  },
  {
    name: '002_add_model',
    up: (db) => safeAddColumn(db, `ALTER TABLE scheduled_tasks ADD COLUMN model TEXT DEFAULT 'claude-sonnet-4-5'`),
  },
  {
    name: '003_add_channel',
    up: (db) => {
      // A7 removed `registered_groups` from createSchema. On fresh installs
      // this migration is a no-op; on legacy DBs the column add still runs.
      if (!hasTable(db, 'registered_groups')) return;
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN channel TEXT`);
    },
  },
  {
    name: '004_add_is_bot_message',
    up: (db) => {
      // Idempotent: safeAddColumn no-ops if column already exists (e.g. fresh
      // installs where createSchema already added it). The UPDATE then
      // back-fills any pre-migration messages (no-op on a brand-new DB).
      safeAddColumn(db, `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`);
      db.prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`).run(`${ASSISTANT_NAME}:%`);
    },
  },
  {
    name: '005_add_reply_context',
    up: (db) => safeAddColumn(db, `ALTER TABLE messages ADD COLUMN reply_context TEXT`),
  },
  {
    name: '006_add_task_script',
    up: (db) => safeAddColumn(db, `ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`),
  },
  {
    name: '007_add_engage_mode_axes',
    up: (db) => {
      // Phase 2 commit 1e086d2 replaced requires_trigger + trigger_pattern
      // with the 4-axis engage model directly in createSchema DDL. Backfill
      // for any dev DB that pre-dates that commit. safeAddColumn is
      // idempotent — re-running is a no-op when the column already exists.
      // A7 removed `registered_groups` from createSchema; skip on fresh
      // installs where the table never existed.
      if (!hasTable(db, 'registered_groups')) return;
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN engage_mode TEXT NOT NULL DEFAULT 'pattern'`);
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN pattern TEXT`);
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN sender_scope TEXT NOT NULL DEFAULT 'all'`);
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN ignored_message_policy TEXT NOT NULL DEFAULT 'drop'`);

      // Best-effort copy from old columns if they exist. SQLite ≤3.35 has
      // no DROP COLUMN; legacy columns stay as unused dead weight.
      const cols = (db.pragma('table_info(registered_groups)') as Array<{ name: string }>).map((c) => c.name);
      if (cols.includes('trigger_pattern')) {
        db.exec(`UPDATE registered_groups SET pattern = trigger_pattern WHERE pattern IS NULL AND trigger_pattern IS NOT NULL`);
      }
      if (cols.includes('requires_trigger')) {
        db.exec(`UPDATE registered_groups SET engage_mode = CASE WHEN requires_trigger = 0 THEN 'always' ELSE 'pattern' END WHERE engage_mode = 'pattern'`);
      }
    },
  },
  {
    name: '008_split_registered_groups',
    up: (db) => {
      // 1. Ensure the three new tables exist (idempotent; createSchema also creates them).
      // Uses the shared ENTITY_MODEL_DDL constant so column-level drift between
      // this migration and createSchema is structurally impossible.
      db.exec(ENTITY_MODEL_DDL);

      // 2. If registered_groups exists, copy its rows into the new tables.
      // Skip if already migrated (idempotent: re-running won't duplicate).
      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='registered_groups'`).all() as any[]);
      if (tables.length === 0) return;

      const rows = db.prepare(`SELECT * FROM registered_groups`).all() as any[];
      if (rows.length === 0) return;

      const insertAg = db.prepare(`INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      // messaging_groups.name is the chat title (not the agent name); fill in lazily
      // on next observation by the channel adapter. v1's registered_groups.name is
      // the agent display name — semantically wrong here, so we write NULL instead.
      const insertMg = db.prepare(`INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, NULL, 0, 'public', ?)`);
      const findAg = db.prepare(`SELECT id FROM agent_groups WHERE folder = ?`);
      const findMg = db.prepare(`SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?`);
      const insertMga = db.prepare(`INSERT OR IGNORE INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', 0, ?)`);

      for (const row of rows) {
        const channelType = row.channel ?? 'whatsapp'; // Phase 1 default — pre-channel-aware rows
        insertAg.run(crypto.randomUUID(), row.name, row.folder, null, row.container_config, row.added_at);
        insertMg.run(crypto.randomUUID(), channelType, row.jid, row.added_at);
        const ag = findAg.get(row.folder) as { id: string };
        const mg = findMg.get(channelType, row.jid) as { id: string };
        insertMga.run(
          crypto.randomUUID(),
          mg.id,
          ag.id,
          row.engage_mode ?? 'pattern',
          row.pattern,
          row.sender_scope ?? 'all',
          row.ignored_message_policy ?? 'drop',
          row.added_at,
        );
      }
    },
  },
  {
    name: '009_drop_registered_groups',
    up: (db) => {
      // The legacy registered_groups table has been fully replaced by the
      // entity-model tables (agent_groups, messaging_groups,
      // messaging_group_agents). Migration 008 already copied any rows; this
      // step removes the now-orphaned table on dev DBs that pre-date A7.
      db.exec(`DROP TABLE IF EXISTS registered_groups`);
    },
  },
  {
    name: '010_add_users',
    up: (db) => {
      // Phase 4B RBAC foundation. Uses the shared USERS_DDL constant so
      // column-level drift between this migration and createSchema is
      // structurally impossible. IF NOT EXISTS makes re-runs a no-op.
      db.exec(USERS_DDL);
    },
  },
  {
    name: '011_add_user_roles',
    up: (db) => {
      db.exec(USER_ROLES_DDL);
    },
  },
  {
    name: '012_add_agent_group_members',
    up: (db) => {
      db.exec(AGENT_GROUP_MEMBERS_DDL);
    },
  },
  {
    name: '013_add_user_dms',
    up: (db) => {
      db.exec(USER_DMS_DDL);
    },
  },
  {
    name: '014_seed_sender_allowlist_to_members',
    up: (_db) => {
      // Reserved for Phase 4B Task B8: subsume the sender-allowlist into
      // agent_group_members so membership is the single source of truth for
      // "who is permitted to interact with this agent group". No-op for now;
      // landing the migration entry early lets the rest of Phase 4B (B2-B7)
      // build on a fixed migration count without renumbering when B8 lands.
    },
  },
];

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  // Detect pre-existing databases that used the old ALTER-TABLE-based system.
  // Check the last migration's column as proof all prior migrations ran.
  // If a future migration adds columns to a different table, add its sentinel here.
  //
  // A7 note: previously this also required `registered_groups.channel` but
  // that table no longer exists on fresh installs. The remaining
  // (messages.is_bot_message, scheduled_tasks.context_mode/model) sentinels
  // are sufficient to identify a pre-migration-system DB.
  const applied = database.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>;
  if (applied.length === 0) {
    const msgCols = database.pragma('table_info(messages)') as Array<{ name: string }>;
    const taskCols = database.pragma('table_info(scheduled_tasks)') as Array<{ name: string }>;
    const hasAllMigrated =
      msgCols.some((c) => c.name === 'is_bot_message') &&
      taskCols.some((c) => c.name === 'context_mode') &&
      taskCols.some((c) => c.name === 'model');
    if (hasAllMigrated) {
      // Mark only pre-migration-system migrations (001–004) as already applied.
      // Newer migrations (005+) must still run through the normal path.
      const PRE_MIGRATION_SYSTEM = ['001_add_context_mode', '002_add_model', '003_add_channel', '004_add_is_bot_message'];
      const now = new Date().toISOString();
      const stmt = database.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)');
      for (const name of PRE_MIGRATION_SYSTEM) {
        stmt.run(name, now);
      }
    }
  }

  // Re-query after potential sentinel detection inserts
  const currentApplied = database.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>;
  const appliedSet = new Set(currentApplied.map((r) => r.version));
  const now = new Date().toISOString();

  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.name)) continue;
    database.transaction(() => {
      migration.up(database);
      database.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(migration.name, now);
    })();
    logger.info({ migration: migration.name }, 'Applied migration');
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. Runs createSchema on an existing in-memory db (for migration testing). */
export function _initTestDatabaseFrom(database: Database.Database): void {
  db = database;
  createSchema(db);
}

/** @internal - for tests only. Returns the current schema version entries. */
export function _getSchemaVersion(): Array<{ version: string; applied_at: string }> {
  return db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version').all() as Array<{ version: string; applied_at: string }>;
}

/**
 * Create a backup of the database. Uses SQLite's online backup API
 * which is safe to call while the database is in use.
 * Keeps the two most recent backups and removes older ones.
 */
export function backupDatabase(): void {
  try {
    const dbPath = path.join(STORE_DIR, 'messages.db');
    const backupDir = path.join(STORE_DIR, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `messages-${timestamp}.db`);

    db.backup(backupPath).then(() => {
      logger.info({ backupPath }, 'Database backup completed');

      // Keep only the 2 most recent backups
      const backups = fs.readdirSync(backupDir)
        .filter((f) => f.startsWith('messages-') && f.endsWith('.db'))
        .sort()
        .reverse();
      for (const old of backups.slice(2)) {
        fs.unlinkSync(path.join(backupDir, old));
      }
    }).catch((err) => {
      logger.error({ err }, 'Database backup failed');
    });
  } catch (err) {
    logger.error({ err }, 'Database backup failed');
  }
}

