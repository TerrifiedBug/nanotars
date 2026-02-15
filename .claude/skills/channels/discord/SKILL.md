---
name: channel-discord
description: >
  Discord channel plugin — setup and installation. Adds Discord as a channel.
  Can run alongside WhatsApp or other channels. Requires `npm install discord.js`.
  Triggers on "add discord", "discord setup", "discord channel".
---

# Add Discord Channel

Adds Discord as a messaging channel to NanoClaw.

## Prerequisites

### 1. Install discord.js

```bash
npm install discord.js
```

### 2. Create a Discord Bot

Tell the user:

> I need you to create a Discord bot:
>
> 1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
> 2. Click **New Application**, give it a name
> 3. Go to **Bot** in the left sidebar
> 4. Click **Reset Token** and copy the bot token
> 5. Under **Privileged Gateway Intents**, enable:
>    - **Message Content Intent** (required to read message text)
>    - **Server Members Intent** (optional, for display names)
> 6. Go to **OAuth2 > URL Generator**:
>    - Scopes: `bot`
>    - Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`
> 7. Copy the generated URL and open it in your browser to invite the bot to your server

Wait for the user to provide the bot token.

### 3. Get Channel ID

The easiest way to find a channel ID is to let the bot discover it:

1. Complete the Install steps below so the bot comes online.
2. Send a message to the bot — either in a server text channel or via DM.
3. Look up the channel ID from the database:
   ```bash
   sqlite3 store/messages.db "SELECT DISTINCT jid FROM messages WHERE jid LIKE 'dc:%' ORDER BY timestamp DESC LIMIT 10"
   ```
   The JID format is `dc:{channel_id}` — for example `dc:1234567890123456789`.

**Fallback (manual method):** If you need the ID before the bot is running, tell the user:

> 1. In Discord, go to **User Settings > Advanced > Developer Mode** (enable it)
> 2. Right-click the text channel (or DM conversation) you want to register
> 3. Click **Copy Channel ID**

**Note on DMs:** You must share at least one server with the bot before you can send it a direct message. Invite the bot to a server you're in (step 2 above), then open a DM with it.

## Install

1. Check current state:
   ```bash
   [ -d plugins/channels/discord ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Verify.

2. Add bot token to `.env`:
   ```bash
   echo "DISCORD_BOT_TOKEN=user_provided_token" >> .env
   ```

3. Copy channel plugin files into place:
   ```bash
   mkdir -p plugins/channels/discord
   cp -r .claude/skills/channels/discord/files/* plugins/channels/discord/
   ```

4. Rebuild and restart:
   ```bash
   npm run build
   ```

   Then restart the service (systemd or launchd depending on platform):
   ```bash
   systemctl restart nanoclaw 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || echo "Restart the NanoClaw service manually"
   ```

## Register a Chat

After the channel connects, use `/add-channel` to register a Discord channel or DM.

## Verify

- Check logs: `tail -20 logs/nanoclaw.log | grep -i discord`
- Send a test message in the registered Discord channel and confirm the agent responds

## Troubleshooting

- **Bot not connecting**: Check `DISCORD_BOT_TOKEN` in `.env`. Verify the token is valid.
- **Bot online but not reading messages**: The **Message Content Intent** must be enabled in the Discord Developer Portal under Bot > Privileged Gateway Intents.
- **Messages not received**: Verify the channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'dc:%'"`
- **No response**: Check trigger pattern matches or that `requiresTrigger: false` is set for the main channel.
- **Bot can't send messages**: Ensure the bot has `Send Messages` permission in the channel.
