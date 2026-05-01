<p align="center">
  <img src="assets/nanotars-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  A personal Claude assistant built on <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a>. Multi-channel, plugin-based, container-isolated.
</p>

## Install

NanoTars requires Node.js 20+ before install. Install Node with your OS package manager, `nvm`, `fnm`, or the official installer, then run the single Node-first install flow:

```bash
git clone https://github.com/TerrifiedBug/nanotars.git
cd nanotars
corepack enable
pnpm install --frozen-lockfile
pnpm run build
./container/build.sh
node dist/cli/nanotars.js service install
```

The service install writes a launchd plist on macOS, a systemd-user unit on Linux when available, or a nohup wrapper for root/WSL-style hosts.

**After install — manage the service:**

```bash
node dist/cli/nanotars.js status     # health snapshot
node dist/cli/nanotars.js logs       # tail logs (or show error log if main is empty)
node dist/cli/nanotars.js restart    # restart
node dist/cli/nanotars.js stop       # stop
```

**Bootstrap your first agent:**

1. Open Claude Code in the install directory:
   ```bash
   cd $HOME/nanotars && claude
   ```
2. Inside Claude, run `/nanotars-setup` — walks through:
   - Pick a chat channel (Telegram, Discord, Slack, WhatsApp, …)
   - Install the channel plugin (`/add-<channel>` if needed)
   - Wire your first agent group to that channel
   - Verify the agent responds in chat
3. (Optional) Edit personality + instructions:
   - `groups/main/IDENTITY.md` — soul / personality
   - `groups/main/CLAUDE.md` — operational guidance
4. (Optional) Register a Claude skill marketplace:
   ```
   /plugin marketplace add <owner>/<repo>
   /plugin install <skill-name>
   ```

## What This Is

A heavily customized fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) — a lightweight Claude assistant that runs agents in Linux containers. This fork adds a plugin architecture, multi-channel support, Docker/Linux hosting, security hardening, an admin dashboard, agent teams, and a [skills marketplace](https://github.com/TerrifiedBug/nanotars-skills) with 27 installable integrations. The core philosophy remains: small enough to understand, secure by OS-level isolation.

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

## Skills

Everything is installed via [Claude Code skills](https://code.claude.com/docs/en/skills). Run a skill, Claude does the work, you get a clean plugin tailored to your setup.

### Integration & Channel Skills (27 — via marketplace)

Integration skills (weather, calendar, search, etc.) and channel skills (Discord, Telegram, Slack, WhatsApp) are available from the [nanotars skills marketplace](https://github.com/TerrifiedBug/nanotars-skills). Browse and install via Claude Code's built-in plugin system:

```
/plugin marketplace add TerrifiedBug/nanotars-skills
/plugin install nanotars-weather@nanotars-skills
```

Or browse all 27 skills in the `/plugin` Discover tab. Categories: messaging channels, productivity, search, media, monitoring, smart home, and utilities.

### Core Skills (10 — in this repo)

| Skill | What it does |
|-------|-------------|
| `/nanotars-setup` | First-time install, auth, service config |
| `/nanotars-debug` | Container troubleshooting and health checks |
| `/nanotars-set-model` | Change Claude model for containers |
| `/nanotars-update` | Pull fork updates, compare plugin versions |
| `/nanotars-add-group` | Register a group on any channel |
| `/nanotars-add-agent` | Create agent definitions for a group |
| `/nanotars-security-audit` | Pre-install security audit of skill plugins |
| `/nanotars-publish-skill` | Publish a local skill to the marketplace |
| `/nanotars-update-skill` | Sync plugin improvements to marketplace |
| `/create-skill-plugin` | Build a new skill plugin from scratch |
| `/create-channel-plugin` | Build a new channel plugin from scratch |

## Plugins

NanoClaw ships with no plugins installed — you add only what you need from the [skill marketplace](https://github.com/TerrifiedBug/nanotars-skills).

After running `/nanotars-setup`, install plugins with:
1. `/plugin install nanotars-{name}@nanotars-skills`
2. Run the install skill: `/add-skill-{name}`

See the [marketplace README](https://github.com/TerrifiedBug/nanotars-skills) for the full list of 27 available plugins.

To remove a plugin: `/nanotars-remove-plugin`
To check for plugin updates: `/nanotars-update`
To sync local plugin improvements to marketplace: `/nanotars-update-skill`

## Getting Started

```bash
git clone https://github.com/TerrifiedBug/nanotars.git
cd nanotars
claude
```

Then run `/nanotars-setup`. Claude handles authentication, channel wiring, container build, and service configuration.

## Requirements

- macOS or Linux
- Node.js 20+
- pnpm 9+
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

## Uninstall

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanotars.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.nanotars.plist
rm -rf "${NANOTARS_DIR:-$HOME/nanotars}"

# Linux
systemctl --user disable --now nanotars 2>/dev/null
rm -f ~/.config/systemd/user/nanotars.service
systemctl --user daemon-reload
rm -rf "${NANOTARS_DIR:-$HOME/nanotars}"
```

## License

MIT
