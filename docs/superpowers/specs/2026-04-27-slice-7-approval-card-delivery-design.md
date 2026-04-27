# Approval-Card Delivery — Design Spec (Slice 7)

**Date:** 2026-04-27
**Slice:** v1↔v2 catch-up — approval-card delivery (surfaced by slice 6 smoke test)
**Status:** Approved for planning
**Surfaced by:** Slice 6 manual smoke test on 2026-04-27 — three independent v1 gaps revealed when first end-to-end test of an approval-card flow ran. Two were patched as workarounds (SQL inserts for `user_roles` and `user_dms`, plus `deliverApprovalCard` patch on `create-skill-plugin.ts`); this slice fixes the gaps properly.

## Problem

In the v1 install state surfaced by slice 6's smoke test, **approval cards cannot be approved through any chat — text or button — for any self-mod action.** Three independent gaps:

1. **Self-mod handlers don't call `deliverApprovalCard`.** `add_mcp_server`, `install_packages`, `create_skill_plugin` (slice 6, patched in `95e378d`), and `create_agent` all persist a `pending_approvals` row via `requestApproval` but never invoke delivery. Only `sender-approval.ts`, `channel-approval.ts`, `onecli-bridge.ts` call `deliverApprovalCard`. Cards never reach a chat.

2. **No channel registers an inline-button renderer.** `registerApprovalDeliverer(channel, fn)` is the registration surface; the `deliverers` Map is always empty. Every card falls through to `deliverApprovalCardAsText`, which produces a plain-text "reply approve/reject" message.

3. **Nothing parses text replies.** The plain-text fallback tells the user to reply `approve`/`reject`, but no host-side middleware listens. Replies just go to the agent (which interprets them conversationally — exactly what happened in the smoke test).

Net: in the smoke test, TARS submitted a valid create_skill_plugin request, the host queued a pending_approvals row, but the admin saw no card; manual SQL workarounds were required to even reach the plain-text fallback, which itself is non-functional.

## Goals

1. Telegram inline-button approval cards render natively for any self-mod or sender/channel approval.
2. Text-reply approval works as a universal fallback for channels without inline buttons (Discord/Slack/WhatsApp/CLI/IRC).
3. Self-mod handlers don't have to know about delivery — `requestApproval` handles it.
4. Decisions edit the original card in place (`✅ Approved by @user at HH:MM`) so the chat history shows clean state. The `platform_message_id` already persists for this purpose.
5. Slice 6's smoke test (Task 11) becomes runnable end-to-end without manual intervention.

## Non-goals

- Discord/Slack/WhatsApp inline-button rendering. Each gets its own marketplace PR later. The text-reply parser unblocks them in the meantime.
- Cryptographic callback-data signing. Auth check (`approval-click-auth.ts`) is the integrity gate.
- Multi-message rich approval cards (attachments, multi-step wizards). Current title+body+options is enough.
- Card auto-edit on expiry (the expiry poll marking rows expired). The card stays as the original; chat history is timestamped. Could be a follow-up.

## Architecture

Three layered changes:

### 1. Hoisted delivery in `src/permissions/approval-primitive.ts`

`requestApproval` auto-calls `deliverApprovalCard` after the DB insert, gated on a new `skipDelivery?: boolean` flag (default false). The 4 self-mod handlers drop their per-handler delivery (incl. reverting the slice 6 patch on `create-skill-plugin.ts`); the 3 explicit callers (`sender-approval.ts`, `channel-approval.ts`, `onecli-bridge.ts`) opt out via `skipDelivery: true` since they have custom delivery flows that pre-resolve the deliveryTarget.

**Why hoist:** the smoke-test bug literally happened because four handlers independently forgot to call delivery. Centralizing the call means future self-mod handlers (e.g., a future `create_team` action) get delivery automatically.

### 2. Channel rendering + click handling, in the Telegram channel plugin

Plugin `onChannel` registers two adapters at startup:

- **Deliverer** (`registerApprovalDeliverer('telegram', ...)`) — sends the card with `reply_markup.inline_keyboard` containing one button per `card.options[].id`. `callback_data` is `approval:<approval_id>:<option_id>`. Returns `platform_message_id` for the editor.
- **Editor** (`registerApprovalEditor('telegram', ...)`) — uses `bot.api.editMessageText` + empty `reply_markup` to replace the card body with `${title}\n\n${body}\n\n✅ Approved by @user at HH:MM` (or `❌ Rejected` / `⏱ Expired`). Removes inline buttons.
- **Callback handler** (`bot.on('callback_query:data')`) — parses `callback_data`, calls `routeApprovalClick`, then `answerCallbackQuery` for the toast.

`registerApprovalEditor` is new infrastructure on the host side, parallel to `registerApprovalDeliverer`. Same Map-of-adapters shape.

### 3. Host text-reply middleware

New module `src/permissions/approval-text-reply.ts`. Single export `tryHandleApprovalTextReply({channel_type, platform_id, sender_handle, sender_name?, text})`. Returns `{matched: boolean}`.

Logic:
1. Match `^\s*(approve|reject)\s*$` (case-insensitive, strict). On miss, return `{matched: false}`.
2. Resolve sender via `resolveSender`.
3. SQL: most-recent `pending_approvals` row whose `_picked_approver_user_id` matches the resolved sender (or sender has owner/global-admin override) AND deliveryTarget points at this `(channel_type, platform_id)`. Limit 1.
4. On hit: call `routeApprovalClick` with the matched option_id. Return `{matched: true}`.
5. On miss (no row OR no auth): return `{matched: false}` (silent fall-through to agent).

The orchestrator's pre-agent hook calls this. On `matched: true`, suppress the agent turn for this message.

## Component specs

### Component 1: Hoisted delivery — `src/permissions/approval-primitive.ts`

Add `skipDelivery?: boolean` to `RequestApprovalArgs`. After the DB insert at the end of `requestApproval`, add:

```typescript
if (!args.skipDelivery && rendered && deliveryTarget) {
  void deliverApprovalCard({
    approval_id: approvalId,
    channel_type: deliveryTarget.messagingGroup.channel_type,
    platform_id: deliveryTarget.messagingGroup.platform_id,
    title: rendered.title,
    body: rendered.body,
    options: rendered.options,
  }).catch((err) =>
    logger.warn(
      { err, approvalId, action: args.action },
      'requestApproval: hoisted delivery failed',
    ),
  );
}
```

Update callers:

- `sender-approval.ts`, `channel-approval.ts`, `onecli-bridge.ts`: add `skipDelivery: true` to their `requestApproval` calls. Each is a one-line edit.
- `create-skill-plugin.ts`: remove the `deliverApprovalCard` block added in commit `95e378d`. The hoisted call covers it.
- `add-mcp-server.ts`, `install-packages.ts`, `create-agent.ts`: no change needed — they didn't call `deliverApprovalCard` to begin with. The hoisted call now provides delivery.

### Component 2: `registerApprovalEditor` — `src/permissions/approval-delivery.ts`

New types and registry:

```typescript
export interface ApprovalEditTarget {
  channel_type: string;
  platform_id: string;
  platform_message_id: string;
  decision: 'approved' | 'rejected' | 'expired';
  decided_by_user_id: string | null;
  /** Original card content so the editor can preserve title etc. */
  original: { title: string; body: string };
}

export type ApprovalEditor = (target: ApprovalEditTarget) => Promise<{ ok: boolean; error?: string }>;

const editors = new Map<string, ApprovalEditor>();

export function registerApprovalEditor(channel: string, fn: ApprovalEditor): void {
  if (editors.has(channel)) {
    logger.warn({ channel }, 'registerApprovalEditor: channel already registered, overwriting');
  }
  editors.set(channel, fn);
}

export function getApprovalEditor(channel: string): ApprovalEditor | undefined {
  return editors.get(channel);
}

export function clearApprovalEditors(): void {
  editors.clear();
}

/**
 * Edit the original card message after a decision. Best-effort — failure
 * logged but doesn't error the click. Looks up the row to get the
 * platform_message_id and original card content.
 */
export async function editApprovalCardOnDecision(approval_id: string): Promise<void> {
  const row = getPendingApproval(approval_id);
  if (!row || typeof row.platform_message_id !== 'string') return;
  const channel = String(row.channel_type ?? '');
  const editor = editors.get(channel);
  if (!editor) return;
  const decision = String(row.status ?? 'pending');
  if (!['approved', 'rejected', 'expired'].includes(decision)) return;
  // Re-render the body so the edit shows exactly what the original card showed.
  const handler = getApprovalHandler(String(row.action ?? ''));
  const payload = JSON.parse(String(row.payload ?? '{}'));
  const rendered = handler?.render({ approvalId: approval_id, payload });
  const renderedBody = rendered?.body ?? '';
  try {
    await editor({
      channel_type: channel,
      platform_id: String(row.platform_id ?? ''),
      platform_message_id: row.platform_message_id,
      decision: decision as 'approved' | 'rejected' | 'expired',
      decided_by_user_id: typeof row.approver_user_id === 'string' ? row.approver_user_id : null,
      original: { title: String(row.title ?? ''), body: renderedBody },
    });
  } catch (err) {
    logger.warn({ err, approval_id, channel }, 'editApprovalCardOnDecision: editor threw');
  }
}
```

**Body source:** the original card body is NOT stored verbatim on the row — `pending_approvals` keeps `title` + `options_json` + `payload` only. To get the body for the edit, `editApprovalCardOnDecision` re-invokes the registered handler's `render({approvalId, payload})` and uses `rendered.body`. This is cheap (pure function, no I/O), avoids a schema change, and means the edit shows exactly what the original card showed. The implementation will look up the handler via the existing `getApprovalHandler(action)` and invoke `render` with the row's parsed payload.

### Component 3: Click-auth hook — `src/permissions/approval-click-auth.ts`

After `applyDecision` returns successfully, call `editApprovalCardOnDecision(approval_id)`. One additional line in `handleApprovalClick`. Best-effort — failure logged, doesn't fail the click.

### Component 4: Telegram plugin — `plugins/nanotars-telegram/files/index.js` + local mirror

In `onChannel`:

```javascript
import {
  registerApprovalDeliverer,
  registerApprovalEditor,
} from '/app/dist/permissions/approval-delivery.js'; // path resolved by container mount; spec sketch
import { routeApprovalClick } from '/app/dist/permissions/approval-click-router.js';

registerApprovalDeliverer('telegram', async (card) => {
  const chatId = parseInt(card.platform_id.replace(/^tg:/, ''), 10);
  const buttons = card.options.map((opt) => ({
    text: opt.label,
    callback_data: `approval:${card.approval_id}:${opt.id}`,
  }));
  const msg = await bot.api.sendMessage(chatId, `${card.title}\n\n${card.body}`, {
    reply_markup: { inline_keyboard: [buttons] },
  });
  return { delivered: true, platform_message_id: String(msg.message_id) };
});

registerApprovalEditor('telegram', async (target) => {
  const chatId = parseInt(target.platform_id.replace(/^tg:/, ''), 10);
  const verb = {
    approved: '✅ Approved',
    rejected: '❌ Rejected',
    expired: '⏱ Expired',
  }[target.decision];
  const decidedBy = target.decided_by_user_id ? ` by ${target.decided_by_user_id}` : '';
  const time = new Date().toISOString().slice(11, 16);
  await bot.api.editMessageText(
    chatId,
    parseInt(target.platform_message_id, 10),
    `${target.original.title}\n\n${target.original.body}\n\n${verb}${decidedBy} at ${time}`,
    { reply_markup: { inline_keyboard: [] } },
  );
  return { ok: true };
});

bot.on('callback_query:data', async (ctx) => {
  const m = ctx.callbackQuery.data.match(/^approval:([0-9a-f-]+):(.+)$/);
  if (!m) return;
  const [, approval_id, selected_option] = m;
  const result = await routeApprovalClick({
    approval_id,
    clicker_channel: 'telegram',
    clicker_platform_id: `tg:${ctx.chat.id}`,
    clicker_handle: String(ctx.from.id),
    clicker_name: ctx.from.username || ctx.from.first_name,
    selected_option,
  });
  await ctx.answerCallbackQuery({
    text: result.success ? `Recorded: ${selected_option}` : `Failed: ${result.error || 'unauthorized'}`,
  });
});
```

**Import path:** the Telegram plugin runs in the same Node process as the host (it's a host-side plugin, not a container plugin). `registerApprovalDeliverer`, `registerApprovalEditor`, and `routeApprovalClick` are imported from the compiled host code. The existing `setMyCommands` block already imports from the host (see how it accesses `data/admin-commands.json` produced by `writeAdminCommandsJson`), so the same module-resolution pattern applies. The plan task will resolve the precise import path based on the existing precedent.

Marketplace PR strategy: same as slice 5 (PR #12 to `TerrifiedBug/nanotars-skills`). Local install patches `plugins/channels/telegram/index.js` simultaneously to mirror.

### Component 5: Text-reply middleware — `src/permissions/approval-text-reply.ts` (new)

Single function:

```typescript
export interface TryHandleApprovalTextReplyArgs {
  channel_type: string;
  platform_id: string;
  sender_handle: string;
  sender_name?: string;
  text: string;
}

export async function tryHandleApprovalTextReply(
  args: TryHandleApprovalTextReplyArgs,
): Promise<{ matched: boolean }> {
  const m = args.text.trim().toLowerCase().match(/^(approve|reject)$/);
  if (!m) return { matched: false };
  const verb = m[1];

  // Resolve sender. If we can't resolve, fall through silently.
  const sender = await resolveSender({
    channel: args.channel_type,
    platform_id: args.platform_id,
    sender_handle: args.sender_handle,
    sender_name: args.sender_name,
  });
  if (!sender || !sender.user_id) return { matched: false };

  // Find a pending row this user can act on for this chat. Priority:
  // (1) most recent where _picked_approver_user_id == sender.user_id
  // (2) most recent where any pending row matches THIS chat AND sender has owner/admin override
  const row = getDb()
    .prepare(`
      SELECT approval_id, payload, options_json, agent_group_id
      FROM pending_approvals
      WHERE status = 'pending'
        AND channel_type = ?
        AND platform_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(args.channel_type, args.platform_id) as
    | { approval_id: string; payload: string; options_json: string; agent_group_id: string | null }
    | undefined;
  if (!row) return { matched: false };

  // Match verb to an option_id on the card. Default option_id matches the verb.
  const options = JSON.parse(row.options_json) as Array<{ id: string; label: string }>;
  const matched_option = options.find((o) => o.id.toLowerCase() === verb);
  if (!matched_option) return { matched: false };

  const result = await routeApprovalClick({
    approval_id: row.approval_id,
    clicker_channel: args.channel_type,
    clicker_platform_id: args.platform_id,
    clicker_handle: args.sender_handle,
    clicker_name: args.sender_name,
    selected_option: matched_option.id,
  });

  // Auth fail → silent fall-through (don't leak the approval's existence)
  if (!result.success && result.reason === 'unauthorized') {
    return { matched: false };
  }
  return { matched: true };
}
```

The orchestrator's pre-agent hook calls this; on `matched: true`, the orchestrator suppresses the agent turn for this message.

### Component 6: Orchestrator integration — `src/orchestrator.ts`

In the inbound-message processing path, after the message is stored but before invoking the agent, add:

```typescript
const replyResult = await tryHandleApprovalTextReply({
  channel_type: msg.channel_type,
  platform_id: msg.chat_jid, // or whatever the chat-jid var is
  sender_handle: msg.sender_handle,
  sender_name: msg.sender_name,
  text: msg.text,
});
if (replyResult.matched) {
  // Skip the agent turn for this message; the click was dispatched.
  return;
}
```

Implementation will check the actual orchestrator entry-point — exact insertion site documented in the plan task.

## Validation rules

- `card.options[].id` length ≤ 18 characters (host-side check before delivery, to fit within Telegram's 64-byte `callback_data` limit).
- Text-reply parser matches `^\s*(approve|reject)\s*$` strictly (case-insensitive).
- Click-auth: existing `approval-click-auth.ts` rules — clicker is approver / owner / global-admin override. No new auth surface.
- `callback_data` regex `/^approval:([0-9a-f-]+):(.+)$/` — anything else ignored silently.

## Failure paths

| Failure | Detection | Behavior | User-visible |
|---|---|---|---|
| Telegram deliverer throws | `deliverApprovalCard` adapter catch | Falls back to `deliverApprovalCardAsText` | Plain-text card lands; admin replies `approve` text |
| Editor throws (msg too old, deleted) | `editApprovalCardOnDecision` catch | Logs warn, decision still recorded | TARS confirm message via chat; original card stays unedited |
| Click on already-resolved approval | `handleApprovalClick` status guard | Toast: "Already resolved" | Toast notification |
| Text-reply matches but no pending row | Lookup returns nothing | Silent fall-through to agent | TARS responds conversationally |
| Text-reply from non-approver | Auth fail | Silent fall-through to agent (don't leak approval) | TARS responds conversationally |
| `applyDecision` throws | Existing rollback | Row marked approved (decision recorded) but `notifyAgent` reports failure | TARS surfaces failure; card edited to ✅ but follow-up explains |
| Hoisted delivery throws | `requestApproval` catch | Logs warn with action + approvalId | No card; row in DB; admin can find via expiry/CLI |
| Text-reply concurrent with button click | Status guard | One wins; other gets silent fall-through OR toast | Either way, single resolution |

## Testing

### Unit

| File | Coverage |
|---|---|
| `src/permissions/__tests__/approval-primitive.test.ts` (extend) | Hoisted `deliverApprovalCard` is called when deliveryTarget exists and skipDelivery falsy. Not called when skipDelivery=true. Failure doesn't fail `requestApproval`. |
| `src/permissions/__tests__/approval-delivery.test.ts` (extend) | `registerApprovalEditor`/`getApprovalEditor`/`clearApprovalEditors`. `editApprovalCardOnDecision` looks up row, dispatches to channel adapter, no-ops when no adapter. |
| `src/permissions/__tests__/approval-text-reply.test.ts` (new) | Strict regex match. Sender resolution. Pending-row lookup by `(channel, platform_id)`. Auth check via `routeApprovalClick`. Silent fall-through on miss/auth-fail. |
| `src/permissions/__tests__/approval-click-auth.test.ts` (extend) | After `applyDecision` succeeds, `editApprovalCardOnDecision` is called once with correct args. |
| `plugins/channels/telegram/__tests__/approval-card.test.js` (new — local plugin) | Deliverer renders inline_keyboard with correct buttons. Editor edits message + clears reply_markup. Callback handler parses callback_data, dispatches, calls `answerCallbackQuery`. |

### Update existing tests

- `sender-approval`, `channel-approval`, `onecli-bridge` request tests assert `skipDelivery: true` is passed in.
- `create-skill-plugin-request.test.ts` drops the `deliverApprovalCard` mock — coverage moves to `approval-primitive.test.ts`.

### E2E

`src/__tests__/e2e/create-skill-plugin-flow.test.ts` (extend): assert that after `applyDecisionForTest('approved')`, `editApprovalCardOnDecision` is called with `decision='approved'`.

`src/__tests__/e2e/approval-text-reply-flow.test.ts` (new): drive a fake inbound message with text "approve", assert pre-agent hook consumes it, applyDecision runs, editor invoked.

### Manual smoke test

In the implementation plan's last task:

1. Build host + restart.
2. Marketplace PR for Telegram plugin merged + reinstalled locally.
3. Telegram main chat: ask TARS to create a `wikipedia-summary` skill.
4. Card with **inline buttons** appears in admin chat.
5. Tap Approve. Card edits to "✅ Approved by @exploit at HH:MM"; buttons gone; toast appears; container restarts; TARS replies "Plugin live".
6. Repeat with Reject.
7. Negative: ask TARS for a different skill, then reply `approve` text. Same end state, suppressed agent turn.
8. Negative: from a non-admin Telegram user, tap Approve. "Not authorized" toast; row stays pending.

## Migration / rollout

No schema migration. Existing `pending_approvals` table has all needed columns (`platform_message_id`, `channel_type`, `platform_id`, `status`).

Rollout: ship host changes (hoist, editor registry, click-auth hook, text-reply middleware) in one branch. Telegram plugin update goes through marketplace PR. Local install patches in same commit. Slice 6's smoke test is then runnable.

Backwards-compat: existing approval-card flows (sender-approval, channel-approval, onecli-bridge) preserve current behavior via `skipDelivery: true` — they continue to deliver via their own paths. No regression.

## Security summary

- Click auth via existing `approval-click-auth.ts` (clicker is approver / owner / global-admin).
- Text-reply auth via same path; silent fall-through on auth fail (no leak of approval existence).
- `callback_data` is server-set; tampering caught by auth + lookup.
- No new audit surface; existing `pending_approvals.status` change is the audit record.
- `card.options[].id` length-bounded server-side to fit Telegram's 64-byte callback_data limit.

## File list

**New files:**
- `src/permissions/approval-text-reply.ts`
- `src/permissions/__tests__/approval-text-reply.test.ts`
- `src/__tests__/e2e/approval-text-reply-flow.test.ts`
- `plugins/channels/telegram/__tests__/approval-card.test.js` (local plugin)

**Modified files:**
- `src/permissions/approval-primitive.ts` — hoist delivery + `skipDelivery` flag
- `src/permissions/approval-delivery.ts` — add `registerApprovalEditor` + `editApprovalCardOnDecision`
- `src/permissions/approval-click-auth.ts` — call `editApprovalCardOnDecision` after `applyDecision`
- `src/permissions/sender-approval.ts` — add `skipDelivery: true`
- `src/permissions/channel-approval.ts` — add `skipDelivery: true`
- `src/permissions/onecli-bridge.ts` — add `skipDelivery: true`
- `src/permissions/create-skill-plugin.ts` — revert the `deliverApprovalCard` patch from commit `95e378d` (hoisted now)
- `src/orchestrator.ts` — call `tryHandleApprovalTextReply` in the pre-agent path
- `plugins/channels/telegram/index.js` (local) — register deliverer + editor + callback_query handler
- (Marketplace) `TerrifiedBug/nanotars-skills` `plugins/nanotars-telegram/files/index.js` — same patch as local
- `src/permissions/__tests__/approval-primitive.test.ts` — hoist tests
- `src/permissions/__tests__/approval-delivery.test.ts` — editor tests
- `src/permissions/__tests__/approval-click-auth.test.ts` — edit-on-decision test
- `src/permissions/__tests__/sender-approval-*.test.ts`, `channel-approval.test.ts`, `onecli-bridge.test.ts` — assert `skipDelivery: true`
- `src/permissions/__tests__/create-skill-plugin-request.test.ts` — drop redundant delivery mock
- `src/__tests__/e2e/create-skill-plugin-flow.test.ts` — assert editor invoked
- `docs/CHANGES.md` — slice 7 entry
- `docs/BACKLOG.md` — close out the three v1 gaps surfaced by slice 6

**Deferred (kept in BACKLOG):**
- Discord/Slack/WhatsApp inline-button rendering (per-channel marketplace PRs).
- Card auto-edit on expiry.
- `nanotars rebuild` UX shortcut (separate slice).
- `pair-main` should grant `owner` + seed `user_dms` (separate slice; smoke-test surfaced).

## Estimated size

2-3 days. Roughly:
- Day 1: Hoist + `skipDelivery` + 3 callers opt-out + revert slice 6 patch + tests.
- Day 1-2: `registerApprovalEditor` + `editApprovalCardOnDecision` + click-auth hook + tests.
- Day 2: Telegram plugin (deliverer + editor + callback handler) — local + marketplace PR.
- Day 2-3: Text-reply parser + orchestrator integration + tests.
- Day 3: E2E test + manual smoke + CHANGES + BACKLOG closeout.
