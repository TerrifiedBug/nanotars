---
name: add-telegram
description: Add Telegram as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill installs the Telegram channel plugin and guides through authentication.

## Step 1: Install Plugin

Check if `plugins/channels/telegram/` exists. If not, copy from skill template files:

```bash
cp -r .claude/skills/channels/telegram/files/* plugins/channels/telegram/
```

Then install dependencies:

```bash
cd plugins/channels/telegram && npm install && cd -
```

## Step 2: Authenticate

Follow the authentication steps in the channel documentation at `.claude/skills/channels/telegram/SKILL.md`:

1. **Create bot** via @BotFather and get the token
2. **Set `TELEGRAM_BOT_TOKEN`** in `.env`
3. **Sync** to container: `cp .env data/env/env`
4. **Disable Group Privacy** (for group chats only)

## Step 3: Build and Restart

```bash
npm run build
```

Then restart the service (systemd or launchd depending on platform).

## Step 4: Register a Chat

Use the `/add-channel` skill to register a Telegram chat. The bot provides a `/chatid` command to discover chat IDs.

## Agent Swarm Support

After completing setup, ask the user if they want Agent Swarm (Teams) support. If yes, invoke `/add-telegram-swarm`.

## Uninstall

See the uninstall section in `.claude/skills/channels/telegram/SKILL.md`.
