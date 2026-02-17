# IPC Protocol

## Overview

NanoClaw uses a file-based IPC system for communication between containerized agents and the host process. Each group gets isolated IPC directories, and identity is determined by filesystem location.

## Directory Structure

```
data/ipc/
├── main/                    # Main group IPC
│   ├── input/               # Host → Container (follow-up messages)
│   ├── messages/            # Container → Host (outbound messages)
│   ├── tasks/               # Container → Host (task commands)
│   ├── current_tasks.json   # Snapshot: all scheduled tasks
│   └── available_groups.json # Snapshot: all available groups
├── work-chat/               # Non-main group IPC
│   ├── input/
│   ├── messages/
│   ├── tasks/
│   ├── current_tasks.json   # Snapshot: own tasks only
│   └── available_groups.json # Snapshot: empty array
└── errors/                  # Failed IPC files moved here for debugging
```

## Message Types

### Outbound Message (Container → Host)

Written by agent to `/workspace/ipc/messages/{timestamp}-{random}.json`:

```json
{
  "type": "message",
  "chatJid": "123456@g.us",
  "text": "Hello from the agent!",
  "sender": "optional-subagent-name"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"message"` | Yes | Message type identifier |
| `chatJid` | string | Yes | Target chat JID |
| `text` | string | Yes | Message content |
| `sender` | string | No | Subagent identity for bot pools |

### Follow-Up Input (Host → Container)

Written by GroupQueue to `data/ipc/{group}/input/{timestamp}-{random}.json`:

```json
{
  "type": "message",
  "text": "Follow-up user message"
}
```

### Close Sentinel (Host → Container)

Empty file at `data/ipc/{group}/input/_close`. Signals the agent runner to gracefully wind down after the current query completes.

## Task Commands

Written by agent to `/workspace/ipc/tasks/{timestamp}-{random}.json`.

### Create Task

```json
{
  "type": "schedule_task",
  "prompt": "Check the weather and send a morning briefing",
  "schedule_type": "cron",
  "schedule_value": "0 8 * * *",
  "context_mode": "isolated",
  "model": "claude-sonnet-4-5"
}
```

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `type` | string | `"schedule_task"` | Command type |
| `prompt` | string | | Task instructions |
| `schedule_type` | string | `"cron"`, `"interval"`, `"once"` | Schedule type |
| `schedule_value` | string | Cron expr / ms / ISO date | Schedule value |
| `context_mode` | string | `"isolated"`, `"group"` | Session isolation |
| `model` | string | | Optional model override |

### Update Task

```json
{
  "type": "update_task",
  "task_id": 42,
  "prompt": "Updated instructions",
  "schedule_value": "0 9 * * *",
  "status": "active"
}
```

### Pause/Resume Task

```json
{
  "type": "pause_task",
  "task_id": 42
}
```

```json
{
  "type": "resume_task",
  "task_id": 42
}
```

### Cancel Task

```json
{
  "type": "cancel_task",
  "task_id": 42
}
```

### Register Group (Main Only)

```json
{
  "type": "register_group",
  "jid": "new-chat-123@g.us",
  "name": "New Chat",
  "folder": "new-chat",
  "trigger_pattern": "@assistant",
  "requires_trigger": true,
  "channel": "whatsapp"
}
```

### Refresh Groups (Main Only)

```json
{
  "type": "refresh_groups"
}
```

Triggers metadata synchronization across all connected channels.

## Authorization Model

Identity is determined by the IPC directory location (the `groupFolder`), not by file contents.

### Permission Matrix

| Operation | Main Group | Non-Main Group |
|-----------|-----------|----------------|
| Send message to own chat | Yes | Yes |
| Send message to other chat | Yes | No (blocked + logged) |
| Create task (own group) | Yes | Yes |
| Manage task (own group) | Yes | Yes |
| Manage task (other group) | Yes | No (blocked) |
| Register new group | Yes | No |
| Refresh group metadata | Yes | No |

### Authorization Logic

```
For messages:
  if (isMain) → allow any chatJid
  else if (registeredGroups[chatJid].folder === sourceGroup) → allow
  else → block and log warning

For tasks:
  if (isMain) → allow any task
  else if (task.group_folder === sourceGroup) → allow
  else → block
```

## Error Handling

- Malformed IPC files are moved to `data/ipc/errors/` with source group prefix
- Each file is processed independently (one failure doesn't block others)
- Authorization failures are logged as warnings with full context
- Missing directories are created automatically

## Snapshots

Read-only JSON files providing system state to containers. Written before every container spawn and on `refresh_groups` command.

### current_tasks.json

```json
[
  {
    "id": 1,
    "groupFolder": "main",
    "prompt": "Daily briefing",
    "schedule_type": "cron",
    "schedule_value": "0 8 * * *",
    "status": "active",
    "next_run": "2026-02-18T08:00:00.000Z",
    "model": "claude-sonnet-4-5"
  }
]
```

Main group sees all tasks. Non-main groups see only tasks where `groupFolder` matches their own.

### available_groups.json

```json
{
  "groups": [
    { "jid": "123@g.us", "name": "Family Chat" },
    { "jid": "tg:-100123", "name": "Work Team" }
  ],
  "lastSync": "2026-02-17T10:00:00.000Z"
}
```

Main group sees all available groups (for activation). Non-main groups see empty array.

## Polling Intervals

| Component | Interval | Location |
|-----------|----------|----------|
| IPC Watcher (host) | 1s (`IPC_POLL_INTERVAL`) | `src/ipc.ts` |
| IPC Poller (container) | 500ms (`IPC_POLL_MS`) | `agent-runner/src/index.ts` |
