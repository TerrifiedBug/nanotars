import { NewMessage } from '../types.js';
import { dbEvents, getDb } from './init.js';

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    getDb().prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    getDb().prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  getDb().prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return getDb()
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = getDb()
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_context ? JSON.stringify(msg.reply_context) : null,
  );
  dbEvents.emit('new-message', msg.chat_jid);
}

/**
 * Store an externally-originated message (plain strings, no channel SDK dependency).
 * Used by plugins (webhooks, channels, etc.) to inject messages into the
 * message store so the polling loop picks them up like any other message.
 */
export function insertExternalMessage(
  chatJid: string,
  messageId: string,
  sender: string,
  senderName: string,
  text: string,
): void {
  const timestamp = new Date().toISOString();

  storeChatMetadata(chatJid, timestamp, senderName);

  getDb().prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageId, chatJid, sender, senderName, text, timestamp, 0);
  dbEvents.emit('new-message', chatJid);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Use >= so that messages arriving in the same second as the cursor are
  // not permanently skipped. Callers must track processed IDs to deduplicate.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, reply_context
    FROM messages
    WHERE timestamp >= ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = getDb()
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as Array<
      Omit<NewMessage, 'reply_context'> & { reply_context: string | null }
    >;

  const messages: NewMessage[] = rows.map((row) => ({
    ...row,
    reply_context: row.reply_context ? JSON.parse(row.reply_context) : undefined,
  }));

  let newTimestamp = lastTimestamp;
  for (const row of messages) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, reply_context
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  const rows = getDb()
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as Array<
      Omit<NewMessage, 'reply_context'> & { reply_context: string | null }
    >;
  return rows.map((row) => ({
    ...row,
    reply_context: row.reply_context ? JSON.parse(row.reply_context) : undefined,
  }));
}

/**
 * Look up a message's sender and fromMe status for reaction routing.
 * Returns null if the message isn't found.
 */
export function getMessageMeta(
  messageId: string,
  chatJid: string,
): { sender: string; isFromMe: boolean } | null {
  const row = getDb()
    .prepare('SELECT sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?')
    .get(messageId, chatJid) as { sender: string; is_from_me: number } | undefined;
  if (!row) return null;
  return { sender: row.sender, isFromMe: row.is_from_me === 1 };
}

export function getRecentMessages(jid: string, limit = 50): NewMessage[] {
  return getDb()
    .prepare('SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?')
    .all(jid, limit) as NewMessage[];
}
