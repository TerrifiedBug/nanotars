# Fork Divergences from Upstream

This document tracks all legitimate divergences between our fork's `main` branch and `upstream/main` (gavrielc/nanoclaw). It exists so future divergence checks can be done quickly without a full codebase scan.

**Branch strategy:**
- `main` = clean NanoClaw as if fresh install (divergence analysis compares this vs upstream)
- `tars` = personal branch with installed plugins that may modify source (Dockerfile, gitignore, etc.)

**Last full audit:** 2026-02-15

## Divergence Categories

| Code | Description |
|------|-------------|
| PLUGIN | Plugin system (loader, hooks, skills, MCP merge, env vars) |
| DOCKER | Docker/Linux support (runtime abstraction, mount permissions, headless) |
| BUGFIX | Bug fixes not yet upstreamed |
| SECURITY | Security hardening (secret isolation, prompt injection, path blocking) |
| ASSISTANT_NAME | Configurable assistant name via `$ASSISTANT_NAME` env var (**pending upstream: PR #235**) |
| TASK | Scheduled task improvements (model selection, error notifications) |
| MEDIA | Media download pipeline (image/video/audio/document) |
| OTHER | Minor improvements (read receipts, DRY refactors) |

## Source Code

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `src/index.ts` | Modified | PLUGIN, DOCKER, BUGFIX, ASSISTANT_NAME, TASK | Plugin lifecycle, per-group triggers, consecutive error tracking, message dedup, heartbeat typing |
| `src/config.ts` | Modified | ASSISTANT_NAME, TASK, PLUGIN | `.env` reading, `ASSISTANT_HAS_OWN_NUMBER`, `SCHEDULED_TASK_IDLE_TIMEOUT`, `createTriggerPattern()` |
| `src/container-runner.ts` | Modified | PLUGIN, DOCKER, SECURITY, TASK, BUGFIX | Plugin mounts/hooks/MCP merge, runtime abstraction, env file quoting, OAuth sync |
| `src/container-runtime.ts` | **New** | DOCKER | Runtime abstraction (Docker vs Apple Container), orphan cleanup, mount permissions |
| `src/db.ts` | Modified | BUGFIX, TASK, PLUGIN | `is_bot_message` flag, `>=` timestamp fix, `insertExternalMessage()`, `claimTask()`, model column |
| `src/env.ts` | **New** | SECURITY | `.env` reader that never pollutes `process.env` |
| `src/ipc.ts` | Modified | ASSISTANT_NAME, TASK | Removed manual prefix, added model field |
| `src/plugin-loader.ts` | **New** | PLUGIN | Plugin discovery, manifest parsing, env var collection, MCP merging, hook lifecycle |
| `src/plugin-types.ts` | **New** | PLUGIN | TypeScript interfaces for plugin system |
| `src/router.ts` | Modified | ASSISTANT_NAME | Removed channel arg and prefix logic (moved to channel layer) |
| `src/task-scheduler.ts` | Modified | TASK, BUGFIX | `claimTask()`, shorter idle timeout, model selection, error notifications |
| `src/types.ts` | Modified | MEDIA, ASSISTANT_NAME, TASK, BUGFIX, PLUGIN | `is_bot_message`, media fields, model, async `OnInboundMessage` |
| `src/channels/whatsapp.ts` | Modified | MEDIA, ASSISTANT_NAME, BUGFIX, OTHER | Media download, centralized prefix, bot detection, read receipts, queue flush fix |

## Tests

| File | Status | Categories |
|------|--------|------------|
| `src/channels/whatsapp.test.ts` | Modified | ASSISTANT_NAME, MEDIA, BUGFIX |
| `src/db.test.ts` | Modified | BUGFIX |
| `src/formatting.test.ts` | Modified | ASSISTANT_NAME, PLUGIN |
| `src/plugin-loader.test.ts` | **New** | PLUGIN |

## Container / Agent Runner

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `container/Dockerfile` | Modified | PLUGIN | Added `jq`, skills directory, env-dir sourcing in entrypoint |
| `container/build.sh` | Modified | DOCKER | Auto-detects Docker vs Apple Container runtime |
| `container/agent-runner/src/index.ts` | Modified | PLUGIN, SECURITY, TASK | Plugin hook loading, secret scrubbing, model selection, error detection |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modified | BUGFIX | Duplicate task creation warning |
| `container/agent-runner/src/security-hooks.ts` | **New** | SECURITY | Bash sanitization, `/proc/*/environ` blocking, `/tmp/input.json` blocking |
| `container/agent-runner/src/security-hooks.test.ts` | **New** | SECURITY | Tests for security hooks |
| `container/agent-runner/tsconfig.json` | Modified | OTHER | Exclude test files from production build |
| `container/agent-runner/package.json` | Modified | SECURITY | Added vitest for testing |
| `container/agent-runner/package-lock.json` | Modified | OTHER | Vitest dependency tree |

## Config / Docs

| File | Status | Categories | Summary |
|------|--------|------------|---------|
| `.gitignore` | Modified | PLUGIN | `plugins/*` and `!plugins/.gitkeep` |
| `plugins/.gitkeep` | **New** | PLUGIN | Tracks empty plugins directory |
| `CLAUDE.md` | Modified | SECURITY | Added security section referencing `docs/SECURITY.md` |
| `README.md` | **In sync** | — | Synced after upstream added repo-tokens badge |
| `groups/global/CLAUDE.md` | Modified | ASSISTANT_NAME | `Andy` -> `$ASSISTANT_NAME` env var |
| `groups/main/CLAUDE.md` | Modified | ASSISTANT_NAME, SECURITY | `$ASSISTANT_NAME` + anti-prompt-injection security rules |
| `docs/DIVERGENCES.md` | **New** | OTHER | This file — fork divergence tracking |
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

### Unchanged from upstream (6)

`add-gmail`, `add-parallel`, `add-telegram-swarm`, `add-telegram`, `convert-to-docker`, `debug`, `x-integration`

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

### Upstream PR #235 (testing for maintainer)

[qwibitai/nanoclaw#235](https://github.com/qwibitai/nanoclaw/pull/235) — `feat: add is_bot_message column and support dedicated phone numbers`

When this merges and we sync, the following divergences collapse:

| Current Divergence | Why It Collapses |
|--------------------|------------------|
| `src/env.ts` (SECURITY) | PR adds upstream `.env` reader (uses `dotenv`) |
| `src/db.ts` `is_bot_message` (BUGFIX) | PR adds same column + migration |
| `src/config.ts` `ASSISTANT_HAS_OWN_NUMBER` (ASSISTANT_NAME) | PR adds this env var upstream |
| `src/router.ts` prefix removal (ASSISTANT_NAME) | PR moves prefix to WhatsApp channel |
| `src/ipc.ts` prefix removal (ASSISTANT_NAME) | PR removes manual prefix upstream |
| `src/channels/whatsapp.ts` bot detection (BUGFIX) | PR adds bot detection via `is_bot_message` |
| `src/channels/whatsapp.ts` prefix + queue flush (ASSISTANT_NAME, BUGFIX) | PR centralizes prefix in channel + fixes flush |
| `src/types.ts` `is_bot_message` (BUGFIX) | PR adds this field upstream |
| `groups/global/CLAUDE.md` name (ASSISTANT_NAME) | PR makes name configurable |

### After all pending PRs merge

**What remains ours:** PLUGIN, DOCKER, MEDIA, TASK (model selection, error notifications), SECURITY (hooks), and fork-only BUGFIX items (env file quoting — only exists in our env mount code).

### Assessed but not PR-able

| Divergence | Why Not |
|------------|---------|
| Plugin system | Feature — upstream uses skills-only architecture |
| Docker runtime abstraction | Compatibility — `convert-to-docker` skill exists upstream |
| Media download pipeline | Capability — could become a skill |
| Task model selection | Enhancement |
| Task error notifications | Enhancement |
| Heartbeat typing indicator | Enhancement |
| Read receipts | Enhancement |
| Security hooks (`security-hooks.ts`) | New capability (complementary to upstream's trust model) |
| Env file quoting | Only applies to our fork's env mount mechanism |
| Queue flush fix | Already part of PR #235 (authored by maintainer) |
