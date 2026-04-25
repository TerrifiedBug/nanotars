import { ensureUser } from './users.js';

export interface SenderInfo {
  channel: string;          // adapter name (e.g. 'whatsapp', 'telegram')
  platform_id: string;       // chat/group id (jid)
  sender_handle: string;     // sender's platform identifier
  sender_name?: string;
}

/**
 * Resolve a platform-level sender to a users.id. Lazily creates a users row if
 * the sender hasn't been seen before. Always returns a non-empty string.
 *
 * The user.id convention is "<channel>:<sender_handle>". Phase 4B's identity
 * model treats one human as one users row per channel; cross-channel linking
 * is not in scope (see Phase 4D considerations).
 *
 * Replaces the 4A stub permissions.ts:resolveSender (which returned undefined).
 */
export function resolveSender(info: SenderInfo): string {
  const userId = `${info.channel}:${info.sender_handle}`;
  ensureUser({
    id: userId,
    kind: info.channel,
    display_name: info.sender_name ?? null,
  });
  return userId;
}
