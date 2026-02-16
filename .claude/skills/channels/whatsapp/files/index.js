import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      printQRInTerminal: false,
      logger: this.logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /nanoclaw-setup in Claude Code.';
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
          this.logger.info('Logged out. Run /nanoclaw-setup to re-authenticate.');
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
          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = this.config.assistantHasOwnNumber
            ? fromMe
            : content.startsWith(`${this.config.assistantName}:`);

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
              content = content
                ? `${content}\n[${media.type}: ${media.path}]`
                : `[${media.type}: ${media.path}]`;
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
          });
        }

        // Send read receipt for incoming messages
        if (!msg.key.fromMe) {
          this.sock.readMessages([msg.key]).catch(() => {});
        }
      }
    });
  }

  async sendMessage(jid, text) {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = this.config.assistantHasOwnNumber
      ? text
      : `${this.config.assistantName}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      this.logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      this.logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      this.logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  isConnected() {
    return this.connected;
  }

  ownsJid(jid) {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  /**
   * Download media from a WhatsApp message and save to the group's media directory.
   * Returns a container-relative path reference, or null if no media or download failed.
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
        const item = this.outgoingQueue.shift();
        // Send directly - queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
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
