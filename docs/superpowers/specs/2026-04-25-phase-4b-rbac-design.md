# Phase 4B: Users + RBAC — Design

**Status:** Approved 2026-04-25 (per Phase 4 brainstorm: full multi-user RBAC adoption under technical-merit lens, despite the triage's SKIP-ARCH-for-solo-fork verdict for Area 2 multi-user tables).

## Goal

Layer v2's identity + RBAC model onto v1's entity-model foundation (Phase 4A). Adds four tables (`users`, `user_roles`, `agent_group_members`, `user_dms`), real implementations for the `resolveSender`/`canAccessAgentGroup` hooks (replacing 4A stubs), the sender-scope gate (`'all' | 'known'`), and a host-side command gate that classifies admin slash-commands against `user_roles`. Subsumes v1's `src/sender-allowlist.ts` two-mode (`trigger`/`drop`) richness into the new `messaging_group_agents` schema.

## Scope decisions (locked)

These follow from the Phase 4 brainstorm (full multi-user as v2 envisions). New ones for 4B:

1. **User-ID convention.** Namespaced `<channel>:<handle>`, matching v2 (`tg:123456789`, `whatsapp:14155551212@s.whatsapp.net`, `discord:user_id`, `email:foo@bar.com`). Channel adapter is responsible for emitting the canonical handle. v1 doesn't link the same human across channels yet (Phase 4D may revisit).

2. **Owner bootstrap.** First user emitted by an inbound message gets the `owner` role automatically IF (a) no owner exists yet AND (b) the message arrives via the configured "main" channel/group. The "main group" concept in v1 (`MAIN_GROUP_FOLDER='main'`) becomes the bootstrap signal: messages arriving in main from a sender without a user_roles row are auto-bootstrapped to owner. Operator can override by manual SQL or a future `/grant` admin command.

3. **Sender-allowlist subsumption.** v1's `src/sender-allowlist.ts` (per-chat trigger/drop modes, fail-open) gets folded into the new schema:
   - `messaging_group_agents.sender_scope='all'|'known'` (Phase 4A column) wires the existing 4A semantics
   - The `'trigger'` vs `'drop'` mode distinction maps as: `mode='trigger'` ↔ `sender_scope='all'` (everyone triggers); `mode='drop'` ↔ `sender_scope='known'` (only known users trigger; unknown silently dropped). The legacy JSON file becomes a one-shot seed for migration; afterward all per-chat allowlist state lives in the DB.
   - Migration: v1's `JSON file → DB rows` happens as part of A1 of Phase 4B (a new migration that reads the JSON if present and seeds `agent_group_members`).
   - Per-chat allowlists (the `chats` map in JSON) translate to `agent_group_members` rows for the matching agent group.

4. **Identity merging not in scope for 4B.** A human appearing as both `tg:123` and `whatsapp:foo` is two `users` rows. Phase 4D may add a linking concept; 4B treats them independently.

5. **Migration policy still applies.** Each new table gets DDL in `createSchema` AND a numbered MIGRATIONS entry. Phase 4A's policy doc in CLAUDE.md governs.

## Schema

Four new tables, sequenced after the Phase 4A entity-model tables:

```sql
-- Platform-level identifiers, namespaced. A single human may have multiple
-- user rows across unrelated channels; no linking yet.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,                    -- "<channel>:<handle>"
  kind         TEXT NOT NULL,                       -- channel adapter name
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Role grants. Privilege is user-level, not group-level.
--   role ∈ {owner, admin}
--   owner: always global (agent_group_id IS NULL); enforced at app layer
--   admin: agent_group_id NULL = global, else scoped to one agent group
-- Invariant: admin @ A implies membership in A (no agent_group_members row needed).
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,                     -- 'owner' | 'admin'
  agent_group_id TEXT REFERENCES agent_groups(id),  -- NULL = global
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

-- "Known" membership in an agent group. Required for a non-privileged user to
-- interact with a workspace under sender_scope='known'. Admin @ A is implicitly
-- a member of A (no row needed).
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- Cold-DM cache: which messaging_group should be used to DM a given user on a
-- given channel. Lazily populated by ensureUserDm via either direct mapping
-- (channels where handle = chat id: WhatsApp, Telegram) or adapter.openDM
-- (channels where DMs need a round trip: Discord, Slack).
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

## Migrations

Each new table gets a CREATE TABLE in `createSchema` AND a numbered migration entry. After Phase 4A's `009_drop_registered_groups`, the next available number is `010`.

- `010_add_users` — CREATE TABLE users
- `011_add_user_roles` — CREATE TABLE user_roles + index
- `012_add_agent_group_members` — CREATE TABLE agent_group_members
- `013_add_user_dms` — CREATE TABLE user_dms
- `014_seed_sender_allowlist_to_members` — read v1's `SENDER_ALLOWLIST_PATH` JSON if present, translate per-chat allowlist to `agent_group_members` rows for the matching agent group(s). Owner-bootstrap not done here — that happens at runtime.

Five migrations is reasonable. Could be combined into fewer (e.g., one migration creating all four tables) — preference: one migration per table for clarity, but combining is also acceptable. Plan picks one-per-table.

## Functions / modules

New module: `/data/nanotars/src/permissions/access.ts` — replaces the 4A stubs in `/data/nanotars/src/permissions.ts`. Real implementations:

```ts
export function canAccessAgentGroup(userId: string | undefined, agentGroupId: string): { allowed: boolean; reason: string }
// Decision order: owner → global admin → scoped admin → member → reject
```

New module: `/data/nanotars/src/permissions/users.ts`:

```ts
export function ensureUser(args: { id: string; kind: string; display_name?: string }): User
export function getUserById(id: string): User | undefined
export function bootstrapOwnerIfMain(args: { user_id: string; messaging_group_id: string }): void
// bootstrapOwnerIfMain: if no owner exists AND messaging_group is the main one, grant owner
```

New module: `/data/nanotars/src/permissions/user-roles.ts`:

```ts
export function isOwner(userId: string): boolean
export function isGlobalAdmin(userId: string): boolean
export function isAdminOfAgentGroup(userId: string, agentGroupId: string): boolean
export function grantRole(args: { user_id: string; role: 'owner' | 'admin'; agent_group_id?: string; granted_by: string }): void
export function revokeRole(...): void
export function listOwners(): User[]
```

New module: `/data/nanotars/src/permissions/agent-group-members.ts`:

```ts
export function isMember(userId: string, agentGroupId: string): boolean
export function addMember(args: { user_id: string; agent_group_id: string; added_by?: string }): void
export function removeMember(args: { user_id: string; agent_group_id: string }): void
export function listMembers(agentGroupId: string): User[]
```

New module: `/data/nanotars/src/permissions/user-dms.ts`:

```ts
export function getUserDm(userId: string, channelType: string): MessagingGroup | undefined
export function ensureUserDm(args: { user_id: string; channel_type: string; channel_adapter: ChannelAdapter }): Promise<MessagingGroup | undefined>
// Two-class resolution:
//   Direct (handle=chat_id): WhatsApp, Telegram, iMessage, email, Matrix
//     - Synthesize messaging_group from user.id's handle portion; persist
//   Indirect (round-trip required): Discord, Slack, Teams
//     - Call channel_adapter.openDM(handle); persist on success
// Either path persists in user_dms cache.
```

New module: `/data/nanotars/src/permissions/sender-resolver.ts`:

```ts
export function resolveSender(info: SenderInfo): string | undefined
// Replaces the 4A stub. Maps (channel, platform_id, sender_handle) → user.id
// Lazy ensureUser if unknown handle (creates user row, returns id).
```

New module: `/data/nanotars/src/command-gate.ts`:

```ts
// Slash-command gating against user_roles. Classifies inbound commands;
// admin commands require owner OR global admin OR scoped admin @ relevant group.
export function isAdminCommand(text: string): boolean
export function checkCommandPermission(userId: string | undefined, command: string, agentGroupId: string): { allowed: boolean; reason?: string }
```

## Wiring

The 4A stubs in `/data/nanotars/src/permissions.ts` get replaced with real implementations. Either:

- Move/rename `permissions.ts` → `permissions/index.ts` as a barrel, with sub-modules per the list above.
- Or keep `permissions.ts` flat and add the new modules alongside.

Decision: barrel pattern — `permissions/` directory with `access.ts`, `users.ts`, `user-roles.ts`, `agent-group-members.ts`, `user-dms.ts`, `sender-resolver.ts`, `index.ts` (re-exports). Cleaner namespace; each sub-module testable independently.

Orchestrator's existing call sites (added in 4A A6) just import from `./permissions/index.js` — no orchestrator changes needed beyond the import path update.

The sender-scope gate (`sender_scope='all' | 'known'`) gets enforced in the orchestrator's routing path:

```ts
// In processGroupMessages / startMessageLoop, after resolveAgentsForInbound:
const userId = resolveSender({ channel, platform_id, sender_handle, sender_name });
for (const { agentGroup, wiring } of resolved) {
  if (!canAccessAgentGroup(userId, agentGroup.id).allowed) continue;
  if (wiring.sender_scope === 'known' && !isMember(userId, agentGroup.id)) continue;
  // ... dispatch
}
```

## Sender-allowlist subsumption (one-time migration)

Migration `014_seed_sender_allowlist_to_members`:

```ts
{
  name: '014_seed_sender_allowlist_to_members',
  up: (db) => {
    // Best-effort: read v1's SENDER_ALLOWLIST_PATH file if it exists.
    // Translate per-chat allow: ['user1', 'user2'] → agent_group_members rows
    // for the agent group(s) wired to that chat.
    // Ignore errors silently if the file doesn't exist or is malformed.
  },
},
```

The legacy `src/sender-allowlist.ts` module stays but marks itself deprecated. Its read API (`isAllowedSender`) becomes a wrapper around `isMember(userId, agentGroupId)`. Phase 4D removes the legacy module entirely.

## Tests

Per-module unit tests:
- `permissions/__tests__/access.test.ts` — canAccessAgentGroup decision table (owner / global admin / scoped admin / member / unknown / unauthenticated)
- `permissions/__tests__/users.test.ts` — ensureUser idempotency, bootstrap-owner flow
- `permissions/__tests__/user-roles.test.ts` — grantRole/revokeRole, isOwner/isGlobalAdmin/isAdminOfAgentGroup
- `permissions/__tests__/agent-group-members.test.ts` — addMember/removeMember/listMembers, admin-implicit-membership invariant
- `permissions/__tests__/user-dms.test.ts` — direct vs indirect resolution paths; cache hit/miss
- `permissions/__tests__/sender-resolver.test.ts` — known sender → users.id; unknown sender → ensure + return new id
- `__tests__/command-gate.test.ts` — admin command classification + permission check
- `__tests__/migration-{010..014}.test.ts` — each migration's effect against hand-crafted pre-state DBs

Integration:
- `__tests__/orchestrator.test.ts` — extended to cover sender-scope gating; admin-only IPC paths gated correctly

## Effort

Triage estimates 4B at ~3-4 weeks. Sub-tasks roughly:

- B1: schemas + migrations 010-014
- B2: `permissions/users.ts` + `permissions/user-roles.ts` + tests
- B3: `permissions/agent-group-members.ts` + tests
- B4: `permissions/user-dms.ts` + tests (touches channel adapters for `openDM`)
- B5: `permissions/access.ts` (canAccessAgentGroup) + `permissions/sender-resolver.ts` + tests
- B6: replace 4A stubs in `permissions.ts`; wire sender-scope gate into orchestrator
- B7: `command-gate.ts` + tests; gate admin IPC handlers
- B8: sender-allowlist subsumption — migration 014 + deprecate legacy module
- B9: also fix Phase 4A H1 (container-side `register_group` MCP tool: add `channel?` field) — folded in here since it touches multi-channel scope
- B10: final phase review

10 sub-tasks. Multi-cross-tier (DB + container IPC + orchestrator + IPC handlers).

## Out of scope (deferred to 4C/4D)

- Approval primitive (`pending_approvals`, `requestApproval`, `pickApprover`) — Phase 4C
- OneCLI manual-approval bridge — Phase 4C
- Pending-sender approval flow (`pending_sender_approvals`) — Phase 4D
- Pending-channel approval flow (`pending_channel_approvals`) — Phase 4D
- `pending_questions` + `ask_question` MCP tool — Phase 4D
- Identity merging across channels — possibly Phase 4D, possibly later
- Cross-channel handle linking (one human, multiple platforms) — out of catch-up scope
