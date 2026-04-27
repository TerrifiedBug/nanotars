/**
 * Click-auth for approval cards.
 *
 * Phase 4C C4: when a user clicks an approve/reject button on an approval
 * card, validate that the clicker is either the approver themselves OR an
 * admin who can act on the approver's behalf, before applying the decision.
 *
 * Mirrors v2's inline check at src/modules/permissions/index.ts (the
 * `clickerId === row.approver_user_id || hasAdminPrivilege(...)` guard).
 * v1 splits this into a small standalone module so the chat-sdk wiring
 * (which doesn't exist in v1 yet — Phase 4D's D6) can call it directly.
 *
 * Status notes:
 *   - pending_approvals.status default is `'pending'` (see APPROVALS_DDL in
 *     src/db/init.ts). We only act on rows whose status is still `'pending'`;
 *     anything else (`approved`, `rejected`, `expired`) means another click
 *     already won the race or the row has been resolved.
 *   - We DO NOT delete rows on click — `updateApprovalStatus` flips the
 *     state, and the caller / sweep is free to GC later.
 */
import {
  getPendingApproval,
  updateApprovalStatus,
  getApprovalHandler,
} from './approval-primitive.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from './user-roles.js';
import { logger } from '../logger.js';
import { editApprovalCardOnDecision } from './approval-delivery.js';

export interface ClickAuthDecision {
  authorized: boolean;
  reason: string;
}

/**
 * Pure auth check: is `clicker_user_id` allowed to act on this approval?
 *
 * Rules (in order):
 *   1. clicker is the picked approver  → 'approver-self'
 *   2. clicker is a global owner       → 'owner-override'
 *   3. clicker is a global admin       → 'global-admin-override'
 *   4. clicker is a scoped admin of    → 'scoped-admin-override'
 *      the approval's agent_group_id
 *   5. otherwise                       → not authorized
 *
 * The approver_user_id can be null (the approval was persisted with no
 * deliverable approver — see C2 / C3). In that case, only owner / admin
 * paths grant authorization.
 */
export function isAuthorizedClicker(args: {
  clicker_user_id: string;
  approver_user_id: string | null;
  agent_group_id: string | null;
}): ClickAuthDecision {
  if (args.approver_user_id && args.clicker_user_id === args.approver_user_id) {
    return { authorized: true, reason: 'approver-self' };
  }
  if (isOwner(args.clicker_user_id)) {
    return { authorized: true, reason: 'owner-override' };
  }
  if (isGlobalAdmin(args.clicker_user_id)) {
    return { authorized: true, reason: 'global-admin-override' };
  }
  if (args.agent_group_id && isAdminOfAgentGroup(args.clicker_user_id, args.agent_group_id)) {
    return { authorized: true, reason: 'scoped-admin-override' };
  }
  return { authorized: false, reason: 'not-approver-not-admin' };
}

export interface HandleApprovalClickArgs {
  approval_id: string;
  clicker_user_id: string;
  decision: 'approved' | 'rejected';
}

export interface HandleApprovalClickResult {
  success: boolean;
  reason: string;
}

/**
 * Full click-handling pipeline:
 *   1. Look up the pending approval row.
 *   2. Reject if missing or already-resolved.
 *   3. Auth-check the clicker against the picked approver + role table.
 *   4. Flip the row status, then call the registered handler's applyDecision
 *      (if any). applyDecision errors are caught + logged so a misbehaving
 *      handler can't strand the row in `pending` forever.
 *
 * Returns `{ success, reason }` so the chat adapter can render an
 * appropriate ack ("done", "you can't click this", "already approved",
 * "expired", …) without re-reading the DB.
 *
 * NOTE: There's a small race between `updateApprovalStatus` and
 * `applyDecision`. The handler may observe `decision='approved'` even if
 * `applyDecision` later throws. That's intentional — making the action
 * idempotent is the handler's job; making the click visible is ours.
 */
export async function handleApprovalClick(
  args: HandleApprovalClickArgs,
): Promise<HandleApprovalClickResult> {
  const approval = getPendingApproval(args.approval_id);
  if (!approval) {
    logger.warn(
      { approval_id: args.approval_id, clicker_user_id: args.clicker_user_id },
      'Approval click ignored: approval row not found',
    );
    return { success: false, reason: 'approval-not-found' };
  }

  const status = approval.status as string | undefined;
  if (status !== 'pending') {
    logger.info(
      { approval_id: args.approval_id, status, clicker_user_id: args.clicker_user_id },
      'Approval click ignored: already resolved',
    );
    return { success: false, reason: `already-${status ?? 'unknown'}` };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(approval.payload as string);
  } catch (err) {
    logger.error(
      { approval_id: args.approval_id, err },
      'Approval click failed: payload JSON.parse threw',
    );
    return { success: false, reason: 'payload-parse-error' };
  }

  const approver_user_id =
    typeof payload._picked_approver_user_id === 'string'
      ? (payload._picked_approver_user_id as string)
      : null;
  const agent_group_id =
    typeof approval.agent_group_id === 'string' ? (approval.agent_group_id as string) : null;

  const auth = isAuthorizedClicker({
    clicker_user_id: args.clicker_user_id,
    approver_user_id,
    agent_group_id,
  });

  if (!auth.authorized) {
    logger.warn(
      {
        approval_id: args.approval_id,
        clicker_user_id: args.clicker_user_id,
        approver_user_id,
        agent_group_id,
        reason: auth.reason,
      },
      'Approval click rejected: unauthorized clicker',
    );
    return { success: false, reason: auth.reason };
  }

  // Authorized — flip status first so a second concurrent click sees the
  // resolved state, then apply the decision via the registered handler.
  updateApprovalStatus(args.approval_id, args.decision);

  const handler = getApprovalHandler(approval.action as string);
  if (handler?.applyDecision) {
    try {
      await handler.applyDecision({
        approvalId: args.approval_id,
        payload,
        decision: args.decision,
      });
      // Slice 7: edit the original card to show the decision
      // (✅ Approved / ❌ Rejected). Best-effort — failure already
      // swallowed inside editApprovalCardOnDecision; we just await to
      // surface logs.
      await editApprovalCardOnDecision(args.approval_id);
    } catch (err) {
      logger.error(
        { approval_id: args.approval_id, decision: args.decision, err },
        'Approval handler.applyDecision threw — status already updated',
      );
      // Deliberately do NOT roll back the status. The decision was
      // recorded; the side-effect failure is the handler's responsibility
      // to surface elsewhere (retry queue, ops alert, etc.).
    }
  }

  logger.info(
    {
      approval_id: args.approval_id,
      decision: args.decision,
      clicker_user_id: args.clicker_user_id,
      reason: auth.reason,
    },
    'Approval click applied',
  );
  return { success: true, reason: auth.reason };
}
