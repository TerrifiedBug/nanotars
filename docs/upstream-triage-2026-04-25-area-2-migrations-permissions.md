## Area: Migrations, permissions, approvals

### Functional inventory

**v1-archive (nanotars):**

The v1 migration story is split across two files. The *schema migration system* — confusingly — lives inline in `src/db/init.ts:103-175`, not in `migrate.ts`. `init.ts:103-127` defines a hard-coded `MIGRATIONS` array (currently 5 entries: `001_add_context_mode` … `005_add_reply_context`), and `init.ts:129-175` runs them transactionally inside a `schema_version (version TEXT, applied_at TEXT)` table. Each migration is an `up: (db) => safeAddColumn(...)` closure (`init.ts:96-100`) that swallows "duplicate column" errors so re-runs against pre-existing v1 DBs are safe. There is a one-time sentinel-detection block (`init.ts:140-160`) that probes column existence on `messages` / `scheduled_tasks` / `registered_groups` and back-fills `schema_version` rows for installs that pre-date the migration system, so that fresh-as-of-2024 DBs and ALTER-laden legacy DBs converge.

`src/db/migrate.ts:11-78` is a different migration concern: a one-shot startup task (`runStartupTasks()`) that reads `data/router_state.json`, `data/sessions.json`, and `data/registered_groups.json` if present, replays them into the new `state` / `sessions` / `registered_groups` tables, and renames the JSON files to `*.migrated`. Once a v1 install has run once, those JSON files are gone and the function is a no-op.

The *permissions model* on v1 is implicit and entirely binary: either you are the "main group" or you are not. `src/config.ts:39` defines `MAIN_GROUP_FOLDER = 'main'` as a hard-coded constant. Every privilege decision in v1 reduces to `group.folder === MAIN_GROUP_FOLDER`, computed once at message-receive time and threaded through as an `isMain: boolean` parameter — see `src/orchestrator.ts:207`, `src/orchestrator.ts:357`, `src/task-scheduler.ts:114`, `src/ipc/index.ts:48`, `src/mount-security.ts:234`, and `src/container-mounts.ts:84`. The IPC authorization helpers in `src/ipc/auth.ts:6-35` are the closest thing v1 has to an "access module": `isAuthorizedForJid` returns true if the source group is main OR the target chat's `registered_groups.folder` matches the source; `authorizedTaskAction` is the same pattern for task IDs. There is no per-user role table, no admin concept, no membership concept — privilege is keyed off the group folder name and the operator implicitly trusts whoever can reach the main chat. `docs/SECURITY.md:5-11,57-69` documents this explicitly: "Main group / Trusted; Non-main groups / Untrusted; private self-chat, admin control."

There are no approval flows, no pending-state tables, no out-of-band confirmation cards. If a user can't pass `isMain || folder === sourceGroup`, the action is logged and dropped (`src/ipc/auth.ts:15`).

**upstream/main (nanoclaw v2):**

The migration framework is a numbered/named-file system under `src/db/migrations/`. Entry point `index.ts:36-73` creates a `schema_version (version INTEGER, name TEXT UNIQUE, applied TEXT)` table and runs any registered migration whose `name` is not present, transactionally per migration. Twelve migrations ship today — eight numbered (`001-initial.ts` … `013-approval-render-metadata.ts`, with gaps at 003-007 because those slots were renamed to `module-*` files for module-installed migrations) and three module migrations (`module-approvals-pending-approvals.ts`, `module-approvals-title-options.ts`, `module-agent-to-agent-destinations.ts`). The framework deliberately uses the migration's `name` as the uniqueness key rather than `version` (`index.ts:45-51,52-55`), so module migrations added later by skill installs can pick arbitrary version numbers without coordinating across modules; `version` is auto-assigned at insert time as a monotonic applied-order counter.

The permissions model is a five-way split. `001-initial.ts:41-83` creates `users (id, kind, display_name)`, `user_roles (user_id, role, agent_group_id, granted_by, granted_at)` with composite PK `(user_id, role, agent_group_id)`, `agent_group_members (user_id, agent_group_id, added_by, added_at)`, and `user_dms (user_id, channel_type, messaging_group_id, resolved_at)`. The role grammar is `role ∈ {owner, admin}`; owner rows must have `agent_group_id IS NULL` (global only — enforced at the application layer in `db/user-roles.ts:9-11`, not by schema), admin rows can be global (NULL) or scoped to one group. `modules/permissions/access.ts:21-28` is the central decision function: `canAccessAgentGroup(userId, agentGroupId)` returns `{allowed, reason}` after checking `isOwner → isGlobalAdmin → isAdminOfAgentGroup → isMember`. Admins are implicit members of the groups they administer (`db/agent-group-members.ts:28-36`).

`modules/permissions/user-dm.ts:52-112` is the cold-DM resolution primitive — `ensureUserDm(userId)` returns (or lazily creates) the `messaging_groups` row used to DM a user, with two-class resolution: direct-addressable channels (Telegram, WhatsApp, iMessage, email, Matrix — handle is the chat id) vs resolution-required channels (Discord, Slack, Teams — `adapter.openDM(handle)` round trip). Successful resolutions persist in `user_dms` and survive restarts (`user-dm.ts:65-75`).

The approvals system layers two flows on top of permissions. The *primitive* (`modules/approvals/primitive.ts`) exposes `requestApproval`, `pickApprover`, `pickApprovalDelivery`, and a `registerApprovalHandler(action, handler)` registry. `pickApprover` walks the approver hierarchy "scoped admins → global admins → owners" (`primitive.ts:76-93`); `pickApprovalDelivery` resolves the first approver with a reachable DM, preferring same-channel-kind as the origin (`primitive.ts:103-119`). Pending state lives in `pending_approvals` (`module-approvals-pending-approvals.ts`, action='install_packages' / 'add_mcp_server' / 'onecli_credential'), `pending_sender_approvals` (`011-pending-sender-approvals.ts`, unknown-sender flow), `pending_channel_approvals` (`012-channel-registration.ts`, unknown-channel-mention flow), `pending_questions` (`001-initial.ts:99-109`, generic ask_question flow), and `unregistered_senders` (`008-dropped-messages.ts`, just a counter for sweeping). The *OneCLI bridge* (`modules/approvals/onecli-approvals.ts`) registers a `configureManualApproval` callback with the OneCLI SDK that delivers a credential-request card, blocks on an in-memory Promise, and resolves on click or expires after a timer just-shy of the gateway's TTL (`onecli-approvals.ts:113-215`). Stale rows from a previous process are swept and edited to "Expired (host restarted)" at startup (`onecli-approvals.ts:247-255`).

The response side is `modules/approvals/response-handler.ts`. The handler dispatches OneCLI clicks first via `resolveOneCLIApproval` (in-memory Promise, `response-handler.ts:25-28`), then DB-backed actions via the `approvalHandlers` registry (`response-handler.ts:80-92`). Sender- and channel-approval response handlers are registered separately from the permissions module (`modules/permissions/index.ts:199-257` for sender, `:283-393` for channel), with click-auth enforced — the clicker must be the designated approver OR have admin privilege over the agent group, otherwise the click is silently consumed (`permissions/index.ts:208-218`, `:289-300`).

### Implementation comparison

**Functionality: Migration framework**
- v1 approach: Inline `MIGRATIONS` array with closure-based `up`s (`src/db/init.ts:103-127`); `safeAddColumn` swallows duplicate-column errors (`init.ts:96-100`); sentinel-detection back-fill for pre-migration-system installs (`init.ts:140-160`); `schema_version (version TEXT, applied_at TEXT)` keyed on `version` string. Five migrations total, all `ALTER TABLE ADD COLUMN`.
- v2 approach: Per-migration files in `src/db/migrations/`, each exporting a `Migration { version, name, up }` object (`migrations/001-initial.ts:5`, etc.); barrel `migrations/index.ts:22-34` registers them in order; `schema_version` keyed on `name UNIQUE`, `version` auto-assigned at insert time as applied-order counter (`index.ts:45-69`); ALTER paths use `IF NOT EXISTS` plus `PRAGMA table_info` guards (`012-channel-registration.ts:29-32`); module-prefix file naming for skill-installed migrations (`module-approvals-pending-approvals.ts`).
- Verdict: v2 is structurally cleaner — one file per concern, transactional, name-keyed for module composition. v1's approach is fine for 5 migrations but doesn't scale to module skills. **Neutral for a single-user fork** at v1's current size; the v2 module-migration story is the only thing v1 truly lacks, and v1 has no module-skill model anyway. PORT only if Danny ever introduces skill-installed migrations.

**Functionality: Schema-version table shape**
- v1 approach: `schema_version (version TEXT PRIMARY KEY, applied_at TEXT)` — version is the migration's name string (`init.ts:131-135`).
- v2 approach: `schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT)` with `UNIQUE INDEX idx_schema_version_name ON schema_version(name)` (`migrations/index.ts:38-44`). Uniqueness is on `name`, not `version`, deliberately.
- Verdict: v2's split version/name lets module migrations pick non-conflicting versions, which is invisible value at v1's current scale. Neutral for solo fork.

**Functionality: One-shot JSON→SQLite startup migration**
- v1 approach: `src/db/migrate.ts:12-78` reads `router_state.json` / `sessions.json` / `registered_groups.json`, replays into tables, renames to `*.migrated`. Idempotent by way of file rename.
- v2 approach: Not present. v2 has no JSON-state heritage to migrate from.
- Verdict: KEEP. v1 needs this for legacy installs; v2 has no equivalent because v2 was greenfield. Effectively dead code now (any live v1 install has long since run it), but cheap to leave in place.

**Functionality: Privilege model**
- v1 approach: One bit (`isMain`) computed from `group.folder === MAIN_GROUP_FOLDER` (`src/config.ts:39`, `src/orchestrator.ts:207`, etc.). Trust derives from "you can reach the main self-chat, therefore you are the operator" — see `docs/SECURITY.md:107-117`. No persisted role state, no per-user privilege.
- v2 approach: Two role types (`owner`, `admin`) on a `(user_id, agent_group_id)` axis where `agent_group_id NULL` = global, persisted in `user_roles` (`migrations/001-initial.ts:51-58`); separate `agent_group_members` for "known" status (`:63-69`); resolution in `modules/permissions/access.ts:21-28`. Approver-picking walks "scoped admin → global admin → owner" (`primitive.ts:76-93`). Privilege is user-keyed, not group-keyed — explicitly *not* "trust the main chat".
- Verdict: **SKIP-ARCH for the solo fork.** The v2 model exists to solve a problem v1 doesn't have: multiple users with differentiated trust across multiple agent groups. For a single-user install the operator IS the owner, the only admin, and the only member of every group; the v2 user_roles + agent_group_members + user_dms machinery collapses to "Danny" with no behavioral difference vs v1's `MAIN_GROUP_FOLDER === 'main'`. The v2 multi-user path also depends on (a) the entity model (users → messaging_groups → agent_groups → sessions) which v1 doesn't have, and (b) a stable namespaced user-id convention (`channel:handle`) which v1's per-channel JIDs don't expose uniformly. Adoption cost is high; benefit is zero until Danny invites a second human.

**Functionality: IPC authorization**
- v1 approach: `src/ipc/auth.ts:6-17` `isAuthorizedForJid(chatJid, registeredGroups, sourceGroup, isMain, action)` — main passes through; otherwise the source must own the target. Same pattern in `authorizedTaskAction` (`auth.ts:20-35`). 35 lines total.
- v2 approach: There is no IPC. The container speaks to the host via `inbound.db` / `outbound.db`, and the access gate is `setAccessGate` in `modules/permissions/index.ts:147-165` running over `canAccessAgentGroup`. Sender-scope is layered on top via `setSenderScopeGate` (`:175-183`).
- Verdict: SKIP-ARCH. The two designs aren't comparable — v2 abolished file-based IPC in the v2 cutover. v1's `src/ipc/auth.ts` is small and load-bearing; keep it. The v2 `setAccessGate` machinery is downstream of the entity model and has nothing to port without porting the entity model first.

**Functionality: Approval flow primitive (`requestApproval`, handler registry, OneCLI bridge)**
- v1 approach: None. No pending-state tables, no out-of-band confirmation cards. Self-modification (which approvals primarily gate) doesn't exist in v1; credential-use approval doesn't exist either (v1 has no OneCLI gateway — credentials are mounted directly per `docs/SECURITY.md:88-101`).
- v2 approach: `modules/approvals/primitive.ts:164-220` queues an approval, picks an approver+DM, delivers an `ask_question` card, persists to `pending_approvals`, and dispatches to a registered `ApprovalHandler` on click. OneCLI bridge in `onecli-approvals.ts` adds an in-memory Promise that resolves on click or expires; `response-handler.ts:24-43` dispatches in priority order (OneCLI in-memory → DB row → registered handler).
- Verdict: ADOPT — but conditional. The primitive is well-factored (~220 LOC), depends only on `getDeliveryAdapter`, `pickApprover`, `pickApprovalDelivery`, and a session for the notify channel. *But* it depends on multi-user permissions (`pickApprover` reads `user_roles`) and on the OneCLI gateway (for the credential-use case). For the v1 fork, the value props are: (a) self-modification approval if Danny ever ports `install_packages` / `add_mcp_server` (Area 3), and (b) credential-use approval if Danny ever ports OneCLI (Area 6). Without those two, the primitive has no callers. Recommend re-evaluating after Areas 3 and 6 land.

**Functionality: Approver picking + delivery resolution**
- v1 approach: Trivial — there's only one approver (the operator at the main chat). No DM-resolution problem because nanotars's main-group is by construction always reachable.
- v2 approach: `pickApprover(agentGroupId)` returns an ordered list "scoped admins → global admins → owners" with dedup (`primitive.ts:76-93`). `pickApprovalDelivery(approvers, originChannelType)` walks the list and returns the first reachable DM, preferring same-channel-kind (`primitive.ts:103-119`). `ensureUserDm` handles cold-DM creation across two channel classes (`user-dm.ts:52-112`).
- Verdict: SKIP-ARCH for the solo fork. Solving "which of my N admins do I poke" is a problem v1 doesn't have. The same-channel-kind tie-break is genuinely clever but unused by a one-admin install.

**Functionality: Pending sender / channel approval cards (auto-onboarding flow)**
- v1 approach: None. v1 has `sender-allowlist.ts` (referenced in the file inventory) but no in-flight-card flow. Unknown-sender messages are silently dropped or accepted based on the trigger pattern; unknown-channel messages don't exist as a concept because group registration is an explicit IPC operation from main (`src/ipc/tasks.ts` patterns).
- v2 approach: `pending_sender_approvals` (`migrations/011-pending-sender-approvals.ts`) and `pending_channel_approvals` (`migrations/012-channel-registration.ts`); request flows in `modules/permissions/sender-approval.ts:54-148` and `channel-approval.ts:58-171`; response handlers in `permissions/index.ts:199-257` (sender) and `:283-393` (channel). On approve: sender flow adds an `agent_group_members` row + replays the message; channel flow creates a `messaging_group_agents` wiring with `mention-sticky` / `pattern='.'` defaults + adds the sender + replays. On deny: channel flow sets `messaging_groups.denied_at` to silence future cards (`channel-approval.ts:25-28`).
- Verdict: SKIP-ARCH. This is the user-facing payoff of the multi-user model — strangers DM the bot, the owner gets a card, click-to-allow. For a solo fork on a personal Telegram/WhatsApp account it's pure complexity; Danny doesn't onboard random users mid-flight. Useful only if Danny starts running a public-facing agent, which the spec frames as out-of-scope under (β).

**Functionality: Click-auth on approval cards**
- v1 approach: N/A — no approval cards.
- v2 approach: `permissions/index.ts:208-218` and `:289-300`. Card-click sender is namespaced (`${channelType}:${userId}`) and required to match the designated `approver_user_id` OR have admin privilege on the agent group. Other clicks are silently consumed.
- Verdict: ADOPT *if* approval primitive is adopted (depends on the primitive port).

**Functionality: `pending_questions` table (generic ask_question state)**
- v1 approach: None. v1 doesn't have an ask_question primitive.
- v2 approach: `migrations/001-initial.ts:99-109`. Carries `(question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json)`. Used by the agent-side `ask_question` MCP tool to bind a card to its destination so a click can route back to the right session.
- Verdict: SKIP-ARCH — depends on entity model (sessions, messaging_groups). The underlying ask_question MCP tool is genuinely useful and might be worth porting separately under Area 5.

**Functionality: `unregistered_senders` table**
- v1 approach: None.
- v2 approach: `migrations/008-dropped-messages.ts:9-21`. Counter table keyed on `(channel_type, platform_id)` with `message_count` increment and `first_seen` / `last_seen` for sweeping unknown senders. Used to surface "who's been hammering on you" in admin tooling.
- Verdict: SKIP-ARCH. Diagnostic-only; no behavioral consequence; depends on the entity-model platform_id convention.

**Functionality: User-DM cache**
- v1 approach: N/A — there's only one user (the operator) and they always reach the bot via the main group, no resolution needed.
- v2 approach: `user_dms (user_id, channel_type, messaging_group_id)` table with `upsertUserDm` / `getUserDm` (`db/user-dms.ts`); `ensureUserDm` populates on first-use via `adapter.openDM` for channels that need it, or directly for channels where handle == chat id (`user-dm.ts:117-134`).
- Verdict: SKIP-ARCH. Multi-user-only.

**Functionality: Migration sentinel detection (back-fill schema_version on legacy installs)**
- v1 approach: `init.ts:140-160` probes columns on `messages` / `scheduled_tasks` / `registered_groups`, decides "yep, all the pre-migration-system migrations were applied via raw `ALTER TABLE` before this code was written," and inserts the corresponding `schema_version` rows so the migration runner doesn't re-apply them.
- v2 approach: None — v2 schema_version was present from migration 001.
- Verdict: KEEP / CONTRIBUTE. v1's sentinel pattern is genuinely useful and slightly clever; it's the standard "detect legacy DBs" pattern but the implementation is small and surgical. Not worth contributing to upstream specifically (v2 is greenfield and has no use for it), but worth keeping in the v1 fork.

**Functionality: Migration retroactive-fix pattern**
- v1 approach: None.
- v2 approach: `module-approvals-title-options.ts:18-39` shows v2's approach to fixing a migration that was edited *after* it shipped: a follow-up migration with `addIfMissing` that swallows "duplicate column" / "already exists" errors. Same `safeAddColumn` pattern as v1 `init.ts:96-100`, just spelled differently.
- Verdict: Neutral. Both sides have the same pattern under different names.

### Verdict matrix

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
| OneCLI manual-approval bridge (`onecli-approvals.ts`) | ADOPT (with OneCLI) | medium | medium | OneCLI gateway port (Area 6) | Bundle the bridge with the OneCLI port; standalone it's pointless. Includes the short-id Telegram callback_data workaround (`:55-65`) |
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

Totals: PORT 0 / KEEP 2 / ADOPT 4 (all approval-primitive bundle, conditional on Areas 3+6) / SKIP-ARCH 19 / CONTRIBUTE 0 → **Total 25**.

### What surprised me

1. **The v1 schema-migration system isn't in `migrate.ts`.** The file the spec pointed me at handles a one-shot JSON-to-SQLite migration only, which is a totally different concern. The actual migration runner lives inline at the bottom of `src/db/init.ts:103-175` with the `MIGRATIONS` array. This is a documentation/file-organization wart, not a behavioral one — but it means the casual reader looking at `migrate.ts` would conclude v1 has no schema migration system, when in fact it has a perfectly serviceable one. Worth flagging when synthesizing the master doc so the executive summary doesn't repeat the assumption.

2. **The v2 migration framework keys uniqueness on `name`, not `version`.** `index.ts:45-51` deliberately uses `name UNIQUE` and auto-assigns `version` at insert time. The reason (per the comment): module migrations added by skill installs can pick arbitrary version numbers without coordinating across modules. This is a meaningful design choice that I'd have missed on a casual read — it explains the otherwise-bizarre file naming where some migrations have `version: 3` (`module-approvals-pending-approvals.ts:20`), some have `version: 4` (`module-agent-to-agent-destinations.ts:23`), and some have `version: 7` (`module-approvals-title-options.ts:20`), with no `005-` or `006-` files on disk. The version numbers in the ordered array (`index.ts:22-34`) are the actual application order; the file numbers are advisory.

3. **Migration 011 contains a postmortem on a previous failed migration.** `migrations/011-pending-sender-approvals.ts:6-15` documents that an earlier version of the migration tried to rebuild `messaging_groups` to flip a column DEFAULT, hit SQLite's foreign-key integrity check at DROP time on live DBs with existing references, and was rolled back to "ALTER ADD COLUMN only" + hardcoded the new default in `router.ts` instead. This is a useful real-world lesson: `PRAGMA foreign_keys` and `defer_foreign_keys` cannot be toggled inside the implicit migration transaction — table rebuilds against FK-referenced tables will fail. v1 doesn't have this concern (its migrations are all `ADD COLUMN`), but it's a landmine if Danny ever adopts the v2 framework and tries to rebuild a referenced table.

### Cross-cutting concerns

- **Permissions tables → entity model (Area 1).** The entire v2 permissions stack assumes the `users` / `agent_groups` / `messaging_groups` / `messaging_group_agents` foreign-key graph from migration 001. Porting any of `user_roles`, `agent_group_members`, `user_dms` requires the entity model first. The verdict-matrix `Depends on: entity model (Area 1)` rows all collapse to the same blocker. If Area 1 verdicts SKIP-ARCH on the entity model (likely), all permissions verdicts inherit it.

- **Approval primitive ↔ self-modification (Area 3).** `requestApproval` exists primarily to gate `install_packages` / `add_mcp_server` (per `module-approvals-pending-approvals.ts:6-9`). If Area 3 SKIP-ARCHes self-modification, the approval primitive has only one caller left (OneCLI), and bundling it with Area 6 is more natural than calling it ADOPT here.

- **Approval primitive ↔ OneCLI gateway (Area 6).** The OneCLI bridge is half the value of the approval primitive. Area 6 will decide whether OneCLI is in scope for the fork; if it's SKIP-ARCH, the approval primitive's second-largest caller goes away too. This area's "ADOPT (deferred)" verdicts on the primitive are conditional on either Area 3 OR Area 6 wanting it.

- **`ensureUserDm` ↔ channel adapter `openDM` (Area 4).** The two-class DM resolution depends on `adapter.openDM` for resolution-required channels (Discord, Slack, Teams). v1's `Channel` interface (`src/types.ts:96-107`) has no `openDM` method. Porting `ensureUserDm` requires extending the v1 channel interface — flag this for Area 4.

- **Migration 010 (`engage_modes`) touches `messaging_group_agents`** — that table is the entity-model backbone, so if Area 1 SKIP-ARCHes the entity model, migration 010 is moot. Flag for Area 1 cross-reference.

- **Migration 008 (`unregistered_senders`)** is a borderline Area-1 concern (table creation) but gets evaluated here because its only consumers are the dropped-message / approval flows. Flag for Area 1 to confirm it's not also doing entity-model work.

- **Click-auth pattern** (`permissions/index.ts:208-218`) is a generally-useful pattern that v1's IPC auth doesn't have but doesn't need (v1 doesn't have inbound clicks — IPC is host-spawned). Won't port standalone, but worth keeping in mind if v1 ever grows clickable card UIs.

- **Host-side command gate (`command-gate.ts`)** — this is a v2 host-side feature that classifies slash commands and gates admin commands against `user_roles`. v1 has no equivalent, and the v2 implementation is small (~64 LOC) but depends entirely on `user_roles`. Cross-references: Area 3 (lifecycle/command flow), Area 6 (host-side security).

### Open questions

1. **Is the OneCLI gateway in scope for the v1 fork at all?** If Area 6 verdicts OneCLI as SKIP-ARCH (the fork keeps the v1 mounted-credentials model from `docs/SECURITY.md:88-101`), then `onecli-approvals.ts` and the OneCLI half of `pending_approvals` should also SKIP-ARCH, and the approval-primitive ADOPT becomes even more conditional (only justified if Area 3 ports self-mod). My current verdict assumes OneCLI is at least *under consideration* for the fork.

2. **Does Danny ever use NanoClaw with a second human?** All of my SKIP-ARCH calls on the multi-user permissions stack assume "no, single-user solo install, no public agents." If Danny is contemplating opening the bot to a small set of trusted people (family, a small Discord server, etc.), the verdict on `user_roles` + `agent_group_members` + sender-approval flow shifts toward ADOPT. The CLAUDE.md banner doesn't constrain this either way.

3. **Should the `pending_questions` table port standalone with the `ask_question` MCP tool?** That MCP tool is genuinely useful for solo work too ("hey, should I deploy?" → buttons in the chat). I marked it SKIP-ARCH here because it depends on the v2 sessions table, but the actual interactive primitive has solo value. Defer to Area 5 for the MCP-tool half.

4. **Is the v1 sentinel-detection block (`init.ts:140-160`) worth contributing upstream?** The pattern is useful for any project that bolts a migration system onto an existing schema. v2 doesn't need it (greenfield), but the generic pattern could be a CONTRIBUTE. I marked KEEP because it has no obvious home in v2; tagging open for Danny's call.

5. **Click-auth claim semantics — is "claim and silently consume on auth failure" the right behavior?** `permissions/index.ts:217` and `:299` both `return true` on unauthorized clicks so they don't get unclaimed-logged. This means a stolen / forwarded card silently does nothing. Alternative would be returning `false` and letting the click propagate to a logging handler. Not a port question per se, but worth flagging for the bigger security review if the approval primitive is adopted.

6. **Should v1 adopt the v2 module-migration name-key uniqueness trick** (uniqueness on `name`, not `version`) even without the rest of the framework? It's a 5-line schema tweak and it future-proofs `init.ts:131-135` for skill-installed migrations. I marked SKIP-ARCH because v1 has no skill model, but if Danny is even tentatively considering one (per `migrate-nanoclaw` / fork-customization patterns), flipping the schema_version PK from `version TEXT` to `name TEXT UNIQUE` now is cheap insurance.
