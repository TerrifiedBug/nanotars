# Fork Divergences from Upstream

This document tracks all legitimate divergences between our fork's `main` branch and `upstream/main` (qwibitai/nanoclaw). It exists so future divergence checks can be done quickly without a full codebase scan.

**Branch strategy:**
- `main` = clean NanoClaw as if fresh install (divergence analysis compares this vs upstream)
- Personal deployments may have installed plugins that modify source (Dockerfile, gitignore, etc.)

**Last full audit:** 2026-02-15 (updated after brainstorm cleanup — Dockerfile.partial mechanism, calendar fix, systemd, gitignore cleanup)

## Divergence Categories

| Code | Description |
|------|-------------|
| PLUGIN | Plugin system (loader, hooks, skills, MCP merge, env vars) |
| DOCKER | Docker/Linux support (runtime abstraction, mount permissions, headless) |
| BUGFIX | Bug fixes not yet upstreamed |
| SECURITY | Security hardening (secret isolation, prompt injection, path blocking) |
| ~~ASSISTANT_NAME~~ | ~~Configurable assistant name~~ — **collapsed: merged via PR #235** |
| TASK | Scheduled task improvements (model selection, error notifications) |
| TELEGRAM | Telegram core channel plugin with swarm pool |
| MEDIA | Media download pipeline (image/video/audio/document) |
| OTHER | Minor improvements (read receipts, DRY refactors) |

## Source Code

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `src/index.ts` | Modified | PLUGIN, DOCKER, BUGFIX, TASK, TELEGRAM | Plugin lifecycle, per-group triggers, consecutive error tracking, message dedup, heartbeat typing, sender forwarding in IPC watcher |
| `src/config.ts` | Modified | TASK, PLUGIN | `SCHEDULED_TASK_IDLE_TIMEOUT`, `createTriggerPattern()` |
| `src/container-runner.ts` | Modified | PLUGIN, DOCKER, SECURITY, TASK, BUGFIX | Plugin mounts/hooks/MCP merge, runtime abstraction, env file quoting, OAuth sync |
| `src/container-runtime.ts` | **New** | DOCKER | Runtime abstraction (Docker vs Apple Container), orphan cleanup, mount permissions |
| `src/db.ts` | Modified | BUGFIX, TASK, PLUGIN | `>=` timestamp fix, `insertExternalMessage()`, `claimTask()`, model column, channel column (no backfill) |
| `src/ipc.ts` | Modified | TASK, TELEGRAM | Model field, `sender` param on `IpcDeps.sendMessage`, reads `data.sender` from IPC JSON |
| `src/plugin-loader.ts` | **New** | PLUGIN | Plugin discovery, manifest parsing, env var collection, MCP merging, hook lifecycle |
| `src/plugin-types.ts` | **New** | PLUGIN | TypeScript interfaces for plugin system (includes version fields) |
| `src/task-scheduler.ts` | Modified | TASK, BUGFIX | `claimTask()`, shorter idle timeout, model selection, error notifications |
| `src/types.ts` | Modified | MEDIA, TASK, PLUGIN, TELEGRAM | Media fields (`mediaType`, `mediaPath`, `mediaHostPath`), model, async `OnInboundMessage`, `sender` param on `Channel.sendMessage` |
| `src/router.ts` | Modified | TELEGRAM | `sender` param threaded through `routeOutbound()` |
| `src/channels/whatsapp.ts` | Modified | MEDIA, OTHER | Media download (returns `hostPath` for host-side plugin hooks), read receipts |

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
| `container/Dockerfile` | Modified | PLUGIN | Added `jq`, skills directory, env-dir sourcing in entrypoint; gogcli removed from base (moved to plugin Dockerfile.partial), COPY paths updated for project-root build context |
| `container/build.sh` | Modified | DOCKER | Auto-detects Docker vs Apple Container runtime; Dockerfile.partial merging from plugins, project-root build context |
| `container/agent-runner/src/index.ts` | Modified | PLUGIN, SECURITY, TASK | Plugin hook loading, secret scrubbing, model selection, error detection |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modified | BUGFIX, PLUGIN | Duplicate task creation warning, channel-agnostic tool descriptions |
| `container/agent-runner/src/security-hooks.ts` | **New** | SECURITY | Bash sanitization, `/proc/*/environ` blocking, `/tmp/input.json` blocking |
| `container/agent-runner/src/security-hooks.test.ts` | **New** | SECURITY | Tests for security hooks |
| `container/agent-runner/tsconfig.json` | Modified | OTHER | Exclude test files from production build |
| `container/agent-runner/package.json` | Modified | SECURITY | Added vitest for testing |
| `container/agent-runner/package-lock.json` | Modified | OTHER | Vitest dependency tree |

## Config / Docs

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `.dockerignore` | **New** | OTHER | Excludes non-build dirs from Docker context |
| `.gitignore` | Modified | PLUGIN, OTHER | `plugins/*` and `!plugins/.gitkeep`; channel plugins gitignored (templates-only); removed docs/plans/, added .mcp.json |
| `plugins/.gitkeep` | **New** | PLUGIN | Tracks empty plugins directory |
| `CLAUDE.md` | Modified | SECURITY | Added security section referencing `docs/SECURITY.md` |
| `groups/global/CLAUDE.md` | Modified | OTHER | References `$ASSISTANT_NAME` env var (upstream still hardcodes "Andy") |
| `groups/main/CLAUDE.md` | Modified | SECURITY, OTHER | Anti-prompt-injection rules, `$ASSISTANT_NAME` env var, generic example triggers |
| `docs/DIVERGENCES.md` | **New** | OTHER | This file — fork divergence tracking |
| `docs/PLUGINS.md` | Modified | PLUGIN | Added Dockerfile.partial documentation section |
| `docs/CHANNEL_PLUGINS.md` | Modified | PLUGIN | Templates-only architecture (no committed channel plugins), `sender` param docs, JID prefix standardisation |
| `package.json` | Modified | PLUGIN | Channel SDK deps removed (moved to per-plugin packages) |
| `package-lock.json` | Modified | OTHER | Platform-specific (Linux vs macOS optional deps) |
| `.mcp.json` | Untracked | OTHER | Gitignored — modified by skill installations |

## Skills (`.claude/skills/`)

### Modified from upstream (3)

| Skill | Categories | Summary |
|-------|------------|---------|
| `setup/SKILL.md` | DOCKER, PLUGIN, OTHER | Major divergence after upstream PR #258 rewrote setup as numbered shell scripts. Our fork keeps monolithic SKILL.md with channel-agnostic plugin flow, headless/Linux QR auth, systemd support, ASSISTANT_NAME env var step. Upstream scripts hardcode WhatsApp deps and auth. |
| `customize/SKILL.md` | PLUGIN, DOCKER | Plugin architecture docs, Linux service management |
| `add-whatsapp-voice/SKILL.md` | PLUGIN, MEDIA | Renamed from `add-voice-transcription`; rewritten for plugin architecture using `mediaHostPath` |

### New skills (20)

| Skill | Description |
|-------|-------------|
| `add-brave-search` | Brave Search API for web search |
| `add-cal` | Google Calendar + CalDAV (7 files incl. TypeScript client); rewritten for Dockerfile.partial architecture |
| `add-changedetection` | changedetection.io website monitoring |
| `add-claude-mem` | Persistent memory for agent containers |
| `add-commute` | Travel times via Waze API |
| `add-discord` | Add Discord as a channel plugin; per-plugin deps template, untracked non-core files |
| `add-norish` | Norish recipe import by URL |
| `create-plugin` | Meta-skill: guided plugin creation from idea to implementation |
| `add-freshrss` | Self-hosted RSS feed reader |
| `add-github` | GitHub API access |
| `add-homeassistant` | Home Assistant via MCP Server |
| `add-imap-read` | Read-only IMAP email access |
| `add-n8n` | n8n workflow automation |
| `add-notion` | Notion API access |
| `add-trains` | UK National Rail departure data |
| `add-weather` | Weather via wttr.in / Open-Meteo |
| `add-webhook` | HTTP webhook endpoint for push events |
| `add-whatsapp` | Add WhatsApp as a channel plugin |
| `channels/telegram` | Telegram channel auth, setup, and troubleshooting reference |
| `set-model` | Change Claude model for containers |
| `update-nanoclaw` | Upstream sync management |

### Unchanged from upstream (0)

None -- all upstream skills have been rewritten or removed.

### Rewritten for plugin architecture (4)

| Skill | Categories | Summary |
|-------|------------|---------|
| `add-gmail` | PLUGIN | Rewritten from inline source-modification to plugin template pattern (plugin.json + mcp.json + container-skills, GCP OAuth auth, `containerMounts` for credentials) |
| `add-parallel` | PLUGIN | Rewritten from inline source-modification to plugin template pattern (plugin.json + mcp.json + container-skills, HTTP MCP servers with API key) |
| `add-telegram` | TELEGRAM, PLUGIN | Rewritten from inline implementation to install-and-auth pattern (copies plugin from skill templates, points to channel docs) |
| `add-telegram-swarm` | TELEGRAM, PLUGIN | Rewritten from code-modification to config-only (set env var, add CLAUDE.md instructions, restart) |

### Superseded by our architecture (1)

| Skill | Why |
|-------|-----|
| `debug` | Upstream version is WhatsApp-specific; ours is channel-agnostic |

### Removed from upstream (2)

| Skill | Why |
|-------|-----|
| `convert-to-docker` | Deleted -- Docker support is baked into `container-runtime.ts` and auto-detected by setup; no conversion needed |
| `x-integration` | Deleted -- niche Playwright-based Twitter automation; write-only, no read capability, not needed |

## Not in Fork (upstream-only, intentionally excluded)

None — all upstream files are now synced.

*Previously excluded: `repo-tokens/`, `update-tokens.yml`, `.github/workflows/test.yml` — all synced as of 2026-02-15.*

## Pending Upstream Changes

### Our PRs (submitted 2026-02-15)

| PR | Title | Type | Files | Status |
|----|-------|------|-------|--------|
| [#245](https://github.com/qwibitai/nanoclaw/pull/245) | `>=` timestamp fix + dedup guard | Fix | `src/db.ts`, `src/index.ts` | Open |
| [#246](https://github.com/qwibitai/nanoclaw/pull/246) | Exclude test files from agent-runner build | Simplification | `container/agent-runner/tsconfig.json` | Open |
| [#247](https://github.com/qwibitai/nanoclaw/pull/247) | Consecutive error tracking | Fix | `src/index.ts` | Open |
| [#248](https://github.com/qwibitai/nanoclaw/pull/248) | Duplicate task prevention guidance | Fix | `container/agent-runner/src/ipc-mcp-stdio.ts` | Open |

When these merge and we sync, the following divergences collapse:

| PR | Divergences Resolved |
|----|---------------------|
| #245 | `src/db.ts` `>=` fix (BUGFIX), `src/index.ts` message dedup (BUGFIX) |
| #246 | `container/agent-runner/tsconfig.json` (OTHER) |
| #247 | `src/index.ts` consecutive error tracking (BUGFIX) |
| #248 | `container/agent-runner/src/ipc-mcp-stdio.ts` task warning (BUGFIX) |

### Upstream PR #258 — **merged, not synced** (2026-02-15)

[qwibitai/nanoclaw#258](https://github.com/qwibitai/nanoclaw/pull/258) — `feat: add setup skill with scripted steps`

Replaces monolithic `setup/SKILL.md` with numbered shell scripts (`01-check-environment.sh` through `09-verify.sh`) with structured status output. Also touches `package.json`, `package-lock.json`, and `src/router.ts`.

**Cannot sync because:** Scripts hardcode WhatsApp (`@whiskeysockets/baileys` dep checks, `04-auth-whatsapp.sh`). Our channel-agnostic plugin architecture handles auth, deps, and registration per-channel-plugin. The scripted pattern (structured output parsing) is worth adopting long-term but requires rewriting all scripts for our architecture.

**Impact:** `setup/SKILL.md` is now a major divergence. `package.json` and `src/router.ts` changes need individual review on next upstream sync.

### Upstream PR #235 — **merged and synced** (2026-02-15)

[qwibitai/nanoclaw#235](https://github.com/qwibitai/nanoclaw/pull/235) — `feat: add is_bot_message column and support dedicated phone numbers`

Collapsed divergences: `src/env.ts`, `src/db.ts` is_bot_message, `src/config.ts` ASSISTANT_HAS_OWN_NUMBER, `src/router.ts` prefix logic, `src/ipc.ts` prefix logic, `src/channels/whatsapp.ts` bot detection + prefix + queue flush, `src/types.ts` is_bot_message. The entire ASSISTANT_NAME category is now upstream.

### After all pending PRs merge

**What remains ours:** PLUGIN, DOCKER, MEDIA, TELEGRAM, TASK (model selection, error notifications), SECURITY (hooks), and fork-only BUGFIX items (env file quoting — only exists in our env mount code).

### Assessed but not PR-able

| Divergence | Why Not |
|------------|---------|
| Plugin system | Feature — upstream uses skills-only architecture |
| Docker runtime abstraction | Feature — upstream uses Apple Container only; we abstract both via `container-runtime.ts` |
| Media download pipeline + `mediaHostPath` | Capability — enables host-side plugin hooks (e.g., voice transcription) |
| Task model selection | Enhancement |
| Task error notifications | Enhancement |
| Heartbeat typing indicator | Enhancement |
| Read receipts | Enhancement |
| Security hooks (`security-hooks.ts`) | New capability (complementary to upstream's trust model) |
| Telegram core channel plugin | Feature — upstream has no Telegram support; includes swarm bot pool |
| `sender` threading (`types.ts`, `router.ts`, `ipc.ts`, `index.ts`) | Enables channel-level sender routing (swarm pool, future per-sender features) |
| Env file quoting | Only applies to our fork's env mount mechanism |
| Setup skill (scripted steps) | Upstream PR #258 hardcodes WhatsApp; our plugin architecture needs channel-agnostic scripts |
| Per-group webhook routing | Enhancement — upstream uses single global webhook secret |
