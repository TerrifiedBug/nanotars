// Telegram swarm bot pool — send-only Grammy Api instances for per-sender identities.
// Installed by /add-telegram-swarm into plugins/channels/telegram/pool.js
import { Api } from 'grammy';

/** Sanitize a sender name for use as a Telegram bot display name. */
function sanitizeBotName(name) {
  let clean = name.replace(/[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202f\ufeff]/g, '').trim();
  if (clean.length > 64) clean = clean.slice(0, 64).trim();
  return clean || 'Agent';
}

/**
 * Create a bot pool from comma-separated tokens.
 * Returns a pool object with sendMessage(jid, text, sender), or null if no bots initialized.
 */
export async function createPool(tokensCsv, logger) {
  const tokens = tokensCsv.split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  const apis = [];
  const senderMap = new Map();
  let nextIndex = 0;

  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      apis.push(api);
      logger.info({ username: me.username, id: me.id, poolSize: apis.length }, 'Pool bot initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }

  if (apis.length === 0) return null;
  logger.info({ count: apis.length }, 'Telegram bot pool ready');

  return {
    get size() { return apis.length; },

    async sendMessage(jid, text, sender) {
      let idx = senderMap.get(sender);
      if (idx === undefined) {
        idx = nextIndex % apis.length;
        nextIndex++;
        senderMap.set(sender, idx);
        try {
          await apis[idx].setMyName(sanitizeBotName(sender));
          await new Promise((r) => setTimeout(r, 2000));
          logger.info({ sender, poolIndex: idx }, 'Assigned and renamed pool bot');
        } catch (err) {
          logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
        }
      }

      const api = apis[idx];
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
    },
  };
}
