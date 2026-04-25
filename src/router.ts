import { logger } from './logger.js';
import type { PluginRegistry } from './plugin-loader.js';
import { redactSecrets } from './secret-redact.js';
import { Channel, NewMessage } from './types.js';

/** Known auth/API error patterns from Claude API and Claude Code SDK. */
const AUTH_ERROR_PATTERNS = [
  'does not have access to claude',
  'oauth token has expired',
  'obtain a new token',
  'refresh your existing token',
  'authentication_error',
  'invalid_api_key',
  'please login again',
];

/** Check if an error message indicates an authentication/authorization failure. */
export function isAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some(p => lower.includes(p));
}

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
    return `<message id="${escapeXml(m.id)}" sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${inner}</message>`;
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
  replyTo?: string,
  pluginRegistry?: PluginRegistry,
): Promise<boolean> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) {
    logger.warn({ jid }, 'No connected channel for JID, message dropped');
    return false;
  }

  let outText = text;
  if (pluginRegistry) {
    outText = await pluginRegistry.runOutboundHooks(outText, jid, channel.name);
    if (!outText) {
      logger.debug({ jid }, 'Outbound message suppressed by plugin hook');
      return true;
    }
  }

  let safeText = redactSecrets(outText);
  if (channel.transformOutboundText) {
    safeText = await channel.transformOutboundText(safeText, jid);
  }
  if (safeText.length === 0) {
    // Hook returned empty — suppress delivery (channel-level rejection).
    logger.debug({ channel: channel.name, jid }, 'transformOutboundText returned empty; suppressing send');
    return true;
  }
  await channel.sendMessage(jid, safeText, sender, replyTo);
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

