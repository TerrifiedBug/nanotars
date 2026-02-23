# IPC Protocol Reference

File-based IPC between the host process and agent containers.

## Directories

| Direction | Path | Purpose |
|-----------|------|---------|
| Host → Agent | `/workspace/ipc/input/` | Follow-up messages, close sentinel |
| Agent → Host | `/workspace/ipc/messages/` | Outbound messages |
| Agent → Host | `/workspace/ipc/tasks/` | Task scheduling |
| Host → Agent | `/workspace/ipc/current_tasks.json` | Task snapshot (read-only) |
| Host → Agent | `/workspace/ipc/available_groups.json` | Group list (main only) |

## Message Types (Agent → Host)

### message

```json
{
  "type": "message",
  "chatJid": "120363XXX@g.us",
  "text": "Hello",
  "sender": "Research",
  "replyTo": "3EB0XXXX"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | `"message"` | yes | |
| chatJid | string | yes | Target chat JID |
| text | string | yes | Message content |
| sender | string | no | Display name (bold prefix on WhatsApp) |
| replyTo | string | no | Message ID to reply to |

### send_file

```json
{
  "type": "send_file",
  "chatJid": "120363XXX@g.us",
  "filePath": "/workspace/group/output.png",
  "fileName": "chart.png",
  "caption": "Here's the chart"
}
```

Max file size: 64 MB.

### react

```json
{
  "type": "react",
  "chatJid": "120363XXX@g.us",
  "messageId": "3EB0XXXX",
  "emoji": "👍"
}
```

## Task Types (Agent → Host)

| Type | Required Fields | Description |
|------|----------------|-------------|
| `schedule_task` | prompt, schedule_type, schedule_value, targetJid | Create scheduled task |
| `pause_task` | taskId | Pause a task |
| `resume_task` | taskId | Resume a paused task |
| `cancel_task` | taskId | Cancel a task |
| `delete_task` | taskId | Delete permanently |
| `register_group` | jid, name, folder, trigger | Register group (main only) |

### schedule_task

```json
{
  "type": "schedule_task",
  "prompt": "Check weather and report",
  "schedule_type": "cron",
  "schedule_value": "0 8 * * *",
  "targetJid": "120363XXX@g.us",
  "context_mode": "isolated",
  "model": "haiku"
}
```

`schedule_type`: `cron`, `interval`, or `once`.

## Close Sentinel

The file `/workspace/ipc/input/_close` signals the agent to end the session.

## Snapshots

### current_tasks.json

```json
[{
  "id": "task-123",
  "groupFolder": "main",
  "prompt": "Daily weather",
  "schedule_type": "cron",
  "schedule_value": "0 8 * * *",
  "status": "active",
  "next_run": "2026-02-24T08:00:00.000Z"
}]
```

Main sees all tasks; non-main sees own only.

### available_groups.json

Main group only.

```json
{
  "groups": [{"jid": "120363XXX@g.us", "name": "Family", "lastActivity": "2026-02-23T12:00:00Z", "isRegistered": true}],
  "lastSync": "2026-02-23T21:00:00Z"
}
```

## File Lifecycle

1. Writer creates JSON file in target directory
2. Reader polls directory (configurable interval)
3. Reader validates: symlink check, size limit (1 MB commands, 64 MB files), JSON parse, type guard
4. Valid: process and delete. Invalid: quarantine and log warning.

## Security

- Symlink rejection (`O_NOFOLLOW`)
- Size limits enforced before parse
- Group isolation via directory paths
- Main-only privilege for cross-group operations
- Atomic snapshot writes (write-then-rename)
