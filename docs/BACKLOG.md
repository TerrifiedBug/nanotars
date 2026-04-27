# nanotars catch-up backlog

Outstanding items from the upstream catch-up. See `docs/upstream-triage-2026-04-25.md` for the full 154-row verdict matrix and rationale; this doc only tracks what is **not yet shipped**.

Markers:
- `[ ]` outstanding, not started
- `[~]` partially shipped (scaffolded, needs finishing)
- `[?]` unverified — needs a code check before being acted on
- `[x]` done (kept here briefly so the previous turn's "outstanding" list can be reconciled)

When an item lands, strike it through or delete the line. The triage doc keeps the durable record.

---

## Phase 1 — trivial wins

All Phase 1 items shipped. See the Reconciliation section at the bottom of this doc for callsites and verification dates.

## Phase 2 — medium architecture-preserving

**Cluster B — compose pipeline**
- [~] Three-tier container skills — shared `container/skills/` + per-group `groups/<folder>/skills/` + selection list in `container.json`. Shared tier exists (`container/skills/agent-browser`, `container/skills/self-customize`); per-group tier and selection mechanism not yet present.

**Cluster C — channels & media**
- [ ] Telegram typed-media routing (`sendPhoto` / `sendVideo` / `sendAudio` extension-dispatch) — closes the `sendFile` gap. Not present in `plugins/channels/telegram/index.js`.
- [ ] CLI always-on local-socket channel (Area 4, ADOPT medium).

(Cluster A items reassigned: chat_sdk_* KV adapter → Phase 6+7, per-provider session_state → Phase 5D. Cluster E secret-redact body parity verified — see Reconciliation.)

## Phase 4 — multi-user RBAC + entity model

Migrations 008-018 are in (`agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, `user_roles`, `agent_group_members`, `user_dms`, `pending_approvals`, `pending_sender_approvals`, `pending_channel_approvals`, `pending_questions`). Approval primitive (`pickApprover`, `registerApprovalHandler`) and `pending-questions` accessors are in. The remaining work is finish-and-verify, not new design.

- [x] 4A — sender-resolver + access-gate hooks wired through router/orchestrator. Verified in slice 4 audit (`docs/phase-4-5-audit-2026-04-27.md` §1) — `resolveSender` callsites at `src/orchestrator.ts:502, 843, 869` plus `sender_scope='known'` gate at lines 504-509 / 871-876.
- [x] 4B — `command-gate.ts` host-side command gate against `user_roles`. Verified slice 4 audit §2 — `src/command-gate.ts` exists; `checkCommandPermission` callsite chain at `src/ipc/auth.ts:58, 66` plus per-handler defensive re-checks. (The earlier "not yet found" note was stale.)
- [x] 4C — card-expiry timer + sweep coverage. Verified slice 4 audit §3 — `startApprovalExpiryPoll()` at `src/index.ts:139` + `sweepExpiredApprovals()` at `src/permissions/approval-expiry.ts:33-49`. Sender/channel coverage is via the unified-approval architecture (paired `pending_approvals` row).
- [x] 4C — OneCLI manual-approval bridge port. Verified slice 4 audit §4 — `src/permissions/onecli-bridge.ts` invoked at `src/index.ts:169` (`startOneCLIBridge()`) / `src/index.ts:261` (`stopOneCLIBridge()`).
- [x] 4D — `pending_sender_approvals` / `pending_channel_approvals` request/respond flows. Verified slice 4 audit §5 — `requestSenderApproval` invoked at `src/orchestrator.ts:518, 883`; `requestChannelApproval` at `src/orchestrator.ts:844`. Tests at `src/permissions/__tests__/{sender,channel}-approval.test.ts`.

## Phase 5 — capability bolt-ons

Migrations + scaffolding are in: `install_packages` and `add_mcp_server` MCP tools, host-side validation/approval queueing, `applyDecision` handlers, `notifyAgent`, lifecycle pause/resume (`emergency_stop` + `resume_processing` in `src/lifecycle-handlers.ts`), per-agent-group image build (`src/image-build.ts`), `create_agent` permissions stub (`src/permissions/create-agent.ts`), AgentProvider seam (`container/agent-runner/src/providers/`).

- [x] 5A — self-mod end-to-end. Verified slice 4 audit §6 — full flow asserted by `src/__tests__/self-mod-flow.test.ts` (Phase 5C-06 test): pending_approvals row, applyDecision mutates container_config + buildImage + restartGroup + notifyAfter + agent system message, denial path, invalid-input path.
- [x] 5B — `image-build.ts` invoked from install_packages live path. Verified slice 4 audit §7 — `buildAgentGroupImage` injected as the `buildImage` dep at `src/index.ts:151`.
- [x] 5C — `create_agent` MCP tool registered + wired. Verified slice 4 audit §8 — admin-gated tool registration at `container/agent-runner/src/ipc-mcp-stdio.ts:663-684`; host-side handler at `src/permissions/create-agent.ts` with re-validation + filesystem scaffold + member registration.
- [ ] 5D provider plugins — Codex / OpenCode / Ollama as plugins (not skill-branches). Provider seam is in (`container/agent-runner/src/providers/`); plugin-loader recognises `agentProvider: true` manifests (`src/plugin-loader.ts:440-462`); resolution reads `NANOCLAW_AGENT_PROVIDER` env var with `'claude'` fallback. No second real provider plugin shipped yet.
- [ ] 5D dependency — per-provider `session_state` continuation namespacing. v1's `sessions` table is `(group_folder PK, session_id)` — one continuation per group, not keyed by provider. Once a second provider lands under 5D, switching `NANOCLAW_AGENT_PROVIDER` for a group would feed a Claude session-id to the new provider's SDK and either reject or replay nothing. Re-key as `(group_folder, provider, session_id)` and update `setSession` / lookup paths in `src/orchestrator.ts` as part of the same slice that ships the second provider — designing the namespace shape blindly without a real consumer risks getting it wrong.

## Phase 6 + 7 — architectural foundation (OPTIONAL)

Per the triage doc, this is the only fully-optional block. Per-session containers + two-DB IPC + heartbeat sweep + Phase-6-enabled bolt-ons (cross-container agent messaging, supportsThreads, subscribe, admin-transport, per-provider session_state).

- [ ] Decision needed: commit to Phase 6 or formally close it as "skipped under technical-merit lens." If skipped, Phase 7 items roll into "won't fix" since they require Phase 6 to land.
- [ ] `chat_sdk_*` SqliteStateAdapter (KV + TTL + lock primitive) — defer until Phase 6 commits or until a real consumer surfaces. v2's `src/state-sqlite.ts` is the reference (~120 LOC, three tables: `chat_sdk_kv`, `chat_sdk_subscriptions`, `chat_sdk_locks`). v2's only consumer is `chat-sdk-bridge.ts` which is on the SKIP-ALT list (vendor lock-in to `@chat-adapter/*`). v1 has no current consumer; `pending-codes.json`'s file-with-mutex works fine for single-process. Phase 6's per-session two-DB IPC creates the natural consumer (per-session locks, KV with TTL for pending state). Pull this in alongside the Phase 6 commit if/when that block is taken.

## Plugin & marketplace ecosystem

nanotars's plugin model lives across two repos: this fork (`TerrifiedBug/nanotars`) ships only core + a few baseline skills; everything else (channels, integrations) lives in the marketplace at `TerrifiedBug/nanotars-skills` and is installed via the Claude Code plugin marketplace. Catch-up work that touches the entity-model schema, the channel plugin interface, or the plugin boundary rules has marketplace-side consequences that the triage doc didn't track.

**Marketplace schema-staleness sweep (mirrors the local skills sweep):**

Inventory done 2026-04-27: only 5 channel-plugin installer skills have raw SQL touching `registered_groups` (discord, slack, telegram, webhook, whatsapp). Container skills and non-channel plugin installers don't touch the DB at all. Total: 10 stale refs, much smaller than initially feared.

- [x] Patch the 5 channel-plugin SKILL.md files to use entity-model SQL — `TerrifiedBug/nanotars-skills#11` merged 2026-04-27.
- [x] **Decision: dropped the `compatibleNanotarsVersion` / CI-bot ideas.** Versioning infrastructure is over-engineered for a single-user installation, and the breakage was a one-time hit from the entity-model migration rather than a recurring drift problem. The right fix is enforcing the plugin boundary so skills don't reach into core schema in the first place — see the new "Skills MUST NOT query the SQLite database directly" rule in `CLAUDE.md` (added 2026-04-27).

**Deferred — `nanotars` CLI subcommands abstracting operator DB ops** (e.g. `nanotars groups list/view/status/update`, `nanotars debug groups`):

Would let core skills become 1-line CLI wrappers instead of inlining SQL, surviving any future schema migration without skill-side changes. Estimated 2-3 days to build (subcommand surface design + Node entry points + skill rewrites). Deferred until either (a) a future architecture change actually causes pain again, or (b) the in-container skill-creation flow needs a stable read API for agents in the container. The CLAUDE.md boundary rule + slice 3a/b sweep is the cheap fix that closes the current breakage; this CLI is the durable-but-not-yet-justified follow-up.

**In-container skill-creation flow correctness:**

- [x] Built `create-skill-plugin` container skill + `create_skill_plugin` MCP primitive + host handler. Skill-only and MCP archetypes only; archetypes 3/4 redirected to host. — slice 6, 2026-04-27
- [x] Decided artifact: bundled `container/skills/create-skill-plugin/SKILL.md` for the conversational flow + boundary rules added to `groups/global/CLAUDE.md`. — slice 6, 2026-04-27
- [x] End-to-end test: `src/__tests__/e2e/create-skill-plugin-flow.test.ts` covers IPC task → approval → files → restart for skill-only happy path, mcp with creds, archetype-3/4 rejection, and admin-rejected decisions. — slice 6, 2026-04-27
- [ ] In-container `gh` availability + auth surface — DEFERRED. Not unblocked or blocked by slice 6; only required for full Telegram→PR automation (option C from slice 6 brainstorm).
- [x] Periodic accuracy re-check: `scripts/check-skill-drift.sh` + `docs/skill-drift-log.md`. Soft CI hint on changes to plugin-interface files. — slice 6, 2026-04-27

**Deferred design question — `nanotars install <plugin>` CLI shortcut:**

Today, installing a marketplace plugin is a two-step flow: (1) install the plugin via Claude Code's marketplace (`/plugin install …`), (2) invoke `/add-skill-<plugin>` (or `/add-channel-<plugin>`) inside Claude to wire it into nanotars. The skills handle interactive parts (API-key prompts, group scoping, container rebuild). A `nanotars install <plugin>` CLI shortcut would collapse the second step but creates a real design tension worth discussing before building:

- The current install skills are **guided and interactive** — they prompt for credentials, ask about scoping, confirm before mutations. CLI form means either (a) reimplementing each plugin's install logic imperatively in TypeScript (forking the contract; every marketplace plugin author maintains both forms), or (b) shelling out to a headless Claude session running the skill (Claude is still in the loop — no real win).
- **Win:** scriptable batch installs (`nanotars install weather && nanotars install gmail && nanotars install trains`). Currently that requires interactive Claude turns per plugin.
- **Cost:** ongoing maintenance burden across the marketplace, OR the CLI becomes second-class and lags.

- [ ] Decide whether to build this. Three credible answers: (1) accept the friction — current 2-step flow is fine, defer indefinitely; (2) build a thin `nanotars install` that just shells out to Claude headless mode with the right skill name (smallest possible CLI surface, no plugin-author burden); (3) full imperative CLI install (bigger commitment, design needed for the interactive-prompt translation). My read leans toward (1) until batch-install actually becomes a recurring pain point — the current friction is operator-felt once per plugin, not in a hot loop.

## Admin slash-commands

Slice 5 (2026-04-27) shipped the scoped-down "admin commands only, main channel only" version of this section: dispatch chain, `/help`, `data/admin-commands.json` export, and Telegram `setMyCommands` autocomplete via merged marketplace PR `TerrifiedBug/nanotars-skills#12`. The original Hermes-parity bullets (plugin-extensible registration, agent-side registration, argument-parsing primitive, cross-channel parity) were explicitly cut during the slice 5 brainstorm — skills/plugins are picked up via Claude Code's SKILL.md context, not slash commands, so the slash-command surface stays admin-only and doesn't need a plugin-extension API.

Remaining incremental work (not blocking; pull in if/when one of these commands actually breaks under agent interpretation):

- [ ] Activate the 6 still-agent-interpreted admin commands in `dispatchAdminCommand` — `/grant`, `/revoke`, `/list-users`, `/list-roles`, `/register-group`, `/delete-group`, `/restart`. Each needs its own host-side `tryHandle*AdminCommand` module (the dispatcher is already structured to accept new handlers; adding one is ~20 LOC plus tests). Estimated ~1 day total if done as a single slice.

- [ ] **Bug — slice 5 slash commands not working in install.** Reported 2026-04-27 during slice 7 work. Two likely causes: (1) the install Telegram plugin (`~/nanotars/plugins/channels/telegram/index.js`) was last installed BEFORE slice 5 PR #12 merged, so it doesn't contain `setupAdminCommandAutocomplete` at all — no `/` autocomplete in Telegram UI. (2) Even with autocomplete fixed, the host-side dispatch may have regressed (admin-command-dispatch chain at `src/orchestrator.ts` line ~556). Investigation: re-install the marketplace Telegram plugin to pick up slice 5 changes; if `/help` still doesn't work, trace through `dispatchAdminCommand` with logging. Likely also tied to slice 7 changes if any introduce a code path skip. Test: `/help` should print the admin command list.

- [ ] **Bug — Telegram typing indicator never stops.** Reported 2026-04-27 during slice 5 debugging. The orchestrator at `src/orchestrator.ts` ~line 631 starts a `setInterval(fire, 4000)` typing indicator before `runAgent` and stores the handle in `typingInterval`. Symptom: indicator stays on permanently even after the reply is sent. Investigation: confirm there's a `clearInterval(typingInterval)` in the `finally` block that runs the agent — likely missing, or the variable scope is wrong so the clear doesn't see the right handle. Single-method bug. ~30 min to fix.

- [ ] **Member-management chat commands.** Slice 8 surfaced that `/grant` only operates on `user_roles` (admin-tier permissions). The other half of the access ladder — `agent_group_members` (interaction-tier membership for `sender_scope='known'` chats) — has no chat-command surface. Today members are added either via the `pending_sender_approvals` flow or via direct DB. Add: `/add-member <user_id> [--scope <folder>]` and `/remove-member <user_id> [--scope <folder>]`. Defaults to current chat's agent group. Owner/admin-gated. ~1h. Each handler is similar shape to `role-admin-commands.ts`. Wraps existing `addAgentGroupMember` / `removeAgentGroupMember` primitives in `src/permissions/agent-group-members.ts`. Smoke test: grant member, verify they can interact in a `sender_scope='known'` chat without admin powers.

- [ ] **`/grant --scope <folder>` for per-agent-group admins.** Schema supports it (`user_roles.agent_group_id` column) but `/grant` only sets global roles (NULL). Add `--scope <folder>` option to grant a role for one specific agent group only. Useful for multi-tenant setups: someone admins their `work` group but not your `main`. ~30 min in `role-admin-commands.ts`. Update `/list-roles` to show scope per row.

- [ ] **Custom roles beyond owner/admin.** Currently `'owner' | 'admin'` is a hardcoded type union. To add a new role (e.g. `editor`, `power-user`), update `src/permissions/user-roles.ts` (type), `command-gate.ts:checkCommandPermission` (gate threshold), `role-admin-commands.ts:VALID_ROLES`. Defer until a real use case surfaces — the existing owner/admin/member/stranger ladder probably covers most cases.

- [ ] Add `nanotars rebuild` subcommand that runs `npm run build && ./container/build.sh && nanotars restart` in one shot. Today operators have to remember which combination of host-build / container-build / service-restart applies to a given change (host code → npm + restart; agent-runner src → restart only because of the bind mount; Dockerfile/Dockerfile.partial / new deps → container build + restart). A single `rebuild` shortcut would prevent "did I forget a step?" debugging. Surfaced 2026-04-27 during slice 6 smoke test. Implementation: add a `rebuild)` branch to `nanotars.sh` and `setup/wrapper-template.sh` next to the existing subcommands. ~30 min.

- [ ] **Bug — `pair-main` doesn't grant `owner` role or seed `user_dms` for the first user.** The Phase 4 RBAC system (Apr 25) introduced `user_roles` gating for approval cards and `user_dms` for delivery routing, but the `pair-main` bootstrap flow (Apr 26, commit 10f2af5) seeds neither. Symptoms on a fresh install: `requestApproval` returns `hasApprover: false` (no role) AND `pickApprovalDelivery` returns `undefined` (no DM target) for every approval-card path. Surfaced 2026-04-27 during slice 6 smoke test — required two manual SQL inserts to unblock. Fix: in the pending-codes consumption path (or `registerForIntent` when `intent='main'`), if no `owner` exists yet, grant the consuming user `owner` AND `INSERT OR IGNORE INTO user_dms` pointing at the messaging group they paired in via (when `is_group=0`). Idempotent — repeat consumes would no-op. ~2h including regression tests that assert `listOwners()` and `getUserDm()` return the new user.

- [x] **UX — Telegram (and other rich-card channels) should render inline-button approval cards, not plain-text fallback.** `approval-delivery.ts:99` exposes `registerApprovalDeliverer(channel, fn)` — but no plugin/core code calls it, so the `deliverers` Map is always empty and every card falls through to `deliverApprovalCardAsText` ("reply approve/reject"). Telegram supports inline keyboards natively via `reply_markup.inline_keyboard`. Half-day of work in the Telegram channel plugin (`plugins/channels/telegram/index.js`, marketplace `TerrifiedBug/nanotars-skills`): (1) register a deliverer that sends `bot.api.sendMessage(chatId, body, { reply_markup: { inline_keyboard: [[{text:'Approve', callback_data:'approval:<id>:approve'}, {text:'Reject', callback_data:'approval:<id>:reject'}]] } })`, (2) wire `bot.on('callback_query')` to forward into `approval-click-router.ts`, (3) on decision, edit the original message via the persisted `platform_message_id` to show "✅ Approved" / "❌ Rejected". Same pattern would extend to Discord/Slack later. Surfaced 2026-04-27 during slice 6 smoke test. — closed by slice 7, 2026-04-27 (PR #13)

- [x] **Bug — self-mod handlers don't deliver approval cards.** `add_mcp_server`, `install_packages`, `create_skill_plugin` (slice 6, fixed in `95e378d`), and `create_agent` all call `requestApproval()` which persists a `pending_approvals` row + returns `{card, deliveryTarget}`, but only `channel-approval.ts` and `onecli-bridge.ts` actually invoke `deliverApprovalCard(...)`. Result: cards never reach admin chats — the row sits in pending until expired and the admin never sees it. Surfaced 2026-04-27 during slice 6 smoke test (slice 6's handler was patched in commit `95e378d`; the other three remain broken). Fix: copy the same fire-and-forget `deliverApprovalCard` block from `create-skill-plugin.ts` into `add-mcp-server.ts`, `install-packages.ts`, `create-agent.ts`. ~30 min total, mostly mechanical. Could also be hoisted into `requestApproval` itself for future-proofing. — closed by slice 7, 2026-04-27

## Side debt — schema-stale skills sweep (local)

Skills queried the dropped `registered_groups` schema (migration 009). 7 skills affected, 22 stale references total. All shipped 2026-04-27 in slices 3a-1 (canonical) and 3a-2 (the other six) — see entries below for landing slice + commit SHA:

- [x] `.claude/skills/nanotars-groups/SKILL.md` — 4 refs, 104 lines. Rewrite first as the canonical template for the others. — Done 2026-04-27 (slice 3a-1, canonical template).
- [x] `.claude/skills/nanotars-add-agent/SKILL.md` — 1 ref, 248 lines. — Done 2026-04-27 (slice 3a-2, commit cdd99a7).
- [x] `.claude/skills/nanotars-add-group/SKILL.md` — 7 refs, 282 lines. — Done 2026-04-27 (slice 3a-2, commit c68e93c).
- [x] `.claude/skills/nanotars-debug/SKILL.md` — 2 refs, 528 lines. — Done 2026-04-27 (slice 3a-2, commit 083068a).
- [x] `.claude/skills/nanotars-remove-plugin/SKILL.md` — 2 refs, 147 lines. — Done 2026-04-27 (slice 3a-2, commit ba262fd).
- [x] `.claude/skills/create-channel-plugin/SKILL.md` — 3 refs, 585 lines. — Done 2026-04-27 (slice 3a-2, commit e3d91f2).
- [x] `.claude/skills/nanotars-setup/SKILL.md` — 6 refs, 857 lines. — Done 2026-04-27 (slice 3a-2, commit 5a29862).

Each should switch to the three-table join (`agent_groups` ⋈ `messaging_group_agents` ⋈ `messaging_groups`) and target modern wiring fields (`engage_mode` / `engage_pattern` / `sender_scope` / `ignored_message_policy`) instead of `requires_trigger`.

(See "Plugin & marketplace ecosystem" above for the marketplace-side mirror of this sweep.)

## Comprehensive skill audit — every skill, every kind of staleness

Broader than the schema-stale sweep above. The schema sweep targets one known issue (`registered_groups` references); this audit catches everything else: outdated CLI commands, removed env vars, branding drift (`nanoclaw` vs `nanotars`), obsolete file paths, dropped MCP tools, wrong plugin manifest fields, references to skills/commands that no longer exist, incorrect trigger keywords, old onboarding flows, deprecated container mount paths, etc.

Run this AFTER the schema-stale sweep lands so the entity-model rewrites don't get re-audited.

**Scope:**
- Every `.claude/skills/*/SKILL.md` in this repo (~18 bundled skills today, count + names verified at audit time).
- Every `plugins/*/skills/**/SKILL.md` and `plugins/*/files/container-skills/SKILL.md` in `TerrifiedBug/nanotars-skills` (~25-30 marketplace plugins).

**Per-skill audit checklist:**
- [ ] Does the skill reference any dropped database tables or columns? (Beyond `registered_groups` — also check for old column names, removed migration artefacts.)
- [ ] Are referenced CLI commands still valid? (`nanotars` wrapper subcommands, slash-commands like `/pair-telegram`, `/pause`, `/grant`.)
- [ ] Are env var names still current? (`ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `NANOCLAW_AGENT_PROVIDER` — especially anything renamed `NANOCLAW_*` ↔ `NANOTARS_*`.)
- [ ] Is the branding consistent? (No `nanoclaw` references in user-facing prose where `nanotars` is the user-visible name.)
- [ ] Are file paths still valid? (`store/messages.db`, `plugins/`, `groups/`, `data/`, `~/.claude/`, container-side `/workspace/...`.)
- [ ] Are referenced MCP tools still registered? (`install_packages`, `add_mcp_server`, `ask_question`, `create_agent` — confirm each is in `container/agent-runner/src/mcp-tools/`.)
- [ ] Does the skill reference other skills correctly? (Slash-command names match installed skills; no references to removed skills like the dropped slack-formatting variant.)
- [ ] Are `plugin.json` schema fields current? (`channels`, `groups`, `containerEnvVars`, `containerHooks`, `containerMounts`, `publicEnvVars`, `dockerfilePartials`, `dependencies`, `agentProvider`/`providerName` — match `src/plugin-types.ts`.)
- [ ] Are trigger keywords / `description` triggers in the YAML frontmatter accurate against current usage?
- [ ] Does the skill assume an old onboarding flow? (Now `setup.sh` + `nanotars` wrapper + `data/onboarding.json`.)

**Output:** per-skill verdict (clean / minor-fix / rewrite-needed), captured as a tracker doc (suggested location: `docs/skill-audit-2026-MM-DD.md`). The audit doc is the input to fix-PRs landed across both repos.

- [ ] Run the audit (probably ~1-2d depending on skill count and whether subagents per-skill or one batched).
- [ ] Land fixes in waves grouped by issue class (one PR per issue class is easier to review than per-skill).
- [ ] Wire a CI check into `nanotars-skills` after the first audit so future PRs flag the same staleness classes automatically (compatible with the `compatibleNanotarsVersion` decision in the marketplace section).

## CONTRIBUTE upstream — opt-in goodwill PRs

These are nanotars wins missing in v2. Pure upside for upstream; no effect on this fork.

- [ ] Container hardening flags PR (`--cap-drop=ALL`, `--cap-add=SYS_PTRACE`, `--security-opt=no-new-privileges`, custom seccomp, `--cpus=2`, `--memory=4g`, `--pids-limit=256`). Single-block PR — biggest concrete security delta in the triage.
- [ ] `AUTH_ERROR_PATTERNS` + `isAuthError` PR (`src/router.ts:7`).
- [ ] `MAX_CONCURRENT_CONTAINERS` host-wide cap PR — v2 still exports the constant but never reads it; ~30 LOC semaphore-around-`wakeContainer`.
- [ ] Mount allowlist tests PR (`src/__tests__/mount-security.test.ts` portable; v2 ships zero tests for security-critical code).
- [ ] ffmpeg thumbnail extraction for inbound video/GIF PR (Area 4 UX win).
- [ ] `isValidGroupFolder` defense-in-depth on read path PR (Area 1).
- [ ] `context_mode` ('group' | 'isolated') on `scheduled_tasks` PR.
- [ ] Online backup hook (`db.backup` keep-2 retention) PR.
- [ ] `task_run_logs` table + recent-runs view PR.

## Reconciliation — items reported "outstanding" 2026-04-27 that turned out to be shipped

(Kept here briefly so memory observation 9286-9315 reconcile cleanly. Delete after first read.)

- [x] Mount allowlist colon-injection check — `src/mount-security.ts:213`.
- [x] `splitForLimit` + tests — `src/channel-helpers.ts:11`, `src/__tests__/channel-helpers.test.ts`.
- [x] `transformOutboundText` / `extractReplyContext` / `NetworkError` retry / `openDM` — all in `src/types.ts` + `src/router.ts` + `src/plugin-loader.ts` + `src/permissions/user-dms.ts`.
- [x] `unregistered_senders` table — `src/db/init.ts:272`.
- [x] `isValidGroupFolder` defense-in-depth — used in `src/task-scheduler.ts:68` and `src/permissions/create-agent.ts:35`.
- [x] `hasTable` helper — `src/db/init.ts:304`.
- [x] Numbered migration framework with `schema_version.name` — `src/db/init.ts:609-680` (18 migrations applied).
- [x] Pinned `CLAUDE_CODE_VERSION` ARGs + `tini` PID 1 + `minimumReleaseAge=4320` — all in `container/Dockerfile` and `container/agent-runner/.npmrc`.
- [x] `manage-mounts` skill port — `.claude/skills/manage-mounts`.
- [x] `context_mode` on scheduled_tasks + online backup hook + `task_run_logs` table — `src/db/init.ts`.
- [x] `secret-redact` module — `src/secret-redact.ts` (parity with v2's body still flagged `[?]` above).
- [x] `claude-md-compose.ts` + `CLAUDE.local.md` — `src/claude-md-compose.ts`.
- [x] Vitest + GH Actions CI — `vitest.config.ts`, `.github/workflows/ci.yml`.
- [x] Four-axis engage model — `src/db/init.ts:40-43` + migration `007_add_engage_mode_axes`.
- [x] Label-scoped orphan cleanup — `src/container-runtime.ts:93,117` uses `--filter label=...`.
- [x] Pre-task `script` hook on scheduled_tasks — migration `006_add_task_script`.
- [x] Router refactor onto (messaging_group, agent_group) — `src/orchestrator.ts:194-340`.
- [x] Lifecycle pause/resume — `src/lifecycle-handlers.ts`.
- [x] Per-agent-group image build — `src/image-build.ts`.
- [x] AgentProvider seam — `container/agent-runner/src/providers/factory.ts`.
- [x] OneCLI gateway — Cluster F shipped 2026-04-25; latest commit walks back the user-facing surface ("Option A: de-emphasize OneCLI").
- [x] `dockerfilePartials` path-traversal guard — `src/image-build.ts:43-49` (TypeScript path) + `container/build.sh:24-34` (shared base build path). Both code paths that resolve+read partials guard with `path.relative` (TS) or `readlink -f` + case-pattern (bash). Verified 2026-04-27.
- [x] `READ_TOOLS_RE` expansion — `container/agent-runner/src/security-hooks.ts:62` regex includes every tool from the triage list (`more`, `od`, `hexdump`, `bun`, `awk`, `sed`, `python3`) plus `cat`, `less`, `head`, `tail`, `base64`, `xxd`, `strings`, `python`, `node`, `perl`, `ruby`. Tests at `security-hooks.test.ts:72,86` cover `hexdump` and `bun`. Verified 2026-04-27.
- [x] `shellQuote` unit tests — extracted into `src/container-mounts.ts` as `shellQuote(value)`; tests in `src/__tests__/shell-quote.test.ts` (5 cases). Slice 1 work, 2026-04-27.
- [x] `secret-redact` body parity with v2 — verified 2026-04-27. v1 (`src/secret-redact.ts`, 170 lines) and v2 (`src/modules/secret-redaction/index.ts`, 171 lines) are functionally identical. Required behaviors all present in v1: length-sort + `Set` dedup at line 99, injectable paths via `LoadSecretsOptions.projectRoot` / `credentialsPath`, `ONECLI_API_KEY` in `NEVER_EXEMPT` (line 24). v1 is slightly more capable (back-compat array form on `loadSecrets`).
- [x] Slice 5 — admin-command dispatch chain + `/help` + `data/admin-commands.json` export. Shipped 2026-04-27 in commits `625b702` (ADMIN_COMMANDS Set→Map + accessors) → `8081b48` (`tryHandleHelpCommand`) → `0700ada` (`dispatchAdminCommand`) → `6539492` (orchestrator wiring) → `751ab81` (boot-time JSON export). Five commands now host-handled: `/help`, `/pause`, `/resume`, `/rebuild-image`, `/pair-telegram`. The other six `ADMIN_COMMANDS` members (`/grant`, `/revoke`, `/list-users`, `/list-roles`, `/register-group`, `/delete-group`, `/restart`) remain agent-interpreted; activating them is a future small slice. Marketplace Telegram plugin patch for `setMyCommands` shipped via `TerrifiedBug/nanotars-skills#12` (merged 2026-04-27 12:47 UTC; includes Greptile-caught scope fix `chat_administrators` → `all_chat_administrators`).
