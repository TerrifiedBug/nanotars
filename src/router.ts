import { logger } from './logger.js';
import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    let inner = '';
    if (m.reply_context) {
      const replyText = m.reply_context.text !== null
        ? escapeXml(m.reply_context.text)
        : '[non-text message]';
      inner += `<reply to="${escapeXml(m.reply_context.sender_name)}">${replyText}</reply>`;
    }
    inner += escapeXml(m.content);
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${inner}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  // Strip properly closed <internal>...</internal> blocks
  let result = text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
  // Strip unclosed <internal> tags (agent didn't close the tag)
  result = result.replace(/<internal>[\s\S]*/g, '');
  return result.trim();
}

export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  sender?: string,
): Promise<boolean> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) {
    logger.warn({ jid }, 'No connected channel for JID, message dropped');
    return false;
  }
  await channel.sendMessage(jid, text, sender);
  return true;
}

export async function routeOutboundFile(
  channels: Channel[],
  jid: string,
  buffer: Buffer,
  mime: string,
  fileName: string,
  caption?: string,
): Promise<boolean> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel?.sendFile) {
    logger.warn({ jid }, 'No connected channel with file support for JID');
    return false;
  }
  await channel.sendFile(jid, buffer, mime, fileName, caption);
  return true;
}

