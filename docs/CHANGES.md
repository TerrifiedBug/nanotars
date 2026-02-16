# Fork Changes: TerrifiedBug/nanoclaw

This document describes all changes made in this fork compared to the upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) repository. It's intended to give the upstream maintainer a clear picture of what this fork does differently, why, and which changes might be worth upstreaming.

**Source diff vs upstream:** 26 files changed, +2,113 / -1,967 lines (`src/` + `container/agent-runner/src/` only)

---

## Table of Contents

1. [Plugin Architecture](#1-plugin-architecture) — The biggest change
2. [Channel Abstraction](#2-channel-abstraction) — Multi-channel support
3. [Docker/Linux Support](#3-dockerlinux-support) — Runtime abstraction layer
4. [Security Hardening](#4-security-hardening) — Bash sanitization, secret isolation
5. [Media Pipeline](#5-media-pipeline) — Image/video/audio/document downloads
6. [Task Scheduler Improvements](#6-task-scheduler-improvements) — Model selection, error notifications
7. [Bug Fixes](#7-bug-fixes) — Submitted as PRs
8. [New Skills](#8-new-skills) — 25+ integration skills
9. [Documentation](#9-documentation) — Plugin guides, channel plugin architecture
10. [Code Quality & Refactoring](#10-code-quality--refactoring) — Module decomposition, dead code removal
11. [Minor Improvements](#11-minor-improvements) — Typing indicators, read receipts

---

## 1. Plugin Architecture

**The single largest change.** Upstream NanoClaw is a monolithic app where channels, skills, and integrations are hardcoded into core source files. This fork introduces a plugin system that makes the core plugin-agnostic — channels, skills, and integrations are all runtime-loaded extensions. No core file modifications needed to add new capabilities.

### What was built

| New File | Purpose |
|----------|---------|
| `src/plugin-loader.ts` | Plugin discovery, manifest parsing, env var collection, MCP config merging, hook lifecycle |
| `src/plugin-types.ts` | TypeScript interfaces for the plugin system |
| `src/plugin-loader.test.ts` | Tests for plugin loading and scoping |
| `docs/PLUGINS.md` | Complete plugin system documentation |
| `plugins/.gitkeep` | Empty plugins directory (plugins are gitignored, installed per-deployment) |

### How it works

Plugins live in `plugins/` with a `plugin.json` manifest. Skill plugin example:

```json
{
  "name": "brave-search",
  "description": "Web search via Brave Search API",
  "containerEnvVars": ["BRAVE_API_KEY"],
  "hooks": []
}
```

Channel plugin example:

```json
{
  "name": "whatsapp",
  "description": "WhatsApp via Baileys",
  "hooks": ["onChannel"],
  "channelPlugin": true,
  "dependencies": true
}
```

The plugin loader:
- Discovers plugins at startup from `plugins/` directory
- Collects env vars from all plugin manifests and injects them into containers
- Merges MCP configs from plugins with the base `.mcp.json`
- Mounts plugin-specific directories into containers (read-only by default)
- Loads plugin-specific CLAUDE.md skills into the agent's context
- Supports `Dockerfile.partial` for plugins that need to bake tools into the container image (e.g., calendar CLI)
- Scopes plugins to specific channels and groups via manifest fields

### Modified core files

| File | Changes |
|------|---------|
| `src/index.ts` | Plugin lifecycle (load → init → start → shutdown), per-group trigger patterns, plugin hook calls on message events |
| `src/container-runner.ts` | Container lifecycle (spawn, I/O, timeout). Plugin mount injection delegated to `container-mounts.ts` |
| `src/container-mounts.ts` | **New** — Extracted from container-runner: volume mount construction, env file building, secrets, plugin mount collection |
| `src/snapshots.ts` | **New** — Extracted from container-runner: task/group snapshot utilities for IPC |
| `src/config.ts` | `createTriggerPattern()` for per-group custom triggers, `SCHEDULED_TASK_IDLE_TIMEOUT` |
| `src/db.ts` | `insertExternalMessage()` for plugins to inject messages, `channel` column (no backfill) |
| `src/types.ts` | `OnInboundMessage` is now async, added `channel` field |
| `container/Dockerfile` | Added `jq`, skills directory, env-dir sourcing in entrypoint |
| `container/build.sh` | Auto-detects Docker vs Apple Container, merges `Dockerfile.partial` files from plugins, uses project-root build context |
| `container/agent-runner/src/index.ts` | Plugin hook loading, model selection, error detection |
| `package.json` | Channel SDK deps removed (moved to per-plugin packages) |

### Container integration

Plugins integrate deeply with the container system at build time and runtime:

- **`Dockerfile.partial`** — Plugins can declare extra image layers (e.g., calendar plugin installs `gogcli` and `cal-cli`). `container/build.sh` merges all partials before the final `COPY`/`ENTRYPOINT`.
- **Container mounts** — Plugin manifests declare `containerMounts` which are injected alongside core mounts. Skills go to `/workspace/.claude/skills/{plugin}/`, hooks to `/workspace/plugin-hooks/`.
- **MCP merging** — Each plugin can provide an `mcp.json`. Per-group scoped configs are merged and written to `data/env/{groupFolder}/merged-mcp.json`, mounted at `/workspace/.mcp.json` in that group's container.
- **Env var collection** — Plugin-declared `containerEnvVars` are filtered from `.env` and written to `data/env/` for container access.
- **Scoping** — Plugins declare which channels and groups they apply to (`"channels": ["whatsapp"]`, `"groups": ["main"]`), so a Discord-only plugin won't load in WhatsApp containers.

### Why this matters

The plugin system means:
- **New channels** (Discord, Telegram, email) can be added without touching core
- **New integrations** (calendar, weather, Home Assistant) are installed via skills that drop plugin files
- **Each deployment is different** — plugins are gitignored, so the repo stays clean
- **Uninstalling** is as easy as calling the skill and asking it to uninstall

---

## 2. Channel Abstraction

Upstream has WhatsApp hardcoded throughout. This fork extracted WhatsApp into a channel plugin and made the core channel-agnostic.

### What changed

| Change | Details |
|--------|---------|
| **WhatsApp extracted** | `src/channels/whatsapp.ts` → `plugins/channels/whatsapp/index.js` |
| **Channel plugin interface** | Any channel implements `connect()`, `sendMessage()`, `sendMedia()`, `getGroups()` |
| **Router made generic** | `src/router.ts` routes to any channel based on JID prefix (`wa:`, `dc:`, `tg:`) |
| **Group registration** | `src/db.ts` tracks which channel each group belongs to |
| **WhatsApp tests removed from core** | `src/channels/whatsapp.test.ts` deleted (tests live with plugin now) |

### Channel plugins available

NanoClaw ships with no channels installed by default. The setup and add-channel skills discover available channel templates and guide installation. Currently supported:

| Channel | Installed via | Template location |
|---------|--------------|-------------------|
| WhatsApp | `/add-whatsapp` | `.claude/skills/channels/whatsapp/files/` |
| Discord | `/add-discord` | `.claude/skills/add-discord/` |
| Telegram | `/add-telegram` | `.claude/skills/channels/telegram/files/` |

### How routing works

The router finds the channel that owns a JID and delegates:

```typescript
const channel = channels.find(c => c.ownsJid(jid) && c.isConnected());
await channel.sendMessage(jid, text);
```

Each channel plugin registers which JID patterns it owns (e.g., WhatsApp owns `*@s.whatsapp.net`, Discord owns `dc:*`). The database tracks which channel each registered group belongs to.

### Channel-agnostic changes

- `groups/main/CLAUDE.md` — Anti-prompt-injection rules, generic trigger examples
- `groups/global/CLAUDE.md` — References `$ASSISTANT_NAME` env var instead of hardcoded "Andy"
- `container/agent-runner/src/ipc-mcp-stdio.ts` — Tool descriptions say "message" not "WhatsApp message"
- Setup skill — Detects installed channels, doesn't assume WhatsApp
- All skill templates — Use generic "channel" language

---

## 3. Docker/Linux Support

Upstream targets macOS with Apple Container. This fork adds full Docker support for Linux servers.

### New files

| File | Purpose |
|------|---------|
| `src/container-runtime.ts` | Runtime abstraction — detects Docker vs Apple Container, provides unified API for spawn, stop, orphan cleanup, mount permissions |
| `container/chromium-seccomp.json` | Seccomp profile for Chromium headless in Docker (Playwright-compatible) |
| `.dockerignore` | Excludes non-build dirs from Docker context |

### Key changes

| File | What |
|------|------|
| `src/container-runner.ts` + `src/container-mounts.ts` | Uses runtime abstraction instead of hardcoded `container` CLI; `chown -R 1000:1000` on writable mounts (Docker bind mounts preserve host ownership) |
| `src/group-queue.ts` | `docker stop` in shutdown handler for clean restarts |
| `src/index.ts` | `docker info` / `docker ps` / `docker rm` at startup for orphan cleanup |
| `container/build.sh` | Auto-detects Docker vs Apple Container; supports both runtimes |
| `container/Dockerfile` | Crashpad handler wrapper for Chromium in Docker, TypeScript global install before devDep pruning |

### How the runtime abstraction works

`container-runtime.ts` detects which runtime is available at startup (tries `docker info` then `container system status`) and exposes a unified API. Docker requires extra flags for Chromium support (`--cap-add=SYS_PTRACE`, `--security-opt seccomp=chromium.json`, `--ipc=host`, `--init`). Apple Container needs none of these. The abstraction also handles orphan container cleanup on startup (`docker ps -a` / `docker rm`).

### Docker-specific fixes

- **Bind mount permissions**: Docker containers run as `node` (UID 1000), but host dirs created by root have root ownership → `chown -R 1000:1000` on writable mounts before spawn
- **Chromium in Docker**: Needs seccomp profile (831-line JSON) to allow Chromium syscalls like `clone`, `unshare`, `ptrace`
- **Crashpad handler**: Chromium's crash reporter needs a real handler binary, not the no-op wrapper upstream uses for Apple Container
- **Env file quoting**: Docker `--env-file` doesn't handle quotes the same as Apple Container → env value quoting in mount code
- **Container shutdown**: `group-queue.ts` explicitly calls `docker stop` with 10s grace period during graceful shutdown

---

## 4. Security Hardening

### New files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/security-hooks.ts` | Bash command sanitization, `/proc/*/environ` blocking, `/tmp/input.json` blocking |
| `container/agent-runner/src/security-hooks.test.ts` | Tests for security hooks |
| `docs/SECURITY.md` | Security model documentation (referenced from CLAUDE.md) |

### Changes to existing files

| File | What |
|------|------|
| `container/agent-runner/src/index.ts` | Secret scrubbing from agent output, security hook loading |
| `src/container-runner.ts` + `src/container-mounts.ts` | Secrets passed via stdin JSON (not written to files in container), OAuth token sync |
| `CLAUDE.md` | Added security section referencing SECURITY.md |
| `groups/main/CLAUDE.md` | Anti-prompt-injection rules |

### How secrets work in containers

Upstream passes secrets via environment variables, which are visible to `env` and `/proc/*/environ`. This fork takes a different approach:

1. Secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) are passed in the stdin JSON, read once by the agent-runner, then used via the SDK `env` option
2. They never appear in `process.env`, on the filesystem, or in logs
3. Security hooks block Bash commands and Read tool calls that try to access `/proc/*/environ` or `/tmp/input.json`
4. Agent output is scrubbed for leaked secret values before routing to the user

### What's protected

- **Bash sanitization**: Agent Bash commands are inspected; access to `/proc/*/environ` (which leaks all env vars including secrets) is blocked
- **Secret isolation**: Only auth-related env vars are exposed to containers, not the full `.env`
- **Input file blocking**: `/tmp/input.json` (which contains the raw user message) can't be read by the agent to bypass prompt injection defenses
- **Output scrubbing**: Agent responses are scanned for leaked secrets before being sent back to the user
- **IPC authorization**: Each group's IPC directory (`data/ipc/{group}/`) determines identity — non-main groups can only send messages and schedule tasks for themselves, preventing cross-group privilege escalation

---

## 5. Media Pipeline

Upstream only handles text messages. This fork adds media download and processing.

### Changes

| File | What |
|------|------|
| `src/types.ts` | Added `mediaType`, `mediaPath`, `mediaHostPath` fields |
| `src/channels/whatsapp.ts` → `plugins/channels/whatsapp/index.js` | Downloads images, videos, audio, documents from WhatsApp; saves to temp dir; passes `hostPath` for plugin hooks |
| `container/agent-runner/src/index.ts` | Media files mounted into container, agent can read/analyze them |

### How it works

1. Channel plugin downloads media to host temp directory
2. `mediaHostPath` is set on the message (host-side path for plugin hooks like voice transcription)
3. `mediaPath` is set to the container-side path
4. Media file is bind-mounted into the container
5. Agent can read the file (images are displayed, documents are parsed)
6. Plugins like `add-transcription` can hook into the media pipeline via `mediaHostPath`

---

## 6. Task Scheduler Improvements

### Changes to `src/task-scheduler.ts`

| Feature | What |
|---------|------|
| **Model selection** | Tasks can specify which Claude model to use (e.g., Haiku for cheap recurring tasks) |
| **Error notifications** | When a scheduled task fails, the user gets a notification instead of silent failure |
| **`claimTask()`** | Atomic task claiming to prevent double-execution in concurrent scenarios |
| **Shorter idle timeout** | `SCHEDULED_TASK_IDLE_TIMEOUT` (configurable) for faster task completion |

### Supporting changes

| File | What |
|------|------|
| `src/ipc.ts` | Model field in IPC messages, `authorizedTaskAction` helper for DRY task auth |
| `src/db.ts` | `claimTask()` method, model column in tasks table |
| `src/config.ts` | `SCHEDULED_TASK_IDLE_TIMEOUT` constant |
| `container/agent-runner/src/index.ts` | Model selection when creating SDK client |

---

## 7. Bug Fixes (Submitted as PRs)

These are clean fixes submitted to upstream. If they merge, the divergences collapse.

| PR | Fix | Files |
|----|-----|-------|
| [#245](https://github.com/qwibitai/nanoclaw/pull/245) | `>=` timestamp comparison (was `>`, causing missed messages at exact same timestamp) + message dedup guard | `src/db.ts`, `src/index.ts` |
| [#246](https://github.com/qwibitai/nanoclaw/pull/246) | Exclude test files from agent-runner production build (vitest not in prod) | `container/agent-runner/tsconfig.json` |
| [#247](https://github.com/qwibitai/nanoclaw/pull/247) | Consecutive error tracking — counts sequential failures, notifies user | `src/index.ts` |
| [#248](https://github.com/qwibitai/nanoclaw/pull/248) | Duplicate task creation prevention — warns in IPC tool description | `container/agent-runner/src/ipc-mcp-stdio.ts` |

### Other fixes in fork (not PR'd — too coupled to fork architecture)

- **Env file quoting** — Only exists in our env mount mechanism
- **90s restart delay prevention** — Fixed race condition in shutdown/restart
- **Relative hostPath resolution** — Plugin container mounts with relative paths resolved to absolute
- **OAuth credential sync** — Detects OAuth credentials file in setup state checks

---

## 8. New Skills (25)

Claude Code skills (`.claude/skills/`) that guide the AI through installing integrations. Each skill creates a plugin directory with manifest, code, and container-side instructions.

### Integration skills (17)

| Skill | What it adds |
|-------|-------------|
| `add-brave-search` | Web search via Brave Search API |
| `add-cal` | Google Calendar + CalDAV (includes TypeScript CLI baked into image via Dockerfile.partial) |
| `add-changedetection` | changedetection.io website monitoring |
| `add-claude-mem` | Persistent cross-session memory for agents |
| `add-commute` | Travel times via Waze API |
| `add-freshrss` | Self-hosted RSS feed reader |
| `add-github` | GitHub API access (PRs, issues, commits) |
| `add-gmail` | Gmail access via gog CLI (search, read, send) |
| `add-homeassistant` | Home Assistant smart home control via MCP |
| `add-imap-read` | Read-only IMAP email access |
| `add-n8n` | n8n workflow automation |
| `add-norish` | Recipe import by URL |
| `add-notion` | Notion API for notes/project management |
| `add-parallel` | Parallel AI web research via MCP servers |
| `add-trains` | UK National Rail departures (includes Python script) |
| `add-transcription` | Voice message transcription via OpenAI Whisper (channel-agnostic) |
| `add-weather` | Weather via wttr.in / Open-Meteo (no API key needed) |
| `add-webhook` | HTTP webhook endpoint for push events (Home Assistant, uptime monitors, etc.) |

### Channel skills (5)

| Skill | What it adds |
|-------|-------------|
| `add-whatsapp` | Install WhatsApp as a channel plugin |
| `add-discord` | Install Discord as a channel plugin |
| `add-telegram` | Install Telegram as a channel plugin |
| `add-telegram-swarm` | Agent Teams support for Telegram (pool bot identities) |
| `add-channel` | Generic skill to register a group on any installed channel |

### Meta skills (6)

| Skill | What it does |
|-------|-------------|
| `nanoclaw-setup` | First-time installation, auth, service configuration |
| `nanoclaw-customize` | Adding integrations, changing behavior |
| `nanoclaw-debug` | Container issues, logs, troubleshooting |
| `nanoclaw-set-model` | Change Claude model used by containers |
| `create-skill-plugin` | Guided creation of new skill plugins from an idea |
| `create-channel-plugin` | Guided creation of new channel plugins |
| `update-nanoclaw` | Manage upstream sync with selective cherry-pick |

### Rewritten upstream skills

| Skill | What changed |
|-------|-------------|
| `nanoclaw-setup` | Major rewrite: channel-agnostic plugin flow, headless/Linux QR auth, systemd service support. Upstream's PR #258 replaced theirs with numbered shell scripts that hardcode WhatsApp. |
| `nanoclaw-customize` | Plugin architecture docs, Linux service management references |
| `nanoclaw-debug` | Channel-agnostic, plugin-aware (upstream version is WhatsApp-specific) |

---

## 9. Documentation

### New docs

| File | Contents |
|------|----------|
| `docs/PLUGINS.md` | Complete plugin system architecture — manifests, hooks, mounts, Dockerfile.partial, env vars, MCP merging, source code changes |
| `docs/CHANNEL_PLUGINS.md` | Channel plugin development guide — interface, auth, registration, testing |
| `docs/CHANGES.md` | This file — comprehensive fork changelog |

### Modified docs

| File | What changed |
|------|-------------|
| `CLAUDE.md` | Added security section referencing `docs/SECURITY.md` |
| `docs/SPEC.md` | Minor updates for plugin architecture |
| `docs/DEBUG_CHECKLIST.md` | Updated for Docker/plugin debugging |

---

## 10. Code Quality & Refactoring

### Module decomposition

`container-runner.ts` was 835 lines handling mounts, env files, secrets, snapshots, and container lifecycle. Decomposed into focused modules:

| Module | Responsibility |
|--------|---------------|
| `src/container-mounts.ts` (313 lines) | Volume mount construction, env file building, secret reading, plugin mount collection |
| `src/snapshots.ts` (84 lines) | Task/group snapshot utilities for IPC |
| `src/container-runner.ts` (467 lines) | Container lifecycle only (spawn, I/O, timeout, logging) |

Re-exports preserve backward compatibility — no consumer import changes needed.

### Dead code removal

| Removed | File | Reason |
|---------|------|--------|
| `storeMessageDirect()` | `src/db.ts` | Zero callers — leftover from earlier iteration |
| `formatOutbound()` | `src/router.ts` | Trivial wrapper around `stripInternalTags()` |
| `findChannel()` | `src/router.ts` | Zero callers — replaced by `routeOutbound()` |

### DRY patterns

| Pattern | File | What |
|---------|------|------|
| `mapRegisteredGroupRow()` | `src/db.ts` | Extracted duplicated row→object mapping from `getRegisteredGroup` and `getAllRegisteredGroups` |
| `authorizedTaskAction()` | `src/ipc.ts` | Consolidated identical auth+action pattern across pause/resume/cancel task handlers |
| Shared logger | `src/mount-security.ts` | Replaced duplicate pino instance with shared `logger` import |

---

## 11. Minor Improvements

| Feature | Files | What |
|---------|-------|------|
| **Heartbeat typing indicator** | `src/index.ts` | Shows typing indicator on every message, not just the first |
| **Read receipts** | `plugins/channels/whatsapp/index.js` | Marks messages as read after processing |
| **Presence management** | `src/index.ts` | Sends `available` presence on connect for consistent typing indicators |
| **Per-group webhook routing** | `plugins/webhook/` | Each group gets its own webhook path + token (upstream uses single global secret) |
| **Agent browser as plugin** | `plugins/agent-browser/` | Moved from `container/skills/` to plugin system |
| **Token count badge** | `repo-tokens/badge.svg` | Auto-updated context window usage badge |

---

## Architecture Summary

### How messages flow (end-to-end)

```
1. Channel plugin (WhatsApp/Discord) receives message via SDK
2. Plugin transforms to NewMessage, runs onInboundMessage hooks (media download, etc.)
3. Stored in SQLite (messages table for registered groups, chats metadata for all)
4. Polling loop (every 2s) fetches new messages, deduplicates, checks trigger patterns
5. GroupQueue enforces MAX_CONCURRENT_CONTAINERS (default 5), pipes to active container or spawns new one
6. ContainerRunner builds security-validated mounts, spawns container with stdin JSON
7. Agent-runner inside container reads stdin, initializes Claude SDK, polls IPC for follow-ups
8. Results stream to stdout with sentinel markers, parsed by host, routed back to channel
```

### Fork vs upstream

```
Upstream NanoClaw:
  WhatsApp ←→ [Monolithic Core] ←→ Apple Container → Claude Agent

This Fork:
  WhatsApp ─┐
  Discord  ─┼→ [Plugin Loader] → [Channel-Agnostic Core] → [Runtime Abstraction] → Docker/Apple Container
  Telegram ─┘         ↓                                              ↓
              Plugin Mounts/Env/MCP                          Claude Agent + Plugin Skills
              Dockerfile.partial                             Security Hooks
              Plugin Hooks                                   Media Pipeline
```

### Key architectural differences

| Aspect | Upstream | This Fork |
|--------|----------|-----------|
| Channels | WhatsApp hardcoded in `src/channels/whatsapp.ts` | Extracted to plugins, core is channel-agnostic |
| Container runtime | Apple Container only | Docker + Apple Container via abstraction layer |
| Extensibility | Skills only (SKILL.md files) | Runtime plugins with hooks, mounts, env vars, MCP, Dockerfile.partial |
| Dependencies | All channel SDKs in root `package.json` | Per-plugin `package.json` (only installed plugins add deps) |
| Media | Text only | Downloads images/video/audio/docs, mounts into container |
| Security | Trust-based (one user) | Defense-in-depth (secret isolation, Bash hooks, IPC authorization) |
| Setup | Shell scripts hardcoding WhatsApp | Channel-agnostic SKILL.md with plugin detection |
| Scheduled tasks | Single model, silent failures | Per-task model selection, error notifications, atomic claiming |

---

## What's Upstream-Ready

These changes could be upstreamed with minimal modification:

1. **Bug fixes** — PRs #245, #246, #247, #248 (already submitted)
2. **Security hooks** — `security-hooks.ts` is additive, no core changes needed
3. **Typing indicator fixes** — Already merged upstream from our earlier PRs
4. **Token count workflow** — Already upstream

## What's Fork-Specific

These are architectural decisions that differ from upstream's direction:

1. **Plugin system** — Upstream prefers skills-only; we use runtime plugins
2. **Channel abstraction** — Upstream is WhatsApp-first; we're channel-agnostic
3. **Docker runtime** — Upstream targets Apple Container; we abstract both
4. **Media pipeline** — Upstream doesn't download media; we do
5. **Task model selection** — Upstream uses one model; we allow per-task model choice
6. **Setup skill** — Upstream now uses numbered shell scripts (PR #258); we keep monolithic SKILL.md with plugin flow
