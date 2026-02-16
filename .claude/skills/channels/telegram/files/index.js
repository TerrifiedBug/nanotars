import { Api, Bot } from 'grammy';

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

  // Swarm pool: send-only Api instances (no polling)
  /** @private */
  poolApis = [];
  /** @private - maps "{groupFolder}:{senderName}" → pool Api index */
  senderBotMap = new Map();
  /** @private */
  nextPoolIndex = 0;

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
      // pattern (e.g., ^@Andy\b), so we prepend the trigger when the
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

      // Deliver message — startMessageLoop() will pick it up
      this.config.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
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

      this.config.onChatMetadata(chatJid, timestamp);
      this.config.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
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

    // Initialize swarm pool bots (send-only, no polling)
    const poolTokens = (process.env.TELEGRAM_BOT_POOL || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    for (const poolToken of poolTokens) {
      try {
        const api = new Api(poolToken);
        const me = await api.getMe();
        this.poolApis.push(api);
        this.logger.info(
          { username: me.username, id: me.id, poolSize: this.poolApis.length },
          'Pool bot initialized',
        );
      } catch (err) {
        this.logger.error({ err }, 'Failed to initialize pool bot');
      }
    }
    if (this.poolApis.length > 0) {
      this.logger.info({ count: this.poolApis.length }, 'Telegram bot pool ready');
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

  async sendMessage(jid, text, sender) {
    if (!this.bot) {
      this.logger.warn('Telegram bot not initialized');
      return;
    }

    // Route through pool bot when sender is provided and pool is available
    if (sender && this.poolApis.length > 0) {
      await this.sendPoolMessage(jid, text, sender);
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      this.logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      this.logger.error({ jid, err }, 'Failed to send Telegram message');
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

  /**
   * Send a message via a pool bot assigned to the given sender name.
   * Assigns bots round-robin on first use; subsequent messages from the
   * same sender always use the same bot.
   * On first assignment, renames the bot to match the sender's role.
   * @private
   */
  async sendPoolMessage(jid, text, sender) {
    const key = sender;
    let idx = this.senderBotMap.get(key);
    if (idx === undefined) {
      idx = this.nextPoolIndex % this.poolApis.length;
      this.nextPoolIndex++;
      this.senderBotMap.set(key, idx);
      // Rename the bot to match the sender's role, then wait for Telegram to propagate
      try {
        await this.poolApis[idx].setMyName(sender);
        await new Promise((r) => setTimeout(r, 2000));
        this.logger.info({ sender, poolIndex: idx }, 'Assigned and renamed pool bot');
      } catch (err) {
        this.logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
      }
    }

    const api = this.poolApis[idx];
    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      this.logger.info({ jid, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
    } catch (err) {
      this.logger.error({ jid, sender, err }, 'Failed to send pool message');
    }
  }
}

export async function onChannel(ctx, config) {
  const channel = new TelegramChannel(config, ctx.logger);
  return channel;
}
