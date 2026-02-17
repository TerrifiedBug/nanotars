# Database

## Overview

NanoClaw uses SQLite via `better-sqlite3` with WAL (Write-Ahead Logging) mode for concurrent read/write performance. Database file: `store/messages.db`.

## Schema

### messages

Stores full message content for registered groups only.

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT NOT NULL,
  is_from_me INTEGER DEFAULT 0,
  is_bot_message INTEGER DEFAULT 0,
  PRIMARY KEY (id, chat_jid)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Platform message ID |
| `chat_jid` | TEXT | Chat identifier (e.g., `123@g.us`, `tg:-100456`) |
| `sender` | TEXT | Sender identifier |
| `sender_name` | TEXT | Display name |
| `content` | TEXT | Message text |
| `timestamp` | TEXT | ISO 8601 timestamp |
| `is_from_me` | INTEGER | 1 if sent by the bot |
| `is_bot_message` | INTEGER | 1 if sent by any bot |

**Deduplication:** Composite primary key `(id, chat_jid)` with INSERT OR IGNORE.

### chats

Tracks all chats for group discovery (registered and unregistered).

```sql
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);
```

### registered_groups

Groups actively monitored by NanoClaw.

```sql
CREATE TABLE IF NOT EXISTS registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  trigger_pattern TEXT,
  added_at TEXT NOT NULL,
  requires_trigger INTEGER DEFAULT 1,
  container_config TEXT,
  channel TEXT
);
```

| Column | Type | Description |
|--------|------|-------------|
| `jid` | TEXT | Chat JID (primary key) |
| `name` | TEXT | Display name |
| `folder` | TEXT | Group folder name under `groups/` |
| `trigger_pattern` | TEXT | Regex trigger (e.g., `@assistant`) |
| `added_at` | TEXT | ISO 8601 registration timestamp |
| `requires_trigger` | INTEGER | 1 = needs trigger, 0 = responds to all |
| `container_config` | TEXT | JSON: `{additionalMounts, timeout}` |
| `channel` | TEXT | Channel that owns this group (whatsapp, telegram, etc.) |

### scheduled_tasks

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL,
  context_mode TEXT DEFAULT 'isolated',
  model TEXT DEFAULT 'claude-sonnet-4-5'
);
```

| Column | Type | Description |
|--------|------|-------------|
| `schedule_type` | TEXT | `cron`, `interval`, or `once` |
| `schedule_value` | TEXT | Cron expression / milliseconds / ISO date |
| `status` | TEXT | `active`, `paused`, `completed` |
| `next_run` | TEXT | Next scheduled execution (NULL = claimed/running) |
| `context_mode` | TEXT | `isolated` (fresh session) or `group` (shared) |
| `model` | TEXT | Model override for this task |

### task_run_logs

Audit trail for task execution.

```sql
CREATE TABLE IF NOT EXISTS task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT,
  result TEXT,
  error TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);
```

Pruned to 30 days on startup.

### sessions

Session persistence for container agents.

```sql
CREATE TABLE IF NOT EXISTS sessions (
  jid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### router_state

Tracks message cursor per chat.

```sql
CREATE TABLE IF NOT EXISTS router_state (
  jid TEXT PRIMARY KEY,
  last_seen_timestamp TEXT NOT NULL
);
```

## Migrations

Schema migrations use `ALTER TABLE` with defensive error handling:

```typescript
const migrate = (sql: string) => {
  try { database.exec(sql); }
  catch (err) {
    if (!(err instanceof Error && err.message.includes('duplicate column'))) throw err;
  }
};
```

Only harmless "duplicate column" errors are ignored. Serious errors (corruption, disk full) propagate.

### Legacy JSON Migration

On first database init, legacy JSON files are automatically migrated:
- `router_state.json` → `router_state` table
- `sessions.json` → `sessions` table
- `registered_groups.json` → `registered_groups` table

Original files renamed with `.migrated` suffix to prevent re-migration.

## Key Query Patterns

### Message Retrieval

```sql
SELECT * FROM messages
WHERE chat_jid = ? AND timestamp >= ?
ORDER BY timestamp ASC
```

Uses `>=` comparison (not `>`) to avoid losing same-second messages. Callers must track processed IDs for deduplication.

### Due Task Discovery

```sql
SELECT * FROM scheduled_tasks
WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
```

### Task Claiming

```sql
UPDATE scheduled_tasks SET next_run = NULL WHERE id = ?
```

Setting `next_run = NULL` prevents the scheduler from re-enqueueing the same task while its container runs.

### Bot Message Filtering

Messages are filtered using both `is_bot_message` flag AND content prefix matching (`ASSISTANT_NAME:`) as a backstop for pre-migration data.

## Backups

- Created automatically on startup using SQLite's online backup API (safe during live operation)
- Stored in `store/backups/messages-{ISO-timestamp}.db`
- Keeps 2 most recent backups, removes older ones
- Non-blocking: uses `db.backup()` promise

## WAL Mode

WAL (Write-Ahead Logging) is enabled at database init:

```typescript
db.pragma('journal_mode = WAL');
```

Benefits:
- Readers don't block writers
- Writers don't block readers
- Better concurrent performance for the polling-based architecture
