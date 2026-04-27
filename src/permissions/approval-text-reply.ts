/**
 * Slice 7 — universal text-reply middleware for approval cards.
 *
 * Channels without inline-button support (Discord/Slack/WhatsApp/CLI/IRC)
 * surface the plain-text fallback card from `deliverApprovalCardAsText`,
 * which instructs the user to reply "approve" or "reject". This module
 * parses those replies and routes them through `routeApprovalClick`.
 *
 * Auth: silent fall-through on any failure (sender not an approver, no
 * pending row, etc.) — we don't leak the existence of pending approvals
 * to non-admins. The orchestrator's pre-agent hook calls this; on
 * matched=true the agent turn is suppressed for this message.
 */
import { logger } from '../logger.js';
import { getDb } from '../db/init.js';
import { resolveSender } from './sender-resolver.js';
import { routeApprovalClick } from './approval-click-router.js';

export interface TryHandleApprovalTextReplyArgs {
  channel_type: string;
  platform_id: string;
  sender_handle: string;
  sender_name?: string;
  text: string;
}

export interface TextReplyMatchResult {
  /** True iff the message was consumed; orchestrator should suppress the agent turn. */
  matched: boolean;
}

const APPROVE_RE = /^\s*(approve|reject)\s*$/i;

export async function tryHandleApprovalTextReply(
  args: TryHandleApprovalTextReplyArgs,
): Promise<TextReplyMatchResult> {
  const m = args.text.match(APPROVE_RE);
  if (!m) return { matched: false };
  const verb = m[1].toLowerCase();

  // Resolve sender; resolveSender is synchronous and always returns a non-empty
  // string (auto-creates the users row if needed). Any unexpected throw is
  // swallowed for silent fall-through.
  let senderUserId: string;
  try {
    senderUserId = resolveSender({
      channel: args.channel_type,
      platform_id: args.platform_id,
      sender_handle: args.sender_handle,
      sender_name: args.sender_name,
    });
  } catch (err) {
    logger.debug({ err }, 'tryHandleApprovalTextReply: resolveSender threw');
    return { matched: false };
  }
  if (!senderUserId) return { matched: false };

  // Find the most recent pending approval for this chat.
  const row = getDb()
    .prepare(
      `SELECT approval_id, options_json
         FROM pending_approvals
        WHERE status = 'pending'
          AND channel_type = ?
          AND platform_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(args.channel_type, args.platform_id) as
    | { approval_id: string; options_json: string }
    | undefined;
  if (!row) return { matched: false };

  // Map the verb to an option_id present on the card. The card's options
  // are typically [{id:'approve',...},{id:'reject',...}] but we honor whatever
  // ids the handler defined.
  let optionId: string | null = null;
  try {
    const options = JSON.parse(row.options_json) as Array<{ id: string }>;
    const match = options.find((o) => o.id.toLowerCase() === verb);
    optionId = match?.id ?? null;
  } catch {
    return { matched: false };
  }
  if (!optionId) return { matched: false };

  let result;
  try {
    result = await routeApprovalClick({
      approval_id: row.approval_id,
      clicker_channel: args.channel_type,
      clicker_platform_id: args.platform_id,
      clicker_handle: args.sender_handle,
      clicker_name: args.sender_name,
      selected_option: optionId,
    });
  } catch (err) {
    logger.warn(
      { err, approval_id: row.approval_id },
      'tryHandleApprovalTextReply: routeApprovalClick threw',
    );
    return { matched: false };
  }

  // Auth fail → silent fall-through (don't leak approval existence).
  if (!result.handled || !result.success) {
    logger.debug(
      { approval_id: row.approval_id, reason: result.reason },
      'tryHandleApprovalTextReply: routeApprovalClick failed',
    );
    return { matched: false };
  }

  return { matched: true };
}
