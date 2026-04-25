# Phase 4C: Approval primitive + OneCLI bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Land v2's approval primitive on v1-archive: `pending_approvals` table, `requestApproval` + handler registry, `pickApprover` + `pickApprovalDelivery` hierarchical resolution, click-auth on approval cards, card-expiry sweep, and the OneCLI manual-approval bridge that Phase 3 deferred. After 4C, any module on v1 can request admin approval via a single function call; the OneCLI gateway can ask the host for human approval before releasing a credential.

**Architecture:** One new central-DB table (`pending_approvals`). A new `src/permissions/` sub-tree (5 modules: `approvals.ts`, `approval-routing.ts`, `approval-response.ts`, `approval-card-expiry.ts`, `onecli-approvals.ts`). A minimal `ChannelDeliveryAdapter` interface + a thin `interaction` hook on channel adapters so button clicks can be dispatched into `handleApprovalResponse`. Host startup wires `startOneCLIApprovalHandler(adapter)` after delivery adapters are initialized. No agent-runner / container changes — the primitive is host-only.

**Tech Stack:** Node 22, TypeScript 5.9, vitest 4, better-sqlite3 11, pino 9, `@onecli-sh/sdk` (already on the dep tree from Phase 3). **npm**, not pnpm — v1-archive uses npm with `package-lock.json`. Run `npm test`, `npm run typecheck`, `npm install`. Never run pnpm. Never run `bun` against host code. Container-side untouched in 4C.

**Spec input:** `/data/nanotars/docs/superpowers/specs/2026-04-25-phase-4c-approval-primitive-design.md` — locks scope decisions, schema (one table), and module shapes.

---

## CONTRIBUTE upstream PRs — out of scope

Same as prior phases. CONTRIBUTE-class items (e.g., possible defense-in-depth on click-auth's silent-claim posture) are PRs to qwibitai/nanoclaw, separate workstream.

---

## Items deferred from Phase 4C

- `pending_questions` + `ask_question` MCP tool (generic agent-asks-user) — Phase 4D.
- `pending_sender_approvals` request/respond flow — Phase 4D.
- `pending_channel_approvals` + `denied_at` flow — Phase 4D.
- Self-modification approval flow (`install_packages`, `add_mcp_server`) — Phase 5; those modules register handlers via `registerApprovalHandler` when they're ported.
- Full Chat SDK bridge port (rich card-rendering surface) — out of catch-up scope.
- Multi-approver quorum / broadcast — not in v2 either.

---

## Pre-flight verification

- [ ] **Step 1: Verify v1-archive clean tree, Phase 4B complete**

```
cd /data/nanotars && git status --short --branch
cd /data/nanotars && git log --oneline -5
```

Expected: clean tree on v1-archive; HEAD at the Phase 4B final-review commit (the commit that closes 4B), with the 4C spec commit immediately before this plan's first task lands. Phase 4B's modules (`src/permissions/users.ts`, `user-roles.ts`, `agent-group-members.ts`, `user-dms.ts`, `access.ts`, `sender-resolver.ts`) all present.

- [ ] **Step 2: Verify Phase 4B exports needed by 4C are present**

```
cd /data/nanotars && grep -nE "listAdminsOfAgentGroup|listGlobalAdmins|listOwners|ensureUserDm|isOwner|isGlobalAdmin|isAdminOfAgentGroup|isMember" src/permissions/*.ts | head -20
```

Expected: each function defined in some sub-module under `src/permissions/`. If any is missing, surface as BLOCKED — Phase 4B is incomplete.

- [ ] **Step 3: Verify baseline test counts**

```
cd /data/nanotars && npm test 2>&1 | tail -5         # ~545+ after Phase 4B
cd /data/nanotars/container/agent-runner && bun test 2>&1 | tail -5    # 29
```

Note exact baseline. 4C will add roughly 30-50 host-side tests; the container-side count must not change.

- [ ] **Step 4: Typecheck clean**

```
cd /data/nanotars && npm run typecheck
```

- [ ] **Step 5: Verify Phase 3 OneCLI gateway is wired**

```
cd /data/nanotars && grep -nE "OneCLI|configureManualApproval" src/container-runner.ts src/index.ts | head -20
```

Expected: `OneCLI` import + `ensureAgent` / `applyContainerConfig` calls in container-runner; NO `configureManualApproval` call yet (Phase 3 deferred it). 4C wires it. If the gateway import isn't present, surface as BLOCKED — 4C cannot land without Phase 3.

---

## Task C1: Schema + migration `015_add_pending_approvals` + DB accessors

**Triage row:** Spec section "Schema" + "Migrations." Land the `pending_approvals` table in `createSchema` AND a numbered migration entry. Add five DB accessors. No callers yet — C2 onwards adds them.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` — append `CREATE TABLE pending_approvals` to `createSchema`; append migration `015_add_pending_approvals` to `MIGRATIONS`.
- New: `/data/nanotars/src/db/approvals.ts` — five accessors (`createPendingApproval`, `getPendingApproval`, `updatePendingApprovalStatus`, `deletePendingApproval`, `getPendingApprovalsByAction`).
- Modify: `/data/nanotars/src/types.ts` — add `PendingApproval` interface.
- New: `/data/nanotars/src/__tests__/migration-015.test.ts` — schema test mirroring Phase 4B's migration-010-013 pattern.
- New: `/data/nanotars/src/db/__tests__/approvals.test.ts` — accessor tests.

- [ ] **Step 1: Add `PendingApproval` to types.ts**

```ts
export interface PendingApproval {
  approval_id:          string;
  session_id:           string | null;
  request_id:           string;
  action:               string;
  payload:              string;          // JSON-encoded
  created_at:           string;
  agent_group_id:       string | null;
  channel_type:         string | null;
  platform_id:          string | null;
  platform_message_id:  string | null;
  expires_at:           string | null;
  status:               'pending' | 'approved' | 'rejected' | 'expired';
  title:                string;
  options_json:         string;          // JSON-encoded
}
```

- [ ] **Step 2: Add CREATE TABLE to createSchema (shared-DDL pattern from Phase 4A)**

In `/data/nanotars/src/db/init.ts`, factor the DDL into a shared constant and reference from both `createSchema` and the migration:

```ts
const PENDING_APPROVALS_DDL = `
  CREATE TABLE IF NOT EXISTS pending_approvals (
    approval_id          TEXT PRIMARY KEY,
    session_id           TEXT,
    request_id           TEXT NOT NULL,
    action               TEXT NOT NULL,
    payload              TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    agent_group_id       TEXT REFERENCES agent_groups(id),
    channel_type         TEXT,
    platform_id          TEXT,
    platform_message_id  TEXT,
    expires_at           TEXT,
    status               TEXT NOT NULL DEFAULT 'pending',
    title                TEXT NOT NULL DEFAULT '',
    options_json         TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_pending_approvals_action_status
    ON pending_approvals(action, status);
`;
```

Reference from `createSchema`'s SQL block, and from the migration body. Note: `session_id` deliberately has NO `REFERENCES sessions(id)` — v1-archive doesn't have a `sessions` table (per-group containers, not per-session). Document inline:

```ts
// session_id intentionally lacks a foreign-key reference: v1 has no
// sessions table (per-group containers, not per-session). Column shape
// matches v2 for forward-port compat; today every row stays NULL or
// carries an opaque agent-group identifier reused by callers.
```

- [ ] **Step 3: Append migration `015_add_pending_approvals`**

In the `MIGRATIONS` array, after Phase 4B's `014_seed_sender_allowlist_to_members`:

```ts
{
  name: '015_add_pending_approvals',
  up: (db) => db.exec(PENDING_APPROVALS_DDL),
},
```

- [ ] **Step 4: Create `/data/nanotars/src/db/approvals.ts`**

```ts
import { getDb } from './init.js';
import type { PendingApproval } from '../types.js';

/**
 * Insert a pending approval row. Idempotent (INSERT OR IGNORE) — delivery
 * retries with the same approval_id must not fail on PK conflict before the
 * send step gets a chance to succeed. Mirrors v2's createPendingApproval.
 */
export function createPendingApproval(
  pa: Partial<PendingApproval> &
    Pick<PendingApproval, 'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'>,
): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, platform_message_id, expires_at, status,
          title, options_json)
       VALUES
         (@approval_id, @session_id, @request_id, @action, @payload, @created_at,
          @agent_group_id, @channel_type, @platform_id, @platform_message_id, @expires_at, @status,
          @title, @options_json)`,
    )
    .run({
      session_id: null,
      agent_group_id: null,
      channel_type: null,
      platform_id: null,
      platform_message_id: null,
      expires_at: null,
      status: 'pending',
      ...pa,
    });
  return result.changes > 0;
}

export function getPendingApproval(approvalId: string): PendingApproval | undefined {
  return getDb().prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as
    | PendingApproval
    | undefined;
}

export function updatePendingApprovalStatus(approvalId: string, status: PendingApproval['status']): void {
  getDb().prepare('UPDATE pending_approvals SET status = ? WHERE approval_id = ?').run(status, approvalId);
}

export function deletePendingApproval(approvalId: string): void {
  getDb().prepare('DELETE FROM pending_approvals WHERE approval_id = ?').run(approvalId);
}

export function getPendingApprovalsByAction(action: string): PendingApproval[] {
  return getDb().prepare('SELECT * FROM pending_approvals WHERE action = ?').all(action) as PendingApproval[];
}
```

- [ ] **Step 5: Migration test**

`/data/nanotars/src/__tests__/migration-015.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('migration 015_add_pending_approvals', () => {
  it('creates the pending_approvals table + index', async () => {
    const db = new Database(':memory:');
    // Build the pre-015 schema (Phase 4A + 4B tables present, pending_approvals absent)
    db.exec(`
      CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT UNIQUE);
    `);
    // Pre-mark migrations 001-014 applied
    const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
    for (const v of [
      '001_add_context_mode', '002_add_model', '003_add_channel',
      '004_add_is_bot_message', '005_add_reply_context', '006_add_task_script',
      '007_add_engage_mode_axes', '008_split_registered_groups', '009_drop_registered_groups',
      '010_add_users', '011_add_user_roles', '012_add_agent_group_members',
      '013_add_user_dms', '014_seed_sender_allowlist_to_members',
    ]) stmt.run(v, new Date().toISOString());

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{name: string}>).map(r => r.name);
    expect(tables).toContain('pending_approvals');

    // Inspect column shape
    const cols = (db.prepare(`PRAGMA table_info(pending_approvals)`).all() as Array<{name: string; notnull: number}>);
    const colNames = cols.map(c => c.name);
    for (const expected of [
      'approval_id', 'session_id', 'request_id', 'action', 'payload', 'created_at',
      'agent_group_id', 'channel_type', 'platform_id', 'platform_message_id', 'expires_at',
      'status', 'title', 'options_json',
    ]) expect(colNames).toContain(expected);

    // Index
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pending_approvals'`).all() as any[]).map(r => r.name);
    expect(indexes).toContain('idx_pending_approvals_action_status');

    // Schema_version row
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{version: string}>).map(r => r.version);
    expect(versions).toContain('015_add_pending_approvals');
  });

  it('is idempotent on a fresh DB built via createSchema', async () => {
    const db = new Database(':memory:');
    const { initDatabase } = await import('../db/init.js');
    initDatabase(db);
    // Migration must be a no-op (table exists from createSchema)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[]).map(r => r.name);
    expect(tables).toContain('pending_approvals');
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{version: string}>).map(r => r.version);
    expect(versions).toContain('015_add_pending_approvals');
  });
});
```

- [ ] **Step 6: Accessor tests**

`/data/nanotars/src/db/__tests__/approvals.test.ts`:
- `createPendingApproval` inserts a row with the right fields
- `createPendingApproval` is idempotent on duplicate `approval_id` (INSERT OR IGNORE returns false on conflict)
- `getPendingApproval` round-trips
- `updatePendingApprovalStatus` updates only the named row
- `deletePendingApproval` removes the row
- `getPendingApprovalsByAction` filters by action correctly + returns empty list on no match

- [ ] **Step 7: Bump db.test.ts schema_version count if applicable**

If `/data/nanotars/src/db/__tests__/db.test.ts` asserts a count, bump from 14 to 15.

- [ ] **Step 8: Run + commit**

```
cd /data/nanotars && npm test && npm run typecheck
git add src/db/init.ts src/db/approvals.ts src/types.ts src/__tests__/migration-015.test.ts src/db/__tests__/approvals.test.ts src/db/__tests__/db.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add pending_approvals table + accessors

Phase 4C foundation: introduces v2's approval-primitive storage.
One new table (pending_approvals) with all 14 columns up-front
(no shape evolution needed on v1-archive). Migration 015 lands
the DDL; createSchema and migration share a constant per Phase
4A's policy.

session_id intentionally lacks REFERENCES sessions(id) — v1 has
no sessions table (per-group containers, not per-session).
Column shape matches v2 for forward-port compat.

Five accessors in src/db/approvals.ts (createPendingApproval,
get/update/delete/getByAction). createPendingApproval is
INSERT OR IGNORE — delivery retries must not fail on PK conflict.

Spec: docs/superpowers/specs/2026-04-25-phase-4c-approval-primitive-design.md
EOF
)"
```

**Reviewer dispatch — schema change.**

---

## Task C2: `requestApproval` primitive + handler registry

**Triage row:** Spec section "Functions / modules" — `permissions/approvals.ts`. Mirrors v2's `src/modules/approvals/primitive.ts`, adapted for v1's directory layout and per-group-container model (no `session` object — replaced by `agentGroupId`).

**Files:**
- New: `/data/nanotars/src/permissions/approvals.ts`
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export)
- New: `/data/nanotars/src/permissions/__tests__/approvals.test.ts`

(C3 supplies `pickApprover` + `pickApprovalDelivery`; this task imports them as if they existed and lands the test that exercises them via stubs. Re-run after C3 for a real green.)

- [ ] **Step 1: Implementation**

```ts
import { createPendingApproval } from '../db/approvals.js';
import { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../delivery.js';
import { logger } from '../logger.js';
import { pickApprovalDelivery, pickApprover } from './approval-routing.js';
import type { MessagingGroup } from '../types.js';

const APPROVAL_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
] as const;

// ── Approval handler registry ──

export interface ApprovalHandlerContext {
  agentGroupId: string;
  payload: Record<string, unknown>;
  userId: string;
  notify: (text: string) => void;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    logger.warn({ action }, 'Approval handler re-registered (overwriting)');
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

// ── Notify ──

/**
 * Send a system message into the requesting agent group. v1 uses per-group
 * containers; the equivalent of v2's writeSessionMessage is whatever existing
 * mechanism v1 uses to inject system text into an agent's inbound feed.
 *
 * If v1's IPC layer doesn't have a clean "system message" entry point, this
 * task may need to add one. Scope is small: enqueue a JSON message kind='chat'
 * sender='system' into the agent group's inbound queue.
 */
export function notifyAgent(agentGroupId: string, text: string): void {
  // Wire to v1's actual system-injection path. Likely candidates:
  //   - src/group-queue.ts (group-level enqueue)
  //   - src/orchestrator.ts (system-message helper)
  // If neither exists, add a minimal helper alongside this module.
  // TODO(C2 implementer): replace this stub with the real call.
  logger.info({ agentGroupId, text }, '[notifyAgent stub]');
}

// ── Request API ──

export interface RequestApprovalOptions {
  agentGroupId: string;
  agentName: string;
  action: string;
  payload: Record<string, unknown>;
  title: string;
  question: string;
  /** Origin channel kind for same-channel-kind tie-break in pickApprovalDelivery. */
  originChannelType?: string;
}

export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { agentGroupId, action, payload, title, question, agentName, originChannelType = '' } = opts;

  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    notifyAgent(agentGroupId, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(agentGroupId, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Approver embedded in payload for click-auth lookup. Avoids adding a column.
  const enrichedPayload = { ...payload, approver: target.userId };

  createPendingApproval({
    approval_id: approvalId,
    session_id: null,
    request_id: approvalId,
    action,
    payload: JSON.stringify(enrichedPayload),
    created_at: new Date().toISOString(),
    agent_group_id: agentGroupId,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    title,
    options_json: JSON.stringify(APPROVAL_OPTIONS),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    notifyAgent(agentGroupId, `${action} failed: no delivery adapter available.`);
    return;
  }

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title,
        question,
        options: APPROVAL_OPTIONS,
      }),
    );
  } catch (err) {
    logger.error({ action, approvalId, err }, 'Failed to deliver approval card');
    notifyAgent(agentGroupId, `${action} failed: could not deliver approval request to ${target.userId}.`);
    return;
  }

  logger.info({ action, approvalId, agentName, approver: target.userId }, 'Approval requested');
}
```

If `src/delivery.ts` doesn't exist on v1 yet, add a minimal version in this task: an exported `ChannelDeliveryAdapter` interface + a module-level `setDeliveryAdapter` / `getDeliveryAdapter` registry. The interface:

```ts
// src/delivery.ts (new, minimal)
export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: 'chat-sdk' | 'text',
    content: string,
  ): Promise<string | undefined>;   // returns platform_message_id if available
}

let adapter: ChannelDeliveryAdapter | null = null;
export function setDeliveryAdapter(a: ChannelDeliveryAdapter): void { adapter = a; }
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null { return adapter; }
```

If v1 already has channel adapters with a similar method, prefer extending the existing interface over adding a new file. Survey first:

```
grep -nE "interface .*ChannelAdapter|deliver.*channel|sendMessage" /data/nanotars/src/types.ts /data/nanotars/src/plugin-types.ts /data/nanotars/src/router.ts 2>/dev/null | head -20
```

- [ ] **Step 2: Update barrel**

```ts
// /data/nanotars/src/permissions/index.ts (append)
export * from './approvals.js';
```

- [ ] **Step 3: Tests**

`/data/nanotars/src/permissions/__tests__/approvals.test.ts`:

- `requestApproval` happy path: stubs `pickApprover` to return `['tg:1']`, `pickApprovalDelivery` to return a fake target, fake delivery adapter; assert `pending_approvals` row exists + adapter received an `ask_question` payload + payload JSON contains `approver: 'tg:1'`.
- No-approvers branch: `pickApprover` returns `[]` → no row created, `notifyAgent` called with the failure message, no adapter call.
- No-DM branch: `pickApprovalDelivery` returns null → no row, notifyAgent called.
- Adapter throws: row created (idempotent INSERT OR IGNORE) but caller is notified of failure.
- `registerApprovalHandler` + `getApprovalHandler` round-trip; re-registering same action overwrites + warns.

Use `vi.mock('./approval-routing.js')` to stub out `pickApprover` / `pickApprovalDelivery` since C3 hasn't landed yet.

- [ ] **Step 4: Run + commit**

```
cd /data/nanotars && npm test -- permissions/__tests__/approvals.test.ts && npm run typecheck
git add src/permissions/approvals.ts src/permissions/index.ts src/permissions/__tests__/approvals.test.ts src/delivery.ts
git commit -m "$(cat <<'EOF'
feat(approvals): add requestApproval primitive + handler registry

Mirrors v2's src/modules/approvals/primitive.ts, adapted for v1's
per-group-container model (agentGroupId in place of v2's session).

requestApproval picks one approver via the hierarchy in C3, delivers
an ask_question card to their DM, and persists a pending_approvals
row. Approver is embedded in the row's payload JSON for click-auth
lookup (avoids adding an approver_user_id column).

Adds a minimal ChannelDeliveryAdapter interface in src/delivery.ts
if v1 doesn't already have an equivalent.

Note: pickApprover / pickApprovalDelivery are stubbed; real impls
land in C3.
EOF
)"
```

**No reviewer dispatch — additive accessor module.**

---

## Task C3: `pickApprover` + `pickApprovalDelivery`

**Triage row:** Spec section "Functions / modules" — `permissions/approval-routing.ts`. Reads `user_roles` via Phase 4B accessors; resolves DMs via Phase 4B's `ensureUserDm`. Same-channel-kind tie-break in delivery.

**Files:**
- New: `/data/nanotars/src/permissions/approval-routing.ts`
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export)
- New: `/data/nanotars/src/permissions/__tests__/approval-routing.test.ts`

- [ ] **Step 1: Implementation**

```ts
import { listAdminsOfAgentGroup, listGlobalAdmins, listOwners } from './user-roles.js';
import { ensureUserDm } from './user-dms.js';
import type { MessagingGroup } from '../types.js';

/**
 * Ordered, deduped approver user_ids for the given agent group.
 * Order: scoped admins for that group → global admins → owners.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of listAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of listGlobalAdmins()) add(r.user_id);
  for (const r of listOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk approvers and return the first reachable DM. If `originChannelType`
 * is non-empty, prefer approvers reachable on that channel kind (one full
 * pass first); otherwise just take the first reachable.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm({ user_id: userId, channel_type: originChannelType });
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  for (const userId of approvers) {
    const mg = await ensureUserDm({ user_id: userId, channel_type: channelTypeOf(userId) });
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}
```

If 4B's `listOwners` returns `User[]` (not `UserRole[]`), adjust the field reference accordingly. Confirm against 4B's signatures before implementing — Phase 4B's spec line 118 says `listOwners(): User[]` but the plan in B2 step 3 uses `UserRole[]`. Whichever 4B actually shipped, this module follows.

If `ensureUserDm`'s 4B signature is `(args: { user_id, channel_type, channel_adapter? })` and the channel_adapter is required for indirect channels, this task may need the orchestrator's adapter registry available. Pass the delivery adapter through if needed; otherwise rely on 4B's cache + direct-channel handling.

- [ ] **Step 2: Tests**

`/data/nanotars/src/permissions/__tests__/approval-routing.test.ts`:

- `pickApprover` ordering: seed scoped admin + global admin + owner; assert returned list is `[scoped, global, owner]`.
- `pickApprover` dedup: same userId in multiple roles appears once.
- `pickApprover(null)`: skips scoped admins; returns `[global, owner]`.
- `pickApprover` empty result: no roles in DB → `[]`.
- `pickApprovalDelivery` same-channel-kind tie-break: approvers `['tg:1', 'whatsapp:2']`, originChannelType `'whatsapp'` → returns `whatsapp:2` even though `tg:1` is first.
- `pickApprovalDelivery` fallback: no approver matches origin → returns first reachable.
- `pickApprovalDelivery` no reachable DM: all `ensureUserDm` calls return undefined → returns null.

- [ ] **Step 3: Re-run C2 tests against real C3**

```
cd /data/nanotars && npm test -- src/permissions
```

The C2 tests that were stubbing this module should now pass against the real implementation; remove the `vi.mock` if appropriate.

- [ ] **Step 4: Commit**

```
git add src/permissions/approval-routing.ts src/permissions/index.ts src/permissions/__tests__/approval-routing.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals): add pickApprover + pickApprovalDelivery

Hierarchical approver resolution: scoped admins → global admins →
owners, deduped. Same-channel-kind tie-break in pickApprovalDelivery
prefers approvers reachable on the message origin's channel.

Reads user_roles via Phase 4B's listAdminsOfAgentGroup /
listGlobalAdmins / listOwners. Resolves DMs via 4B's ensureUserDm
(direct-channel handle = chat_id; indirect channels need
adapter.openDM, which 4B handles).
EOF
)"
```

**No reviewer dispatch — additive accessor module with full unit-test coverage.**

---

## Task C4: Click-auth + button-click dispatch wiring

**Triage row:** Spec section "Click-auth implementation note" + "Wiring" point 1. The cross-tier task. Adds `handleApprovalResponse` with click-auth, and wires button-click events from channel adapters into it. Touches the channel-adapter interface.

**Files:**
- New: `/data/nanotars/src/permissions/approval-response.ts`
- New: `/data/nanotars/src/permissions/__tests__/approval-response.test.ts`
- Modify: `/data/nanotars/src/types.ts` (add `ApprovalClickPayload`, extend channel adapter interface with optional `onInteraction` hook)
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export)
- Modify: any existing channel adapter that supports buttons (likely Telegram-only on v1; if v1 has none, this task adds the adapter contract and the wiring stays as a no-op until a real button-capable channel is added).

- [ ] **Step 1: Survey current channel-adapter contract**

```
grep -nE "interface .*ChannelAdapter|onInteraction|callback_data|button" /data/nanotars/src/plugin-types.ts /data/nanotars/src/types.ts /data/nanotars/src/router.ts /data/nanotars/src/orchestrator.ts | head -30
grep -rln "callback_data\|button" /data/nanotars/src/ 2>/dev/null
```

If v1 has no button-handling code at all (likely — the master triage notes v1 has no approval cards), this task adds the interaction interface and implements it stub-style. The wiring becomes live once a real button-capable channel adapter is wired (out of scope for 4C; documented in the commit message).

- [ ] **Step 2: Define `ApprovalClickPayload` + `onInteraction` hook**

In types.ts:

```ts
export interface ApprovalClickPayload {
  questionId: string;             // approval_id from the card
  value: string;                  // 'approve' | 'reject'
  channelType: string;            // for clicker resolution
  userId?: string;                // raw platform handle of clicker
}
```

If the channel-adapter interface lives in plugin-types.ts or types.ts, add an optional method:

```ts
export interface ChannelAdapter {
  // ...existing fields
  /** Called when an interactive button click arrives. Implementer must
   *  forward to the host's response dispatcher (see permissions/approval-response.ts). */
  onInteraction?: (payload: ApprovalClickPayload) => Promise<void>;
}
```

(This is forward-looking. v1's existing adapters won't implement it; that's fine.)

- [ ] **Step 3: Implement `approval-response.ts`**

```ts
import { logger } from '../logger.js';
import { getApprovalHandler } from './approvals.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';
import {
  deletePendingApproval,
  getPendingApproval,
  updatePendingApprovalStatus,
} from '../db/approvals.js';
import { resolveOneCLIApproval, ONECLI_ACTION } from './onecli-approvals.js';
import type { ApprovalClickPayload, PendingApproval } from '../types.js';

export async function handleApprovalResponse(payload: ApprovalClickPayload): Promise<boolean> {
  // OneCLI in-memory shortcut — landed by C6, but the import path is wired here from C4.
  if (resolveOneCLIApproval(payload.questionId, payload.value)) {
    return true;
  }

  const row = getPendingApproval(payload.questionId);
  if (!row) return false;

  if (row.action === ONECLI_ACTION) {
    // Row exists but in-memory resolver is gone (timer fired or process restart).
    // Drop the row and claim the click.
    deletePendingApproval(payload.questionId);
    return true;
  }

  // Click-auth — clicker must be the designated approver OR an admin/owner.
  const clickerId = payload.userId ? `${payload.channelType}:${payload.userId}` : null;
  let approverId: string | undefined;
  try {
    approverId = JSON.parse(row.payload).approver;
  } catch {
    /* malformed payload — approverId stays undefined, falling through to admin-only auth */
  }

  const authorized = clickerId !== null && (
    clickerId === approverId ||
    isOwner(clickerId) ||
    isGlobalAdmin(clickerId) ||
    (row.agent_group_id != null && isAdminOfAgentGroup(clickerId, row.agent_group_id))
  );

  if (!authorized) {
    logger.warn({ approvalId: row.approval_id, clickerId, expectedApprover: approverId }, 'approval click rejected — unauthorized clicker');
    return true;   // claim silently per v2's posture
  }

  await dispatchApproval(row, payload.value, clickerId);
  return true;
}

async function dispatchApproval(
  row: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!row.agent_group_id) {
    deletePendingApproval(row.approval_id);
    return;
  }

  const notify = (text: string): void => {
    // Wire to v1's system-message injection for the agent group. Same TODO as
    // approvals.ts notifyAgent — replace with the real call.
    logger.info({ agentGroupId: row.agent_group_id, text }, '[approval-response notify stub]');
  };

  if (selectedOption !== 'approve') {
    updatePendingApprovalStatus(row.approval_id, 'rejected');
    notify(`Your ${row.action} request was rejected by admin.`);
    logger.info({ approvalId: row.approval_id, action: row.action, userId }, 'Approval rejected');
    deletePendingApproval(row.approval_id);
    return;
  }

  const handler = getApprovalHandler(row.action);
  if (!handler) {
    logger.warn({ approvalId: row.approval_id, action: row.action }, 'No approval handler registered — row dropped');
    notify(`Your ${row.action} was approved, but no handler is installed to apply it.`);
    deletePendingApproval(row.approval_id);
    return;
  }

  const payload = JSON.parse(row.payload);
  try {
    await handler({ agentGroupId: row.agent_group_id, payload, userId, notify });
    updatePendingApprovalStatus(row.approval_id, 'approved');
    logger.info({ approvalId: row.approval_id, action: row.action, userId }, 'Approval handled');
  } catch (err) {
    logger.error({ approvalId: row.approval_id, action: row.action, err }, 'Approval handler threw');
    notify(`Your ${row.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`);
  }

  deletePendingApproval(row.approval_id);
}
```

Note: `resolveOneCLIApproval` is imported from C6's module. If C6 hasn't landed when C4 lands, either land them in the same commit OR use a forward-declaration stub:

```ts
// Forward stub until C6 lands
export const ONECLI_ACTION = 'onecli_credential';
export function resolveOneCLIApproval(_id: string, _v: string): boolean { return false; }
```

…and remove the stub when C6 commits. Cleaner: land C4 + C6 sequentially, with C4 importing from a placeholder file that C6 will replace.

- [ ] **Step 4: Tests**

`/data/nanotars/src/permissions/__tests__/approval-response.test.ts`:

Click-auth decision table (parametrized):
| Clicker role         | Expected outcome     |
|----------------------|----------------------|
| approver             | dispatched           |
| owner                | dispatched           |
| global admin         | dispatched           |
| scoped admin @ group | dispatched           |
| scoped admin @ other | rejected silently    |
| random user          | rejected silently    |
| unauthenticated      | rejected silently    |

- Reject path: notifies caller, drops row, status updated to 'rejected' before delete.
- Approve path with handler: handler called, status updated to 'approved' before delete.
- Approve path no handler: notifies caller, drops row.
- Approve path handler throws: notifies caller with error text, drops row.
- Unknown questionId: returns false (not claimed).
- Malformed `payload` JSON: `approverId` undefined; admin check still works for owner/global/scoped.

- [ ] **Step 5: Run + commit**

```
cd /data/nanotars && npm test -- permissions && npm run typecheck
git add src/permissions/approval-response.ts src/permissions/__tests__/approval-response.test.ts src/types.ts src/permissions/index.ts
git commit -m "$(cat <<'EOF'
feat(approvals): click-auth + handleApprovalResponse dispatcher

handleApprovalResponse is the host-side entry point for an approval
card click. Click-auth: clicker must be the designated approver OR
owner OR global admin OR scoped admin over the agent group. On
failure, the click is silently claimed (return true, no dispatch) —
v2's posture, deliberately preserved.

On approve: handler from registry called with agentGroupId + payload
+ approver userId + notify; status updated to 'approved' before row
delete. On reject: status updated to 'rejected' before row delete.

Channel adapters with button support implement an optional
onInteraction(payload) hook that forwards into this dispatcher.
v1 currently has no button-capable adapter; the wiring is
forward-looking until a real adapter ports.
EOF
)"
```

**Reviewer dispatch — IPC / channel-adapter contract change.**

---

## Task C5: Card-expiry sweep + edit-to-Expired helper

**Triage row:** Spec section "Functions / modules" — `permissions/approval-card-expiry.ts`. Mechanical port of v2's `sweepStaleApprovals` and `editCardExpired` from `onecli-approvals.ts`. Lives in its own module so C6 can call it cleanly and so other future card actions can reuse `editCardExpired`.

**Files:**
- New: `/data/nanotars/src/permissions/approval-card-expiry.ts`
- New: `/data/nanotars/src/permissions/__tests__/approval-card-expiry.test.ts`
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export)

- [ ] **Step 1: Implementation**

```ts
import { deletePendingApproval, getPendingApprovalsByAction } from '../db/approvals.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { logger } from '../logger.js';
import type { PendingApproval } from '../types.js';

/**
 * Edit a single card to "Expired (<reason>)" via the delivery adapter.
 * No-op if the row doesn't carry enough metadata to address the platform message.
 */
export async function editCardExpired(
  row: PendingApproval,
  reason: string,
  adapter: ChannelDeliveryAdapter,
): Promise<void> {
  if (!row.platform_message_id || !row.channel_type || !row.platform_id) return;
  try {
    await adapter.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: `Expired (${reason})`,
      }),
    );
  } catch (err) {
    logger.warn({ approvalId: row.approval_id, err }, 'Failed to edit expired approval card');
  }
}

/**
 * Edit all leftover OneCLI cards from a previous process run to
 * "Expired (host restarted)" and drop the rows. Called at host startup
 * before configureManualApproval is wired.
 */
export async function sweepStaleApprovals(
  adapter: ChannelDeliveryAdapter,
  action = 'onecli_credential',
): Promise<void> {
  const rows = getPendingApprovalsByAction(action);
  if (rows.length === 0) return;
  logger.info({ count: rows.length, action }, 'Sweeping stale approvals from previous process');
  for (const row of rows) {
    await editCardExpired(row, 'host restarted', adapter);
    deletePendingApproval(row.approval_id);
  }
}
```

- [ ] **Step 2: Tests**

`/data/nanotars/src/permissions/__tests__/approval-card-expiry.test.ts`:

- `editCardExpired` happy path: row with all platform metadata → adapter.deliver called with `operation: 'edit'`, expired text.
- `editCardExpired` no-platform-message-id: silent no-op (no adapter call).
- `editCardExpired` no-channel-type: silent no-op.
- `editCardExpired` adapter throws: logs warning but doesn't throw.
- `sweepStaleApprovals`: seed three rows with action='onecli_credential' + one row with action='other' → sweep edits + deletes the three; the 'other' row remains.
- `sweepStaleApprovals` no rows: silent no-op (no adapter calls).

- [ ] **Step 3: Run + commit**

```
cd /data/nanotars && npm test -- permissions/__tests__/approval-card-expiry.test.ts && npm run typecheck
git add src/permissions/approval-card-expiry.ts src/permissions/__tests__/approval-card-expiry.test.ts src/permissions/index.ts
git commit -m "$(cat <<'EOF'
feat(approvals): card-expiry sweep + editCardExpired helper

Two helpers used by the OneCLI bridge (C6) and reusable by future
card actions:
  - editCardExpired: best-effort edit a card to "Expired (<reason>)"
    via the delivery adapter; silent no-op if the row lacks platform
    metadata.
  - sweepStaleApprovals: at startup, edit all pending_approvals rows
    for the given action to "Expired (host restarted)" and drop them.

Defaults to action='onecli_credential' for the OneCLI use case;
parameterizable for future actions.
EOF
)"
```

**No reviewer dispatch — single-file mechanical helpers with full unit tests.**

---

## Task C6: OneCLI manual-approval bridge port

**Triage row:** Master triage Phase 4C section + Phase 3 deferred-items list. The bridge that Phase 3 explicitly deferred. Verbatim port of v2's `src/modules/approvals/onecli-approvals.ts` with directory + import-path rewrites for v1.

**Files:**
- New: `/data/nanotars/src/permissions/onecli-approvals.ts`
- New: `/data/nanotars/src/permissions/__tests__/onecli-approvals.test.ts`
- Modify: `/data/nanotars/src/index.ts` — call `startOneCLIApprovalHandler(deliveryAdapter)` after adapters initialize; `stopOneCLIApprovalHandler()` on shutdown.
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export)

- [ ] **Step 1: Read v2 reference one more time**

```
cat /data/nanoclaw-v2/src/modules/approvals/onecli-approvals.ts
```

This is the canonical port target. Note the short-id workaround for Telegram callback_data 64-byte limit (`shortApprovalId`), the in-memory `pending` Map, the timer-just-shy-of-TTL pattern.

- [ ] **Step 2: Port the file**

Create `/data/nanotars/src/permissions/onecli-approvals.ts` with the v2 source, adjusted for v1's import paths:

- `'./primitive.js'` → `'./approval-routing.js'` (for `pickApprover`, `pickApprovalDelivery`)
- `'../../config.js'` → `'../config.js'`
- `'../../db/agent-groups.js'` → `'../db/agent-groups.js'` (assumes 4A's accessor name; adjust if v1 named it differently — check what 4A actually shipped)
- `'../../db/sessions.js'` → `'../db/approvals.js'` (the four pending_approvals accessors live there in v1)
- `'../../delivery.js'` → `'../delivery.js'`
- `'../../log.js'` → `'../logger.js'` (v1 uses pino under `src/logger.ts`)
- `'../../types.js'` → `'../types.js'`
- Import `editCardExpired` + `sweepStaleApprovals` from `./approval-card-expiry.js` instead of inlining (C5 supplies them).

The bridge's structure:

```ts
import { OneCLI, type ApprovalRequest, type ManualApprovalHandle } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';      // adjust to v1's actual export name
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApprovalsByAction,
  updatePendingApprovalStatus,
} from '../db/approvals.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { logger } from '../logger.js';
import type { PendingApproval } from '../types.js';
import { pickApprovalDelivery, pickApprover } from './approval-routing.js';
import { editCardExpired, sweepStaleApprovals } from './approval-card-expiry.js';

export const ONECLI_ACTION = 'onecli_credential';
type Decision = 'approve' | 'deny';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

interface PendingState { resolve: (decision: Decision) => void; timer: NodeJS.Timeout; }
const pending = new Map<string, PendingState>();
let handle: ManualApprovalHandle | null = null;
let adapterRef: ChannelDeliveryAdapter | null = null;

function shortApprovalId(): string {
  return `oa-${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveOneCLIApproval(approvalId: string, selectedOption: string): boolean {
  const state = pending.get(approvalId);
  if (!state) return false;
  pending.delete(approvalId);
  clearTimeout(state.timer);

  const decision: Decision = selectedOption === 'approve' ? 'approve' : 'deny';
  updatePendingApprovalStatus(approvalId, decision === 'approve' ? 'approved' : 'rejected');
  deletePendingApproval(approvalId);

  state.resolve(decision);
  logger.info({ approvalId, decision }, 'OneCLI approval resolved');
  return true;
}

export function startOneCLIApprovalHandler(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (handle) return;
  adapterRef = deliveryAdapter;

  sweepStaleApprovals(deliveryAdapter, ONECLI_ACTION).catch((err) =>
    logger.error({ err }, 'OneCLI approval sweep failed'),
  );

  handle = onecli.configureManualApproval(async (request: ApprovalRequest): Promise<Decision> => {
    try {
      return await handleRequest(request);
    } catch (err) {
      logger.error({ id: request.id, err }, 'OneCLI approval handler errored');
      return 'deny';
    }
  });
  logger.info('OneCLI approval handler started');
}

export function stopOneCLIApprovalHandler(): void {
  handle?.stop();
  handle = null;
  for (const state of pending.values()) clearTimeout(state.timer);
  pending.clear();
  adapterRef = null;
}

async function handleRequest(request: ApprovalRequest): Promise<Decision> {
  if (!adapterRef) return 'deny';

  const originGroup = request.agent.externalId ? getAgentGroup(request.agent.externalId) : undefined;
  const agentGroupId = originGroup?.id ?? null;
  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    logger.warn({ id: request.id, host: request.host, agent: request.agent.externalId }, 'OneCLI approval auto-denied: no eligible approver');
    return 'deny';
  }

  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    logger.warn({ id: request.id, approvers }, 'OneCLI approval auto-denied: no DM channel for any approver');
    return 'deny';
  }

  const approvalId = shortApprovalId();
  const question = buildQuestion(request, originGroup?.name ?? request.agent.name);
  const onecliTitle = 'Credentials Request';
  const onecliOptions = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  ];

  let platformMessageId: string | undefined;
  try {
    platformMessageId = await adapterRef.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ type: 'ask_question', questionId: approvalId, title: onecliTitle, question, options: onecliOptions }),
    );
  } catch (err) {
    logger.error({ approvalId, oneCliRequestId: request.id, err }, 'Failed to deliver OneCLI approval card');
    return 'deny';
  }

  createPendingApproval({
    approval_id: approvalId,
    session_id: null,
    request_id: request.id,
    action: ONECLI_ACTION,
    payload: JSON.stringify({
      oneCliRequestId: request.id,
      method: request.method,
      host: request.host,
      path: request.path,
      bodyPreview: request.bodyPreview,
      agent: request.agent,
      approver: target.userId,
    }),
    created_at: new Date().toISOString(),
    agent_group_id: agentGroupId,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    platform_message_id: platformMessageId ?? null,
    expires_at: request.expiresAt,
    status: 'pending',
    title: onecliTitle,
    options_json: JSON.stringify(onecliOptions),
  });

  const expiresAtMs = new Date(request.expiresAt).getTime();
  const timeoutMs = Math.max(1000, expiresAtMs - Date.now() - 1000);

  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(approvalId)) return;
      pending.delete(approvalId);
      expireApproval(approvalId, 'no response').catch((err) =>
        logger.error({ approvalId, err }, 'Failed to mark OneCLI approval expired'),
      );
      resolve('deny');
    }, timeoutMs);

    pending.set(approvalId, { resolve, timer });
  });
}

async function expireApproval(approvalId: string, reason: string): Promise<void> {
  const rows = getPendingApprovalsByAction(ONECLI_ACTION).filter((r) => r.approval_id === approvalId);
  const row = rows[0];
  if (!row) return;
  updatePendingApprovalStatus(approvalId, 'expired');
  if (adapterRef) await editCardExpired(row, reason, adapterRef);
  deletePendingApproval(approvalId);
  logger.info({ approvalId, reason }, 'OneCLI approval expired');
}

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [
    'Credential access request',
    `Agent: ${agentName}`,
    '```',
    `${request.method} ${request.host}${request.path}`,
    '```',
  ];
  if (request.bodyPreview) lines.push('Body:', '```', request.bodyPreview, '```');
  return lines.join('\n');
}
```

- [ ] **Step 3: Wire startup + shutdown in `src/index.ts`**

After channel adapters + delivery adapter are initialized:

```ts
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './permissions/onecli-approvals.js';

// In the startup sequence, after the delivery adapter is wired:
const deliveryAdapter = getDeliveryAdapter();
if (deliveryAdapter) {
  startOneCLIApprovalHandler(deliveryAdapter);
}

// In the shutdown handler:
process.on('SIGTERM', () => {
  stopOneCLIApprovalHandler();
  // ...existing shutdown chain
});
```

If `ONECLI_URL` / `ONECLI_API_KEY` aren't configured, the OneCLI SDK constructor itself may throw on first `configureManualApproval` call. Wrap the start call in a try/catch and log a warning if the gateway is unreachable; v1 must keep working without OneCLI (matching Phase 3's "fall through silently if not reachable" posture).

- [ ] **Step 4: Tests**

`/data/nanotars/src/permissions/__tests__/onecli-approvals.test.ts`:

Mock `@onecli-sh/sdk` (same `vi.mock` pattern Phase 3 uses). The mock's `configureManualApproval` captures the callback so tests can invoke it directly with synthetic `ApprovalRequest` objects.

- Happy path: synthetic request → callback delivers card → `pending_approvals` row created → calling `resolveOneCLIApproval(approvalId, 'approve')` resolves the Promise to `'approve'` and updates row to 'approved' (then deletes).
- Reject path: same as above but with `'reject'` → resolves to `'deny'`, row updated to 'rejected'.
- Expiry path with `vi.useFakeTimers`: synthetic request → fast-forward past `expiresAt - 1000ms` → Promise resolves to `'deny'`, row updated to 'expired', card edit attempted.
- No-approvers branch: `pickApprover` returns `[]` (faked via in-memory user_roles) → callback returns `'deny'` immediately, no row created.
- No-DM branch: `pickApprovalDelivery` returns null → `'deny'` immediately, no row.
- Adapter throws: `'deny'`, no row.
- Startup sweep: pre-seed two leftover `'onecli_credential'` rows → call `startOneCLIApprovalHandler(adapter)` → both rows are edited + deleted.

- [ ] **Step 5: Run + commit**

```
cd /data/nanotars && npm test && npm run typecheck
git add src/permissions/onecli-approvals.ts src/permissions/__tests__/onecli-approvals.test.ts src/permissions/index.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(approvals): OneCLI manual-approval bridge

Picks up the bridge that Phase 3 explicitly deferred. Verbatim port
of v2's src/modules/approvals/onecli-approvals.ts with directory +
import-path rewrites for v1.

The bridge:
  - configureManualApproval(callback) registered at host startup
  - on callback: pickApprover (4B) → pickApprovalDelivery (4C C3) →
    deliver ask_question card → persist pending_approvals row
  - in-process Promise resolved by click (resolveOneCLIApproval) or
    by an expiry timer just-shy of OneCLI's TTL → 'deny'
  - startup sweep: edits leftover cards from previous process to
    "Expired (host restarted)" and drops rows

Short approval id (oa-<8 base36>) preserves v2's Telegram
callback_data 64-byte workaround. The OneCLI request.id stays in
the pending_approvals.payload JSON for audit.

Best-effort: if ONECLI_URL/API_KEY isn't configured, host startup
logs a warning and continues without manual-approval wiring.
Phase 3's no-OneCLI fallback path is unchanged.
EOF
)"
```

**Reviewer dispatch — cross-tier OneCLI integration.**

---

## Task C7: Final phase review

After all tasks land, dispatch the final phase reviewer per memory `feedback-cross-tier-reviews`.

**Reviewer prompt:**

```
Final review of Phase 4C on /data/nanotars v1-archive. HEAD started
at <Phase 4C spec commit SHA>; current HEAD is <SHA>. Review:

git log <spec-sha>..HEAD --oneline

Verify:
1. Spec compliance against
   docs/superpowers/specs/2026-04-25-phase-4c-approval-primitive-design.md
2. Migration 015 idempotent; createSchema and migration share DDL via
   a constant (no drift). Phase 4A's migration policy applied.
3. pending_approvals column shape exactly matches the spec; the
   session_id-without-FK divergence is documented in the migration body.
4. permissions/ barrel re-exports all 5 new modules cleanly.
5. requestApproval honors no-approvers / no-DM / adapter-throws
   branches with caller-notify + bail (no orphan rows on failure).
6. pickApprover hierarchy + dedup + same-channel-kind tie-break
   match the spec.
7. handleApprovalResponse click-auth: clicker = approver | owner |
   global admin | scoped admin @ row.agent_group_id; otherwise the
   click is silently claimed (return true with no dispatch). No log
   of sensitive payload contents on the unauthorized branch.
8. OneCLI bridge:
   a. configureManualApproval registered at host startup (and not
      twice — handle guard works).
   b. Short approval id (oa-<8 base36>) used for cards/buttons; the
      OneCLI request.id stays in payload JSON for audit.
   c. Startup sweep edits + drops leftover OneCLI rows.
   d. Expiry timer fires just-shy of expiresAt; resolves 'deny';
      updates row status to 'expired'; edits card.
   e. Falls through silently when ONECLI_URL isn't configured — v1
      must work without OneCLI.
9. No agent-runner changes; container bun test count unchanged.
10. Tests adequate for each new module.

Out of scope:
- Phase 4D (pending_questions, pending_sender_approvals,
  pending_channel_approvals, ask_question MCP tool).
- Phase 5 (self-modification, per-session containers).
- Full Chat SDK bridge port (rich card-rendering surface).

Report findings: Critical / High / Medium / Low / Nit with file:line.
End with PHASE 4C APPROVED or PHASE 4C NEEDS FIXES.
```

---

## Self-review checklist

- [x] Spec coverage: all 4C sections (schema, modules, click-auth, wiring, OneCLI bridge, expiry sweep, out-of-scope) map to tasks C1-C6.
- [x] Migration policy applied: one DDL change → one MIGRATIONS entry; createSchema and migration share a DDL constant per Phase 4A.
- [x] Reviewer dispatch: C1 (schema), C4 (cross-tier IPC + adapter contract), C6 (cross-tier OneCLI integration). Mechanical: C2, C3, C5.
- [x] npm-not-pnpm warnings present in pre-flight + tech stack.
- [x] Phase 4B dependency named explicitly: pickApprover reads via 4B's listAdminsOfAgentGroup / listGlobalAdmins / listOwners; pickApprovalDelivery uses 4B's ensureUserDm.
- [x] Phase 3 dependency named explicitly: OneCLI gateway must be wired (C6 step 1's pre-flight).
- [x] Click-auth posture matches v2: silent-claim on unauthorized clicker.
- [x] Approver embedded in payload JSON (no new column) — documented decision.
- [x] session_id without FK reference — documented in C1 step 2.
- [x] notifyAgent stubs flagged as TODOs to wire to v1's actual system-message injection path; replacement happens in the implementer's first concrete pass on each module.
- [x] Plugin contract: no new plugin-facing changes in 4C (the channel-adapter `onInteraction` hook is optional + forward-looking; existing adapters compile unchanged).
