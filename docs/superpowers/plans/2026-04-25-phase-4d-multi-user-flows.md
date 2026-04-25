# Phase 4D: Multi-user user-facing flows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add v2's three user-facing approval flows on top of Phase 4B (RBAC) + Phase 4C (approval primitive). Three new tables (`pending_sender_approvals`, `pending_channel_approvals`, `pending_questions`), the request/respond modules in `src/permissions/sender-approval.ts` + `channel-approval.ts`, the host-side interactive response handler, and the container-side `ask_user_question` MCP tool. PK / UNIQUE in-flight dedup; integration with 4C's central card-expiry sweep.

**Architecture:** Three tables join the central DB (`STORE_DIR/messages.db`). Each table's PK or UNIQUE constraint is the in-flight dedup gate. Sender-approval and channel-approval each write a paired `pending_approvals` row (4C primitive) so the unified card-expiry sweep covers them. Plain `ask_user_question` calls go through their own response-handler that runs ahead of the 4C action dispatcher in the registry order. Router gains two new branches: sender-scope failure with `unknown_sender_policy='request_approval'` calls `requestSenderApproval`; unwired-channel + bot mention with no `denied_at` calls `requestChannelApproval`.

**Tech Stack:** Node 22, TypeScript 5.9, vitest 4, better-sqlite3 11. **npm**, not pnpm. `npm test`, `npm run typecheck`, `npm install`. Container side runs on whatever runtime v1-archive uses for the agent-runner today (verify in pre-flight; v1-archive likely Node + vitest, NOT bun like v2 — confirm before D4 ships its container test). Lockfile is `package-lock.json`.

**Spec input:** `/data/nanotars/docs/superpowers/specs/2026-04-25-phase-4d-multi-user-flows-design.md`

---

## CONTRIBUTE upstream PRs — out of scope

Same as prior phases.

---

## Items deferred from Phase 4D

- Identity merging across channels — possibly a future phase, not 4D.
- Multi-agent picker for channel-registration card — today: first agent group by created_at.
- Manual `/wire` / `/unwire` admin command — operational helper, not 4D.
- `unregistered_senders` diagnostic counter — skipped on technical merit (logs cover it).
- Self-modification approval flows (`install_packages`, `add_mcp_server`) — Phase 5.
- Lifecycle pause/resume, provider abstraction, `create_agent` — Phase 5.
- Per-session containers + two-DB IPC — Phase 6.
- Cross-container agent messaging, supportsThreads — Phase 7.

---

## Pre-flight verification

- [ ] **Step 1: Verify v1-archive clean tree, Phase 4B + 4C complete**

```
cd /data/nanotars && git status --short --branch
cd /data/nanotars && git log --oneline -5
```

Expected: clean tree on v1-archive. HEAD shows the Phase 4B final-review commit followed by the Phase 4C completion commits. `git log --oneline | grep -i 'phase 4[bc]'` lists at least the spec + final-review commits for both phases. If 4B or 4C aren't done, STOP — 4D depends on `users` / `user_roles` / `agent_group_members` / `user_dms` (4B) and `pending_approvals` / `requestApproval` / `pickApprover` / `pickApprovalDelivery` / `registerApprovalHandler` (4C).

- [ ] **Step 2: Verify baseline test counts**

```
cd /data/nanotars && npm test 2>&1 | tail -5
cd /data/nanotars/container/agent-runner && npm test 2>&1 | tail -5  # OR bun test if v1-archive container uses bun
```

Record the baseline numbers. Each task adds tests; final-phase review checks the delta is plausible.

- [ ] **Step 3: Typecheck clean**

```
cd /data/nanotars && npm run typecheck
```

- [ ] **Step 4: Confirm Phase 4A added `messaging_groups.denied_at`**

```
cd /data/nanotars && node -e "
const db = require('better-sqlite3')(process.env.STORE_DIR ? process.env.STORE_DIR + '/messages.db' : 'data/nanotars.db');
console.log(db.prepare(\"PRAGMA table_info('messaging_groups')\").all().map(c => c.name));
"
```

If `denied_at` is in the column list, migration 017 only ships the `pending_channel_approvals` table. If not, migration 017 also issues `ALTER TABLE messaging_groups ADD COLUMN denied_at TEXT` (idempotent guarded with `PRAGMA table_info` check, mirroring v2 migration 012). Plan assumes it's missing — adjust D1 if it isn't.

- [ ] **Step 5: Confirm container-runner test runtime**

```
cat /data/nanotars/container/agent-runner/package.json | grep -E '"test"|"vitest"|"bun"'
```

If `bun:test`: D4's container test imports from `bun:test`. If `vitest`: imports from `vitest`. v2 uses bun; v1-archive likely vitest. Plan default: vitest; flip in D4 if bun.

- [ ] **Step 6: Confirm 4C's response-handler registry export name**

```
grep -n "registerApprovalHandler\|registerResponseHandler" /data/nanotars/src/permissions/index.ts /data/nanotars/src/index.ts 2>/dev/null
```

Phase 4C defines the registry. Confirm export name + signature; D2/D3/D4 wire against whatever 4C shipped. If the names differ from this plan's references (`registerApprovalHandler` and `registerResponseHandler`), substitute throughout.

---

## Task D1: Schemas + migrations 016-018

**Files:**
- `/data/nanotars/src/db/init.ts` (createSchema additions + 3 migration entries)
- `/data/nanotars/src/__tests__/migration-016-018.test.ts` (combined test file)

The three new tables + the (idempotent guarded) `denied_at` column on `messaging_groups`.

- [ ] **Step 1: Add CREATE TABLE statements to createSchema**

After the Phase 4B + 4C tables, append:

```sql
CREATE TABLE IF NOT EXISTS pending_sender_approvals (
  id                   TEXT PRIMARY KEY,
  messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity      TEXT NOT NULL,
  sender_name          TEXT,
  original_message     TEXT NOT NULL,
  approver_user_id     TEXT NOT NULL REFERENCES users(id),
  approval_id          TEXT REFERENCES pending_approvals(approval_id),
  title                TEXT NOT NULL DEFAULT '',
  options_json         TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
CREATE INDEX IF NOT EXISTS idx_pending_sender_approvals_mg
  ON pending_sender_approvals(messaging_group_id);

CREATE TABLE IF NOT EXISTS pending_channel_approvals (
  messaging_group_id   TEXT PRIMARY KEY REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  original_message     TEXT NOT NULL,
  approver_user_id     TEXT NOT NULL REFERENCES users(id),
  approval_id          TEXT REFERENCES pending_approvals(approval_id),
  title                TEXT NOT NULL DEFAULT '',
  options_json         TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  approval_id    TEXT REFERENCES pending_approvals(approval_id),
  created_at     TEXT NOT NULL
);
```

Use the same shared-DDL constant pattern Phase 4A established (factor each table's DDL into a constant; createSchema and the matching migration both reference the constant — no drift).

- [ ] **Step 2: Append migrations 016-018 to MIGRATIONS array**

```ts
{
  name: '016_add_pending_sender_approvals',
  up: (db) => db.exec(PENDING_SENDER_APPROVALS_DDL),
},
{
  name: '017_add_pending_channel_approvals',
  up: (db) => {
    // Idempotent guard: add denied_at to messaging_groups if absent.
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'denied_at')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN denied_at TEXT`);
    }
    db.exec(PENDING_CHANNEL_APPROVALS_DDL);
  },
},
{
  name: '018_add_pending_questions',
  up: (db) => db.exec(PENDING_QUESTIONS_DDL),
},
```

- [ ] **Step 3: Migration tests**

`/data/nanotars/src/__tests__/migration-016-018.test.ts`:
- Build a Phase-4C-shaped DB (manually, mirroring how migration-010-013 builds a Phase-4A-shaped DB). The pre-016 state has `messaging_groups`, `agent_groups`, `users`, `pending_approvals`, etc., but no pending_sender / pending_channel / pending_questions tables.
- Run migrations 016-018; assert each table exists with the right column list, PK, UNIQUE, indexes.
- Idempotency: run all three migrations twice; assert no error, schema unchanged.
- 017 idempotency variant: pre-state with `denied_at` already present (simulate Phase 4A having added it). Migration 017 must skip the ALTER.
- 017 idempotency variant: pre-state without `denied_at`. Migration 017 must add it.

- [ ] **Step 4: Bump db.test.ts schema_version assertions**

If `src/db/__tests__/db.test.ts` asserts the migration count, bump it: 4B took it to 14, 4C to 15, 4D to 18.

- [ ] **Step 5: Run tests + typecheck**

```
cd /data/nanotars && npm test && npm run typecheck
```

Expected: ~3-5 new tests pass; everything else green.

- [ ] **Step 6: Commit**

```
git add src/db/init.ts src/__tests__/migration-016-018.test.ts src/db/__tests__/db.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add pending_sender_approvals + pending_channel_approvals + pending_questions

Phase 4D foundation: introduces the three user-facing approval state
tables. PK / UNIQUE constraints provide free in-flight dedup so a
retry / second message from the same unknown sender, second mention
on the same unwired channel, or second ask_question with a colliding
id is silently dropped at the INSERT step.

Migration 017 idempotently adds messaging_groups.denied_at via
PRAGMA-guarded ALTER TABLE (mirrors v2 migration 012).

Per Phase 4A's migration policy: createSchema and migrations 016-018
share DDL via constants (no drift).

Spec: docs/superpowers/specs/2026-04-25-phase-4d-multi-user-flows-design.md
EOF
)"
```

**Reviewer dispatch — schema change + cross-table FK references.**

---

## Task D2: pending_sender_approvals module + sender-approval flow

**Files:**
- New: `/data/nanotars/src/permissions/db/pending-sender-approvals.ts`
- New: `/data/nanotars/src/permissions/db/__tests__/pending-sender-approvals.test.ts`
- New: `/data/nanotars/src/permissions/sender-approval.ts`
- New: `/data/nanotars/src/permissions/__tests__/sender-approval.test.ts`
- New: `/data/nanotars/src/permissions/__tests__/sender-approval-response.test.ts`
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export + register response handler)
- Modify: `/data/nanotars/src/orchestrator.ts` or `src/router.ts` (call `requestSenderApproval` from the sender-scope failure branch)

- [ ] **Step 1: DB module**

`/data/nanotars/src/permissions/db/pending-sender-approvals.ts`:

```ts
import { getDb } from '../../db/init.js';

export interface PendingSenderApproval {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
  approver_user_id: string;
  approval_id: string | null;
  title: string;
  options_json: string;
  created_at: string;
}

export function createPendingSenderApproval(row: PendingSenderApproval): boolean {
  const result = getDb()
    .prepare(`INSERT OR IGNORE INTO pending_sender_approvals (
      id, messaging_group_id, agent_group_id, sender_identity, sender_name,
      original_message, approver_user_id, approval_id, title, options_json, created_at
    ) VALUES (
      @id, @messaging_group_id, @agent_group_id, @sender_identity, @sender_name,
      @original_message, @approver_user_id, @approval_id, @title, @options_json, @created_at
    )`)
    .run(row);
  return result.changes > 0;
}

export function getPendingSenderApproval(id: string): PendingSenderApproval | undefined {
  return getDb().prepare(`SELECT * FROM pending_sender_approvals WHERE id = ?`).get(id) as PendingSenderApproval | undefined;
}

export function hasInFlightSenderApproval(messagingGroupId: string, senderIdentity: string): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM pending_sender_approvals WHERE messaging_group_id = ? AND sender_identity = ? LIMIT 1`
  ).get(messagingGroupId, senderIdentity);
  return row !== undefined;
}

export function deletePendingSenderApproval(id: string): void {
  getDb().prepare(`DELETE FROM pending_sender_approvals WHERE id = ?`).run(id);
}

export function getSenderApprovalByApprovalId(approvalId: string): PendingSenderApproval | undefined {
  return getDb().prepare(`SELECT * FROM pending_sender_approvals WHERE approval_id = ?`).get(approvalId) as PendingSenderApproval | undefined;
}
```

DB-module tests cover: CRUD + UNIQUE constraint (second insert on same `(messaging_group_id, sender_identity)` returns `false` from `createPendingSenderApproval`).

- [ ] **Step 2: Request flow + response handler**

`/data/nanotars/src/permissions/sender-approval.ts`:

```ts
import { pickApprover, pickApprovalDelivery, requestApproval } from './index.js'; // 4C primitive
import { addMember } from './agent-group-members.js';
import { getMessagingGroup } from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
  createPendingSenderApproval,
  hasInFlightSenderApproval,
  getSenderApprovalByApprovalId,
  deletePendingSenderApproval,
} from './db/pending-sender-approvals.js';
// import the v1 routeInbound entry point (orchestrator or router) for replay
import { routeInbound } from '../router.js'; // adjust to v1's actual export

const APPROVAL_OPTIONS = [
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve' },
  { label: 'Deny',  selectedLabel: '❌ Denied',  value: 'reject' },
];

const APPROVE_VALUE = 'approve';
const REJECT_VALUE = 'reject';

function generateId(): string {
  return `nsa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string;
  senderName: string | null;
  event: unknown; // the original inbound event
}

export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<void> {
  if (hasInFlightSenderApproval(input.messagingGroupId, input.senderIdentity)) {
    logger.debug({ ...input }, 'Unknown-sender approval already in flight — dropping retry');
    return;
  }

  const approvers = pickApprover(input.agentGroupId);
  if (approvers.length === 0) {
    logger.warn({ ...input }, 'Unknown-sender approval skipped — no owner or admin configured');
    return;
  }

  const originMg = getMessagingGroup(input.messagingGroupId);
  const target = await pickApprovalDelivery(approvers, originMg?.channel_type ?? '');
  if (!target) {
    logger.warn({ ...input }, 'Unknown-sender approval skipped — no DM channel for any approver');
    return;
  }

  const approvalId = generateId();
  const senderDisplay = input.senderName?.length ? input.senderName : input.senderIdentity;
  const originName = originMg?.name ?? `a ${originMg?.channel_type ?? 'channel'}`;
  const title = '👤 New sender';
  const question = `${senderDisplay} wants to talk to your agent in ${originName}. Allow?`;

  // Atomic: write both rows so the central card-expiry sweep in 4C can edit
  // the card to "Expired" by joining via approval_id.
  const tx = (require('../db/init.js') as typeof import('../db/init.js')).getDb().transaction(() => {
    createPendingSenderApproval({
      id: approvalId,
      messaging_group_id: input.messagingGroupId,
      agent_group_id: input.agentGroupId,
      sender_identity: input.senderIdentity,
      sender_name: input.senderName,
      original_message: JSON.stringify(input.event),
      approver_user_id: target.userId,
      approval_id: approvalId,
      title,
      options_json: JSON.stringify(APPROVAL_OPTIONS),
      created_at: new Date().toISOString(),
    });
    requestApproval({
      approval_id: approvalId,
      action: 'sender-approval',
      // the rest of the pending_approvals-shape fields, mirroring 4C's contract
      // ...
    });
  });
  tx();

  // Deliver the card to the approver via 4C's pickApprovalDelivery target
  await target.deliver({
    type: 'ask_question',
    questionId: approvalId,
    title,
    question,
    options: APPROVAL_OPTIONS,
  });
}

// Response handler — registered with 4C's registerApprovalHandler('sender-approval', ...)
export async function handleSenderApprovalResponse(payload: { approvalId: string; value: string }): Promise<boolean> {
  const row = getSenderApprovalByApprovalId(payload.approvalId);
  if (!row) return false;

  if (payload.value === APPROVE_VALUE) {
    addMember({
      user_id: row.sender_identity,
      agent_group_id: row.agent_group_id,
      added_by: row.approver_user_id,
    });
    // Replay the original inbound event through the normal routing path
    await routeInbound(JSON.parse(row.original_message));
  }

  deletePendingSenderApproval(row.id);
  // 4C's primitive deletes the pending_approvals row separately (it owns that table)
  return true;
}
```

Adjust the `requestApproval` call shape to whatever 4C's primitive accepts. The exact signature depends on 4C's plan — read the 4C plan + spec before implementing.

- [ ] **Step 3: Wire response handler**

In `src/index.ts` (or wherever the host bootstraps and registers other approval handlers from 4C):

```ts
import { handleSenderApprovalResponse } from './permissions/sender-approval.js';
registerApprovalHandler('sender-approval', handleSenderApprovalResponse);
```

- [ ] **Step 4: Wire `requestSenderApproval` into router**

In `src/orchestrator.ts` or `src/router.ts` — wherever Phase 4B added the sender-scope gate. Extend the drop branch:

```ts
if (wiring.sender_scope === 'known' && !isMember(userId, agentGroup.id)) {
  if (messagingGroup.unknown_sender_policy === 'request_approval') {
    await requestSenderApproval({
      messagingGroupId: messagingGroup.id,
      agentGroupId: agentGroup.id,
      senderIdentity: userId,
      senderName: senderName ?? null,
      event,
    });
  }
  continue;
}
```

`messagingGroup` must be in scope here — if 4B's gate only had `wiring`, plumb the `messaging_groups` row through too (cheap — it was already looked up).

- [ ] **Step 5: Tests**

`pending-sender-approvals.test.ts` — unit DB tests (CRUD, UNIQUE).

`sender-approval.test.ts` — request flow:
- Happy path: pickApprover returns one, pickApprovalDelivery returns a target, INSERT succeeds, deliver called once.
- Dedup: second call with same (messagingGroupId, senderIdentity) early-returns; deliver not called.
- No approver: warn + early-return; no DB row, no card.
- No DM target: warn + early-return; no row, no card.

`sender-approval-response.test.ts` — response handler:
- Approve path: addMember called with correct args; routeInbound called with the parsed event; row deleted; returns true.
- Deny path: addMember NOT called; routeInbound NOT called; row deleted; returns true.
- Unknown approvalId: returns false (no row in `pending_sender_approvals`).

Mock `pickApprover` / `pickApprovalDelivery` / `requestApproval` (4C exports). Mock `routeInbound`. Use a real in-memory DB so the constraint logic is exercised.

- [ ] **Step 6: Run + commit**

```
cd /data/nanotars && npm test && npm run typecheck
git add src/permissions/sender-approval.ts src/permissions/db/pending-sender-approvals.ts src/permissions/index.ts src/permissions/__tests__/sender-approval.test.ts src/permissions/__tests__/sender-approval-response.test.ts src/permissions/db/__tests__/pending-sender-approvals.test.ts src/orchestrator.ts src/router.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(permissions): add unknown-sender approval flow

Phase 4D: when an unknown sender writes into a wired chat with
unknown_sender_policy='request_approval', the router calls
requestSenderApproval instead of silently dropping. The flow picks
an approver via 4C's pickApprover/pickApprovalDelivery primitives,
records a pending_sender_approvals row + paired pending_approvals
row, and delivers an Allow/Deny card via the approver's DM.

On approve: handler adds the sender to agent_group_members and
replays the original inbound event through routeInbound. On deny:
handler just deletes the rows. UNIQUE(messaging_group_id,
sender_identity) gives free in-flight dedup.
EOF
)"
```

**Reviewer dispatch — cross-tier (DB + permissions module + router behavior + response handler registry).**

---

## Task D3: pending_channel_approvals module + channel-approval flow

**Files:**
- New: `/data/nanotars/src/permissions/db/pending-channel-approvals.ts`
- New: `/data/nanotars/src/permissions/db/__tests__/pending-channel-approvals.test.ts`
- New: `/data/nanotars/src/permissions/channel-approval.ts`
- New: `/data/nanotars/src/permissions/__tests__/channel-approval.test.ts`
- New: `/data/nanotars/src/permissions/__tests__/channel-approval-response.test.ts`
- Modify: `/data/nanotars/src/permissions/index.ts` (re-export + register response handler)
- Modify: `/data/nanotars/src/router.ts` (call `requestChannelApproval` from the unwired-channel branch)

Mirrors D2's structure with channel-approval semantics.

- [ ] **Step 1: DB module**

`/data/nanotars/src/permissions/db/pending-channel-approvals.ts`:

```ts
import { getDb } from '../../db/init.js';

export interface PendingChannelApproval {
  messaging_group_id: string;
  agent_group_id: string;
  original_message: string;
  approver_user_id: string;
  approval_id: string | null;
  title: string;
  options_json: string;
  created_at: string;
}

export function createPendingChannelApproval(row: PendingChannelApproval): boolean {
  const result = getDb()
    .prepare(`INSERT OR IGNORE INTO pending_channel_approvals (
      messaging_group_id, agent_group_id, original_message, approver_user_id,
      approval_id, title, options_json, created_at
    ) VALUES (
      @messaging_group_id, @agent_group_id, @original_message, @approver_user_id,
      @approval_id, @title, @options_json, @created_at
    )`)
    .run(row);
  return result.changes > 0;
}

export function getPendingChannelApproval(messagingGroupId: string): PendingChannelApproval | undefined {
  return getDb().prepare(`SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?`).get(messagingGroupId) as PendingChannelApproval | undefined;
}

export function hasInFlightChannelApproval(messagingGroupId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM pending_channel_approvals WHERE messaging_group_id = ? LIMIT 1`).get(messagingGroupId);
  return row !== undefined;
}

export function deletePendingChannelApproval(messagingGroupId: string): void {
  getDb().prepare(`DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?`).run(messagingGroupId);
}

export function getChannelApprovalByApprovalId(approvalId: string): PendingChannelApproval | undefined {
  return getDb().prepare(`SELECT * FROM pending_channel_approvals WHERE approval_id = ?`).get(approvalId) as PendingChannelApproval | undefined;
}

export function setMessagingGroupDeniedAt(messagingGroupId: string, deniedAt: string): void {
  getDb().prepare(`UPDATE messaging_groups SET denied_at = ? WHERE id = ?`).run(deniedAt, messagingGroupId);
}
```

DB-module tests: CRUD + PK constraint (second insert on same `messaging_group_id` returns `false`); `setMessagingGroupDeniedAt` updates the column.

- [ ] **Step 2: Request flow + response handler**

`/data/nanotars/src/permissions/channel-approval.ts`:

```ts
import { pickApprover, pickApprovalDelivery, requestApproval } from './index.js';
import { addMember } from './agent-group-members.js';
import { getAllAgentGroups, getMessagingGroup, createMessagingGroupAgent } from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
  createPendingChannelApproval,
  hasInFlightChannelApproval,
  getChannelApprovalByApprovalId,
  deletePendingChannelApproval,
  setMessagingGroupDeniedAt,
} from './db/pending-channel-approvals.js';
import { routeInbound } from '../router.js';

const APPROVAL_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Wired', value: 'approve' },
  { label: 'Ignore',  selectedLabel: '🙅 Ignored', value: 'reject' },
];
const APPROVE_VALUE = 'approve';
const REJECT_VALUE = 'reject';

export interface RequestChannelApprovalInput {
  messagingGroupId: string;
  event: unknown;
}

export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<void> {
  if (hasInFlightChannelApproval(input.messagingGroupId)) {
    logger.debug({ ...input }, 'Channel registration already in flight — dropping retry');
    return;
  }

  const agentGroups = getAllAgentGroups();
  if (agentGroups.length === 0) {
    logger.warn({ ...input }, 'Channel registration skipped — no agent groups configured');
    return;
  }
  const target = agentGroups[0]; // MVP: first by created_at; multi-agent picker is a follow-up

  const approvers = pickApprover(target.id);
  if (approvers.length === 0) {
    logger.warn({ ...input, targetAgentGroupId: target.id }, 'Channel registration skipped — no owner or admin configured');
    return;
  }

  const originMg = getMessagingGroup(input.messagingGroupId);
  const delivery = await pickApprovalDelivery(approvers, originMg?.channel_type ?? '');
  if (!delivery) {
    logger.warn({ ...input }, 'Channel registration skipped — no DM channel for any approver');
    return;
  }

  // Title + question text — branch on is_group + senderName
  const isGroup = (originMg?.is_group === 1) || /* event.message.isGroup heuristic */ false;
  let senderName: string | undefined;
  try {
    const parsed = JSON.parse((input.event as any)?.message?.content ?? 'null');
    senderName = parsed?.senderName ?? parsed?.sender;
  } catch { /* ignore */ }

  const title = isGroup ? '📣 Bot mentioned in new chat' : '💬 New direct message';
  const question = isGroup
    ? (senderName
        ? `${senderName} mentioned your agent in a ${originMg?.channel_type} channel. Wire it to ${target.name} and let it engage?`
        : `Your agent was mentioned in a ${originMg?.channel_type} channel. Wire it to ${target.name} and let it engage?`)
    : (senderName
        ? `${senderName} DM'd your agent on ${originMg?.channel_type}. Wire it to ${target.name} and let it respond?`
        : `Someone DM'd your agent on ${originMg?.channel_type}. Wire it to ${target.name} and let it respond?`);

  const approvalId = input.messagingGroupId; // PK is unique per channel — use it as approvalId

  // Atomic: pending_channel_approvals + pending_approvals
  const tx = (require('../db/init.js') as typeof import('../db/init.js')).getDb().transaction(() => {
    createPendingChannelApproval({
      messaging_group_id: input.messagingGroupId,
      agent_group_id: target.id,
      original_message: JSON.stringify(input.event),
      approver_user_id: delivery.userId,
      approval_id: approvalId,
      title,
      options_json: JSON.stringify(APPROVAL_OPTIONS),
      created_at: new Date().toISOString(),
    });
    requestApproval({ approval_id: approvalId, action: 'channel-approval' /* + 4C-required fields */ });
  });
  tx();

  await delivery.deliver({
    type: 'ask_question',
    questionId: approvalId,
    title,
    question,
    options: APPROVAL_OPTIONS,
  });
}

export async function handleChannelApprovalResponse(payload: { approvalId: string; value: string; userId?: string }): Promise<boolean> {
  const row = getChannelApprovalByApprovalId(payload.approvalId);
  if (!row) return false;

  if (payload.value === APPROVE_VALUE) {
    const event = JSON.parse(row.original_message);
    const originMg = getMessagingGroup(row.messaging_group_id);
    const isGroup = originMg?.is_group === 1;

    // MVP wiring defaults
    createMessagingGroupAgent({
      messaging_group_id: row.messaging_group_id,
      agent_group_id: row.agent_group_id,
      engage_mode: isGroup ? 'mention-sticky' : 'pattern',
      engage_pattern: isGroup ? null : '.',
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
    });

    // Add the triggering sender as a member so sender_scope='known' doesn't
    // bounce the replayed event into a sender-approval cascade.
    const senderHandle = (event?.from?.handle ?? event?.message?.sender) as string | undefined;
    if (senderHandle && originMg) {
      addMember({
        user_id: `${originMg.channel_type}:${senderHandle}`,
        agent_group_id: row.agent_group_id,
        added_by: row.approver_user_id,
      });
    }

    await routeInbound(event);
  } else {
    setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
  }

  deletePendingChannelApproval(row.messaging_group_id);
  return true;
}
```

- [ ] **Step 3: Wire response handler**

```ts
import { handleChannelApprovalResponse } from './permissions/channel-approval.js';
registerApprovalHandler('channel-approval', handleChannelApprovalResponse);
```

- [ ] **Step 4: Wire `requestChannelApproval` into router**

In `src/router.ts`, add the unwired-channel branch BEFORE 4B's `canAccessAgentGroup` gate (since there's no agent group to access yet — the channel isn't wired):

```ts
const wirings = getWiringsForMessagingGroup(mg.id);
if (wirings.length === 0) {
  if (mg.denied_at) return;                              // owner already said no — silent drop
  const isMentionOrDm = !mg.is_group || /* mention check */ event.message?.mentionsBot;
  if (!isMentionOrDm) return;                            // unrelated message in unwired group chat
  await requestChannelApproval({ messagingGroupId: mg.id, event });
  return;
}
```

The "is bot mentioned" check uses v1-archive's existing mention-detection. For channels without a clear mention concept (email), `is_group=0` (DM-like) is sufficient.

- [ ] **Step 5: Tests**

`pending-channel-approvals.test.ts` — DB unit tests (CRUD, PK, setMessagingGroupDeniedAt).

`channel-approval.test.ts` — request flow:
- Happy path: pickApprover + pickApprovalDelivery succeed, INSERT succeeds, deliver called.
- Dedup: second call same messagingGroupId early-returns.
- No agent groups: warn + early-return (fresh install with no /init-first-agent yet).
- No approver / no DM: warn + early-return.

`channel-approval-response.test.ts` — response handler:
- Approve: createMessagingGroupAgent called with MVP defaults; addMember called; routeInbound called; row deleted; returns true.
- Deny: setMessagingGroupDeniedAt called; createMessagingGroupAgent NOT called; row deleted; returns true.
- Unknown approvalId: returns false.

Integration test in `src/__tests__/router-channel-approval.test.ts`:
- Unwired channel + mention: requestChannelApproval triggered.
- Unwired channel + non-mention group message: silent drop (no card).
- Unwired channel + denied_at set: silent drop (no card).
- Approve click: wiring created, sender added, message replayed.

- [ ] **Step 6: Run + commit**

```
cd /data/nanotars && npm test && npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat(permissions): add unknown-channel registration flow

Phase 4D: when a channel has no messaging_group_agents wiring AND a
message is a bot mention or DM AND messaging_groups.denied_at is
NULL, the router calls requestChannelApproval instead of silently
dropping.

On approve: handler creates a messaging_group_agents row with MVP
defaults (mention-sticky for groups, pattern='.' for DMs;
sender_scope='known'; ignored_message_policy='accumulate'); adds
the triggering sender as a member; replays the original event.

On deny: handler sets messaging_groups.denied_at to silence future
mentions on that channel until an admin manually re-wires.

PRIMARY KEY (messaging_group_id) on pending_channel_approvals gives
free in-flight dedup — second mention while pending is silently
dropped at the INSERT step.
EOF
)"
```

**Reviewer dispatch — cross-tier (DB + permissions + router branch + wiring side-effect on approve).**

---

## Task D4: pending_questions table + ask_user_question MCP tool

**Files:**
- New: `/data/nanotars/src/db/pending-questions.ts`
- New: `/data/nanotars/src/db/__tests__/pending-questions.test.ts`
- New: `/data/nanotars/src/modules/interactive/index.ts`
- New: `/data/nanotars/src/modules/interactive/__tests__/index.test.ts`
- Modify: `/data/nanotars/src/types.ts` (add `PendingQuestion`, `NormalizedOption` interfaces if not already present)
- Modify: `/data/nanotars/src/delivery.ts` (or wherever v1's outbound delivery lives — add the `createPendingQuestion` hook on `type: 'ask_question'` payloads)
- Modify: `/data/nanotars/src/index.ts` (register `handleInteractiveResponse` with the response-handler registry)
- New: `/data/nanotars/container/agent-runner/src/mcp-tools/ask-question.ts` (container-side MCP tool)
- Modify: `/data/nanotars/container/agent-runner/src/ipc-mcp-stdio.ts` (register the new MCP tool)
- New: `/data/nanotars/container/agent-runner/src/__tests__/ask-question.test.ts`

This is the cross-tier task: container-side schema (zod or matching MCP shape), host-side delivery hook, host-side response handler, host-side DB module. Mirror v2's `interactive.ts` (container) and `modules/interactive/index.ts` (host) for shape; the only structural change is v1-archive's per-group inbox/outbox model replaces v2's per-session `inbound.db`/`outbound.db`.

- [ ] **Step 1: Host-side DB module**

`/data/nanotars/src/db/pending-questions.ts`:

```ts
import { getDb } from './init.js';

export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
}

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options: NormalizedOption[];
  approval_id: string | null;
  created_at: string;
}

/** INSERT OR IGNORE so retries with the same question_id don't fail before the send step succeeds. */
export function createPendingQuestion(pq: PendingQuestion): boolean {
  const result = getDb()
    .prepare(`INSERT OR IGNORE INTO pending_questions (
      question_id, session_id, message_out_id, platform_id, channel_type,
      thread_id, title, options_json, approval_id, created_at
    ) VALUES (
      @question_id, @session_id, @message_out_id, @platform_id, @channel_type,
      @thread_id, @title, @options_json, @approval_id, @created_at
    )`)
    .run({
      ...pq,
      options_json: JSON.stringify(pq.options),
    });
  return result.changes > 0;
}

export function getPendingQuestion(questionId: string): PendingQuestion | undefined {
  const row = getDb().prepare(`SELECT * FROM pending_questions WHERE question_id = ?`).get(questionId) as
    | (Omit<PendingQuestion, 'options'> & { options_json: string })
    | undefined;
  if (!row) return undefined;
  const { options_json, ...rest } = row;
  return { ...rest, options: JSON.parse(options_json) };
}

export function deletePendingQuestion(questionId: string): void {
  getDb().prepare(`DELETE FROM pending_questions WHERE question_id = ?`).run(questionId);
}

export function listPendingQuestionsBySession(sessionId: string): PendingQuestion[] {
  return getDb().prepare(`SELECT * FROM pending_questions WHERE session_id = ?`).all(sessionId)
    .map((r: any) => ({ ...r, options: JSON.parse(r.options_json) }));
}
```

DB tests cover INSERT OR IGNORE retry semantics + CRUD + listPendingQuestionsBySession.

- [ ] **Step 2: Host-side delivery hook**

In v1's outbound delivery path (find via `grep -n 'writeMessage\|deliverMessage\|outbound' src/`), add:

```ts
// After preparing the outbound message, before/after dispatching:
let parsed: any;
try { parsed = JSON.parse(msg.content); } catch { /* not JSON; skip */ }
if (parsed?.type === 'ask_question' && parsed.questionId && hasTable(getDb(), 'pending_questions')) {
  createPendingQuestion({
    question_id: parsed.questionId,
    session_id: msg.session_id ?? msg.group_id, // adjust to v1's session/group identifier
    message_out_id: msg.id,
    platform_id: msg.platform_id ?? null,
    channel_type: msg.channel_type ?? null,
    thread_id: msg.thread_id ?? null,
    title: parsed.title ?? '',
    options: parsed.options ?? [],
    approval_id: parsed.approvalId ?? null,
    created_at: new Date().toISOString(),
  });
}
```

`hasTable` guard means a pre-018 DB doesn't crash on this path (v1-archive doesn't have a hasTable helper today; add one in `src/db/init.ts` if missing — `db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined`).

- [ ] **Step 3: Host-side interactive response handler**

`/data/nanotars/src/modules/interactive/index.ts`:

```ts
import { getDb, hasTable } from '../../db/init.js';
import { getPendingQuestion, deletePendingQuestion } from '../../db/pending-questions.js';
import { writeMessageToGroup, wakeContainer } from '../../orchestrator.js'; // adjust to v1 names
import { logger } from '../../logger.js';

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId?: string;
}

export async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'pending_questions')) return false;

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return false;

  // Write a system message into the agent's inbox so the polling loop wakes
  // up and the container-side ask_user_question call returns the response.
  await writeMessageToGroup(pq.session_id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platform_id: pq.platform_id,
    channel_type: pq.channel_type,
    thread_id: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: payload.questionId,
      selectedOption: payload.value,
      userId: payload.userId ?? '',
    }),
  });

  deletePendingQuestion(payload.questionId);
  await wakeContainer(pq.session_id);
  logger.info({ questionId: payload.questionId, selectedOption: payload.value }, 'Question response routed');
  return true;
}
```

Tests in `__tests__/index.test.ts`:
- Missing table returns false.
- Unknown questionId returns false (lets other handlers try).
- Hit: writeMessageToGroup called with correct shape; deletePendingQuestion called; wakeContainer called; returns true.

- [ ] **Step 4: Register interactive handler ahead of approval handler**

In `src/index.ts`, register the interactive handler with the host's response-handler registry. Order matters: the interactive handler runs first, claims questionIds it owns (plain ask_user_question calls with no approval_id), and lets unhandled ones fall through to 4C's approval registry.

```ts
import { handleInteractiveResponse } from './modules/interactive/index.js';
registerResponseHandler(handleInteractiveResponse);   // runs first
// 4C's approval-action dispatcher runs second (already wired)
```

The exact registry name + order semantics depend on what 4C ships. If 4C uses a single combined registry, register interactive there with a higher priority. Mirror v2's `response-handler.ts:24-43` ordering.

- [ ] **Step 5: Container-side MCP tool**

`/data/nanotars/container/agent-runner/src/mcp-tools/ask-question.ts`:

Mirror v2's `interactive.ts` `askUserQuestion` definition, but adapted to v1-archive's MCP plumbing in `ipc-mcp-stdio.ts`.

```ts
import { z } from 'zod';
// import v1-archive's outbox-write + inbox-poll helpers (existing)

export const askUserQuestionInput = z.object({
  title: z.string(),
  question: z.string(),
  options: z.array(
    z.union([
      z.string(),
      z.object({
        label: z.string(),
        selectedLabel: z.string().optional(),
        value: z.string().optional(),
      }),
    ]),
  ),
  timeout: z.number().optional(),  // seconds, default 300
});

export async function askUserQuestion(input: z.infer<typeof askUserQuestionInput>): Promise<string> {
  const timeoutMs = (input.timeout ?? 300) * 1000;
  const options = input.options.map((o) => {
    if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
    return { label: o.label, selectedLabel: o.selectedLabel ?? o.label, value: o.value ?? o.label };
  });
  const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Write a chat-sdk outbound message via v1-archive's existing outbox path
  await writeOutboundMessage({
    id: questionId,
    kind: 'chat-sdk',
    content: JSON.stringify({ type: 'ask_question', questionId, title: input.title, question: input.question, options }),
    // ...platform routing fields
  });

  // Poll the inbox for a question_response system message
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findQuestionResponse(questionId);
    if (response) {
      const parsed = JSON.parse(response.content);
      markResponseConsumed(response.id);
      return parsed.selectedOption;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Question ${questionId} timed out after ${timeoutMs / 1000}s`);
}
```

Register the tool in `ipc-mcp-stdio.ts` alongside the existing tools (mirror the registration pattern v1-archive already uses).

Container tests in `container/agent-runner/src/__tests__/ask-question.test.ts`:
- Happy path: write outbound, simulate inbound `question_response`, return selectedOption.
- Timeout: throws after the configured timeout.
- Multiple options: zod parses both string and object option shapes.

**Use v1-archive's container test runtime** (vitest if v1-archive container is Node-based; bun:test if it's Bun. Pre-flight Step 5 confirmed which.)

- [ ] **Step 6: Run host + container tests + typecheck**

```
cd /data/nanotars && npm test && npm run typecheck
cd /data/nanotars/container/agent-runner && npm test  # OR bun test
```

- [ ] **Step 7: Commit**

```
git add src/db/pending-questions.ts src/db/__tests__/pending-questions.test.ts src/modules/interactive src/types.ts src/delivery.ts src/index.ts container/agent-runner/src/mcp-tools/ask-question.ts container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/__tests__/ask-question.test.ts
git commit -m "$(cat <<'EOF'
feat(interactive): add ask_user_question MCP tool + pending_questions

Phase 4D: introduces a generic interactive-question primitive. The
agent calls ask_user_question with title + question + options;
container writes a chat-sdk card to the outbox and polls the inbox
for a question_response system message. Host-side delivery binds
the card to a session via pending_questions; click responses route
back through the response-handler registry, ahead of 4C's approval
action dispatcher.

INSERT OR IGNORE on pending_questions.question_id makes retries
idempotent so a delivery failure followed by an agent retry doesn't
collide on UNIQUE before the send step.

Container schema is a zod input schema in
mcp-tools/ask-question.ts; host-side handler in
modules/interactive/index.ts.
EOF
)"
```

**Reviewer dispatch — cross-tier (container schema + host delivery + host registry + DB).**

---

## Task D5: In-flight dedup integration tests

**Files:**
- New: `/data/nanotars/src/__tests__/dedup-pending-tables.test.ts`

D2/D3/D4 already cover dedup at the unit level via the DB module tests + request-flow tests. D5 adds end-to-end integration tests that assert dedup holds across the full request → INSERT → second request → silent return path, for all three tables.

- [ ] **Step 1: Test cases**

```ts
describe('Phase 4D in-flight dedup', () => {
  it('pending_sender_approvals dedups on (messaging_group_id, sender_identity)', async () => {
    // Seed: a wired channel with sender_scope='known' + unknown_sender_policy='request_approval'
    // Set up an owner + reachable DM
    // Mock the delivery adapter to count calls
    // Send two events from the same unknown sender
    // Assert: ONE pending_sender_approvals row, ONE delivery call, second send logs "dropping retry"
  });

  it('pending_channel_approvals dedups on messaging_group_id', async () => {
    // Seed: an unwired channel
    // Send two bot-mention events from the same channel
    // Assert: ONE pending_channel_approvals row, ONE delivery call, second send logs "dropping retry"
  });

  it('pending_questions tolerates retries on the same question_id', () => {
    // Call createPendingQuestion twice with the same question_id
    // Assert: first returns true, second returns false, only ONE row exists
  });
});
```

- [ ] **Step 2: Run + commit**

```
cd /data/nanotars && npm test && npm run typecheck
git add src/__tests__/dedup-pending-tables.test.ts
git commit -m "$(cat <<'EOF'
test(permissions): in-flight dedup across all three pending tables

Phase 4D: end-to-end tests that verify the PRIMARY KEY / UNIQUE
constraints on pending_sender_approvals, pending_channel_approvals,
and pending_questions actually drop retries silently instead of
generating duplicate cards. Asserts exactly one delivery call per
unique key.
EOF
)"
```

**No reviewer dispatch — additive integration tests, no behavior change.**

---

## Task D6: Integration with 4C's pending_approvals (unified card-expiry sweep)

**Files:**
- New: `/data/nanotars/src/__tests__/card-expiry-integration.test.ts`
- Possibly modify: `/data/nanotars/src/permissions/sender-approval.ts` and `channel-approval.ts` if 4C's `requestApproval` signature differs from this plan's assumptions

The pending-* rows in 4D each carry an `approval_id` foreign key to `pending_approvals`. 4C's central card-expiry sweep iterates `pending_approvals` rows, edits delivered cards to "Expired" past TTL, and deletes the rows. D6 verifies that:
- 4D's request flows write BOTH a pending_sender_approvals (or pending_channel_approvals) row AND a pending_approvals row in the same transaction.
- When the 4C sweep expires a paired pending_approvals row, the corresponding 4D row also gets cleaned up (either by the sweep itself extending the cleanup to the 4D row, or by a 4D-side stale-row sweep that joins on `approval_id IS NOT NULL AND approval_id NOT IN (SELECT approval_id FROM pending_approvals)`).
- The post-click "edit-to-selected-state" render reads `title` + `options_json` from the 4D row (the v2 migration 013 motivation — render metadata co-located with the pending row to prevent drift).

- [ ] **Step 1: Read 4C's plan to confirm sweep behavior**

```
cat /data/nanotars/docs/superpowers/plans/2026-04-25-phase-4c-*.md | grep -A 20 -iE 'sweep|expir'
```

If 4C's sweep already scans `pending_approvals`-with-foreign-keys correctly, D6 only adds a verification test. If 4C's sweep doesn't yet handle the 4D rows (because 4D didn't exist when 4C was written), D6 adds the cleanup join — likely a few lines in `pickApprovalDelivery`'s sweep companion in `src/permissions/approvals/primitive.ts` or wherever 4C parks the sweep.

- [ ] **Step 2: Verify atomic two-row write**

Test that `requestSenderApproval` and `requestChannelApproval` each write both rows under a transaction (started from `getDb().transaction(...)`). Use a forced failure (mock `requestApproval` to throw) and assert the pending-* row also rolled back — no orphan 4D row without a paired 4C row.

- [ ] **Step 3: Verify expiry sweep covers 4D rows**

Test:
- Seed a pending_sender_approvals row + paired pending_approvals row with `expires_at` in the past.
- Run the 4C sweep (whatever its exported entry point is).
- Assert: pending_approvals row marked expired (per 4C's contract); pending_sender_approvals row also gone (or, if the sweep just expires 4C and a sibling 4D-side sweep cleans up 4D, run that too).

If 4C's sweep doesn't yet clean up 4D rows, add a small companion sweep to D6:

```ts
// src/permissions/sweep.ts (new) or extension of 4C's sweep
export function sweepStaleSenderApprovals(): void {
  getDb().exec(`
    DELETE FROM pending_sender_approvals
    WHERE approval_id IS NOT NULL
      AND approval_id NOT IN (SELECT approval_id FROM pending_approvals)
  `);
}
export function sweepStaleChannelApprovals(): void {
  getDb().exec(`
    DELETE FROM pending_channel_approvals
    WHERE approval_id IS NOT NULL
      AND approval_id NOT IN (SELECT approval_id FROM pending_approvals)
  `);
}
```

Wire these alongside the 4C sweep tick.

- [ ] **Step 4: Verify render metadata is read from the 4D row**

The post-click render (the click handler editing the original card to "✅ Allowed" / "❌ Denied" / "✅ Wired" / "🙅 Ignored") reads `title` + `options_json` from the pending-* row at handle time, not from a hardcoded constant. Test: mutate the row's `title` to a sentinel between create and click; assert the post-click edit uses the sentinel.

- [ ] **Step 5: Run + commit**

```
cd /data/nanotars && npm test && npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat(permissions): integrate 4D pending tables with 4C card-expiry sweep

Phase 4D: each requestSenderApproval / requestChannelApproval call
now writes the 4D pending row + paired pending_approvals row in a
single transaction, so the rows can't drift out of sync. The 4C
central card-expiry sweep extends to clean up 4D rows whose paired
pending_approvals row is gone (orphan-cleanup join on approval_id).

Render metadata (title + options_json) is persisted on the 4D row
and read at click time — fixes the post-click edit drift v2 hit
(see v2 migration 013 commentary).
EOF
)"
```

**Reviewer dispatch — touches 4C primitive surface (the sweep). Verify no regression in 4C-only tests.**

---

## Task D7: Final phase review

After D1-D6 land, dispatch the final phase reviewer.

**Reviewer prompt:**

```
Final review of Phase 4D on /data/nanotars v1-archive. HEAD started at
<phase-4c-final-commit-sha>; current HEAD is <new-SHA>. Review:

git log <phase-4c-final-commit-sha>..HEAD --oneline

Verify:
1. Spec compliance against
   docs/superpowers/specs/2026-04-25-phase-4d-multi-user-flows-design.md
2. Migrations 016-018 idempotent and order-correct; 017's denied_at
   ALTER is PRAGMA-guarded
3. PK / UNIQUE constraints on all three pending tables enforced and
   exercised by tests
4. Sender-approval flow: request happy path + 3 failure modes +
   dedup; response handler approve adds member + replays; deny
   just deletes
5. Channel-approval flow: request happy path + 4 failure modes +
   dedup; response handler approve creates wiring + adds sender +
   replays; deny sets denied_at
6. ask_user_question MCP tool: container schema (zod) + host
   delivery hook + host response handler + register order
   (interactive ahead of 4C action dispatcher)
7. pending-* rows write paired pending_approvals row in a
   transaction; sweep cleans up orphans
8. Render metadata (title + options_json) persisted on pending-*
   rows and used by post-click edit
9. Router branches: sender-scope failure with policy=request_approval
   triggers requestSenderApproval; unwired-channel + bot-mention +
   denied_at IS NULL triggers requestChannelApproval
10. Tests adequate for each new module; container test uses the
    correct test runtime (vitest or bun:test per v1-archive)

Out of scope: Phase 5 (capability bolt-ons), Phase 6 (per-session
containers), Phase 7 (cross-container messaging).

Report: Critical / High / Medium / Low / Nit with file:line.
End with PHASE 4D APPROVED or PHASE 4D NEEDS FIXES.
```

---

## Self-review checklist

- [x] Spec coverage: all 4D sections (three tables, two request/respond modules, ask_question MCP tool, dedup, integration with 4C) map to tasks D1-D6.
- [x] Migration policy applied to all 3 new migrations (016-018), with createSchema + numbered MIGRATIONS entry sharing DDL via constants.
- [x] Reviewer dispatch on D1 (schema), D2 (cross-tier router branch + permissions module + handler registry), D3 (cross-tier router branch + wiring side-effect), D4 (cross-tier container schema + host delivery hook + host registry), D6 (touches 4C surface). Mechanical: D5.
- [x] npm-not-pnpm warnings present.
- [x] Container test runtime confirmed in pre-flight Step 5; D4 task references it explicitly.
- [x] Phase 4B (RBAC) + Phase 4C (approval primitive) listed as hard preconditions in pre-flight Step 1; D2/D3/D4 wire against 4C's `pickApprover` / `pickApprovalDelivery` / `requestApproval` / `registerApprovalHandler` exports without redesigning them.
- [x] In-flight dedup is the central spec invariant; tested at the unit level (D2/D3/D4) AND end-to-end (D5).
- [x] Render-metadata-on-row design (v2 migration 013 motivation) is shipped in D1 columns directly — no follow-up ALTER migration.
- [x] `messaging_groups.denied_at` handled idempotently in migration 017 (works whether 4A added it or not).
