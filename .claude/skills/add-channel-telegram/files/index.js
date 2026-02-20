import { Bot } from 'grammy';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class TelegramChannel {
  name = 'telegram';

  /** @private */
  bot = null;
  /** @private */
  config;
  /** @private */
  logger;
  /** @private - swarm bot pool, loaded dynamically from pool.js if present */
  pool = null;

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async connect() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN not set');
    }

    this.bot = new Bot(token);
    const triggerPattern = new RegExp(
      '^@' + escapeRegex(this.config.assistantName) + '\\b',
      'i',
    );

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : ctx.chat.title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${this.config.assistantName} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : ctx.chat.title || chatJid;

      // Translate Telegram @bot_username mentions into trigger format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match the trigger
      // pattern (e.g., ^@TARS\b), so we prepend the trigger when the
      // bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !triggerPattern.test(content)) {
          content = `@${this.config.assistantName} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.config.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.config.registeredGroups()[chatJid];
      if (!group) {
        this.logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Extract reply context if this message is a reply
      let replyContext;
      const replyMsg = ctx.message.reply_to_message;
      if (replyMsg) {
        const replySender = replyMsg.from?.first_name || replyMsg.from?.username || replyMsg.from?.id?.toString() || 'unknown';
        const replyText = replyMsg.text || replyMsg.caption || null;
        replyContext = { sender_name: replySender, text: replyText };
      }

      // Deliver message — startMessageLoop() will pick it up
      this.config.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        reply_context: replyContext,
      });

      this.logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx, placeholder) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.config.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      // Extract reply context if this is a reply
      let replyContext;
      const replyMsg = ctx.message.reply_to_message;
      if (replyMsg) {
        const replySender = replyMsg.from?.first_name || replyMsg.from?.username || replyMsg.from?.id?.toString() || 'unknown';
        const replyText = replyMsg.text || replyMsg.caption || null;
        replyContext = { sender_name: replySender, text: replyText };
      }

      this.config.onChatMetadata(chatJid, timestamp);
      this.config.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        reply_context: replyContext,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      this.logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Load swarm bot pool if pool.js is present and TELEGRAM_BOT_POOL is set
    if (process.env.TELEGRAM_BOT_POOL) {
      try {
        const { createPool } = await import('./pool.js');
        this.pool = await createPool(process.env.TELEGRAM_BOT_POOL, this.logger);
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND') {
          this.logger.warn('TELEGRAM_BOT_POOL is set but pool.js not found — run /add-telegram-swarm to install');
        } else {
          this.logger.error({ err: err.message }, 'Failed to initialize bot pool');
        }
      }
    }

    // Start polling — returns a Promise that resolves when started
    return new Promise((resolve) => {
      this.bot.start({
        onStart: (botInfo) => {
          this.logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid, text, sender, replyTo) {
    if (!this.bot) {
      this.logger.warn('Telegram bot not initialized');
      return;
    }

    // Route through pool bot when sender is provided and pool is available
    if (sender && this.pool) {
      await this.pool.sendMessage(jid, text, sender);
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      const replyParams = replyTo ? { reply_parameters: { message_id: parseInt(replyTo, 10) } } : {};
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text, replyParams);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const params = i === 0 ? replyParams : {};
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH), params);
        }
      }
      this.logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      this.logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async react(jid, messageId, emoji) {
    if (!this.bot) {
      this.logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.setMessageReaction(numericId, parseInt(messageId, 10), [{ type: 'emoji', emoji }]);
      this.logger.info({ jid, messageId, emoji }, 'Telegram reaction sent');
    } catch (err) {
      this.logger.error({ jid, messageId, emoji, err }, 'Failed to send Telegram reaction');
    }
  }

  isConnected() {
    return this.bot !== null;
  }

  ownsJid(jid) {
    return jid.startsWith('tg:');
  }

  async disconnect() {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      this.logger.info('Telegram bot stopped');
    }
  }
}

export async function onChannel(ctx, config) {
  const channel = new TelegramChannel(config, ctx.logger);
  return channel;
}
