# Source Module Reference

All source files are in `src/` (TypeScript, compiled to `dist/` via `tsc`). ESM module system.

---

## src/index.ts — Orchestrator

The main entry point that initializes all subsystems and runs the message processing loop.

**Startup sequence:**
1. `initDatabase()` — open SQLite, run migrations, backup
2. `loadPlugins()` — discover and load plugins from `plugins/`
3. Connect channel plugins (WhatsApp, Telegram, Discord)
4. `startMessageLoop()` — poll DB every 2s for new messages
5. `startIpcWatcher()` — poll IPC directories every 1s
6. `startTaskScheduler()` — poll for due tasks every 60s

**Message processing:**
- Groups messages by registered JID
- Checks trigger patterns (non-main groups require explicit trigger)
- Tracks consecutive errors per JID (max 3 before advancing cursor)
- Handles crash recovery by detecting unprocessed messages

**Shutdown:** Graceful SIGTERM/SIGINT handling, stops all containers, closes channels.

---

## src/plugin-loader.ts — Plugin System

Discovers, loads, and manages plugins from the `plugins/` directory.

**Key exports:**

| Function | Purpose |
|----------|---------|
| `parseManifest(raw)` | Validate and normalize plugin.json |
| `collectContainerEnvVars(plugins)` | Merge core + plugin env vars |
| `collectSkillPaths(plugins)` | Find container-skills/ directories |
| `collectContainerHookPaths(plugins)` | Find container hook files |
| `collectContainerMounts(plugins)` | Collect additional mount declarations |
| `mergeMcpConfigs(fragments)` | Merge MCP server configurations |

**PluginRegistry class:**
- `loaded` — all loaded plugins
- `channels` — connected Channel instances
- `pluginsForGroup(channel, group)` — filter by scope
- `executeHook(hookName, ctx)` — run plugin lifecycle hooks

**Plugin discovery:** Scans `plugins/` with one level of nesting support (`plugins/{category}/{name}/plugin.json`).

---

## src/router.ts — Message Routing

Message formatting and outbound routing.

**Key exports:**

| Function | Purpose |
|----------|---------|
| `formatMessages(messages)` | Convert NewMessage[] to XML format |
| `stripInternalTags(text)` | Remove `<internal>...</internal>` blocks |
| `routeOutbound(channels, jid, text, sender?)` | Find owning channel, deliver message |

**XML format:** Messages formatted with escaped sender names, timestamps, `is_from_me` flags. Agents parse this structured input.

**Internal tags:** Agents can emit `<internal>...</internal>` blocks for reasoning/telemetry that gets stripped before delivery to users.

---

## src/container-runner.ts — Container Execution

Spawns and manages containerized Claude agent instances.

**Key exports:**

| Function | Purpose |
|----------|---------|
| `runContainerAgent(opts)` | Main entry: build mounts, spawn container, parse output |

**Input protocol:** `ContainerInput` JSON written to container stdin:
```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}
```

**Output protocol:** Streaming results wrapped in marker pairs:
```
OUTPUT_START_MARKER
{"status":"success","result":"...","newSessionId":"..."}
OUTPUT_END_MARKER
```

Multiple result pairs may be emitted (one per agent turn). Hard timeout resets on each output chunk.

**Credential sync:** OAuth tokens refreshed inside containers are synced back to host `~/.claude/.credentials.json` when newer `expiresAt` detected.

**Logging:** Per-group logs written to `groups/{folder}/logs/`. Verbosity escalates on error exit codes.

---

## src/container-mounts.ts — Mount Construction

Builds volume mount arrays with per-group isolation.

**Security model:**
- Main group: read-write project root mount
- Non-main groups: isolated group folder + read-only global directory only
- Per-group IPC directories prevent cross-group privilege escalation
- Plugin skills, hooks, mounts scoped by channel and group

**Mount sources:**
- Core skills from `container/skills/`
- Plugin skills from `plugins/{name}/container-skills/`
- Plugin hook files
- MCP configs (merged per-group from root + plugin fragments)
- OAuth credentials copied from host to per-group session directory

**Environment file:** Filtered to plugin-declared allowlist, shell-quoted to prevent injection.

**Model override priority:** task override > `store/claude-model` > `.env CLAUDE_MODEL` > SDK default.

---

## src/container-runtime.ts — Runtime Abstraction

Platform-agnostic abstraction over Docker and Apple Container.

**Runtime detection:** Prefers Docker, falls back to Apple Container on macOS. Cached after first detection.

**Docker-specific configuration for Chromium/Playwright:**
- `--cap-add=SYS_PTRACE` for crashpad
- Custom seccomp profile (`chromium-seccomp.json`) allowing clone/unshare/ptrace
- `--shm-size=2g` (default 64MB causes OOM)
- `--init` for zombie process reaping

**Key exports:**

| Function | Purpose |
|----------|---------|
| `detectRuntime()` | Auto-detect available runtime |
| `ensureRunning()` | Start runtime if needed (Apple Container only) |
| `cleanupOrphans()` | Remove leftover `nanoclaw-*` containers from crashes |
| `fixMountPermissions(path)` | chown to UID 1000 for Docker bind mounts |

---

## src/mount-security.ts — Mount Validation

Defense-in-depth mount validation against tamper-proof allowlist.

**Allowlist location:** `~/.config/nanoclaw/mount-allowlist.json` (outside project root — containers can't modify it).

**Validation pipeline:**
1. Expand tilde paths, resolve symlinks to canonical paths
2. Check against blocked patterns (`.ssh`, `.aws`, `.env`, credentials, etc.)
3. Verify path falls under an allowed root directory
4. Determine effective readonly (mount request × root policy × nonMainReadOnly)
5. Validate container path (no `..`, no absolute, non-empty)

**Fail secure:** Missing or invalid allowlist → ALL additional mounts blocked.

**Key exports:**

| Function | Purpose |
|----------|---------|
| `loadMountAllowlist()` | Load and cache allowlist |
| `validateMount(mount, isMain)` | Validate single mount → `MountValidationResult` |
| `validateAdditionalMounts(mounts, group, isMain)` | Validate all mounts for a group |
| `generateAllowlistTemplate()` | Create starter allowlist JSON |

---

## src/group-queue.ts — Concurrency Control

Serializes container invocations per group with global concurrency limits.

**GroupQueue class:**

| Method | Purpose |
|--------|---------|
| `enqueueMessageCheck(jid)` | Queue message processing for a group |
| `enqueueTask(jid, taskId, fn)` | Queue a scheduled task |
| `sendMessage(jid, text)` | Pipe follow-up message to active container via IPC |
| `closeStdin(jid)` | Write `_close` sentinel to signal container wind-down |
| `registerProcess(jid, proc, name)` | Track active container process |
| `shutdown(gracePeriodMs)` | Stop all containers gracefully |

**Concurrency model:**
- Global: `MAX_CONCURRENT_CONTAINERS` (default 5)
- Per-group: exactly 1 container at a time
- Tasks prioritized over messages in drain order
- Exponential backoff retry: `BASE_RETRY_MS * 2^(retryCount-1)`, max 5 retries

---

## src/ipc.ts — IPC Watcher

File-based IPC system for container-to-host communication.

**Directory structure per group:**
```
data/ipc/{groupFolder}/
├── input/        # Host → Container (follow-up messages)
├── messages/     # Container → Host (outbound messages)
└── tasks/        # Container → Host (task commands)
```

**Authorization model:**
- Identity determined by directory location (groupFolder), not file contents
- Main group: can send to any chat, manage any task, register groups
- Non-main groups: can only send to own chats, manage own tasks

**Exports:** `startIpcWatcher(deps: IpcDeps)` — starts polling loop.

See [IPC Protocol](ipc-protocol.md) for message format details.

---

## src/db.ts — Database Layer

SQLite persistence with WAL mode, automatic backups, and schema migrations.

**Key exports:**

| Function | Purpose |
|----------|---------|
| `initDatabase()` | Open DB, create schema, migrate, backup, prune |
| `storeMessage(msg)` | Insert message with deduplication |
| `storeChatMetadata(jid, ts, name?)` | Track chat for discovery |
| `getNewMessages(jid, since)` | Fetch messages after timestamp |
| `getRegisteredGroups()` | All registered groups |
| `createTask(task)` / `updateTask()` / `deleteTask()` | Task CRUD |
| `getDueTasks()` | Tasks where next_run has passed |
| `claimTask(id)` | Set next_run = NULL to prevent re-enqueue |
| `backupDatabase()` | Online backup, keep 2 most recent |

See [Database](database.md) for schema details.

---

## src/task-scheduler.ts — Task Scheduling

Polling-based scheduler for cron, interval, and one-time tasks.

**Schedule types:**
- `cron` — Timezone-aware cron expressions
- `interval` — Repeat every N milliseconds
- `once` — Single execution at ISO timestamp

**Context modes:**
- `group` — Reuses group's existing session (continuity with chat history)
- `isolated` — Fresh session per run

**Behavior:**
- Polls every 60s (configurable via `SCHEDULER_POLL_INTERVAL`)
- Claims tasks immediately (sets `next_run = NULL`) preventing double-execution
- Uses shorter idle timeout (30s vs 30min) to free queue slots quickly
- Failed tasks notify users with truncated error unless successful response already delivered

---

## src/snapshots.ts — State Snapshots

Provides containerized agents read-only views of system state via JSON files.

**Files written to `data/ipc/{groupFolder}/`:**

| File | Contents | Main sees | Non-main sees |
|------|----------|-----------|---------------|
| `current_tasks.json` | Scheduled tasks | All tasks | Own tasks only |
| `available_groups.json` | Channel groups | All groups | Empty array |

**Timing:** Written before every container spawn and on `refresh_groups` IPC command.

---

## src/config.ts — Configuration

Centralizes system configuration. Reads non-secret values from `.env`.

See [Configuration](configuration.md) for the full reference.

---

## src/types.ts — Type Definitions

Core interfaces and types shared across modules.

See [Database](database.md) for `RegisteredGroup`, `ScheduledTask`, `NewMessage`. See [Security Model](security-model.md) for `MountAllowlist`, `AllowedRoot`, `AdditionalMount`.

---

## container/agent-runner/src/index.ts — Agent Runner

The in-container orchestrator that executes Claude Code SDK queries.

**Input:** `ContainerInput` JSON via stdin.

**Query loop:**
1. Run SDK `query()` with prompt
2. Emit `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` pair
3. Wait for IPC message in `input/` directory
4. Resume from `lastAssistantUuid` for context continuity
5. Repeat until `_close` sentinel or idle timeout

**Security features:**
- Secrets passed via stdin, merged into SDK env only (never `process.env`)
- `sanitizeBashHook` blocks Bash access to `SECRET_ENV_VARS`
- `secretPathBlockHook` blocks Read tool on sensitive paths
- Plugin hooks loaded from `/workspace/plugin-hooks/*.js`

**PreCompact hook:** Archives full conversation transcripts to `conversations/{date}-{summary}.md` before session compaction.

**Additional directories:** Discovers `/workspace/extra/*` and passes to SDK for CLAUDE.md auto-loading (plugin-contributed context).
