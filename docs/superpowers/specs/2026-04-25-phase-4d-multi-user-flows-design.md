# Phase 4D: Multi-user user-facing flows — Design

**Status:** Approved 2026-04-25 (per Phase 4 brainstorm: full multi-user adoption under technical-merit lens; the v2 sender/channel approval cards + ask_question infrastructure are the only places the RBAC + approval-primitive plumbing surfaces to humans).

## Goal

Layer v2's three user-facing approval flows on top of the Phase 4B (`users` + `user_roles` + `agent_group_members` + `user_dms`) and Phase 4C (`pending_approvals` + `requestApproval` + `pickApprover` + `pickApprovalDelivery`) foundations. Adds three new tables (`pending_sender_approvals`, `pending_channel_approvals`, `pending_questions`), the request/respond modules in `src/permissions/sender-approval.ts` + `src/permissions/channel-approval.ts`, and the generic `ask_question` MCP tool (container schema + host-side response handler). All four interactions (unknown sender, unknown channel, agent-asked question, admin-credential approval) deliver a uniform Approve/Deny / multi-choice card via the same `pickApprover → pickApprovalDelivery → ask_question` rail; click responses dispatch through 4C's response-handler registry.

## Scope decisions (locked)

These follow from the Phase 4 brainstorm and the parallel Phase 4C design:

1. **Three new tables, all PK-deduped.** Each pending-something table uses its primary key as the in-flight dedup gate (mirroring v2). A second message from the same unknown sender / second mention on the same unwired channel / second `ask_question` with a colliding id is silently dropped (or collapsed) instead of generating duplicate cards. Schema:
   - `pending_sender_approvals` PK `(messaging_group_id, sender_identity)` (v2's exact UNIQUE; we promote it to PK on a synthesized id+UNIQUE pair, see Schema below)
   - `pending_channel_approvals` PK `(messaging_group_id)` — one card per unwired channel max
   - `pending_questions` PK `(question_id)` — caller-supplied id; `INSERT OR IGNORE` on retry

2. **`pending_questions` ports standalone with the `ask_question` MCP tool.** The triage's Area 2 question 3 ("does pending_questions port standalone with ask_question?") resolves YES — it has solo value (the agent can interactively confirm before deploying / deleting / sending). v1 has no equivalent today; this is a net new capability, not a multi-user-only payoff.

3. **Channel-approval `denied_at` lives on `messaging_groups`, not on the pending row.** v2 stores the denied-forever marker on `messaging_groups.denied_at` (added by v2 migration 012 via `ALTER TABLE ADD COLUMN`). When the owner clicks Ignore on a channel-registration card, the pending row is deleted AND `messaging_groups.denied_at = now()` is set. Future messages on that channel drop silently in the router without re-escalating. Re-wiring requires a manual admin command (4D doesn't ship that; it's a future operational helper).

4. **No `unregistered_senders` counter.** The triage flagged this as a diagnostic-only counter. Skipped from 4D — adding it changes nothing about the user-visible flow and the request-approval path already logs every unknown-sender event.

5. **Integration with 4C's `pending_approvals` is the central card-expiry sweep.** Each new pending-* row also writes a corresponding `pending_approvals` row keyed by the same approval id, so 4C's unified card-expiry sweep + edit-to-Expired-on-startup logic also expires sender / channel / question cards. Without this hook each new flow would need its own sweep; with it the card-expiry behavior is uniform across the four flows. (4C ships the sweep; 4D writes the rows.)

6. **Approval-card render metadata persisted on the pending rows.** v2's migration 013 added `title TEXT NOT NULL DEFAULT ''` + `options_json TEXT NOT NULL DEFAULT '[]'` to `pending_sender_approvals` and `pending_channel_approvals` so the post-click "edit-to-selected-state" render reads the same title/options the original card showed (no drift). 4D ships these columns directly in migrations 016/017 — no need for a follow-up ALTER TABLE migration.

7. **Migration policy still applies.** Each new table gets DDL in `createSchema` AND a numbered MIGRATIONS entry. Phase 4A's policy doc in CLAUDE.md governs.

8. **`ask_question` MCP tool name.** v2 calls the container-side tool `ask_user_question` (its display name in `interactive.ts`); the corresponding chat-sdk-bridge card type is `ask_question`. v1-archive will use `ask_user_question` as the MCP tool name (matching v2's name) and `ask_question` as the wire-format card type. The infrastructure name "ask_question MCP tool" in the triage refers to the same thing — these are the same primitive.

## Schema

Three new tables, sequenced after the Phase 4B + 4C tables. Migration numbering picks up at `016` (Phase 4B uses 010-014, Phase 4C uses 015).

```sql
-- Pending unknown-sender approvals.
-- One card per (messaging_group, unknown sender) at a time. UNIQUE on the
-- pair gives free in-flight dedup: a retry / second message from the same
-- unknown sender while a card is pending is silently dropped at the
-- INSERT step instead of spamming the admin.
--
-- approval_id mirrors pending_approvals.approval_id (4C primitive's row); the
-- two rows are written in the same flow so the central card-expiry sweep
-- can edit-to-Expired both atomically.
--
-- title + options_json persist render metadata so the post-click
-- "edit to selected state" renders the same title and option labels the
-- original card showed (no drift).
CREATE TABLE pending_sender_approvals (
  id                   TEXT PRIMARY KEY,            -- nsa-<ts>-<rand>
  messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity      TEXT NOT NULL,               -- namespaced user id (channel_type:handle)
  sender_name          TEXT,
  original_message     TEXT NOT NULL,               -- JSON-serialized inbound event
  approver_user_id     TEXT NOT NULL REFERENCES users(id),
  approval_id          TEXT REFERENCES pending_approvals(approval_id),
  title                TEXT NOT NULL DEFAULT '',
  options_json         TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
CREATE INDEX idx_pending_sender_approvals_mg
  ON pending_sender_approvals(messaging_group_id);

-- Pending unknown-channel registration approvals.
-- PK on messaging_group_id gives free in-flight dedup: at most one card per
-- unwired channel at a time. A second mention or DM while pending is
-- silently dropped (INSERT OR IGNORE).
--
-- agent_group_id is the wiring target chosen at request time (MVP: first
-- agent group by created_at; multi-agent picker is a follow-up).
--
-- On approve: handler creates messaging_group_agents row + adds sender to
-- agent_group_members + replays original_message. On deny: handler sets
-- messaging_groups.denied_at + deletes this row.
CREATE TABLE pending_channel_approvals (
  messaging_group_id   TEXT PRIMARY KEY REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  original_message     TEXT NOT NULL,               -- JSON-serialized inbound event
  approver_user_id     TEXT NOT NULL REFERENCES users(id),
  approval_id          TEXT REFERENCES pending_approvals(approval_id),
  title                TEXT NOT NULL DEFAULT '',
  options_json         TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL
);

-- Generic interactive-question state. Used by ask_user_question MCP tool
-- to bind a card (delivered as messages_out) to a specific session so the
-- click response routes back to the right place.
--
-- v1-archive lacks v2's per-session inbound.db / outbound.db split — instead,
-- session_id is a logical id (the v1 group identifier), message_out_id is
-- the corresponding outbound message id from the existing v1 outbox path,
-- and (channel_type, platform_id, thread_id) is the address the click
-- response will arrive on. The host's response handler looks up the
-- pending_questions row, writes a 'question_response' system message into
-- the agent's inbox, wakes the per-group container, and deletes the row.
--
-- INSERT OR IGNORE on (question_id) makes ask_user_question retries
-- idempotent: if the first delivery attempt failed and the agent retries
-- with the same question_id, the second insert is a no-op + the actual
-- send still proceeds.
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,                     -- logical session/group id
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

Schema notes:
- `denied_at` on `messaging_groups` was added by Phase 4A's spec (the column exists; 4D consumers it). If 4A omitted it (verify on B1), 4D's migration 017 also adds the column via `ALTER TABLE ADD COLUMN`. Mirror v2 migration 012's idempotent guard (`PRAGMA table_info` then conditional `ALTER`).
- `approval_id` is nullable on all three tables to keep tests with no `pending_approvals` row simple. The 4D request flow writes both rows in the same transaction; the column is informational. The unified expire-sweep in 4C joins by approval_id.
- `pending_questions.session_id` is `TEXT NOT NULL` even though v1-archive has no `sessions` table — this is the v1 group/session identifier (whatever the per-group container model uses today). The constraint stays NOT NULL for forward-compat with Phase 6's eventual sessions table; populating it is the caller's responsibility.

## Functions / modules

Three new modules under `src/permissions/` (joining the 4B set), one new module under `src/modules/interactive/`, and additions to the container-side MCP tools.

### `src/permissions/sender-approval.ts` (new)

```ts
export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string;          // namespaced "<channel>:<handle>"
  senderName: string | null;
  event: InboundEvent;             // JSON-serialized into original_message
}

export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<void>;

// Response-handler registered with 4C's registerApprovalHandler('sender-approval', ...):
//   - On approve: addMember({ user_id, agent_group_id, added_by: approver })
//                 + replay original_message via routeInbound
//                 + delete pending_sender_approvals + pending_approvals rows
//   - On deny:    delete pending_sender_approvals + pending_approvals rows
export const APPROVE_VALUE = 'approve';
export const REJECT_VALUE = 'reject';
```

### `src/permissions/channel-approval.ts` (new)

```ts
export interface RequestChannelApprovalInput {
  messagingGroupId: string;
  event: InboundEvent;
}

export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<void>;

// Response-handler registered with 4C's registerApprovalHandler('channel-approval', ...):
//   - On approve: createMessagingGroupAgent({
//                   messaging_group_id, agent_group_id,
//                   engage_mode: isGroup ? 'mention-sticky' : 'pattern',
//                   engage_pattern: isGroup ? null : '.',
//                   sender_scope: 'known',
//                   ignored_message_policy: 'accumulate',
//                 })
//                 + addMember({ user_id: extractedSender, agent_group_id })
//                 + replay original_message via routeInbound
//                 + delete pending_channel_approvals + pending_approvals rows
//   - On deny:    UPDATE messaging_groups SET denied_at = now() WHERE id = ?
//                 + delete pending_channel_approvals + pending_approvals rows
```

### `src/permissions/db/pending-sender-approvals.ts` (new)

```ts
export interface PendingSenderApproval { /* matches schema */ }

export function createPendingSenderApproval(row: PendingSenderApproval): boolean;
export function getPendingSenderApproval(id: string): PendingSenderApproval | undefined;
export function hasInFlightSenderApproval(messagingGroupId: string, senderIdentity: string): boolean;
export function deletePendingSenderApproval(id: string): void;
export function getSenderApprovalByApprovalId(approvalId: string): PendingSenderApproval | undefined;
```

`createPendingSenderApproval` uses `INSERT OR IGNORE` so the request flow is safe to re-enter; `hasInFlightSenderApproval` is the explicit pre-check used by `requestSenderApproval` to log a "dropping retry" debug line before the INSERT.

### `src/permissions/db/pending-channel-approvals.ts` (new)

```ts
export interface PendingChannelApproval { /* matches schema */ }

export function createPendingChannelApproval(row: PendingChannelApproval): boolean;
export function getPendingChannelApproval(messagingGroupId: string): PendingChannelApproval | undefined;
export function hasInFlightChannelApproval(messagingGroupId: string): boolean;
export function deletePendingChannelApproval(messagingGroupId: string): void;
export function getChannelApprovalByApprovalId(approvalId: string): PendingChannelApproval | undefined;
export function setMessagingGroupDeniedAt(messagingGroupId: string, deniedAt: string): void;
```

### `src/db/pending-questions.ts` (new — central DB module)

```ts
export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options: NormalizedOption[];     // JSON-decoded from options_json
  approval_id: string | null;
  created_at: string;
}

export function createPendingQuestion(pq: PendingQuestion): boolean;  // INSERT OR IGNORE
export function getPendingQuestion(questionId: string): PendingQuestion | undefined;
export function deletePendingQuestion(questionId: string): void;
export function listPendingQuestionsBySession(sessionId: string): PendingQuestion[];
```

### `src/modules/interactive/index.ts` (new)

Host-side handler for question-card click responses. Registers with 4C's response-handler registry. Looks up the pending_questions row, writes a `question_response` system message into the agent's inbox (using v1-archive's existing per-group inbox writer — `writeMessageToGroup` or equivalent), wakes the container, deletes the pending_questions row.

```ts
async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean>;
//   - If pending_questions table is missing (4D not migrated): return false
//   - If question_id not found: return false (let other handlers try)
//   - On hit: write question_response system message + wakeContainer + delete row + return true
```

### Container side — `container/agent-runner/src/mcp-tools/ask-question.ts` (new) + `ipc-mcp-stdio.ts` plumbing

Container-side `ask_user_question` MCP tool. Inputs: `title`, `question`, `options` (array of strings or `{label, selectedLabel?, value?}`). Behavior: write a `chat-sdk` outbound message with content `{type:'ask_question', questionId, title, question, options}`; poll the inbox for a `question_response` system message matching `questionId`; return `selectedOption`. Timeout default 300s.

The wire-format payload + polling shape mirror v2's `ask_user_question` in `interactive.ts`. The mechanical difference for v1-archive: it writes via the existing per-group outbox path (`writeMessageOut` or whatever v1's outbox API is) rather than v2's per-session `outbound.db`. Polling reads from the per-group inbox the same way the existing inbound poll loop does.

The container schema is a zod schema (or matching JSON schema, depending on v1-archive's MCP shape). The host-side delivery path needs a one-line plumbing change: when an outbound message has content `type:'ask_question'`, also call `createPendingQuestion(...)` to bind the card to the session before delivering. v2 does this in `delivery.ts:317-330`; v1 mirrors it.

## Wiring

### Router changes (sender-scope failure → request_approval branch)

Phase 4B wired the sender-scope gate (`if sender_scope='known' && !isMember(...) drop`). Phase 4D extends that drop branch: instead of silently dropping, when `messaging_groups.unknown_sender_policy = 'request_approval'` AND the sender isn't a member, call `requestSenderApproval(...)` instead of `continue`. Sketch:

```ts
// In router/orchestrator routing path (where 4B's sender-scope gate lives):
const userId = resolveSender({ channel, platform_id, sender_handle, sender_name });
for (const { agentGroup, wiring, messagingGroup } of resolved) {
  if (!canAccessAgentGroup(userId, agentGroup.id).allowed) continue;
  if (wiring.sender_scope === 'known' && !isMember(userId, agentGroup.id)) {
    if (messagingGroup.unknown_sender_policy === 'request_approval') {
      await requestSenderApproval({
        messagingGroupId: messagingGroup.id,
        agentGroupId: agentGroup.id,
        senderIdentity: userId,
        senderName: ...,
        event,
      });
    }
    continue;
  }
  // ... dispatch
}
```

### Router changes (unwired channel + bot mention → request_approval branch)

When the router resolves an inbound message and finds NO `messaging_group_agents` rows for the messaging group, AND the message was a mention of the bot or a DM, AND `messaging_groups.denied_at IS NULL`, call `requestChannelApproval(...)` and return. Sketch:

```ts
// In router (where v1 currently silently drops unwired-chat messages):
const wirings = getWiringsForMessagingGroup(mg.id);
if (wirings.length === 0) {
  if (mg.denied_at) return;                           // owner already said no
  const isMentionOrDm = !mg.is_group || event.message?.mentionsBot;
  if (!isMentionOrDm) return;
  await requestChannelApproval({ messagingGroupId: mg.id, event });
  return;
}
```

The "is this a bot mention" check uses whatever v1-archive has today (Telegram's mention parsing, Discord's mention markers, etc.). Channels without a clear mention concept (email) just check `is_group=0` (DM-like) and skip the mention fork.

### Delivery changes (`createPendingQuestion` hook)

In v1's existing outbound delivery path (e.g. `delivery.ts` or wherever `writeMessageOut` then sends to the channel adapter), inspect the outbound payload: if `content.type === 'ask_question'` AND the `pending_questions` table exists, also call `createPendingQuestion(...)` before dispatching. Mirror v2's pattern (guard with `hasTable(...)` so a fresh DB before migration 018 ran doesn't crash).

### Response handler registration

Three registrations land in `src/index.ts` (or wherever 4C registered its OneCLI handler):

```ts
import { registerApprovalHandler } from './permissions/index.js';   // 4C primitive
import { handleSenderApprovalResponse } from './permissions/sender-approval.js';
import { handleChannelApprovalResponse } from './permissions/channel-approval.js';
import { handleInteractiveResponse } from './modules/interactive/index.js';

registerApprovalHandler('sender-approval', handleSenderApprovalResponse);
registerApprovalHandler('channel-approval', handleChannelApprovalResponse);
registerResponseHandler(handleInteractiveResponse);   // for plain ask_question (no approval row)
```

Note the asymmetry: sender / channel approvals route through 4C's `registerApprovalHandler('action', handler)` registry (because each writes a `pending_approvals` row with `action='sender-approval'` / `'channel-approval'`); plain `ask_question` calls (where the agent just wants user input, no approval semantics) route through a sibling `registerResponseHandler` callback that runs first, claims the questionId if it owns it, and lets unhandled ones fall through to the approval registry. Order: interactive handler → 4C action dispatcher → OneCLI handler. v2's `response-handler.ts:24-43` shows the dispatch order.

## In-flight dedup tests (D5)

Each pending-* table's PK / UNIQUE provides dedup. Tests:

- `pending_sender_approvals`: two `requestSenderApproval` calls with the same `(messagingGroupId, senderIdentity)` produce ONE row. The second call's `hasInFlightSenderApproval` returns true; `requestSenderApproval` early-returns without writing or sending a card. (Two separate retries simulated end-to-end.)
- `pending_channel_approvals`: two `requestChannelApproval` calls with the same `messagingGroupId` produce ONE row. Same shape as sender flow.
- `pending_questions`: `createPendingQuestion` called twice with the same `question_id` returns `true` then `false` (changes count). The agent-runner side keeps polling on the same questionId.

## Tests

Per-module unit tests:

- `permissions/__tests__/sender-approval.test.ts` — request flow (happy path: pickApprover + pickApprovalDelivery + create row + deliver card); failure modes (no approver / no DM / no delivery adapter); dedup (second call short-circuits).
- `permissions/__tests__/channel-approval.test.ts` — request flow; agent-group selection (MVP: first by created_at); failure modes; dedup; `denied_at` short-circuit.
- `permissions/__tests__/sender-approval-response.test.ts` — approve adds member + replays event; deny just deletes rows.
- `permissions/__tests__/channel-approval-response.test.ts` — approve creates wiring + adds member + replays; deny sets denied_at + deletes.
- `permissions/db/__tests__/pending-sender-approvals.test.ts` — CRUD + UNIQUE constraint.
- `permissions/db/__tests__/pending-channel-approvals.test.ts` — CRUD + PK constraint + setMessagingGroupDeniedAt.
- `db/__tests__/pending-questions.test.ts` — CRUD + INSERT OR IGNORE retry semantics.
- `modules/interactive/__tests__/index.test.ts` — handler claims known questionIds; missing table returns false; missing row returns false (lets others try).
- Container: `container/agent-runner/src/__tests__/ask-question.test.ts` — write outbound + poll for response + return selectedOption + timeout. **Uses bun:test, not vitest.**

Migration tests (one combined file `src/__tests__/migration-016-018.test.ts`):
- Run all three on a Phase-4C-shaped DB; assert tables exist with the right columns / PK / UNIQUE.
- Idempotency: re-run; no error, no duplicate rows.
- `denied_at` column added to `messaging_groups` if absent (017's idempotent ALTER guard).

Integration tests in `src/__tests__/router-approval-flows.test.ts`:
- Unknown sender + `unknown_sender_policy='request_approval'` triggers a card to the owner. On approve click, the original message is processed (member added, dispatched).
- Unknown sender + `unknown_sender_policy='strict'` (default per Phase 4A) drops silently.
- Unwired channel + bot mention triggers a channel-approval card. On approve, wiring is created, sender added, message replayed.
- Unwired channel + bot mention + `denied_at != NULL` drops silently.
- ask_user_question round-trip: container writes outbound, host creates pending_questions, response click writes question_response into the inbox, container's polling loop returns the selected option.

## Effort

Triage estimates 4D at ~2-3 weeks. Sub-tasks:

- D1: schemas + migrations 016-018 + migration tests
- D2: pending_sender_approvals module + sender-approval.ts + response handler + tests
- D3: pending_channel_approvals module + channel-approval.ts + response handler + tests
- D4: pending_questions table + ask_user_question MCP tool (container) + interactive response handler (host) + tests (host vitest + container bun:test)
- D5: in-flight dedup integration tests across all three tables
- D6: integration with 4C's pending_approvals (unified card-expiry sweep correctness)
- D7: final phase review

7 sub-tasks. Cross-tier on D2/D3 (router + orchestrator + channel adapter touch) and D4 (container schema + host delivery hook). Mechanical on D1, D5, D6.

## Out of scope (deferred to Phase 5+)

- Identity merging across channels (one human as both `tg:123` and `whatsapp:foo`) — possibly a future phase, not 4D.
- Multi-agent picker for channel-registration card (today: first agent group by created_at). Follow-up.
- Manual `/wire` / `/unwire` admin command for re-approving denied channels. Operational helper, not 4D.
- `unregistered_senders` diagnostic counter — skipped per scope decision 4.
- Self-modification approval flows (`install_packages`, `add_mcp_server`) — Phase 5; they reuse the same `pending_approvals` rail but the request side is a different module.
- Lifecycle pause/resume, provider abstraction, `create_agent` MCP tool — Phase 5.
- Per-session containers + two-DB IPC — Phase 6.
- Cross-container agent messaging, supportsThreads — Phase 7.
