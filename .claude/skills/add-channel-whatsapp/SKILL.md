---
name: add-channel-whatsapp
description: >
  Add WhatsApp as a channel. Install the WhatsApp channel plugin and authenticate.
  Use when WhatsApp is not already installed as a core plugin.
  Triggers on "add whatsapp", "whatsapp setup", "whatsapp channel".
---

# Add WhatsApp Channel

Adds WhatsApp as a messaging channel to NanoClaw using the Baileys library.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- A phone number with WhatsApp installed (for QR code authentication)

## Install

1. Check current state:
   ```bash
   [ -d plugins/channels/whatsapp ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Auth.

2. Copy channel plugin files into place:
   ```bash
   mkdir -p plugins/channels/whatsapp
   cp -r .claude/skills/add-channel-whatsapp/files/* plugins/channels/whatsapp/
   ```

3. The plugin has `"dependencies": true` in its manifest, so the plugin-loader will run `npm install` automatically on first startup. To install dependencies now:
   ```bash
   cd plugins/channels/whatsapp && npm install && cd -
   ```

4. Rebuild and restart:
   ```bash
   npm run build
   ```

   Then restart the service:
   ```bash
   systemctl restart nanoclaw 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || echo "Restart the NanoClaw service manually"
   ```

## Auth

Follow the WhatsApp authentication flow described in `CHANNEL.md`.

The auth script supports two modes:
- **QR code**: `node plugins/channels/whatsapp/auth.js` (or `--serve` for HTTP-served QR on headless servers)
- **Pairing code**: `node plugins/channels/whatsapp/auth.js --pairing-code --phone YOUR_NUMBER`

## Register a Chat

After authentication, use `/nanoclaw-add-group` to register a WhatsApp group or DM.

## Verify

- Check logs: `tail -20 logs/nanoclaw.log | grep -i whatsapp`
- Send a test message in the registered WhatsApp chat and confirm the agent responds

## Troubleshooting

- **Error 515 "restart required"**: Common during initial pairing. The auth script auto-reconnects. Wait 30 seconds.
- **QR code too wide**: Use `--serve` flag to get an HTTP-served QR at `http://SERVER_IP:8899`.
- **Bot not receiving messages (DMs)**: WhatsApp may use LID JIDs. Check logs for `Translated LID to phone JID`.
- **Messages not received**: Verify the JID is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE channel = 'whatsapp'"`

## Uninstall

1. Stop the NanoClaw service
2. Remove the plugin directory: `rm -rf plugins/channels/whatsapp/`
3. Remove WhatsApp auth data: `rm -rf data/channels/whatsapp/`
4. Remove registered groups for this channel:
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel = 'whatsapp'"
   ```
5. Rebuild and restart NanoClaw
6. Group folders under `groups/` are preserved (not automatically deleted)
