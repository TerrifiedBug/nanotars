---
name: add-channel-telegram
description: Add Telegram as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill installs the Telegram channel plugin and guides through authentication.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Step 1: Install Plugin

Check if `plugins/channels/telegram/` exists. If not, copy from skill template files:

```bash
cp -r .claude/skills/add-channel-telegram/files/* plugins/channels/telegram/
```

Then install dependencies:

```bash
cd plugins/channels/telegram && npm install && cd -
```

## Step 2: Authenticate

### Create a Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow prompts:
   - Bot name: Something friendly (e.g., "TARS Assistant")
   - Bot username: Must end with "bot" (e.g., "andy_ai_bot")
3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### Set Environment Variable

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN_HERE
```

Sync to container environment:

```bash
cp .env data/env/env
```

### Disable Group Privacy (for group chats)

By default, Telegram bots in groups only receive messages that @mention the bot or are commands. To let the bot see all messages:

1. Open `@BotFather`
2. Send `/mybots` and select your bot
3. Go to **Bot Settings** > **Group Privacy** > **Turn off**

Optional if the user only wants trigger-based responses via @mentioning the bot.

## Step 3: Build and Restart

```bash
npm run build
```

Then restart the service (systemd or launchd depending on platform).

## Step 4: Register a Chat

Use `/chatid` command in any Telegram chat with the bot to get the chat ID.

- **Private chat**: `tg:123456789` (positive number)
- **Group chat**: `tg:-1001234567890` (negative number)

Register the main group (there can only be one) via `/nanoclaw-setup`. Add additional groups with `/nanoclaw-add-group`.

## Trigger Behavior

The bot responds when:
1. Chat has `requiresTrigger: false` (e.g., main group)
2. Bot is @mentioned in Telegram (auto-translated to trigger pattern)
3. Message matches trigger pattern directly (e.g., starts with @TARS)

## Agent Swarm Support

After completing setup, ask the user if they want Agent Swarm (Teams) support. If yes, invoke `/add-channel-telegram-swarm`.

The plugin has built-in bot pool support for agent teams. Each subagent appears as a different bot identity in Telegram.

To enable, create 3-5 additional bots via @BotFather and set:

```bash
TELEGRAM_BOT_POOL=TOKEN1,TOKEN2,TOKEN3
```

Pool bots are send-only (no polling). When a subagent calls `send_message` with a `sender` parameter, the host assigns a pool bot and renames it to match the sender's role. See `/add-channel-telegram-swarm` for full setup guide.

## Commands

- `/chatid` — Get chat ID for registration
- `/ping` — Check if bot is online

## Troubleshooting

### Bot not responding

1. Verify `TELEGRAM_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`
3. For non-main chats: ensure message includes trigger pattern
4. Check service is running

### Bot only responds to @mentions in groups

Group Privacy is enabled (default). Fix:
1. Open `@BotFather` > `/mybots` > select bot > **Bot Settings** > **Group Privacy** > **Turn off**
2. Remove and re-add the bot to the group (required for the change to take effect)

### Verifying bot token

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
```

## Uninstall

1. Stop NanoClaw
2. Remove group registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'tg:%'"`
3. Remove plugin: `rm -rf plugins/channels/telegram/`
4. Remove `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_POOL` from `.env`
5. Restart NanoClaw
