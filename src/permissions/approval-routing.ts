import {
  listOwners,
  listGlobalAdmins,
  listAdminsOfAgentGroup,
} from './user-roles.js';
import { getUserDm, ensureUserDm, type ChannelDmAdapter } from './user-dms.js';
import { getUserById } from './users.js';
import type { User, MessagingGroup } from '../types.js';

/**
 * Pick approvers for a credentialed action scoped to an agent group.
 *
 * Hierarchy (matches v2 src/modules/approvals/primitive.ts:pickApprover):
 *   1. Scoped admins of the agent group (skipped when agentGroupId is null)
 *   2. Global admins
 *   3. Owners
 *
 * Returns the User rows resolved from user_roles, deduplicated. A user holding
 * both a scoped-admin and a global-admin grant appears exactly once, in the
 * highest-priority position. Empty list if no eligible approver exists — the
 * caller decides what to do (auto-deny or hold).
 */
export function pickApprover(agentGroupId: string | null): User[] {
  const seen = new Set<string>();
  const out: User[] = [];

  const add = (userId: string): void => {
    if (seen.has(userId)) return;
    seen.add(userId);
    const user = getUserById(userId);
    if (user) out.push(user);
  };

  // Step 1: scoped admins (only if agent_group_id is non-null)
  if (agentGroupId) {
    for (const role of listAdminsOfAgentGroup(agentGroupId)) add(role.user_id);
  }

  // Step 2: global admins
  for (const role of listGlobalAdmins()) add(role.user_id);

  // Step 3: owners
  for (const role of listOwners()) add(role.user_id);

  return out;
}

export interface ApprovalDeliveryTarget {
  userId: string;
  messagingGroup: MessagingGroup;
}

/**
 * Pick the best DM target for one of the approvers, preferring the same
 * channel kind as the originating channel when possible.
 *
 * Two-pass strategy:
 *   1. Cache pass — walk preferred channel order; for each channel check
 *      every approver's `user_dms` cache.
 *   2. Resolution pass — if `channelAdapters` is provided, walk the same
 *      channel order and try `ensureUserDm` for approvers whose `kind`
 *      matches the channel (you cannot DM a Discord user via WhatsApp).
 *
 * The first hit wins. Returns undefined if nobody is reachable.
 */
export async function pickApprovalDelivery(
  approvers: User[],
  originatingChannel: string,
  channelAdapters?: Record<string, ChannelDmAdapter>,
): Promise<ApprovalDeliveryTarget | undefined> {
  // First pass: check the cache, prefer originating channel.
  for (const channel of preferredChannelOrder(originatingChannel)) {
    for (const approver of approvers) {
      const dm = getUserDm(approver.id, channel);
      if (dm) return { userId: approver.id, messagingGroup: dm };
    }
  }

  // Second pass: try ensureUserDm if channel adapters are available.
  if (channelAdapters) {
    for (const channel of preferredChannelOrder(originatingChannel)) {
      const adapter = channelAdapters[channel];
      if (!adapter) continue;
      for (const approver of approvers) {
        // Can only DM via approver's own channel kind.
        if (approver.kind !== channel) continue;
        const mg = await ensureUserDm({
          user_id: approver.id,
          channel_type: channel,
          channel_adapter: adapter,
        });
        if (mg) return { userId: approver.id, messagingGroup: mg };
      }
    }
  }

  return undefined;
}

/**
 * Channels v1 might plausibly route DMs through. v1 does not currently maintain
 * a canonical channel registry, so this list is a superset of the channel kinds
 * referenced elsewhere in the codebase (notably user-dms.ts:DIRECT_CHANNELS plus
 * the indirect ones Discord/Slack). Extend if/when v1 gains new channels.
 */
const KNOWN_CHANNELS = ['whatsapp', 'telegram', 'discord', 'slack', 'imessage', 'matrix', 'email'];

function preferredChannelOrder(originatingChannel: string): string[] {
  if (originatingChannel && KNOWN_CHANNELS.includes(originatingChannel)) {
    return [originatingChannel, ...KNOWN_CHANNELS.filter((c) => c !== originatingChannel)];
  }
  return originatingChannel ? [originatingChannel, ...KNOWN_CHANNELS] : [...KNOWN_CHANNELS];
}
