<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  A personal Claude assistant built on <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a>. Multi-channel, plugin-based, container-isolated.
</p>

## What This Is

A heavily customized fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) — a lightweight Claude assistant that runs agents in Linux containers. This fork adds a plugin architecture, multi-channel support, Docker/Linux hosting, security hardening, an admin dashboard, agent teams, and 35 installation skills. The core philosophy remains: small enough to understand, secure by OS-level isolation.

## What It Does

**Channels** — Connect via WhatsApp, Discord, Telegram, or build your own channel plugin. Each channel is a plugin; the core is channel-agnostic.

**Plugin System** — All capabilities are runtime-loaded plugins with hooks, env vars, MCP configs, container mounts, and `Dockerfile.partial` support. Plugins are installed via Claude Code skills and gitignored per-deployment.

**Container Isolation** — Agents run in Docker (Linux) or Apple Container (macOS) with explicit mount boundaries, resource limits (`--cpus=2`, `--memory=4g`, `--pids-limit=256`), and no host access beyond what's mounted.

**Security** — Secrets passed via stdin (never in env/filesystem), Bash command sanitization, `/proc/*/environ` blocking, outbound secret redaction, IPC authorization per group, path traversal defense, pre-install security audits.

**Media Pipeline** — Bidirectional media: images/video/audio/documents download into containers for agent analysis, agents send files back via `send_file` MCP tool (64MB limit). Video thumbnail extraction via ffmpeg.

**Agent Teams** — Persistent agent definitions per group (`agents/{name}/IDENTITY.md` + `CLAUDE.md`). The lead agent spawns specialized subagents via Claude's Agent Teams. WhatsApp shows each agent's name as a bold prefix.

**Admin Dashboard** — Server-rendered web UI (htmx + Tailwind) with system health, queue status, task management, message viewer, group inspection, plugin list, system logs, and dark/light toggle. Bearer token auth.

**Scheduled Tasks** — Recurring jobs with per-task model selection, error notifications, atomic claiming, and configurable idle timeouts.

**Agent Identity** — `IDENTITY.md` files give agents personality, separate from operational `CLAUDE.md` instructions. Per-group overrides with global fallback.

**Per-Group Credentials** — Groups can have their own `.env` overrides for isolated credentials (e.g., personal vs team calendar).

**Plugin Versioning** — Semver tracking on all plugins. The update skill compares template versions vs installed versions and offers guided upgrades.

## Architecture

```
Channel Plugins ──> SQLite ──> Polling Loop ──> Container (Claude Agent SDK) ──> Response
  (WhatsApp,         (messages,    (2s interval,     (Docker or Apple Container,    (routed back
   Discord,           groups,       dedup, trigger     security-validated mounts,     to channel)
   Telegram)          tasks)        matching)          stdin secrets, IPC polling)
```

Single Node.js process. Channel plugins deliver messages to SQLite. A polling loop feeds them to agents running in isolated containers. Per-group message queue with concurrency control (default 5 containers). IPC via filesystem.

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, plugin lifecycle, message loop, agent invocation |
| `src/plugin-loader.ts` | Plugin discovery, manifest parsing, env/MCP/mount collection |
| `src/plugin-types.ts` | Plugin system type definitions |
| `src/container-runner.ts` | Spawns streaming agent containers |
| `src/container-mounts.ts` | Volume mount construction, env files, secrets |
| `src/container-runtime.ts` | Runtime abstraction (Docker / Apple Container) |
| `src/mount-security.ts` | Mount path validation and allowlist |
| `src/router.ts` | Message formatting and outbound routing to channels |
| `src/ipc.ts` | IPC watcher, task processing, cross-group authorization |
| `src/group-queue.ts` | Per-group queue with global concurrency limit |
| `src/task-scheduler.ts` | Scheduled task execution with model selection |
| `src/secret-redact.ts` | Outbound secret redaction |
| `src/db.ts` | SQLite operations (messages, groups, sessions, state) |
| `groups/*/CLAUDE.md` | Per-group agent instructions (isolated) |
| `groups/*/IDENTITY.md` | Per-group agent personality (optional) |
| `plugins/channels/*/` | Channel plugins (WhatsApp, Discord, Telegram) |
| `plugins/*/` | Skill plugins (search, calendar, dashboard, etc.) |

## Skills (35)

Everything is installed via [Claude Code skills](https://code.claude.com/docs/en/skills). Run a skill, Claude does the work, you get a clean plugin tailored to your setup.

### Integration Skills (23)

| Skill | What it adds |
|-------|-------------|
| `/add-skill-brave-search` | Web search via Brave API |
| `/add-skill-calendar` | Google Calendar + CalDAV |
| `/add-skill-changedetection` | Website monitoring via changedetection.io |
| `/add-skill-claude-mem` | Persistent cross-session memory |
| `/add-skill-commute` | Travel times via Waze |
| `/add-skill-cs2-esports` | CS2 esports match tracking |
| `/add-skill-dashboard` | Admin web UI |
| `/add-skill-freshrss` | Self-hosted RSS reader |
| `/add-skill-giphy` | GIF search and sending |
| `/add-skill-github` | GitHub API (PRs, issues, commits) |
| `/add-skill-gmail` | Gmail (search, read, send) |
| `/add-skill-homeassistant` | Smart home control via MCP |
| `/add-skill-imap-read` | Read-only IMAP email |
| `/add-skill-n8n` | n8n workflow automation |
| `/add-skill-norish` | Recipe import by URL |
| `/add-skill-notion` | Notion pages and databases |
| `/add-skill-parallel` | Parallel AI web research |
| `/add-skill-stocks` | Stock prices via Yahoo Finance |
| `/add-skill-telegram-swarm` | Agent Teams for Telegram (bot pool) |
| `/add-skill-trains` | UK National Rail departures |
| `/add-skill-transcription` | Voice transcription via Whisper |
| `/add-skill-weather` | Weather (no API key needed) |
| `/add-skill-webhook` | HTTP webhook endpoint for push events |

### Channel Skills (4)

| Skill | What it adds |
|-------|-------------|
| `/add-channel-whatsapp` | WhatsApp via Baileys |
| `/add-channel-discord` | Discord (servers + DMs) |
| `/add-channel-telegram` | Telegram (bot API) |
| `/nanoclaw-add-group` | Register a group on any channel |

### Meta Skills (8)

| Skill | What it does |
|-------|-------------|
| `/nanoclaw-setup` | First-time install, auth, service config |
| `/nanoclaw-debug` | Container troubleshooting and health checks |
| `/nanoclaw-set-model` | Change Claude model for containers |
| `/nanoclaw-update` | Pull fork updates, compare plugin versions |
| `/nanoclaw-add-agent` | Create agent definitions for a group |
| `/nanoclaw-security-audit` | Pre-install security audit of skill plugins |
| `/create-skill-plugin` | Build a new skill plugin from scratch |
| `/create-channel-plugin` | Build a new channel plugin from scratch |

## Getting Started

```bash
git clone https://github.com/TerrifiedBug/nanotars.git
cd nanotars
claude
```

Then run `/nanoclaw-setup`. Claude handles dependencies, authentication, container build, and service configuration.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)
- **Optional:** ffmpeg for video/GIF thumbnail extraction

## Key Differences from Upstream

| Aspect | Upstream NanoClaw | This Fork |
|--------|-------------------|-----------|
| Channels | WhatsApp hardcoded | Plugin-based: WhatsApp, Discord, Telegram, extensible |
| Container runtime | Apple Container only | Docker + Apple Container via abstraction layer |
| Extensibility | Skills only | Runtime plugins with hooks, mounts, env vars, MCP, Dockerfile.partial |
| Dependencies | All channel SDKs in root package.json | Per-plugin packages |
| Media | Text only | Bidirectional media + video thumbnails |
| Security | Trust-based | Defense-in-depth (secret isolation, Bash hooks, IPC auth, resource limits) |
| Scheduled tasks | Single model, silent failures | Per-task model, error notifications, atomic claiming |
| Monitoring | None | Admin dashboard with live system status |
| Agent identity | None | IDENTITY.md personality system |
| Agent teams | Basic support | Persistent per-group agent definitions with channel display |
| Updates | Manual git pull | Fetch-then-assess with plugin version comparison |

## Credits

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) by [qwibitai](https://github.com/qwibitai). See [docs/CHANGES.md](docs/CHANGES.md) for the full fork changelog.

## License

MIT
