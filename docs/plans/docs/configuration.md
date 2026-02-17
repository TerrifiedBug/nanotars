# Configuration Reference

All configuration is read from `.env` and `process.env`. Defined in `src/config.ts`.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |

One of these is required for container authentication:
- `ANTHROPIC_API_KEY` — direct API access
- `CLAUDE_CODE_OAUTH_TOKEN` — OAuth token (alternative)

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `ASSISTANT_NAME` | `Andy` | Bot display name (used in trigger patterns, message prefixes) |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | WhatsApp-specific: `true` if bot has its own phone number |
| `CLAUDE_MODEL` | SDK default | Model for agent containers (e.g., `claude-sonnet-4-5`) |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker image name for agent containers |

### Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_TIMEOUT` | `1800000` (30 min) | Hard timeout for container execution |
| `IDLE_TIMEOUT` | `1800000` (30 min) | Idle timeout for chat conversations |
| `SCHEDULED_TASK_IDLE_TIMEOUT` | `30000` (30 sec) | Idle timeout for scheduled tasks (shorter to free queue) |

### Concurrency

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max containers running simultaneously (minimum: 1) |

### Output Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10 MB) | Max stdout from a container before truncation |

### Timezone

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | System timezone | Timezone for cron expression parsing |

## Internal Constants (src/config.ts)

These are not configurable via environment variables.

| Constant | Value | Description |
|----------|-------|-------------|
| `POLL_INTERVAL` | `2000` ms | Message loop polling interval |
| `IPC_POLL_INTERVAL` | `1000` ms | IPC watcher polling interval |
| `SCHEDULER_POLL_INTERVAL` | `60000` ms | Task scheduler polling interval |
| `MAIN_GROUP_FOLDER` | `main` | Folder name for the main group |
| `MOUNT_ALLOWLIST_PATH` | `~/.config/nanoclaw/mount-allowlist.json` | Mount security allowlist |
| `STORE_DIR` | `{cwd}/store` | SQLite database directory |
| `GROUPS_DIR` | `{cwd}/groups` | Per-group data directories |
| `DATA_DIR` | `{cwd}/data` | IPC, sessions, channels, env data |
| `CHANNELS_DIR` | `{cwd}/data/channels` | Per-channel auth data |

## Container-Side Constants (agent-runner)

| Constant | Value | Description |
|----------|-------|-------------|
| `IPC_INPUT_DIR` | `/workspace/ipc/input` | Follow-up message directory |
| `IPC_INPUT_CLOSE_SENTINEL` | `/workspace/ipc/input/_close` | Close signal file |
| `IPC_POLL_MS` | `500` ms | IPC polling interval inside container |
| `PLUGIN_HOOKS_DIR` | `/workspace/plugin-hooks` | Plugin hook modules directory |

## Trigger Patterns

The default trigger pattern is built from `ASSISTANT_NAME`:

```
^@{ASSISTANT_NAME}\b    (case-insensitive)
```

Per-group custom triggers are stored in `registered_groups.trigger_pattern` and built via `createTriggerPattern()`.

**Main group:** `requires_trigger = false` (responds to all messages)
**Non-main groups:** `requires_trigger = true` (only triggered messages, but all messages are collected as context)

## Model Override Chain

When determining which Claude model to use, the system checks in order:

1. **Task model override** — `scheduled_tasks.model` column
2. **`store/claude-model` file** — set via `/nanoclaw-set-model` skill
3. **`.env CLAUDE_MODEL`** — environment variable
4. **SDK default** — whatever the Claude Agent SDK defaults to

## Directory Layout

```
{project root}/
├── .env                           # Configuration and secrets
├── store/
│   ├── messages.db                # SQLite database
│   ├── backups/                   # Automatic DB backups
│   └── claude-model               # Optional model override file
├── groups/
│   ├── main/                      # Main group (CLAUDE.md, logs, conversations)
│   ├── global/                    # Global CLAUDE.md (read-only to non-main)
│   └── {name}/                    # Per-group isolated folders
├── data/
│   ├── ipc/{group}/               # Per-group IPC directories
│   ├── sessions/{group}/.claude/  # Per-group Claude SDK sessions
│   ├── env/{group}/               # Per-group filtered env files
│   └── channels/{name}/           # Per-channel auth data
├── plugins/                       # Plugin directory (gitignored)
├── container/
│   ├── Dockerfile                 # Agent container image
│   ├── build.sh                   # Build script
│   ├── chromium-seccomp.json      # Seccomp profile for Chromium
│   ├── agent-runner/              # In-container runner source
│   └── skills/                    # Core skills
├── logs/                          # Application logs (pino)
└── .claude/skills/                # Installation skills (Claude Code)
```

## Container SDK Settings

Per-group SDK settings are auto-configured in the session directory:

```json
{
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
}
```

## Logging

NanoClaw uses Pino for structured JSON logging.

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |

Container logs are written per-group to `groups/{folder}/logs/container-{timestamp}.log`. Verbosity escalates automatically on non-zero exit codes.
