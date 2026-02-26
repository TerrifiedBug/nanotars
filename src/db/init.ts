import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { runStartupTasks } from './migrate.js';

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

/** Event emitter for database changes. Emits 'new-message' with chatJid after inserts. */
export const dbEvents = new EventEmitter();
dbEvents.setMaxListeners(50);

function createSchema(database: Database.Database): void {
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
    CREATE TABLE IF NOT EXISTS registered_groups (
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

  runMigrations(database);
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
    up: (db) => safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN channel TEXT`),
  },
  {
    name: '004_add_is_bot_message',
    up: (db) => {
      safeAddColumn(db, `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`);
      db.prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`).run(`${ASSISTANT_NAME}:%`);
    },
  },
  {
    name: '005_add_reply_context',
    up: (db) => safeAddColumn(db, `ALTER TABLE messages ADD COLUMN reply_context TEXT`),
  },
];

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  // Detect pre-existing databases that used the old ALTER-TABLE-based system.
  // Check the last migration's column as proof all prior migrations ran.
  // If a future migration adds columns to a different table, add its sentinel here.
  const applied = database.prepare('SELECT version FROM schema_version').all() as Array<{ version: string }>;
  if (applied.length === 0) {
    const msgCols = database.pragma('table_info(messages)') as Array<{ name: string }>;
    const taskCols = database.pragma('table_info(scheduled_tasks)') as Array<{ name: string }>;
    const groupCols = database.pragma('table_info(registered_groups)') as Array<{ name: string }>;
    const hasAllMigrated =
      msgCols.some((c) => c.name === 'is_bot_message') &&
      taskCols.some((c) => c.name === 'context_mode') &&
      taskCols.some((c) => c.name === 'model') &&
      groupCols.some((c) => c.name === 'channel');
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
  createSchema(db);

  // Post-schema startup: JSON migration + log pruning
  runStartupTasks();

  // Create a backup on startup
  backupDatabase();
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

