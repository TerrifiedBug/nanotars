import { Client, GatewayIntentBits, Partials } from 'discord.js';

const MESSAGE_MAX_LENGTH = 2000;

class DiscordChannel {
  name = 'discord';

  /** @private @type {Client | null} */
  client = null;
  /** @private */
  connected = false;
  /** @private */
  shuttingDown = false;
  /** @private @type {import('../../src/plugin-types.js').ChannelPluginConfig} */
  config;
  /** @private */
  logger;

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async connect() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      this.logger.warn('DISCORD_BOT_TOKEN not set — skipping Discord channel');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // needed to receive DM events
    });

    return new Promise((resolve) => {
      this.client.once('ready', () => {
        this.connected = true;
        this.logger.info(
          { username: this.client.user?.tag, id: this.client.user?.id },
          'Discord bot connected',
        );
        resolve();
      });

      this.client.on('messageCreate', async (message) => {
        // Ignore messages from bots (including self)
        if (message.author.bot) return;

        const chatJid = `dc:${message.channelId}`;
        const timestamp = message.createdAt.toISOString();
        const senderName = message.member?.displayName || message.author.displayName || message.author.username;
        const sender = message.author.id;
        const msgId = message.id;

        // Determine chat name
        let chatName;
        if (message.guild) {
          chatName = message.channel.name || chatJid;
        } else {
          chatName = senderName;
        }

        // Report chat metadata for discovery
        this.config.onChatMetadata(chatJid, timestamp, chatName);

        // Only deliver full message for registered chats
        const groups = this.config.registeredGroups();
        if (!groups[chatJid]) return;

        let content = message.content || '';

        // Handle attachments as text placeholders
        for (const attachment of message.attachments.values()) {
          const type = attachment.contentType?.startsWith('image/')
            ? 'Image'
            : attachment.contentType?.startsWith('video/')
              ? 'Video'
              : attachment.contentType?.startsWith('audio/')
                ? 'Audio'
                : 'File';
          content += content ? `\n[${type}: ${attachment.name}]` : `[${type}: ${attachment.name}]`;
        }

        // Handle stickers
        for (const sticker of message.stickers.values()) {
          content += content ? `\n[Sticker: ${sticker.name}]` : `[Sticker: ${sticker.name}]`;
        }

        if (!content) return;

        this.config.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        });

        this.logger.info(
          { chatJid, chatName, sender: senderName },
          'Discord message stored',
        );
      });

      this.client.on('error', (err) => {
        this.logger.error({ err: err.message }, 'Discord client error');
      });

      this.client.login(token);
    });
  }

  async sendMessage(jid, text) {
    if (!this.client) {
      this.logger.warn('Discord client not initialized');
      return;
    }

    const channelId = jid.replace(/^dc:/, '');

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        this.logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      // Discord has a 2000 character limit per message — split if needed
      if (text.length <= MESSAGE_MAX_LENGTH) {
        await channel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MESSAGE_MAX_LENGTH) {
          await channel.send(text.slice(i, i + MESSAGE_MAX_LENGTH));
        }
      }

      this.logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      this.logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected() {
    return this.connected;
  }

  ownsJid(jid) {
    return jid.startsWith('dc:');
  }

  async disconnect() {
    this.shuttingDown = true;
    this.connected = false;
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.logger.info('Discord bot stopped');
    }
  }

  async listAvailableGroups() {
    if (!this.client) return [];

    const results = [];

    // List guild text channels
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.isTextBased() && !channel.isVoiceBased()) {
          results.push({
            jid: `dc:${channel.id}`,
            name: `${guild.name} / #${channel.name}`,
          });
        }
      }
    }

    return results;
  }
}

export async function onChannel(ctx, config) {
  const channel = new DiscordChannel(config, ctx.logger);
  return channel;
}
