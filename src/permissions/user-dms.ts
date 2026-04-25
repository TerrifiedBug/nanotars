import { getDb } from '../db/init.js';
import {
  getMessagingGroup,
  createMessagingGroup,
} from '../db/agent-groups.js';
import type { MessagingGroup } from '../types.js';
import { logger } from '../logger.js';

const DIRECT_CHANNELS = new Set(['whatsapp', 'telegram', 'imessage', 'email', 'matrix']);

export function getUserDm(userId: string, channelType: string): MessagingGroup | undefined {
  return getDb().prepare(`
    SELECT mg.* FROM messaging_groups mg
    JOIN user_dms ud ON ud.messaging_group_id = mg.id
    WHERE ud.user_id = ? AND ud.channel_type = ?
  `).get(userId, channelType) as MessagingGroup | undefined;
}

export interface ChannelDmAdapter {
  name: string;
  /** Some channels (Discord/Slack/Teams) need a round-trip to open a DM channel.
   * Direct-handle channels (WhatsApp, Telegram, etc.) skip this. */
  openDM?: (handle: string) => Promise<string>;
}

export async function ensureUserDm(args: {
  user_id: string;
  channel_type: string;
  channel_adapter?: ChannelDmAdapter;
}): Promise<MessagingGroup | undefined> {
  const cached = getUserDm(args.user_id, args.channel_type);
  if (cached) return cached;

  const colonIdx = args.user_id.indexOf(':');
  if (colonIdx === -1) {
    logger.warn({ userId: args.user_id }, 'ensureUserDm: malformed user.id (missing colon)');
    return undefined;
  }
  const handle = args.user_id.slice(colonIdx + 1);

  let chatId: string;
  if (DIRECT_CHANNELS.has(args.channel_type)) {
    chatId = handle;
  } else if (args.channel_adapter?.openDM) {
    try {
      chatId = await args.channel_adapter.openDM(handle);
    } catch (err) {
      logger.warn({ err, userId: args.user_id, channel_type: args.channel_type }, 'ensureUserDm: openDM failed');
      return undefined;
    }
  } else {
    logger.warn({ userId: args.user_id, channel_type: args.channel_type }, 'ensureUserDm: no openDM available for indirect channel');
    return undefined;
  }

  let mg = getMessagingGroup(args.channel_type, chatId);
  if (!mg) mg = createMessagingGroup({ channel_type: args.channel_type, platform_id: chatId, name: null });

  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`)
    .run(args.user_id, args.channel_type, mg.id, now);

  return mg;
}

export function clearUserDm(userId: string, channelType: string): void {
  getDb().prepare(`DELETE FROM user_dms WHERE user_id = ? AND channel_type = ?`).run(userId, channelType);
}
