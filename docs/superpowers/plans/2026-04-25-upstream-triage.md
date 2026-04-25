# nanotars (v1-archive) ↔ nanoclaw v2 — Upstream Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a working triage document at `/data/nanotars/docs/upstream-triage-2026-04-25.md` that classifies every meaningful difference between v1-archive and upstream/main into PORT/KEEP/ADOPT/SKIP-ARCH/CONTRIBUTE buckets with effort/confidence/dependencies, plus six per-area appendix reports.

**Architecture:** Six parallel subagents perform structural code review across coherent slices of the codebase. Each produces a uniform per-area report at a fixed path. The orchestrator (you) then performs a synthesis pass into the master document and a spot-check verification pass.

**Tech Stack:** Bash + Agent tool + Read + Write + git on the `v1-archive` branch of `/data/nanotars/`. No code execution beyond agents.

**Spec:** `/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md` — read it first if you need the full method, verdict definitions, or acceptance criteria.

---

## File Structure

**Per-area appendix reports** (one per agent, each agent writes its own):
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25-area-1-persistence.md`
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25-area-2-migrations-permissions.md`
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25-area-3-runtime-lifecycle.md`
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25-area-4-channels-media.md`
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25-area-5-extensions-agents.md`
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25-area-6-security-ipc-build.md`

**Master synthesis doc** (orchestrator writes):
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25.md`

All paths absolute. All committed to `v1-archive` at the end.

---

## Task 1: Pre-flight verification

**Files:**
- Read-only checks; no edits

- [ ] **Step 1: Verify nanotars is on v1-archive with clean tree**

Run: `cd /data/nanotars && git status --short --branch`
Expected: `## v1-archive...origin/v1-archive` with **no other lines**. If working tree dirty, abort and report to user — don't proceed with mixed state.

- [ ] **Step 2: Verify both source trees exist and are readable**

Run:
```bash
test -f /data/nanotars/src/index.ts && echo "v1 ok"
test -f /data/nanoclaw-v2/src/index.ts && echo "v2 ok"
```
Expected: both lines printed.

- [ ] **Step 3: Verify spec is committed and readable**

Run: `cd /data/nanotars && git log --oneline -1 docs/superpowers/specs/2026-04-25-upstream-triage-design.md`
Expected: one line showing the spec commit.

- [ ] **Step 4: Confirm no per-area reports already exist (idempotency check)**

Run: `ls /data/nanotars/docs/upstream-triage-2026-04-25-area-*.md 2>/dev/null | wc -l`
Expected: `0`. If non-zero, ask user before proceeding (would overwrite prior reports).

---

## Task 2: Dispatch all six agents in parallel

**Files:**
- Each agent writes its own per-area appendix file (paths above).
- This task is a single message with six parallel Agent tool calls.

- [ ] **Step 1: Dispatch all six agents in one message**

Use a single message with six Agent tool calls. Each prompt below is **self-contained** — agents start fresh with no context from this conversation. All six prompts share the same skeleton:

```
You are doing a structural code review of <area name> across two codebases.
Source A (nanotars v1 fork, customized): /data/nanotars (currently on v1-archive branch)
Source B (upstream NanoClaw v2): /data/nanoclaw-v2

Read the design spec first to understand the verdict definitions and required output format:
/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md

Your assigned area: <area name and scope from spec>
Files to read on side A: <list>
Files to read on side B: <list>

Your output is one markdown file at the path:
/data/nanotars/docs/upstream-triage-2026-04-25-area-<N>-<slug>.md

Format: follow the per-area report format from the spec exactly:
1. Functional inventory (v1 + v2)
2. Implementation comparison (per-functionality side-by-side, with verdict)
3. Verdict matrix (Item | Action | Effort | Confidence | Depends on | Notes)
4. What surprised me (1-3 unexpected findings)
5. Cross-cutting concerns (dependencies on other areas)
6. Open questions (low-confidence verdicts needing human review)

Hard requirements:
- file:line citations on every behavior claim
- Use git log -p ONLY when comparison is ambiguous, never as routine
- Verdict types are PORT / KEEP / ADOPT / SKIP-ARCH / CONTRIBUTE — see spec for definitions
- Effort buckets: trivial / small / medium / large
- Confidence: high / medium / low
- Length 3500-5000 words
- Reference cross-area items by their area number (e.g. "depends on Area 3 item: container-runner concurrency model")

When done, confirm with file path and a one-line summary of how many items in each verdict bucket.
```

The six concrete agent prompts follow. Use `subagent_type: "general-purpose"` for all six.

#### Agent 1 — Persistence layer

**Description:** Triage area 1 — persistence layer

**Prompt:**

```
You are doing a structural code review of the PERSISTENCE LAYER across two codebases for a nanotars-fork upstream-triage exercise.

Source A (nanotars v1 fork, customized): /data/nanotars (currently on v1-archive branch)
Source B (upstream NanoClaw v2): /data/nanoclaw-v2

Read the design spec first:
/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md

Your scope: DB schemas, accessors, queries — central DB on each side and per-session DBs on v2. State persistence helpers (kv state, snapshots, session state). Row-shapes and column-level differences matter.

Files to read on side A (v1):
- /data/nanotars/src/db.ts (re-export barrel)
- /data/nanotars/src/db/index.ts
- /data/nanotars/src/db/init.ts (schemas)
- /data/nanotars/src/db/messages.ts
- /data/nanotars/src/db/state.ts
- /data/nanotars/src/db/tasks.ts
- /data/nanotars/src/snapshots.ts
- /data/nanotars/src/types.ts (look for RegisteredGroup, ScheduledTask, etc.)

Files to read on side B (v2):
- /data/nanoclaw-v2/src/db/connection.ts
- /data/nanoclaw-v2/src/db/schema.ts
- /data/nanoclaw-v2/src/db/agent-groups.ts
- /data/nanoclaw-v2/src/db/messaging-groups.ts
- /data/nanoclaw-v2/src/db/sessions.ts
- /data/nanoclaw-v2/src/db/session-db.ts
- /data/nanoclaw-v2/src/db/dropped-messages.ts
- /data/nanoclaw-v2/src/state-sqlite.ts
- /data/nanoclaw-v2/container/agent-runner/src/db/connection.ts
- /data/nanoclaw-v2/container/agent-runner/src/db/messages-in.ts
- /data/nanoclaw-v2/container/agent-runner/src/db/messages-out.ts
- /data/nanoclaw-v2/container/agent-runner/src/db/session-routing.ts
- /data/nanoclaw-v2/container/agent-runner/src/db/session-state.ts

Output: /data/nanotars/docs/upstream-triage-2026-04-25-area-1-persistence.md

Per-area report format (from the spec — follow exactly):
1. Functional inventory (v1 + v2 — 2-4 sentences each side, key files with line refs, design choices)
2. Implementation comparison (per shared functionality: name / v1 approach with file:line / v2 approach with file:line / verdict)
3. Verdict matrix (markdown table: Item | Action | Effort | Confidence | Depends on | Notes)
4. What surprised me (1-3 unexpected findings)
5. Cross-cutting concerns (items in this area that touch other areas — be specific about the dependency)
6. Open questions (verdicts you're not confident about, with the specific question for human review)

Hard requirements:
- file:line citations on every claim about behavior
- Use git log -p ONLY when comparison is ambiguous; not routinely
- Verdict types PORT/KEEP/ADOPT/SKIP-ARCH/CONTRIBUTE per spec definitions
- Effort: trivial / small / medium / large
- Confidence: high / medium / low
- Length 3500-5000 words
- Reference cross-area items by area number (e.g. "depends on Area 3 item: per-session container model")

Areas to coordinate with (cross-references): Area 2 covers migrations + permissions tables; if you find permissions-table operations, flag for Area 2. Area 3 covers session lifecycle which heavily uses session DBs.

When done, confirm with file path and one-line summary: counts per verdict bucket.
```

#### Agent 2 — Migrations, permissions, approvals

**Description:** Triage area 2 — migrations, permissions, approvals

**Prompt:**

```
You are doing a structural code review of MIGRATIONS, PERMISSIONS, AND APPROVALS across two codebases for a nanotars-fork upstream-triage exercise.

Source A (nanotars v1 fork, customized): /data/nanotars (v1-archive branch)
Source B (upstream NanoClaw v2): /data/nanoclaw-v2

Read the spec first:
/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md

Your scope:
- Migration framework (v1: one-shot JSON-to-SQLite migration; v2: versioned migrations with `schema_version` table and numbered files)
- Permissions model (v1: implicit via "main group" privilege; v2: `user_roles` + `agent_group_members` + `user_dms` tables, owner/admin/member resolution)
- Approvals state (v2-only): `pending_approvals`, `pending_channel_approvals`, `pending_sender_approvals`, `pending_questions`, `unregistered_senders`
- Approvals primitive code (v2-only): the request/respond flow, OneCLI manual-approval bridge

Files to read on side A (v1):
- /data/nanotars/src/db/migrate.ts (the one-shot)
- /data/nanotars/src/ipc/auth.ts (look for any role/privilege resolution)
- /data/nanotars/src/types.ts (RegisteredGroup, etc.)
- /data/nanotars/docs/SECURITY.md (read for design intent on the main-group privilege model)

Files to read on side B (v2):
- /data/nanoclaw-v2/src/db/migrations/index.ts (entry point)
- /data/nanoclaw-v2/src/db/migrations/*.ts (every numbered + named migration)
- /data/nanoclaw-v2/src/modules/permissions/access.ts
- /data/nanoclaw-v2/src/modules/permissions/user-dm.ts
- /data/nanoclaw-v2/src/modules/permissions/channel-approval.ts
- /data/nanoclaw-v2/src/modules/permissions/sender-approval.ts
- /data/nanoclaw-v2/src/modules/permissions/db/users.ts
- /data/nanoclaw-v2/src/modules/permissions/db/user-roles.ts
- /data/nanoclaw-v2/src/modules/permissions/db/user-dms.ts
- /data/nanoclaw-v2/src/modules/permissions/db/agent-group-members.ts
- /data/nanoclaw-v2/src/modules/permissions/db/pending-channel-approvals.ts
- /data/nanoclaw-v2/src/modules/permissions/db/pending-sender-approvals.ts
- /data/nanoclaw-v2/src/modules/approvals/primitive.ts
- /data/nanoclaw-v2/src/modules/approvals/onecli-approvals.ts
- /data/nanoclaw-v2/src/modules/approvals/response-handler.ts
- /data/nanoclaw-v2/src/modules/approvals/index.ts

Output: /data/nanotars/docs/upstream-triage-2026-04-25-area-2-migrations-permissions.md

Format and hard requirements: identical to Agent 1's prompt — see the spec.

Note: nanotars is single-user (Danny, solo). Many v2 multi-user permissions concepts may be SKIP-ARCH unless they map cleanly to v1's main-group model. Be opinionated: a "more rigorous permissions model" isn't worth porting if it adds complexity without solving a real problem for a single-user fork.

Cross-references: Area 1 covers other DB tables. If you find migrations that touch tables outside permissions/approvals, flag for Area 1. Area 6 covers OneCLI integration overall — your scope is the *approvals bridge*, not the credential injection.

When done, confirm with file path and counts per verdict bucket.
```

#### Agent 3 — Runtime, lifecycle, scheduling

**Description:** Triage area 3 — runtime, lifecycle, scheduling

**Prompt:**

```
You are doing a structural code review of RUNTIME, LIFECYCLE, AND SCHEDULING across two codebases for a nanotars-fork upstream-triage exercise.

Source A (nanotars v1 fork, customized): /data/nanotars (v1-archive branch)
Source B (upstream NanoClaw v2): /data/nanoclaw-v2

Read the spec first:
/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md

Your scope:
- Container runner (spawn, mounts, env-file injection, signal forwarding)
- Container runtime abstraction (Docker / Apple Container)
- Container hardening (cap-drop, no-new-privileges, resource limits, UID 1000)
- Concurrency model (v1: per-group queue + global MAX_CONCURRENT_CONTAINERS; v2: per-session container with no host-wide cap)
- Idle timeout / retry / lifecycle / signal handling (tini)
- Pause/resume (v2's lifecycle module vs v1's emergency-stop)
- Self-modification (v2-only: install_packages / add_mcp_server)
- Provider abstraction (v2-only: Codex / OpenCode / Ollama agent providers)
- Scheduled tasks (storage shape, cron parser, task-script hook on v2, error notification, per-task model, recurrence handling, atomic claim, idle preemption)

Files to read on side A (v1):
- /data/nanotars/src/container-runner.ts
- /data/nanotars/src/container-runtime.ts
- /data/nanotars/src/container-mounts.ts
- /data/nanotars/src/group-queue.ts
- /data/nanotars/src/task-scheduler.ts
- /data/nanotars/src/orchestrator.ts
- /data/nanotars/container/Dockerfile
- /data/nanotars/container/build.sh
- /data/nanotars/container/agent-runner/src/index.ts (the agent-runner entry on v1)

Files to read on side B (v2):
- /data/nanoclaw-v2/src/container-runner.ts
- /data/nanoclaw-v2/src/container-runtime.ts
- /data/nanoclaw-v2/src/container-config.ts
- /data/nanoclaw-v2/src/host-sweep.ts
- /data/nanoclaw-v2/src/modules/lifecycle/index.ts
- /data/nanoclaw-v2/src/modules/lifecycle/actions.ts
- /data/nanoclaw-v2/src/modules/lifecycle/module.ts
- /data/nanoclaw-v2/src/modules/self-mod/request.ts
- /data/nanoclaw-v2/src/modules/self-mod/apply.ts
- /data/nanoclaw-v2/src/modules/self-mod/index.ts
- /data/nanoclaw-v2/src/modules/scheduling/db.ts
- /data/nanoclaw-v2/src/modules/scheduling/recurrence.ts
- /data/nanoclaw-v2/src/modules/scheduling/actions.ts
- /data/nanoclaw-v2/src/modules/scheduling/index.ts
- /data/nanoclaw-v2/src/providers/index.ts
- /data/nanoclaw-v2/src/providers/provider-container-registry.ts
- /data/nanoclaw-v2/container/Dockerfile
- /data/nanoclaw-v2/container/build.sh
- /data/nanoclaw-v2/container/entrypoint.sh
- /data/nanoclaw-v2/container/agent-runner/src/poll-loop.ts
- /data/nanoclaw-v2/container/agent-runner/src/scheduling/task-script.ts
- /data/nanoclaw-v2/container/agent-runner/src/providers/factory.ts
- /data/nanoclaw-v2/container/agent-runner/src/providers/claude.ts

Output: /data/nanotars/docs/upstream-triage-2026-04-25-area-3-runtime-lifecycle.md

Format and hard requirements: identical to Agent 1.

Special focus areas:
1. The MAX_CONCURRENT_CONTAINERS cap on v1 vs absence on v2 — a known regression worth flagging
2. The pre-task `script` hook on v2 (used by scheduled tasks for cheap pre-checks) — investigate whether v1 has equivalent
3. Provider abstraction on v2 — most likely SKIP-ARCH for nanotars, but verify

Cross-references: Area 1 covers DB schema for scheduled tasks and sessions. Area 5 covers any provider-related extension hooks. Area 6 covers container hardening flags overlap.

When done, confirm with file path and counts per verdict bucket.
```

#### Agent 4 — Channels & media

**Description:** Triage area 4 — channels & media

**Prompt:**

```
You are doing a structural code review of CHANNELS AND MEDIA HANDLING across two codebases for a nanotars-fork upstream-triage exercise.

Source A (nanotars v1 fork, customized): /data/nanotars (v1-archive branch)
Source B (upstream NanoClaw v2): /data/nanoclaw-v2

Read the spec first:
/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md

Your scope:
- Channel adapter interface and registration (v1: `Channel` interface + plugin-loader's `channelPlugin: true` + `onChannel` factory; v2: `ChannelAdapter` interface + `registerChannelAdapter` + chat-sdk-bridge)
- Channel-specific code on each side (Telegram, WhatsApp, Discord, etc.) — interface and shape, not the entire 27-channel marketplace
- Outbound media handling: magic-bytes MIME detection, ffmpeg thumbnail extraction, send_file MCP tool, sendPhoto/sendVideo/sendAudio routing
- Inbound media handling: voice/audio attachment download, document handling, image embedding
- Reactions, reply-quoting, message ID composite formats, JID/threading conventions
- The chat-sdk bridge (v2-only middleware between adapter and SDK)

Files to read on side A (v1):
- /data/nanotars/src/router.ts (outbound router with channel dispatch)
- /data/nanotars/src/types.ts (the Channel interface)
- /data/nanotars/docs/CHANNEL_PLUGINS.md (design intent — read in full for the channel-plugin contract)
- Look for any channel implementations: ls /data/nanotars/plugins/channels/ (gitignored, may be empty here)

Files to read on side B (v2):
- /data/nanoclaw-v2/src/channels/adapter.ts (interface)
- /data/nanoclaw-v2/src/channels/channel-registry.ts
- /data/nanoclaw-v2/src/channels/chat-sdk-bridge.ts
- /data/nanoclaw-v2/src/channels/cli.ts (always-on terminal channel)
- /data/nanoclaw-v2/src/channels/telegram.ts
- /data/nanoclaw-v2/src/channels/telegram-pairing.ts
- /data/nanoclaw-v2/src/channels/telegram-markdown-sanitize.ts
- /data/nanoclaw-v2/src/channels/ask-question.ts
- /data/nanoclaw-v2/src/delivery.ts (outbound delivery + adapter dispatch)
- /data/nanoclaw-v2/src/router.ts (v2's inbound router — different shape than v1's outbound router with same name)
- /data/nanoclaw-v2/container/agent-runner/src/destinations.ts

Output: /data/nanotars/docs/upstream-triage-2026-04-25-area-4-channels-media.md

Format and hard requirements: identical to Agent 1.

Special focus areas:
1. Magic-bytes MIME detection and ffmpeg thumbnail extraction — likely already in v1 (Danny's own work). Confirm and verdict carefully.
2. Reactions and the chat-sdk-bridge composite-id quirk — Danny just fixed this in v2 (commit 32a8dea/9ed4722). Verify whether the same bug exists in v1.
3. The `ChannelAdapter` interface (v2) vs `Channel` interface (v1) — fundamentally different shape (deliver vs sendMessage, supportsThreads, openDM, subscribe). Verdict each method individually.
4. The chat-sdk bridge is v2-specific glue around `@chat-adapter/*` packages — ADOPT or SKIP-ARCH? Reason carefully.

Cross-references: Area 5 covers the plugin loader / extension system that v1 uses to load channels. Your scope is the channel *interface* and *channel-specific code*, not the discovery mechanism. Area 1 covers DB schemas if any channel persistence touches them.

Note: nanotars's actual channel implementations may live outside the repo (gitignored under `plugins/channels/`). If they're missing, review the contract from `docs/CHANNEL_PLUGINS.md` and `src/types.ts` instead — the *interface* is what matters for the verdict.

When done, confirm with file path and counts per verdict bucket.
```

#### Agent 5 — Extensions, agent teams, identity, dashboard

**Description:** Triage area 5 — extensions, agent teams, identity

**Prompt:**

```
You are doing a structural code review of EXTENSIONS, AGENT TEAMS, IDENTITY, AND DASHBOARD across two codebases for a nanotars-fork upstream-triage exercise.

Source A (nanotars v1 fork, customized): /data/nanotars (v1-archive branch)
Source B (upstream NanoClaw v2): /data/nanoclaw-v2

Read the spec first:
/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md

Your scope:
- Extension system (v1: `plugin-loader.ts` + `plugins/<name>/plugin.json` discovery + manifest + hooks; v2: barrel-import + skill-installed branches)
- MCP integration (v1: per-plugin `mcp.json` merge into `merged-mcp.json`; v2: in-process MCP tool stubs in `container/agent-runner/src/mcp-tools/`)
- Container-skills mounting (v1: per-plugin `container-skills/`; v2: `container/skills/` + `groups/<folder>/skills/`)
- Dockerfile partials (v1: per-plugin `Dockerfile.partial` injected into base Dockerfile; v2: `container/partials/<name>.Dockerfile` + `container.json:dockerfilePartials`)
- Agent teams (v1: `groups/<folder>/agents/<name>/{agent.json,IDENTITY.md,CLAUDE.md}` + `discoverAgents` in agent-runner; v2: `src/modules/agent-to-agent/*` destinations module — DIFFERENT CONCEPT)
- Per-group identity (v1: `groups/<folder>/IDENTITY.md` + `groups/global/`; v2: `groups/<folder>/CLAUDE.md` + `CLAUDE.local.md` + `groups/identity/` mount)
- Webhooks (v1: webhook plugins; v2: `src/webhook-server.ts`)
- Dashboard (v1: `plugins/dashboard/` ~900 LOC htmx app; v2: `add-dashboard` skill + `src/dashboard-pusher.ts`)

Files to read on side A (v1):
- /data/nanotars/src/plugin-loader.ts
- /data/nanotars/src/plugin-types.ts
- /data/nanotars/docs/PLUGINS.md
- /data/nanotars/docs/AGENT_TEAMS.md
- /data/nanotars/docs/MARKETPLACE.md
- /data/nanotars/.claude/settings.json (if present)
- Sample any plugins under /data/nanotars/plugins/ that exist

Files to read on side B (v2):
- /data/nanoclaw-v2/src/channels/index.ts (barrel pattern)
- /data/nanoclaw-v2/src/providers/index.ts (barrel pattern)
- /data/nanoclaw-v2/src/modules/index.ts (barrel pattern)
- /data/nanoclaw-v2/src/modules/agent-to-agent/agent-route.ts
- /data/nanoclaw-v2/src/modules/agent-to-agent/create-agent.ts
- /data/nanoclaw-v2/src/modules/agent-to-agent/write-destinations.ts
- /data/nanoclaw-v2/src/modules/agent-to-agent/db/agent-destinations.ts
- /data/nanoclaw-v2/src/modules/agent-to-agent/index.ts
- /data/nanoclaw-v2/src/dashboard-pusher.ts
- /data/nanoclaw-v2/src/webhook-server.ts
- /data/nanoclaw-v2/src/group-init.ts (per-group filesystem scaffold)
- /data/nanoclaw-v2/src/claude-md-compose.ts
- /data/nanoclaw-v2/container/agent-runner/src/mcp-tools/index.ts
- /data/nanoclaw-v2/container/agent-runner/src/mcp-tools/server.ts
- /data/nanoclaw-v2/container/agent-runner/src/mcp-tools/core.ts
- /data/nanoclaw-v2/container/agent-runner/src/mcp-tools/agents.ts
- /data/nanoclaw-v2/docs/skills-as-branches.md (read in full for the v2 distribution model)

Output: /data/nanotars/docs/upstream-triage-2026-04-25-area-5-extensions-agents.md

Format and hard requirements: identical to Agent 1.

Special focus areas:
1. The plugin loader vs barrel-import + skill-branches comparison is the central architectural divergence — be honest about which is better for which use case (Danny is a single user with 20+ extensions; the answer may not be what upstream chose).
2. Agent teams (`groups/<folder>/agents/`) is v1-only and worth keeping; verify what `discoverAgents` does and whether v2's agent-to-agent module is a meaningful equivalent (likely no — they solve different problems).
3. Dashboard is a heavy item — full-featured admin UI in v1 vs minimal pusher in v2. CONTRIBUTE candidate? Or just KEEP?
4. The identity system — v1's IDENTITY.md vs v2's CLAUDE.local.md + groups/identity/ — consider how they compose.

Cross-references: Area 4 covers channel-specific code; your scope is the discovery/loading framework, not the channels themselves. Area 6 covers MCP server config + per-group env (which extensions use).

When done, confirm with file path and counts per verdict bucket.
```

#### Agent 6 — Security, IPC, build, tests, ops

**Description:** Triage area 6 — security, IPC, build, tests, ops

**Prompt:**

```
You are doing a structural code review of SECURITY, IPC, BUILD, TESTS, AND OPS across two codebases for a nanotars-fork upstream-triage exercise.

Source A (nanotars v1 fork, customized): /data/nanotars (v1-archive branch)
Source B (upstream NanoClaw v2): /data/nanoclaw-v2

Read the spec first:
/data/nanotars/docs/superpowers/specs/2026-04-25-upstream-triage-design.md

Your scope:
- Mount allowlist (`mount-security.ts` on each side — v2 explicitly ports from v1)
- Secret-redaction (`secret-redact.ts` on v1; `src/modules/secret-redaction/` on v2 — also a documented port)
- Auth-error detection (v1's `router.ts:isAuthError` and AUTH_ERROR_PATTERNS; v2 GAP)
- Credential model (v1: stdin-injected secrets + OAuth bind-mount; v2: OneCLI gateway + HTTPS_PROXY injection)
- IPC layer (v1: file-based `src/ipc/*` with `data/ipc/<group>/{messages,tasks}/*.json` + `output-parser.ts` stdout markers; v2: per-session `inbound.db`/`outbound.db` with no file IPC)
- Bash security hooks (v1's `security-hooks.ts`; v2's same file — known equivalent)
- Per-group env passthrough (v2-only `src/modules/group-env/index.ts` with explicit allowlist + shell-quoting; v1 merges all of `.env`)
- Container hardening flags (cap-drop, no-new-privileges, resource limits — verify both sides)
- Logging / observability (pino on v1; hand-rolled `src/log.ts` on v2)
- Tests (vitest on v1; vitest + bun:test split on v2; coverage gaps including missing mount-security tests on v2)
- Build pipeline (npm on v1; pnpm + bun on v2; minimumReleaseAge supply-chain hold; pinned versions)
- CI (GitHub Actions: nanotars vs v2's larger surface)
- Operational skills inventory (.claude/skills/ on each side — already heavily compared in earlier work; don't redo, just summarize)

Files to read on side A (v1):
- /data/nanotars/src/mount-security.ts
- /data/nanotars/src/secret-redact.ts
- /data/nanotars/src/router.ts (look for isAuthError and AUTH_ERROR_PATTERNS)
- /data/nanotars/src/ipc/index.ts
- /data/nanotars/src/ipc/auth.ts
- /data/nanotars/src/ipc/file-io.ts
- /data/nanotars/src/ipc/messages.ts
- /data/nanotars/src/ipc/tasks.ts
- /data/nanotars/src/ipc/types.ts
- /data/nanotars/src/output-parser.ts
- /data/nanotars/src/logger.ts
- /data/nanotars/src/env.ts
- /data/nanotars/container/agent-runner/src/security-hooks.ts
- /data/nanotars/container/agent-runner/src/security-hooks.test.ts
- /data/nanotars/package.json
- /data/nanotars/docs/SECURITY.md
- /data/nanotars/docs/IPC_PROTOCOL.md
- /data/nanotars/.github/workflows (if present)
- ls /data/nanotars/.claude/skills/ (inventory only)

Files to read on side B (v2):
- /data/nanoclaw-v2/src/modules/mount-security/index.ts
- /data/nanoclaw-v2/src/modules/secret-redaction/index.ts
- /data/nanoclaw-v2/src/modules/secret-redaction/secret-redaction.test.ts
- /data/nanoclaw-v2/src/modules/group-env/index.ts
- /data/nanoclaw-v2/src/onecli-approvals.ts (if exists, otherwise it's at src/modules/approvals/onecli-approvals.ts — already in Area 2)
- /data/nanoclaw-v2/src/command-gate.ts
- /data/nanoclaw-v2/src/log.ts
- /data/nanoclaw-v2/src/env.ts
- /data/nanoclaw-v2/src/delivery.ts (look for any auth-error handling)
- /data/nanoclaw-v2/container/agent-runner/src/security-hooks.ts
- /data/nanoclaw-v2/container/agent-runner/src/security-hooks.test.ts
- /data/nanoclaw-v2/package.json
- /data/nanoclaw-v2/pnpm-workspace.yaml
- /data/nanoclaw-v2/container/agent-runner/package.json
- /data/nanoclaw-v2/container/agent-runner/bun.lock (presence/absence only — don't parse)
- /data/nanoclaw-v2/.github/workflows
- ls /data/nanoclaw-v2/.claude/skills/ (inventory only)

Output: /data/nanotars/docs/upstream-triage-2026-04-25-area-6-security-ipc-build.md

Format and hard requirements: identical to Agent 1.

Special focus areas:
1. The IPC vs two-DB messaging is the BIGGEST architectural divergence in this area — entire `src/ipc/*` tree on v1 is replaced by per-session DBs on v2. Almost certainly SKIP-ARCH (β posture rules out the architectural shift).
2. OneCLI vs stdin-secrets — adoptable as an addition to v1 (OneCLI is a separate daemon), but ranks medium-large effort. ADOPT candidate.
3. Auth-error detection on v1 is a known gap on v2 — CONTRIBUTE candidate.
4. Per-group env allowlist on v2 (group-env module) — ADOPT or PORT? Verify v1's behaviour.
5. Tests + CI: be specific about coverage gaps. v2's mount-security has no tests — actual regression.
6. Don't re-litigate the .claude/skills/ inventory — there's a separate skill assessment doc Danny did earlier. Just note any operational skill on v2 that's relevant to porting.

Cross-references: Area 1 covers session DB schemas (which IPC replaces). Area 2 covers OneCLI's approval bridge (your scope is the credential injection itself). Area 3 covers the stdin/output protocol from the runtime side.

When done, confirm with file path and counts per verdict bucket.
```

- [ ] **Step 2: Wait for all six agents to return**

You will receive confirmations from each agent stating their output file path and bucket counts. Wait for ALL six before proceeding. If any agent fails or times out, capture its error and decide: (a) re-dispatch with adjusted scope, or (b) flag the gap in the master doc and continue.

- [ ] **Step 3: No commit yet**

Per-area files are deliverables that get committed at the end (Task 6). Don't commit individual agent outputs.

---

## Task 3: Verify all six per-area reports exist and meet structural requirements

**Files:**
- Read all six per-area files

- [ ] **Step 1: Confirm all six files exist**

Run:
```bash
for n in 1 2 3 4 5 6; do
  test -f /data/nanotars/docs/upstream-triage-2026-04-25-area-${n}-*.md && echo "area $n ok" || echo "area $n MISSING"
done
```
Expected: all six say `ok`. If any are MISSING, return to Task 2 Step 2 and triage.

- [ ] **Step 2: Read each per-area file and verify required sections**

For each of the six files, use Read to load it, then verify the file contains:
- A `## Area:` heading
- A `### Functional inventory` section
- A `### Implementation comparison` section
- A `### Verdict matrix` section with a markdown table (at least one row)
- A `### What surprised me` section
- A `### Cross-cutting concerns` section
- A `### Open questions` section

If any section is missing in any file, mark it for manual completion before synthesis. Don't reject the file — just note the gap.

- [ ] **Step 3: Tally verdict counts across all six files**

For each file, scan the verdict matrix and count rows by Action column (PORT / KEEP / ADOPT / SKIP-ARCH / CONTRIBUTE). Record the per-area subtotals. These will become the Executive Summary's count totals — and the numeric integrity check (Acceptance Criterion #4) requires the totals match.

Example output to keep:
```
Area 1: PORT=2 KEEP=1 ADOPT=4 SKIP-ARCH=3 CONTRIBUTE=1 → total 11
Area 2: ...
...
Grand totals: PORT=X KEEP=Y ADOPT=Z SKIP-ARCH=N CONTRIBUTE=M
```

- [ ] **Step 4: Note cross-area dependencies**

Each agent flagged cross-area items in their "Cross-cutting concerns" section. Pull these into a single list — every cross-reference will need to be verified to exist in the referenced area, otherwise it's a dangling link.

---

## Task 4: First synthesis pass — write the master doc

**Files:**
- Create: `/data/nanotars/docs/upstream-triage-2026-04-25.md`

- [ ] **Step 1: Write the executive summary**

Use the format from the spec:
```markdown
# nanotars (v1-archive) ↔ nanoclaw v2 — Upstream Triage 2026-04-25

## Executive summary

**Verdict counts (across all 6 areas):**
- PORT: <X>
- KEEP: <Y>
- ADOPT: <Z>
- SKIP-ARCH: <N>
- CONTRIBUTE: <M>
- **Total items reviewed: <X+Y+Z+N+M>**

**Top 5 high-priority ports** (most user-visible / lowest effort):
1. <Item> (Area <n>, effort <bucket>) — <one-line rationale>
2. ...

**Top 5 nanotars wins to contribute upstream:**
1. <Item> (Area <n>) — <why upstream needs this>
2. ...

**Architectural items skipped** (one-line rationale per):
- <Item> — <reason for SKIP-ARCH>
- ...

**Estimated total port effort:** <weeks at 8h/wk> (range based on confidence)
```

Pull the rankings from the verdict matrices: PORT items sorted by user-visibility × inverse-effort; CONTRIBUTE items sorted by upstream applicability.

- [ ] **Step 2: Write the sequencing recommendation**

```markdown
## Sequencing recommendation

### Phase 1 — small/independent ports (~weeks 1-2)
<Items: trivial-effort PORT/ADOPT with no dependencies. Order by user-visibility.>

### Phase 2 — medium items with dependencies (~weeks 3-N)
<Items grouped by dependency clusters.>

### Phase 3 — large items (~weeks N+1...)
<Items: large-effort items, e.g. OneCLI integration.>

### Items punted to future / explicitly out of scope
<Items: SKIP-ARCH with note. Architectural items needing separate brainstorm.>
```

Use the Depends-on column from each verdict matrix to compute the dependency graph. Phase 1 = items with no dependencies; Phase 2 = items depending on Phase 1; etc.

- [ ] **Step 3: For each of six concern areas, write a synthesized section**

```markdown
## Area <N>: <name>

**Functional inventory (condensed):** <2-3 sentences on each side, drawn from the per-area report's inventory section>

**Implementation comparison highlights:** <Top 3-5 differences from the per-area report's comparison section, NOT the full list>

**Verdict matrix:** <FULL matrix copied verbatim from the per-area report — this is the operational data Danny works from>

**Cross-cutting concerns:** <Bullet list copied from the per-area report>

→ See `upstream-triage-2026-04-25-area-<N>-<name>.md` for the full agent report.
```

Repeat for all six areas.

- [ ] **Step 4: Write the cross-cutting findings section**

```markdown
## Cross-cutting findings

### Cross-area dependencies
<For each cross-reference noted by agents, verify the referenced item exists. List as: "Area X item 'foo' depends on Area Y item 'bar'.">

### Items that change architectural assumptions
<Any verdicts that, if adopted, would shift more than just one area. Flag for separate brainstorm.>

### Inline code excerpts for top PORT items
<For each of the top 5 PORT items, include a short code excerpt (10-30 lines) showing the v2 implementation. Use Read to grab the actual code; cite file:line.>

### Inline code excerpts for top CONTRIBUTE items
<For each of the top 5 CONTRIBUTE items, include a short code excerpt showing v1's implementation worth contributing.>
```

- [ ] **Step 5: Write the methodology + appendix sections**

```markdown
## Appendix: methodology

**Baseline:** v1-archive at commit <SHA>, head of nanotars's preserved fork code as of 2026-04-25.

**Comparison method:** Six parallel structural code reviews (no commit-archaeology). Each agent owned one concern area, read both codebases, produced a uniform per-area report. `git log -p <file>` consulted only for ambiguity, not as routine.

**Confidence levels:** Every verdict marked high/medium/low. Low-confidence items have follow-up questions in the area's "Open questions" section.

**Spot-check pass:** <X> randomly-selected verdicts manually re-verified against source code. <Y> drift corrections made.

## Appendix: agent reports

Per-area appendix files (verbatim agent output, preserved for traceability):
- [Area 1: Persistence layer](upstream-triage-2026-04-25-area-1-persistence.md)
- [Area 2: Migrations, permissions, approvals](upstream-triage-2026-04-25-area-2-migrations-permissions.md)
- [Area 3: Runtime, lifecycle, scheduling](upstream-triage-2026-04-25-area-3-runtime-lifecycle.md)
- [Area 4: Channels & media](upstream-triage-2026-04-25-area-4-channels-media.md)
- [Area 5: Extensions, agent teams, identity, dashboard](upstream-triage-2026-04-25-area-5-extensions-agents.md)
- [Area 6: Security, IPC, build, tests, ops](upstream-triage-2026-04-25-area-6-security-ipc-build.md)
```

- [ ] **Step 6: Numeric integrity check**

Re-tally the verdict counts in your Executive Summary against the sum of all matrix rows you copied into the Per-Area sections. If they don't match, find the discrepancy and fix. Do NOT commit until totals reconcile (Acceptance Criterion #4 from the spec).

---

## Task 5: Spot-check pass — verify 10-15 random verdicts

**Files:**
- Read the master doc + selected source files for verification

- [ ] **Step 1: Pick 10-15 random verdict rows across the six areas**

Distribute roughly evenly: 2-3 from each area. Prefer high-effort or high-user-impact items, since drift on these is more consequential than drift on trivial items.

- [ ] **Step 2: For each picked row, manually verify**

For each row:
1. Read the cited file:line on both v1 and v2.
2. Confirm the agent's claim about behavior is accurate.
3. Confirm the verdict (PORT/KEEP/ADOPT/SKIP-ARCH/CONTRIBUTE) follows from the comparison.
4. Note any drift or correction needed.

- [ ] **Step 3: Apply drift corrections inline in the master doc**

If a verdict was wrong, update both the per-area section in the master doc AND the per-area report file. Track the correction in the methodology appendix:

```markdown
**Spot-check pass:** 12 verdicts manually re-verified. 1 drift correction:
- Area 4 item "<name>": initial verdict ADOPT → corrected to PORT after verifying v2's <X> at <file:line> is genuinely better than v1's <Y> at <file:line>.
```

- [ ] **Step 4: Re-run numeric integrity check**

If any verdicts changed bucket during the spot-check, the Executive Summary counts may be off. Re-tally and reconcile.

---

## Task 6: Commit and present

**Files:**
- All seven (master + six per-area reports) committed to v1-archive

- [ ] **Step 1: Confirm working tree state**

Run: `cd /data/nanotars && git status --short`
Expected: 7 new untracked files (the master doc + six per-area appendices). No modifications to existing tracked files.

If there are unexpected modifications, stop and investigate — agents shouldn't have touched anything outside the seven output paths.

- [ ] **Step 2: Stage all seven files**

Run:
```bash
cd /data/nanotars && git add docs/upstream-triage-2026-04-25.md docs/upstream-triage-2026-04-25-area-*.md
```

- [ ] **Step 3: Commit with informative message**

Run:
```bash
cd /data/nanotars && git commit -m "$(cat <<'EOF'
docs(triage): v1-archive ↔ upstream/main structural triage

Six parallel agents reviewed both codebases module-by-module across
persistence, migrations/permissions, runtime/lifecycle, channels/media,
extensions/agent-teams, and security/IPC/build. Output is a master doc
with verdict matrix + sequencing recommendation, plus six per-area
appendix reports preserved for traceability.

Verdict counts: <PORT> PORT / <KEEP> KEEP / <ADOPT> ADOPT /
<SKIP-ARCH> SKIP-ARCH / <CONTRIBUTE> CONTRIBUTE.

Sequencing recommendation defines Phase 1-3 work for the catch-up.
SKIP-ARCH items are explicitly out of scope under (β) posture; if
any are reconsidered later that becomes a separate brainstorm.

Spec: docs/superpowers/specs/2026-04-25-upstream-triage-design.md
Plan: docs/superpowers/plans/2026-04-25-upstream-triage.md
EOF
)"
```

(Replace `<PORT>`/`<KEEP>`/etc. with the actual numbers from your final tally.)

- [ ] **Step 4: Push to origin**

Run: `cd /data/nanotars && git push origin v1-archive`
Expected: clean push.

- [ ] **Step 5: Present final summary to Danny**

Output to Danny: file path of master doc, verdict bucket counts, top 5 PORT items, top 5 CONTRIBUTE items, list of architectural items skipped. Offer next step: "ready to brainstorm Phase 1 ports individually, or want to discuss the verdicts first?"

---

## Acceptance check (final)

After Task 6 completes, verify against the spec's acceptance criteria:

1. ✅ All 6 concern areas have a synthesized section in the master doc
2. ✅ Every verdict has effort + confidence + one-line rationale (no bare "PORT" rows)
3. ✅ Cross-area dependencies flagged in both area sections and cross-cutting section
4. ✅ Numeric integrity: Executive Summary counts == sum of all matrix rows
5. ✅ Confidence levels: every verdict marked high/medium/low
6. ✅ Synthesis is yours, not the agents' (Executive Summary, Sequencing, Cross-cutting are written by orchestrator)
7. ✅ Inline code excerpts for top PORT and top CONTRIBUTE items
8. ✅ Spot-check pass complete with drift corrections noted

If any criterion fails, return to the relevant task. The doc is not "done" until all eight pass.
