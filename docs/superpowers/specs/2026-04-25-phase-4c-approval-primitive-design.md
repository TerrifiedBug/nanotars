# Phase 4C: Approval primitive + OneCLI bridge — Design

**Status:** Approved 2026-04-25 (per Phase 4 brainstorm: full multi-user RBAC + approval primitive adoption under technical-merit lens). Builds directly on Phase 4B's `pickApprover`-eligible role model. Phase 3's OneCLI gateway port left the manual-approval bridge explicitly deferred to this phase.

## Goal

Land the reusable approval primitive (`pending_approvals` table + `requestApproval` + handler registry + `pickApprover` / `pickApprovalDelivery` hierarchical resolution + click-auth on approval cards + card-expiry sweep) on v1-archive, plus the OneCLI manual-approval bridge that Phase 3 deferred. After 4C, any module on v1 can request admin approval for an action via a single function call; the OneCLI gateway can ask the host for human approval before releasing a credential.

## Scope decisions (locked)

These follow from the Phase 4 brainstorm and the master triage's Phase 4C section.

1. **Single approver per request.** v2's `requestApproval` picks ONE approver (the first reachable in the hierarchical list), delivers the card to their DM, and waits for that one click. Not a quorum, not a broadcast. Same posture in 4C.

2. **Two-button cards only.** The approval primitive ships only Approve / Reject buttons. Three-or-more-button approval flows are not in scope; modules that want richer interactions use the future generic `pending_questions` flow (Phase 4D).

3. **Approver hierarchy.** `pickApprover(agent_group_id)` walks `user_roles` in this order, deduping:
   - Scoped admins for that agent group (`role='admin'`, `agent_group_id=<arg>`)
   - Global admins (`role='admin'`, `agent_group_id IS NULL`)
   - Owners (`role='owner'`, `agent_group_id IS NULL`)
   Same-channel-kind tie-break in `pickApprovalDelivery`: prefer approvers reachable on the same channel as the origin; else first in list.

4. **Click-auth is non-negotiable.** Every approval-card click handler in Phase 4C MUST verify clicker = approver OR clicker has admin privilege over the agent group, and silently consume on failure. v2's pattern (return `true` to claim the click without acting) is preserved — a stolen / forwarded card silently does nothing rather than logging-and-bouncing.

5. **OneCLI bridge bundles with primitive.** Phase 3's OneCLI gateway port deliberately deferred `configureManualApproval`. 4C wires it. The bridge depends on `pickApprover` + `pickApprovalDelivery` (4B) AND on a `delivery` adapter capable of `chat-sdk` `ask_question` cards. v1 currently has no `ask_question` infrastructure; 4C adds the minimal-viable card-delivery surface needed by the primitive (text + 2 buttons via channel adapters that support it).

6. **Card-delivery surface.** v1 doesn't have v2's full Chat SDK bridge. For 4C, define a narrow `ChannelDeliveryAdapter` interface (`deliver(channel_type, platform_id, thread_id, kind, content)`) modeled on v2's. v1's existing per-channel adapters (Telegram, etc.) gain a `deliver` method that handles the `ask_question` content payload at minimum. Channels without button support fall back to text-only and accept a free-text reply (handled in Phase 4D).

7. **Migration policy still applies.** Every new table gets DDL in `createSchema` AND a numbered MIGRATIONS entry. Phase 4A's policy doc in CLAUDE.md governs.

8. **No `pending_questions` / `ask_question` MCP tool.** Those are Phase 4D — generic agent-asks-user question flows. 4C only ships approval-specific cards (admin-asks-admin), even though the underlying delivery payload shape is the same `ask_question` envelope.

9. **Single migration `015_add_pending_approvals` with all columns at once.** v2 evolved `pending_approvals` over three migrations (003 base, 007 title/options retrofit, 013 render-metadata). v1-archive has no installed v1 with the legacy three-migration shape, so 4C lands the final column set in one migration. No shape evolution is needed; no `safeAddColumn` retrofit.

## Schema

One new table:

```sql
CREATE TABLE pending_approvals (
  approval_id          TEXT PRIMARY KEY,
  session_id           TEXT,                                       -- nullable: OneCLI rows have no session
  request_id           TEXT NOT NULL,                              -- caller-supplied id (often = approval_id)
  action               TEXT NOT NULL,                              -- e.g. 'install_packages', 'onecli_credential'
  payload              TEXT NOT NULL,                              -- JSON-encoded opaque payload, handed to handler on approve
  created_at           TEXT NOT NULL,
  agent_group_id       TEXT REFERENCES agent_groups(id),           -- nullable for global / OneCLI cases
  channel_type         TEXT,                                       -- delivery channel (where the card was sent)
  platform_id          TEXT,                                       -- delivery chat (e.g. admin's DM jid)
  platform_message_id  TEXT,                                       -- so we can edit the card on expiry
  expires_at           TEXT,                                       -- nullable: only OneCLI uses this today
  status               TEXT NOT NULL DEFAULT 'pending',            -- 'pending' | 'approved' | 'rejected' | 'expired'
  title                TEXT NOT NULL DEFAULT '',                   -- card title (render metadata)
  options_json         TEXT NOT NULL DEFAULT '[]'                  -- normalized button options (render metadata)
);

CREATE INDEX idx_pending_approvals_action_status
  ON pending_approvals(action, status);
```

Notes on the schema:
- `session_id` is intentionally NOT a foreign key (`REFERENCES sessions(id)`) on v1-archive — v1 doesn't have a `sessions` table (per-group containers, not per-session). The column exists for future Phase 5 per-session-container work; today every row stays NULL or carries an opaque agent-group identifier reused by callers. This is the one v1↔v2 schema divergence in 4C; document it inline in the migration body.
- `idx_pending_approvals_action_status` matches v2's index name precisely. v2's filename was `pending-approvals` with the index added in the same migration; we collapse to a single `015_*` entry.
- All columns NON-NULL except where genuinely optional. Defaults for `status`, `title`, `options_json` match v2's final shape after migration 007's retrofit.

## Migrations

After Phase 4B's `010-014`, the next available number is `015`. One migration entry suffices:

- `015_add_pending_approvals` — CREATE TABLE pending_approvals + index.

Reserve slot `016_*` informally for any forward-port adjustment but do not allocate it pre-emptively.

## Functions / modules

New module: `/data/nanotars/src/permissions/approvals.ts` — the primitive. Mirrors v2's `src/modules/approvals/primitive.ts`, adapted to v1's flat directory structure.

```ts
// Two-button approval UI — the only options the primitive supports today.
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

export interface ApprovalHandlerContext {
  agentGroupId: string;                          // v1 has per-group containers; this replaces v2's `session`
  payload: Record<string, unknown>;
  userId: string;                                // approver user id; '' if unknown
  notify: (text: string) => void;                // send a system message into the requesting agent group
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void
export function getApprovalHandler(action: string): ApprovalHandler | undefined

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
export async function requestApproval(opts: RequestApprovalOptions): Promise<void>
```

New module: `/data/nanotars/src/permissions/approval-routing.ts` — approver picking + delivery target.

```ts
/** Ordered, deduped approver user_ids for an agent group. */
export function pickApprover(agentGroupId: string | null): string[]

/** Walk approvers and return the first reachable DM. Same-channel-kind tie-break. */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null>
```

`pickApprover` reads `user_roles` via Phase 4B's `listAdminsOfAgentGroup` / `listGlobalAdmins` / `listOwners` (assumed to exist after 4B B2). `pickApprovalDelivery` uses Phase 4B's `ensureUserDm` to resolve DMs, with cache hit cheap and cache miss potentially calling a channel adapter's `openDM`.

New module: `/data/nanotars/src/permissions/approval-response.ts` — click handling + click-auth.

```ts
/** Dispatched from the channel adapter's button-click handler. Returns true if the click was claimed. */
export async function handleApprovalResponse(payload: ApprovalClickPayload): Promise<boolean>

interface ApprovalClickPayload {
  questionId: string;       // approval_id
  value: string;            // 'approve' | 'reject'
  channelType: string;      // for clicker resolution
  userId?: string;          // raw platform handle of clicker
}
```

The response flow:
1. Try `resolveOneCLIApproval(questionId, value)` — short-circuit for the in-memory OneCLI case.
2. Look up `pending_approvals` row.
3. Compute `clickerId = '<channelType>:<userId>'`. Click-auth: `clickerId === row.approver_user_id || isOwner(clickerId) || isGlobalAdmin(clickerId) || isAdminOfAgentGroup(clickerId, row.agent_group_id)`. On failure: log warning, return `true` (claim silently — no further dispatch).
4. On approve: look up handler in registry, call it; on no-handler: notify caller, drop row.
5. On reject: notify caller, drop row.

(v1 doesn't have `row.approver_user_id` because v2's later migrations added it. For 4C, store the picked approver's userId in the row's `payload` JSON for click-auth lookup. If a future migration wants a dedicated column, that's a follow-on; the JSON-embedded approver is functionally equivalent for click-auth.)

New module: `/data/nanotars/src/permissions/approval-card-expiry.ts` — startup sweep + edit-to-Expired.

```ts
/** Edit any leftover OneCLI cards from a previous process to "Expired (host restarted)" + drop the rows. */
export async function sweepStaleApprovals(adapter: ChannelDeliveryAdapter): Promise<void>

/** Edit a specific card to "Expired (<reason>)". Used by the OneCLI bridge when its in-process timer fires. */
export async function editCardExpired(
  row: PendingApproval,
  reason: string,
  adapter: ChannelDeliveryAdapter,
): Promise<void>
```

New module: `/data/nanotars/src/permissions/onecli-approvals.ts` — Phase 3 carryover, ports v2's `src/modules/approvals/onecli-approvals.ts` verbatim with the directory + import-path rewrites.

Functions exposed:

```ts
export const ONECLI_ACTION = 'onecli_credential';
export function startOneCLIApprovalHandler(adapter: ChannelDeliveryAdapter): void
export function stopOneCLIApprovalHandler(): void
/** Called from approval-response.ts to short-circuit the in-memory Promise. */
export function resolveOneCLIApproval(approvalId: string, selectedOption: string): boolean
```

The bridge:
1. Calls `onecli.configureManualApproval(callback)` once at host startup, after delivery adapters are registered.
2. On callback: pick approver via `pickApprover(<agent_group_id from request.agent.externalId>)`, deliver an `ask_question` card via the delivery adapter, persist a `pending_approvals` row with `action='onecli_credential'` + `expires_at`, and return a Promise that resolves on click or expires just-shy of the gateway's TTL.
3. On expiry: edit the card to "Expired (no response)", set `status='expired'`, drop the row, resolve `'deny'`.
4. On startup: `sweepStaleApprovals` edits leftover OneCLI cards to "Expired (host restarted)" and drops rows.

New DB accessors in `/data/nanotars/src/db/state.ts` (or a new `src/db/approvals.ts`):

```ts
export function createPendingApproval(pa: Partial<PendingApproval> & Required<...>): boolean
export function getPendingApproval(approvalId: string): PendingApproval | undefined
export function updatePendingApprovalStatus(approvalId: string, status: PendingApproval['status']): void
export function deletePendingApproval(approvalId: string): void
export function getPendingApprovalsByAction(action: string): PendingApproval[]
```

`createPendingApproval` uses `INSERT OR IGNORE` (idempotent — delivery retries with the same `approval_id` must not fail on PK conflict before the send step succeeds; same reasoning v2 uses).

## Wiring

The approval primitive integrates at three points in v1's existing surface:

1. **Channel-adapter button-click handler.** Each channel adapter that supports buttons (Telegram + future Slack / Discord) needs to dispatch button clicks to `handleApprovalResponse`. v1's existing inbound message path doesn't carry button-click events; 4C adds a minimal "interaction" hook on the adapter interface (the adapter calls `onInteraction(payload)` instead of routing the click as an inbound text message). Channels without button support: skip — text-only DMs won't carry approvals in 4C.

2. **Host startup.** In `/data/nanotars/src/index.ts`, after channel adapters + delivery adapter are initialized, call `startOneCLIApprovalHandler(deliveryAdapter)`. On shutdown, call `stopOneCLIApprovalHandler()`. Document that this is best-effort — if OneCLI isn't reachable, the call is a no-op (no manual-approval registration happens; OneCLI's own server-side TTL governs).

3. **Future modules.** Self-modification (Phase 5), `ask_question` from agents (Phase 4D), pending-sender approval (Phase 4D), pending-channel approval (Phase 4D) all import `requestApproval` + `registerApprovalHandler`. Phase 4C doesn't ship those callers; it just makes the primitive available.

## Click-auth implementation note

v2's click-auth lives in `permissions/index.ts:208-218` and `:289-300` (sender + channel registration). In 4C, the equivalent check lives in `approval-response.ts`. Two checks:

```ts
const clickerId = payload.userId ? `${payload.channelType}:${payload.userId}` : null;
const approverId = JSON.parse(row.payload).approver as string | undefined;   // stored at requestApproval time
const authorized = clickerId !== null && (
  clickerId === approverId ||
  isOwner(clickerId) ||
  isGlobalAdmin(clickerId) ||
  (row.agent_group_id != null && isAdminOfAgentGroup(clickerId, row.agent_group_id))
);
if (!authorized) {
  log.warn('approval click rejected — unauthorized clicker', { approvalId: row.approval_id, clickerId, expectedApprover: approverId });
  return true;   // claim silently per v2's posture
}
```

The "claim silently" semantics deliberately match v2 — a stolen / forwarded card silently does nothing rather than yielding to a logging fallback that might log sensitive information. Master triage open question #5 (Area 2 appendix line ~168) flags this as "worth flagging for security review if adopted"; we adopt v2's posture in 4C and revisit only if a real reason surfaces.

## Tests

Per-module unit tests:
- `permissions/__tests__/approvals.test.ts` — `requestApproval` happy path (creates row + delivers card), no-approvers branch (notify-and-bail), no-DM branch (notify-and-bail), handler-registry idempotency.
- `permissions/__tests__/approval-routing.test.ts` — `pickApprover` ordering (scoped → global → owner), dedup, `pickApprovalDelivery` same-channel-kind tie-break, no-reachable-DM returns null.
- `permissions/__tests__/approval-response.test.ts` — click-auth decision table (approver / scoped admin / global admin / owner / random user / unauthenticated), reject path notifies caller, approve path dispatches handler.
- `permissions/__tests__/approval-card-expiry.test.ts` — sweep edits + drops; edit-card no-ops when no platform_message_id.
- `permissions/__tests__/onecli-approvals.test.ts` — full callback flow with a faked OneCLI SDK + fake delivery adapter; expiry timer fires and resolves `'deny'`; click resolves `'approve'`/`'deny'`; startup sweep behavior.
- `__tests__/migration-015.test.ts` — pending_approvals table + index exist after running migration; idempotent on re-run.

Integration:
- A small integration test that exercises requestApproval end-to-end against an in-memory DB and a stub adapter, asserting the row exists and the adapter received an `ask_question` payload.

OneCLI bridge testing notes:
- Mock `@onecli-sh/sdk`'s `OneCLI` class (the same shape used in Phase 3). The `configureManualApproval` callback signature is `(req: ApprovalRequest) => Promise<'approve' | 'deny'>`; tests invoke the captured callback directly with a synthetic `ApprovalRequest`.
- Use `vi.useFakeTimers()` for the expiry timer — fast-forward past `expiresAt`, assert the Promise resolves to `'deny'` and the row is marked `'expired'`.

## Effort

Triage estimates 4C at ~2-3 weeks. Sub-tasks roughly:

- C1: schema + migration `015_add_pending_approvals` + DB accessors
- C2: `requestApproval` primitive + handler registry
- C3: `pickApprover` + `pickApprovalDelivery` (reads `user_roles` via 4B accessors)
- C4: click-auth + button-click dispatch wiring (touches IPC / channel-adapter interface)
- C5: card-expiry sweep + edit-to-Expired helper
- C6: OneCLI manual-approval bridge port (depends on Phase 3 OneCLI gateway + 4C C3)
- C7: final phase review

Reviewer dispatch on: C1 (schema), C4 (cross-tier IPC + adapter contract), C6 (cross-tier OneCLI integration). Mechanical: C2, C3, C5.

## Out of scope (deferred to 4D / later)

- `pending_questions` table + `ask_question` MCP tool (generic agent-asks-user) — Phase 4D.
- `pending_sender_approvals` request/respond flow — Phase 4D.
- `pending_channel_approvals` + `denied_at` flow — Phase 4D.
- Self-modification approval flow (`install_packages`, `add_mcp_server`) — Phase 5; those modules will register their handlers via `registerApprovalHandler`.
- Multi-approver quorum / broadcast — not in v2 either.
- Full Chat SDK bridge port (the rich card-rendering surface) — out of catch-up scope; 4C ships the minimum delivery interface needed by the primitive.
