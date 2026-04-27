/**
 * Phase 4D D2 — pending-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy` is `request_approval`-style
 * (in v1 the gate fires when a wiring's `sender_scope='known'` denies a
 * non-member), the orchestrator no longer silently drops the message. It
 * calls `requestSenderApproval` to:
 *
 *   1. Persist a `pending_approvals` row via 4C's primitive (handles the
 *      approver-pick + DM-target selection + click-auth payload glue).
 *   2. Persist a `pending_sender_approvals` row keyed on
 *      (messaging_group_id, sender_identity) so a duplicate request for the
 *      same unknown sender returns `alreadyPending: true` instead of
 *      double-prompting an admin.
 *   3. On approve (handled by 4C's click-auth pipeline calling our
 *      `applyDecision`): add an `agent_group_members` row for the sender so
 *      the next message routes through cleanly. Replay of the original
 *      message is deferred to D6.
 *
 * Schema note: the actual `pending_sender_approvals` table (D1) uses
 *   id TEXT PK + UNIQUE(messaging_group_id, sender_identity)
 * and carries `approver_user_id`, `original_message`, `title`,
 * `options_json` columns required by the spec's card-rendering contract.
 * This module writes against that schema verbatim — no `message_text`-only
 * shortcut, since the column is `original_message NOT NULL`.
 */
import crypto from 'crypto';

import { getDb } from '../db/init.js';
import { getMessagingGroupById } from '../db/agent-groups.js';
import { logger } from '../logger.js';
import {
  requestApproval,
  registerApprovalHandler,
  type ApprovalDecision,
} from './approval-primitive.js';
import { addMember } from './agent-group-members.js';
import { ensureUser } from './users.js';
import { deliverApprovalCard } from './approval-delivery.js';
import { replayInboundMessage } from './approval-replay.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types + accessors against the actual D1 schema
// ─────────────────────────────────────────────────────────────────────────────

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

export interface CreatePendingSenderApprovalArgs {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name?: string | null;
  original_message: string;
  approver_user_id: string;
  approval_id?: string | null;
  title?: string;
  options_json?: string;
  created_at?: string;
}

/**
 * Create a pending_sender_approvals row. Returns `true` if a row was
 * inserted, `false` if the `(messaging_group_id, sender_identity)` UNIQUE
 * constraint blocked the insert (an in-flight approval already exists for
 * this pair).
 */
export function createPendingSenderApproval(
  args: CreatePendingSenderApprovalArgs,
): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_sender_approvals (
        id, messaging_group_id, agent_group_id, sender_identity, sender_name,
        original_message, approver_user_id, approval_id, title, options_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.id,
      args.messaging_group_id,
      args.agent_group_id,
      args.sender_identity,
      args.sender_name ?? null,
      args.original_message,
      args.approver_user_id,
      args.approval_id ?? null,
      args.title ?? '',
      args.options_json ?? '[]',
      args.created_at ?? new Date().toISOString(),
    );
  return result.changes > 0;
}

/**
 * Look up an in-flight pending_sender_approvals row by the natural key
 * (messaging_group_id, sender_identity). Returns the most recent row (the
 * UNIQUE constraint guarantees at most one matching row, but ORDER BY makes
 * the "most recent wins" semantics explicit if the constraint is ever
 * relaxed).
 */
export function getPendingSenderApproval(args: {
  messaging_group_id: string;
  sender_identity: string;
}): PendingSenderApproval | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM pending_sender_approvals
        WHERE messaging_group_id = ? AND sender_identity = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(args.messaging_group_id, args.sender_identity) as
    | PendingSenderApproval
    | undefined;
}

export function getPendingSenderApprovalById(
  id: string,
): PendingSenderApproval | undefined {
  return getDb()
    .prepare(`SELECT * FROM pending_sender_approvals WHERE id = ?`)
    .get(id) as PendingSenderApproval | undefined;
}

/**
 * Look up a pending_sender_approvals row by its FK to pending_approvals.
 * Used by the applyDecision callback so it can find the agent_group_id
 * + sender_identity it needs to materialize a member row.
 */
export function getPendingSenderApprovalByApprovalId(
  approvalId: string,
): PendingSenderApproval | undefined {
  return getDb()
    .prepare(`SELECT * FROM pending_sender_approvals WHERE approval_id = ?`)
    .get(approvalId) as PendingSenderApproval | undefined;
}

export function deletePendingSenderApproval(args: { id: string }): void {
  getDb().prepare(`DELETE FROM pending_sender_approvals WHERE id = ?`).run(args.id);
}

export function hasInFlightSenderApproval(
  messagingGroupId: string,
  senderIdentity: string,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM pending_sender_approvals
        WHERE messaging_group_id = ? AND sender_identity = ? LIMIT 1`,
    )
    .get(messagingGroupId, senderIdentity);
  return row !== undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval handler — registered with 4C's primitive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The action string used in `pending_approvals.action` and the handler
 * registry key. Kept in sync between request + click-auth response.
 */
export const SENDER_APPROVAL_ACTION = 'sender_approval';

const APPROVE_OPTIONS = [
  { id: 'approve', label: '✅ Allow' },
  { id: 'reject', label: '❌ Deny' },
];

/**
 * Register the sender-approval handler with 4C's approval primitive. Idempotent
 * via the underlying registry — calling twice replaces the handler with a
 * warning log.
 *
 * Must be called once during host init. The orchestrator constructor calls
 * this so we don't have to touch index.ts (which is C6's territory while
 * Phase 4D is in flight).
 */
export function registerSenderApprovalHandler(): void {
  registerApprovalHandler(SENDER_APPROVAL_ACTION, {
    render: ({ payload }) => {
      const senderDisplay =
        (typeof payload.display_name === 'string' && payload.display_name) ||
        (typeof payload.sender_identity === 'string' && payload.sender_identity) ||
        'Someone';
      const folder =
        (typeof payload.agent_group_folder === 'string' && payload.agent_group_folder) ||
        'this agent';
      return {
        title: '👤 New sender',
        body: `${senderDisplay} wants to message ${folder}. Allow?`,
        options: APPROVE_OPTIONS,
      };
    },
    applyDecision: async (args) => {
      await applySenderApprovalDecision(args);
    },
  });
}

/**
 * Apply an approve/reject decision: on `'approved'` add the sender to
 * `agent_group_members`; on `'rejected'` or `'expired'` simply log and
 * delete the pending row. Idempotent — safe to call twice for the same
 * approvalId because addMember is INSERT OR IGNORE and the delete is a
 * no-op when the row is gone.
 *
 * Exported separately from the registered handler so tests can call it
 * directly without going through the click-auth pipeline.
 */
export async function applySenderApprovalDecision(args: {
  approvalId: string;
  payload: Record<string, unknown>;
  decision: ApprovalDecision;
}): Promise<void> {
  const row = getPendingSenderApprovalByApprovalId(args.approvalId);
  if (!row) {
    // Defensive: payload-driven path lets us still act on approve even if
    // the cross-reference row was lost (e.g. manual DB cleanup).
    const userId = typeof args.payload.user_id === 'string' ? args.payload.user_id : null;
    const agentGroupId =
      typeof args.payload.agent_group_id === 'string' ? args.payload.agent_group_id : null;
    if (args.decision === 'approved' && userId && agentGroupId) {
      addMember({ user_id: userId, agent_group_id: agentGroupId });
      logger.info(
        { approvalId: args.approvalId, userId, agentGroupId },
        'Sender approved (no pending_sender_approvals row found, used payload)',
      );
    } else {
      logger.info(
        { approvalId: args.approvalId, decision: args.decision },
        'Sender approval applied without a pending_sender_approvals row',
      );
    }
    return;
  }

  if (args.decision === 'approved') {
    addMember({
      user_id: row.sender_identity,
      agent_group_id: row.agent_group_id,
      added_by: row.approver_user_id,
    });
    logger.info(
      {
        approvalId: args.approvalId,
        sender_identity: row.sender_identity,
        agent_group_id: row.agent_group_id,
      },
      'Sender approved; added to agent_group_members',
    );
    // Phase 4D D6: replay the original message via the host's registered
    // replay hook. The membership change above means the replayed
    // inbound now passes `canAccessAgentGroup`; the hook is best-effort
    // (see approval-replay.ts) so a missing/broken hook does not roll
    // back the approve. We synthesize the platform-side sender handle
    // by stripping the `<channel>:` prefix that resolveSender added.
    if (row.original_message) {
      const colonIdx = row.sender_identity.indexOf(':');
      const channel_type =
        colonIdx > 0 ? row.sender_identity.slice(0, colonIdx) : 'unknown';
      const sender_handle =
        colonIdx > 0 ? row.sender_identity.slice(colonIdx + 1) : row.sender_identity;
      // Look up messaging_group → platform_id for the chat we should
      // replay into. Avoid a circular import on db/agent-groups by
      // doing the lookup with the raw db handle.
      const mg = getDb()
        .prepare(`SELECT platform_id, channel_type FROM messaging_groups WHERE id = ?`)
        .get(row.messaging_group_id) as { platform_id: string; channel_type: string } | undefined;
      if (mg) {
        await replayInboundMessage({
          channel_type: mg.channel_type ?? channel_type,
          platform_id: mg.platform_id,
          sender_handle,
          sender_name: row.sender_name,
          message_text: row.original_message,
          agent_group_id: row.agent_group_id,
          replay_id: `sender-${args.approvalId}`,
        });
      }
    }
  } else {
    logger.info(
      {
        approvalId: args.approvalId,
        sender_identity: row.sender_identity,
        decision: args.decision,
      },
      'Sender rejected',
    );
  }

  deletePendingSenderApproval({ id: row.id });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public request flow
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestSenderApprovalArgs {
  /** Namespaced user id `<channel>:<sender_handle>`. */
  user_id: string;
  /** Agent group the sender is trying to reach. */
  agent_group_id: string;
  /** Folder name for nicer card copy. */
  agent_group_folder: string;
  /** Originating chat (UNIQUE part 1). */
  messaging_group_id: string;
  /** Platform-level sender handle, namespaced (UNIQUE part 2). */
  sender_identity: string;
  /** Best-known display name for the card. */
  display_name?: string;
  /** The raw inbound message — stored so D6 can replay on approve. */
  message_text?: string;
  /** Originating channel type (drives same-kind DM preference). */
  originating_channel?: string;
}

export interface RequestSenderApprovalResult {
  approvalId: string;
  alreadyPending: boolean;
}

/**
 * Idempotent: a second call for the same `(messaging_group_id, sender_identity)`
 * pair returns the existing approval's id with `alreadyPending: true`
 * instead of issuing a fresh card.
 *
 * Failure modes (no row created, returns `alreadyPending: false` with the
 * approval id from the primitive):
 *   - 4C primitive could not pick an approver / DM target — the
 *     pending_approvals row is still persisted (NULL channel) per 4C's
 *     contract; we don't write a pending_sender_approvals row in that case
 *     because there's no admin to receive the card.
 *
 * The caller (orchestrator) should also drop the inbound message regardless
 * — replay is deferred to D6.
 */
export async function requestSenderApproval(
  args: RequestSenderApprovalArgs,
): Promise<RequestSenderApprovalResult> {
  // Dedup gate. Cheap query against the UNIQUE index.
  const existing = getPendingSenderApproval({
    messaging_group_id: args.messaging_group_id,
    sender_identity: args.sender_identity,
  });
  if (existing) {
    return { approvalId: existing.approval_id ?? existing.id, alreadyPending: true };
  }

  // Lazy-create the users row so downstream addMember has something to
  // FK to on approve. The kind comes from the `<channel>:` prefix on the
  // namespaced user id; falling back to 'unknown' keeps the row valid even
  // for malformed identities.
  const kind = args.user_id.includes(':') ? args.user_id.split(':')[0] : 'unknown';
  ensureUser({
    id: args.user_id,
    kind,
    display_name: args.display_name ?? null,
  });

  // Resolve originating channel kind for the same-channel-DM preference.
  let originatingChannel = args.originating_channel ?? '';
  if (!originatingChannel) {
    const mg = getMessagingGroupById(args.messaging_group_id);
    originatingChannel = mg?.channel_type ?? '';
  }

  const result = await requestApproval({
    action: SENDER_APPROVAL_ACTION,
    agentGroupId: args.agent_group_id,
    payload: {
      user_id: args.user_id,
      agent_group_id: args.agent_group_id,
      agent_group_folder: args.agent_group_folder,
      messaging_group_id: args.messaging_group_id,
      sender_identity: args.sender_identity,
      display_name: args.display_name ?? null,
      message_text: args.message_text ?? null,
    },
    originatingChannel,
    skipDelivery: true,
  });

  // If the primitive couldn't pick a delivery target, there's no admin to
  // receive the card. Skip the cross-reference write — re-issuing the
  // request on the next inbound is preferable to permanently shadowing
  // this sender behind a card that never gets seen.
  if (!result.deliveryTarget) {
    logger.warn(
      {
        messaging_group_id: args.messaging_group_id,
        sender_identity: args.sender_identity,
        agent_group_id: args.agent_group_id,
      },
      'requestSenderApproval: no delivery target — pending_sender_approvals row not written',
    );
    return { approvalId: result.approvalId, alreadyPending: false };
  }

  // Persist the cross-reference. UNIQUE on (messaging_group_id,
  // sender_identity) makes this idempotent: a same-pair concurrent caller
  // will see `inserted=false` and we treat that as "already pending".
  const inserted = createPendingSenderApproval({
    id: `nsa-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    messaging_group_id: args.messaging_group_id,
    agent_group_id: args.agent_group_id,
    sender_identity: args.sender_identity,
    sender_name: args.display_name ?? null,
    original_message: args.message_text ?? '',
    approver_user_id: result.deliveryTarget.userId,
    approval_id: result.approvalId,
    title: '👤 New sender',
    options_json: JSON.stringify(APPROVE_OPTIONS),
  });

  if (!inserted) {
    // Race: a concurrent caller won. Re-fetch and report alreadyPending.
    const winner = getPendingSenderApproval({
      messaging_group_id: args.messaging_group_id,
      sender_identity: args.sender_identity,
    });
    return {
      approvalId: winner?.approval_id ?? result.approvalId,
      alreadyPending: true,
    };
  }

  // Phase 4D D6: deliver the card to the approver. Best-effort — if no
  // adapter is registered for the approver's DM channel and no fallback
  // sender is supplied (current default), the card is still queryable
  // via pending_approvals/admin tooling. Per-channel button rendering
  // (Telegram inline keyboards, Slack blocks) is per-adapter follow-on
  // work registered via `registerApprovalDeliverer`.
  if (result.card && result.deliveryTarget) {
    void deliverApprovalCard({
      approval_id: result.approvalId,
      channel_type: result.deliveryTarget.messagingGroup.channel_type,
      platform_id: result.deliveryTarget.messagingGroup.platform_id,
      title: result.card.title,
      body: result.card.body,
      options: result.card.options,
    }).catch((err) =>
      logger.warn({ err, approvalId: result.approvalId }, 'sender-approval: deliverApprovalCard failed'),
    );
  }

  return { approvalId: result.approvalId, alreadyPending: false };
}
