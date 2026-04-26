/**
 * Phase 4D D6 — host-side approval-click router.
 *
 * Adapter-side bridge for inbound button-clicks on approval cards. A
 * channel adapter (Telegram inline-keyboard webhook, Slack interactive
 * payload, …) calls `routeApprovalClick` when it receives a click; this
 * module:
 *
 *   1. Resolves the clicker's `(channel, sender_handle)` pair to a
 *      canonical `users.id` via 4B's `resolveSender`.
 *   2. Maps the chosen option id to an approve/reject decision via the
 *      pending row's `options_json` (so adapter-side hardcoding of
 *      'approve'/'reject' isn't required).
 *   3. Hands off to C4's `handleApprovalClick`, which performs the
 *      identity-vs-approver auth and runs the registered handler's
 *      `applyDecision` callback.
 *
 * The host-side surface is intentionally tiny — adapters do the
 * platform-specific webhook decoding, this module does the cross-cutting
 * resolution + dispatch. Each adapter currently needs its own per-button
 * webhook wiring; that's per-adapter follow-on work.
 */
import { getPendingApproval } from './approval-primitive.js';
import { handleApprovalClick } from './approval-click-auth.js';
import { resolveSender, type SenderInfo } from './sender-resolver.js';
import { logger } from '../logger.js';

export interface RouteApprovalClickArgs {
  /** Approval id from the button's callback payload (e.g. card embedded id). */
  approval_id: string;
  /** Channel kind on which the click happened ("telegram", "slack", …). */
  clicker_channel: string;
  /** Platform-id chat where the click happened — used to seed user resolution. */
  clicker_platform_id: string;
  /** Platform-side handle of the clicker (channel-specific). */
  clicker_handle: string;
  /** Optional best-known display name for the clicker — passed through to user row. */
  clicker_name?: string;
  /**
   * Selected option id from the card. Must match an `options[].id` on
   * the pending_approvals row's `options_json` (e.g. 'approve' or 'reject').
   */
  selected_option: string;
}

export interface RouteApprovalClickResult {
  /** True iff the click was decoded + dispatched. */
  handled: boolean;
  /** Outcome from C4's auth/apply pipeline (when handled=true). */
  success: boolean;
  /** Diagnostic reason — auth failure, missing row, invalid option, …. */
  reason: string;
  /** Resolved canonical clicker user id, when resolution succeeded. */
  clicker_user_id?: string;
  /** Decision actually applied (when success=true). */
  decision?: 'approved' | 'rejected';
}

/**
 * Map an option id to an approve/reject decision by reading the card's
 * persisted `options_json`. Adapters don't hardcode option semantics —
 * the card writer (renderer) does, so the same id ('approve') can mean
 * different things across actions if a handler ever invented its own
 * option set.
 *
 * Convention: an option whose id starts with 'approve', 'allow', 'yes',
 * or 'ok' (case-insensitive) maps to `approved`. Everything else maps
 * to `rejected`. This matches every card produced by 4D's handlers
 * (sender-approval, channel-approval, OneCLI, ask_question) which all
 * use {id:'approve' | 'reject'} pairs.
 *
 * Exported for tests. The "approve-or-reject only" coercion is
 * intentional — the click-auth pipeline only accepts `approved` or
 * `rejected`; richer multi-option flows belong in a future
 * `pending_questions` answer router (separate from approvals).
 */
export function classifyOptionAsDecision(
  optionId: string,
): 'approved' | 'rejected' {
  const lower = optionId.toLowerCase();
  if (
    lower === 'approve' ||
    lower === 'approved' ||
    lower.startsWith('approve') ||
    lower === 'allow' ||
    lower === 'yes' ||
    lower === 'ok'
  ) {
    return 'approved';
  }
  return 'rejected';
}

/**
 * Adapter-facing handler. Resolves the clicker, decodes the option, and
 * delegates to C4 for auth + apply.
 *
 * Failure modes (each returns `handled:false`):
 *   - approval row not found (already resolved or never existed)
 *   - selected option not present on the card
 *   - sender resolution failed (malformed handle)
 *
 * On success (handled:true), the C4 pipeline already updated the
 * approval row status + invoked the handler. Adapters typically reply
 * to the click with an ack derived from `result.reason` — e.g.
 * "Approved", "Already resolved", or "You can't act on this card".
 */
export async function routeApprovalClick(
  args: RouteApprovalClickArgs,
): Promise<RouteApprovalClickResult> {
  // 1. Validate the approval row exists. C4 will re-check, but a
  // missing row here lets the adapter respond with a clearer error
  // ("expired") without burning a click-auth log entry.
  const approval = getPendingApproval(args.approval_id);
  if (!approval) {
    logger.warn(
      { approval_id: args.approval_id, clicker: args.clicker_handle },
      'routeApprovalClick: approval row not found',
    );
    return { handled: false, success: false, reason: 'approval-not-found' };
  }

  // 2. Validate the option is one the card actually offered. The card's
  // options_json was rendered at request time; an option id that's not
  // in the list is either a stale callback or an attacker.
  let optionsArr: Array<{ id: string; label: string }>;
  try {
    optionsArr = JSON.parse((approval.options_json as string) ?? '[]');
    if (!Array.isArray(optionsArr)) optionsArr = [];
  } catch {
    optionsArr = [];
  }
  const matched = optionsArr.find((o) => o.id === args.selected_option);
  if (!matched) {
    logger.warn(
      {
        approval_id: args.approval_id,
        selected_option: args.selected_option,
        offered: optionsArr.map((o) => o.id),
      },
      'routeApprovalClick: selected option not on card',
    );
    return { handled: false, success: false, reason: 'option-not-on-card' };
  }

  // 3. Resolve the clicker → canonical user id. resolveSender always
  // returns a non-null id; ensure_user inside it lazy-creates the row.
  let clicker_user_id: string;
  try {
    const senderInfo: SenderInfo = {
      channel: args.clicker_channel,
      platform_id: args.clicker_platform_id,
      sender_handle: args.clicker_handle,
      sender_name: args.clicker_name,
    };
    clicker_user_id = resolveSender(senderInfo);
  } catch (err) {
    logger.warn(
      { err, clicker_handle: args.clicker_handle, channel: args.clicker_channel },
      'routeApprovalClick: resolveSender failed',
    );
    return { handled: false, success: false, reason: 'clicker-resolution-failed' };
  }

  // 4. Decode the option to an approve/reject decision and hand off.
  const decision = classifyOptionAsDecision(args.selected_option);
  const result = await handleApprovalClick({
    approval_id: args.approval_id,
    clicker_user_id,
    decision,
  });

  return {
    handled: true,
    success: result.success,
    reason: result.reason,
    clicker_user_id,
    decision,
  };
}
