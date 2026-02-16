---
name: create-channel-plugin
description: >
  Create a new NanoClaw channel plugin from scratch. Guides through design choices and
  generates a complete channel plugin ready to install. Triggers on "create channel plugin",
  "new channel plugin", "make a channel", "build a channel plugin".
---

# Create Channel Plugin

## Overview

This skill creates new NanoClaw channel plugins through guided conversation. The user describes which messaging platform they want to connect, and this skill generates a complete, working channel plugin following the established pattern (WhatsApp reference implementation).

You are the channel plugin expert. Your job is to translate the user's idea into a working channel plugin without exposing internal architecture details. Keep questions focused on what the user wants — platform credentials, chat behavior, naming — not on how the plugin system works under the hood.

The output is a self-contained channel plugin directory (`plugins/channels/{name}/`) with all required files, plus an `add-channel-{name}` installation skill.

## Conversational Flow

Guide the user one question at a time using `AskUserQuestion` with multiple-choice options when possible.

### Phase 1: Understand the Channel

Start with:

> "Which messaging platform do you want to connect?"

Common answers: Discord, Telegram, Slack, Signal, Matrix, SMS/Twilio, email (IMAP), IRC, custom webhook.

Then ask follow-ups **one at a time** based on context:

1. **Authentication**: "How do you authenticate with [platform]?" — e.g., bot token, OAuth, API key, phone number
2. **npm package**: "Is there a Node.js library for [platform]?" — suggest one if you know it (e.g., `grammy` for Telegram, `discord.js` for Discord, `@slack/bolt` for Slack)
3. **Message format**: "How does [platform] identify chats?" — helps determine JID format

Skip questions whose answers are obvious from the platform choice.

### Phase 2: Determine Architecture (Internal — Do NOT Ask)

All channel plugins follow the same archetype:

- `plugin.json` with `channelPlugin: true` and `hooks: ["onChannel"]`
- `index.js` exporting `onChannel(ctx, config)` returning a `Channel` object
- Optional `auth.js` for standalone authentication setup

Determine internally:
- **JID prefix**: Must be unique and non-overlapping. Convention: `{platform}:` prefix (e.g., `tg:123`, `dc:456`, `slack:C01ABC`)
- **Auth method**: Token-based (add to `.env`) or interactive (needs `auth.js`)
- **npm dependency**: If needed, document as prerequisite (don't run `npm install`)

### Phase 3: Fill in Details

Ask about specifics, one at a time:

1. **Plugin name**: Suggest based on platform (e.g., "How about `discord`?")
2. **Bot behavior**: "Should the bot respond to all messages in a chat, or only when @mentioned/triggered?" — determines default `requiresTrigger`
3. **Group vs DM support**: "Should this support group chats, DMs, or both?"

### Phase 4: Confirm and Generate

Before generating:

1. **Summarize** what will be created:
   > "I'll create a `{name}` channel plugin with:
   > - `plugin.json` — manifest with `channelPlugin: true`
   > - `index.js` — {Platform} bot using {library}, implements Channel interface
   > - `auth.js` — standalone auth script (if applicable)
   > - `/add-channel-{name}` skill — so you can run `/add-channel-{name}` to install it anytime"

2. **List prerequisites** (npm packages, API setup)

3. **Ask for confirmation** before generating

4. **Generate all files**

5. **Next step — make this prominent and unmissable:**

   > **Your `{name}` channel plugin is ready! To install it, run `/add-channel-{name}`.**

   Then immediately ask with `AskUserQuestion`:
   > "Want me to install it now, or would you prefer to run `/add-channel-{name}` later?"
   >
   > Options: ["Install now", "I'll run /add-channel-{name} later"]

   - If **"Install now"**: Follow the generated `add-channel-{name}` SKILL.md installation steps inline — install npm dependencies, copy plugin files into `plugins/channels/{name}/`, collect credentials from the user and add to `.env`, run `auth.js` if applicable, rebuild and restart. Do not tell the user to go read the SKILL.md — just execute the steps yourself.
   - If **"I'll run /add-channel-{name} later"**: Confirm with: "Sounds good. When you're ready, just say `/add-channel-{name}` and I'll walk you through it."

### User-Facing Language

| Internal concept | What to say |
|---|---|
| Channel interface | "The bot connects to [platform] and receives/sends messages" |
| ownsJid() | "Each channel has its own chat ID format so messages route correctly" |
| ChannelPluginConfig | "The plugin gets callbacks to deliver messages into NanoClaw" |
| onChannel hook | "The plugin creates a bot instance when NanoClaw starts" |
| auth.js | "A setup script to authenticate with [platform]" |

### Anti-Patterns

**Never do any of these:**

- Never ask about hooks, Channel interface methods, or plugin.json fields
- Never mention `PluginContext`, `ChannelPluginConfig`, `ownsJid`, or other internals
- Never present architecture decisions as user choices
- Never ask multiple questions at once
- Never modify `src/` files — channel plugins must work without touching core code

## Boundaries

### MUST NOT modify:

- `src/` — no TypeScript source changes
- `container/` — no Docker image changes
- Root `package.json` or `package-lock.json` — channel deps go in per-plugin packages
- Existing plugins — no cross-plugin modifications

### CAN create/modify:

- `plugins/channels/{name}/` — the channel plugin being generated
- `.claude/skills/add-channel-{name}/` — the installation skill
- `.env` — adding environment variables, with user confirmation only

### Escalation:

- If the platform requires core code changes: "This would need changes to NanoClaw's core code. You could use `/nanoclaw-customize` for that."
- If npm dependencies needed: document as prerequisite in the installation skill
- If container image changes needed (system packages): document as manual step

## Output Structure

Create all files in a single skill directory:

### Installation skill: `.claude/skills/add-channel-{name}/`

This is both the **user-facing entry point** (shows up as `/add-channel-{name}` in the skills list) and the home for the channel plugin template files. The `files/` subdirectory holds the actual channel plugin code that gets copied to `plugins/channels/{name}/` when installed.

```
.claude/skills/add-channel-{name}/
├── SKILL.md                        # Installation skill (name: add-channel-{name})
├── CHANNEL.md                      # Channel reference (auth details, platform docs)
└── files/                          # Template channel plugin (copied on install)
    ├── plugin.json                 # Manifest (always present)
    ├── index.js                    # Channel implementation (always present)
    └── auth.js                     # Auth setup script (if interactive auth needed)
```

The `add-channel-{name}` SKILL.md must:
- Have frontmatter with `name: add-channel-{name}` (e.g., `name: add-channel-discord`)
- Include the full installation flow: npm install, copy plugin files, collect credentials, restart
- Reference the channel files with: `cp -r .claude/skills/add-channel-{name}/files/* plugins/channels/{name}/`
- Include registration and verification steps

## Channel Plugin Templates

### plugin.json

```json
{
  "name": "{name}",
  "description": "{Platform} channel via {library}",
  "hooks": ["onChannel"],
  "channelPlugin": true,
  "dependencies": true,
  "authSkill": "setup-{name}"
}
```

Notes:
- `channelPlugin: true` is required — tells the plugin loader this provides a Channel
- `hooks: ["onChannel"]` is required — the entry point for channel initialization
- `authSkill` is optional — references an interactive auth skill if the platform needs it

### index.js

Channel implementations must export `onChannel(ctx, config)` and return an object implementing the Channel interface:

```javascript
class {Name}Channel {
  name = '{name}';

  // Internal state
  #client = null;
  #connected = false;
  #config;
  #logger;

  constructor(config, logger) {
    this.#config = config;
    this.#logger = logger;
  }

  async connect() {
    // Initialize platform client
    // Set up message listeners
    // Call this.#config.onMessage() for inbound messages
    // Call this.#config.onChatMetadata() for chat discovery
  }

  async sendMessage(jid, text, sender) {
    // Send message to the platform
    // Extract platform-native ID from JID: jid.replace(/^{prefix}:/, '')
    // Optional: if sender is provided and the platform supports per-sender
    // identities (e.g. webhook display names, bot pools), use it to send
    // from a distinct identity. Channels that don't support this can ignore it.
  }

  isConnected() {
    return this.#connected;
  }

  ownsJid(jid) {
    // CRITICAL: Must return true ONLY for JIDs this channel owns
    // Must not overlap with any other channel's JID format
    return jid.startsWith('{prefix}:');
  }

  async disconnect() {
    // Clean shutdown of platform client
  }

  // Optional: refresh group/chat metadata
  async refreshMetadata() { }

  // Optional: list available groups/chats for registration
  async listAvailableGroups() {
    return []; // Array of { jid: string, name: string }
  }
}

export async function onChannel(ctx, config) {
  const channel = new {Name}Channel(config, ctx.logger);
  return channel;
}
```

### Key Implementation Rules

1. **JID Format**: Use `{prefix}:{platform_id}` — e.g., `tg:123456`, `dc:789012`, `slack:C01ABC`. The prefix MUST be unique across all channels. WhatsApp uses `@g.us` and `@s.whatsapp.net` suffixes instead.

2. **Message Delivery**: Inbound messages go through `config.onMessage(chatJid, message)` where message matches the `NewMessage` interface:
   ```javascript
   config.onMessage(chatJid, {
     id: messageId,
     chat_jid: chatJid,
     sender: senderId,
     sender_name: senderDisplayName,
     content: messageText,
     timestamp: new Date().toISOString(),
     is_from_me: false,
     is_bot_message: false,
   });
   ```

3. **Chat Metadata**: Call `config.onChatMetadata(chatJid, timestamp, optionalName)` for every message — this powers chat discovery for registration.

4. **Registered Groups Check**: Only deliver full messages for registered chats:
   ```javascript
   const groups = config.registeredGroups();
   if (!groups[chatJid]) return; // Skip unregistered chats
   ```

5. **Bot Message Detection**: Set `is_bot_message: true` for messages the bot itself sent. How this is detected varies by platform.

6. **Assistant Name Prefix**: Most platforms display bot names already (Telegram, Discord, Slack). WhatsApp is special because it shares a phone number, so it prefixes `AssistantName: `. New channels typically do NOT need this prefix.

7. **Credentials**: Read from `process.env` inside `onChannel` — values come from `.env` via NanoClaw's env loader. Guard with early return if missing.

### auth.js Template (when needed)

```javascript
/**
 * {Platform} Authentication Script
 *
 * Usage: node plugins/channels/{name}/auth.js
 */
import fs from 'fs';

const AUTH_DIR = './data/channels/{name}/auth';
const STATUS_FILE = './data/channels/{name}/auth-status.txt';

async function authenticate() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Platform-specific auth flow:
  // 1. Validate credentials exist
  // 2. Test connection
  // 3. Save state to AUTH_DIR
  // 4. Write status to STATUS_FILE

  fs.writeFileSync(STATUS_FILE, 'authenticated');
  console.log('Successfully authenticated with {Platform}!');
  process.exit(0);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
```

Status file protocol:
- `authenticated` — success
- `already_authenticated` — already set up
- `failed:{reason}` — failure with reason

### Installation Skill Template

```markdown
---
name: add-channel-{name}
description: Add {Platform} as a messaging channel. Triggers on "add {name}", "{name} setup", "{name} channel".
---

# Add {Platform} Channel

Adds {Platform} as a messaging channel to NanoClaw.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
{- Platform-specific prerequisites (bot creation, API keys, etc.)}

## Install

1. Check current state:
   ```bash
   [ -d plugins/channels/{name} ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Verify.

2. Collect credentials from user and add to `.env`:
   ```bash
   # Add to .env
   {PLATFORM}_BOT_TOKEN=user_provided_value
   ```

3. Copy channel plugin files into place:
   ```bash
   mkdir -p plugins/channels/{name}
   cp -r .claude/skills/add-channel-{name}/files/* plugins/channels/{name}/
   ```

4. Install plugin dependencies:
   ```bash
   cd plugins/channels/{name} && npm install && cd -
   ```

5. {If interactive auth needed: run auth.js}
   ```bash
   node plugins/channels/{name}/auth.js
   ```

6. Rebuild and restart:
   ```bash
   npm run build && systemctl restart nanoclaw
   ```

## Register a Chat

After the channel connects, use `/nanoclaw-add-group` to register a group/chat on this channel.

## Verify

- Check logs: `tail -20 logs/nanoclaw.log | grep '{name}'`
- Send a test message and confirm agent responds

## Troubleshooting

- Bot not connecting: Check credentials in `.env`
- Messages not received: Verify chat is registered in `registered_groups` table
- No response: Check trigger pattern matches (or `requiresTrigger: false` for main)

## Uninstall

To remove the {Platform} channel:

1. **Stop NanoClaw**

2. **Cancel affected tasks:**
   ```bash
   sqlite3 store/messages.db "UPDATE scheduled_tasks SET status = 'completed' WHERE chat_jid IN (SELECT jid FROM registered_groups WHERE channel = '{name}');"
   ```

3. **Remove group registrations:**
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel = '{name}';"
   ```

4. **Remove the plugin directory:**
   ```bash
   rm -rf plugins/channels/{name}/
   ```

5. **Remove credentials from `.env`**

6. **Restart NanoClaw** — group folders and message history are preserved.
```

## Reference: Existing Channel Plugins

### WhatsApp (`plugins/channels/whatsapp/`)
- **JID format**: `{number}@g.us` (groups), `{number}@s.whatsapp.net` (DMs)
- **Library**: `@whiskeysockets/baileys`
- **Auth**: QR code scan or pairing code via `auth.js`
- **Special**: Prefixes bot name (shared phone number), LID translation, media download

### Telegram (`plugins/channels/telegram/`)
- **JID format**: `tg:{chat_id}` (positive for DMs, negative for groups)
- **Library**: `grammy`
- **Auth**: Bot token from BotFather (simple env var)
- **Special**: @mention translation to trigger pattern, `/chatid` command, built-in swarm bot pool via `sender` parameter

## Plugin System Reference

- Plugins are discovered from `plugins/` and `plugins/{category}/` directories
- Channel plugins go in `plugins/channels/{name}/`
- Data storage goes in `data/channels/{name}/`
- The `onChannel(ctx, config)` hook receives a `PluginContext` (logger, insertMessage, sendMessage, getRegisteredGroups, getMainChannelJid) and `ChannelPluginConfig` (onMessage, onChatMetadata, registeredGroups, paths, assistantName, assistantHasOwnNumber, db)
- Channels are initialized before other plugin hooks (`onStartup`)
- The `Channel` interface: `name`, `connect()`, `sendMessage(jid, text, sender?)`, `isConnected()`, `ownsJid(jid)`, `disconnect()`, optional `refreshMetadata()`, optional `listAvailableGroups()`. The `sender` parameter carries the subagent's identity name — channels that support per-sender identities (bot pools, webhooks) can use it; others ignore it.
