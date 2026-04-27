/**
 * Approval primitive — request an admin approval, register handlers for
 * action-specific apply logic.
 *
 * Phase 4C C2 port of v2's src/modules/approvals/primitive.ts, adapted for
 * v1-archive's per-group-container model:
 *   - v2 keys requests to a `Session` object; v1 has no sessions table, so
 *     we key to `agentGroupId` directly.
 *   - v2's pickApprover returns string[]; v1 (C3) returns User[]. We embed
 *     the picked approver's id into the persisted payload as
 *     `_picked_approver_user_id` for C4's click-auth lookup, mirroring v2's
 *     `payload.approver` slot but with a name that's unambiguous on this side.
 *   - notifyAgent is a logger-warn stub today (concern #3 in the plan): v1
 *     has no clean per-group system-message injection path yet. Container-
 *     side wiring lands in a later task.
 *   - Card delivery to deliveryTarget is TODO(C4): the primitive currently
 *     persists the row and returns {approvalId, approvers, deliveryTarget}
 *     so callers (OneCLI bridge in C6, install_packages in Phase 5) can
 *     handle delivery themselves if needed.
 */
import crypto from 'crypto';

import {
  getAgentGroupById,
  getMessagingGroupById,
  getWiringForAgentGroup,
} from '../db/agent-groups.js';
import { dbEvents, getDb } from '../db/init.js';
import { insertExternalMessage } from '../db/messages.js';
import { logger } from '../logger.js';
import {
  pickApprover,
  pickApprovalDelivery,
  type ApprovalDeliveryTarget,
} from './approval-routing.js';
import { deliverApprovalCard } from './approval-delivery.js';
import type { User } from '../types.js';

/**
 * Decision returned by an approval handler when the user clicks/types.
 */
export type ApprovalDecision = 'approved' | 'rejected' | 'expired';

/**
 * Handler registry for approval actions. Each unique `action` string maps to
 * a handler that knows how to render the card AND apply the decision.
 *
 * Example actions: 'onecli_credential', 'install_packages', 'register_group'.
 */
export interface ApprovalHandler {
  /** Render the approval card payload (text + buttons) for delivery. */
  render: (args: { approvalId: string; payload: Record<string, unknown> }) => {
    title: string;
    body: string;
    options: Array<{ id: string; label: string }>;
  };
  /** Apply the decision when the approver clicks. Should be idempotent. */
  applyDecision?: (args: {
    approvalId: string;
    payload: Record<string, unknown>;
    decision: ApprovalDecision;
  }) => Promise<void> | void;
}

const handlerRegistry = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (handlerRegistry.has(action)) {
    logger.warn({ action }, 'registerApprovalHandler: action already registered, overwriting');
  }
  handlerRegistry.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return handlerRegistry.get(action);
}

export function clearApprovalHandlers(): void {
  handlerRegistry.clear();
}

/**
 * Send a system message to the requesting agent group. Phase 5C-05 wires
 * this to v1's existing inbound-message pipeline:
 *
 *   1. Look up the agent group's first wiring → messaging_group → chat_jid.
 *   2. Insert a row into `messages` (via insertExternalMessage so the path
 *      mirrors Phase 4D D6's replay hook — same shape, same dbEvents emit).
 *   3. The orchestrator's message loop is awoken by dbEvents.emit
 *      ('new-message', chatJid) and picks the synthetic message up on its
 *      next iteration via getMessagesSince.
 *
 * The injected row sets sender='system', sender_name='system', and the
 * content is prefixed with `[system] ` for visual disambiguation; it is
 * NOT marked is_bot_message so it remains visible to the agent. v1's
 * getMessagesSince filter strips bot messages but lets system messages
 * through. The injected row also avoids the `<assistantName>:` content
 * prefix backstop in db/messages.ts so the filter doesn't drop it.
 *
 * Multi-wiring agent groups: notifyAgent picks the highest-priority wiring
 * (`getWiringForAgentGroup` orders by priority DESC, created_at). For
 * single-channel agents this is the only wiring; for multi-channel agents
 * this is the same as their primary chat. Routing to a different channel
 * is out of scope here — callers can pass the originating channel via the
 * approval-card delivery path if they need cross-channel feedback.
 *
 * Best-effort: if no wiring exists yet, the call logs and returns. The
 * approval card itself reaches the admin via a separate path (4C
 * primitive's deliveryTarget), so the human always sees the decision —
 * the agent's view is the only thing that goes silent here.
 */
export function notifyAgent(agentGroupId: string | null, text: string): void {
  if (!agentGroupId) {
    logger.warn({ text }, 'notifyAgent: no agent group id provided');
    return;
  }

  const ag = getAgentGroupById(agentGroupId);
  if (!ag) {
    logger.warn({ agentGroupId, text }, 'notifyAgent: agent group not found');
    return;
  }

  const wirings = getWiringForAgentGroup(agentGroupId);
  if (wirings.length === 0) {
    logger.warn(
      { agentGroupId, text },
      'notifyAgent: agent group has no wirings; cannot inject system message',
    );
    return;
  }

  const mg = getMessagingGroupById(wirings[0].messaging_group_id);
  if (!mg) {
    logger.warn(
      { agentGroupId, messagingGroupId: wirings[0].messaging_group_id, text },
      'notifyAgent: wiring messaging_group missing; cannot inject',
    );
    return;
  }

  const chatJid = mg.platform_id;
  // Namespace the message id so concurrent notifies (e.g. apply + notifyAfter
  // pair) don't collide. INSERT OR REPLACE on a duplicate id would silently
  // overwrite, which is correct (idempotent retry) but namespacing keeps
  // distinct messages distinct.
  const messageId = `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // insertExternalMessage handles storeChatMetadata + INSERT OR REPLACE +
    // dbEvents.emit('new-message', chatJid). Mirrors the replay hook in
    // src/index.ts (Phase 4D D6).
    insertExternalMessage(chatJid, messageId, 'system', 'system', `[system] ${text}`);
    // Belt-and-suspenders dbEvents emit — insertExternalMessage already does
    // it, but we re-emit defensively in case future refactors split the
    // helpers and the emit is overlooked. EventEmitter.emit is cheap.
    dbEvents.emit('new-message', chatJid);
    logger.info(
      { agentGroupId, chatJid, messageId, textLen: text.length },
      'notifyAgent: system message injected',
    );
  } catch (err) {
    logger.error(
      { err, agentGroupId, chatJid, text },
      'notifyAgent: failed to inject system message',
    );
  }
}

export interface RequestApprovalArgs {
  /** Free-form action identifier; matches a registered handler. */
  action: string;
  /** Agent group requesting approval; null for global / no-scope actions. */
  agentGroupId: string | null;
  /** Opaque JSON-serializable payload, persisted into pending_approvals.payload. */
  payload: Record<string, unknown>;
  /** Optional external request id (e.g. OneCLI request id). Defaults to approvalId. */
  request_id?: string | null;
  /** Optional session id; v1 has no sessions table, so usually null. */
  session_id?: string | null;
  /** Optional ISO expiry timestamp. */
  expires_at?: string | null;
  /** Channel kind of the originating message — used for same-channel-kind preference. */
  originatingChannel?: string;
  /**
   * Slice 7: opt out of the hoisted deliverApprovalCard call. Set true if the
   * caller invokes deliverApprovalCard itself (sender-approval.ts,
   * channel-approval.ts, onecli-bridge.ts have custom delivery flows that
   * pre-resolve the deliveryTarget). Defaults to false — most self-mod
   * handlers want auto-delivery.
   */
  skipDelivery?: boolean;
}

export interface RequestApprovalResult {
  approvalId: string;
  approvers: User[];
  deliveryTarget: ApprovalDeliveryTarget | undefined;
  /**
   * Phase 4D D6: rendered card payload for the action's handler. Callers
   * use this to invoke `deliverApprovalCard` themselves so the per-action
   * 4D row can be persisted before delivery. Undefined when no handler
   * was registered for `args.action`.
   */
  card:
    | {
        title: string;
        body: string;
        options: Array<{ id: string; label: string }>;
      }
    | undefined;
}

/**
 * Request an approval. Persists a pending_approvals row, picks an approver
 * via the C3 hierarchy, and returns {approvalId, approvers, deliveryTarget}.
 * Card delivery itself is the caller's responsibility (or C4's wiring) —
 * this primitive only handles the storage + routing decisions.
 */
export async function requestApproval(args: RequestApprovalArgs): Promise<RequestApprovalResult> {
  const handler = handlerRegistry.get(args.action);
  if (!handler) {
    logger.warn({ action: args.action }, 'requestApproval: no handler registered for action');
  }

  const approvers = pickApprover(args.agentGroupId);
  const deliveryTarget = await pickApprovalDelivery(approvers, args.originatingChannel ?? '');

  const approvalId = crypto.randomUUID();

  // Embed picked approver in payload so C4's click-auth can verify identity.
  // Rationale: avoids adding an approver_user_id column on pending_approvals;
  // matches v2's `payload.approver` slot.
  const enrichedPayload: Record<string, unknown> = {
    ...args.payload,
    _picked_approver_user_id: deliveryTarget?.userId ?? null,
  };

  const rendered = handler
    ? handler.render({ approvalId, payload: args.payload })
    : null;
  // Slice 7: option_id length warning. Telegram's callback_data is capped at
  // 64 bytes; format is `approval:<uuid>:<opt.id>` = 46 + len(opt.id). Anything
  // > 18 chars would overflow and the deliverer falls back to text. Warn
  // loudly so handler authors notice. Defense in depth — the Telegram plugin
  // also checks before sending.
  if (rendered) {
    for (const opt of rendered.options ?? []) {
      if (opt.id.length > 18) {
        logger.warn(
          { action: args.action, optionId: opt.id, length: opt.id.length },
          'requestApproval: option id length > 18; will overflow Telegram callback_data and fall back to text',
        );
      }
    }
  }
  const title = rendered?.title ?? args.action;
  const optionsJson = JSON.stringify(rendered?.options ?? []);

  const now = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO pending_approvals (
        approval_id, session_id, request_id, action, payload, created_at,
        agent_group_id, channel_type, platform_id, platform_message_id,
        expires_at, status, title, options_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      approvalId,
      args.session_id ?? null,
      args.request_id ?? approvalId,
      args.action,
      JSON.stringify(enrichedPayload),
      now,
      args.agentGroupId,
      deliveryTarget?.messagingGroup.channel_type ?? null,
      deliveryTarget?.messagingGroup.platform_id ?? null,
      null, // platform_message_id filled in by C4 after card delivery
      args.expires_at ?? null,
      'pending',
      title,
      optionsJson,
    );

  // Slice 7: hoisted delivery. Self-mod handlers used to forget this; now
  // requestApproval itself ensures the card reaches the approver. Custom-flow
  // callers (sender-approval, channel-approval, onecli-bridge) opt out via
  // skipDelivery: true since they invoke deliverApprovalCard themselves.
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

  return {
    approvalId,
    approvers,
    deliveryTarget,
    card: rendered ?? undefined,
  };
}

/**
 * Update the status of a pending approval. Used by C4's click handler.
 */
export function updateApprovalStatus(approvalId: string, status: string): void {
  getDb().prepare(`UPDATE pending_approvals SET status = ? WHERE approval_id = ?`).run(status, approvalId);
}

export function getPendingApproval(approvalId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare(`SELECT * FROM pending_approvals WHERE approval_id = ?`)
    .get(approvalId) as Record<string, unknown> | undefined;
}

export function listPendingApprovalsByAction(action: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT * FROM pending_approvals WHERE action = ? AND status = 'pending' ORDER BY created_at`,
    )
    .all(action) as Array<Record<string, unknown>>;
}

export function deletePendingApproval(approvalId: string): void {
  getDb().prepare(`DELETE FROM pending_approvals WHERE approval_id = ?`).run(approvalId);
}
