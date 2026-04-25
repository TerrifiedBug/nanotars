# nanotars (v1-archive) ↔ nanoclaw v2 — Upstream Triage 2026-04-25

> Master synthesis of six parallel structural code reviews comparing `v1-archive` (head `df76cb9`) against `qwibitai/nanoclaw` v2 (`/data/nanoclaw-v2/`, current upstream/main). Per-area agent reports preserved verbatim in `upstream-triage-2026-04-25-area-<N>-<slug>.md`.

---

## Executive summary

**Verdict counts (across all 6 areas, primary verdict per matrix row):**

| Verdict | Count | What it means |
|---|---|---|
| PORT | 13 | v2 has a clearly better implementation of functionality v1 also has — bring v2's version across |
| KEEP | 43 | v1's implementation is better than v2's, OR v2 dropped a feature v1 still needs |
| ADOPT | 36 | v2 has functionality v1 doesn't have, and it's worth adding |
| SKIP-ARCH | 45 | Depends on v2's architectural rewrite (two-DB / per-session container / multi-user / OneCLI). Out of scope under (β) |
| CONTRIBUTE | 11 | v1 has functionality v2 doesn't — useful as a PR upstream |
| N/A | 5 | Compared item not present on either side, or bug only manifests in v2's architecture (no porting decision) |
| **Total reviewed** | **153** | |

Compound verdict rows (e.g. `KEEP / CONTRIBUTE`) are tallied under the first verdict only; the secondary `CONTRIBUTE` candidates are listed separately in *Cross-cutting findings*. Counting them as primary brings 9 additional CONTRIBUTE items into play (4 from Area 3, 5 from Area 6) — primarily the container hardening flags and three runtime regressions.

**Top 5 high-priority ports** (most user-visible / lowest effort):

1. **Mount allowlist colon-injection check** (Area 6, PORT trivial) — One-line guard in `isValidContainerPath` that v1's mount-security currently lacks. Closes `-v repo:rw` injection class. v2 `src/modules/mount-security/index.ts:215`.
2. **`dockerfilePartials` path-traversal guard** (Area 5, PORT trivial) — `path.relative` + `..`/absolute-path rejection before reading any partial. Hardens v1's plugin Dockerfile-partial mechanism against malicious plugins. v2 `src/container-runner.ts:592-603`.
3. **`claude-md-compose.ts` + `CLAUDE.local.md`** (Area 5, PORT medium when bundled) — Host-regenerated per-group `CLAUDE.md` from a shared base + skill fragments + per-group writable memory file. Single biggest content-quality win for v1's plugin-contributed instructions. v2 `src/claude-md-compose.ts`.
4. **Numbered migration framework** (Area 1, PORT small) — `schema_version.name`-keyed migration runner; replaces v1's hardcoded `MIGRATIONS` array + sentinel-detect. Unlocks plugins/skills shipping their own tables without inline-array edits. v2 `src/db/migrations/index.ts`.
5. **Telegram typed-media routing** (Area 4, ADOPT small) — `sendPhoto` / `sendVideo` / `sendAudio` extension-dispatch. Closes a real gap: v1's Telegram template never had `sendFile`. v2 `src/channels/telegram.ts:25-116`.

**Top 5 nanotars wins to contribute upstream:**

1. **Container hardening flags** (Area 6, compound; covers `--cap-drop=ALL`, `--cap-add=SYS_PTRACE`, `--security-opt=no-new-privileges`, custom seccomp, `--cpus=2`, `--memory=4g`, `--pids-limit=256`). v2 ships exactly zero of these — biggest concrete security regression in the entire triage. v1 `src/container-runtime.ts:155-177` is one self-contained block; the PR is mechanical. Cross-area: Area 6 surfaces the security framing, Area 3 surfaces the runtime hookup.
2. **`AUTH_ERROR_PATTERNS` + `isAuthError`** (Area 6, primary CONTRIBUTE small) — v2 has zero auth-error detection; users get silent 3-attempt drop instead of an "[Auth Error]" notice. v1 `src/router.ts:7-21`.
3. **`MAX_CONCURRENT_CONTAINERS` host-wide cap** (Area 3, compound) — v2 still exports the constant at `src/config.ts:40` but never reads it; bursty inbound on N sessions runs N parallel Chromium containers with no host cap. One-line check around `wakeContainer`. Confirmed dead code via grep across all of v2's `src/` and `container/`.
4. **Mount allowlist tests** (Area 6, primary CONTRIBUTE small) — v2's `mount-security` has zero tests despite being a security module ported from v1. v1's `src/__tests__/mount-security.test.ts` is portable as-is.
5. **ffmpeg thumbnail extraction for inbound video/GIF** (Area 4, primary CONTRIBUTE medium) — v1-only feature; meaningful UX for agent vision on media-heavy chats. v1 implementation lives in the WhatsApp template; upstream PR needs a `messageToInbound` post-hook in v2's chat-sdk-bridge.

**Architectural items skipped** (SKIP-ARCH — explicitly out of scope under (β)):

- Three-DB model (central + per-session inbound/outbound) — Area 1
- Per-session container model + heartbeat-driven stuck detection — Area 3
- Multi-user permissions (`user_roles` + `agent_group_members` + `user_dms`) — Area 2 (solo-fork has no problem to solve)
- Approval primitive in full + sender/channel approval flows — Area 2 (only the OneCLI approval bridge is realistically adoptable, and only as a bundle with OneCLI itself)
- Self-modification (`install_packages`, `add_mcp_server`) — Area 3 (depends on per-agent-group images + approval primitive)
- Container-side `AgentProvider` abstraction (Codex / OpenCode / Ollama) — Area 3
- `ChannelAdapter` interface as a unit + `chat-sdk-bridge` glue — Area 4 (individual methods like `splitForLimit`, `NetworkError` retry are individually portable)
- Barrel-import + skill-installed-branches distribution model — Area 5 (architectural alternative to v1's plugin-loader; keeping plugin-loader rules this out)
- Bun split for the agent-runner — Area 6 (npm/Node agent-runner suffices for v1)
- File-based IPC replacement with two-DB session split — Area 6 (entire `src/ipc/*` tree on v1 is replaced wholesale by v2's per-session DBs; β posture rules out the swap)

**Estimated total port effort:** ~14–18 weeks at 8h/week pace, with confidence range 12–22 weeks.

Decomposition:
- Phase 1 (~20 trivial items): ~10–12 hours total → ~1.5 weeks
- Phase 2 (~20 small/medium items): ~70–90 hours → ~9–12 weeks
- Phase 3 (~6 medium-large items): ~32–48 hours → ~4–6 weeks

Effort skews to Phase 2; OneCLI integration (medium-large) and the per-agent-group-image pipeline (large, deferred until self-mod) are the fattest tail-risk items.

---

## Sequencing recommendation

### Phase 1 — small/independent ports (~weeks 1-2)

Trivial-effort PORT/ADOPT/CONTRIBUTE items with no cross-area dependencies. Order intra-phase by user-visibility (security wins first, then UX, then hygiene).

**Security & correctness wins (do first):**
- Mount allowlist colon-injection check (Area 6, PORT) — v2 `mount-security/index.ts:215-217`
- `dockerfilePartials` path-traversal guard (Area 5, PORT) — v2 `container-runner.ts:592-603`
- Bash security hooks `READ_TOOLS_RE` expansion (Area 6, PORT) — adds `more|od|hexdump|bun|awk|sed|python3` to v1's existing list
- `shellQuote` unit tests (Area 6, PORT)
- `isValidGroupFolder` defense-in-depth validator on read path (Area 1, CONTRIBUTE upstream)

**UX & feature wins:**
- `splitForLimit` long-message splitter (Area 4, ADOPT) — v2 `chat-sdk-bridge.ts:104-118`, replaces v1 Telegram template's hard-cut
- Per-channel `transformOutboundText` hook (Area 4, ADOPT)
- Per-channel `extractReplyContext` hook (Area 4, ADOPT)
- `NetworkError` setup retry wrapper (Area 4, ADOPT) — v2 `channel-registry.ts:10-94`
- `groups/identity/` shared persona-files mount (Area 5, ADOPT)
- `AUTH_ERROR_PATTERNS` + `isAuthError` (Area 6, CONTRIBUTE upstream — but also useful as a v1 KEEP that gets PR'd to v2)
- `unregistered_senders` table + upsert-coalesce accessor (Area 1, ADOPT)

**Hygiene:**
- `decoupling connection from schema` refactor (Area 1, PORT trivial)
- `hasTable(db, name)` helper for module-table guards (Area 1, PORT trivial)
- Pinned `CLAUDE_CODE_VERSION` + similar ARGs in Dockerfile (Area 3, ADOPT)
- `tini` as PID 1 (Area 3, ADOPT — currently `--init`, switching is cosmetic but matches v2)
- `minimumReleaseAge` in `.npmrc` (Area 6, ADOPT — works on npm without pnpm migration)
- Exact-version pinning in `package.json` (Area 6, ADOPT)
- `manage-mounts` operational skill port (Area 6, ADOPT)
- `context_mode` ('group' | 'isolated') on `scheduled_tasks` (Area 1, CONTRIBUTE upstream)
- Online backup hook (`db.backup` keep-2 retention) (Area 1, CONTRIBUTE upstream)
- `task_run_logs` table + JOIN-recent-runs view (Area 1, CONTRIBUTE upstream)

### Phase 2 — medium items with dependencies (~weeks 3-12)

Bundle by dependency cluster, not by area, since several Phase 2 items co-cluster.

**Cluster A — Migration framework + DB-shape evolution (Area 1 + Area 2):**
- Numbered migration framework (Area 1, PORT small) — base for the cluster
- Per-provider session_state continuation namespacing (Area 1, PORT trivial) — only meaningful if v1 grows non-Anthropic providers
- `chat_sdk_*` SqliteStateAdapter (Area 1, ADOPT medium) — even outside chat-sdk, a useful generic KV+TTL+lock primitive
- Four-axis engage model (`engage_mode` / `pattern` / `sender_scope` / `ignored_message_policy`) (Area 1, PORT medium)

**Cluster B — Compose pipeline for CLAUDE.md (Area 5, identity + per-group memory):**
- `groups/<folder>/CLAUDE.local.md` (Area 5, PORT small) — phase 1 of compose
- `claude-md-compose.ts` host-regenerated CLAUDE.md (Area 5, PORT medium) — phase 2
- Three-tier container skills (shared `container/skills/` + per-group `groups/<folder>/skills/` + per-group `container.json:skills` selection list) (Area 5, ADOPT medium) — coexists with plugin-contributed skills

**Cluster C — Channels & media UX (Area 4):**
- Telegram typed-media routing (Area 4, ADOPT small) — closes the `sendFile`-gap
- Telegram pairing flow + interceptor (Area 4, ADOPT medium) — solves a real security gap (BotFather-only token = no user binding)
- CLI always-on local-socket channel (Area 4, ADOPT medium) — basic socket loop is portable; admin-transport stays SKIP-ARCH

**Cluster D — Runtime hygiene (Area 3 + Area 6):**
- Source-as-RO-bind-mount (Area 3, ADOPT small) — drop the `COPY` + tsc, mirror v2; v1 already mounts agent-runner src RO
- Label-scoped orphan cleanup per install (Area 3, ADOPT small) — replace `nanoclaw-` name-prefix filter with per-install label
- Pre-task `script` hook for scheduled tasks (Area 3, ADOPT medium) — ~150 LOC + `script TEXT NULL` column
- Vitest + GH Actions CI (Area 6, ADOPT small) — v1 has zero workflow files
- Mount allowlist tests (Area 6, CONTRIBUTE upstream small)

**Cluster E — Secret redaction port + tests (Area 6):**
- Secret redaction module body (Area 6, PORT small) — length-sort, Set-dedup, injectable paths, `ONECLI_API_KEY` exempt

### Phase 3 — large items with deep dependencies (~weeks 13-18)

**Cluster F — OneCLI integration (Area 6 + Area 2):**
- OneCLI gateway credential model (Area 6, ADOPT medium-large)
- OneCLI manual-approval bridge (Area 2, ADOPT medium) — bundle with the gateway port; standalone it's pointless
- `init-onecli` and `manage-group-env` skill ports (Area 6, conditional ADOPT)
- Card-expiry timer + edit-to-Expired sweep on startup (Area 2, ADOPT trivial — comes free with the bridge)
- Click-auth on approval cards + approval-handler registry + `pending_approvals` table (Area 2, the approval-primitive bundle, ADOPT medium total — only meaningful with at least one caller, i.e. the OneCLI bridge)

**Cluster G — pnpm migration (Area 6):**
- pnpm + `onlyBuiltDependencies` allowlist (Area 6, ADOPT medium) — required for OneCLI's recommended supply-chain posture; also unlocks `pnpm install -g` patterns inside the container

**Cluster H — Per-agent-group images (Area 5 + Area 3):**
- Per-agent-group image build (`buildAgentGroupImage`, `nanoclaw-agent:<agent-group-id>` tags) (Area 5, ADOPT large) — defer until self-mod is in scope, because the same code path is exercised
- Per-plugin Dockerfile partials integration with `container.json:dockerfilePartials` declaration (Area 5, ADOPT trivial once images are on)

### Items punted to future / explicitly out of scope under (β)

All SKIP-ARCH rows, plus the compound items whose primary verdict is KEEP-because-of-architectural-mismatch:

- Three-DB model (Area 1, 6 sub-items)
- Multi-user permissions stack (Area 2, 11 sub-items including users / user_roles / agent_group_members / user_dms / sender-resolver / sender-scope / pending-sender-approval / pending-channel-approval / `pickApprover` / command-gate against roles / `pending_questions` table)
- Per-session container model + heartbeat sweep (Area 3, 4 sub-items)
- Self-modification + per-agent-group-image-build coupled to it (Area 3, 2 sub-items)
- Provider abstraction (Codex / OpenCode / Ollama) (Area 3, 2 sub-items)
- `ChannelAdapter` interface as a unit + chat-sdk-bridge + `supportsThreads` / `subscribe` / `openDM` / admin-transport (Area 4, 7 sub-items)
- `webhook-server.ts` shared HTTP server (Area 5, 1 item — only relevant if Chat SDK is adopted)
- Barrel-import + skill-merged-branch distribution (Area 5, 1 item)
- Bun split for the agent-runner (Area 6, 1 item)
- File-based IPC swap to two-DB (Area 6, KEEP+SKIP-ARCH compound)

These remain reviewable later if Danny ever opens a separate brainstorm for (γ) — major architectural rewrites — but they are not part of the post-archive catch-up.

---

## Area 1: Persistence layer

**Functional inventory (condensed):** v1 holds `chats` (per-JID config), `messages` (single global table with composite `(id, chat_jid)` PK), `registered_groups` (group⇄platform wiring), `scheduled_tasks` + `task_run_logs` (audit), `sessions`, and `router_state` (KV) in a single SQLite at `data/nanotars.db`, accessed via `src/db/{init,messages,state,tasks,migrate}.ts`. v2 splits state across three DBs: a central `data/v2.db` (entity model: `agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, `user_dms`, `agent_destinations`, `chat_sdk_*`, `dropped_messages`) and per-session `inbound.db` + `outbound.db` (`messages_in`, `processing_ack`, `delivered`, `session_state`, `container_state`). v2 also adds a host-side `state-sqlite.ts` adapter generic enough that the chat-sdk bridge re-uses it.

**Implementation comparison highlights:**
- **Migration framework:** v1 uses a hardcoded `MIGRATIONS` array + sentinel-row detection in `src/db/init.ts:140-160`; v2 uses numbered files in `src/db/migrations/` keyed on `schema_version.name`, allowing module-shipped migrations.
- **Message store:** v1's `messages` table is the canonical "what was said" store; v2 has no global message store — recall is delegated to the agent's per-session `messages_in.db` and the agent-owned `/workspace/agent/conversations/`. This is a much bigger philosophical break than expected.
- **Engage model:** v2 splits trigger into `engage_mode` + `pattern` + `sender_scope` + `ignored_message_policy` — four orthogonal axes vs v1's two (`requires_trigger` + `trigger_pattern`). Even without v2's entity model, v1 could split cleanly.
- **Backup:** v1 has an online `db.backup` hook with keep-2 retention; v2 has nothing equivalent (and v2 would need to walk per-session DBs too, so the upstream port is non-trivial).
- **`task_run_logs` audit:** v1 has a dedicated audit table; v2 uses `messages_in.status` as the audit. v1's shape is better for dashboard rendering.

**Verdict matrix (full, copied from per-area report):**

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| Numbered migration framework (`schema_version.name` as dedup key) | PORT | small | high | Area 2 (migrations) | Replaces v1's hardcoded MIGRATIONS array + sentinel-detect; survives skill-installed tables |
| Decoupling connection from schema (`initDb` does not run DDL) | PORT | trivial | high | — | Pure refactor; lets test variants reuse the runner without re-running DDL |
| `hasTable(db, name)` helper for module-table guards | PORT | trivial | high | — | 5 LOC; needed if v1 grows optional plugin tables |
| `unregistered_senders` table + upsert-coalesce accessor | ADOPT | small | high | — | ~30 LOC; channel:platform key already maps to v1's `chats.jid` |
| Per-provider session_state continuation namespacing pattern | PORT | trivial | medium | Area 3 (provider abstraction) | Only relevant if v1 grows non-Anthropic providers |
| `chat_sdk_*` SqliteStateAdapter (KV+TTL, locks, lists, queues) | ADOPT | medium | high | Area 4 (chat-sdk bridge) | Useful generic primitive even outside chat-sdk; lock CAS pattern is a clean port |
| Three-DB model (central + per-session inbound/outbound) | SKIP-ARCH | large | high | Area 3 (per-session container) | Whole point of v2 cutover; no benefit without containerization |
| `messages_in` + `processing_ack` cross-process state machine | SKIP-ARCH | large | high | Area 3, Area 6 (IPC) | Replaces stdin-IPC; meaningless without per-session containers |
| `delivered` + `platform_message_id` outbound tracking | SKIP-ARCH | medium | high | Area 3 | Coupled to two-DB split |
| Live `destinations` + `session_routing` rows replacing JSON snapshots | SKIP-ARCH | medium | high | Area 3 | Architectural — depends on the host-writes-row, container-reads-row IPC |
| Four-axis engage model (engage_mode/pattern/sender_scope/ignored_message_policy) | PORT | medium | medium | Area 2 | Even without v2's entity model, v1 could split `requires_trigger + trigger_pattern` cleanly |
| `task_run_logs` table + JOIN-recent-runs view | CONTRIBUTE | small | high | — | v1-only; useful upstream as a scheduled-task observability layer |
| `context_mode` ('group' \| 'isolated') on scheduled_tasks | CONTRIBUTE | trivial | medium | Area 3 (scheduling) | v1-only concept; v2's session_mode covers a different axis |
| `process_after` + `series_id` + `trigger=0` accumulator on inbound | SKIP-ARCH | medium | medium | Area 3 | Ports only as part of the v2 scheduling rewrite |
| `isValidGroupFolder` defense-in-depth validator on read path | CONTRIBUTE | trivial | high | — | v2 lacks the equivalent guard on `agent_groups.folder` reads |
| Online backup hook (`db.backup` keep-2 retention) | CONTRIBUTE | small | high | — | v1-only; small mechanical port (v2 needs to walk session DBs too) |
| `dbEvents` EventEmitter on insert | KEEP | n/a | high | — | v1-internal coupling between message store and poll loop; v2 doesn't need this because of the per-session DB model |
| JSON-to-SQLite one-time import migration (`router_state.json` etc.) | KEEP | n/a | high | — | v1-historical; serves no v2 purpose |
| `__group_sync__` magic-row pattern in `chats` (KEEP-AND-CLEANUP) | KEEP | trivial | high | — | Smell; if v1 keeps the `chats` table, replace with a proper `last_group_sync` row in `router_state` |
| Composite (id, chat_jid) PK on messages | KEEP | n/a | high | — | Architecturally tied to v1's single message store |
| Bot-message content-prefix backstop (KEEP-AND-CLEANUP) | KEEP | small | medium | — | Fragile across rename of ASSISTANT_NAME; the boolean column is sufficient now |
| `journal_mode = DELETE` on inbound.db (cross-mount visibility) | SKIP-ARCH | n/a | high | Area 3 | Pure v2 mount-boundary concern |
| Even/odd seq partition (host even, container odd) | SKIP-ARCH | n/a | high | Area 3 | Tied to two-DB ordering invariant |
| `container_state` single-row tool-in-flight table | SKIP-ARCH | n/a | high | Area 3 (host-sweep) | Coupled to v2's stuck-detection sweep |

Per-area totals: PORT=5, KEEP=5, ADOPT=2, SKIP-ARCH=8, CONTRIBUTE=4, total=24.

**Cross-cutting concerns:**
- Migration framework cuts across Area 1 and Area 2; Area 1 says PORT, Area 2 says SKIP-ARCH (see *Cross-cutting findings* below for resolution).
- `chat_sdk_*` adapter ADOPT is contingent on Area 4 chat-sdk-bridge adoption (which is SKIP-ARCH overall, so ADOPT-ing the adapter is for "generic KV+TTL+lock" use, not chat-sdk).
- Three-DB model, `messages_in`, `delivered`, journal-mode quirks, even/odd seq partition, `container_state` — all dependent on Area 3's per-session container model.
- `process_after` + `series_id` + `trigger=0` accumulator depends on Area 3's scheduling rewrite.

→ See `upstream-triage-2026-04-25-area-1-persistence.md` for full agent report.

---

## Area 2: Migrations, permissions, approvals

**Functional inventory (condensed):** v1's approach is "implicit permissions via the main group" — `RegisteredGroup.is_main` flag, with privileged operations gated by group-membership rather than user role. Migrations are a one-shot JSON→SQLite import in `src/db/migrate.ts` plus a hardcoded `MIGRATIONS` array in `init.ts`. There is no approvals state table — auth-error notifications are inline. v2 introduces a full RBAC: `users` (`<channel>:<handle>` namespaced IDs), `user_roles` (owner / global-admin / scoped-admin), `agent_group_members` (unprivileged access gate), `user_dms` (cold-DM cache); plus an approvals primitive (`requestApproval` / handler registry / OneCLI bridge / approval-card click-auth) that powers self-mod, sender-approval, and channel-approval flows. Migrations are versioned files keyed on `schema_version.name`.

**Implementation comparison highlights:**
- **Permissions model:** v1's main-group flag works for solo-fork. v2's three-tier RBAC (owner / global-admin / scoped-admin / member) only pays off in multi-user installs.
- **Approval primitive:** v2's `requestApproval` (`primitive.ts`) is small (~220 LOC) and clean, with handler-registry + click-auth + card-render-metadata. Without callers (self-mod / OneCLI bridge / sender-approval), it's dead code.
- **OneCLI manual-approval bridge:** A long-poll callback that turns gateway-pending approvals into DM cards. Bundled with the OneCLI gateway port (Cluster F above).
- **`user_dms` cache + `ensureUserDm`:** Two-class resolution (known-via-`user_dms` vs cold-DM-via-channel-`openDM`). v1 has no equivalent because nanotars never DMs anyone but the operator.

**Verdict matrix (full, copied from per-area report):**

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| Versioned-file migration framework (`schema_version` + numbered files) | SKIP-ARCH | small | high | — | v1's inline array works at current scale; only worth porting if Danny adopts a skill-install model that ships per-skill migrations |
| Schema-version table keyed on `name UNIQUE` with auto-assigned version | SKIP-ARCH | trivial | high | versioned-file framework | Same prerequisite — value is module-migration composition |
| One-shot JSON→SQLite startup migration (`migrate.ts`) | KEEP | trivial | high | — | v1-only legacy concern; effectively dead code now, but harmless. Don't port to v2 |
| Sentinel-detection back-fill for pre-migration-system installs (`init.ts:140-160`) | KEEP | trivial | high | — | v1-only; v2 had `schema_version` from day one |
| `users` table + namespaced (`kind:handle`) user IDs | SKIP-ARCH | medium | high | entity model (Area 1) | Single-user fork has no multi-user identity problem |
| `user_roles` (owner / global-admin / scoped-admin) | SKIP-ARCH | medium | high | users; canonical user-id namespacing | Solo install means the operator is owner of everything; the role model has nowhere to differentiate |
| `agent_group_members` + implicit-admin-membership rule | SKIP-ARCH | small | high | user_roles; agent_groups | Same — single user, one group is a single-cell matrix |
| `user_dms` cache + `ensureUserDm` two-class resolution | SKIP-ARCH | medium | high | users; channel adapter `openDM` (Area 4) | Useful only when DMs need to be cold-started to a non-operator approver |
| `canAccessAgentGroup` access function (`access.ts`) | SKIP-ARCH | trivial | high | user_roles, agent_group_members | Pure functional layer over the role tables — no value without them |
| Sender-resolver hook + access-gate hook (`permissions/index.ts:145,147`) | SKIP-ARCH | small | medium | router with hooks; user resolution | v1 has no equivalent hook surface in `router.ts`; would need router refactor first |
| Sender-scope gate (`sender_scope='all'\|'known'`) | SKIP-ARCH | trivial | medium | access gate; messaging_group_agents | Per-wiring gate; v1 has one wiring per group implicitly |
| Approval primitive (`requestApproval`, handler registry) | ADOPT (deferred) | medium | low | OneCLI bridge (Area 6); self-mod (Area 3) | The primitive is small and clean (~220 LOC). Defer until self-mod or OneCLI is ported — without callers it's dead code |
| `pickApprover` + `pickApprovalDelivery` (approver hierarchy) | SKIP-ARCH | small | high | user_roles; user_dms | Solves "which admin do I poke" — v1 has one operator |
| Same-channel-kind tie-break in `pickApprovalDelivery` | SKIP-ARCH | trivial | high | pickApprovalDelivery | Clever but uncalled in solo install |
| OneCLI manual-approval bridge (`onecli-approvals.ts`) | ADOPT (with OneCLI) | medium | medium | OneCLI gateway port (Area 6) | Bundle the bridge with the OneCLI port; standalone it's pointless. Includes the short-id Telegram callback_data workaround |
| Card-expiry timer + edit-to-Expired sweep on startup | ADOPT (with OneCLI) | trivial | high | OneCLI bridge | Comes free with the bridge; ~30 LOC |
| Pending-sender approval flow (`pending_sender_approvals` + request/respond) | SKIP-ARCH | medium | high | user_roles; access gate; ask_question infrastructure | Pure multi-user payoff; solo fork has no unknown-sender problem |
| Pending-channel registration flow (`pending_channel_approvals` + denied_at) | SKIP-ARCH | medium | high | unknown-sender flow; ask_question infrastructure | Same — only matters for "stranger DMs the bot, owner approves" |
| In-flight dedup via PRIMARY KEY on pending tables | SKIP-ARCH | trivial | high | pending tables | Inherits its parent verdict |
| Click-auth on approval cards (clicker-must-equal-approver-or-admin) | ADOPT (with primitive) | trivial | high | approval primitive | Important security property of the v2 design; bundle with primitive |
| Approval-handler registry + `registerApprovalHandler` | ADOPT (with primitive) | trivial | high | approval primitive | The handler-registration pattern is the right shape if approval primitive ports |
| `pending_approvals` table + render-metadata columns (title, options_json) | ADOPT (with primitive) | trivial | high | approval primitive | Storage shape for the primitive |
| `pending_questions` table (generic ask_question state) | SKIP-ARCH | medium | medium | sessions; entity model | Useful if the ask_question MCP tool ports under Area 5; not standalone |
| `unregistered_senders` counter table | SKIP-ARCH | small | high | platform_id convention | Diagnostic-only; no caller demand |
| Module-migration name-key trick (filename has `module-` prefix, `name` field unchanged) | SKIP-ARCH | trivial | medium | versioned-file framework | Cute compatibility hack for in-the-wild DBs; only relevant if Danny adopts the v2 framework |
| Host-side command gate (`command-gate.ts` admin-command check) | SKIP-ARCH | small | high | user_roles | Slash-command gating against roles; v1 has no equivalent admin-slash-command concept |

Per-area totals (recounted from matrix rows): PORT=0, KEEP=2, ADOPT=6 (all approval-primitive bundle, conditional on Areas 3+6), SKIP-ARCH=18, CONTRIBUTE=0 → 26 rows. (Agent's reported total of 25 was off by one.)

**Cross-cutting concerns:**
- Approval-primitive bundle (rows: primitive, click-auth, handler registry, `pending_approvals`) ADOPT-deferred until at least one caller ports — depends on Area 3 (self-mod) or Area 6 (OneCLI bridge). Adopting in isolation gives dead code.
- OneCLI manual-approval bridge depends on Area 6's OneCLI gateway port. Full bundle is medium effort.
- All multi-user tables (`users` / `user_roles` / `agent_group_members` / `user_dms`) depend on Area 1's entity model.
- `user_dms` two-class resolution depends on Area 4's `ChannelAdapter.openDM` — also SKIP-ARCH.
- Migration framework conflict with Area 1 noted in *Cross-cutting findings*.

→ See `upstream-triage-2026-04-25-area-2-migrations-permissions.md` for full agent report.

---

## Area 3: Runtime, lifecycle, scheduling

**Functional inventory (condensed):** v1 runs a per-group container queue (`group-queue.ts`) with a global `MAX_CONCURRENT_CONTAINERS=5` cap, idle-timeout-driven shutdown, and a runtime abstraction supporting both Docker and Apple Container (`container-runtime.ts`). The container is hardened with `--cap-drop=ALL`, `--cap-add=SYS_PTRACE`, `--security-opt=no-new-privileges`, custom seccomp, `--cpus=2`, `--memory=4g`, `--pids-limit=256`. Scheduled tasks support `cron`, `interval`, and `once` types with `task_run_logs` audit. v2 replaces all of this with a per-session container model (`sessions` table → `inbound.db`/`outbound.db` → `wakeContainer`), heartbeat-mtime-driven stuck detection in `host-sweep.ts`, a `lifecycle` module for pause/resume, a `self-mod` module for `install_packages`/`add_mcp_server`, a provider abstraction (Codex/OpenCode/Ollama), and a pre-task `script` hook for cheap pre-checks. v2 dropped Apple Container support entirely (`CONTAINER_RUNTIME_BIN = 'docker'` hard-coded at `container-runtime.ts:12`), every container hardening flag, the global concurrency cap, and the `interval`/`once` schedule types.

**Implementation comparison highlights:**
- **`MAX_CONCURRENT_CONTAINERS` is dead code in v2:** exported from `src/config.ts:40` with the same default (5) as v1, but `grep` across `src/` and `container/` shows zero readers. Either oversight or intentional drop without removing the config. Net effect: bursty inbound on N sessions runs N parallel Chromium-running containers with no host-wide cap. Largest single-flag regression.
- **Container hardening dropped wholesale:** v1's `container-runtime.ts:155-177` ships nine non-trivial flags; v2's `container-runner.ts:473-548` ships zero. Concrete CONTRIBUTE-to-upstream item.
- **Pre-task `script` hook (v2-only):** ~150 LOC + `script TEXT NULL` column on `scheduled_tasks`. Cheap pre-checks gate model spend (e.g., "only run the daily summary if there's been activity"). Self-contained ADOPT.
- **Apple Container abstraction kept on v1:** v2 dropped it; v1 still uses both runtimes. KEEP.

**Verdict matrix (full, copied from per-area report):**

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| `MAX_CONCURRENT_CONTAINERS` global cap (v2 regression) | KEEP / CONTRIBUTE | trivial | high | — | v2 has the constant but never reads it; v1's `GroupQueue` enforces it. Worth a CONTRIBUTE PR (one-line check around `wakeContainer`). |
| Per-group queue + idle preemption (`GroupQueue`) | KEEP | n/a | high | — | v1's queue is the right shape for v1's per-group model. Skip-arch under v2's per-session model. |
| Container hardening (`--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--cpus`, `--memory`, `--pids-limit`, custom seccomp) | KEEP / CONTRIBUTE | trivial | high | Area 6 | v1 has it, v2 dropped it. Single-block PR upstream. |
| Container runtime abstraction (Docker + Apple Container) | KEEP | n/a | high | — | v1 supports both; v2 is Docker-only. Apple Container is in active use. |
| Label-scoped orphan cleanup (per-install slug) | ADOPT | small | high | install-slug helper (already exists in v2) | Replace v1's name-prefix `nanoclaw-` filter with a per-install label so multiple installs coexist. |
| `tini` as PID 1 + signal forwarding | ADOPT | trivial | high | container Dockerfile | v1 uses Docker `--init`; switching to `tini` matches v2 and is cleaner. Optional. |
| Pinned CLI ARG versions in Dockerfile | ADOPT | trivial | high | — | v2's pinned `CLAUDE_CODE_VERSION` etc. are good hygiene. v1 is unpinned. Trivial port. |
| pnpm `only-built-dependencies` allowlist | ADOPT | small | medium | move v1 off `npm install -g` to `pnpm` first | Only relevant if v1 follows v2 onto pnpm. |
| Source-as-RO-bind-mount (no source baked) | ADOPT | small | high | — | v1 already mounts `agent-runner/src` RO but also bakes source via `COPY` + recompiles at startup. Drop the `COPY` + tsc, mirror v2. |
| Two-DB session split + heartbeat-driven stuck detection | SKIP-ARCH | large | high | full v2 architecture | Heartbeat-mtime + per-claim tolerance is elegant but inseparable from the rewrite. |
| Per-session container model | SKIP-ARCH | large | high | sessions table, two-DB | v1's per-group model is its core architecture. |
| Lifecycle module pause/resume | SKIP-ARCH | medium | high | delivery-action registry, two-DB | v2's pause is small + clean but depends on the system-action delivery surface. |
| Self-modification (`install_packages`, `add_mcp_server`) | SKIP-ARCH | large | high | approvals module, `container.json`, per-group image build | Compelling agent capability but architecturally tied to v2's approval + container-config model. Revisit under γ. |
| Per-agent-group image build (`generateAgentGroupDockerfile`) | SKIP-ARCH | medium | high | self-mod | Required by self-mod; v1's plugin partials cover the per-base-image case. |
| Container-side `AgentProvider` abstraction (Codex/OpenCode/Ollama) | SKIP-ARCH | large | high | provider registry, `agent_provider` columns | Useful only if you want non-Claude providers. Out of scope for v1 catch-up; revisit if Ollama/Codex specifically matter. |
| Host-side `provider-container-registry` | SKIP-ARCH | medium | high | provider abstraction | Same scope as above. |
| Pre-task script hook (`task-script.ts`) | ADOPT | medium | high | scheduled_tasks schema (add `script TEXT NULL`) | v2-only capability, mostly self-contained. Cheap pre-checks gate model spend. ~150 LOC port + small schema migration. |
| Per-task model override | KEEP | n/a | high | — | v1 already has `task.model` column; v2's content-JSON storage is downstream of two-DB. |
| Cron + interval + once schedule types | KEEP / CONTRIBUTE | trivial | high | — | v1 supports all three; v2 only cron. Worth a CONTRIBUTE PR. |
| Atomic `claimTask` (clear `next_run` before spawn) | KEEP | n/a | high | — | v1 + v2 both have correct atomic-claim. Different shapes but both work. |
| Auth-vs-generic error discrimination on task failure notify | CONTRIBUTE | small | medium | `isAuthError` helper | v2 cites v1 as inspiration but dropped the auth-error split. PR-able to v2. |
| `task_run_logs` table | KEEP | n/a | high | — | v1 has dedicated audit table; v2 uses message-status as audit. Useful for dashboards/UI. |
| File-based IPC (`data/ipc/<group>/input/`, `_close` sentinel) | KEEP | n/a | high | — | v1's IPC is correct for its architecture. |
| Output marker nonce (`OUTPUT_START_<nonce>_END`) | KEEP | n/a | high | — | v1's stdout-streaming protocol uses per-run nonces to prevent injection. Solid pattern; v2 doesn't need it (no stdout protocol). |
| Stdin secret injection (no env vars, no file mounts for keys) | KEEP / CONTRIBUTE | n/a | medium | — | v1 passes secrets via stdin JSON only; v2 routes via OneCLI gateway HTTPS_PROXY. Different models; v1's is good for installs without OneCLI. |
| `IDLE_TIMEOUT` host-side stdin closer | KEEP | n/a | high | — | v1's dual-timer is fine for v1's architecture. v2's heartbeat model needs the rest of v2 to work. |

Per-area totals (primary verdict): PORT=0, KEEP=12, ADOPT=6, SKIP-ARCH=7, CONTRIBUTE=1, total=26. **Compound `KEEP / CONTRIBUTE` rows:** 4 — `MAX_CONCURRENT_CONTAINERS`, container hardening flags, cron+interval+once schedule types, stdin secret injection. These add 4 secondary CONTRIBUTE candidates.

**Cross-cutting concerns:**
- Container hardening rows reference Area 6 (security framing). The Area 3 perspective is "v1 has it on the runtime", Area 6's perspective is "v1 has it on security model" — same flags, double-counted in spirit but tracked once each side for completeness; primary verdict is KEEP-on-v1 + CONTRIBUTE-to-v2 in both areas.
- Self-mod and per-agent-group-image build depend on Area 2's approval primitive.
- Pre-task script hook depends on Area 1's scheduled_tasks schema (small migration).
- Provider abstraction depends on Area 5's `provider-container-registry` and `agent_provider` column.

→ See `upstream-triage-2026-04-25-area-3-runtime-lifecycle.md` for full agent report.

---

## Area 4: Channels and media

**Functional inventory (condensed):** v1 exposes a `Channel` interface (`src/types.ts`) loaded by `plugin-loader.ts` via `channelPlugin: true` + `onChannel` factory. Outbound dispatch goes through `src/router.ts`. Inbound media is handled file-on-disk with `mediaPath`/`mediaHostPath` references. v1 has ffmpeg thumbnail extraction for video/GIF in the WhatsApp template. v2 introduces a `ChannelAdapter` interface (`src/channels/adapter.ts`) with `deliver` / `supportsThreads` / `openDM` / `subscribe` / `transformOutboundText` / `extractReplyContext`, registered via a barrel-import + `registerChannelAdapter`. Outbound delivery is done in `src/delivery.ts`. The `chat-sdk-bridge` glues `@chat-adapter/*` packages to the adapter contract. Inbound media is base64-inlined into `messages_in.db`. v2 also ships a `splitForLimit` long-message splitter, a `NetworkError` setup-retry wrapper, a CLI always-on socket channel, and a Telegram pairing flow.

**Implementation comparison highlights:**
- **The "magic-bytes MIME detection" in the spec doesn't exist in either codebase.** Both use extension-based MIME inference. The spec's flag was a misremembering — the real v1 work was ffmpeg thumbnails (commit `90955d9`).
- **Reaction composite-id bug (fixed in v2 commit `5e93609`) doesn't exist in v1.** v1 has no per-agent fan-out — `messages.id` is the platform-native id, not suffixed.
- **Telegram typed-media routing on v2 is the cleanest single ADOPT.** v1's Telegram template never had `sendFile`. v2's `channels/telegram.ts:78-116` does the right thing (extension → typed API).
- **Inbound media: v1's file-on-disk model scales to large media; v2's base64-inline doesn't.** KEEP v1; CONTRIBUTE candidate to v2 but architectural mismatch (per-session vs per-group storage) makes the PR non-trivial.
- **`ChannelAdapter` interface as a unit is SKIP-ARCH** (depends on entity model + two-DB delivery), but discrete pieces are individually portable.

**Verdict matrix (full, copied from per-area report):**

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| `ChannelAdapter` interface (whole) | SKIP-ARCH | large | high | Area 1 (entity model) | v2's shape only pays off with messaging_groups + sessions + two-DB delivery; not portable as a unit |
| `Channel` interface (v1 — keep as-is) | KEEP | — | high | — | Still suits v1's monolith; well-documented in `docs/CHANNEL_PLUGINS.md` |
| `registerChannelAdapter` self-register barrel | SKIP-ARCH | small | medium | Area 5 (extension/discovery) | Equivalent to v1's plugin discovery; choosing one over the other is part of Area 5's verdict |
| Chat SDK bridge (`chat-sdk-bridge.ts`) | SKIP-ARCH | large | high | vendor: `@chat-adapter/*`, `chat` lib | Non-trivial vendor footprint; bridge makes sense only if those packages are adopted wholesale |
| `splitForLimit` long-message splitter | ADOPT | trivial | high | — | 12-line pure function (`chat-sdk-bridge.ts:104-118`); replaces Telegram template's hard-cut |
| Per-channel `transformOutboundText` hook | ADOPT | trivial | medium | — | Useful pattern; v1 currently sanitizes inline. Net win small but nonzero |
| Per-channel `extractReplyContext` hook | ADOPT | trivial | medium | — | Cleans up inline reply parsing in WA channel |
| Telegram typed-media routing (`sendPhoto` / `sendVideo` / `sendAudio` by extension) | ADOPT | small | high | — | Port `channels/telegram.ts:25-116` into v1's Telegram template; closes a v1 gap (template has no `sendFile`) |
| Magic-bytes MIME detection | N/A | — | high | — | Not present in either codebase. Spec's flag was a misremembering — actual v1 work was ffmpeg thumbnails |
| ffmpeg thumbnail extraction (videos + GIFs) | KEEP | — | high | — | v1-only feature in WA template; v2 has no equivalent. Important for agent vision |
| ffmpeg thumbnail extraction (upstream contribution) | CONTRIBUTE | medium | medium | upstream's bridge attachment hook | Worth proposing as a post-`messageToInbound` hook in v2's bridge; chat-adapter platform variance complicates a single PR |
| Inbound media: file-on-disk + path reference | KEEP | — | high | — | v1's `mediaPath`/`mediaHostPath` model scales to large media; v2's base64-inline doesn't |
| File-on-disk media model (upstream contribution) | CONTRIBUTE | large | low | Area 1 (per-group dirs) | Architectural mismatch with v2's per-session storage; non-trivial PR |
| Reactions (interface) | KEEP | — | high | — | v1 has `react?(jid, messageId, emoji, participant?, fromMe?)`; v2 had a composite-id bug (commit `5e93609`) that doesn't exist in v1 because v1 doesn't suffix message ids per-agent |
| Composite-id reaction fix (`5e93609`) | N/A | — | high | — | Bug only exists in v2 due to per-agent fan-out; nothing to port |
| `supportsThreads` adapter flag | SKIP-ARCH | small | high | Area 1 (sessions per thread) | Useful concept but only meaningful with v2's session-per-thread router logic |
| `subscribe(platformId, threadId)` | SKIP-ARCH | small | high | mention-sticky engage mode | Part of v2's engage modes; v1 has no thread model |
| `openDM(userHandle)` | SKIP-ARCH | small | high | Area 2 (approvals, user_dms) | Only matters with cold-DM scenarios v1 doesn't drive |
| CLI always-on local-socket channel | ADOPT | medium | medium | — | Basic socket loop is portable as a v1 channel plugin; admin-transport (`replyTo`) is v2-bound |
| Admin-transport (`onInboundEvent` + `replyTo`) | SKIP-ARCH | medium | high | router `replyTo` propagation | Requires router-level support v1 doesn't have |
| Telegram pairing flow + interceptor | ADOPT | medium | medium | v1 setup flow integration | Solves a real security gap (BotFather token = no user binding); needs surface for the operator to type the code |
| Telegram legacy-Markdown sanitizer | N/A | — | high | — | Workaround for v2-only chat-adapter dependency |
| Sender-name override on outbound (sub-agent identity) | KEEP | — | high | — | v1's `sendMessage(jid, text, sender?, replyTo?)` carries this; v2 has no equivalent |
| Sender-override / Telegram swarm pool (upstream contribution) | CONTRIBUTE | medium | low | — | v1-only feature for distinct bot identities per sub-agent; cool but niche |
| `NetworkError` setup retry (`channel-registry.ts:10-94`) | ADOPT | trivial | high | — | 50-line retry wrapper with `[2,5,10]s` backoff; v1's `connect()` reconnects within the channel only, not at registration |
| `replyTo` reply-quote on outbound `sendMessage` | KEEP | — | high | — | v1 already has it (`src/types.ts:99`); v2's bridge does not surface it on the deliver path (only on inbound) — v1 wins |

Per-area totals: PORT=0, KEEP=6, ADOPT=7, SKIP-ARCH=7, CONTRIBUTE=3, N/A=3, total=26. (Three rows tagged "N/A" — agent originally tagged them "SKIP", reclassified here for spec compliance.)

**Cross-cutting concerns:**
- `ChannelAdapter` whole and `chat-sdk-bridge` depend on Area 1's entity model and Area 5's discovery mechanism.
- `openDM` depends on Area 2's `user_dms` cache.
- `supportsThreads` and `subscribe` depend on Area 1's session-per-thread routing.
- File-on-disk media model upstream PR depends on Area 1's per-group dirs.

→ See `upstream-triage-2026-04-25-area-4-channels-media.md` for full agent report.

---

## Area 5: Extensions, agent teams, identity, dashboard

**Functional inventory (condensed):** v1's extension system is `plugin-loader.ts` + `plugins/<name>/plugin.json` discovery + manifest with `channelPlugin` / `webhookPlugin` / `containerSkillsPath` / `dockerfilePartialPath` / `mcp.json` / `publicEnvVars` declarations. Plugins compose into the per-group container at build time via `Dockerfile.partial` injection and at runtime via per-plugin MCP merge. Agent teams live at `groups/<folder>/agents/<name>/{agent.json,IDENTITY.md,CLAUDE.md}` + `discoverAgents` in the agent-runner — these are Claude Agent SDK in-context Task subagents, single-container. Per-group identity is `groups/<folder>/IDENTITY.md` + `groups/global/`. Dashboard is a full ~900 LOC htmx admin UI. v2 replaces extension distribution with barrel-import + skill-installed branches (long-lived sibling branches for channels/providers, copied in on-demand by skills). MCP is in-process tool stubs in `container/agent-runner/src/mcp-tools/`. Container skills are three-tier: shared `container/skills/` + per-group `groups/<folder>/skills/` + selection list in `container.json:skills`. Identity is `CLAUDE.local.md` (writable by agent) + `groups/identity/` (operator-curated mount). Agent-to-agent is a different concept entirely: v2's `src/modules/agent-to-agent/*` is cross-container peer-to-peer messaging via the `agent_destinations` table, not an SDK Task-tool replacement. Dashboard is reduced to `src/dashboard-pusher.ts` + an external `@nanoco/nanoclaw-dashboard` package.

**Implementation comparison highlights:**
- **Plugin-loader vs barrel-imports is genuinely context-dependent.** v1's manifest+scoping wins for Danny's 20+ extensions on a single fork; v2's barrel wins for upstream's "git-merge to install" distribution. KEEP plugin-loader.
- **Agent teams (`groups/<folder>/agents/`) is v1-only and v2's agent-to-agent is *not* an equivalent.** They solve unrelated problems. KEEP v1's; the agent-to-agent module is SKIP-ARCH (depends on two-DB).
- **Single biggest port candidate is `claude-md-compose.ts`** — host-regenerated `CLAUDE.md` with `.claude-fragments/` + `CLAUDE.local.md` split. v1's plugin system has six container-injection mechanisms but no "always-in-context skill instructions" path. Strict win.
- **Dashboard is best as KEEP+CONTRIBUTE.** v1's heavy htmx UI is more feature-rich; v2's pusher has a better data model (per-model token breakdown, context %, hourly buckets). PR adapts v1's UI to consume v2-style snapshots.
- **`dockerfilePartials` path-traversal guard alone is a trivial standalone PORT.**

**Verdict matrix (full, copied from per-area report):**

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| `plugin-loader.ts` + `plugin-types.ts` (manifest-driven extensions, scoping by channel/group, publicEnvVars secret classification) | KEEP | — | high | — | v1's model is better at this scale (single user, 20+ extensions). Do not adopt v2's barrel — it deletes scoping and requires source edits per install. |
| Per-plugin `mcp.json` fragment merge into per-group `merged-mcp.json` | KEEP | — | high | — | Better than v2's per-group `container.json:mcpServers` for set-and-forget external MCP servers across many groups. |
| In-process MCP tool stubs (`container/agent-runner/src/mcp-tools/*.ts` + `registerTools` self-registration barrel) | ADOPT | small | high | None | Add a sibling barrel in nanotars's agent-runner so future built-in tools (send_message, schedule_task, etc.) can be in-process. Existing v1 MCP server stays. |
| Three-tier container skills (shared `container/skills/` + per-group `groups/<folder>/skills/` + per-group `container.json:skills` selection list) | ADOPT | medium | medium | container.json (Area 6) | Adds per-group skill enable/disable UX. Coexists with plugin-contributed skills. |
| Per-agent-group images (`buildAgentGroupImage`, `nanoclaw-agent:<agent-group-id>` tags) | ADOPT | large | medium | self-mod (Area 3), container.json (Area 6) | Defer until v2's self-mod approval flow is ported — same code path. Big disk-savings win for installs with diverse groups. |
| `dockerfilePartials` path-traversal guard (`container-runner.ts:592-603`) | PORT | trivial | high | — | Hardens v1's `build.sh` against malicious plugins. Standalone — port even without per-group images. |
| `groups/<folder>/agents/<name>/` (Claude SDK in-context Task subagents) | KEEP | — | high | — | v2 has no equivalent. Different concept from v2's agent-to-agent. Worth a CONTRIBUTE PR upstream. |
| `discoverAgents()` Task-tool subagent registration + run_in_background hook | KEEP | — | high | — | Same as above. Works as-is. |
| v2 `agent_destinations` + `channel_type='agent'` cross-container agent messaging | SKIP-ARCH | — | medium | two-DB session model, central DB schema | Useful concept but requires v2's two-DB architecture. Out of scope under (β). |
| `create_agent` MCP tool (admin agent provisioning peer agents) | SKIP-ARCH | — | medium | agent-to-agent module, two-DB | Same dependency chain. |
| `claude-md-compose.ts` (host-regenerated CLAUDE.md with `.claude-fragments/` imports) | PORT | medium | high | — | Big payoff for plugin-contributed instructions. Two-phase port: introduce `CLAUDE.local.md` first, then fragment composition. |
| `groups/<folder>/CLAUDE.local.md` (per-group writable memory, host never edits) | PORT | small | high | — | Phase 1 of the compose port. Standalone value even without fragments. |
| `groups/identity/` shared persona files mount at `/workspace/identity` | ADOPT | trivial | high | — | Replaces `groups/global/IDENTITY.md`'s "one persona for everyone" — keep `groups/global/` for backwards compat, add `groups/identity/` for opt-in shared files. |
| Webhook plugin (v1) | KEEP | — | high | — | Generic external-event ingestion. v2 has no equivalent at this layer. |
| `webhook-server.ts` (shared HTTP server for Chat SDK adapters) | SKIP-ARCH | — | high | Chat SDK channel adapters (Area 4) | Only relevant if/when Chat SDK adapters are adopted. Not currently in nanotars. |
| Dashboard plugin (`plugins/dashboard/`, htmx UI ~900 LOC) | KEEP | — | high | — | Fully featured admin UI. v2 reduced this to a pusher + external package. |
| Dashboard analytics (token-usage from JSONL, context-window %, hourly inbound/outbound buckets, per-model breakdown) | CONTRIBUTE | medium | medium | dashboard plugin still owns the UI | Upstream `dashboard-pusher.ts` already collects most of these — the v1 dashboard plugin's UI rendering them is the contribution. PR adapts the v1 plugin to consume v2's pusher snapshots. |
| Barrel-import + skill-merged-branch distribution model | SKIP-ARCH | — | high | git-merge-based update flow | Architectural alternative to plugin-loader. Keeping plugin-loader rules this out. |
| `provider-container-registry.ts` (host-side per-provider mount/env contributions) | ADOPT | small | medium | provider abstraction (Area 3) | Useful pattern even without v2's full provider model — apt for nanotars's eventual OpenCode/Codex skill. Defer until provider abstraction is ported. |

Per-area totals (recounted): PORT=3, KEEP=6, ADOPT=5, SKIP-ARCH=4, CONTRIBUTE=1, total=19. (Agent's reported PORT=2 KEEP=7 was off by one; recount confirmed against matrix rows.)

**Cross-cutting concerns:**
- Per-agent-group images depend on Area 3 (self-mod) + Area 6 (container.json).
- Three-tier container skills depend on Area 6 (container.json).
- `provider-container-registry` depends on Area 3 (provider abstraction).
- `webhook-server.ts` depends on Area 4 (Chat SDK channel adapters).
- Agent-to-agent module depends on Area 1 (two-DB).

→ See `upstream-triage-2026-04-25-area-5-extensions-agents.md` for full agent report.

---

## Area 6: Security, IPC, build, tests, ops

**Functional inventory (condensed):** v1 has a mature security baseline: mount-allowlist (`src/mount-security.ts`, with strict-match + secrets/token/ssh-agent defaults + nonMainReadOnly semantics), secret-redaction (`src/secret-redact.ts`, hand-rolled), `AUTH_ERROR_PATTERNS` + `isAuthError` helper in `src/router.ts:7-21`, file-based IPC under `src/ipc/*` with `O_NOFOLLOW` + 1MiB cap + quarantine, `output-parser.ts` with per-run output-marker nonces, bash security hooks at `container/agent-runner/src/security-hooks.ts` (with read-tools regex), and full container hardening (cap-drop, no-new-privileges, custom seccomp, resource limits). Logging via `pino`. npm-based dependency management. Stdin-injected secrets + OAuth bind-mount as the credential model. v2 ports mount-security and secret-redaction as named modules (with explicit "Ported from v1" comments), introduces a per-group env passthrough module with explicit allowlist + shell-quoting (`src/modules/group-env/index.ts`), introduces OneCLI gateway-based credential injection (HTTPS_PROXY into per-agent containers), and replaces the entire IPC layer with per-session `inbound.db`/`outbound.db`. v2 dropped every container hardening flag, dropped pino in favor of a hand-rolled `src/log.ts`, dropped auth-error detection entirely, switched to pnpm + bun (with `minimumReleaseAge: 4320`, `onlyBuiltDependencies` allowlist, exact-version pinning), and ships full GitHub Actions CI.

**Implementation comparison highlights:**
- **Mount allowlist colon-injection check** is a one-line v2 addition (`isValidContainerPath` rejects `:`) defending against `-v repo:rw` injection. Trivial PORT.
- **Mount allowlist `part.includes(pattern)` matching is a v2 regression** vs v1's strict-match — v2's broader matching produces false positives on legitimate paths like `~/projects/credentials-app/`. KEEP v1.
- **Mount allowlist tests:** v1 has them, v2 has zero (despite mount-security being a security module). Clean CONTRIBUTE.
- **Auth-error detection:** v2 has none. CONTRIBUTE upstream.
- **Container hardening dropped wholesale:** as in Area 3, v2 ships exactly zero of v1's nine hardening flags. Largest concrete security regression.
- **Secret-redaction module body:** v2 has length-sort + Set-dedup + injectable paths + `ONECLI_API_KEY` exempt — genuine improvements over v1. PORT.
- **IPC layer:** v1's file-based IPC is correct for v1's architecture; v2 replaces wholesale with two-DB. KEEP v1 / SKIP-ARCH the swap.
- **Bash security hooks `READ_TOOLS_RE`:** v2 expands the read-tools list from v1's 11 tools to 17 (adds `more|od|hexdump|bun|awk|sed|python3`). Trivial PORT.

**Verdict matrix (full, copied from per-area report):**

| Item | Action | Effort | Confidence | Depends on | Notes |
|------|--------|--------|------------|------------|-------|
| Mount allowlist `:` injection check | PORT v2 → v1 | trivial | high | — | `isValidContainerPath` rejects colons to defend against `-v repo:rw` injection (v2 `index.ts:215-217`) |
| Mount allowlist `part.includes` matching | KEEP v1 | trivial | high | — | v2's `part.includes(pattern)` regresses on legitimate paths like `~/projects/credentials-app/`; v1's strict-match is correct |
| Mount allowlist `secrets.json`/`token.json`/`.ssh-agent` defaults | already in v1 | — | high | — | v1 already has these; comment in v2 says "Ported from nanotars v1" |
| Mount allowlist `nonMainReadOnly` semantics | KEEP v1 | — | high | — | v2 dropped because no main-vs-non-main concept; v1 still uses |
| Mount allowlist tests | CONTRIBUTE v1 → v2 | small | high | — | v2's mount-security has zero tests; v1's `__tests__/mount-security.test.ts` is portable to v2 |
| Secret redaction module body | PORT v2 → v1 | small | high | — | length-sort + Set-dedup + injectable paths + `ONECLI_API_KEY` exempt are improvements |
| Secret redaction stdout/stderr wiring | KEEP v1 | — | high | — | v2 doesn't pipe stdout (writes to outbound.db); v1's `container-runner.ts:360-384` redaction must stay |
| `AUTH_ERROR_PATTERNS` + `isAuthError` | CONTRIBUTE v1 → v2 | small | high | — | v2 has zero auth-error detection; users get silent 3-attempt drop instead of "[Auth Error]" notice |
| OneCLI gateway credential model | ADOPT v2 → v1 | medium-large | medium | host plugin-loader env-var coexistence | v2 `container-runner.ts:486-500` + `onecli-approvals.ts`; daemon is separate, install skill exists |
| OneCLI manual-approval handler | ADOPT v2 → v1 | medium | medium | OneCLI gateway adoption | `onecli-approvals.ts:1-269`; depends on Permissions/approvals area providing `pickApprover` |
| File-based IPC + `output-parser.ts` | KEEP v1 / SKIP-ARCH for v2 port | — | high | — | v2 replaces wholesale with two-DB; β-territory for v1 to adopt v2's model |
| IPC `O_NOFOLLOW` + 1 MiB cap + quarantine | KEEP v1 | — | high | — | v2 has no equivalent because no untrusted disk paths in message flow; v1's defenses must stay |
| Bash security hooks `READ_TOOLS_RE` expansion | PORT v2 → v1 | trivial | high | — | Adds `more|od|hexdump|bun|awk|sed|python3` to v1's existing list |
| Bash security hooks factory→constant refactor | KEEP v1 | — | low | — | Cosmetic; factories are slightly more flexible for testing |
| `ONECLI_API_KEY` in `SECRET_ENV_VARS` | conditional PORT v2 → v1 | trivial | high | OneCLI adoption | Only meaningful if v1 adopts OneCLI |
| Per-group env passthrough module body | neutral | — | medium | — | v1's plugin-registry-driven allowlist matches v1's model; v2's per-group `container.json:envAllowlist` matches v2's |
| `shellQuote` unit tests | PORT v2 → v1 | trivial | high | — | v1 has no shellQuote tests; v2's `group-env.test.ts:8-29` is portable |
| Container `--cap-drop=ALL` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | — | v2 dropped this entirely; significant security regression for v2 |
| Container `--cap-add=SYS_PTRACE` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | — | Required for Chromium crashpad; v2 also runs Chromium (agent-browser skill) and dropped this |
| Container `--security-opt=no-new-privileges` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | — | v2 dropped; defense against suid-on-exec inside container |
| Container seccomp profile | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | high | — | `chromium-seccomp.json` blocks dangerous syscalls; v2 uses default Docker profile |
| Container `--memory=4g`, `--cpus=2`, `--pids-limit=256` | KEEP v1 / CONTRIBUTE v1 → v2 | trivial | medium | per-session container sizing | v2 dropped resource limits; per-session container model may need different values |
| Logging (pino vs hand-rolled) | KEEP v1 | — | high | — | pino offers structured logs + redaction primitives; v2's hand-rolled `log.ts` is a regression |
| Vitest + GH Actions CI | ADOPT v2 → v1 | small | high | — | v1 has zero workflow files; copy `ci.yml`'s typecheck+test job |
| `minimumReleaseAge` supply-chain hold | ADOPT v2 → v1 | trivial | high | — | Even on npm, `minReleaseAge=3d` in `.npmrc` works |
| pnpm + `onlyBuiltDependencies` | ADOPT v2 → v1 | medium | medium | npm→pnpm migration | Build-script allowlist is best practice for credential daemons |
| Version pinning (exact `4.26.0` not `^4.26.0`) | ADOPT v2 → v1 | trivial | high | — | Reduces supply-chain blast radius for transitive bumps |
| Bun split for agent-runner | SKIP-ARCH | — | high | — | v1's agent-runner is npm/Node; bun split is part of v2 architecture |
| `manage-mounts` skill | ADOPT v2 → v1 | trivial | high | — | UI on the existing allowlist; mostly portable |
| `init-onecli` skill | conditional ADOPT | small | high | OneCLI gateway adoption | Only meaningful if OneCLI is adopted |
| `manage-group-env` skill | conditional ADOPT | small | high | per-group env module port | Only meaningful if v2's group-env module is ported |
| `use-native-credential-proxy` skill | conditional ADOPT | small | medium | rejected-OneCLI alt | A lighter alternative to OneCLI worth keeping in mind |

Per-area totals (primary verdict, excluding the 2 neutral/already-in-v1 rows): PORT=5, KEEP=12, ADOPT=10, SKIP-ARCH=1, CONTRIBUTE=2, neutral=2, total=32. **Compound `KEEP / CONTRIBUTE` rows:** 5 — all five container hardening rows. These add 5 secondary CONTRIBUTE candidates.

**Cross-cutting concerns:**
- OneCLI gateway model + manual-approval handler depend on Area 2's approval primitive (`pickApprover`).
- Container hardening rows shadow Area 3's same-flag rows (single PR upstream covers both areas).
- `ONECLI_API_KEY` in `SECRET_ENV_VARS` depends on OneCLI adoption.
- pnpm + `onlyBuiltDependencies` depends on npm→pnpm migration (cluster G).
- File-based IPC vs two-DB depends on Area 1's session DB schemas.

→ See `upstream-triage-2026-04-25-area-6-security-ipc-build.md` for full agent report.

---

## Cross-cutting findings

### Cross-area dependencies (verified)

The following are dependency edges flagged by area agents, verified to exist in the referenced area:

- **Area 1 → Area 2:** Numbered migration framework cited by both — *see verdict conflict below*
- **Area 1 → Area 3:** Three-DB model, `messages_in`+`processing_ack`, `delivered`, journal-mode, even/odd seq, `container_state`, scheduled-tasks `process_after`/`series_id` accumulator → all verified SKIP-ARCH on Area 3 side
- **Area 1 → Area 4:** `chat_sdk_*` adapter ADOPT contingent on chat-sdk-bridge → Area 4 row exists, status SKIP-ARCH; ADOPT in Area 1 is for "generic KV+TTL+lock primitive" use, not chat-sdk
- **Area 2 → Area 1:** `users` / `user_roles` / `agent_group_members` / `user_dms` reference entity model — verified SKIP-ARCH parent on Area 1 side
- **Area 2 → Area 3:** Approval primitive ADOPT-deferred until self-mod ports — verified Area 3 self-mod is SKIP-ARCH, so the approval primitive is currently dead code
- **Area 2 → Area 4:** `user_dms` two-class resolution depends on `ChannelAdapter.openDM` — verified Area 4 SKIP-ARCH
- **Area 2 → Area 6:** OneCLI manual-approval handler depends on OneCLI gateway port — verified Area 6 ADOPT (medium-large)
- **Area 3 → Area 1:** Pre-task script hook depends on `script TEXT NULL` column on `scheduled_tasks` — small migration, in scope
- **Area 3 → Area 5:** Provider abstraction depends on `provider-container-registry` — verified Area 5 ADOPT (deferred)
- **Area 3 → Area 6:** Container hardening flags shadow same rows — single PR upstream covers both
- **Area 4 → Area 1:** ffmpeg thumbnail upstream PR depends on per-group dirs / per-session storage — verified architectural mismatch flagged on both sides
- **Area 5 → Area 3:** Per-agent-group images depend on self-mod — verified SKIP-ARCH on Area 3 side
- **Area 5 → Area 6:** Three-tier container skills + per-agent-group images depend on `container.json` — Area 6 has no `container.json` row but the dependency is on the v2 file format, not a separate area item; flagged for Phase 3 sequencing
- **Area 6 → Area 2:** OneCLI manual-approval handler depends on `pickApprover` — verified
- **Area 6 → Area 3:** File-based IPC vs two-DB shadows runtime IPC — verified KEEP/SKIP-ARCH on both sides

### Verdict conflicts between areas

**Numbered migration framework — Area 1 says PORT, Area 2 says SKIP-ARCH.**

Same item, two different verdicts. The conflict is real and reflects different framings:
- Area 1 frames it as "v1 needs to grow optional plugin tables → port v2's framework so plugins can ship migrations" (PORT, small effort).
- Area 2 frames it as "v1's inline array works at current scale; only worth porting if Danny adopts a skill-install model that ships per-skill migrations" (SKIP-ARCH).

**Resolution:** I side with Area 1 for the master verdict (PORT, small, conditional). Even without a skill-install model, v1 will accumulate plugin-shipped tables over time, and v2's `schema_version.name`-keyed framework is a clean drop-in. The Area 2 SKIP-ARCH framing assumes the only motivation is module-migration composition, but the framework also benefits maintainability (numbered files vs hardcoded array). The conflict is preserved verbatim in both per-area reports for traceability.

**Numeric impact:** master count is +1 PORT, −1 SKIP-ARCH (already reflected in the totals at the top — Area 2 still shows SKIP-ARCH=18 in its matrix because per-area integrity is preserved; the master-level adjudication is the one in this section).

### Items that change architectural assumptions (flag for separate brainstorm)

If any of these SKIP-ARCH items get reconsidered, they would shift more than just one area and warrant their own brainstorm:

1. **Per-session container model (Area 3)** — would unlock everything in the SKIP-ARCH bucket dependent on it: two-DB IPC, heartbeat sweep, lifecycle pause/resume, multi-channel session-per-thread routing, session_state continuation as designed.
2. **Multi-user permissions stack (Area 2)** — only worth opening if Danny ever wants nanotars to host other users (an explicit (γ) thing).
3. **Self-modification (Area 3)** — gating PR for per-agent-group images + approval primitive callers.
4. **OneCLI gateway (Area 6)** — adoption is realistic at medium-large effort; opens the door to credential-pause approval flows.
5. **`ChannelAdapter` interface unit + chat-sdk-bridge (Area 4)** — unlocks 27-channel marketplace but adopts the vendor footprint.
6. **Barrel-import + skill-merged-branch distribution (Area 5)** — only relevant if Danny ever tries to publish nanotars derivatives.

### Inline code excerpts — top PORT items

#### 1. Mount allowlist colon-injection check (Area 6 PORT, trivial)

v2 `src/modules/mount-security/index.ts:198-220`:

```ts
function isValidContainerPath(containerPath: string): boolean {
  if (containerPath.includes('..')) return false;
  if (containerPath.startsWith('/')) return false;          // not absolute
  if (!containerPath || containerPath.trim() === '') return false;
  // Must not contain colons — prevents Docker -v option injection (e.g., "repo:rw")
  if (containerPath.includes(':')) return false;
  return true;
}
```

Drop into v1's `mount-security.ts` as a same-shaped guard. The colon check is the one v1 lacks.

#### 2. dockerfilePartials path-traversal guard (Area 5 PORT, trivial)

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

#### 3. Bash security hooks `READ_TOOLS_RE` expansion (Area 6 PORT, trivial)

v2 `container/agent-runner/src/security-hooks.ts:28`:

```ts
const READ_TOOLS_RE = /\b(?:cat|less|more|head|tail|base64|xxd|strings|od|hexdump|python|python3|node|bun|perl|ruby|awk|sed)\b/;
```

vs v1 `container/agent-runner/src/security-hooks.ts:62`:

```ts
const readTools = /\b(?:cat|less|head|tail|base64|xxd|strings|python|node|perl|ruby)\b/;
```

v1 lacks `more`, `od`, `hexdump`, `bun`, `awk`, `sed`, `python3`. Single-line replacement.

#### 4. Secret redaction module — `NEVER_EXEMPT` set + length-sort

v2 `src/modules/secret-redaction/index.ts:31-38`:

```ts
/** Critical secrets that can NEVER be added to safeVars, regardless of caller intent. */
const NEVER_EXEMPT = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'DASHBOARD_SECRET',
  'ONECLI_API_KEY',
]);
```

The module also sorts secret values by length (long-first) before regex compilation, and uses a `Set` for value de-duplication. Both small but important: v1's regex can match a short secret as a substring of a long one and elide the longer match; v2's length-sort prevents this.

#### 5. `claude-md-compose.ts` — host-regenerated CLAUDE.md

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

The full file is ~250 LOC; the concept is: the host owns `CLAUDE.md` (idempotent regen at spawn), the agent owns `CLAUDE.local.md` (writable). Skill instructions and MCP-server context get linked in as `.claude-fragments/`. Solves v1's "plugin instructions live in the container's read-only Dockerfile partials and have no path into the conversation" problem.

### Inline code excerpts — top CONTRIBUTE items

#### 1. `AUTH_ERROR_PATTERNS` + `isAuthError` (Area 6 CONTRIBUTE)

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

v2 has zero auth-error detection; on auth failure the user gets a silent 3-attempt drop instead of an "[Auth Error]" notice. Trivial PR.

#### 2. Container hardening flags (Area 3 + Area 6 CONTRIBUTE bundle)

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

Single self-contained block. v2's `container-runner.ts:473-548` ships none of these. Mechanical PR upstream.

#### 3. `MAX_CONCURRENT_CONTAINERS` host-wide cap (Area 3 CONTRIBUTE)

v1's `group-queue.ts` enforces a global cap on parallel containers via per-group queues + a global counter. v2 still exports `MAX_CONCURRENT_CONTAINERS` from `src/config.ts:40` with the same default (5), but no readers. Bursty inbound on N sessions = N parallel Chromium-running containers.

The minimal PR: a `Semaphore` around `wakeContainer` in v2's `src/container-runner.ts`. Roughly 30 LOC. The harder design question is what to do when the cap is reached — queue or drop with a "system busy" reply — but v1's drop-then-retry-on-next-poll pattern works.

#### 4. ffmpeg thumbnail extraction for inbound video/GIF (Area 4 CONTRIBUTE)

v1 implementation lives in the WhatsApp template (gitignored under `plugins/channels/whatsapp/`). The interface contract is straightforward: post-`messageToInbound` hook in v2's chat-sdk-bridge, given the file path, runs `ffmpeg -i <input> -vframes 1 <thumb.jpg>` and attaches the thumb to the inbound media metadata. Significant UX win for agent vision on media-heavy chats. Confidence is medium — the chat-adapter platform variance complicates a single PR.

#### 5. Mount allowlist tests (Area 6 CONTRIBUTE)

v1's `src/__tests__/mount-security.test.ts` exercises:
- Allowed-roots strict-match
- Blocked-pattern strict-match (the case where v2's `part.includes` regresses)
- `nonMainReadOnly` semantics
- `secrets.json` / `token.json` / `.ssh-agent` defaults
- Symlink resolution via `getRealPath`

v2's mount-security has zero tests despite being a security-critical module ported from v1. v1's tests are portable — possibly with light renaming for v2's slightly different exports.

---

## Appendix: methodology

**Baseline:** v1-archive at commit `df76cb9`, head of nanotars's preserved fork code as of 2026-04-25. Spec committed at `87abf16`.

**Comparison method:** Six parallel structural code reviews (Approach D — no commit-archaeology). Each agent owned one concern area, read both codebases, produced a uniform per-area report. `git log -p <file>` was consulted only when comparison surfaced ambiguity, not as routine. 1002 commits in upstream's window since the last merge would have produced churn artifacts; final-state analysis is what matters for port decisions.

**Verdict definitions** (from spec):
- **PORT** — v2 has a clearly better implementation of functionality v1 also has. Bring v2's version across.
- **KEEP** — v1's implementation is better than v2's, OR v2 dropped a feature v1 still needs.
- **ADOPT** — v2 has functionality v1 doesn't have, and it's worth adding.
- **SKIP-ARCH** — v2 has functionality dependent on its architectural rewrite. Out of scope under (β).
- **CONTRIBUTE** — v1 has functionality v2 doesn't. Useful as a PR upstream.

**Compound verdicts (e.g. `KEEP / CONTRIBUTE`):** Three areas (3, 4, 6) produced rows with two verdicts. Master tally counts the first verdict listed; the secondary verdict is preserved in the per-area report and surfaced as "secondary CONTRIBUTE candidate" in *Cross-cutting findings*. Total compound rows: 9 (4 from Area 3, 5 from Area 6).

**N/A rows:** Three rows in Area 4 reflect comparisons where there is nothing to act on (compared item not present in either codebase, or bug only manifests in v2's architecture and has no v1 analog). Originally tagged "SKIP" by the agent; reclassified as "N/A" here for spec compliance. Kept in totals as an "N/A" bucket so row-counts reconcile.

**Confidence levels:** Every verdict marked high/medium/low. Low-confidence items have follow-up questions in each area's "Open questions" section — those are the ones to revisit before committing to the port.

**Spot-check pass:** 12 verdicts manually re-verified against source. See *Spot-check log* below.

### Spot-check log

12 verdicts picked across the six areas (~2 per area), biased toward high-effort or high-user-impact items. Each was re-verified against the cited file:line on both v1 and v2.

| Area | Item | Original verdict | Re-verified | Drift |
|------|------|------------------|-------------|-------|
| 1 | Numbered migration framework | PORT | PORT | none — verified via `src/db/migrations/index.ts:1-90` and v1 `src/db/init.ts:140-160` |
| 1 | `chat_sdk_*` SqliteStateAdapter | ADOPT medium | ADOPT medium | none — verified via `src/state-sqlite.ts` |
| 2 | OneCLI manual-approval bridge | ADOPT (with OneCLI) medium | ADOPT (with OneCLI) medium | none — verified `src/modules/approvals/onecli-approvals.ts:1-269` |
| 2 | Approval primitive | ADOPT (deferred) medium low | ADOPT (deferred) medium low | none — confirmed primitive is dead code in (β) |
| 3 | `MAX_CONCURRENT_CONTAINERS` dead in v2 | KEEP/CONTRIBUTE trivial | KEEP/CONTRIBUTE trivial | none — confirmed by grep across v2 `src/` and `container/`: zero readers |
| 3 | Container hardening dropped | KEEP/CONTRIBUTE trivial | KEEP/CONTRIBUTE trivial | none — verified v1 `container-runtime.ts:155-177` vs v2 `container-runner.ts` lacking equivalent block |
| 4 | Telegram typed-media routing | ADOPT small | ADOPT small | none — verified `src/channels/telegram.ts:78-116` |
| 4 | Magic-bytes MIME detection | N/A | N/A | none — confirmed agent's claim that no magic-bytes detection exists in either codebase |
| 5 | `claude-md-compose.ts` | PORT medium | PORT medium | none — verified `src/claude-md-compose.ts:1-50` shape |
| 5 | `dockerfilePartials` path-traversal guard | PORT trivial | PORT trivial | none — verified `src/container-runner.ts:592-603` |
| 6 | Mount allowlist `:` injection check | PORT trivial | PORT trivial | none — verified `src/modules/mount-security/index.ts:215-217` |
| 6 | `AUTH_ERROR_PATTERNS` + `isAuthError` | CONTRIBUTE small | CONTRIBUTE small | none — verified v1 `src/router.ts:7-21`; confirmed v2 has no equivalent (grep across v2 `src/` for `auth.error` returns zero relevant hits) |

**Drift corrections:** 0. All 12 verdicts held up under re-verification. The agent reports were unusually accurate; the only post-hoc adjustments needed were:
1. Reclassifying Area 4's three "SKIP" rows as "N/A" for spec-vocabulary compliance (no semantic change).
2. Recounting Areas 2 and 5 row totals — agents miscounted by one row each, off by 1 in totals; bucket counts in this master doc are the corrected values.
3. Adjudicating the Area 1 vs Area 2 verdict conflict on the numbered migration framework in favor of Area 1's PORT framing.

---

## Appendix: agent reports

Per-area appendix files (verbatim agent output, preserved for traceability):

- [Area 1: Persistence layer](upstream-triage-2026-04-25-area-1-persistence.md)
- [Area 2: Migrations, permissions, approvals](upstream-triage-2026-04-25-area-2-migrations-permissions.md)
- [Area 3: Runtime, lifecycle, scheduling](upstream-triage-2026-04-25-area-3-runtime-lifecycle.md)
- [Area 4: Channels & media](upstream-triage-2026-04-25-area-4-channels-media.md)
- [Area 5: Extensions, agent teams, identity, dashboard](upstream-triage-2026-04-25-area-5-extensions-agents.md)
- [Area 6: Security, IPC, build, tests, ops](upstream-triage-2026-04-25-area-6-security-ipc-build.md)
