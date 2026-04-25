# Phase 4B: Users + RBAC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add v2's identity + RBAC layer to v1-archive. Four new tables (`users`, `user_roles`, `agent_group_members`, `user_dms`), real implementations replacing the 4A permissions stubs, sender-scope gate enforcement, host-side command-gate, sender-allowlist subsumption.

**Architecture:** Builds on Phase 4A's entity model. Per-table migration entries. Permissions code lives under `src/permissions/` as a barrel of focused modules. Routing-time permission checks land in the orchestrator's existing call sites (anchored by 4A's `permissions.ts` stubs). Plugin contract additions: plugins can now read `users` / `user_roles` for permission decisions.

**Tech Stack:** Node 22, TypeScript 5.9, vitest 4, better-sqlite3 11. **npm**, not pnpm. `npm test`, `npm run typecheck`. `package-lock.json` only.

**Spec input:** `/data/nanotars/docs/superpowers/specs/2026-04-25-phase-4b-rbac-design.md`

---

## CONTRIBUTE upstream PRs — out of scope

Same as prior phases.

---

## Items deferred from Phase 4B

- Approval primitive (`pending_approvals`, `requestApproval`, `pickApprover`) — Phase 4C
- OneCLI manual-approval bridge — Phase 4C
- Pending-sender / pending-channel approval flows — Phase 4D
- `pending_questions` + `ask_question` MCP tool — Phase 4D
- Identity merging across channels — out of catch-up scope

---

## Pre-flight verification

- [ ] **Step 1: Verify v1-archive clean tree, Phase 4A complete**

```
cd /data/nanotars && git status --short --branch
cd /data/nanotars && git log --oneline -3
```

Expected: clean tree on v1-archive; HEAD around `39ea4a4 docs(spec): Phase 4B...`.

- [ ] **Step 2: Verify baseline test counts**

```
cd /data/nanotars && npm test 2>&1 | tail -5     # 540
cd /data/nanotars/container/agent-runner && bun test 2>&1 | tail -5    # 29
```

- [ ] **Step 3: Typecheck clean**

```
cd /data/nanotars && npm run typecheck
```

---

## Task B1: Schemas + migrations 010-014

**Files:**
- `/data/nanotars/src/db/init.ts` (createSchema additions + 5 migration entries)
- `/data/nanotars/src/__tests__/migration-{010..014}.test.ts` (5 new test files OR one combined)

The five new tables. Defaults match v2's schema (per /data/nanoclaw-v2/src/db/schema.ts:61-95 reference).

- [ ] **Step 1: Add CREATE TABLE statements to createSchema**

After the Phase 4A entity-model tables, append:

```sql
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_scope ON user_roles(agent_group_id, role);

CREATE TABLE IF NOT EXISTS agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

CREATE TABLE IF NOT EXISTS user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

Use the same shared-DDL pattern Phase 4A established (factor into a constant and reference from both createSchema and migrations).

- [ ] **Step 2: Append migrations 010-014 to MIGRATIONS array**

```ts
{
  name: '010_add_users',
  up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS users (...)`),
},
{
  name: '011_add_user_roles',
  up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS user_roles (...); CREATE INDEX IF NOT EXISTS idx_user_roles_scope ...`),
},
{
  name: '012_add_agent_group_members',
  up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS agent_group_members (...)`),
},
{
  name: '013_add_user_dms',
  up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS user_dms (...)`),
},
{
  name: '014_seed_sender_allowlist_to_members',
  up: (db) => {
    // Best-effort import from src/sender-allowlist.ts's JSON file. Implementation in B8.
    // For now (B1): no-op. B8 fills in the logic before the module is shipped.
  },
},
```

(B8 will revisit migration 014 to add the JSON-import logic. B1 ships an empty migration so the schema_version slot is reserved.)

- [ ] **Step 3: Migration tests**

One combined test file `/data/nanotars/src/__tests__/migration-010-013.test.ts` covering all four schema-introducing migrations (014 is empty until B8). Pattern from migration-008.test.ts: build the pre-010 schema (Phase 4A's three tables present, four new ones absent), run migrations, assert tables exist with the right columns/indexes/PK.

Idempotency: also test that running migrations twice doesn't error. Mirror Phase 3 A2's idempotency test pattern.

- [ ] **Step 4: Bump db.test.ts schema_version assertions**

The schema_version count test in /data/nanotars/src/db/__tests__/db.test.ts probably asserts the count. After 4A it was 9 (008+009 added); now 14 (010-014 added).

- [ ] **Step 5: Run tests + typecheck**

```
cd /data/nanotars && npm test && npm run typecheck
```

Expected: 540 + (~5 new) = ~545 passing.

- [ ] **Step 6: Commit**

```
git add src/db/init.ts src/__tests__/migration-010-013.test.ts src/db/__tests__/db.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add users + user_roles + agent_group_members + user_dms tables

Phase 4B foundation: introduces v2's RBAC schema. Four new tables
plus a placeholder migration 014 for the sender-allowlist seed
(B8 fills in).

Per Phase 4A's migration policy: createSchema and migrations 010-013
share DDL via constants (no drift). 014 is empty until B8.

Spec: docs/superpowers/specs/2026-04-25-phase-4b-rbac-design.md
EOF
)"
```

**Reviewer dispatch — schema change.**

---

## Task B2: users.ts + user-roles.ts modules

**Files:**
- New: `/data/nanotars/src/permissions/users.ts`
- New: `/data/nanotars/src/permissions/user-roles.ts`
- New: `/data/nanotars/src/permissions/index.ts` (barrel)
- New: `/data/nanotars/src/permissions/__tests__/users.test.ts`
- New: `/data/nanotars/src/permissions/__tests__/user-roles.test.ts`
- Modify: `/data/nanotars/src/types.ts` (add User, UserRole interfaces)

Reorganize: keep `/data/nanotars/src/permissions.ts` (the 4A stubs) until B6 replaces it; new modules live under `/data/nanotars/src/permissions/`.

- [ ] **Step 1: Add types**

In types.ts:

```ts
export interface User {
  id: string;                  // "<channel>:<handle>"
  kind: string;
  display_name: string | null;
  created_at: string;
}

export interface UserRole {
  user_id: string;
  role: 'owner' | 'admin';
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}
```

- [ ] **Step 2: Create users.ts**

```ts
import { getDb } from '../db/init.js';   // adjust to v1's actual export
import type { User } from '../types.js';

export function ensureUser(args: { id: string; kind: string; display_name?: string | null }): User {
  const existing = getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(args.id) as User | undefined;
  if (existing) {
    if (args.display_name && existing.display_name !== args.display_name) {
      getDb().prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(args.display_name, args.id);
      return { ...existing, display_name: args.display_name };
    }
    return existing;
  }
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run(args.id, args.kind, args.display_name ?? null, now);
  return { id: args.id, kind: args.kind, display_name: args.display_name ?? null, created_at: now };
}

export function getUserById(id: string): User | undefined {
  return getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function listUsersByKind(kind: string): User[] {
  return getDb().prepare(`SELECT * FROM users WHERE kind = ? ORDER BY created_at`).all(kind) as User[];
}
```

- [ ] **Step 3: Create user-roles.ts**

```ts
import { getDb } from '../db/init.js';
import type { UserRole } from '../types.js';

export function isOwner(userId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'owner' AND agent_group_id IS NULL LIMIT 1`).get(userId);
  return row !== undefined;
}

export function isGlobalAdmin(userId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin' AND agent_group_id IS NULL LIMIT 1`).get(userId);
  return row !== undefined;
}

export function isAdminOfAgentGroup(userId: string, agentGroupId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin' AND agent_group_id = ? LIMIT 1`).get(userId, agentGroupId);
  return row !== undefined;
}

export function grantRole(args: {
  user_id: string;
  role: 'owner' | 'admin';
  agent_group_id?: string | null;
  granted_by?: string | null;
}): void {
  if (args.role === 'owner' && args.agent_group_id != null) {
    throw new Error('owner role must be global (agent_group_id = NULL)');
  }
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`)
    .run(args.user_id, args.role, args.agent_group_id ?? null, args.granted_by ?? null, now);
}

export function revokeRole(args: { user_id: string; role: 'owner' | 'admin'; agent_group_id?: string | null }): void {
  if (args.agent_group_id == null) {
    getDb().prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL`).run(args.user_id, args.role);
  } else {
    getDb().prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?`).run(args.user_id, args.role, args.agent_group_id);
  }
}

export function listOwners(): UserRole[] {
  return getDb().prepare(`SELECT * FROM user_roles WHERE role = 'owner'`).all() as UserRole[];
}

export function listGlobalAdmins(): UserRole[] {
  return getDb().prepare(`SELECT * FROM user_roles WHERE role = 'admin' AND agent_group_id IS NULL`).all() as UserRole[];
}

export function listAdminsOfAgentGroup(agentGroupId: string): UserRole[] {
  return getDb().prepare(`SELECT * FROM user_roles WHERE role = 'admin' AND agent_group_id = ?`).all(agentGroupId) as UserRole[];
}
```

- [ ] **Step 4: Create barrel /data/nanotars/src/permissions/index.ts**

```ts
export * from './users.js';
export * from './user-roles.js';
// Phase 4B: exports as additional modules land
```

- [ ] **Step 5: Tests for both modules**

`/data/nanotars/src/permissions/__tests__/users.test.ts`:
- ensureUser creates a new row
- ensureUser is idempotent (second call with same id returns same user)
- ensureUser updates display_name if provided and different
- getUserById round-trip

`/data/nanotars/src/permissions/__tests__/user-roles.test.ts`:
- grantRole + isOwner round-trip
- grantRole rejects owner with non-null agent_group_id
- isGlobalAdmin / isAdminOfAgentGroup distinguish scope correctly
- revokeRole removes the row
- listOwners / listGlobalAdmins / listAdminsOfAgentGroup correctness
- INSERT OR IGNORE: granting same role twice is a no-op

- [ ] **Step 6: Run + commit**

```
cd /data/nanotars && npm test && npm run typecheck
git add -A
git commit -m "feat(permissions): add users + user-roles modules"
```

**No reviewer dispatch — additive accessor module.**

---

## Task B3: agent-group-members.ts

**Files:**
- New: `/data/nanotars/src/permissions/agent-group-members.ts`
- New: `/data/nanotars/src/permissions/__tests__/agent-group-members.test.ts`
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export)

Mirrors B2's structure. Key invariant: admin @ A is implicitly a member of A (no agent_group_members row needed). The `isMember` function returns true if EITHER an agent_group_members row exists OR the user is admin@A OR global admin OR owner.

- [ ] **Step 1: Implementation**

```ts
import { getDb } from '../db/init.js';
import type { User } from '../types.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './user-roles.js';

export function isMember(userId: string, agentGroupId: string): boolean {
  // Admin @ group OR global admin OR owner is implicitly a member
  if (isOwner(userId)) return true;
  if (isGlobalAdmin(userId)) return true;
  if (isAdminOfAgentGroup(userId, agentGroupId)) return true;
  const row = getDb().prepare(`SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1`).get(userId, agentGroupId);
  return row !== undefined;
}

export function addMember(args: { user_id: string; agent_group_id: string; added_by?: string | null }): void {
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)`)
    .run(args.user_id, args.agent_group_id, args.added_by ?? null, now);
}

export function removeMember(args: { user_id: string; agent_group_id: string }): void {
  getDb().prepare(`DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?`).run(args.user_id, args.agent_group_id);
}

export function listMembers(agentGroupId: string): User[] {
  return getDb().prepare(`SELECT u.* FROM users u JOIN agent_group_members m ON m.user_id = u.id WHERE m.agent_group_id = ? ORDER BY m.added_at`).all(agentGroupId) as User[];
}
```

- [ ] **Step 2: Tests**

- addMember + isMember round-trip
- isMember returns true for owner / global admin / scoped admin even without an explicit row (the implicit-membership invariant)
- removeMember removes the row but the user is still a member if they're admin
- listMembers returns the right users

- [ ] **Step 3: Run + commit**

```
git add -A
git commit -m "feat(permissions): add agent-group-members module with implicit-admin-membership"
```

---

## Task B4: user-dms.ts (touches channel adapters)

**Files:**
- New: `/data/nanotars/src/permissions/user-dms.ts`
- New: `/data/nanotars/src/permissions/__tests__/user-dms.test.ts`
- Modify: `/data/nanotars/src/permissions/index.ts`
- Modify: any channel adapter that needs an `openDM(handle)` method (Discord, Slack, Teams). Telegram/WhatsApp have `handle = chat_id` so they're direct.

Two-class resolution:
- Direct channels (handle == chat_id): synthesize `messaging_groups` row from the user.id's handle portion; persist user_dms row; return the messaging group.
- Indirect channels (need round trip): call `adapter.openDM(handle)` to get the chat id, then do the same. v1 may not have `openDM` on all adapters — for adapters that lack it, return undefined and warn.

- [ ] **Step 1: Implementation**

(See spec for full code skeleton; full code lives in this task body when implementing.)

```ts
import { getDb } from '../db/init.js';
import { getMessagingGroup, createMessagingGroup, type MessagingGroup } from '../db/agent-groups.js';
import { logger } from '../logger.js';

const DIRECT_CHANNELS = new Set(['whatsapp', 'telegram', 'imessage', 'email', 'matrix']);

export function getUserDm(userId: string, channelType: string): MessagingGroup | undefined {
  const row = getDb().prepare(`
    SELECT mg.* FROM messaging_groups mg
    JOIN user_dms ud ON ud.messaging_group_id = mg.id
    WHERE ud.user_id = ? AND ud.channel_type = ?
  `).get(userId, channelType) as MessagingGroup | undefined;
  return row;
}

interface ChannelAdapter {
  name: string;
  openDM?: (handle: string) => Promise<string>;
}

export async function ensureUserDm(args: {
  user_id: string;
  channel_type: string;
  channel_adapter?: ChannelAdapter;
}): Promise<MessagingGroup | undefined> {
  const cached = getUserDm(args.user_id, args.channel_type);
  if (cached) return cached;

  // user.id is "<kind>:<handle>" — extract the handle
  const colonIdx = args.user_id.indexOf(':');
  if (colonIdx === -1) {
    logger.warn({ userId: args.user_id }, 'ensureUserDm: malformed user.id (missing colon)');
    return undefined;
  }
  const handle = args.user_id.slice(colonIdx + 1);

  let chatId: string;
  if (DIRECT_CHANNELS.has(args.channel_type)) {
    chatId = handle;
  } else if (args.channel_adapter?.openDM) {
    try {
      chatId = await args.channel_adapter.openDM(handle);
    } catch (err) {
      logger.warn({ err, userId: args.user_id, channel_type: args.channel_type }, 'ensureUserDm: openDM failed');
      return undefined;
    }
  } else {
    logger.warn({ userId: args.user_id, channel_type: args.channel_type }, 'ensureUserDm: no openDM available for indirect channel');
    return undefined;
  }

  // Synthesize or fetch the messaging_groups row for this DM
  let mg = getMessagingGroup(args.channel_type, chatId);
  if (!mg) mg = createMessagingGroup({ channel_type: args.channel_type, platform_id: chatId, name: null });

  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`)
    .run(args.user_id, args.channel_type, mg.id, now);

  return mg;
}
```

- [ ] **Step 2: Tests**

Use a fake `channel_adapter` with `openDM: vi.fn().mockResolvedValue('chat-id-123')`. Cover:
- Direct channel (whatsapp): handle becomes chat_id; messaging_group + user_dms row created
- Indirect channel (discord): openDM called; result becomes chat_id
- Cache hit: subsequent ensureUserDm with same user/channel reuses
- openDM failure: returns undefined + warns
- Indirect channel with no adapter: returns undefined + warns

- [ ] **Step 3: openDM channel-adapter survey**

Run `grep -rn "openDM\b" src/channels/` to see whether v1's existing channel adapters define openDM. If not, this is fine — the indirect-channel path returns undefined for adapters that don't define it. Phase 4D / channel adapter ports may add openDM later.

- [ ] **Step 4: Run + commit**

```
git add -A
git commit -m "feat(permissions): add user-dms module with two-class DM resolution"
```

---

## Task B5: access.ts (canAccessAgentGroup) + sender-resolver.ts

**Files:**
- New: `/data/nanotars/src/permissions/access.ts`
- New: `/data/nanotars/src/permissions/sender-resolver.ts`
- New: tests for both
- Modify: barrel

- [ ] **Step 1: access.ts**

```ts
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './user-roles.js';
import { isMember } from './agent-group-members.js';

export function canAccessAgentGroup(userId: string | undefined, agentGroupId: string): { allowed: boolean; reason: string } {
  if (!userId) return { allowed: false, reason: 'unauthenticated' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global-admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'scoped-admin' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not-a-member' };
}
```

- [ ] **Step 2: sender-resolver.ts**

```ts
import { ensureUser } from './users.js';
import { logger } from '../logger.js';

export interface SenderInfo {
  channel: string;
  platform_id: string;
  sender_handle: string;
  sender_name?: string;
}

/**
 * Resolve a platform-level sender to a users.id. Lazily creates a users row if
 * the sender hasn't been seen before; returns the existing id otherwise.
 *
 * The user.id convention is "<channel>:<handle>". A future Phase 4D / identity
 * merging step may link multiple users.id rows to the same human; not in 4B scope.
 */
export function resolveSender(info: SenderInfo): string {
  const userId = `${info.channel}:${info.sender_handle}`;
  ensureUser({ id: userId, kind: info.channel, display_name: info.sender_name ?? null });
  return userId;
}
```

Note signature change from the 4A stub: returns `string` (always resolves), not `string | undefined`. The 4A stub returned undefined to make the gate fall back to "allow" for routing simplicity. With real RBAC, every inbound has a sender, and the resolver always produces a user.id (creating the row if needed).

- [ ] **Step 3: Tests**

- canAccessAgentGroup decision table: each branch (owner / global admin / scoped admin / member / unknown / unauthenticated)
- resolveSender creates a users row if absent
- resolveSender returns the same id for the same (channel, handle) pair
- resolveSender updates display_name if a newer one is provided

- [ ] **Step 4: Run + commit**

```
git add -A
git commit -m "feat(permissions): add access + sender-resolver modules"
```

---

## Task B6: Replace 4A stubs in permissions.ts; wire sender-scope gate

**Files:**
- Modify: `/data/nanotars/src/permissions.ts` (the 4A stub file) — delete OR convert to a thin re-export from `permissions/index.ts`
- Modify: `/data/nanotars/src/orchestrator.ts` (sender-scope gate enforcement)
- Modify: `/data/nanotars/src/__tests__/permissions.test.ts` and `/data/nanotars/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Decide on permissions.ts vs permissions/index.ts**

Two options:
- (a) Delete `/data/nanotars/src/permissions.ts` entirely; all consumers import from `./permissions/index.js` (or `./permissions`).
- (b) Keep `/data/nanotars/src/permissions.ts` as a thin re-export wrapper for backward compat.

Option (a) is cleaner. Consumers in 4A wired against `./permissions.js`; switch them all to `./permissions/index.js`.

- [ ] **Step 2: Update consumers**

```
grep -rn "from '\.\./permissions'" /data/nanotars/src/
grep -rn "from '\./permissions'" /data/nanotars/src/
```

Update each import to use the new barrel path.

- [ ] **Step 3: Wire sender-scope gate in orchestrator**

In the routing path (where 4A's stubs are called), add the wiring sender-scope check after `canAccessAgentGroup`:

```ts
const userId = resolveSender({ channel, platform_id, sender_handle, sender_name });
for (const { agentGroup, wiring } of resolved) {
  const access = canAccessAgentGroup(userId, agentGroup.id);
  if (!access.allowed) {
    logger.debug({ userId, agentGroup: agentGroup.folder, reason: access.reason }, 'Access denied');
    continue;
  }
  if (wiring.sender_scope === 'known' && !isMember(userId, agentGroup.id)) {
    logger.debug({ userId, agentGroup: agentGroup.folder }, 'Dropped by sender_scope=known gate');
    continue;
  }
  // ... dispatch
}
```

- [ ] **Step 4: Tests**

- Orchestrator routes correctly when canAccessAgentGroup returns allowed
- Orchestrator drops messages when canAccessAgentGroup returns denied
- Orchestrator drops messages when sender_scope='known' and user is not a member
- Orchestrator routes when sender_scope='all' regardless of membership

- [ ] **Step 5: Run + commit**

```
git add -A
git commit -m "$(cat <<'EOF'
feat(permissions): replace 4A stubs with real RBAC; wire sender-scope gate

Orchestrator routing path now enforces canAccessAgentGroup against
the user_roles + agent_group_members tables. sender_scope='known'
on messaging_group_agents wirings drops messages from non-members.

Phase 4A's permissions.ts stub file removed; consumers now import
from ./permissions/index.js.
EOF
)"
```

**Reviewer dispatch — orchestrator behavior change.**

---

## Task B7: command-gate.ts

**Files:**
- New: `/data/nanotars/src/command-gate.ts`
- New: `/data/nanotars/src/__tests__/command-gate.test.ts`
- Modify: `/data/nanotars/src/ipc/auth.ts` (gate admin commands)

- [ ] **Step 1: Survey current admin command surface**

```
grep -nE "admin|/grant|/revoke|register_group|delete_group" /data/nanotars/src/ipc/*.ts
```

Identify which IPC operations are admin-only. v1 likely has implicit gating ("only main can do X") — formalize via user_roles.

- [ ] **Step 2: command-gate.ts**

```ts
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './permissions/index.js';

const ADMIN_COMMANDS = new Set([
  '/grant', '/revoke', '/list-users', '/list-roles',
  '/register-group', '/delete-group', '/restart',
  // ... extend as v1 adds admin commands
]);

export function isAdminCommand(text: string): boolean {
  const trimmed = text.trim().split(/\s+/)[0];
  return ADMIN_COMMANDS.has(trimmed);
}

export function checkCommandPermission(
  userId: string | undefined,
  command: string,
  agentGroupId: string,
): { allowed: boolean; reason?: string } {
  if (!userId) return { allowed: false, reason: 'unauthenticated' };
  if (isOwner(userId)) return { allowed: true };
  if (isGlobalAdmin(userId)) return { allowed: true };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true };
  return { allowed: false, reason: 'admin-only' };
}
```

- [ ] **Step 3: Wire into IPC auth**

In /data/nanotars/src/ipc/auth.ts: where admin operations are gated, replace the existing implicit "main only" check with `checkCommandPermission`. Use the `userId` resolved from the inbound message.

If v1's IPC currently doesn't carry user identity, either thread it through (preferred — IPC payloads gain a `userId` field) OR resolve at the handler from message metadata. The cleanest path is to thread through; document in the commit message.

- [ ] **Step 4: Tests**

- isAdminCommand correctly classifies admin/non-admin commands
- checkCommandPermission decision table
- Integration: admin IPC handler refuses non-admin user

- [ ] **Step 5: Run + commit**

```
git add -A
git commit -m "$(cat <<'EOF'
feat(permissions): add command-gate; gate admin IPC handlers

ADMIN_COMMANDS set classifies known admin slash-commands. IPC auth
handlers now check user role via checkCommandPermission instead of
relying on the implicit "main group only" convention.

Threads userId through IPC payloads where needed.
EOF
)"
```

**Reviewer dispatch — IPC contract change.**

---

## Task B8: Sender-allowlist subsumption + migration 014 logic

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` (fill in migration 014 body)
- Modify: `/data/nanotars/src/sender-allowlist.ts` (deprecate, route reads through new accessors)
- New: `/data/nanotars/src/__tests__/migration-014.test.ts`

- [ ] **Step 1: Migration 014 implementation**

```ts
{
  name: '014_seed_sender_allowlist_to_members',
  up: (db) => {
    // Best-effort: read SENDER_ALLOWLIST_PATH if present.
    let raw: string | null = null;
    try {
      const fs = require('fs');
      const { SENDER_ALLOWLIST_PATH } = require('../config.js');
      raw = fs.readFileSync(SENDER_ALLOWLIST_PATH, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return;  // No legacy file = no-op
      // Logging here is awkward (no logger inside migration); silently skip
      return;
    }
    if (!raw) return;
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!parsed?.chats || typeof parsed.chats !== 'object') return;

    // For each chat in the legacy allowlist, find the corresponding messaging_group
    // and the wired agent_groups, then add agent_group_members rows for the allowed users.
    for (const [jid, entry] of Object.entries(parsed.chats) as Array<[string, any]>) {
      if (!entry?.allow || !Array.isArray(entry.allow)) continue;
      const mg = db.prepare(`SELECT id, channel_type FROM messaging_groups WHERE platform_id = ? LIMIT 1`).get(jid) as any;
      if (!mg) continue;
      const wirings = db.prepare(`SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id = ?`).all(mg.id) as Array<{agent_group_id: string}>;
      for (const w of wirings) {
        for (const handle of entry.allow) {
          const userId = `${mg.channel_type}:${handle}`;
          // ensureUser inline (can't import from outside the migration body easily)
          db.prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, ?, NULL, ?)`).run(userId, mg.channel_type, new Date().toISOString());
          db.prepare(`INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`).run(userId, w.agent_group_id, new Date().toISOString());
        }
      }
    }
  },
},
```

- [ ] **Step 2: Deprecate sender-allowlist.ts**

Keep the file but mark its functions as deprecated. Replace `isAllowedSender` (or whatever the v1 read API is) with a wrapper around `isMember` from the new modules:

```ts
/** @deprecated Use isMember from src/permissions/agent-group-members.js. Retained for legacy callers; migration 014 seeded the data into the DB. */
export function isAllowedSender(jid: string, senderHandle: string, channelType: string): boolean {
  // Resolve to (messaging_group, agent_group) pair, then check isMember
  // ... or just import isMember and forward
}
```

If the legacy module has a `mode` distinction (trigger vs drop), that maps to `sender_scope` on the wiring — not handled here. The wiring's sender_scope value is what governs runtime behavior.

- [ ] **Step 3: Tests**

`/data/nanotars/src/__tests__/migration-014.test.ts`:
- Hand-craft a pre-014 DB with users/agent_groups/messaging_groups/wirings tables empty
- Write a temp JSON file representing a legacy allowlist
- Configure SENDER_ALLOWLIST_PATH to that file (env override or vi.mock)
- Run migration 014
- Assert: users rows created for each allowed handle; agent_group_members rows created

- [ ] **Step 4: Run + commit**

```
git add -A
git commit -m "$(cat <<'EOF'
feat(permissions): subsume sender-allowlist into agent_group_members

Migration 014 reads the legacy SENDER_ALLOWLIST_PATH JSON if present
and seeds users + agent_group_members rows. Legacy isAllowedSender
becomes a thin deprecated wrapper around isMember.

The trigger/drop mode distinction maps to sender_scope='all'/'known'
on messaging_group_agents wirings (set at registration time).
EOF
)"
```

**Reviewer dispatch — schema migration with data movement.**

---

## Task B9: Container-side `register_group` channel field (Phase 4A H1 carryover)

**Files:**
- Modify: `/data/nanotars/container/agent-runner/src/ipc-mcp-stdio.ts`

A5-review M1 / Phase 4A final-review H1: container-side `register_group` MCP tool needs to send `channel`. Mechanical, ~6 lines.

- [ ] **Step 1: Add `channel` to the zod schema**

In ipc-mcp-stdio.ts around line 354, add `channel: z.string().optional()` to the register_group input schema.

- [ ] **Step 2: Forward into the IPC payload**

Around line 380, add `channel: input.channel` to the payload object.

- [ ] **Step 3: Container tests**

```
cd /data/nanotars/container/agent-runner && bun test
```

Expected: all pass. Update any test that mocks the register_group payload to include `channel`.

- [ ] **Step 4: Commit**

```
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "$(cat <<'EOF'
fix(container): plumb channel field through register_group MCP tool

Phase 4A final-review H1 carryover. Container-side IPC client now
sends channel in the register_group payload, matching the host-side
schema added in 4A A5. Multi-channel installs no longer rely on
adapter ownsJid resolution; the agent specifies channel explicitly.
EOF
)"
```

**No reviewer dispatch — single-file mechanical change.**

---

## Task B10: Final phase review

After all tasks land, dispatch the final phase reviewer.

**Reviewer prompt:**

```
Final review of Phase 4B on /data/nanotars v1-archive. HEAD started at
39ea4a4 (Phase 4B spec); current HEAD is <SHA>. Review:

git log 39ea4a4..HEAD --oneline

Verify:
1. Spec compliance against
   docs/superpowers/specs/2026-04-25-phase-4b-rbac-design.md
2. Migrations 010-014 idempotent and order-correct
3. permissions/ barrel structure consistent; no orphan modules
4. canAccessAgentGroup decision order matches spec
5. Sender-scope gate enforced in orchestrator
6. Command-gate gates admin IPC handlers
7. Sender-allowlist legacy module is wrapper-only
8. Phase 4A H1 (container-side channel forwarding) addressed in B9
9. Tests adequate for each new module
10. Plugin contract additions documented (if any)

Out of scope: Phase 4C (approvals), Phase 4D (multi-user UX flows).

Report: Critical / High / Medium / Low / Nit with file:line.
End with PHASE 4B APPROVED or PHASE 4B NEEDS FIXES.
```

---

## Self-review checklist

- [x] Spec coverage: all 4B sections (schemas, modules, hooks, command-gate, subsumption) map to tasks B1-B8.
- [x] Phase 4A H1 carryover (container channel) folded into B9.
- [x] Reviewer dispatch: B1 (schema), B6 (orchestrator behavior), B7 (IPC), B8 (migration with data). Mechanical: B2/B3/B4/B5/B9.
- [x] Migration policy applied to all 5 new migrations.
- [x] npm-not-pnpm warnings present.
- [x] Plugin contract: no new plugin-facing changes in 4B (the orchestrator's exposed methods don't change shape; permissions are internal).
