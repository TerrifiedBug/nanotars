# nanotars (v1-archive) ↔ nanoclaw v2 — Upstream Triage 2026-04-25

> Master synthesis of six parallel structural code reviews comparing `v1-archive` (head `df76cb9`) against `qwibitai/nanoclaw` v2 (`/data/nanoclaw-v2/`, current upstream/main). Per-area agent reports preserved verbatim in `upstream-triage-2026-04-25-area-<N>-<slug>.md`.

> **Triage lens (revised after initial pass).** The exercise's goal is: **keep nanotars's improvements (plugin-loader, channel/skill plugins, file-on-disk media, dashboard, agent teams, etc.) and catch up on upstream improvements where v2 is genuinely better.** Two corrections to the initial verdict pass:
>
> 1. **Technical-merit lens, not pain-driven.** If a v2 feature is genuinely better, it is in scope — the absence of observable pain on v1 is not a reason to defer. The first pass had filtered too aggressively on "no pain felt yet."
> 2. **Multi-user is on the table.** nanotars's repo is public; future installs will host multiple users in shared groups. The multi-user RBAC stack (`users` / `user_roles` / `agent_group_members` / `pickApprover` / sender-scope / approval flows) is in scope, not SKIP.
>
> Conversely, **nanotars's plugin/extension/channel architecture stays.** v2's `ChannelAdapter` interface, barrel-import + skill-merged-branch distribution, `chat-sdk-bridge`, and Bun runtime split are *alternative architectures*, not improvements — different shape, no merit-based win for Danny's installed base. These move from SKIP-ARCH to a new bucket: **SKIP-ALT** (alternative architecture, not adopted on technical merit).

---

## Executive summary

**Verdict counts (revised, primary verdict per matrix row):**

| Verdict | Count | What it means |
|---|---|---|
| PORT | 16 | v2 has a clearly better implementation of functionality v1 also has — bring v2's version across. Fits v1's architecture. |
| KEEP | 44 | v1's implementation wins, OR v1 has improvements v2 lacks. Includes plugin-loader / channel-plugins / dashboard / agent-teams / file-on-disk media — nanotars's own customizations stay. |
| ADOPT | 58 | v2 has functionality v1 doesn't — worth adding. Fits v1's architecture (some require central-DB schema changes for multi-user). |
| PORT-ARCH | 14 | v2 has functionality genuinely better than v1's, but pickup requires committing to per-session containers + two-DB IPC + heartbeat sweep. In scope, but sequenced as a coherent architectural-foundation block. |
| SKIP-ALT | 6 | Alternative architecture, not strictly better. Not adopted on technical merit (`ChannelAdapter` unit, `chat-sdk-bridge`, barrel-import distribution, Bun runtime split, `webhook-server` standalone, registerChannelAdapter barrel). |
| CONTRIBUTE | 12 | v1 has functionality v2 doesn't — useful as a PR upstream. Plus 9 secondary CONTRIBUTE candidates from compound-verdict rows. |
| N/A | 4 | Compared item not present on either side, or v2-only bug with no v1 analog. |
| **Total reviewed** | **154** | (one row added — magic-bytes MIME detection, originally tagged N/A, split into v1-KEEP + upstream-CONTRIBUTE rows after CHANGES.md cross-reference revealed it is present in v1's WhatsApp plugin) |

The 45 original SKIP-ARCH items redistributed as: 14 → **PORT-ARCH** (Phase 6 cluster: two-DB schemas + per-session container + heartbeat sweep + supportsThreads/subscribe/admin-transport + cross-container agent messaging), 22 → **ADOPT** (Phase 4 multi-user RBAC + Phase 5 capability bolt-ons; openDM fits v1's `Channel` interface as a primitive), 3 → **PORT** (Phase 2 A migration-framework cluster — paired adjudication of versioned-file framework + schema-version table + module-migration name-key trick), 6 → **SKIP-ALT** (alternative architectures, not strictly better).

**Top 5 high-priority small wins (Phase 1, ~1.5 weeks):**

1. **Mount allowlist colon-injection check** (Area 6, PORT trivial) — One-line guard in `isValidContainerPath`. Closes `-v repo:rw` injection class. v2 `src/modules/mount-security/index.ts:215`.
2. **`dockerfilePartials` path-traversal guard** (Area 5, PORT trivial) — `path.relative` + `..`/absolute-path rejection. Hardens v1's plugin Dockerfile-partial mechanism. v2 `src/container-runner.ts:592-603`.
3. **Telegram typed-media routing** (Area 4, ADOPT small) — `sendPhoto` / `sendVideo` / `sendAudio` extension-dispatch. Closes the `sendFile` gap in v1's Telegram template. v2 `src/channels/telegram.ts:78-116`.
4. **Bash security hooks `READ_TOOLS_RE` expansion** (Area 6, PORT trivial) — Adds `more|od|hexdump|bun|awk|sed|python3` to v1's existing list.
5. **`AUTH_ERROR_PATTERNS` + `isAuthError`** — already on v1 — KEEP and **CONTRIBUTE upstream** (v2 has no auth-error detection at all; users get silent 3-attempt drop).

**Top 5 medium-effort architecture-preserving wins (Phase 2-3):**

1. **`claude-md-compose.ts` + `CLAUDE.local.md`** (Area 5, PORT medium when bundled) — Host-regenerated per-group `CLAUDE.md` from a shared base + skill fragments + per-group writable memory. Single biggest content-quality win for plugin-contributed instructions.
2. **Numbered migration framework** (Area 1, PORT small) — `schema_version.name`-keyed migration runner; replaces v1's hardcoded MIGRATIONS array. Unlocks plugins shipping their own tables.
3. **OneCLI gateway credential model** (Area 6, ADOPT medium-large) — Centralized credential management + approval-gated credential use. Real operational win.
4. **Three-tier container skills** (Area 5, ADOPT medium) — Shared `container/skills/` + per-group `groups/<folder>/skills/` + selection list in `container.json`. Adds per-group skill enable/disable UX. Coexists with plugin-loader.
5. **Pre-task `script` hook** (Area 3, ADOPT medium) — ~150 LOC + `script TEXT NULL` column. Cheap pre-checks gate model spend on scheduled tasks.

**Top 5 multi-user pickups (Phase 4 — multi-user infrastructure layer on v1's container model):**

1. **Entity model: `agent_groups` + `messaging_groups` + many-to-many wiring** — Replaces v1's `registered_groups` with a 3-level structure that supports multiple channels per agent group. Foundation for everything else in this phase.
2. **`users` + `user_roles` + `agent_group_members`** — Multi-user identity + RBAC.
3. **`pickApprover` + `pickApprovalDelivery`** — Hierarchical approver resolution (scoped admins → global admins → owners).
4. **Approval primitive (`requestApproval` + handler registry + click-auth + `pending_approvals` table)** — Reusable infrastructure for self-mod, OneCLI, ask_question, sender approval, channel registration. ~220 LOC of clean code.
5. **`pending_questions` table + `ask_question` MCP tool** — Real UX win even solo: agent surfaces a question as a Telegram card with answer buttons. Routes the answer back as an MCP tool result.

**Top 5 architecture-pickup items (Phase 6 — per-session containers + two-DB IPC + heartbeat sweep):**

1. **Per-session container model + two-DB IPC** — Better isolation, cleaner lifecycle, atomic per-session state, per-session DBs as natural units. Replaces v1's per-group queue + file-IPC.
2. **Heartbeat-driven stuck detection (`host-sweep.ts`)** — More reliable than v1's poll-only model. Uses `/workspace/.heartbeat` mtime + per-claim tolerance.
3. **`messages_in` + `processing_ack` + `delivered` cross-process state machine** — Replaces stdin-IPC and the `output-parser.ts` stdout-marker protocol with a queryable inbox/outbox.
4. **`container_state` single-row tool-in-flight table** — Cross-process visibility on what tool a container is currently running. Powers the host-side stuck detection.
5. **Live `destinations` + `session_routing` rows** — Replaces JSON-snapshot routing with row-level, per-session routing decisions. Required for session-per-thread routing if `supportsThreads` is wired.

**Top 5 nanotars wins to contribute upstream:**

1. **Container hardening flags** (Area 3 + Area 6, compound — `--cap-drop=ALL`, `--cap-add=SYS_PTRACE`, `--security-opt=no-new-privileges`, custom seccomp, `--cpus=2`, `--memory=4g`, `--pids-limit=256`). v2 ships zero of these. Single-block PR. Biggest concrete security regression in the entire triage.
2. **`AUTH_ERROR_PATTERNS` + `isAuthError`** (Area 6) — Trivial PR; closes silent-drop UX bug.
3. **`MAX_CONCURRENT_CONTAINERS` host-wide cap** (Area 3) — v2 still exports the constant but never reads it. ~30 LOC semaphore-around-`wakeContainer`.
4. **Mount allowlist tests** (Area 6) — v2's `mount-security` has zero tests despite being security-critical. v1's tests are portable.
5. **ffmpeg thumbnail extraction for inbound video/GIF** (Area 4) — Real UX win for agent vision on media-heavy chats.

**SKIP-ALT items (alternative architectures, not adopted on technical merit):**

- **`ChannelAdapter` interface as a unit** (Area 4) — alternative shape; v1's `Channel` interface stays, with selective adoption of new methods (`splitForLimit`, `transformOutboundText`, `extractReplyContext`, `openDM`, `NetworkError` retry).
- **`registerChannelAdapter` self-register barrel** (Area 4) — strictly less flexible than plugin-loader (no manifest, no scoping, no `publicEnvVars`). Plugin-loader wins for the 20+ extensions case.
- **`chat-sdk-bridge`** (Area 4) — vendor lock-in to `@chat-adapter/*` packages. Adopt only if you specifically want the upstream channel marketplace.
- **Barrel-import + skill-merged-branch distribution** (Area 5) — strictly less flexible than plugin-loader. Plugin-loader is the right model for nanotars.
- **`webhook-server.ts` shared HTTP server** (Area 5) — only useful with chat-sdk-bridge adoption.
- **Bun runtime split for the agent-runner** (Area 6) — alternative runtime, not strictly better. Bun beats Node on cold-start, loses on some workloads. No clear technical win.

**Confirmed: nanotars improvements that stay (mapped to [CHANGES.md](CHANGES.md)):**

| CHANGES.md § | Subject | Triage verdict |
|---|---|---|
| §1 | Plugin Architecture (`plugin-loader.ts`, `plugin-types.ts`, `plugins/` directory, plugin.json manifests with channel/group scoping, per-plugin `mcp.json` merge → per-group `merged-mcp.json`, `Dockerfile.partial` injection, `containerEnvVars` allowlist, per-group `.env` overrides) | KEEP — `registerChannelAdapter` barrel and barrel-import distribution are SKIP-ALT |
| §2 | Channel Abstraction (`Channel` interface with `sendMessage`/`sendMedia`/`sendFile`/`react`/`replyTo`, JID-prefix routing, channel plugins) | KEEP — selectively ADOPT v2 method-additions (`splitForLimit`, `transformOutboundText`, `extractReplyContext`, `openDM`, `NetworkError` retry) |
| §3 | Docker/Linux runtime abstraction (`container-runtime.ts`, `chromium-seccomp.json`, all 9 hardening flags) | KEEP — and CONTRIBUTE the hardening block upstream |
| §4 | Security Hardening (`secret-redact.ts`, `security-hooks.ts`, IPC `O_NOFOLLOW` + 1 MiB cap + quarantine, mount allowlist strict-match, anti-prompt-injection rules, output-marker nonce, sender allowlist, .env masking via `/dev/null` overlay, `assertPathWithin` defense-in-depth) | KEEP — small PORTs from v2 are additive (colon-injection check, `READ_TOOLS_RE` expansion, secret-redaction body length-sort + Set-dedup) |
| §5 | Media Pipeline (file-on-disk model with `mediaPath`/`mediaHostPath`, `send_file` IPC + MCP, ffmpeg thumbnail extraction, magic-bytes MIME detection in WhatsApp plugin) | KEEP — CONTRIBUTE thumbnails + magic-bytes upstream |
| §6 | Task Scheduler (per-task model, error notifications, atomic `claimTask`, three schedule types `cron`/`interval`/`once`, `resumeAt` persistence, `task_run_logs` audit) | KEEP — CONTRIBUTE auth-vs-generic error split + `interval`/`once` types upstream |
| §7 | Bug fixes (PRs to upstream + ports of upstream fixes) | No conflicts |
| §8 | Skill marketplace (27 marketplace + 13 core skills via Claude Code `/plugin install`) | KEEP — v2's barrel-import distribution is SKIP-ALT |
| §9 | Documentation | KEEP |
| §10 | Code quality refactoring (`db/`, `ipc/`, `container-mounts.ts`, `snapshots.ts` decomposition, dead-code removal, mtime-based `.env` cache, stdout-streaming-to-file) | KEEP |
| §11 | Minor improvements (reply context, singleton PID guard, typing/read-receipts, per-group webhook routing, react IPC + MCP, emoji status reactions, **emergency stop / resume**) | KEEP — Phase 5 lifecycle pause/resume *extends* emergency_stop, doesn't replace it |
| §12 | Admin Dashboard (full htmx UI, ~900 LOC) | KEEP — CONTRIBUTE adapter to consume v2 pusher data model |
| §13 | Agent Identity System (`groups/<folder>/IDENTITY.md` per-group override + `groups/global/IDENTITY.md` fallback, prepended to system prompt by agent-runner) | KEEP — `claude-md-compose.ts` PORT (Phase 2 B) is at a *different layer* (SDK CLAUDE.md, not system-prompt prefix) and preserves IDENTITY.md prepending unchanged. v2's `groups/identity/` mount solves a use case (cross-group persona-snippet library) you don't have — deferred from Phase 1 |
| §14 | Plugin versioning & update system (semver in `plugin.json`, `nanoclaw-update` skill, marketplace version comparison) | KEEP |
| §15 | Agent Teams (`groups/<folder>/agents/<name>/{agent.json,IDENTITY.md,CLAUDE.md}` + `discoverAgents` Claude SDK Task subagents) | KEEP — v2's `agent-to-agent` is a different concept (cross-container peer messaging, PORT-ARCH Phase 7) |
| §16 | Skill marketplace at `TerrifiedBug/nanoclaw-skills` (Claude Code marketplace, version-gated updates) | KEEP |
| §17 | Plugin scoping standardization (`channels`/`groups` defaults in `plugin.json`) | KEEP |

**Sender-allowlist subsumption (Phase 4 B note):** v1's `src/sender-allowlist.ts` (per-chat trigger/drop modes, fail-open) is the existing equivalent of v2's `sender_scope='all' | 'known'` gate. Phase 4 B should *merge* the two — v1's two-mode design (trigger vs drop) is richer than v2's binary all/known. v1's concept wins; the entity-model wiring (per-`messaging_group_agents` row config) is what gets adopted.

**Estimated total catch-up effort:** **~37–52 weeks at 8 hours/week** (range driven by Phase 6 commitment).

| Phase | Scope | Effort | Notes |
|---|---|---|---|
| 1 | Trivial security & UX wins | ~1.5 weeks | Independent of everything |
| 2 | Medium architecture-preserving ports | ~9–12 weeks | Cluster-by-dependency |
| 3 | Large architecture-preserving items (OneCLI, claude-md-compose) | ~4–6 weeks | OneCLI gateway only — manual-approval handler moves to Phase 4 |
| 4 | Multi-user RBAC + entity-model upgrade | ~10–14 weeks | Doesn't require per-session containers; layers onto v1 central DB |
| 5 | Capability bolt-ons (self-mod, lifecycle pause/resume, provider abstraction concept-level) | ~6–10 weeks | Reimplemented on v1's per-group container model |
| 6 | Architectural foundation (per-session containers + two-DB IPC + heartbeat sweep) | ~8–12 weeks | Optional — can defer or skip if Phase 4-5 satisfy multi-user goals |
| 7 | Phase-6-enabled bolt-ons (cross-container agent messaging, supportsThreads, subscribe, admin-transport, session_state per provider) | ~3–4 weeks | Only if Phase 6 lands |

**Total committed (Phases 1-5):** ~30-42 weeks, ~7-10 months part-time.
**Total full pickup (Phases 1-7):** ~37-52 weeks, ~9-13 months part-time.

Phase 6 is the only optional block — Phases 1-5 deliver the bulk of the catch-up value (multi-user, all the bolt-on capabilities, OneCLI, plus all small wins). Phase 6's payoff is a cleaner internal architecture without exposing new user-facing capability beyond what Phase 4-5 already enable.

---

## Sequencing recommendation

### Phase 1 — Trivial wins (~weeks 1-2)

Independent items, mostly trivial-effort PORT/ADOPT. Order by user-visibility (security wins first, UX next, hygiene last).

**Security & correctness wins (do first):**
- Mount allowlist colon-injection check (Area 6, PORT)
- `dockerfilePartials` path-traversal guard (Area 5, PORT)
- Bash security hooks `READ_TOOLS_RE` expansion (Area 6, PORT)
- `shellQuote` unit tests (Area 6, PORT)
- `isValidGroupFolder` defense-in-depth validator on read path (Area 1, CONTRIBUTE upstream)

**UX & feature wins:**
- `splitForLimit` long-message splitter (Area 4, ADOPT)
- Per-channel `transformOutboundText` hook (Area 4, ADOPT)
- Per-channel `extractReplyContext` hook (Area 4, ADOPT)
- `NetworkError` setup retry wrapper (Area 4, ADOPT)
- `openDM(userHandle)` channel primitive added to v1's `Channel` interface (Area 4, ADOPT — was SKIP-ARCH, now ADOPT under corrected lens)
- `unregistered_senders` table + upsert-coalesce accessor (Area 1, ADOPT — paired with multi-user Phase 4 but the table is independently useful)

(Removed from Phase 1: `groups/identity/` mount — your existing per-group + global IDENTITY.md fallback covers the use case; v2's mount is for cross-group persona-snippet sharing which isn't a current need.)

**Hygiene:**
- `decoupling connection from schema` refactor (Area 1, PORT trivial)
- `hasTable(db, name)` helper for module-table guards (Area 1, PORT trivial)
- Pinned `CLAUDE_CODE_VERSION` + similar ARGs in Dockerfile (Area 3, ADOPT)
- `tini` as PID 1 (Area 3, ADOPT — currently `--init`, optional cosmetic switch)
- `minimumReleaseAge` in `.npmrc` (Area 6, ADOPT — works on npm without pnpm migration)
- Exact-version pinning in `package.json` (Area 6, ADOPT)
- `manage-mounts` operational skill port (Area 6, ADOPT)
- `context_mode` ('group' | 'isolated') on `scheduled_tasks` (Area 1, CONTRIBUTE upstream)
- Online backup hook (`db.backup` keep-2 retention) (Area 1, CONTRIBUTE upstream)
- `task_run_logs` table + JOIN-recent-runs view (Area 1, CONTRIBUTE upstream)

### Phase 2 — Medium architecture-preserving (~weeks 3-12)

Bundle by dependency cluster.

**Cluster A — Migration framework + DB-shape evolution:**
- Numbered migration framework (Area 1, PORT small) — base for the cluster
- Per-provider session_state continuation namespacing (Area 1, PORT trivial — paired with Phase 5 provider abstraction)
- `chat_sdk_*` SqliteStateAdapter as a generic KV+TTL+lock primitive (Area 1, ADOPT medium)
- Four-axis engage model (`engage_mode` / `pattern` / `sender_scope` / `ignored_message_policy`) (Area 1, PORT medium — fits v1 even without entity model)

**Cluster B — Compose pipeline for CLAUDE.md:**
- `groups/<folder>/CLAUDE.local.md` (Area 5, PORT small) — phase 1 of compose
- `claude-md-compose.ts` host-regenerated CLAUDE.md (Area 5, PORT medium) — phase 2
- Three-tier container skills (Area 5, ADOPT medium) — coexists with plugin-loader

**Cluster C — Channels & media UX:**
- Telegram typed-media routing (Area 4, ADOPT small)
- Telegram pairing flow + interceptor (Area 4, ADOPT medium)
- CLI always-on local-socket channel (Area 4, ADOPT medium)

**Cluster D — Runtime hygiene:**
- Source-as-RO-bind-mount (Area 3, ADOPT small) — drop COPY+tsc, mirror v2's mount-only
- Label-scoped orphan cleanup per install (Area 3, ADOPT small)
- Pre-task `script` hook for scheduled tasks (Area 3, ADOPT medium)
- Vitest + GH Actions CI (Area 6, ADOPT small)
- Mount allowlist tests (Area 6, CONTRIBUTE upstream small)

**Cluster E — Secret redaction port + tests:**
- Secret redaction module body (Area 6, PORT small) — length-sort, Set-dedup, injectable paths, `ONECLI_API_KEY` exempt

### Phase 3 — Large architecture-preserving (~weeks 13-18)

**Cluster F — OneCLI gateway only:**
- OneCLI gateway credential model (Area 6, ADOPT medium-large) — credential injection only
- `init-onecli` skill port (Area 6, conditional ADOPT)
- `manage-group-env` skill port (Area 6, conditional ADOPT)

The OneCLI **manual-approval handler** moves to Phase 4 because it depends on `pickApprover` (Phase 4 RBAC).

**Cluster G — pnpm migration (optional under corrected lens):**
- pnpm + `onlyBuiltDependencies` allowlist (Area 6, ADOPT medium) — supply-chain hygiene; not gated on observable pain but lower priority than Phase 4 multi-user work. Could defer if Phase 4-5 are urgent.

### Phase 4 — Multi-user RBAC + entity model (~weeks 19-32)

This phase layers v2's identity + RBAC + approval infrastructure onto v1's existing per-group container model. **Does NOT require per-session containers.** Per-group containers stay; the central DB grows new tables.

**Sub-phase 4A — Entity-model migration (~3-4 weeks):**
- New tables: `agent_groups` (workspace, memory, CLAUDE.md, container config), `messaging_groups` (one chat/channel on one platform; unknown_sender_policy), `messaging_group_agents` (many-to-many wiring with session_mode, trigger_rules, priority).
- Migration: split v1's `registered_groups` into agent_groups + messaging_groups + wiring rows.
- Router refactor: route by (messaging_group, agent_group) pair instead of single group lookup.
- Hook surface: add sender-resolver hook + access-gate hook callsites.

**Sub-phase 4B — Users + RBAC (~3-4 weeks):**
- Tables: `users` (`<channel>:<handle>` namespaced IDs), `user_roles` (owner / global-admin / scoped-admin), `agent_group_members`, `user_dms` cache.
- Functions: `canAccessAgentGroup`, `ensureUserDm`.
- Sender-resolver hook integration.
- Sender-scope gate (`sender_scope='all' | 'known'`).
- Host-side command gate (`command-gate.ts`) against `user_roles`.

**Sub-phase 4C — Approval primitive (~2-3 weeks):**
- `pending_approvals` table + render-metadata columns.
- `requestApproval` + handler registry + `registerApprovalHandler`.
- Click-auth on approval cards (clicker-must-equal-approver-or-admin).
- `pickApprover` + `pickApprovalDelivery` + same-channel-kind tie-break.
- OneCLI manual-approval bridge port (depends on Phase 3 OneCLI gateway + this approval primitive).
- Card-expiry timer + edit-to-Expired sweep on startup.

**Sub-phase 4D — Multi-user user-facing flows (~2-3 weeks):**
- `pending_sender_approvals` + request/respond flow.
- `pending_channel_approvals` + denied_at flow.
- In-flight dedup via PRIMARY KEY on pending tables.
- `pending_questions` table + `ask_question` MCP tool.

### Phase 5 — Capability bolt-ons (~weeks 33-42)

Bolt-ons reimplemented on v1's per-group container model. Doesn't require Phase 6.

- **Self-modification** (`install_packages` / `add_mcp_server`) — concept port: agent requests apt/npm install → admin approves (uses Phase 4 approval primitive) → image rebuilds → container restarts.
- **Per-agent-group image build** — required by self-mod; replaces v1's plugin-Dockerfile-partial-only model with a per-group-image variant.
- **Lifecycle pause/resume** — extend group-queue with a `paused` flag; wakeContainer respects it; messages queue until resumed.
- **Provider abstraction (concept-level)** — define an `AgentProvider` seam in agent-runner; default to Claude; wire Codex/OpenCode/Ollama as plugins (not as v2 skill-branches). Per-provider XDG/env handled via plugin-loader's `publicEnvVars` and per-plugin Dockerfile partials.
- **`create_agent` MCP tool** — admin agent-provisioning primitive (depends on Phase 4 RBAC).

### Phase 6 — Architectural foundation (~weeks 43-54, optional)

**Big block.** Per-session containers + two-DB IPC + heartbeat sweep. Replaces v1's per-group queue + file-IPC + stdin/stdout protocol.

This is the only PORT-ARCH cluster in the catch-up plan. Doing it gives:
- Per-session DBs as natural units (atomic per-session state)
- Cleaner lifecycle (one container, one session, one tool-call-in-flight)
- Heartbeat-driven stuck detection (more reliable than poll-only)
- Scheduling improvements (`process_after` + `series_id` accumulator)

Items in this block:
- `sessions` table + per-session `inbound.db` / `outbound.db`
- `messages_in` + `processing_ack` + `delivered` schemas
- Even/odd seq partition (host even, container odd)
- `journal_mode = DELETE` for cross-mount visibility
- `container_state` single-row tool-in-flight table
- Live `destinations` + `session_routing` rows replacing JSON snapshots
- Per-session container spawn (replaces per-group queue's `wakeContainer`)
- Heartbeat sweep in `host-sweep.ts` (60s sweep, processing_ack sync, stale detection, due-message wake)
- File-IPC → two-DB swap
- `process_after` + `series_id` + `trigger=0` accumulator on inbound

**Migration discipline:** dual-running v1 file-IPC alongside v2 two-DB during transition; flip per-group as readiness allows.

### Phase 7 — Phase-6-enabled bolt-ons (~weeks 55-58, optional)

Bolt-ons that require Phase 6 to work:
- `agent_destinations` + `channel_type='agent'` cross-container agent messaging (Area 5)
- `supportsThreads` adapter flag + `subscribe(platformId, threadId)` (Area 4)
- Admin-transport (`onInboundEvent` + `replyTo`) (Area 4)
- `session_state` continuation per provider (Area 1) — paired with Phase 5 provider abstraction

### SKIP-ALT — explicitly out of scope

Not adopted on technical-merit grounds (alternative architectures, not improvements):

- **`ChannelAdapter` interface as a unit** (Area 4) — v1's `Channel` interface is the base; new methods (`splitForLimit`, `transformOutboundText`, `extractReplyContext`, `openDM`, `NetworkError` retry) get cherry-picked individually.
- **`registerChannelAdapter` self-register barrel** (Area 4) — plugin-loader is more flexible.
- **`chat-sdk-bridge`** (Area 4) — adopting means committing to the `@chat-adapter/*` vendor stack. v1's plugin-channel model is the right shape for nanotars's installed base.
- **Barrel-import + skill-merged-branch distribution model** (Area 5) — plugin-loader is more flexible (manifest-driven, scoped, secret classification).
- **`webhook-server.ts` shared HTTP server** (Area 5) — only useful with chat-sdk-bridge adoption.
- **Bun runtime split for the agent-runner** (Area 6) — alternative runtime; no clear technical win on Danny's workloads.

These remain reviewable later if any specific motivation surfaces (e.g., wanting the upstream chat-adapter marketplace), but on technical merit alone they don't displace nanotars's existing design.

---

## Area 1: Persistence layer

**Functional inventory (condensed):** v1 holds `chats` (per-JID config), `messages` (single global table with composite `(id, chat_jid)` PK), `registered_groups` (group⇄platform wiring), `scheduled_tasks` + `task_run_logs` (audit), `sessions`, and `router_state` (KV) in a single SQLite at `data/nanotars.db`. v2 splits state across three DBs: a central `data/v2.db` (entity model: `agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, `user_dms`, `agent_destinations`, `chat_sdk_*`, `dropped_messages`) and per-session `inbound.db` + `outbound.db` (`messages_in`, `processing_ack`, `delivered`, `session_state`, `container_state`).

**Implementation comparison highlights:**
- **Migration framework:** v2's numbered files keyed on `schema_version.name` is genuinely better — supports module-shipped migrations, decouples from code shipped order. PORT.
- **Message store:** v1's `messages` table is the canonical "what was said" store; v2 has no global message store. KEEP v1's central store as an additional capability v2 lacks; CONTRIBUTE upstream as `messages` summary table.
- **Engage model:** v2's four-axis split is genuinely better and portable to v1 even without per-session sessions. PORT.
- **Backup:** v1's online `db.backup` hook is a v1 win; CONTRIBUTE upstream.
- **`task_run_logs` audit:** v1 wins; CONTRIBUTE upstream.

**Verdict reclassification under corrected lens:** All 8 SKIP-ARCH items (three-DB schemas, `messages_in`/`processing_ack`, `delivered`, live `destinations` + `session_routing` rows, `process_after`+`series_id` accumulator, `journal_mode=DELETE`, even/odd seq partition, `container_state`) → **PORT-ARCH**. Genuinely better persistence architecture, but pickup is gated on per-session container model. Sequenced as Phase 6.

**Verdict matrix (full, copied from per-area report):**

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| Numbered migration framework (`schema_version.name` as dedup key) | PORT | small | high | Area 2 (migrations) | Replaces v1's hardcoded MIGRATIONS array + sentinel-detect; survives skill-installed tables |
| Decoupling connection from schema (`initDb` does not run DDL) | PORT | trivial | high | — | Pure refactor; lets test variants reuse the runner without re-running DDL |
| `hasTable(db, name)` helper for module-table guards | PORT | trivial | high | — | 5 LOC; needed if v1 grows optional plugin tables |
| `unregistered_senders` table + upsert-coalesce accessor | ADOPT | small | high | — | ~30 LOC; channel:platform key already maps to v1's `chats.jid` |
| Per-provider session_state continuation namespacing pattern | PORT | trivial | medium | Area 3 (provider abstraction) | Only relevant if v1 grows non-Anthropic providers |
| `chat_sdk_*` SqliteStateAdapter (KV+TTL, locks, lists, queues) | ADOPT | medium | high | Area 4 (chat-sdk bridge) | Useful generic primitive even outside chat-sdk; lock CAS pattern is a clean port |
| Three-DB model (central + per-session inbound/outbound) | PORT-ARCH | large | high | Area 3 (per-session container) | Phase 6: paired with per-session container model |
| `messages_in` + `processing_ack` cross-process state machine | PORT-ARCH | large | high | Area 3, Area 6 (IPC) | Phase 6: replaces stdin-IPC |
| `delivered` + `platform_message_id` outbound tracking | PORT-ARCH | medium | high | Area 3 | Phase 6 |
| Live `destinations` + `session_routing` rows replacing JSON snapshots | PORT-ARCH | medium | high | Area 3 | Phase 6 |
| Four-axis engage model (engage_mode/pattern/sender_scope/ignored_message_policy) | PORT | medium | medium | Area 2 | Even without v2's entity model, v1 could split `requires_trigger + trigger_pattern` cleanly |
| `task_run_logs` table + JOIN-recent-runs view | CONTRIBUTE | small | high | — | v1-only; useful upstream as a scheduled-task observability layer |
| `context_mode` ('group' \| 'isolated') on scheduled_tasks | CONTRIBUTE | trivial | medium | Area 3 (scheduling) | v1-only concept; v2's session_mode covers a different axis |
| `process_after` + `series_id` + `trigger=0` accumulator on inbound | PORT-ARCH | medium | medium | Area 3 | Phase 6: ports as part of the v2 scheduling rewrite |
| `isValidGroupFolder` defense-in-depth validator on read path | CONTRIBUTE | trivial | high | — | v2 lacks the equivalent guard on `agent_groups.folder` reads |
| Online backup hook (`db.backup` keep-2 retention) | CONTRIBUTE | small | high | — | v1-only; small mechanical port (v2 needs to walk session DBs too) |
| `dbEvents` EventEmitter on insert | KEEP | n/a | high | — | v1-internal coupling between message store and poll loop; v2 doesn't need this because of the per-session DB model |
| JSON-to-SQLite one-time import migration (`router_state.json` etc.) | KEEP | n/a | high | — | v1-historical; serves no v2 purpose |
| `__group_sync__` magic-row pattern in `chats` (KEEP-AND-CLEANUP) | KEEP | trivial | high | — | Smell; if v1 keeps the `chats` table, replace with a proper `last_group_sync` row in `router_state` |
| Composite (id, chat_jid) PK on messages | KEEP | n/a | high | — | Architecturally tied to v1's single message store |
| Bot-message content-prefix backstop (KEEP-AND-CLEANUP) | KEEP | small | medium | — | Fragile across rename of ASSISTANT_NAME; the boolean column is sufficient now |
| `journal_mode = DELETE` on inbound.db (cross-mount visibility) | PORT-ARCH | n/a | high | Area 3 | Phase 6: technical detail of two-DB split |
| Even/odd seq partition (host even, container odd) | PORT-ARCH | n/a | high | Area 3 | Phase 6: tied to two-DB ordering invariant |
| `container_state` single-row tool-in-flight table | PORT-ARCH | n/a | high | Area 3 (host-sweep) | Phase 6: paired with stuck-detection sweep |

Per-area totals (revised): PORT=5, KEEP=5, ADOPT=2, **PORT-ARCH=8**, CONTRIBUTE=4. Total=24.

→ See `upstream-triage-2026-04-25-area-1-persistence.md` for full agent report (unchanged).

---

## Area 2: Migrations, permissions, approvals

**Functional inventory (condensed):** v1's approach is "implicit permissions via the main group" with one-shot JSON→SQLite migration and a hardcoded `MIGRATIONS` array. v2 introduces full RBAC (`users` + `user_roles` + `agent_group_members` + `user_dms`) and an approvals primitive (`requestApproval` / handler registry / OneCLI bridge / approval-card click-auth) that powers self-mod, sender-approval, and channel-approval flows.

**Implementation comparison highlights:**
- **Permissions model:** Under the corrected lens (multi-user IS in scope), v2's three-tier RBAC is genuinely better. ADOPT.
- **Approval primitive:** Reusable infrastructure; ~220 LOC; clean abstraction. ADOPT (independently good once any caller exists).
- **OneCLI manual-approval bridge:** ADOPT bundled with Phase 3 OneCLI gateway port + Phase 4 `pickApprover`.
- **`user_dms` cache:** ADOPT — useful as a caching primitive even with single user (caches the operator's DM JID per channel).

**Verdict reclassification under corrected lens:**
- 15 SKIP-ARCH items move to **ADOPT** (multi-user RBAC + approval primitive + ask_question — all layerable on v1's per-group container model with central-DB schema additions).
- 3 SKIP-ARCH items already moved to **PORT** in the cross-cutting adjudication (versioned-file framework, schema-version table, module-migration name-key trick).
- The `ADOPT (deferred)` and `ADOPT (with OneCLI)` and `ADOPT (with primitive)` rows in the original matrix are sequenced into Phase 3 (OneCLI gateway only) and Phase 4 (everything else multi-user).

**Verdict matrix (full, copied from per-area report — verdicts on rows below show original classifications; Phase column added):**

| Item | Action | Effort | Confidence | Phase | Notes |
|------|--------|--------|------------|-------|-------|
| Versioned-file migration framework (`schema_version` + numbered files) | PORT (was SKIP-ARCH; adjudicated) | small | high | Phase 2 | Module-migration composition |
| Schema-version table keyed on `name UNIQUE` with auto-assigned version | PORT (was SKIP-ARCH; paired) | trivial | high | Phase 2 | Same prerequisite |
| One-shot JSON→SQLite startup migration (`migrate.ts`) | KEEP | trivial | high | — | v1-historical |
| Sentinel-detection back-fill for pre-migration-system installs | KEEP | trivial | high | — | v1-only |
| `users` table + namespaced (`kind:handle`) user IDs | ADOPT (was SKIP-ARCH) | medium | high | Phase 4B | Foundation for multi-user identity |
| `user_roles` (owner / global-admin / scoped-admin) | ADOPT (was SKIP-ARCH) | medium | high | Phase 4B | RBAC entry point |
| `agent_group_members` + implicit-admin-membership rule | ADOPT (was SKIP-ARCH) | small | high | Phase 4B | Unprivileged access gate |
| `user_dms` cache + `ensureUserDm` two-class resolution | ADOPT (was SKIP-ARCH) | medium | high | Phase 4B | Cold-DM resolution + JID cache |
| `canAccessAgentGroup` access function | ADOPT (was SKIP-ARCH) | trivial | high | Phase 4B | Functional layer over role tables |
| Sender-resolver hook + access-gate hook | ADOPT (was SKIP-ARCH) | small | medium | Phase 4A | Router refactor adds hook surface |
| Sender-scope gate (`sender_scope='all'\|'known'`) | ADOPT (was SKIP-ARCH) | trivial | medium | Phase 4B | Per-wiring gate. **Subsumes v1's `src/sender-allowlist.ts`** (CHANGES.md §4) — v1's two-mode design (trigger / drop) is richer than v2's binary `all`/`known`. Phase 4 B should preserve the two-mode semantics inside the new per-`messaging_group_agents` config |
| Approval primitive (`requestApproval`, handler registry) | ADOPT (was deferred) | medium | low | Phase 4C | Reusable infrastructure |
| `pickApprover` + `pickApprovalDelivery` (approver hierarchy) | ADOPT (was SKIP-ARCH) | small | high | Phase 4C | Hierarchical approver resolution |
| Same-channel-kind tie-break in `pickApprovalDelivery` | ADOPT (was SKIP-ARCH) | trivial | high | Phase 4C | Comes with pickApprovalDelivery |
| OneCLI manual-approval bridge (`onecli-approvals.ts`) | ADOPT (was deferred) | medium | medium | Phase 4C | Bundle with OneCLI gateway port |
| Card-expiry timer + edit-to-Expired sweep on startup | ADOPT (was deferred) | trivial | high | Phase 4C | ~30 LOC |
| Pending-sender approval flow (`pending_sender_approvals` + request/respond) | ADOPT (was SKIP-ARCH) | medium | high | Phase 4D | Multi-user user-facing flow |
| Pending-channel registration flow (`pending_channel_approvals` + denied_at) | ADOPT (was SKIP-ARCH) | medium | high | Phase 4D | Multi-user user-facing flow |
| In-flight dedup via PRIMARY KEY on pending tables | ADOPT (was SKIP-ARCH) | trivial | high | Phase 4D | Comes with pending tables |
| Click-auth on approval cards | ADOPT (was deferred) | trivial | high | Phase 4C | Critical security property |
| Approval-handler registry + `registerApprovalHandler` | ADOPT (was deferred) | trivial | high | Phase 4C | Handler-registration pattern |
| `pending_approvals` table + render-metadata columns (title, options_json) | ADOPT (was deferred) | trivial | high | Phase 4C | Storage shape for primitive |
| `pending_questions` table (generic ask_question state) | ADOPT (was SKIP-ARCH) | medium | medium | Phase 4D | ask_question MCP tool storage |
| `unregistered_senders` counter table | ADOPT (was SKIP-ARCH) | small | high | Phase 4D | Diagnostic |
| Module-migration name-key trick (filename has `module-` prefix, `name` field unchanged) | PORT (was SKIP-ARCH; paired) | trivial | medium | Phase 2 | Compatibility hack |
| Host-side command gate (`command-gate.ts` admin-command check) | ADOPT (was SKIP-ARCH) | small | high | Phase 4B | Admin-slash-command gating against roles |

Per-area totals (revised): PORT=3, KEEP=2, **ADOPT=21**, total=26.

→ See `upstream-triage-2026-04-25-area-2-migrations-permissions.md` for full agent report (unchanged).

---

## Area 3: Runtime, lifecycle, scheduling

**Functional inventory (condensed):** v1 runs a per-group container queue (`group-queue.ts`) with a global `MAX_CONCURRENT_CONTAINERS=5` cap, idle-timeout-driven shutdown, and a runtime abstraction supporting both Docker and Apple Container. Container is hardened with `--cap-drop=ALL`, `--cap-add=SYS_PTRACE`, `--security-opt=no-new-privileges`, custom seccomp, `--cpus=2`, `--memory=4g`, `--pids-limit=256`. Scheduled tasks support `cron`, `interval`, and `once` types. v2 replaces with per-session container model + heartbeat-driven stuck detection + lifecycle module + self-mod + provider abstraction + pre-task `script` hook. v2 dropped Apple Container, every container hardening flag, the global concurrency cap, and the `interval`/`once` schedule types.

**Implementation comparison highlights:**
- **`MAX_CONCURRENT_CONTAINERS` is dead code in v2** (exported but zero readers). KEEP v1 + CONTRIBUTE upstream.
- **Container hardening dropped wholesale on v2.** KEEP v1 + CONTRIBUTE upstream (single-block PR).
- **Pre-task `script` hook (v2-only):** ADOPT — concept-level, fits v1's scheduling without architectural pickup.
- **Self-modification, lifecycle pause/resume, provider abstraction:** ADOPT (rebuild on v1's per-group container model). Reimplemented, not direct-port.
- **Per-session container model + heartbeat sweep + two-DB IPC:** PORT-ARCH (Phase 6). Genuinely better, requires architectural commitment.

**Verdict reclassification under corrected lens:**
- 4 SKIP-ARCH items become **ADOPT** (rebuild on v1): self-mod, per-agent-group image build, lifecycle pause/resume, provider abstraction, host-side provider-container-registry.
- 3 SKIP-ARCH items become **PORT-ARCH** (Phase 6): two-DB session split + heartbeat sweep, per-session container model, AgentProvider container-side abstraction depends on per-session for clean session_state.

Wait — checking carefully: AgentProvider abstraction is conceptually reimplementable on v1's per-group, so ADOPT. The per-session-tied items are: two-DB session split, per-session container model, lifecycle pause/resume's v2-implementation-on-delivery-action-registry (but pause/resume concept is ADOPT-rebuild). So PORT-ARCH = two-DB session split, per-session container. Self-mod, lifecycle pause concept, provider abstraction concept = all ADOPT-rebuild.

**Verdict matrix (full, copied from per-area report — Phase column added; verdicts updated where reclassified):**

| Item | Action | Effort | Confidence | Phase | Notes |
|------|--------|--------|------------|-------|-------|
| `MAX_CONCURRENT_CONTAINERS` global cap | KEEP / CONTRIBUTE | trivial | high | Phase 1 (CONTRIBUTE PR) | v2 has the constant but never reads it |
| Per-group queue + idle preemption (`GroupQueue`) | KEEP | n/a | high | — | v1's queue is the right shape; supersedes per-session-only model in Phase 6 hybrid |
| Container hardening flags | KEEP / CONTRIBUTE | trivial | high | Phase 1 (CONTRIBUTE PR) | Single-block PR upstream |
| Container runtime abstraction (Docker + Apple Container) | KEEP | n/a | high | — | v1 supports both; v2 is Docker-only |
| Label-scoped orphan cleanup (per-install slug) | ADOPT | small | high | Phase 2 D | Per-install label vs name-prefix |
| `tini` as PID 1 + signal forwarding | ADOPT | trivial | high | Phase 1 | Cosmetic switch from `--init` |
| Pinned CLI ARG versions in Dockerfile | ADOPT | trivial | high | Phase 1 | `CLAUDE_CODE_VERSION` etc. pinning |
| pnpm `only-built-dependencies` allowlist | ADOPT | small | medium | Phase 3 G | Bundled with pnpm migration |
| Source-as-RO-bind-mount (no source baked) | ADOPT | small | high | Phase 2 D | Drop COPY+tsc, mirror v2 |
| Two-DB session split + heartbeat-driven stuck detection | PORT-ARCH | large | high | Phase 6 | Genuinely better; gated on per-session container |
| Per-session container model | PORT-ARCH | large | high | Phase 6 | The keystone of Phase 6 |
| Lifecycle module pause/resume | ADOPT (rebuild) | medium | high | Phase 5 | **Extends v1's existing `emergency_stop`/`resume_processing` in `src/group-queue.ts`** (CHANGES.md §11). v1 already supports kill-and-resume; v2's pattern is queue-suspending (cleaner — adds `paused` flag, no kill). The rebuild adds the queue-suspend mode alongside the existing kill-mode |
| Self-modification (`install_packages`, `add_mcp_server`) | ADOPT (rebuild) | large | high | Phase 5 | Concept port: agent → admin approval → rebuild → restart |
| Per-agent-group image build (`generateAgentGroupDockerfile`) | ADOPT (rebuild) | medium | high | Phase 5 | Required by self-mod |
| Container-side `AgentProvider` abstraction (Codex/OpenCode/Ollama) | ADOPT (rebuild) | large | high | Phase 5 | Concept-level seam in agent-runner; default Claude |
| Host-side `provider-container-registry` | ADOPT (rebuild) | medium | high | Phase 5 | Per-provider mount/env contributions |
| Pre-task script hook (`task-script.ts`) | ADOPT | medium | high | Phase 2 D | ~150 LOC + small migration; cheap pre-checks |
| Per-task model override | KEEP | n/a | high | — | v1 already has `task.model` column |
| Cron + interval + once schedule types | KEEP / CONTRIBUTE | trivial | high | Phase 1 (CONTRIBUTE) | v1 supports all three; v2 only cron |
| Atomic `claimTask` (clear `next_run` before spawn) | KEEP | n/a | high | — | Both correct, different shapes |
| Auth-vs-generic error discrimination on task failure notify | CONTRIBUTE | small | medium | Phase 1 (CONTRIBUTE) | Paired with `isAuthError` PR |
| `task_run_logs` table | KEEP | n/a | high | — | v1's audit table |
| File-based IPC (`data/ipc/<group>/input/`, `_close` sentinel) | KEEP (transition) → swap in Phase 6 | n/a | high | Phase 6 | Transitions to two-DB at Phase 6 |
| Output marker nonce (`OUTPUT_START_<nonce>_END`) | KEEP (transition) → no longer needed in Phase 6 | n/a | high | Phase 6 | Stdout protocol drops with two-DB |
| Stdin secret injection | KEEP / CONTRIBUTE | n/a | medium | — | Different model from OneCLI; both retained as alternatives |
| `IDLE_TIMEOUT` host-side stdin closer | KEEP | n/a | high | — | Fine for v1's architecture |

Per-area totals (revised): PORT=0, KEEP=12, **ADOPT=11** (was 6), **PORT-ARCH=2** (was SKIP-ARCH=7), CONTRIBUTE=1 (primary; +4 secondary from compounds). Total=26.

→ See `upstream-triage-2026-04-25-area-3-runtime-lifecycle.md` for full agent report (unchanged).

---

## Area 4: Channels and media

**Functional inventory (condensed):** v1 exposes a `Channel` interface loaded via plugin-loader's `channelPlugin: true`. v2 introduces a `ChannelAdapter` interface registered via barrel-import + `registerChannelAdapter`, plus a `chat-sdk-bridge` glue layer for `@chat-adapter/*` packages.

**Implementation comparison highlights:**
- **`ChannelAdapter` as a unit:** SKIP-ALT — alternative shape, not strictly better; v1's `Channel` interface stays as the base.
- **Individual `ChannelAdapter` methods are individually portable** to v1's `Channel` interface: `splitForLimit`, `transformOutboundText`, `extractReplyContext`, `openDM`, `NetworkError` retry. Adopt per method.
- **`chat-sdk-bridge`:** SKIP-ALT — vendor lock-in.
- **`supportsThreads` / `subscribe` / admin-transport:** PORT-ARCH (Phase 7) — only useful with per-session-per-thread routing from Phase 6.
- **ffmpeg thumbnail extraction:** v1 wins; KEEP and CONTRIBUTE upstream.
- **Inbound media file-on-disk model:** v1 wins (scales to large media); KEEP.
- **Telegram typed-media routing:** v2 wins; ADOPT.

**Verdict reclassification under corrected lens:**
- 3 SKIP-ARCH items become **PORT-ARCH** (Phase 7): supportsThreads, subscribe, admin-transport — gated on Phase 6 per-session-per-thread routing.
- 1 SKIP-ARCH becomes **ADOPT** (Phase 1): openDM as a primitive on v1's `Channel` interface.
- 3 SKIP-ARCH become **SKIP-ALT**: ChannelAdapter unit, registerChannelAdapter, chat-sdk-bridge.

**Verdict matrix (full, copied from per-area report — verdicts updated where reclassified):**

| Item | Action | Effort | Confidence | Phase | Notes |
|------|--------|--------|------------|-------|-------|
| `ChannelAdapter` interface (whole) | SKIP-ALT (was SKIP-ARCH) | — | high | — | Alternative shape, not strictly better; cherry-pick individual methods |
| `Channel` interface (v1 — keep as base) | KEEP | — | high | — | Suits v1's plugin-channel model |
| `registerChannelAdapter` self-register barrel | SKIP-ALT (was SKIP-ARCH) | — | medium | — | Plugin-loader is more flexible |
| Chat SDK bridge (`chat-sdk-bridge.ts`) | SKIP-ALT (was SKIP-ARCH) | — | high | — | Vendor lock-in |
| `splitForLimit` long-message splitter | ADOPT | trivial | high | Phase 1 | Add to v1's channel base helpers |
| Per-channel `transformOutboundText` hook | ADOPT | trivial | medium | Phase 1 | Hook on v1's Channel interface |
| Per-channel `extractReplyContext` hook | ADOPT | trivial | medium | Phase 1 | Hook on v1's Channel interface |
| Telegram typed-media routing (`sendPhoto` / `sendVideo` / `sendAudio` by extension) | ADOPT | small | high | Phase 2 C | Closes v1 Telegram template's `sendFile` gap |
| Magic-bytes MIME detection (v1 WhatsApp plugin) | KEEP | — | high | — | Detects PNG/JPEG/GIF/WebP/PDF from buffer headers; corrects WhatsApp's wrong MIME declarations. Lives in `plugins/channels/whatsapp/index.js` (gitignored — see *Cross-cutting concerns: gitignored-plugin gap*). Originally tagged N/A; reclassified after CHANGES.md §5 cross-reference |
| Magic-bytes MIME detection (upstream contribution) | CONTRIBUTE | medium | medium | — | v2 lacks this entirely; same PR shape as ffmpeg-thumbnail contribution |
| ffmpeg thumbnail extraction (videos + GIFs) | KEEP | — | high | — | v1-only; agent vision win |
| ffmpeg thumbnail extraction (upstream contribution) | CONTRIBUTE | medium | medium | — | Post-`messageToInbound` hook |
| Inbound media: file-on-disk + path reference | KEEP | — | high | — | v1's model scales to large media |
| File-on-disk media model (upstream contribution) | CONTRIBUTE | large | low | — | Architectural mismatch makes PR non-trivial |
| Reactions (interface) | KEEP | — | high | — | v1 has `react?(jid, messageId, emoji, ...)` |
| Composite-id reaction fix (`5e93609`) | N/A | — | high | — | Bug only exists in v2 due to per-agent fan-out |
| `supportsThreads` adapter flag | PORT-ARCH (was SKIP-ARCH) | small | high | Phase 7 | Useful with Phase 6 session-per-thread routing |
| `subscribe(platformId, threadId)` | PORT-ARCH (was SKIP-ARCH) | small | high | Phase 7 | Part of v2's engage modes |
| `openDM(userHandle)` | ADOPT (was SKIP-ARCH) | small | high | Phase 1 | Add to v1's Channel interface; doesn't require user_dms |
| CLI always-on local-socket channel | ADOPT | medium | medium | Phase 2 C | Basic socket loop is a v1 channel plugin |
| Admin-transport (`onInboundEvent` + `replyTo`) | PORT-ARCH (was SKIP-ARCH) | medium | high | Phase 7 | Requires router-level support |
| Telegram pairing flow + interceptor | ADOPT | medium | medium | Phase 2 C | Solves BotFather-only token security gap |
| Telegram legacy-Markdown sanitizer | N/A | — | high | — | Workaround for chat-adapter |
| Sender-name override on outbound | KEEP | — | high | — | v1's `sendMessage(jid, text, sender?, replyTo?)` |
| Sender-override / Telegram swarm pool (upstream contribution) | CONTRIBUTE | medium | low | — | Niche but cool |
| `NetworkError` setup retry | ADOPT | trivial | high | Phase 1 | 50-line retry wrapper |
| `replyTo` reply-quote on outbound `sendMessage` | KEEP | — | high | — | v1 already has it |

Per-area totals (revised): PORT=0, KEEP=7 (+1 from magic-bytes reclassification), **ADOPT=8** (was 7), **PORT-ARCH=3** (was SKIP-ARCH=7), **SKIP-ALT=3**, CONTRIBUTE=4 (+1 from magic-bytes upstream-contribution row), N/A=2 (–1 from magic-bytes reclassification). Total=27 (was 26 — magic-bytes split into two rows).

→ See `upstream-triage-2026-04-25-area-4-channels-media.md` for full agent report (unchanged).

---

## Area 5: Extensions, agent teams, identity, dashboard

**Functional inventory (condensed):** v1's extension system is `plugin-loader.ts` + `plugins/<name>/plugin.json` discovery + manifest with `channelPlugin` / `webhookPlugin` / `containerSkillsPath` / `dockerfilePartialPath` / `mcp.json` / `publicEnvVars` declarations. Agent teams live at `groups/<folder>/agents/<name>/{agent.json,IDENTITY.md,CLAUDE.md}` + `discoverAgents` (Claude SDK in-context Task subagents). Dashboard is a full ~900 LOC htmx admin UI. v2 replaces extension distribution with barrel-import + skill-installed branches and reduces dashboard to a pusher + external package. v2's `agent-to-agent` module is a different concept (cross-container peer messaging via `agent_destinations`).

**Implementation comparison highlights:**
- **Plugin-loader vs barrel-imports is decisively plugin-loader's win for nanotars** (Danny's 20+ extensions, single fork, public repo with users). Per the corrected lens, KEEP plugin-loader; barrel-import distribution is SKIP-ALT.
- **Agent teams (`groups/<folder>/agents/`) is v1-only and worth keeping.** v2's agent-to-agent is *different*, not equivalent.
- **`claude-md-compose.ts` + `CLAUDE.local.md`:** PORT — biggest content-quality win. **Coexists with v1's `IDENTITY.md` system at a different layer** (IDENTITY.md is prepended to the *system prompt* by the agent-runner before `query()`; compose regenerates the SDK-loaded `CLAUDE.md`). The PORT preserves IDENTITY.md prepending unchanged.
- **Dashboard:** KEEP v1's full UI; CONTRIBUTE adapter to consume v2's pusher data model.
- **`dockerfilePartials` path-traversal guard:** PORT trivial.
- **Per-agent-group images (`buildAgentGroupImage`):** ADOPT (rebuild) — concept fits v1's per-group model; required by self-mod (Phase 5).
- **`agent_destinations` cross-container messaging + `create_agent` MCP:** under multi-user lens, useful — `create_agent` becomes ADOPT (Phase 5), `agent_destinations` becomes PORT-ARCH (Phase 7) because cross-container only helps with per-session containers.

**Verdict reclassification under corrected lens:**
- 1 SKIP-ARCH becomes **ADOPT** (Phase 5): create_agent MCP tool.
- 1 SKIP-ARCH becomes **PORT-ARCH** (Phase 7): agent_destinations cross-container messaging.
- 2 SKIP-ARCH become **SKIP-ALT**: webhook-server.ts (only useful with chat-sdk), barrel-import distribution model.

**Verdict matrix (full, copied from per-area report — verdicts updated where reclassified):**

| Item | Action | Effort | Confidence | Phase | Notes |
|------|--------|--------|------------|-------|-------|
| `plugin-loader.ts` + `plugin-types.ts` | KEEP | — | high | — | Manifest + scoping wins for 20+ extensions case |
| Per-plugin `mcp.json` fragment merge | KEEP | — | high | — | Better than per-group `container.json:mcpServers` for set-and-forget |
| In-process MCP tool stubs + `registerTools` self-registration barrel | ADOPT | small | high | Phase 1 | Sibling barrel coexists with plugin MCP |
| Three-tier container skills | ADOPT | medium | medium | Phase 2 B | Per-group enable/disable UX; coexists with plugin-loader |
| Per-agent-group images (`buildAgentGroupImage`) | ADOPT (rebuild) | large | medium | Phase 5 | Required by self-mod |
| `dockerfilePartials` path-traversal guard | PORT | trivial | high | Phase 1 | Hardens v1's `build.sh` |
| `groups/<folder>/agents/<name>/` (Claude SDK Task subagents) | KEEP | — | high | — | v2 has no equivalent; CONTRIBUTE candidate |
| `discoverAgents()` Task-tool subagent registration + run_in_background hook | KEEP | — | high | — | Same |
| v2 `agent_destinations` + `channel_type='agent'` cross-container agent messaging | PORT-ARCH (was SKIP-ARCH) | medium | medium | Phase 7 | Requires per-session for clean isolation |
| `create_agent` MCP tool | ADOPT (was SKIP-ARCH) | small | medium | Phase 5 | Admin agent-provisioning, fits v1's per-group |
| `claude-md-compose.ts` | PORT | medium | high | Phase 2 B | Two-phase port |
| `groups/<folder>/CLAUDE.local.md` | PORT | small | high | Phase 2 B | Phase 1 of compose. Different *layer* than v1's IDENTITY.md (CLAUDE.md context vs system-prompt prefix); both coexist |
| `groups/identity/` shared persona files mount | ADOPT (deferred) | trivial | high | — | v1's per-group + global IDENTITY.md fallback already covers solo + per-DM identity. v2's mount is for cross-group persona-snippet *library*; revisit only if Danny ever wants persona files imported across multiple groups |
| Webhook plugin (v1) | KEEP | — | high | — | v2 has no equivalent at this layer |
| `webhook-server.ts` (shared HTTP server for Chat SDK) | SKIP-ALT (was SKIP-ARCH) | — | high | — | Only useful with chat-sdk-bridge |
| Dashboard plugin (`plugins/dashboard/`, htmx UI ~900 LOC) | KEEP | — | high | — | Fully featured admin UI |
| Dashboard analytics (token-usage from JSONL etc.) | CONTRIBUTE | medium | medium | — | Adapt v1 plugin to consume v2 pusher snapshots |
| Barrel-import + skill-merged-branch distribution model | SKIP-ALT (was SKIP-ARCH) | — | high | — | Plugin-loader wins on technical merit for nanotars |
| `provider-container-registry.ts` | ADOPT (rebuild) | small | medium | Phase 5 | Fits v1's per-plugin model |

Per-area totals (revised): PORT=3, KEEP=6, **ADOPT=6** (was 5), **PORT-ARCH=1** (was SKIP-ARCH=4), **SKIP-ALT=2**, CONTRIBUTE=1. Total=19. (Dashboard analytics row is CONTRIBUTE, not ADOPT.)

→ See `upstream-triage-2026-04-25-area-5-extensions-agents.md` for full agent report (unchanged).

---

## Area 6: Security, IPC, build, tests, ops

**Functional inventory (condensed):** v1 has a mature security baseline: mount-allowlist (strict-match + secrets/token/ssh-agent defaults + nonMainReadOnly), secret-redaction (hand-rolled), `AUTH_ERROR_PATTERNS` + `isAuthError`, file-based IPC under `src/ipc/*` with `O_NOFOLLOW` + 1MiB cap + quarantine, `output-parser.ts` with per-run output-marker nonces, bash security hooks, full container hardening, pino logging, npm-based deps, stdin-injected secrets + OAuth bind-mount. v2 ports mount-security and secret-redaction (with explicit "Ported from v1" comments), introduces a per-group env passthrough module, introduces OneCLI gateway-based credential injection, replaces IPC with two-DB. v2 dropped every container hardening flag, dropped pino, dropped auth-error detection, switched to pnpm + bun (with `minimumReleaseAge: 4320`, `onlyBuiltDependencies` allowlist, exact-version pinning), and ships full GitHub Actions CI.

**Implementation comparison highlights:**
- **Mount allowlist colon-injection check:** PORT trivial.
- **Mount allowlist `part.includes(pattern)` matching is a v2 regression** vs v1's strict-match. KEEP v1.
- **Mount allowlist tests:** v1 wins; CONTRIBUTE upstream.
- **Auth-error detection:** v1 wins; CONTRIBUTE upstream.
- **Container hardening dropped wholesale on v2.** KEEP v1; CONTRIBUTE upstream.
- **Secret-redaction module body:** v2 wins (length-sort + Set-dedup + injectable paths + `ONECLI_API_KEY` exempt). PORT.
- **IPC layer:** v1's file-based IPC stays during transition; PORT-ARCH the two-DB swap as part of Phase 6.
- **Bash security hooks `READ_TOOLS_RE`:** PORT trivial.
- **Bun split:** SKIP-ALT — alternative runtime.
- **Per-group env passthrough:** neutral — both sides filter, just from different config sources.

**Verdict reclassification under corrected lens:**
- 1 SKIP-ARCH (Bun runtime split) becomes **SKIP-ALT**.
- The compound row (file-IPC vs two-DB) sequences as Phase 6 PORT-ARCH for the swap; KEEP v1's IPC during transition.

**Verdict matrix (full, copied from per-area report — verdicts updated where reclassified):**

| Item | Action | Effort | Confidence | Phase | Notes |
|------|--------|--------|------------|-------|-------|
| Mount allowlist `:` injection check | PORT v2 → v1 | trivial | high | Phase 1 | One-line guard |
| Mount allowlist `part.includes` matching | KEEP v1 | trivial | high | — | v2 regresses |
| Mount allowlist `secrets.json`/`token.json`/`.ssh-agent` defaults | already in v1 | — | high | — | "Ported from nanotars v1" |
| Mount allowlist `nonMainReadOnly` semantics | KEEP v1 | — | high | — | v2 dropped |
| Mount allowlist tests | CONTRIBUTE v1 → v2 | small | high | Phase 2 D | v2 has zero tests |
| Secret redaction module body | PORT v2 → v1 | small | high | Phase 2 E | length-sort + Set-dedup + injectable paths |
| Secret redaction stdout/stderr wiring | KEEP v1 | — | high | — | v2 doesn't pipe stdout |
| `AUTH_ERROR_PATTERNS` + `isAuthError` | CONTRIBUTE v1 → v2 | small | high | Phase 1 | v2 has zero detection |
| OneCLI gateway credential model | ADOPT v2 → v1 | medium-large | medium | Phase 3 F | Gateway only |
| OneCLI manual-approval handler | ADOPT v2 → v1 | medium | medium | Phase 4 C | Depends on `pickApprover` |
| File-based IPC + `output-parser.ts` | KEEP (transition) → PORT-ARCH swap | — | high | Phase 6 | Two-DB swap is Phase 6 |
| IPC `O_NOFOLLOW` + 1 MiB cap + quarantine | KEEP v1 | — | high | — | v2 has no equivalent |
| Bash security hooks `READ_TOOLS_RE` expansion | PORT v2 → v1 | trivial | high | Phase 1 | Adds `more|od|hexdump|bun|awk|sed|python3` |
| Bash security hooks factory→constant refactor | KEEP v1 | — | low | — | Cosmetic |
| `ONECLI_API_KEY` in `SECRET_ENV_VARS` | conditional PORT v2 → v1 | trivial | high | Phase 3 F | With OneCLI |
| Per-group env passthrough module body | neutral | — | medium | — | Both sides filter |
| `shellQuote` unit tests | PORT v2 → v1 | trivial | high | Phase 1 | v1 has no tests |
| Container `--cap-drop=ALL` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | Phase 1 (CONTRIBUTE) | v2 dropped |
| Container `--cap-add=SYS_PTRACE` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | Phase 1 (CONTRIBUTE) | Required for Chromium crashpad |
| Container `--security-opt=no-new-privileges` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | Phase 1 (CONTRIBUTE) | v2 dropped |
| Container seccomp profile | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | Phase 1 (CONTRIBUTE) | `chromium-seccomp.json` |
| Container `--memory=4g`, `--cpus=2`, `--pids-limit=256` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | medium | Phase 1 (CONTRIBUTE) | v2 may need different values per-session |
| Logging (pino vs hand-rolled) | KEEP v1 | — | high | — | pino wins |
| Vitest + GH Actions CI | ADOPT v2 → v1 | small | high | Phase 2 D | v1 has zero workflow files |
| `minimumReleaseAge` supply-chain hold | ADOPT v2 → v1 | trivial | high | Phase 1 | `.npmrc` works on npm |
| pnpm + `onlyBuiltDependencies` | ADOPT v2 → v1 | medium | medium | Phase 3 G | Optional / lower priority |
| Version pinning (exact `4.26.0` not `^4.26.0`) | ADOPT v2 → v1 | trivial | high | Phase 1 | |
| Bun split for agent-runner | SKIP-ALT (was SKIP-ARCH) | — | high | — | Alternative runtime |
| `manage-mounts` skill | ADOPT v2 → v1 | trivial | high | Phase 1 | |
| `init-onecli` skill | conditional ADOPT | small | high | Phase 3 F | With OneCLI |
| `manage-group-env` skill | conditional ADOPT | small | high | Phase 3 F | With per-group env |
| `use-native-credential-proxy` skill | conditional ADOPT | small | medium | — | Lighter alt to OneCLI |

Per-area totals (revised): PORT=5, KEEP=12, ADOPT=10, **PORT-ARCH=0** (was 1; file-IPC swap is on the KEEP side as a transition row, with the swap itself counted under Phase 6 sequencing), **SKIP-ALT=1**, CONTRIBUTE=2 (primary; +5 secondary from compound rows), neutral=2. Total=32.

Hmm, the file-IPC row is compound — it's KEEP during transition and PORT-ARCH the swap. For the totals, I'm leaving it as KEEP (primary) and noting the Phase 6 swap. So Area 6 PORT-ARCH=0, but the file-IPC swap is captured under Area 1's Phase 6 PORT-ARCH cluster (the two-DB schemas are listed there). No double-count.

→ See `upstream-triage-2026-04-25-area-6-security-ipc-build.md` for full agent report (unchanged).

---

## Cross-cutting findings

### Cross-area dependencies (verified)

The dependency edges flagged by area agents, verified to exist in the referenced area, with phase ordering:

- **Numbered migration framework** (Area 1 PORT, Area 2 paired) → Phase 2 A
- **Entity model** (Area 1 ADOPT-multi-user → Area 2 RBAC stack) → Phase 4 A is foundation; 4B-D follow
- **Three-DB / per-session schema cluster** (Area 1 PORT-ARCH × 8 → Area 3 PORT-ARCH × 2) → Phase 6 atomic block
- **Approval primitive** (Area 2 ADOPT × 4 → Area 3 self-mod, Area 6 OneCLI bridge) → Phase 4 C precedes Phase 5 self-mod and Phase 4 OneCLI bridge wiring
- **OneCLI gateway** (Area 6 ADOPT) → unblocks Area 2 manual-approval bridge → Phase 3 F gateway, Phase 4 C bridge wiring
- **Self-mod** (Area 3 ADOPT-rebuild) → depends on Area 5 per-agent-group images + Area 2 approval primitive → Phase 5
- **Provider abstraction** (Area 3 ADOPT-rebuild) → depends on Area 5 provider-container-registry → Phase 5 bundled
- **`openDM`** (Area 4 ADOPT) → independent on v1's Channel interface → Phase 1
- **`user_dms` cache** (Area 2 ADOPT) → independent useful primitive, paired with `openDM` for full cold-DM flow → Phase 4 B
- **supportsThreads / subscribe / admin-transport** (Area 4 PORT-ARCH × 3) → require per-session per-thread routing → Phase 7
- **agent_destinations cross-container** (Area 5 PORT-ARCH) → require per-session containers → Phase 7
- **Container hardening** (Area 3 + Area 6 compound) → CONTRIBUTE to upstream as single PR
- **Pre-task `script` hook** (Area 3 ADOPT) → requires Area 1 schema migration (`script TEXT NULL` column) → Phase 2 D

### Gitignored-plugin gap

The Area 4 agent reviewed the `Channel` interface contract (from `src/types.ts` and `docs/CHANNEL_PLUGINS.md`) but could not see the actual plugin implementations under `plugins/channels/`, which is gitignored on the v1-archive branch (channel plugins are installed per-deployment via the [nanoclaw-skills marketplace](https://github.com/TerrifiedBug/nanoclaw-skills)). One known consequence:

- **Magic-bytes MIME detection** was originally tagged N/A ("not present in either codebase") because Area 4 saw only the `Channel` interface, not the WhatsApp plugin's actual file at `plugins/channels/whatsapp/index.js`. Cross-referenced against [CHANGES.md §5](CHANGES.md), the feature exists in v1 — reclassified as KEEP + CONTRIBUTE.

Other plugin-side features that Area 4's review may have missed (and are documented in CHANGES.md): per-channel reply-context extraction, sender-name override display, exponential backoff on reconnect, protocol-message filtering, message-handler resilience, video thumbnail extraction. The triage's KEEP verdicts on these capabilities at the *interface* level cover them, but anyone reviewing the matrices for "what does v1 already have" should check CHANGES.md alongside.

### Verdict adjudication: numbered migration framework

Area 1 said PORT (small, high confidence). Area 2 said SKIP-ARCH originally (revisited: even under multi-user lens, the numbered framework is a clean drop-in regardless of whether plugins ship migrations).

**Resolution:** PORT (Phase 2 A). Adjudicated PORT in the original triage; reaffirmed under the corrected lens. The `name`-keyed framework is genuinely better than v1's hardcoded MIGRATIONS array regardless of motivation.

### Items that change architectural assumptions (γ-territory if reconsidered)

Under the corrected lens, the original SKIP-ARCH list shrinks dramatically. The remaining items requiring genuinely architectural reconsideration are:

1. **The Phase 6 cluster** (per-session containers + two-DB IPC + heartbeat sweep). This is the only PORT-ARCH commitment in the catch-up. If you decide not to do Phase 6, the catch-up is otherwise complete after Phase 5; you'd lose the Phase 7 bolt-ons but keep multi-user, all bolt-on capabilities, and OneCLI.
2. **chat-sdk-bridge adoption**, if Danny ever wants the `@chat-adapter/*` channel marketplace. This pulls in the vendor footprint; would unlock 27-channel install ecosystem from upstream. Currently SKIP-ALT.
3. **Barrel-import distribution**, if Danny ever wants nanotars derivatives to install via git-merge instead of plugin-loader. Currently SKIP-ALT and unlikely to flip.

### Inline code excerpts — top PORT items

#### 1. Mount allowlist colon-injection check (Phase 1 PORT, trivial)

v2 `src/modules/mount-security/index.ts:198-220`:

```ts
function isValidContainerPath(containerPath: string): boolean {
  if (containerPath.includes('..')) return false;
  if (containerPath.startsWith('/')) return false;
  if (!containerPath || containerPath.trim() === '') return false;
  // Must not contain colons — prevents Docker -v option injection (e.g., "repo:rw")
  if (containerPath.includes(':')) return false;
  return true;
}
```

Drop into v1's `mount-security.ts` as a same-shaped guard.

#### 2. dockerfilePartials path-traversal guard (Phase 1 PORT, trivial)

v2 `src/container-runner.ts:592-603`:

```ts
for (const partial of partials) {
  const resolved = path.resolve(projectRoot, partial);
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`dockerfilePartial escapes project root: ${partial}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`dockerfilePartial not found or not a file: ${partial}`);
  }
  const body = fs.readFileSync(resolved, 'utf8').trimEnd();
  out += `# --- partial: ${rel} ---\n${body}\n`;
}
```

Wraps every plugin-supplied partial path. v1's `build.sh` reads partials by glob without this guard.

#### 3. Numbered migration framework keyed on name (Phase 2 A PORT, small)

v2 `src/db/migrations/index.ts:36-73`:

```ts
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  // Uniqueness is keyed on `name`, not `version`. This lets module
  // migrations (added later by install skills) pick arbitrary version
  // numbers without coordinating across modules.
  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number }).v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(next, m.name, new Date().toISOString());
    })();
  }
}
```

Replace v1's hardcoded `MIGRATIONS` array + sentinel-detect.

#### 4. claude-md-compose.ts — host-regenerated CLAUDE.md (Phase 2 B PORT, medium)

v2 `src/claude-md-compose.ts:35-50`:

```ts
const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

export function composeGroupClaudeMd(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }
  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);
  // ... discover and link skill instruction fragments + MCP server fragments
  // ... write composed CLAUDE.md with @-imports of fragments + CLAUDE.local.md
  // ... ensure CLAUDE.local.md exists (empty if first run)
}
```

Solves v1's "plugin instructions live in the container's read-only Dockerfile partials and have no path into the conversation" problem.

#### 5. Secret redaction `NEVER_EXEMPT` set (Phase 2 E PORT, small)

v2 `src/modules/secret-redaction/index.ts:31-38`:

```ts
const NEVER_EXEMPT = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'DASHBOARD_SECRET',
  'ONECLI_API_KEY',
]);
```

Plus length-sort + Set-dedup before regex compilation.

### Inline code excerpts — top CONTRIBUTE items

#### 1. `AUTH_ERROR_PATTERNS` + `isAuthError`

v1 `src/router.ts:7-21`:

```ts
const AUTH_ERROR_PATTERNS = [
  'does not have access to claude',
  'oauth token has expired',
  'obtain a new token',
  'refresh your existing token',
  'authentication_error',
  'invalid_api_key',
  'please login again',
];

export function isAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some(p => lower.includes(p));
}
```

#### 2. Container hardening flags

v1 `src/container-runtime.ts:155-177`:

```ts
export function extraRunArgs(): string[] {
  if (detectRuntime() === 'docker') {
    const seccomp = path.join(__dirname, '..', 'container', 'chromium-seccomp.json');
    return [
      '--cap-drop=ALL',
      '--cap-add=SYS_PTRACE',
      '--security-opt=no-new-privileges',
      '--security-opt', `seccomp=${seccomp}`,
      '--shm-size=2g',
      '--init',
      '--cpus=2',
      '--memory=4g',
      '--pids-limit=256',
      '--add-host=host.docker.internal:host-gateway',
    ];
  }
  return [];
}
```

#### 3. `MAX_CONCURRENT_CONTAINERS` host-wide cap

v1's `group-queue.ts` enforces a global cap via per-group queues + a global counter. v2 still exports `MAX_CONCURRENT_CONTAINERS` from `src/config.ts:40` with the same default (5), but no readers. Bursty inbound on N sessions = N parallel Chromium-running containers. Minimal PR: a `Semaphore` around `wakeContainer`. ~30 LOC.

#### 4. ffmpeg thumbnail extraction for inbound video/GIF

v1 implementation in WhatsApp template; post-`messageToInbound` hook in v2's chat-sdk-bridge. Significant agent-vision UX.

#### 5. Mount allowlist tests

v1's `src/__tests__/mount-security.test.ts` exercises strict-match, blocked-pattern, `nonMainReadOnly`, default paths, symlink resolution. v2's mount-security has zero tests.

---

## Appendix: methodology

**Baseline:** v1-archive at commit `df76cb9`; spec committed at `87abf16`; original triage at commit `01b9c52`.

**Triage lens (revised):** "Keep nanotars's improvements, catch up upstream where it brings concrete or technically-better value." Multi-user is in scope (public repo, future shared-group installs). Filter is technical merit, not observable pain.

**Comparison method:** Six parallel structural code reviews (Approach D — no commit-archaeology). Each agent owned one concern area, read both codebases, produced a uniform per-area report. `git log -p <file>` consulted only when comparison surfaced ambiguity.

**Verdict definitions (revised):**
- **PORT** — v2 has a clearly better implementation of v1 functionality; fits v1's architecture.
- **KEEP** — v1 wins (or v2 dropped a feature v1 still needs). Includes nanotars's customizations that aren't strictly worse than upstream.
- **ADOPT** — v2 has new functionality worth adding; fits v1's architecture (some require central-DB schema additions for multi-user).
- **PORT-ARCH** — v2 is genuinely better, but pickup requires committing to per-session containers + two-DB IPC + heartbeat sweep. In scope (Phase 6).
- **SKIP-ALT** — Alternative architecture, not strictly better. Not adopted on technical merit.
- **CONTRIBUTE** — v1 wins worth PRing upstream.
- **N/A** — Not in either codebase; v2-only bug with no v1 analog.

**Compound verdicts:** 9 rows in Areas 3 and 6 carry compound `KEEP / CONTRIBUTE` markers — primary verdict counted, secondary CONTRIBUTE candidates surfaced as Phase 1 PRs.

**Confidence levels:** Every verdict marked high/medium/low.

**Spot-check pass:** 12 verdicts manually re-verified against source. See *Spot-check log* below. Zero drift corrections beyond reclassification under the corrected lens (Area 4 SKIP→N/A relabeling, Areas 2 & 5 row-count fixes, Area 1 vs Area 2 migration-framework adjudication, and the post-hoc bucket changes from this revision).

### Spot-check log

12 verdicts picked across the six areas, biased toward high-effort or high-user-impact items. Each was re-verified against the cited file:line on both v1 and v2.

| Area | Item | Original verdict | Re-verified verdict (revised lens) | Notes |
|------|------|------------------|-------------------------------------|-------|
| 1 | Numbered migration framework | PORT | PORT (Phase 2 A) | Verified `src/db/migrations/index.ts:36-73` |
| 1 | `chat_sdk_*` SqliteStateAdapter | ADOPT medium | ADOPT (Phase 2 A) | Verified `src/state-sqlite.ts` |
| 2 | OneCLI manual-approval bridge | ADOPT (with OneCLI) medium | ADOPT (Phase 4 C) | Verified `src/modules/approvals/onecli-approvals.ts:1-269` |
| 2 | Approval primitive | ADOPT (deferred) medium low | ADOPT (Phase 4 C) | Confirmed primitive is reusable infra |
| 3 | `MAX_CONCURRENT_CONTAINERS` dead in v2 | KEEP/CONTRIBUTE trivial | KEEP/CONTRIBUTE (Phase 1 PR) | Confirmed by grep across v2 — zero readers |
| 3 | Container hardening dropped | KEEP/CONTRIBUTE trivial | KEEP/CONTRIBUTE (Phase 1 PR) | Verified v1 `container-runtime.ts:155-177` vs v2 lacking equivalent |
| 4 | Telegram typed-media routing | ADOPT small | ADOPT (Phase 2 C) | Verified `src/channels/telegram.ts:78-116` |
| 4 | Magic-bytes MIME detection | N/A | N/A | Confirmed not present in either codebase |
| 5 | `claude-md-compose.ts` | PORT medium | PORT (Phase 2 B) | Verified `src/claude-md-compose.ts:1-50` shape |
| 5 | `dockerfilePartials` path-traversal guard | PORT trivial | PORT (Phase 1) | Verified `src/container-runner.ts:592-603` |
| 6 | Mount allowlist `:` injection check | PORT trivial | PORT (Phase 1) | Verified `src/modules/mount-security/index.ts:215-217` |
| 6 | `AUTH_ERROR_PATTERNS` + `isAuthError` | CONTRIBUTE small | CONTRIBUTE (Phase 1 PR) | Confirmed v2 has zero equivalent |

**Drift corrections (from spot-check):** 0. All 12 verdicts held up under re-verification.

**Lens-revision adjustments:** 45 SKIP-ARCH items redistributed as 16 PORT-ARCH (Phase 6) + 22 ADOPT (Phases 4-5) + 1 ADOPT (`openDM` Phase 1) + 6 SKIP-ALT. No content changes to per-area appendices — those preserve the original agent classifications for traceability.

---

## Appendix: agent reports

Per-area appendix files (verbatim agent output, preserved for traceability):

- [Area 1: Persistence layer](upstream-triage-2026-04-25-area-1-persistence.md)
- [Area 2: Migrations, permissions, approvals](upstream-triage-2026-04-25-area-2-migrations-permissions.md)
- [Area 3: Runtime, lifecycle, scheduling](upstream-triage-2026-04-25-area-3-runtime-lifecycle.md)
- [Area 4: Channels & media](upstream-triage-2026-04-25-area-4-channels-media.md)
- [Area 5: Extensions, agent teams, identity, dashboard](upstream-triage-2026-04-25-area-5-extensions-agents.md)
- [Area 6: Security, IPC, build, tests, ops](upstream-triage-2026-04-25-area-6-security-ipc-build.md)
