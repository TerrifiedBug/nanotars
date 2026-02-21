import bolt from '@slack/bolt';
import fs from 'fs';
import path from 'path';
import https from 'https';

const { App } = bolt;

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_MSG_LENGTH = 40000; // Slack API limit

// Unicode emoji → Slack reaction short names
const EMOJI_TO_SLACK = {
  '\u{1F44D}': 'thumbsup', '\u{1F44E}': 'thumbsdown', '\u{2764}\u{FE0F}': 'heart',
  '\u{1F602}': 'joy', '\u{1F62E}': 'open_mouth', '\u{1F622}': 'cry',
  '\u{1F64F}': 'pray', '\u{1F389}': 'tada', '\u{1F525}': 'fire',
  '\u{2705}': 'white_check_mark', '\u{1F440}': 'eyes', '\u{1F4AF}': '100',
  '\u{2B50}': 'star', '\u{1F914}': 'thinking_face', '\u{1F4AA}': 'muscle',
  '\u{1F44F}': 'clap', '\u{1F680}': 'rocket', '\u{1F4A1}': 'bulb',
  '\u{26A1}': 'zap', '\u{2728}': 'sparkles', '\u{274C}': 'x',
  '\u{26A0}\u{FE0F}': 'warning', '\u{1F4AC}': 'speech_balloon', '\u{1F4CC}': 'pushpin',
  '\u{1F3AF}': 'dart', '\u{1F4DD}': 'memo', '\u{1F50D}': 'mag', '\u{1F91D}': 'handshake',
};

class SlackChannel {
  name = 'slack';

  /** @private */ app = null;
  /** @private */ connected = false;
  /** @private */ config;
  /** @private */ logger;
  /** @private */ botUserId = null;
  /** @private */ nameCache = new Map();

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async connect() {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;
    if (!botToken) throw new Error('SLACK_BOT_TOKEN not set');
    if (!appToken) throw new Error('SLACK_APP_TOKEN not set — required for Socket Mode');

    this.app = new App({ token: botToken, appToken, socketMode: true });

    // Resolve bot identity for mention translation
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id;
    this.logger.info({ botUserId: this.botUserId }, 'Slack bot identity resolved');

    // Listen for all message events including file_share
    this.app.event('message', async ({ event, client }) => {
      try {
        await this.handleMessage(event, client);
      } catch (err) {
        this.logger.error({ err: err.message }, 'Error handling Slack message');
      }
    });

    await this.app.start();
    this.connected = true;
    this.logger.info('Slack bot connected via Socket Mode');
  }

  /** @private */
  async handleMessage(message, client) {
    // Skip bot messages, edits, deletions, and non-content subtypes
    if (message.bot_id) return;
    if (message.subtype && message.subtype !== 'file_share') return;
    if (message.hidden) return;

    const chatJid = `slack:${message.channel}`;
    const timestamp = new Date(parseFloat(message.ts) * 1000).toISOString();

    const senderName = await this.resolveName(`user:${message.user}`, () =>
      this.fetchUserName(client, message.user),
    );

    const chatName = await this.resolveName(`chan:${message.channel}`, () =>
      this.fetchChannelName(client, message.channel),
    );
    this.config.onChatMetadata(chatJid, timestamp, chatName);

    // Only deliver full messages for registered groups
    const group = this.config.registeredGroups()[chatJid];
    if (!group) {
      this.logger.debug({ chatJid, chatName }, 'Message from unregistered Slack channel');
      return;
    }

    let content = message.text || '';

    // Translate <@USER_ID> mentions to @DisplayName
    // Critical for trigger matching (bot mentions → @AssistantName)
    const mentions = [...content.matchAll(/<@(U\w+)>/g)];
    for (const m of mentions) {
      const userId = m[1];
      const name = userId === this.botUserId
        ? this.config.assistantName
        : await this.resolveName(`user:${userId}`, () => this.fetchUserName(client, userId));
      content = content.replace(m[0], `@${name}`);
    }

    // Extract reply context from thread parent
    let replyContext;
    if (message.thread_ts && message.thread_ts !== message.ts) {
      try {
        const replies = await client.conversations.replies({
          channel: message.channel,
          ts: message.thread_ts,
          limit: 1,
          inclusive: true,
        });
        const parent = replies.messages?.[0];
        if (parent) {
          const parentName = parent.user === this.botUserId
            ? this.config.assistantName
            : await this.resolveName(`user:${parent.user}`, () =>
              this.fetchUserName(client, parent.user),
            );
          replyContext = { sender_name: parentName, text: parent.text || null };
        }
      } catch (err) {
        this.logger.debug({ err: err.message }, 'Failed to fetch thread parent');
      }
    }

    // Handle file attachments
    let mediaType, mediaPath, mediaHostPath;
    if (message.files?.length > 0) {
      const file = message.files[0];
      const media = await this.downloadFile(file, group.folder);
      if (media) {
        mediaType = media.type;
        mediaPath = media.path;
        mediaHostPath = media.hostPath;
        content = content
          ? `${content}\n[${media.type}: ${media.path}]`
          : `[${media.type}: ${media.path}]`;
      } else if (!content) {
        const type = file.mimetype?.split('/')[0] || 'file';
        content = `[${type}: download failed]`;
      }
    }

    if (!content) return;

    this.config.onMessage(chatJid, {
      id: message.ts,
      chat_jid: chatJid,
      sender: message.user || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      mediaType,
      mediaPath,
      mediaHostPath,
      reply_context: replyContext,
    });

    this.logger.info({ chatJid, sender: senderName }, 'Slack message received');
  }

  /** @private */
  async downloadFile(file, groupFolder) {
    const url = file.url_private_download;
    if (!url) return null;

    const mediaDir = path.join(this.config.paths.groupsDir, groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const ext = file.name?.split('.').pop() || file.filetype || 'bin';
    const filename = `${file.id}.${ext}`;
    const filePath = path.join(mediaDir, filename);

    try {
      const buffer = await this.fetchAuthed(url);
      fs.writeFileSync(filePath, buffer);

      const prefix = (file.mimetype || '').split('/')[0];
      const type = prefix === 'image' ? 'image'
        : prefix === 'video' ? 'video'
        : prefix === 'audio' ? 'audio'
        : 'document';

      this.logger.info({ groupFolder, type, filename }, 'Slack file downloaded');
      return { path: `/workspace/group/media/${filename}`, hostPath: filePath, type };
    } catch (err) {
      this.logger.warn({ err: err.message, fileId: file.id }, 'Failed to download Slack file');
      return null;
    }
  }

  /** @private */
  async fetchAuthed(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      https.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      }, (res) => {
        // Follow redirects (Slack may redirect file downloads)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchAuthed(res.headers.location).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  async sendMessage(jid, text, sender, replyTo) {
    if (!this.app) return;

    const channelId = jid.replace(/^slack:/, '');
    const opts = { channel: channelId, text };

    // Use sender identity as display name override (requires chat:write.customize scope)
    if (sender && sender !== this.config.assistantName) {
      opts.username = sender;
    }

    // In group channels, reply in a thread to keep the channel tidy.
    // In DMs, reply directly (threading feels unnatural in 1:1 chats).
    const isDM = channelId.startsWith('D');
    if (replyTo && !isDM) {
      opts.thread_ts = replyTo;
    }

    try {
      if (text.length <= MAX_MSG_LENGTH) {
        await this.app.client.chat.postMessage(opts);
      } else {
        // Split oversized messages
        for (let i = 0; i < text.length; i += MAX_MSG_LENGTH) {
          const chunk = { ...opts, text: text.slice(i, i + MAX_MSG_LENGTH) };
          if (i > 0) delete chunk.thread_ts;
          await this.app.client.chat.postMessage(chunk);
        }
      }
      this.logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      // If username override fails (missing chat:write.customize scope), retry with prefix
      if (opts.username && (err.data?.error === 'missing_scope' || err.data?.error === 'not_allowed_token_type')) {
        this.logger.warn('chat:write.customize scope missing — using name prefix');
        const prefixed = sender ? `*${sender}*\n${text}` : text;
        delete opts.username;
        opts.text = prefixed;
        await this.app.client.chat.postMessage(opts);
      } else {
        this.logger.error({ jid, err: err.message || err }, 'Failed to send Slack message');
      }
    }
  }

  async sendFile(jid, buffer, mime, fileName, caption) {
    if (!this.app) return;

    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.filesUploadV2({
        channel_id: channelId,
        file: buffer,
        filename: fileName,
        initial_comment: caption || undefined,
      });
      this.logger.info({ jid, fileName, mime }, 'Slack file sent');
    } catch (err) {
      this.logger.error({ jid, fileName, err: err.message || err }, 'Failed to send Slack file');
      throw err;
    }
  }

  async react(jid, messageId, emoji) {
    if (!this.app) return;

    const channelId = jid.replace(/^slack:/, '');
    const slackName = EMOJI_TO_SLACK[emoji];
    if (!slackName) {
      this.logger.warn({ emoji }, 'No Slack mapping for emoji — skipping reaction');
      return;
    }

    try {
      await this.app.client.reactions.add({
        channel: channelId,
        name: slackName,
        timestamp: messageId,
      });
      this.logger.info({ jid, messageId, emoji: slackName }, 'Slack reaction sent');
    } catch (err) {
      if (err.data?.error === 'already_reacted') return;
      this.logger.error({ jid, messageId, emoji: slackName, err: err.message || err }, 'Failed to react');
    }
  }

  isConnected() {
    return this.connected;
  }

  ownsJid(jid) {
    return jid.startsWith('slack:');
  }

  async disconnect() {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.connected = false;
      this.logger.info('Slack bot stopped');
    }
  }

  async refreshMetadata() {
    if (!this.app) return;
    try {
      let cursor;
      let count = 0;
      do {
        const res = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          limit: 200,
          cursor,
        });
        for (const ch of res.channels || []) {
          if (ch.is_member) {
            this.config.db.updateChatName(`slack:${ch.id}`, ch.name || ch.id);
            count++;
          }
        }
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
      this.logger.info({ count }, 'Slack channel metadata refreshed');
    } catch (err) {
      this.logger.error({ err: err.message || err }, 'Failed to refresh Slack metadata');
    }
  }

  async listAvailableGroups() {
    if (!this.app) return [];
    const result = [];
    let cursor;
    do {
      const res = await this.app.client.conversations.list({
        types: 'public_channel,private_channel,im,mpim',
        limit: 200,
        cursor,
      });
      for (const ch of res.channels || []) {
        if (ch.is_member) {
          result.push({ jid: `slack:${ch.id}`, name: ch.name || ch.id });
        }
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
    return result;
  }

  /** @private */
  async resolveName(key, fetchFn) {
    const cached = this.nameCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    try {
      const value = await fetchFn();
      this.nameCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      return value;
    } catch {
      return key.split(':')[1] || 'Unknown';
    }
  }

  /** @private */
  async fetchUserName(client, userId) {
    if (!userId) return 'Unknown';
    const info = await client.users.info({ user: userId });
    return info.user?.real_name || info.user?.profile?.display_name || info.user?.name || userId;
  }

  /** @private */
  async fetchChannelName(client, channelId) {
    const info = await client.conversations.info({ channel: channelId });
    return info.channel?.name || `slack:${channelId}`;
  }
}

export async function onChannel(ctx, config) {
  const channel = new SlackChannel(config, ctx.logger);
  return channel;
}
