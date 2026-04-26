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

import { getDb } from '../db/init.js';
import { logger } from '../logger.js';
import {
  pickApprover,
  pickApprovalDelivery,
  type ApprovalDeliveryTarget,
} from './approval-routing.js';
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
 * Send a system message to the requesting agent group. v1 has no clean
 * system-injection path yet — this is a logger.warn stub; the real wiring is
 * deferred to a later task (concern #3 in the C2 plan). Callers should treat
 * notifyAgent as best-effort.
 */
export function notifyAgent(agentGroupId: string | null, text: string): void {
  // TODO(phase-4c+): wire to v1's actual system-message injection path
  // (probably src/group-queue.ts or src/orchestrator.ts). Today the agent
  // never sees these notifications.
  logger.warn({ agentGroupId, text }, 'notifyAgent stub: agent not actually notified');
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
}

export interface RequestApprovalResult {
  approvalId: string;
  approvers: User[];
  deliveryTarget: ApprovalDeliveryTarget | undefined;
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

  // TODO(C4): deliver the card to deliveryTarget via channel adapter.

  return { approvalId, approvers, deliveryTarget };
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
