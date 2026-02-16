---
name: add-channel-discord
description: >
  Add Discord as a channel. Runs alongside WhatsApp or other channels.
  Supports server text channels and DMs. Triggers on "add discord",
  "discord setup", "discord channel".
---

# Add Discord Channel

This skill installs the Discord channel plugin and registers a Discord chat.

**If the plugin is already installed** (check `plugins/channels/discord/`), skip to "Register a Chat" below.

## Prerequisites

### 1. Create a Discord Bot

Tell the user:

> I need you to create a Discord bot:
>
> 1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
> 2. Click **New Application**, give it a name
> 3. Go to **Bot** in the left sidebar
> 4. Click **Reset Token** and copy the bot token
> 5. Under **Privileged Gateway Intents**, enable:
>    - **Message Content Intent** (required to read message text)
> 6. Go to **OAuth2 > URL Generator**:
>    - Scopes: `bot`
>    - Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`
> 7. Copy the generated URL and open it to invite the bot to your server

Wait for the user to provide the bot token.

**Note on DMs:** You must share at least one server with the bot before you can DM it directly.

## Install

1. Install discord.js (per-plugin dependency):
   ```bash
   cd plugins/channels/discord && npm install && cd -
   ```
   The plugin has its own `package.json` — dependencies are isolated from the core.

2. Check if plugin files exist:
   ```bash
   [ -d plugins/channels/discord ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```

3. If needed, copy channel plugin files into place:
   ```bash
   mkdir -p plugins/channels/discord
   cp -r .claude/skills/add-channel-discord/files/* plugins/channels/discord/
   ```

4. Add bot token to `.env` (get from user, never echo full token):
   ```bash
   echo "DISCORD_BOT_TOKEN=user_provided_token" >> .env
   ```

5. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null
   ```

6. Verify the bot connected:
   ```bash
   sleep 3 && grep -i 'discord.*connected' logs/nanoclaw.log | tail -1
   ```

## Register a Chat

The easiest way to get a channel ID is dynamic discovery:

1. Send a message to the bot (DM or server text channel)
2. Query the database:
   ```bash
   sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'dc:%' ORDER BY last_message_time DESC LIMIT 10"
   ```
3. Register the chat using `/nanoclaw-add-group`, or directly:
   ```bash
   sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, channel) VALUES ('dc:CHANNEL_ID', 'GROUP_NAME', 'FOLDER_NAME', '@ASSISTANT_NAME', datetime('now'), TRIGGER_BOOL, 'discord')"
   ```
   - `requires_trigger`: `0` for DMs/main (responds to all), `1` for group channels (needs @mention)
   - Create the group folder: `mkdir -p groups/FOLDER_NAME`

4. Restart to pick up the registration:
   ```bash
   systemctl restart nanoclaw 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null
   ```

## Verify

- Check logs: `tail -20 logs/nanoclaw.log | grep -i discord`
- Send a test message and confirm the agent responds

## Troubleshooting

- **Bot not connecting**: Check `DISCORD_BOT_TOKEN` in `.env`
- **Bot online but not reading messages**: Enable **Message Content Intent** in Discord Developer Portal > Bot > Privileged Gateway Intents
- **Messages not received**: Verify registration: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'dc:%'"`
- **No response in group channel**: Check trigger pattern matches or set `requiresTrigger: false`
- **Bot can't send messages**: Ensure bot has `Send Messages` permission in the channel

## Uninstall

To remove the Discord channel:

1. **Stop NanoClaw**

2. **Cancel affected tasks** (if any scheduled tasks target Discord groups):
   ```bash
   sqlite3 store/messages.db "UPDATE scheduled_tasks SET status = 'completed' WHERE chat_jid IN (SELECT jid FROM registered_groups WHERE channel = 'discord');"
   ```

3. **Remove group registrations:**
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel = 'discord';"
   ```

4. **Remove the plugin directory:**
   ```bash
   rm -rf plugins/channels/discord/
   ```

5. **Remove `DISCORD_BOT_TOKEN` from `.env`**

6. **Restart NanoClaw** — group folders and message history are preserved.
