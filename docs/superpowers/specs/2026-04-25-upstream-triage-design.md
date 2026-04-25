# Spec — nanotars (v1-archive) ↔ nanoclaw v2 upstream triage

**Date:** 2026-04-25
**Author:** Danny (TerrifiedBug) + assistant
**Status:** approved
**Output:** `docs/upstream-triage-2026-04-25.md` (master doc, committed to `v1-archive`)

---

## Background

`TerrifiedBug/nanotars` is a heavily customized fork of `qwibitai/nanoclaw`. Last upstream merge into nanotars: 2026-02-19 at upstream commit `b60e49c`. Since then, upstream has 1002 new commits, including the v2 architectural cutover (`fe942dd chore: bump to 2.0.0`, `c16052e Merge pull request #1919 from qwibitai/v2`). Upstream explicitly added a STOP banner to `CLAUDE.md` at commit `0ed00b3` directing v1-fork users to run `migrate-v2.sh` instead of merging — the architectures are incompatible at the merge-graph level.

nanotars's primary state lives on the `v1-archive` branch (head `df76cb9`). The fork's `main` is currently a v2 mirror that will be replaced by `v1-archive` once the catch-up is complete.

## Goal

Produce a single working document that, for every meaningful difference between v1-archive and upstream/main, gives Danny:

1. A verdict (PORT / KEEP / ADOPT / SKIP-ARCH / CONTRIBUTE)
2. An effort estimate (trivial / small / medium / large)
3. A confidence level (high / medium / low)
4. Cross-area dependencies
5. Sequencing recommendation

The doc enables Danny to make port decisions without re-reading either codebase. It is the operational artifact that drives the catch-up work over the following weeks/months.

## Verdict definitions

| Verdict | Meaning |
|---------|---------|
| **PORT** | v2 has a clearly better implementation of functionality v1 also has. Bring v2's version across to v1. |
| **KEEP** | v1's implementation is better than v2's (or v2 dropped a feature v1 still needs). Keep v1's. Flag for upstream contribution if generally useful. |
| **ADOPT** | v2 has functionality v1 doesn't have, and it's worth adding. |
| **SKIP-ARCH** | v2 has functionality that depends on its architectural rewrite (two-DB, three-level entity model, OneCLI gateway, per-session container). Out of scope under (β); revisit if (γ) ever happens. |
| **CONTRIBUTE** | v1 has functionality v2 doesn't. Useful to upstream as a PR. |

## Method

**Approach D — Side-by-side structural code review.** No commit-archaeology. Subagents read the current state of both codebases module-by-module and produce a uniform per-area comparison. Commit log (`git log -p <file>`) is used only when the comparison surfaces ambiguity.

**Why not commit-walk:** 1002 commits is unbounded effort. Many features were added then refactored over the 1002-commit window; commit-walk would produce churn artifacts. Final state is what matters for port decisions.

## Subagent allocation — 6 parallel agents

Each agent owns a coherent slice of the codebase, reads both `/data/nanotars/src/` (v1-archive) and `/data/nanoclaw-v2/src/` for its assigned areas, plus relevant `container/agent-runner/src/` slices, plus design-intent docs on each side. Each produces one per-area report (3500-5000 words) following the uniform format below.

### Agent 1 — Persistence layer

Scope: DB schemas, accessors, queries — central DB on each side and per-session DBs on v2. Includes `chats`, `messages`, `registered_groups`, `scheduled_tasks`, `task_run_logs`, `sessions`, `router_state` on nanotars; `agent_groups`, `messaging_groups`, `messaging_group_agents`, `messaging_groups`, `users`, `user_dms`, `agent_destinations`, `chat_sdk_*`, plus per-session `messages_in`, `messages_out`, `processing_ack`, `delivered`, `session_state`, `container_state` on v2. **State persistence helpers** (kv state, snapshots, session state).

Files (representative): `src/db.ts` + `src/db/{init,messages,state,tasks,migrate}.ts` (nanotars); `src/db/{connection,schema,agent-groups,messaging-groups,sessions,session-db,dropped-messages}.ts` + `container/agent-runner/src/db/{messages-in,messages-out,session-routing,session-state,connection}.ts` (v2).

### Agent 2 — Migrations, permissions, approvals

Scope: migration framework (one-shot vs versioned with `schema_version` + numbered files), permissions model (nanotars: implicit via main-group; v2: `user_roles` + `agent_group_members` + `user_dms`), approvals state (v2-only: `pending_approvals`, `pending_channel_approvals`, `pending_sender_approvals`, `pending_questions`, `unregistered_senders`).

Files: `src/db/migrate.ts` (nanotars); `src/db/migrations/*` + `src/modules/permissions/{access,user-dm,channel-approval,sender-approval}.ts` + `src/modules/permissions/db/*.ts` + `src/modules/approvals/{primitive,onecli-approvals,response-handler}.ts` (v2).

### Agent 3 — Runtime, lifecycle, scheduling

Scope: container runner, container-runtime abstraction (Docker / Apple Container), idle/timeout/retry, concurrency model (nanotars: per-group queue + global `MAX_CONCURRENT_CONTAINERS`; v2: per-session container with no host-wide cap), pause/resume (v2 lifecycle module vs nanotars emergency-stop), self-mod (`install_packages` / `add_mcp_server` — v2-only), provider abstraction (Codex/OpenCode/Ollama agents — v2-only), scheduled tasks (storage shape, cron parser, task-script hook, error notification, per-task model, recurrence handling, atomic claim, idle preemption).

Files: `src/container-runner.ts` + `src/container-runtime.ts` + `src/group-queue.ts` + `src/task-scheduler.ts` + container Dockerfile + entrypoint (nanotars); `src/container-runner.ts` + `src/container-runtime.ts` + `src/host-sweep.ts` + `src/modules/lifecycle/*` + `src/modules/self-mod/*` + `src/modules/scheduling/*` + `src/providers/*` + `container/agent-runner/src/{config,poll-loop,scheduling}.ts` + `container/agent-runner/src/providers/*` + container Dockerfile + entrypoint (v2).

### Agent 4 — Channels & media

Scope: channel adapter interface and registration (nanotars's `Channel` interface + plugin-loader's `channelPlugin: true` + `onChannel` factory; v2's `ChannelAdapter` + `registerChannelAdapter` + chat-sdk-bridge), channel-specific code (Telegram, WhatsApp, Discord, etc. on each side), media handling (magic-bytes MIME detection, ffmpeg thumbnails, `send_file` MCP, voice/audio attachment download), reactions, reply-quoting, message ID composite formats, JID/threading conventions.

Files: `src/router.ts` (nanotars's outbound router) + `plugins/channels/*` (gitignored — sample any present) + `src/types.ts` Channel interface (nanotars); `src/channels/*` + `src/delivery.ts` + `container/agent-runner/src/destinations.ts` (v2).

Note: nanotars's actual channel implementations may live outside the repo (gitignored). Agent should review the **interface and shape**, plus reference the v1 `docs/CHANNEL_PLUGINS.md` doc for the expected behaviour.

### Agent 5 — Extensions, agent teams, identity, dashboard

Scope: extension system (nanotars's `plugin-loader.ts` + `plugins/<name>/plugin.json` discovery + manifest + hooks; v2's barrel-import + skill-installed branches model), MCP integration (per-plugin `mcp.json` merge in nanotars vs in-process MCP tool stubs in v2), container-skills mounting (per-plugin in nanotars; per-group `container/skills/` + `groups/<folder>/skills/` in v2), Dockerfile partials (per-plugin `Dockerfile.partial` in nanotars; `container/partials/<name>.Dockerfile` + `container.json:dockerfilePartials` in v2), agent teams (nanotars's `groups/<folder>/agents/<name>/{agent.json,IDENTITY.md,CLAUDE.md}` + `discoverAgents` in agent-runner; v2's `src/modules/agent-to-agent/*` destinations module), per-group identity (nanotars's `groups/<folder>/IDENTITY.md` + `groups/global/`; v2's `groups/<folder>/CLAUDE.md` + `CLAUDE.local.md` + `groups/identity/` mount), webhooks (nanotars's webhook plugins; v2's `src/webhook-server.ts`), dashboard (nanotars's `plugins/dashboard/` ~900 LOC; v2's `add-dashboard` skill + `src/dashboard-pusher.ts`).

Files: `src/plugin-loader.ts` + `src/plugin-types.ts` + `src/router.ts` outbound (nanotars); `src/channels/index.ts` barrel + `src/providers/index.ts` barrel + `src/modules/agent-to-agent/*` + `src/dashboard-pusher.ts` + `src/webhook-server.ts` + container `groups/identity/` references (v2).

### Agent 6 — Security, IPC, build, tests, ops

Scope: mount allowlist (`mount-security.ts` on each side — already known to be a direct port from nanotars to v2), secret-redaction (`secret-redact.ts` on nanotars; `src/modules/secret-redaction/index.ts` on v2 — also a documented port), auth-error detection (`router.ts:isAuthError` on nanotars; **gap on v2**), credential model (nanotars: stdin-injected secrets + `OAUTH bind-mount`; v2: OneCLI gateway + HTTPS_PROXY injection), IPC layer (nanotars: file-based `src/ipc/*` with `data/ipc/<group>/{messages,tasks}/*.json` plus `output-parser.ts` stdout markers; v2: per-session `inbound.db`/`outbound.db` with no file IPC), bash security hooks (`security-hooks.ts` on each side — known equivalent), per-group env passthrough (v2-only `src/modules/group-env/index.ts` with explicit allowlist + shell-quoting; nanotars merges all of `.env`), container hardening (`--cap-drop=ALL`, `--security-opt=no-new-privileges`, resource limits — verify both sides), tests (vitest on nanotars; vitest + bun:test split on v2; coverage gaps), build (npm vs pnpm + bun; `minimumReleaseAge` supply-chain hold; pinned versions; CJK fonts; tini), CI (GitHub Actions: nanotars vs v2's larger surface), operational skills inventory (`.claude/skills/` on each side).

Files: `src/mount-security.ts` + `src/secret-redact.ts` + `src/ipc/*` + `src/output-parser.ts` + `container/agent-runner/src/security-hooks.ts` + `package.json` + `.github/workflows/*` + `src/__tests__/*` (nanotars); same equivalents in v2 plus `src/modules/{secret-redaction,mount-security,group-env,lifecycle}/*` + `src/onecli-approvals.ts` + `src/command-gate.ts` + `src/host-sweep.ts` + `package.json` + `pnpm-workspace.yaml` + `container/build.sh` + container `partials/` + `container/agent-runner/package.json` + `bun.lock` + `setup/*` (v2).

## Per-area report format

Each agent produces a markdown report following this exact shape:

```markdown
## Area: <area name>

### Functional inventory
- **v1-archive:** <2-4 sentences describing what nanotars does in this area, key files with line refs, design choices>
- **upstream/main:** <same shape, for v2>

### Implementation comparison
For each shared piece of functionality, a side-by-side analysis:
- **Functionality:** <name>
- **v1 approach:** <description with file:line citations>
- **v2 approach:** <description with file:line citations>
- **Verdict:** <which is better, and why — or "neutral" with rationale>

### Verdict matrix
| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| <descriptor> | PORT / KEEP / ADOPT / SKIP-ARCH / CONTRIBUTE | trivial / small / medium / large | high / medium / low | <other-area items, if any> | <one-line rationale> |

### What surprised me
1-3 unexpected findings — things that contradict the obvious assumption from a high-level reading.

### Cross-cutting concerns
Items in this area that touch other areas. List the dependency clearly.

### Open questions
Any verdicts the agent isn't confident about, with the specific question for human review.
```

Each agent's report goes into a per-area appendix file at `/data/nanotars/docs/upstream-triage-2026-04-25-area-<N>-<name>.md`, then is referenced from the master doc.

## Master doc structure

`/data/nanotars/docs/upstream-triage-2026-04-25.md`:

```markdown
# nanotars (v1-archive) ↔ nanoclaw v2 — Upstream Triage 2026-04-25

## Executive summary
- Verdict counts (X PORT / Y KEEP / Z ADOPT / N SKIP-ARCH / M CONTRIBUTE — totals must match matrix)
- Top 5 high-priority ports (most user-visible / lowest effort)
- Top 5 nanotars wins worth contributing upstream
- Architectural items skipped (with one-line rationale per)
- Estimated total port effort (in week-equivalents at 8 hours/week pace)

## Sequencing recommendation
- Phase 1 — small/independent ports (week-by-week order)
- Phase 2 — medium items with dependencies
- Phase 3 — large items if any
- Items punted to future / explicitly out of scope

## Per-area sections (one per concern area, 6 total — synthesized from agent reports)
- Functional inventory (condensed)
- Implementation comparison highlights (top 3-5 differences)
- Verdict matrix (full, copied from agent report)
- Cross-cutting concerns

## Cross-cutting findings
- Dependencies between items across areas (graph/list)
- Items that change architectural assumptions (flag for separate brainstorm)
- High-consequence inline code excerpts for top PORT and CONTRIBUTE items

## Appendix: methodology
- How v1-archive was identified as baseline
- How equivalents were detected (file inventory + grep + git log -p when ambiguous)
- Confidence levels and where uncertainty remains
- Links to per-area agent reports

## Appendix: agent reports
Links to each per-area report file (preserved verbatim for traceability).
```

## Acceptance criteria

The triage doc is "done" when:

1. **All 6 concern areas have a synthesized section** in the master doc.
2. **Every verdict has an effort estimate, confidence level, and one-line rationale.** No bare "PORT" rows.
3. **Cross-area dependencies are flagged** in both the area sections and the cross-cutting section.
4. **Numeric integrity:** executive summary verdict counts match the sum of all matrix rows across all areas.
5. **Confidence levels:** every verdict marked high/medium/low. Low-confidence items get a "needs human verification" note.
6. **Synthesis is mine, not the agents'.** Each agent contributes a section; I synthesize the executive summary, sequencing recommendation, and cross-cutting findings — no single agent's framing dominates the master doc.
7. **Inline code excerpts** for top PORT and top CONTRIBUTE items so review is possible without context-switching to the source.
8. **Spot-check pass:** I randomly verify 10-15 verdicts against the actual source files and correct any drift.

## Quality controls

- **file:line citations** required on every claim about behavior. No hand-waving.
- **`git log -p <file>`** used only when comparison is ambiguous, not as a routine — bias toward current-state analysis.
- **Two synthesis passes** by me — first pass merges agent reports as-is, second spot-verifies and corrects.
- **Per-agent "what surprised me"** callouts surface findings that contradict the obvious assumption.

## Out of scope for this triage

- Detailed implementation plans for any specific port (each becomes its own brainstorm later).
- Decisions on architectural items beyond "yes/no, here's why" — adopting two-DB or entity-model is a separate γ-territory brainstorm.
- The recurring upstream-watching skill (post-triage, separate brainstorm).
- Actual code changes — this spec produces only the triage document.

## Execution plan

1. Verify nanotars is on `v1-archive` branch with clean working tree.
2. Dispatch 6 agents in parallel (single tool-calls message) with the per-agent prompts above.
3. Each agent writes its per-area report to `/data/nanotars/docs/upstream-triage-2026-04-25-area-<N>-<name>.md`.
4. After all agents return, perform first synthesis pass: build master doc from per-area reports.
5. Perform spot-check pass: verify 10-15 random verdicts against source. Correct drift.
6. Commit master doc + per-area appendices to `v1-archive`.
7. Present summary to Danny for review.

## Estimated effort

- Agent runtime: ~6-9 hours wall-clock (parallel, longest agent dominates)
- Synthesis: ~2-3 hours
- Spot-check + drift correction: ~1-2 hours
- Total: ~9-14 hours, primarily agent-time

## Definition of success

Danny opens the master doc and within 30 minutes can:
1. Identify the 5-10 highest-priority ports to start with.
2. Identify which v2 architectural shifts are firmly out of scope and why.
3. Begin Phase 1 of the catch-up work without re-reading either codebase.
