---
name: nanoclaw-db-maintenance
description: Run SQLite database maintenance — vacuum, integrity check, prune old data, report statistics
triggers:
  - db maintenance
  - database maintenance
  - vacuum database
  - clean database
  - database health
---

# Database Maintenance

Runs maintenance operations on the NanoClaw SQLite database at `store/messages.db`.

## Step 1: Backup

Always back up before maintenance:

```bash
cp store/messages.db "store/backups/messages-$(date +%Y%m%d-%H%M%S).db"
ls -la store/backups/
```

Keep only the 3 most recent backups:

```bash
ls -1t store/backups/messages-*.db | tail -n +4 | xargs rm -f 2>/dev/null
echo "Backups retained: $(ls store/backups/messages-*.db 2>/dev/null | wc -l)"
```

## Step 2: Report statistics

```bash
sqlite3 store/messages.db << 'SQL'
.mode column
.headers on
SELECT 'Messages' as table_name, COUNT(*) as row_count FROM messages
UNION ALL SELECT 'Chats', COUNT(*) FROM chats
UNION ALL SELECT 'Scheduled Tasks', COUNT(*) FROM scheduled_tasks
UNION ALL SELECT 'Task Run Logs', COUNT(*) FROM task_run_logs
UNION ALL SELECT 'Sessions', COUNT(*) FROM sessions;
SQL

echo ""
echo "Database file size:"
ls -lh store/messages.db
```

## Step 3: Integrity check

```bash
sqlite3 store/messages.db "PRAGMA integrity_check;"
```

Expected output: `ok`. If errors, report them and stop — do not proceed with VACUUM on a corrupt database.

## Step 4: Prune old data

Ask the user how many days of data to retain (default: 90 days for messages, 30 days for task logs).

```bash
# Prune old task run logs (default 30 days)
DELETED=$(sqlite3 store/messages.db "DELETE FROM task_run_logs WHERE run_at < datetime('now', '-30 days'); SELECT changes();")
echo "Deleted ${DELETED} old task run logs"

# Prune old messages (default 90 days) — ask before running
DELETED=$(sqlite3 store/messages.db "DELETE FROM messages WHERE timestamp < datetime('now', '-90 days'); SELECT changes();")
echo "Deleted ${DELETED} old messages"
```

## Step 5: Optimize

```bash
sqlite3 store/messages.db "ANALYZE;"
sqlite3 store/messages.db "VACUUM;"
echo "Database optimized"
```

## Step 6: Report final state

Re-run the statistics from Step 2 to show before/after comparison.

```bash
echo "Maintenance complete."
ls -lh store/messages.db
```
