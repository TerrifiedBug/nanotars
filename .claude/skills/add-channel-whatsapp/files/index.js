import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_OUTGOING_QUEUE = 200;

class WhatsAppChannel {
  name = 'whatsapp';

  /** @private */
  sock;
  /** @private */
  connected = false;
  /** @private */
  shuttingDown = false;
  /** @private */
  lidToPhoneMap = {};
  /** @private */
  outgoingQueue = [];
  /** @private */
  flushing = false;
  /** @private */
  groupSyncTimerStarted = false;
  /** @private */
  ffmpegAvailable = false;
  /** @private */
  ffmpegChecked = false;
  /** @private */
  config;
  /** @private */
  logger;

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  /** @private */
  async connectInternal(onFirstOpen) {
    const authDir = path.join(this.config.paths.channelsDir, 'whatsapp', 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    if (!this.ffmpegChecked) {
      this.ffmpegChecked = true;
      try {
        await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
        this.ffmpegAvailable = true;
        this.logger.info('ffmpeg detected — video thumbnails enabled');
      } catch {
        this.ffmpegAvailable = false;
        this.logger.warn('ffmpeg not found — video thumbnails will use low-res fallback');
      }
    }

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      printQRInTerminal: false,
      logger: this.logger,
      browser: Browsers.macOS('Chrome'),
      getMessage: async () => undefined,
      syncFullHistory: false,
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /add-channel-whatsapp in Claude Code.';
        this.logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut && !this.shuttingDown;
        this.logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        if (shouldReconnect) {
          this.logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            this.logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                this.logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          this.logger.info('Logged out. Run /add-channel-whatsapp to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.logger.info('Connected to WhatsApp');

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            this.logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Announce online presence
        this.sock.sendPresenceUpdate('available').catch((err) =>
          this.logger.debug({ err }, 'Failed to send initial presence'),
        );

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          this.logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          this.logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              this.logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Unwrap WhatsApp message wrappers (viewOnce, ephemeral, documentWithCaption)
        let inner = msg.message;
        if (inner?.ephemeralMessage) inner = inner.ephemeralMessage.message;
        if (inner?.viewOnceMessage) inner = inner.viewOnceMessage.message;
        if (inner?.viewOnceMessageV2) inner = inner.viewOnceMessageV2.message;
        if (inner?.documentWithCaptionMessage) inner = inner.documentWithCaptionMessage.message;
        // Replace msg.message with unwrapped inner for downstream processing
        if (inner && inner !== msg.message) {
          msg.message = inner;
        }

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        this.config.onChatMetadata(chatJid, timestamp);

        // Only deliver full message for registered groups
        const groups = this.config.registeredGroups();
        if (groups[chatJid]) {
          let content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          // Translate @mention IDs to @DisplayName so trigger patterns match.
          // WhatsApp encodes mentions as @LID or @phonenumber in the text,
          // not the display name shown in the UI.
          const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          if (mentionedJids.length > 0 && content) {
            const myPhone = this.sock?.user?.id?.split(':')[0];
            const myLid = this.sock?.user?.lid?.split(':')[0];
            for (const jid of mentionedJids) {
              const id = jid.split('@')[0];
              if ((myPhone && id === myPhone) || (myLid && id === myLid)) {
                content = content.replace(new RegExp(`@${id}\\b`, 'g'), `@${this.config.assistantName}`);
              }
            }
          }

          const rawSender = msg.key.participant || msg.key.remoteJid || '';
          const sender = await this.translateJid(rawSender);
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = this.config.assistantHasOwnNumber
            ? fromMe
            : content.startsWith(`${this.config.assistantName}:`);

          // Extract reply context if this message is a reply
          let replyContext;
          const ctxInfo = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo
            || msg.message?.documentMessage?.contextInfo
            || msg.message?.audioMessage?.contextInfo;
          if (ctxInfo?.quotedMessage) {
            const quotedText = ctxInfo.quotedMessage.conversation
              || ctxInfo.quotedMessage.extendedTextMessage?.text
              || ctxInfo.quotedMessage.imageMessage?.caption
              || ctxInfo.quotedMessage.videoMessage?.caption
              || null;
            const rawQuotedSender = ctxInfo.participant || '';
            const quotedSender = rawQuotedSender ? await this.translateJid(rawQuotedSender) : '';
            // Use assistant name if replying to the bot's own message
            const myPhone = this.sock?.user?.id?.split(':')[0];
            const quotedPhone = quotedSender?.split('@')[0];
            const quotedName = (myPhone && quotedPhone === myPhone)
              ? this.config.assistantName
              : (quotedSender ? quotedSender.split('@')[0] : 'unknown');
            replyContext = {
              sender_name: quotedName,
              text: quotedText,
            };
          }

          // Download media (images, videos, documents, audio) if present
          const hasMedia = msg.message?.imageMessage || msg.message?.videoMessage ||
            msg.message?.documentMessage || msg.message?.audioMessage;
          let mediaType;
          let mediaPath;
          let mediaHostPath;
          if (hasMedia) {
            const media = await this.downloadMedia(msg, groups[chatJid].folder);
            if (media) {
              mediaType = media.type;
              mediaPath = media.path;
              mediaHostPath = media.hostPath;
              if (media.thumbnailPath) {
                // Video with thumbnail — show both references so agent can preview
                content = content
                  ? `${content}\n[${media.type}: ${media.path}]\n[thumbnail: ${media.thumbnailPath}]`
                  : `[${media.type}: ${media.path}]\n[thumbnail: ${media.thumbnailPath}]`;
              } else {
                content = content
                  ? `${content}\n[${media.type}: ${media.path}]`
                  : `[${media.type}: ${media.path}]`;
              }
            } else if (!content) {
              // Media download failed and no caption — add placeholder so message isn't dropped
              const type = msg.message?.imageMessage ? 'image' : msg.message?.videoMessage ? 'video'
                : msg.message?.audioMessage ? 'audio' : 'document';
              content = `[${type}: download failed]`;
            }
          }

          // Skip protocol messages with no content (encryption keys, read receipts, etc.)
          if (!content) continue;

          this.config.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
            mediaType,
            mediaPath,
            mediaHostPath,
            reply_context: replyContext,
          });
        }

        // Send read receipt for incoming messages
        if (!msg.key.fromMe) {
          this.sock.readMessages([msg.key]).catch(() => {});
        }
      }
    });
  }

  async sendMessage(jid, text, sender, replyTo) {
    // If a subagent identity is specified, prefix with its name in bold
    const withSender = sender && sender !== this.config.assistantName
      ? `*${sender}*\n${text}`
      : text;

    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = this.config.assistantHasOwnNumber
      ? withSender
      : `${this.config.assistantName}: ${withSender}`;

    if (!this.connected) {
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
        const dropped = this.outgoingQueue.shift();
        this.logger.warn({ jid: dropped.jid, queueSize: this.outgoingQueue.length }, 'Outgoing queue full, dropped oldest message');
      }
      this.outgoingQueue.push({ jid, text: prefixed, replyTo });
      this.logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      const msg = { text: prefixed };
      if (replyTo) {
        msg.quoted = { key: { remoteJid: jid, id: replyTo, fromMe: false } };
      }
      await this.sock.sendMessage(jid, msg);
      this.logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed, replyTo });
      this.logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  async sendFile(jid, buffer, mime, fileName, caption) {
    if (!this.connected) {
      this.logger.warn({ jid, fileName }, 'WA disconnected, cannot send file');
      return;
    }
    try {
      if (mime.startsWith('image/')) {
        await this.sock.sendMessage(jid, { image: buffer, caption });
      } else if (mime.startsWith('video/')) {
        await this.sock.sendMessage(jid, { video: buffer, caption });
      } else if (mime.startsWith('audio/')) {
        await this.sock.sendMessage(jid, { audio: buffer });
      } else {
        await this.sock.sendMessage(jid, { document: buffer, mimetype: mime, fileName, caption });
      }
      this.logger.info({ jid, fileName, mime }, 'File sent');
    } catch (err) {
      this.logger.error({ jid, fileName, err }, 'Failed to send file');
      throw err;
    }
  }

  async react(jid, messageId, emoji, participant, fromMe) {
    if (!this.connected) {
      this.logger.warn({ jid, messageId }, 'WA disconnected, cannot react');
      return;
    }
    try {
      const key = { remoteJid: jid, id: messageId, fromMe: fromMe ?? false };
      // Group reactions require participant (sender JID) in the key
      if (participant && jid.endsWith('@g.us')) {
        key.participant = participant;
      }
      await this.sock.sendMessage(jid, { react: { text: emoji, key } });
      this.logger.info({ jid, messageId, emoji, participant, fromMe }, 'Reaction sent');
    } catch (err) {
      this.logger.error({ jid, messageId, emoji, err }, 'Failed to send reaction');
    }
  }

  isConnected() {
    return this.connected;
  }

  ownsJid(jid) {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  /**
   * Extract a JPEG thumbnail from a video file.
   * Tries ffmpeg first, falls back to Baileys' embedded jpegThumbnail.
   * @private
   * @returns {Promise<string|null>} Host path to thumbnail, or null on failure
   */
  async extractThumbnail(videoPath, thumbnailPath, jpegThumbnail) {
    if (this.ffmpegAvailable) {
      try {
        await execFileAsync('ffmpeg', [
          '-i', videoPath, '-frames:v', '1', '-q:v', '2', '-y', thumbnailPath,
        ], { timeout: 10000 });
        this.logger.debug({ thumbnailPath }, 'Thumbnail extracted via ffmpeg');
        return thumbnailPath;
      } catch (err) {
        this.logger.warn({ err }, 'ffmpeg thumbnail extraction failed, trying fallback');
      }
    }

    // Fallback: use Baileys' embedded low-res thumbnail
    if (jpegThumbnail && Buffer.isBuffer(jpegThumbnail) && jpegThumbnail.length > 0) {
      try {
        fs.writeFileSync(thumbnailPath, jpegThumbnail);
        this.logger.debug({ thumbnailPath }, 'Thumbnail written from Baileys jpegThumbnail');
        return thumbnailPath;
      } catch (err) {
        this.logger.warn({ err }, 'Failed to write jpegThumbnail fallback');
      }
    }

    return null;
  }

  /**
   * Download media from a WhatsApp message and save to the group's media directory.
   * Returns a container-relative path reference, or null if no media or download failed.
   * For videos, extracts a JPEG thumbnail so the agent can preview the content.
   * For GIFs (gifPlayback videos), returns the thumbnail as an image instead.
   * @private
   */
  async downloadMedia(msg, groupFolder) {
    const mediaTypes = [
      { key: 'imageMessage', type: 'image', ext: 'jpg' },
      { key: 'videoMessage', type: 'video', ext: 'mp4' },
      { key: 'documentMessage', type: 'document', ext: '' },
      { key: 'audioMessage', type: 'audio', ext: 'ogg' },
    ];

    for (const mt of mediaTypes) {
      const mediaMsg = msg.message?.[mt.key];
      if (!mediaMsg) continue;

      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const ext = mt.ext || mediaMsg.fileName?.split('.').pop() || 'bin';
        const filename = `${msg.key.id}.${ext}`;
        const mediaDir = path.join(this.config.paths.groupsDir, groupFolder, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const filePath = path.join(mediaDir, filename);
        fs.writeFileSync(filePath, buffer);

        this.logger.info({ groupFolder, type: mt.type, filename }, 'Media downloaded');

        // Extract thumbnail for video messages
        if (mt.key === 'videoMessage') {
          const thumbFilename = `${msg.key.id}-thumb.jpg`;
          const thumbPath = path.join(mediaDir, thumbFilename);
          const thumbResult = await this.extractThumbnail(
            filePath, thumbPath, mediaMsg.jpegThumbnail,
          );

          if (thumbResult) {
            const containerThumbPath = `/workspace/group/media/${thumbFilename}`;
            if (mediaMsg.gifPlayback) {
              // GIF: present thumbnail as image so the agent can view it
              this.logger.info({ groupFolder, filename: thumbFilename }, 'GIF thumbnail extracted as image');
              return { path: containerThumbPath, hostPath: thumbResult, type: 'image' };
            }
            // Regular video: include both video and thumbnail
            this.logger.info({ groupFolder, filename: thumbFilename }, 'Video thumbnail extracted');
            return {
              path: `/workspace/group/media/${filename}`,
              hostPath: filePath,
              type: 'video',
              thumbnailPath: containerThumbPath,
            };
          }
        }

        return { path: `/workspace/group/media/${filename}`, hostPath: filePath, type: mt.type };
      } catch (err) {
        this.logger.warn({ err, msgId: msg.key.id, type: mt.type }, 'Failed to download media');
      }
    }
    return null;
  }

  async disconnect() {
    this.shuttingDown = true;
    this.connected = false;
    this.sock?.end(undefined);
  }

  /**
   * Send typing indicator. Internal method, not part of the Channel interface.
   */
  async setTyping(jid, isTyping) {
    try {
      const status = isTyping ? 'composing' : 'paused';
      this.logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      this.logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Public method to refresh group metadata.
   * Forces a re-sync regardless of the 24h cache.
   */
  async refreshMetadata() {
    return this.syncGroupMetadata(true);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via refreshMetadata.
   */
  async syncGroupMetadata(force = false) {
    if (!force) {
      const lastSync = this.config.db.getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          this.logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      this.logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          this.config.db.updateChatName(jid, metadata.subject);
          count++;
        }
      }

      this.config.db.setLastGroupSync();
      this.logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      this.logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  /**
   * Fetch all participating groups from WhatsApp.
   * Returns an array of { jid, name } objects.
   */
  async listAvailableGroups() {
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.entries(groups).map(([jid, metadata]) => ({
      jid,
      name: metadata.subject || jid,
    }));
  }

  /** @private */
  async translateJid(jid) {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      this.logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        this.logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');
        return phoneJid;
      }
    } catch (err) {
      this.logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  /** @private */
  async flushOutgoingQueue() {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      this.logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue[0];
        const msg = { text: item.text };
        if (item.replyTo) {
          msg.quoted = { key: { remoteJid: item.jid, id: item.replyTo, fromMe: false } };
        }
        await this.sock.sendMessage(item.jid, msg);
        this.outgoingQueue.shift();
        this.logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}

export async function onChannel(ctx, config) {
  const channel = new WhatsAppChannel(config, ctx.logger);
  return channel;
}
