# Fork Divergences from Upstream

This document tracks all divergences between our fork's `main` branch and `upstream/main` (gavrielc/nanoclaw). Upstream's [CONTRIBUTING.md](https://github.com/gavrielc/nanoclaw/blob/main/CONTRIBUTING.md) accepts: **bug fixes, security fixes, simplifications**. Features/capabilities should be skills.

**Last full audit:** 2026-02-15

## Divergence Categories

| Code | Description |
|------|-------------|
| PLUGIN | Plugin system (loader, hooks, skills, MCP merge, env vars) |
| DOCKER | Docker/Linux support (runtime abstraction, mount permissions) |
| BUGFIX | Bug fixes (PR-able per upstream guidelines) |
| SECURITY | Security hardening (PR-able as "security fixes") |
| TASK | Scheduled task improvements (model selection, error notifications) |
| MEDIA | Media download pipeline (image/video/audio/document) |
| OTHER | Minor improvements (read receipts, typing indicator, DRY refactors) |

## Source Code

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `src/index.ts` | Modified | PLUGIN, DOCKER, BUGFIX, TASK, OTHER | Plugin lifecycle, per-group triggers, consecutive error tracking, message dedup, heartbeat typing |
| `src/config.ts` | Modified | TASK, PLUGIN | `SCHEDULED_TASK_IDLE_TIMEOUT`, `createTriggerPattern()` |
| `src/container-runner.ts` | Modified | PLUGIN, DOCKER, SECURITY, TASK, BUGFIX | Plugin mounts/hooks/MCP merge, runtime abstraction, env file quoting, OAuth sync, recursive skill copy |
| `src/container-runtime.ts` | **New** | DOCKER | Runtime abstraction (Docker vs Apple Container), orphan cleanup, mount permissions |
| `src/db.ts` | Modified | BUGFIX, TASK, PLUGIN | `>=` timestamp fix, `insertExternalMessage()`, `claimTask()`, model column |
| `src/ipc.ts` | Modified | TASK | Model field |
| `src/plugin-loader.ts` | **New** | PLUGIN | Plugin discovery, manifest parsing, env var collection, MCP merging, hook lifecycle |
| `src/plugin-types.ts` | **New** | PLUGIN | TypeScript interfaces for plugin system |
| `src/task-scheduler.ts` | Modified | TASK, BUGFIX | `claimTask()`, shorter idle timeout, model selection, error notifications, `<internal>` stripping |
| `src/types.ts` | Modified | MEDIA, TASK, PLUGIN | Media fields, model, async `OnInboundMessage` |
| `src/channels/whatsapp.ts` | Modified | MEDIA, BUGFIX, OTHER | Media download, presence update fix, read receipts |

## Tests

| File | Status | Categories |
|------|--------|------------|
| `src/channels/whatsapp.test.ts` | Modified | MEDIA |
| `src/db.test.ts` | Modified | BUGFIX |
| `src/formatting.test.ts` | Modified | PLUGIN |
| `src/plugin-loader.test.ts` | **New** | PLUGIN |

## Container / Agent Runner

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `container/Dockerfile` | Modified | PLUGIN | Added `jq`, skills directory, env-dir sourcing in entrypoint |
| `container/build.sh` | Modified | DOCKER | Auto-detects Docker vs Apple Container runtime |
| `container/agent-runner/src/index.ts` | Modified | PLUGIN, SECURITY, TASK, BUGFIX | Plugin hooks, secret scrubbing, model selection, SDK error detection, hardcoded name fix |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modified | BUGFIX, TASK | Duplicate task warning, model parameter |
| `container/agent-runner/src/security-hooks.ts` | **New** | SECURITY | Bash sanitization, `/proc/*/environ` blocking, `/tmp/input.json` blocking |
| `container/agent-runner/src/security-hooks.test.ts` | **New** | SECURITY | Tests for security hooks |
| `container/agent-runner/tsconfig.json` | Modified | BUGFIX | Exclude test files from production build |
| `container/agent-runner/package.json` | Modified | SECURITY | Added vitest for testing |
| `container/agent-runner/package-lock.json` | Modified | OTHER | Vitest dependency tree |

## Config / Docs

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `.gitignore` | Modified | PLUGIN, DOCKER | `plugins/*`, `!plugins/.gitkeep`, `socket:*` |
| `plugins/.gitkeep` | **New** | PLUGIN | Tracks empty plugins directory |
| `CLAUDE.md` | Modified | SECURITY | Added security section referencing `docs/SECURITY.md` |
| `groups/global/CLAUDE.md` | Modified | BUGFIX | `$ASSISTANT_NAME` env var (upstream hardcodes "Andy" despite PR #235 making it configurable) |
| `groups/main/CLAUDE.md` | Modified | SECURITY, BUGFIX | Anti-prompt-injection rules, `$ASSISTANT_NAME`, generic example triggers |
| `docs/DIVERGENCES.md` | **New** | OTHER | This file |
| `docs/PLUGINS.md` | **New** | PLUGIN | Plugin system architecture, hook lifecycle, security model, source code changes |
| `package-lock.json` | Modified | OTHER | Platform-specific (Linux vs macOS optional deps) |

## Skills (`.claude/skills/`)

### Modified from upstream (3)

| Skill | Categories | Summary |
|-------|------------|---------|
| `setup/SKILL.md` | DOCKER, OTHER | Headless/Linux QR auth support, timezone configuration step |
| `customize/SKILL.md` | PLUGIN, DOCKER | Plugin architecture docs, Linux service management |
| `add-voice-transcription/SKILL.md` | PLUGIN | Rewritten for plugin architecture (no core mods) |

### New skills (16)

| Skill | Description |
|-------|-------------|
| `add-brave-search` | Brave Search API for web search |
| `add-cal` | Google Calendar + CalDAV (7 files incl. TypeScript client) |
| `add-changedetection` | changedetection.io website monitoring |
| `add-claude-mem` | Persistent memory for agent containers |
| `add-commute` | Travel times via Waze API |
| `add-freshrss` | Self-hosted RSS feed reader |
| `add-github` | GitHub API access |
| `add-homeassistant` | Home Assistant via MCP Server |
| `add-imap-read` | Read-only IMAP email access |
| `add-n8n` | n8n workflow automation |
| `add-notion` | Notion API access |
| `add-trains` | UK National Rail departure data |
| `add-weather` | Weather via wttr.in / Open-Meteo |
| `add-webhook` | HTTP webhook endpoint for push events |
| `set-model` | Change Claude model for containers |
| `update-nanoclaw` | Upstream sync management |

### Unchanged from upstream (7)

`add-gmail`, `add-parallel`, `add-telegram-swarm`, `add-telegram`, `convert-to-docker`, `debug`, `x-integration`

---

## Upstream PRs

### Open PRs

| PR | Title | Type | Status |
|----|-------|------|--------|
| [#234](https://github.com/qwibitai/nanoclaw/pull/234) | Docker runtime support alongside Apple Container | Refactor | Open |
| [#245](https://github.com/qwibitai/nanoclaw/pull/245) | `>=` timestamp fix + dedup guard | Bug fix | Open |
| [#246](https://github.com/qwibitai/nanoclaw/pull/246) | Exclude test files from agent-runner build | Simplification | Open |
| [#247](https://github.com/qwibitai/nanoclaw/pull/247) | Consecutive error tracking | Bug fix | Open |
| [#248](https://github.com/qwibitai/nanoclaw/pull/248) | Duplicate task prevention guidance | Bug fix | Open |

### Merged PRs

| PR | Title | Merged |
|----|-------|--------|
| [#235](https://github.com/qwibitai/nanoclaw/pull/235) | `is_bot_message` + dedicated phone numbers | 2026-02-15 |

### When open PRs merge, these divergences collapse:

| PR | Resolved |
|----|----------|
| #234 | `src/container-runtime.ts` (new file), `src/container-runner.ts` runtime calls, `container/build.sh` runtime detection |
| #245 | `src/db.ts` `>=` fix, `src/index.ts` message dedup |
| #246 | `container/agent-runner/tsconfig.json` test exclusion |
| #247 | `src/index.ts` consecutive error tracking |
| #248 | `container/agent-runner/src/ipc-mcp-stdio.ts` task warning |

### Candidates for new PRs (bug fixes per CONTRIBUTING.md)

| Fix | Files | Bug |
|-----|-------|-----|
| `claimTask()` race condition | `src/db.ts`, `src/task-scheduler.ts` | Scheduler re-enqueues tasks while container still running |
| Error status before result check | `src/index.ts`, `src/task-scheduler.ts` | Error status ignored when result text exists |
| SDK `is_error` flag detection | `container/agent-runner/src/index.ts` | Agent-runner treats SDK errors as successes |
| `<internal>` tag stripping in tasks | `src/task-scheduler.ts` | Internal reasoning leaks to users in scheduled task output |
| Hardcoded 'Andy' in transcript format | `container/agent-runner/src/index.ts` | Doesn't respect configurable name (PR #235 follow-up) |
| Recursive skill directory copy | `src/container-runner.ts` | Flat copy breaks nested skill dirs (e.g. add-cal with src/) |
| Timeout after successful response | `src/task-scheduler.ts` | Reports false failure when agent sent output but timed out closing |
| `$ASSISTANT_NAME` in CLAUDE.md templates | `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md` | PR #235 made name configurable but templates still say "Andy" |
| Presence update ordering | `src/channels/whatsapp.ts` | Fires before LID mapping, errors silently swallowed |

### Candidates for security PRs (accepted per CONTRIBUTING.md)

| Fix | Files | Risk |
|-----|-------|------|
| Secret env scrubbing | `container/agent-runner/src/index.ts` | API keys readable via `process.env` inside agent |
| `/proc/*/environ` read blocking | `container/agent-runner/src/security-hooks.ts` | Agent can read all env vars via proc filesystem |
| `/tmp/input.json` read blocking | `container/agent-runner/src/security-hooks.ts` | Agent can read its own input containing secrets |
| Anti-prompt-injection rules | `groups/main/CLAUDE.md` | External data (emails, webhooks, RSS) could hijack agent |
| Env file shell injection quoting | `src/container-runner.ts` | `#` truncates, `$()` executes in env values |

### Not PR-able (features per CONTRIBUTING.md)

| Divergence | Reason |
|------------|--------|
| Plugin system (loader, types, hooks, MCP merge) | Feature — upstream uses skills-only architecture |
| Media download pipeline | Capability — could become a skill |
| Per-task model selection | Enhancement |
| Per-group custom triggers | Enhancement |
| Heartbeat typing indicator | Enhancement |
| Read receipts | Enhancement |
| Shorter scheduled task idle timeout | Enhancement |
| 16 new skills | Skills are welcome as PRs but these are personal/niche |
