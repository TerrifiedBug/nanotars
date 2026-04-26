/**
 * Phase 4D D3 — unknown-channel registration flow.
 *
 * When the orchestrator hits an inbound message whose
 * (channel, platform_id) does not resolve to any messaging_group_agents
 * wiring, the message is no longer silently dropped. Instead, this
 * module persists a `pending_channel_approvals` row + a paired
 * `pending_approvals` row and surfaces an Approve / Reject card to an
 * admin via 4C's approval primitive.
 *
 * On approve:
 *   - Create a wiring (engage_mode='always', engage_pattern='.',
 *     sender_scope='known' — the conservative default; admin can flip)
 *   - Add the original sender as the first member so sender_scope='known'
 *     does not bounce the next message
 *
 * On reject:
 *   - Set messaging_groups.denied_at = now() so future messages from this
 *     channel short-circuit (sticky deny)
 *
 * Dedup invariant: pending_channel_approvals PRIMARY KEY is
 * messaging_group_id — a second `requestChannelApproval` call for the
 * same chat while a card is in-flight returns alreadyPending=true and
 * does not write a second row.
 *
 * Schema reference: src/db/init.ts PENDING_CHANNEL_APPROVALS_DDL.
 * v2 reference: /data/nanoclaw-v2/src/modules/permissions/channel-approval.ts.
 */
import { getDb } from '../db/init.js';
import {
  registerApprovalHandler,
  requestApproval,
} from './approval-primitive.js';
import {
  getMessagingGroup,
  getMessagingGroupById,
  createMessagingGroup,
  createWiring,
  getAgentGroupByFolder,
  createAgentGroup,
  getAllAgentGroups,
} from '../db/agent-groups.js';
import { addMember } from './agent-group-members.js';
import { logger } from '../logger.js';

export const CHANNEL_APPROVAL_ACTION = 'channel-approval';

/**
 * In-DB shape of a pending_channel_approvals row.
 *
 * Schema (per migration 017 / PENDING_CHANNEL_APPROVALS_DDL):
 *   - messaging_group_id (PK, FK -> messaging_groups.id)
 *   - agent_group_id     (NOT NULL, FK -> agent_groups.id) — target wire candidate
 *   - original_message   (NOT NULL TEXT)                   — JSON-serialized inbound event
 *   - approver_user_id   (NOT NULL, FK -> users.id)        — who got the card
 *   - approval_id        (FK -> pending_approvals.approval_id) — paired 4C row
 *   - title              (NOT NULL DEFAULT '')             — card render
 *   - options_json       (NOT NULL DEFAULT '[]')           — card render
 *   - created_at         (NOT NULL)
 */
export interface PendingChannelApproval {
  messaging_group_id: string;
  agent_group_id: string;
  original_message: string;
  approver_user_id: string;
  approval_id: string | null;
  title: string;
  options_json: string;
  created_at: string;
}

export function createPendingChannelApproval(row: PendingChannelApproval): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_channel_approvals (
         messaging_group_id, agent_group_id, original_message, approver_user_id,
         approval_id, title, options_json, created_at
       ) VALUES (
         @messaging_group_id, @agent_group_id, @original_message, @approver_user_id,
         @approval_id, @title, @options_json, @created_at
       )`,
    )
    .run(row);
  return result.changes > 0;
}

export function getPendingChannelApproval(messagingGroupId: string): PendingChannelApproval | undefined {
  return getDb()
    .prepare(`SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?`)
    .get(messagingGroupId) as PendingChannelApproval | undefined;
}

export function getPendingChannelApprovalByApprovalId(approvalId: string): PendingChannelApproval | undefined {
  return getDb()
    .prepare(`SELECT * FROM pending_channel_approvals WHERE approval_id = ?`)
    .get(approvalId) as PendingChannelApproval | undefined;
}

export function deletePendingChannelApproval(messagingGroupId: string): void {
  getDb()
    .prepare(`DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?`)
    .run(messagingGroupId);
}

export function setMessagingGroupDeniedAt(messagingGroupId: string, deniedAt: string): void {
  getDb()
    .prepare(`UPDATE messaging_groups SET denied_at = ? WHERE id = ?`)
    .run(deniedAt, messagingGroupId);
}

/**
 * Sticky-deny check. True when the messaging_group has `denied_at` set
 * (either by an admin's reject click or by a prior soft-deny mechanism).
 *
 * Note: `MessagingGroup` typing in src/types.ts does not yet expose
 * `denied_at` (it's only present at the DB layer). We query the column
 * directly here to avoid a wider type change for D3.
 */
export function isMessagingGroupDenied(messagingGroupId: string): boolean {
  const row = getDb()
    .prepare(`SELECT denied_at FROM messaging_groups WHERE id = ?`)
    .get(messagingGroupId) as { denied_at: string | null } | undefined;
  return row?.denied_at != null;
}

interface ChannelApprovalPayload extends Record<string, unknown> {
  channel_type: string;
  platform_id: string;
  messaging_group_id: string;
  agent_group_id: string;
  chat_name?: string | null;
  sender_user_id?: string | null;
  proposed_folder?: string | null;
}

/**
 * Slugify a chat name (or fall back to platform_id) into a folder-safe
 * identifier. Used as the proposed agent-group folder when the request
 * does not provide one explicitly.
 */
function generateFolderName(chatName?: string | null, platformId?: string): string {
  const base = (chatName ?? platformId ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base || 'channel';
}

/**
 * Register the channel-approval handler with 4C's primitive. Called once
 * during host startup (orchestrator construction). The handler pattern
 * mirrors D2's registerSenderApprovalHandler — render produces the card
 * payload; applyDecision is invoked when the admin clicks.
 */
export function registerChannelApprovalHandler(): void {
  registerApprovalHandler(CHANNEL_APPROVAL_ACTION, {
    render: ({ payload }) => {
      const p = payload as ChannelApprovalPayload;
      return {
        title: 'New channel registration',
        body: `Register chat ${p.channel_type}:${p.platform_id} as agent group?`,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject (sticky)' },
        ],
      };
    },
    applyDecision: ({ approvalId, payload, decision }) => {
      const p = payload as ChannelApprovalPayload;
      const pending = getPendingChannelApproval(p.messaging_group_id);

      if (decision === 'approved') {
        const folder = p.proposed_folder ?? generateFolderName(p.chat_name, p.platform_id);
        let ag = getAgentGroupByFolder(folder);
        if (!ag) {
          ag = createAgentGroup({ name: p.chat_name ?? folder, folder });
        }
        // Ensure the messaging_group still exists (it should — we created
        // it in requestChannelApproval before the approval row went out).
        let mg = getMessagingGroupById(p.messaging_group_id);
        if (!mg) {
          mg = createMessagingGroup({
            channel_type: p.channel_type,
            platform_id: p.platform_id,
            name: p.chat_name ?? null,
          });
        }
        createWiring({
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'always',
          engage_pattern: '.',
          sender_scope: 'known',
        });
        if (p.sender_user_id) {
          addMember({
            user_id: p.sender_user_id,
            agent_group_id: ag.id,
            added_by: pending?.approver_user_id ?? null,
          });
        }
        logger.info(
          { channel_type: p.channel_type, platform_id: p.platform_id, folder, agentGroupId: ag.id },
          'Channel registered (approved)',
        );
      } else {
        // Reject (or expired) → sticky deny on messaging_groups.denied_at
        setMessagingGroupDeniedAt(p.messaging_group_id, new Date().toISOString());
        logger.info(
          { channel_type: p.channel_type, platform_id: p.platform_id, decision },
          'Channel registration denied (sticky)',
        );
      }

      // TODO(D6): replay original message after approve so the original
      // sender's prompt actually reaches the freshly-wired agent.

      // Cleanup the pending row regardless of decision.
      if (pending) {
        deletePendingChannelApproval(pending.messaging_group_id);
      }
      // Note: 4C's approval-primitive currently leaves the pending_approvals
      // row in place after applyDecision; the central card-expiry sweep
      // tidies it up. Mirrors D2's behavior.
    },
  });
}

export interface RequestChannelApprovalArgs {
  channel_type: string;
  platform_id: string;
  chat_name?: string;
  sender_user_id?: string;
  proposed_folder?: string;
}

export interface RequestChannelApprovalResult {
  approvalId: string;
  alreadyPending: boolean;
  denied: boolean;
}

/**
 * Issue a channel-registration approval card if one is not already in
 * flight and the channel is not under sticky deny.
 *
 * Failure modes (each returns a result with empty approvalId, the caller
 * logs and moves on):
 *   - sticky-denied messaging group (denied=true)
 *   - already an in-flight pending row (alreadyPending=true)
 *   - no agent groups configured (returns approvalId='')
 *   - no eligible approver (returns approvalId='', no row written)
 *   - no DM channel for any approver (returns approvalId='', no row written)
 */
export async function requestChannelApproval(
  args: RequestChannelApprovalArgs,
): Promise<RequestChannelApprovalResult> {
  // 1. Sticky deny check — only meaningful if mg already exists.
  let mg = getMessagingGroup(args.channel_type, args.platform_id);
  if (mg && isMessagingGroupDenied(mg.id)) {
    return { approvalId: '', alreadyPending: false, denied: true };
  }

  // 2. In-flight dedup — only meaningful if mg already exists.
  if (mg) {
    const existing = getPendingChannelApproval(mg.id);
    if (existing) {
      return {
        approvalId: existing.approval_id ?? '',
        alreadyPending: true,
        denied: false,
      };
    }
  }

  // 3. Pick a target agent group. MVP: first by created_at (matches v2).
  // If none exist, the install hasn't run /init-first-agent yet; warn and
  // return empty.
  const agentGroups = getAllAgentGroups();
  if (agentGroups.length === 0) {
    logger.warn(
      { channel_type: args.channel_type, platform_id: args.platform_id },
      'Channel registration skipped — no agent groups configured. Run /init-first-agent.',
    );
    return { approvalId: '', alreadyPending: false, denied: false };
  }
  const target = agentGroups[0];

  // 4. Ensure messaging_group exists (FK target for pending_channel_approvals).
  if (!mg) {
    mg = createMessagingGroup({
      channel_type: args.channel_type,
      platform_id: args.platform_id,
      name: args.chat_name ?? null,
    });
  }

  // 5. Build the payload + request the approval. The primitive picks an
  // approver via pickApprover/pickApprovalDelivery and persists a
  // pending_approvals row keyed by approvalId; we then write our 4D row
  // referencing that approvalId.
  const payload: ChannelApprovalPayload = {
    channel_type: args.channel_type,
    platform_id: args.platform_id,
    messaging_group_id: mg.id,
    agent_group_id: target.id,
    chat_name: args.chat_name ?? null,
    sender_user_id: args.sender_user_id ?? null,
    proposed_folder: args.proposed_folder ?? null,
  };

  const result = await requestApproval({
    action: CHANNEL_APPROVAL_ACTION,
    agentGroupId: target.id,
    payload,
    originatingChannel: args.channel_type,
  });

  // No approver / no DM → don't persist a 4D row. The 4C row already
  // exists (with NULL channel_type/platform_id) but is unreachable;
  // a future request can try again once an approver/DM is configured.
  if (!result.deliveryTarget) {
    logger.warn(
      {
        channel_type: args.channel_type,
        platform_id: args.platform_id,
        targetAgentGroupId: target.id,
      },
      'Channel registration card not delivered — no approver or DM available',
    );
    return { approvalId: result.approvalId, alreadyPending: false, denied: false };
  }

  // 6. Write the paired pending_channel_approvals row.
  const card = {
    title: 'New channel registration',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject (sticky)' },
    ],
  };
  createPendingChannelApproval({
    messaging_group_id: mg.id,
    agent_group_id: target.id,
    original_message: JSON.stringify({
      channel_type: args.channel_type,
      platform_id: args.platform_id,
      chat_name: args.chat_name,
      sender_user_id: args.sender_user_id,
    }),
    approver_user_id: result.deliveryTarget.userId,
    approval_id: result.approvalId,
    title: card.title,
    options_json: JSON.stringify(card.options),
    created_at: new Date().toISOString(),
  });

  // TODO(D6): actually deliver the card via the channel adapter. 4C's
  // primitive persists the row but defers wire-up; D2/D3 inherit that.

  return {
    approvalId: result.approvalId,
    alreadyPending: false,
    denied: false,
  };
}
