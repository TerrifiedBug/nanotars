# Scheduled Tasks

Recurring and one-time tasks created by agents via IPC.

## Creating Tasks

Agents write to `/workspace/ipc/tasks/`:
```json
{
  "type": "schedule_task",
  "prompt": "Check weather and summarize",
  "schedule_type": "cron",
  "schedule_value": "0 8 * * *",
  "targetJid": "120363XXX@g.us",
  "context_mode": "isolated",
  "model": "haiku"
}
```

## Schedule Types

| Type | Format | Example |
|------|--------|---------|
| `cron` | Cron expression | `0 8 * * *` (daily 8am) |
| `interval` | Milliseconds | `3600000` (hourly) |
| `once` | ISO 8601 | `2026-03-01T09:00:00Z` |

## Context Modes

| Mode | Description |
|------|-------------|
| `isolated` | Fresh container, no history (default) |
| `group` | Resumes group's conversation session |

## Task Lifecycle

```
active → running → active (next_run updated)
                 → paused (manual or auto-pause on missing group)
                 → cancelled
```

## Management

| Command | Effect |
|---------|--------|
| `pause_task` | Stops scheduling |
| `resume_task` | Resumes paused task |
| `cancel_task` | Marks cancelled |
| `delete_task` | Removes from database |

## Authorization

- Main group can schedule for any group
- Other groups can only target themselves

## Querying

```bash
# Active tasks
sqlite3 store/messages.db "SELECT id, group_folder, prompt, schedule_type, next_run FROM scheduled_tasks WHERE status = 'active';"

# Recent runs
sqlite3 store/messages.db "SELECT task_id, run_at, status, duration_ms FROM task_run_logs ORDER BY run_at DESC LIMIT 10;"
```
