import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;

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

  // Migrate from JSON files if they exist
  migrateJsonState();

  // Create a backup on startup
  backupDatabase();

  // Prune old task run logs
  const pruned = pruneTaskRunLogs();
  if (pruned > 0) {
    logger.info({ pruned }, 'Pruned old task run logs');
  }
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

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_context ? JSON.stringify(msg.reply_context) : null,
  );
  dbEvents.emit('new-message', msg.chat_jid);
}

/**
 * Store an externally-originated message (plain strings, no channel SDK dependency).
 * Used by plugins (webhooks, channels, etc.) to inject messages into the
 * message store so the polling loop picks them up like any other message.
 */
export function insertExternalMessage(
  chatJid: string,
  messageId: string,
  sender: string,
  senderName: string,
  text: string,
): void {
  const timestamp = new Date().toISOString();

  storeChatMetadata(chatJid, timestamp, senderName);

  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageId, chatJid, sender, senderName, text, timestamp, 0);
  dbEvents.emit('new-message', chatJid);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Use >= so that messages arriving in the same second as the cursor are
  // not permanently skipped. Callers must track processed IDs to deduplicate.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, reply_context
    FROM messages
    WHERE timestamp >= ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as Array<
      Omit<NewMessage, 'reply_context'> & { reply_context: string | null }
    >;

  const messages: NewMessage[] = rows.map((row) => ({
    ...row,
    reply_context: row.reply_context ? JSON.parse(row.reply_context) : undefined,
  }));

  let newTimestamp = lastTimestamp;
  for (const row of messages) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, reply_context
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as Array<
      Omit<NewMessage, 'reply_context'> & { reply_context: string | null }
    >;
  return rows.map((row) => ({
    ...row,
    reply_context: row.reply_context ? JSON.parse(row.reply_context) : undefined,
  }));
}

/**
 * Look up a message's sender and fromMe status for reaction routing.
 * Returns null if the message isn't found.
 */
export function getMessageMeta(
  messageId: string,
  chatJid: string,
): { sender: string; isFromMe: boolean } | null {
  const row = db
    .prepare('SELECT sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?')
    .get(messageId, chatJid) as { sender: string; is_from_me: number } | undefined;
  if (!row) return null;
  return { sender: row.sender, isFromMe: row.is_from_me === 1 };
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, model, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.model || 'claude-sonnet-4-5',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'model'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/**
 * Claim a task for execution by clearing its next_run.
 * Prevents the scheduler from re-enqueuing it while it's running.
 */
export function claimTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET next_run = NULL WHERE id = ?`).run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function getTaskRunLogs(taskId: string, limit = 50): TaskRunLog[] {
  return db
    .prepare('SELECT task_id, run_at, duration_ms, status, result, error FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?')
    .all(taskId, limit) as TaskRunLog[];
}

/** Get recent task run logs across all tasks with a single JOIN query. */
export function getRecentTaskRunLogs(limit = 15): Array<TaskRunLog & { group_folder: string; prompt: string }> {
  return db
    .prepare(`
      SELECT trl.task_id, trl.run_at, trl.duration_ms, trl.status, trl.result, trl.error,
             st.group_folder, st.prompt
      FROM task_run_logs trl
      JOIN scheduled_tasks st ON trl.task_id = st.id
      ORDER BY trl.run_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<TaskRunLog & { group_folder: string; prompt: string }>;
}

export function getRecentMessages(jid: string, limit = 50): NewMessage[] {
  return db
    .prepare('SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?')
    .all(jid, limit) as NewMessage[];
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

/** Delete task_run_logs older than the given number of days. */
export function pruneTaskRunLogs(olderThanDays = 30): number {
  const result = db.prepare(
    `DELETE FROM task_run_logs WHERE run_at < datetime('now', ?)`,
  ).run(`-${olderThanDays} days`);
  return result.changes;
}

/** Delete all scheduled tasks for a given group folder. Returns count deleted. */
export function deleteTasksForGroup(groupFolder: string): number {
  const result = db.prepare(
    'DELETE FROM scheduled_tasks WHERE group_folder = ?',
  ).run(groupFolder);
  return result.changes;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  channel: string | null;
}

function mapRegisteredGroupRow(row: RegisteredGroupRow): RegisteredGroup {
  return {
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    channel: row.channel || undefined,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

/** Validate folder name from DB to prevent path traversal from corrupted data. */
const SAFE_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  return SAFE_FOLDER_RE.test(folder) && !RESERVED_FOLDERS.has(folder.toLowerCase());
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn({ jid, folder: row.folder }, 'Skipping registered group with invalid folder name');
    return undefined;
  }
  return { jid: row.jid, ...mapRegisteredGroupRow(row) };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
  channel?: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    channel || null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn({ jid: row.jid, folder: row.folder }, 'Skipping registered group with invalid folder name');
      continue;
    }
    result[row.jid] = mapRegisteredGroupRow(row);
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}
