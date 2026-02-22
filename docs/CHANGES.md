# Fork Changes: TerrifiedBug/nanoclaw

This document describes all changes made in this fork compared to the upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) repository. It's intended to give the upstream maintainer a clear picture of what this fork does differently, why, and which changes might be worth upstreaming.

**Source diff vs upstream:** 28 files changed, +2,250 / -1,980 lines (`src/` + `container/agent-runner/src/` only)

---

## Table of Contents

1. [Plugin Architecture](#1-plugin-architecture) — The biggest change
2. [Channel Abstraction](#2-channel-abstraction) — Multi-channel support
3. [Docker/Linux Support](#3-dockerlinux-support) — Runtime abstraction layer
4. [Security Hardening](#4-security-hardening) — Bash sanitization, secret isolation
5. [Media Pipeline](#5-media-pipeline) — Image/video/audio/document downloads
6. [Task Scheduler Improvements](#6-task-scheduler-improvements) — Model selection, error notifications
7. [Bug Fixes](#7-bug-fixes) — Submitted as PRs
8. [New Skills](#8-new-skills) — 27 integration, channel, and meta skills (now in marketplace)
9. [Documentation](#9-documentation) — Plugin guides, channel plugin architecture
10. [Code Quality & Refactoring](#10-code-quality--refactoring) — Module decomposition, dead code removal
11. [Minor Improvements](#11-minor-improvements) — Typing indicators, read receipts
12. [Admin Dashboard](#12-admin-dashboard) — Web UI for monitoring and management
13. [Agent Identity System](#13-agent-identity-system) — IDENTITY.md personality support
14. [Plugin Versioning & Update System](#14-plugin-versioning--update-system) — Semver tracking, fork-based updates
15. [Agent Teams & Per-Group Agent Definitions](#15-agent-teams--per-group-agent-definitions) — Persistent subagent roles, WhatsApp sender display
16. [Skill Marketplace](#16-skill-marketplace) — Skills moved to Claude Code plugin marketplace
17. [Plugin Scoping Standardization](#17-plugin-scoping-standardization) — Mandatory channels/groups configuration

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
  "version": "1.0.0",
  "containerEnvVars": ["BRAVE_API_KEY"],
  "hooks": []
}
```

Channel plugin example:

```json
{
  "name": "whatsapp",
  "description": "WhatsApp via Baileys",
  "version": "1.0.0",
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
| **Outbound hooks** | `onOutboundMessage(text, jid, channel)` on PluginHooks — transforms outbound text before channel delivery. Return empty to suppress. Pipeline pattern matching `onInboundMessage` |
| `container/Dockerfile` | Added `jq`, skills directory, env-dir sourcing in entrypoint |
| `container/build.sh` | Auto-detects Docker vs Apple Container, merges `Dockerfile.partial` files from plugins, uses project-root build context |
| `container/agent-runner/src/index.ts` | Plugin hook loading, model selection, error detection |
| `package.json` | Channel SDK deps removed (moved to per-plugin packages) |

### Container integration

Plugins integrate deeply with the container system at build time and runtime:

- **`Dockerfile.partial`** — Plugins can declare extra image layers (e.g., calendar plugin installs `gogcli` and `cal-cli`). `container/build.sh` merges all partials before the final `COPY`/`ENTRYPOINT`.
- **Container mounts** — Plugin manifests declare `containerMounts` which are injected alongside core mounts. Skills go to `/workspace/.claude/skills/{plugin}/`, hooks to `/workspace/plugin-hooks/`.
- **MCP merging** — Each plugin can provide an `mcp.json`. Per-group scoped configs are merged and written to `data/env/{groupFolder}/merged-mcp.json`, mounted at `/workspace/.mcp.json` in that group's container.
- **Env var collection** — Plugin-declared `containerEnvVars` are filtered from `.env` and written to `data/env/` for container access. Per-group `.env` overrides layer on top (see below).
- **Scoping** — Plugins declare which channels and groups they apply to (`"channels": ["whatsapp"]`, `"groups": ["main"]`), so a Discord-only plugin won't load in WhatsApp containers. All plugins now include explicit `"channels": ["*"], "groups": ["*"]` in their `plugin.json` for visibility (previously implicit defaults). Sensitive plugin installers (homeassistant, gmail, imap-read, notion, github, n8n, calendar) prompt users to choose group restrictions during installation.

### Per-group credential overrides

Groups can have their own `.env` files at `groups/{folder}/.env` that override global `.env` values for that group's containers only. This enables scenarios like: main group uses personal Google creds, a shared group uses team calendar creds.

**How it works:**
- `container-mounts.ts` (`buildEnvMount`) parses the global `.env` into a key→value map, then overlays `groups/{folder}/.env` if it exists (group values win), then filters through the `containerEnvVars` allowlist as before
- `secret-redact.ts` (`loadSecrets`) scans all `groups/*/.env` files at startup so per-group secrets are redacted from outbound messages/logs
- Installation-level auth (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) is passed via stdin secrets and is NOT overridable per-group (security boundary)
- New group `.env` files require a restart for redaction to pick them up (same as global `.env`)

All 16 `add-skill-*` SKILL.md templates document per-group support: Tier 1 (10 personal account plugins) have full "Existing Installation" sections, Tier 2 (4 shared API key plugins) have brief notes, Tier 3 (2 system-wide plugins) note it's not applicable.

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
| **Channel plugin interface** | Any channel implements `connect()`, `sendMessage()`, `sendMedia()`, `getGroups()`, optional `sendFile()` |
| **File sending** | `sendFile(jid, buffer, mime, fileName, caption)` — agents can send files back to users via IPC. Router delegates to channel plugin. 64MB limit |
| **Router made generic** | `src/router.ts` routes to any channel based on JID prefix (`wa:`, `dc:`, `tg:`) |
| **Group registration** | `src/db.ts` tracks which channel each group belongs to |
| **WhatsApp tests removed from core** | `src/channels/whatsapp.test.ts` deleted (tests live with plugin now) |
| **Reactions** | `react?(jid, messageId, emoji)` — optional emoji reaction method on Channel interface. WhatsApp (Baileys react), Discord (message.react), Telegram (setMessageReaction) |
| **Reply-quoting** | `sendMessage` gains `replyTo` parameter — orchestrator automatically quotes the triggering message. IPC `send_message` also supports `replyTo` |
| **Message IDs in prompts** | Agent XML now includes `id` attribute: `<message id="MSG_ID" sender="..." time="...">` — enables agents to reference specific messages |

### Channel plugins available

NanoClaw ships with no channels installed by default. Channel plugins are available from the [skills marketplace](https://github.com/TerrifiedBug/nanoclaw-skills) and installed via Claude Code's plugin system:

| Channel | Marketplace plugin | Install command |
|---------|-------------------|-----------------|
| WhatsApp | `nanoclaw-whatsapp` | `/plugin install nanoclaw-whatsapp@nanoclaw-skills` |
| Discord | `nanoclaw-discord` | `/plugin install nanoclaw-discord@nanoclaw-skills` |
| Telegram | `nanoclaw-telegram` | `/plugin install nanoclaw-telegram@nanoclaw-skills` |
| Slack | `nanoclaw-slack` | `/plugin install nanoclaw-slack@nanoclaw-skills` |

### How routing works

The router finds the channel that owns a JID and delegates:

```typescript
const channel = channels.find(c => c.ownsJid(jid) && c.isConnected());
await channel.sendMessage(jid, text);
```

Each channel plugin registers which JID patterns it owns (e.g., WhatsApp owns `*@s.whatsapp.net`, Discord owns `dc:*`). The database tracks which channel each registered group belongs to.

### Channel capability awareness

Each channel plugin template now includes a `container-skills/SKILL.md` that tells agents what the channel can and can't do (file sending support, media types, size limits). This means agents know at runtime whether they can send files, what formats are supported, and what the limitations are — without hardcoding channel knowledge into the core.

### Channel-agnostic changes

- `groups/main/CLAUDE.md` — Anti-prompt-injection rules, generic trigger examples
- `groups/global/CLAUDE.md` — References `$ASSISTANT_NAME` env var instead of hardcoded "TARS"
- `container/agent-runner/src/ipc-mcp-stdio.ts` — Tool descriptions say "message" not "WhatsApp message"; `send_file` tool with channel capability note
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
- **OAuth credential bind mount**: Host `~/.claude/.credentials.json` is bind-mounted directly into containers (file-level mount overlaying the session directory mount) instead of copied at spawn time. If any host process refreshes the token, containers see it immediately — eliminates stale token failures during long conversations
- **Auth error detection**: `orchestrator.ts` detects auth-specific error patterns (expired OAuth, invalid API key) and sends a targeted `[Auth Error]` notification to the user immediately, even when the agent had already sent output earlier in the conversation. Prevents silent failures where auth expires mid-conversation

---

## 4. Security Hardening

### New files

| File | Purpose |
|------|---------|
| `src/secret-redact.ts` | Outbound secret redaction — loads all `.env` values, strips them from outbound messages and container logs |
| `src/secret-redact.test.ts` | Tests for secret redaction (24 tests) |
| `container/agent-runner/src/security-hooks.ts` | Bash command sanitization, `/proc/*/environ` blocking, `/tmp/input.json` blocking |
| `container/agent-runner/src/security-hooks.test.ts` | Tests for security hooks |
| `docs/SECURITY.md` | Security model documentation (referenced from CLAUDE.md) |

### Changes to existing files

| File | What |
|------|------|
| `container/agent-runner/src/index.ts` | Secret scrubbing from agent output, security hook loading |
| `src/container-runner.ts` + `src/container-mounts.ts` | Secrets passed via stdin JSON (not written to files in container), OAuth credentials bind-mounted from host, container logs redacted |
| `src/router.ts` | `redactSecrets()` applied in `routeOutbound()` before channel delivery |
| `src/index.ts` | `loadSecrets()` called at startup |
| `src/container-runtime.ts` | Container resource limits: `--cpus=2`, `--memory=4g`, `--pids-limit=256` (prevents fork bombs and runaway agents) |
| `src/router.ts` | `stripInternalTags()` handles unclosed `<internal>` tags (prevents agent reasoning from leaking to users) |
| `src/ipc.ts` | Folder name allowlist validation (`/^[a-z0-9][a-z0-9_-]*$/i`) — blocks path traversal via `../../` in group folder names |
| `src/container-mounts.ts` | `assertPathWithin()` defense-in-depth — validates resolved paths stay within expected directories |
| `src/db.ts` | Folder validation on database retrieval — rejects rows with invalid folder names |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP schema allowlist for folder names (Zod regex + max length) |
| `CLAUDE.md` | Added security section referencing SECURITY.md |
| `groups/main/CLAUDE.md` | Anti-prompt-injection rules |

### How secrets work in containers

Upstream passes secrets via environment variables, which are visible to `env` and `/proc/*/environ`. This fork takes a different approach:

1. Secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) are passed in the stdin JSON, read once by the agent-runner, then used via the SDK `env` option
2. They never appear in `process.env`, on the filesystem, or in logs
3. Security hooks block Bash commands and Read tool calls that try to access `/proc/*/environ` or `/tmp/input.json`
4. Agent output is scrubbed for leaked secret values before routing to the user
5. **Outbound redaction** (`src/secret-redact.ts`) — reads ALL `.env` values at startup and strips them from outbound messages and container log files. Auto-detects secrets (no hardcoded list) — only a small safe-list of non-secret config vars like `ASSISTANT_NAME` and `CLAUDE_MODEL` is exempted
6. **OAuth credentials bind-mounted** (`src/container-mounts.ts`) — host `~/.claude/.credentials.json` is bind-mounted directly into containers rather than copied at spawn time, so token refreshes on the host are immediately visible to running containers
7. **Auth error detection** (`src/orchestrator.ts`) — authentication failures (expired tokens, invalid API keys) are detected by pattern matching and immediately surfaced to the user with a specific `[Auth Error]` message, even mid-conversation when other output has already been sent

### Container hardening (Docker)

- **`--cap-drop=ALL`** drops every Linux capability, then re-adds only `SYS_PTRACE` (needed for Chromium crashpad)
- **`--security-opt=no-new-privileges`** prevents privilege escalation via setuid/setgid binaries inside the container
- **Per-run output nonce** — output markers are `---NANOCLAW_OUTPUT_{nonce}_START---` instead of static strings. The 32-char hex nonce is generated per container run and passed via stdin, making it impossible for injected agent output to spoof real output markers

### IPC hardening

- **Symlink rejection** — `lstatSync()` rejects non-regular-file entries before reading (CWE-59)
- **O_NOFOLLOW** — file descriptor opened with `O_NOFOLLOW` flag to prevent TOCTOU race between lstat and open (CWE-367)
- **Size limit** — IPC JSON files capped at 1 MiB (prevents DoS via oversized files)
- **Entry type filtering** — `readdirSync({ withFileTypes: true })` used throughout, so only real files and directories are processed
- **send_file path traversal** — resolved host path validated to stay within the group directory (prevents `../../etc/passwd`-style attacks)
- **Once-schedule UTC fix** — bare datetime strings (no timezone suffix) now treated as UTC instead of server-local timezone

### Mount security

- **Exact matching only** — `matchesBlockedPattern()` uses strict `===` on path components instead of substring `.includes()`, preventing false positives (e.g. blocking "my-credentials-app" because it contained "credentials")
- **Additional blocked patterns** — `secrets.json`, `token.json`, `.ssh-agent`

### Read-only project root mount

- **Read-only project root mount** — Main group's project root is now mounted read-only to prevent container escape via host code modification (port of upstream 5fb1064)

### Group folder path validation

- **Group folder path validation** — Added max-length (64 chars) and reserved name (`global`) checks to folder validation. Malformed scheduled tasks are now paused instead of retrying forever (port of upstream 2e1c768, 02d8528)

### .env permissions warning

- `readEnvFile()` warns on stderr if `.env` has group/other read permissions (mode > 600)

### What's protected

- **Bash sanitization**: Agent Bash commands are inspected; access to `/proc/*/environ` (which leaks all env vars including secrets) is blocked
- **Secret isolation**: Only auth-related env vars are exposed to containers, not the full `.env`
- **Input file blocking**: `/tmp/input.json` (which contains the raw user message) can't be read by the agent to bypass prompt injection defenses
- **Output scrubbing**: Agent responses are scanned for leaked secrets before being sent back to the user
- **IPC authorization**: Each group's IPC directory (`data/ipc/{group}/`) determines identity — non-main groups can only send messages and schedule tasks for themselves, preventing cross-group privilege escalation

---

## 5. Media Pipeline

Upstream only handles text messages. This fork adds core support for media in the message flow.

### Core changes

| File | What |
|------|------|
| `src/types.ts` | Added `mediaType`, `mediaPath`, `mediaHostPath` fields to `NewMessage`; optional `sendFile()` on `Channel` interface |
| `src/router.ts` | `routeOutboundFile()` — finds the owning channel and delegates file delivery |
| `src/ipc.ts` | `send_file` IPC message type — translates container paths to host paths, validates size (64MB limit), calls router |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `send_file` MCP tool — agents can send files from `/workspace/` back to the chat |
| `container/agent-runner/src/index.ts` | Media files bind-mounted into container so agents can read/analyze them |

### How media receiving works

1. Channel plugin downloads media to host temp directory
2. `mediaHostPath` is set on the message (host-side path for plugin hooks)
3. `mediaPath` is set to the container-side path
4. Media file is bind-mounted into the container
5. Agent can read the file (images are displayed, documents are parsed)

Channel plugins implement the download logic. Host-side plugin hooks (`onInboundMessage`) can transform media before it reaches the agent (e.g., transcription).

### Video thumbnail extraction

When users send videos or GIFs via WhatsApp, the agent receives an MP4 file that Claude cannot view directly. The WhatsApp channel plugin now extracts a JPEG thumbnail frame from video messages so agents can "see" the content.

**How it works:**
- On startup, the plugin checks for `ffmpeg` availability (cached, checked once)
- When a video message arrives, `extractThumbnail()` runs `ffmpeg -frames:v 1` to grab the first frame as a high-quality JPEG
- Falls back to Baileys' embedded `jpegThumbnail` (low-res ~100px) when ffmpeg is not installed
- **GIFs** (WhatsApp converts to MP4 with `gifPlayback: true`): presented as `[image: ...thumb.jpg]` so the agent treats it as a viewable image
- **Regular videos**: presented as `[video: ...mp4]\n[thumbnail: ...thumb.jpg]` so the agent can preview without viewing the MP4
- ffmpeg is an optional host dependency — the feature degrades gracefully without it

### How file sending works

1. Agent calls `send_file` MCP tool with a path inside `/workspace/`
2. IPC handler translates container path to host path, validates file exists and is ≤64MB
3. Router finds the channel that owns the chat JID
4. Channel plugin's `sendFile()` method delivers via the appropriate API (auto-selects image/video/audio/document based on MIME type)
5. WhatsApp plugin unwraps nested message wrappers (viewOnce, ephemeral, documentWithCaption) for proper media display

---

## 6. Task Scheduler Improvements

### Changes to `src/task-scheduler.ts`

| Feature | What |
|---------|------|
| **Model selection** | Tasks can specify which Claude model to use (e.g., Haiku for cheap recurring tasks) |
| **Error notifications** | When a scheduled task fails, the user gets a notification instead of silent failure |
| **`claimTask()`** | Atomic task claiming to prevent double-execution in concurrent scenarios |
| **Shorter idle timeout** | `SCHEDULED_TASK_IDLE_TIMEOUT` (configurable) for faster task completion |
| **resumeAt persistence** | Persists the last assistant message UUID per group so the SDK can skip replay on container restart (in-memory, survives container restarts within the same process) |

### Supporting changes

| File | What |
|------|------|
| `src/ipc.ts` | Model field in IPC messages, `authorizedTaskAction` helper for DRY task auth |
| `src/db.ts` | `claimTask()` method, model column in tasks table |
| `src/config.ts` | `SCHEDULED_TASK_IDLE_TIMEOUT` constant |
| `src/orchestrator.ts` | `resumePositions` map — persists and passes `resumeAt` for each group's container sessions |
| `src/container-runner.ts` | `resumeAt` field in ContainerInput/ContainerOutput interfaces |
| `container/agent-runner/src/index.ts` | Model selection, resumeAt pass-through to SDK query, retry-without-session on failure |

---

## 7. Bug Fixes (Submitted as PRs)

These are clean fixes submitted to upstream. If they merge, the divergences collapse.

| PR | Fix | Files |
|----|-----|-------|
| [#245](https://github.com/qwibitai/nanoclaw/pull/245) | `>=` timestamp comparison (was `>`, causing missed messages at exact same timestamp) + message dedup guard | `src/db.ts`, `src/index.ts` |
| [#246](https://github.com/qwibitai/nanoclaw/pull/246) | Exclude test files from agent-runner production build (vitest not in prod) | `container/agent-runner/tsconfig.json` |
| [#247](https://github.com/qwibitai/nanoclaw/pull/247) | Consecutive error tracking — counts sequential failures, notifies user | `src/index.ts` |
| [#248](https://github.com/qwibitai/nanoclaw/pull/248) | Duplicate task creation prevention — warns in IPC tool description | `container/agent-runner/src/ipc-mcp-stdio.ts` |

- **Container timezone** — TZ is now passed to containers via env. Containers no longer default to UTC. UTC-suffixed timestamps are rejected in schedule_task validation since all times should be local (port of upstream 77f7423)
- **Idle preemption** — Scheduled tasks only preempt idle containers, not ones actively processing. Adds idleWaiting tracking to prevent mid-work container kills (port of upstream 93bb94f, c6b69e8, 3d8c0d1)

---

## 8. New Skills

Claude Code skills that guide the AI through installing integrations. Each skill creates a plugin directory with manifest, code, and container-side instructions.

Integration and channel skills (27 total) have been moved to the [skills marketplace](https://github.com/TerrifiedBug/nanoclaw-skills) — see [§16](#16-skill-marketplace). Core skills (10) remain in the main repository under `.claude/skills/`.

### Integration skills (23) — now in marketplace

| Skill | What it adds |
|-------|-------------|
| `add-skill-brave-search` | Web search via Brave Search API |
| `add-skill-calendar` | Google Calendar + CalDAV (includes TypeScript CLI baked into image via Dockerfile.partial) |
| `add-skill-changedetection` | changedetection.io website monitoring |
| `add-skill-claude-mem` | Persistent cross-session memory for agents |
| `add-skill-commute` | Travel times via Waze API |
| `add-skill-cs2-esports` | CS2 esports match tracking via Liquipedia |
| `add-skill-dashboard` | Admin dashboard — web UI for monitoring and management (see [§12](#12-admin-dashboard)) |
| `add-skill-freshrss` | Self-hosted RSS feed reader |
| `add-skill-giphy` | GIF search and sending via Giphy API |
| `add-skill-github` | GitHub API access (PRs, issues, commits) |
| `add-skill-gmail` | Gmail access via gog CLI (search, read, send) |
| `add-skill-homeassistant` | Home Assistant smart home control via MCP |
| `add-skill-imap-read` | Read-only IMAP email access |
| `add-skill-n8n` | n8n workflow automation |
| `add-skill-norish` | Recipe import by URL |
| `add-skill-notion` | Notion API for notes/project management |
| `add-skill-parallel` | Parallel AI web research via MCP servers |
| `add-skill-stocks` | Stock prices and financial data via Yahoo Finance |
| `add-skill-trains` | UK National Rail departures (includes Python script) |
| `add-skill-transcription` | Voice message transcription via OpenAI Whisper (channel-agnostic) |
| `add-skill-weather` | Weather via wttr.in / Open-Meteo (no API key needed) |
| `add-skill-telegram-swarm` | Agent Teams support for Telegram (pool bot identities) |
| `add-skill-webhook` | HTTP webhook endpoint for push events (Home Assistant, uptime monitors, etc.) |

### Channel skills (4) — now in marketplace

| Skill | What it adds |
|-------|-------------|
| `add-channel-whatsapp` | Install WhatsApp as a channel plugin |
| `add-channel-discord` | Install Discord as a channel plugin |
| `add-channel-telegram` | Install Telegram as a channel plugin |
| `add-channel-slack` | Install Slack as a channel plugin |

### Core skills (10) — in main repo

| Skill | What it does |
|-------|-------------|
| `nanoclaw-setup` | First-time installation, auth, service configuration |
| `nanoclaw-debug` | Container issues, logs, troubleshooting |
| `nanoclaw-set-model` | Change Claude model used by containers |
| `nanoclaw-update` | Pull fork updates, compare plugin versions |
| `nanoclaw-add-group` | Register a group on any installed channel |
| `nanoclaw-add-agent` | Guided creation of persistent agent definitions for groups (Agent Teams) |
| `nanoclaw-security-audit` | Pre-installation security audit of skill plugins |
| `nanoclaw-publish-skill` | Publish a local skill to the marketplace |
| `create-skill-plugin` | Guided creation of new skill plugins from an idea |
| `create-channel-plugin` | Guided creation of new channel plugins |

### Rewritten upstream skills

| Skill | What changed |
|-------|-------------|
| `nanoclaw-setup` | Major rewrite: channel-agnostic plugin flow, headless/Linux QR auth, systemd service support. Upstream's PR #258 replaced theirs with numbered shell scripts that hardcode WhatsApp. |
| `nanoclaw-debug` | Channel-agnostic, plugin-aware (upstream version is WhatsApp-specific) |

---

## 9. Documentation

### New docs

| File | Contents |
|------|----------|
| `docs/PLUGINS.md` | Complete plugin system architecture — manifests, hooks, mounts, Dockerfile.partial, env vars, MCP merging, source code changes |
| `docs/CHANNEL_PLUGINS.md` | Channel plugin development guide — interface, auth, registration, testing |
| `docs/MARKETPLACE.md` | Skill marketplace guide — installation, publishing, available skills |
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
| **Reply context** | `src/types.ts`, `src/router.ts`, `src/db.ts`, `plugins/channels/whatsapp/index.js` | When a user replies to a specific message, the agent sees `<reply to="sender">quoted text</reply>` inside the message XML. Stored as JSON in SQLite, extracted from Baileys `contextInfo` |
| **Singleton PID guard** | `src/index.ts` | Prevents running duplicate instances (e.g. `npm run dev` while systemd service is active). Writes `host.pid`, checks if existing PID is alive, cleans up on exit |
| **Heartbeat typing indicator** | `src/index.ts` | Shows typing indicator on every message, not just the first |
| **Read receipts** | `plugins/channels/whatsapp/index.js` | Marks messages as read after processing |
| **Presence management** | `src/index.ts` | Sends `available` presence on connect for consistent typing indicators |
| **Per-group webhook routing** | `plugins/webhook/` | Each group gets its own webhook path + token (upstream uses single global secret) |
| **Agent browser as plugin** | `plugins/agent-browser/` | Moved from `container/skills/` to plugin system |
| **Token count badge** | `repo-tokens/badge.svg` | Auto-updated context window usage badge |
| **React IPC + MCP tool** | `src/ipc.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts` | Agents can send emoji reactions via IPC. Host-side handler + agent-side `react` MCP tool. Same authorization as `send_message`. Channel skills document when to use reactions |
| **GIF search skill** | `plugins/gif-search/` | Giphy API GIF search — returns both gif and mp4 URLs, defaults to GIF format for channel-agnostic compatibility |

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

---

## 12. Admin Dashboard

A server-rendered web UI for monitoring system health, managing scheduled tasks, viewing messages, and inspecting groups. Runs as an optional plugin with htmx for live partial updates, Tailwind CSS for styling, and bearer token auth for security.

### What it provides

| Section | Description |
|---------|-------------|
| **Health bar** | Uptime, memory usage, Node version, PID |
| **Identity** | Safe env vars (`ASSISTANT_NAME`, `TZ`, etc.), IDENTITY.md, global CLAUDE.md |
| **Channels** | Connection status per channel (green/red indicators) |
| **Queue** | Active container count, per-group state with pending/retry badges |
| **Recent Runs** | Last 15 task executions with duration and status |
| **Groups** | Registered groups table with detail view (CLAUDE.md, MEMORY.md, media size) |
| **Tasks** | Scheduled task management — pause/resume, delete, run now, view run logs |
| **Create Task** | Form to create new scheduled tasks |
| **Plugins** | Installed plugins with type/scope badges, uninstalled templates |
| **Messages** | Per-group recent message viewer |
| **Send Message** | Send a message to any registered group |
| **System Logs** | Live tail of `nanoclaw.log` (last 64KB, 100 lines) |
| **Dark/Light toggle** | Theme toggle with localStorage persistence |

### Core code changes (4 files, ~100 lines added)

The dashboard extends PluginContext with read-only monitoring and task management APIs. All changes are purely additive — no existing lines modified.

| File | What was added |
|------|---------------|
| `src/plugin-types.ts` | 28 lines — monitoring, task CRUD, and message query methods on `PluginContext` interface |
| `src/index.ts` | 32 lines — wiring the new methods to existing orchestrator/db/queue/plugin-loader functions |
| `src/group-queue.ts` | 15 lines — `getStatus()` method exposing per-group queue state |
| `src/db.ts` | 12 lines — `getTaskRunLogs()` and `getRecentMessages()` query functions (parameterized SQL) |

### Security

- **Bearer token auth** via `DASHBOARD_SECRET` env var (cookie + header + query param)
- **XSS protection** — all dynamic content HTML-escaped including single quotes
- **Input validation** — task status/schedule_type allowlisted, JID validated against registered groups
- **No direct DB access** — all data flows through PluginContext methods
- **Bind to localhost by default** — exposed via socat bridge for VPN access

### Plugin files

| File | Purpose |
|------|---------|
| `plugins/dashboard/plugin.json` | Manifest: `onStartup`/`onShutdown` hooks |
| `plugins/dashboard/index.js` (900 lines) | HTTP server, auth middleware, route handlers, HTML renderers |
| `.claude/skills/add-skill-dashboard/SKILL.md` | Installation instructions |
| `.claude/skills/add-skill-dashboard/files/` | Template files copied on install |

---

## 13. Agent Identity System

Agents can now have a personality via `IDENTITY.md` files, inspired by OpenClaw's SOUL.md philosophy.

### What was built

| File | Purpose |
|------|---------|
| `groups/global/IDENTITY.md` | Default TARS personality — applies to all groups as a fallback |
| `container/agent-runner/src/index.ts` | Loads IDENTITY.md into system prompt (per-group override or global fallback) |
| `src/container-mounts.ts` | Mounts `/workspace/global` for all groups (was non-main only) |

### How it works

The agent-runner loads identity files with a fallback pattern:
1. Check for `groups/{folder}/IDENTITY.md` (per-group override)
2. Fall back to `groups/global/IDENTITY.md` (default personality)
3. Identity content is prepended to the system prompt, before functional CLAUDE.md instructions

This separates **personality** (IDENTITY.md) from **capabilities and rules** (CLAUDE.md). Groups can override the personality without duplicating operational instructions.

### Per-group customization

The `nanoclaw-add-group` skill now offers optional per-group personality customization at registration time. Creating `groups/{folder}/IDENTITY.md` overrides the global identity for that group only.

---

## 14. Plugin Versioning & Update System

All plugins now include a `"version"` field in their `plugin.json` manifest (semver format, e.g. `"1.0.0"`). This enables the update skill to detect when skill templates have newer versions than installed plugins.

### What was added

| Change | Details |
|--------|---------|
| **Version field** | `"version": "1.0.0"` added to all 47 plugin.json files (21 installed plugins, 25 skill templates, 1 channel plugin) |
| **Create-plugin templates** | `create-skill-plugin` and `create-channel-plugin` SKILL.md files updated — all archetype templates and the schema reference now include `"version"` |
| **Update skill rework** | `nanoclaw-update` completely rewritten for fork-based workflow with plugin version detection |

### How plugin versioning works

- Each `plugin.json` has a `"version": "1.0.0"` field
- Marketplace plugin manifests are the "source of truth" for the latest version (previously: skill templates under `.claude/skills/add-*/files/`)
- Installed plugins under `plugins/` may lag behind if the user hasn't updated from the marketplace
- The `/nanoclaw-update` skill checks marketplace versions vs installed versions

### Update skill rework

The `nanoclaw-update` skill was rewritten with three key changes:

1. **Fork-based**: pulls from `nanoclaw` remote (`TerrifiedBug/nanoclaw`) instead of `upstream` (`qwibitai/nanoclaw`), since nanotars tracks the fork
2. **Fetch-then-assess**: fetches first, then shows a combined preview of core code changes AND plugin version differences before asking whether to proceed — the user sees everything that would change before committing to the merge
3. **Plugin update flow**: after merge, compares template versions vs installed plugins, offers to update outdated plugins while preserving user's group/channel scoping

### Files modified

| File | Change |
|------|--------|
| `plugins/*/plugin.json` (21 files) | Added `"version": "1.0.0"` |
| `plugins/channels/whatsapp/plugin.json` | Added `"version": "1.0.0"` |
| `.claude/skills/add-*/files/plugin.json` (25 files) | Added `"version": "1.0.0"` |
| `.claude/skills/create-skill-plugin/SKILL.md` | Added `"version"` to all 4 archetype templates + schema reference |
| `.claude/skills/create-channel-plugin/SKILL.md` | Added `"version"` to channel plugin template |
| `.claude/skills/nanoclaw-update/SKILL.md` | Complete rewrite: fork remote, fetch-then-assess, plugin version check |

---

## 15. Agent Teams & Per-Group Agent Definitions

Persistent, role-based agent definitions auto-discovered by the agent-runner and registered as SDK `subagent_type` options. Each group can have specialized agents (research, dev, coordinator, etc.) defined as files — no core code changes needed to add agents.

### Agent definitions

Agents are defined as files under `groups/{folder}/agents/{name}/`:

| File | Purpose |
|------|---------|
| `agent.json` | Required config — description, model, maxTurns (discovery marker) |
| `IDENTITY.md` | Agent personality — who it is, its expertise |
| `CLAUDE.md` | Agent instructions — capabilities, tools, communication rules |

The agent-runner scans `/workspace/group/agents/*/agent.json` at container startup and passes them to the SDK's `query()` as the `agents` option. The SDK registers them as `subagent_type` values on the Task tool. Agents can be spawned foreground or background (`run_in_background: true`).

### SDK integration

The `discoverAgents()` function in the agent-runner:
1. Scans agent directories for `agent.json` (required — directories without it are skipped)
2. Reads `IDENTITY.md` (required) and `CLAUDE.md` (optional) to build the agent prompt
3. Maps `agent.json` fields to `AgentDefinition`: `description`, `model` (haiku/sonnet/opus/inherit), `maxTurns`
4. Returns `Record<string, AgentDefinition>` keyed by directory name (e.g., `"research"`)

The existing `task_notification` heartbeat resets the host idle timer when background agents complete, preventing premature container termination. Groups without agent directories are unaffected — the `agents` option is omitted from `query()`.

### WhatsApp sender display

When subagents specify a `sender` parameter via `send_message`, WhatsApp now displays it as a bold name prefix:

```
TARS: *Research Specialist*
Here's what I found about coral reefs...
```

This gives each subagent a visible identity without needing multiple phone numbers (unlike Telegram's bot pool approach). The change is in `sendMessage()` — if `sender` is provided and differs from `assistantName`, the message is prefixed with `*{sender}*\n`.

### New skill

| Skill | Purpose |
|-------|---------|
| `nanoclaw-add-agent` | Guided flow to create agent definitions (including `agent.json`) for a group |

### Updated skills

| Skill | Change |
|-------|--------|
| `add-channel-whatsapp` | Documents Agent Teams support (no setup needed) |
| `nanoclaw-add-group` | Mentions `/nanoclaw-add-agent` after group registration |
| `create-channel-plugin` | Added sender parameter guidance for new channels |

### Files modified

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Agent auto-discovery via `discoverAgents()`, wired into `query()` |
| `groups/main/CLAUDE.md` | Simplified Agent Teams section for SDK-native `subagent_type` |
| `plugins/channels/whatsapp/index.js` | Sender prefix display in `sendMessage` |
| `.claude/skills/add-channel-whatsapp/files/index.js` | Same change in template |
| `plugins/channels/whatsapp/container-skills/SKILL.md` | Agent Teams documentation for agents |
| `.claude/skills/add-channel-whatsapp/files/container-skills/SKILL.md` | Same in template |

---

## 16. Skill Marketplace

Installable skills (`add-skill-*`, `add-channel-*`) moved to a separate Claude Code plugin marketplace at [TerrifiedBug/nanoclaw-skills](https://github.com/TerrifiedBug/nanoclaw-skills). This keeps the main repo focused on core functionality while making skills discoverable via Claude Code's native `/plugin` UI.

**What moved:** 23 skill plugins + 4 channel plugins (27 total)
**What stayed:** 10 core skills (`nanoclaw-*`, `create-*-plugin`, `nanoclaw-publish-skill`)

**For forkers:**
```
/plugin marketplace add TerrifiedBug/nanoclaw-skills
/plugin install nanoclaw-weather@nanoclaw-skills
```

**New skills:**
- `/nanoclaw-publish-skill` — publishes local skills to the marketplace
- `/nanoclaw-remove-plugin` — atomic plugin removal (runtime dir, env vars, DB entries for channels, marketplace skill cleanup)

**Marketplace update tracking:**
- Each marketplace SKILL.md writes a `.marketplace.json` breadcrumb to the installed plugin directory after `cp -r`
- Format: `{"marketplace":"nanoclaw-skills","plugin":"nanoclaw-weather"}`
- `/nanoclaw-update` scans these files, diffs installed plugins against `~/.claude/plugins/marketplaces/` source, and offers to re-copy changed files while preserving user scoping (`channels`/`groups`)
- Works with Claude Code's periodic marketplace sync — no custom infrastructure needed

**Updated skills:**
- `nanoclaw-setup` — now includes marketplace provisioning step
- `nanoclaw-update` — marketplace-aware version checking + `.marketplace.json` diff-based update detection
- `create-skill-plugin` / `create-channel-plugin` — publish guidance + marketplace breadcrumb template
- `nanoclaw-publish-skill` — auto-injects `.marketplace.json` write step into SKILL.md during publishing

**Files added/modified:**
- `.claude/settings.json` — `extraKnownMarketplaces` for auto-discovery
- `.claude/skills/nanoclaw-publish-skill/SKILL.md` — new publish skill
- `.claude/skills/nanoclaw-setup/SKILL.md` — marketplace step + marketplace channel discovery
- `.claude/skills/nanoclaw-update/SKILL.md` — marketplace-aware version checking
- `.claude/skills/create-skill-plugin/SKILL.md` — publish guidance
- `.claude/skills/create-channel-plugin/SKILL.md` — publish guidance
- `CONTRIBUTING.md` — marketplace contribution workflow
- `.github/CODEOWNERS` — core skills maintainer-only
- `.github/PULL_REQUEST_TEMPLATE.md` — marketplace skill checklist

---

### Key architectural differences

| Aspect | Upstream | This Fork |
|--------|----------|-----------|
| Channels | WhatsApp hardcoded in `src/channels/whatsapp.ts` | Extracted to plugins, core is channel-agnostic |
| Container runtime | Apple Container only | Docker + Apple Container via abstraction layer |
| Extensibility | Skills only (SKILL.md files) | Runtime plugins with hooks, mounts, env vars, MCP, Dockerfile.partial |
| Dependencies | All channel SDKs in root `package.json` | Per-plugin `package.json` (only installed plugins add deps) |
| Media | Text only | Bidirectional: downloads into container + agents can send files back via `send_file` MCP tool |
| Security | Trust-based (one user) | Defense-in-depth (secret isolation, Bash hooks, IPC auth, resource limits, path traversal defense, pre-install security audits) |
| Setup | Shell scripts hardcoding WhatsApp | Channel-agnostic SKILL.md with plugin detection |
| Scheduled tasks | Single model, silent failures | Per-task model selection, error notifications, atomic claiming |
| Updates | Manual `git pull` from upstream | Fetch-then-assess from fork with plugin version comparison |

---

## 17. Plugin Scoping Standardization

All plugin install skills now include a mandatory **Plugin Configuration** step that prompts users to confirm or customize `channels` and `groups` scoping. Previously only 2/27 marketplace plugins included these fields in `plugin.json`, and only 7/27 had a scoping step in their install skills.

### What changed

- **`create-skill-plugin` template** — Phase 3 now mandates Plugin Configuration for all plugins (not just sensitive ones). The generated SKILL.md template includes a mandatory configuration step after file copy.
- **Local plugins** — Added `channels`/`groups` fields to `plugins/weather/plugin.json` and `plugins/dashboard/plugin.json`.
- **Marketplace `plugin.json` files** — All 26 marketplace plugin templates now include `"channels": ["*"], "groups": ["*"]` defaults.
- **Marketplace install skills** — All 23 skill plugin install skills now include a Plugin Configuration step:
  - 7 existing "Group Scoping" sections renamed to "Plugin Configuration" with channels scoping added
  - 16 skills received new Plugin Configuration steps (brief for informational/system plugins, detailed for sensitive plugins)
- **Channel plugins** (discord, slack, telegram, whatsapp) — `plugin.json` templates updated for completeness; install skills unchanged since channels scope via group registration.

