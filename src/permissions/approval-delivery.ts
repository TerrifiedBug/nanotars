/**
 * Phase 4D D6 — adapter-agnostic approval-card delivery.
 *
 * Approval flows in 4D (sender-approval, channel-approval, OneCLI bridge,
 * ask_question) all create rows in `pending_approvals` (+ a paired 4D
 * row) and need to surface a card to a human approver. Card delivery
 * itself was deferred to this task because v1's channel adapters don't
 * expose a unified card-with-buttons API today — only `sendMessage`.
 *
 * Strategy: ship a small registry of channel-aware delivery functions
 * keyed by `channel_type`. Each adapter can register a richer
 * implementation (Telegram inline keyboard, Slack blocks, …) at startup.
 * If no adapter is registered for the target channel, we fall back to a
 * plain-text `sendMessage` via the supplied `sendMessage` function —
 * the human still sees the card title/body and can reply with the
 * option label, which a future click-routing path can match.
 *
 * The API is intentionally minimal so per-adapter wiring is a follow-on
 * task and not a blocker for the rest of D6 (replay-on-approve,
 * click-routing). v2 reference: src/delivery.ts +
 * src/modules/approvals/primitive.ts:196-217.
 */
import { getDb } from '../db/init.js';
import { logger } from '../logger.js';

// ── Module-level fallback sender ──────────────────────────────────────────
//
// Mirrors the setReplayHook pattern in approval-replay.ts. Wired at startup
// from index.ts so that deliverApprovalCard always has a plain-text path even
// when no per-channel ApprovalCardDeliverer has been registered and no
// per-call options.fallbackSendMessage was supplied.

type FallbackSendMessage = (channel_type: string, platform_id: string, text: string) => Promise<string | undefined>;

let fallbackSender: FallbackSendMessage | undefined;

/**
 * Wire the host's outbound message-send function as the plain-text
 * fallback for approval-card delivery. Called from index.ts at startup,
 * mirroring setReplayHook. Mostly used when no per-channel adapter has
 * registered an ApprovalCardDeliverer.
 */
export function setApprovalFallbackSender(sender: FallbackSendMessage): void {
  fallbackSender = sender;
}

export function clearApprovalFallbackSender(): void {
  fallbackSender = undefined;
}

/**
 * Card payload — common surface every adapter must accept, even if it
 * downgrades to plain text when the channel doesn't support buttons.
 */
export interface ApprovalCard {
  approval_id: string;
  /** The approver's resolved DM channel kind ("telegram", "whatsapp", …). */
  channel_type: string;
  /** The approver's DM target on that channel. */
  platform_id: string;
  /** Card title — short, human-readable. */
  title: string;
  /** Card body — multi-line allowed. */
  body: string;
  /** Approve/reject options, with stable `id`s used for click routing. */
  options: Array<{ id: string; label: string }>;
  /** Optional thread/reply id for adapters that thread their cards. */
  thread_id?: string;
}

export interface DeliveryResult {
  /** True if the adapter (or fallback) reported the card was delivered. */
  delivered: boolean;
  /**
   * Platform-native message id, when the adapter can provide one. Used to
   * persist `pending_approvals.platform_message_id` so a future "edit
   * card to Approved/Rejected/Expired" path can find the original.
   */
  platform_message_id?: string;
  /** Adapter-supplied diagnostic on failure. */
  error?: string;
}

/**
 * One implementation per channel kind. Adapters register themselves at
 * startup so the delivery dispatcher can route each card to the right
 * place. Returning `delivered:false` (or throwing) signals that the
 * caller should fall back to plain-text or accept the card is parked.
 */
export type ApprovalCardDeliverer = (card: ApprovalCard) => Promise<DeliveryResult>;

const deliverers = new Map<string, ApprovalCardDeliverer>();

/**
 * Register a per-channel delivery adapter. Idempotent — a second call
 * for the same channel overwrites the previous handler with a warning
 * (mirroring the approval-primitive registry).
 */
export function registerApprovalDeliverer(channel: string, fn: ApprovalCardDeliverer): void {
  if (deliverers.has(channel)) {
    logger.warn({ channel }, 'registerApprovalDeliverer: channel already registered, overwriting');
  }
  deliverers.set(channel, fn);
}

export function getApprovalDeliverer(channel: string): ApprovalCardDeliverer | undefined {
  return deliverers.get(channel);
}

export function clearApprovalDeliverers(): void {
  deliverers.clear();
}

/**
 * Plain-text fallback used when no per-channel adapter is registered.
 * Renders the card as a single message (title, body, then "Reply '<id>'
 * to <label>" lines). The `sendMessage` injection mirrors what
 * `routeOutbound` does in src/router.ts.
 *
 * Best-effort: if `sendMessage` is undefined or throws, returns
 * `delivered:false` so the caller can log and move on without
 * cancelling the approval.
 */
export async function deliverApprovalCardAsText(
  card: ApprovalCard,
  sendMessage: ((jid: string, text: string) => Promise<void>) | undefined,
): Promise<DeliveryResult> {
  if (!sendMessage) {
    return { delivered: false, error: 'no-sendMessage' };
  }
  const optionLines = card.options
    .map((o) => `- Reply "${o.id}" to ${o.label}`)
    .join('\n');
  const text = [card.title, '', card.body, '', optionLines, '', `(approval: ${card.approval_id})`]
    .filter(Boolean)
    .join('\n');
  try {
    await sendMessage(card.platform_id, text);
    return { delivered: true };
  } catch (err) {
    return {
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DeliverApprovalCardOptions {
  /**
   * Plain-text sender used when no channel adapter is registered or
   * the registered one returns `delivered:false`. Optional — when not
   * supplied, the dispatcher only tries the registered adapter.
   */
  fallbackSendMessage?: (jid: string, text: string) => Promise<void>;
  /**
   * If true, persist `pending_approvals.platform_message_id` after a
   * successful delivery. Defaults to true; tests can pass false to
   * keep the row pristine.
   */
  persistPlatformMessageId?: boolean;
}

/**
 * Top-level dispatcher. Tries the registered adapter for the card's
 * channel first; on miss or failure, falls back to plain-text via the
 * supplied `sendMessage`. Always best-effort — never throws.
 *
 * On a successful delivery that yields a `platform_message_id`, the
 * dispatcher writes it to the paired `pending_approvals` row so future
 * "edit card to Resolved" paths can target the original message.
 */
export async function deliverApprovalCard(
  card: ApprovalCard,
  options: DeliverApprovalCardOptions = {},
): Promise<DeliveryResult> {
  const persist = options.persistPlatformMessageId ?? true;

  // Try registered adapter first.
  const adapter = deliverers.get(card.channel_type);
  if (adapter) {
    try {
      const result = await adapter(card);
      if (result.delivered) {
        if (persist && result.platform_message_id) {
          persistPlatformMessageId(card.approval_id, result.platform_message_id);
        }
        return result;
      }
      logger.debug(
        { approval_id: card.approval_id, channel: card.channel_type, error: result.error },
        'Approval-card adapter returned delivered:false; falling back to plain text',
      );
    } catch (err) {
      logger.warn(
        { approval_id: card.approval_id, channel: card.channel_type, err },
        'Approval-card adapter threw; falling back to plain text',
      );
    }
  }

  // Plain-text fallback: prefer explicit per-call option, fall back to
  // the module-level sender wired at startup (setApprovalFallbackSender).
  let plainTextSender = options.fallbackSendMessage;
  if (!plainTextSender && fallbackSender) {
    const moduleSender = fallbackSender;
    plainTextSender = (jid, text) => moduleSender(card.channel_type, jid, text).then(() => undefined);
  }

  const fallback = await deliverApprovalCardAsText(card, plainTextSender);
  if (fallback.delivered && persist && fallback.platform_message_id) {
    persistPlatformMessageId(card.approval_id, fallback.platform_message_id);
  }
  if (!fallback.delivered) {
    logger.warn(
      { approval_id: card.approval_id, channel: card.channel_type, error: fallback.error },
      'Approval-card delivery fully failed (no adapter, no fallback)',
    );
  }
  return fallback;
}

function persistPlatformMessageId(approvalId: string, platformMessageId: string): void {
  // Direct UPDATE — no row state change, just persisting the
  // platform-side message id so a future "edit card to Resolved/Expired"
  // path can target the original message.
  try {
    getDb()
      .prepare(`UPDATE pending_approvals SET platform_message_id = ? WHERE approval_id = ?`)
      .run(platformMessageId, approvalId);
  } catch (err) {
    logger.warn({ approvalId, err }, 'persistPlatformMessageId failed');
  }
}
