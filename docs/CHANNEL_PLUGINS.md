# Channel Plugins

Channel plugins decouple messaging platforms from NanoClaw's core. The orchestrator (`src/index.ts`) is entirely channel-agnostic — it discovers channel plugins at startup, initialises them, and routes messages through a common `Channel` interface. Adding a new messaging platform (Telegram, Discord, Slack) means creating a plugin directory. No source code changes are required.

This document covers the full architecture, interfaces, message flows, and a step-by-step guide for adding new channels. For the general plugin system (hooks, container resources, env vars), see [PLUGINS.md](PLUGINS.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [The Channel Interface](#the-channel-interface)
4. [Writing a Channel Plugin](#writing-a-channel-plugin)
5. [JID Namespacing](#jid-namespacing)
6. [Message Flow](#message-flow)
7. [Plugin Scoping](#plugin-scoping)
8. [Database](#database)
9. [WhatsApp Reference Implementation](#whatsapp-reference-implementation)
10. [Adding a New Channel (Checklist)](#adding-a-new-channel-checklist)

---

## Overview

Before this architecture, WhatsApp was hardcoded into the source — `src/index.ts` imported a `WhatsAppChannel` class directly, called Baileys APIs inline, and every outbound message went through `whatsapp.sendMessage()`. Adding a second channel would have required modifying every file that touched messaging.

Now:

- **Channel plugins** live under `plugins/channels/{name}/` and implement a standard `Channel` interface.
- **The core** discovers channel plugins automatically, calls their `onChannel` hook to get a `Channel` object, then calls `connect()`.
- **Outbound routing** uses `routeOutbound(channels, jid, text)` which iterates all connected channels and dispatches to whichever one claims the JID via `ownsJid()`.
- **Inbound messages** flow through callbacks (`onMessage`, `onChatMetadata`) that the orchestrator passes to the channel at init time.

Regular plugins add tools, container hooks, or env vars. Channel plugins are different: they own a network connection, receive inbound messages from a platform, and deliver outbound messages. A channel plugin is identified by `"channelPlugin": true` in its `plugin.json` manifest.

---

## Architecture

### Directory Layout

```
.claude/skills/
  add-channel-whatsapp/        # channel skill (version-controlled templates)
    CHANNEL.md                 # auth docs, troubleshooting
    files/                     # template files (copied on install)
      plugin.json
      index.js
      auth.js
      package.json
  add-channel-telegram/        # same pattern for each channel
    CHANNEL.md
    files/
      plugin.json
      index.js
      package.json

plugins/
  channels/                    # runtime directory (gitignored)
    whatsapp/                  # installed channel plugin
      plugin.json              # manifest: channelPlugin: true
      index.js                 # exports onChannel hook
      auth.js                  # standalone auth helper script
    telegram/                  # installed from templates by /add-channel-telegram
      plugin.json
      index.js

data/
  channels/
    whatsapp/                  # runtime data (gitignored)
      auth/                    # Baileys multi-file auth state
      qr-data.txt              # transient: QR data during auth
      auth-status.txt          # transient: auth status sentinel
    telegram/                  # each channel gets its own data dir
```

Channel plugin **templates** live under `.claude/skills/add-channel-{name}/files/`. When a user runs `/add-channel-{name}`, the skill copies templates into `plugins/channels/{name}/` and runs `npm install`. The entire `plugins/channels/` directory is gitignored — only the skill templates are version-controlled. Runtime data (auth credentials, caches) lives under `data/channels/{name}/`.

### Plugin Discovery

The plugin loader (`src/plugin-loader.ts`) uses `discoverPluginDirs()` to scan two levels:

1. **Top-level:** `plugins/{name}/plugin.json` — standard tool/hook plugins
2. **Nested:** `plugins/{category}/{name}/plugin.json` — categorised plugins (e.g. `plugins/channels/whatsapp/plugin.json`)

No configuration is needed. Any directory under `plugins/channels/` with a `plugin.json` is automatically discovered at startup.

### Startup Sequence

```
loadPlugins()
  → discoverPluginDirs()              # scan plugins/ tree for plugin.json files
  → parseManifest()                    # read + validate each plugin.json
  → import(index.js)                   # dynamically load declared hooks
  → registry.add(plugin)              # register in PluginRegistry

// Channel plugins initialised first
for each plugin where channelPlugin === true:
  → plugin.hooks.onChannel(ctx, config)   # factory: returns Channel object
  → channel.connect()                      # blocks until network connection open

// Then non-channel plugin startup hooks
for each plugin with onStartup hook:
  → plugin.hooks.onStartup(ctx)
```

The order matters: channels connect before other plugins start, so plugins like webhook servers can route through connected channels immediately.

### Key Source Files

| File | Role |
|------|------|
| `src/types.ts` | `Channel` interface, `NewMessage`, `OnInboundMessage`, `OnChatMetadata` |
| `src/plugin-types.ts` | `PluginManifest`, `ChannelPluginConfig`, `PluginContext`, `PluginHooks` |
| `src/plugin-loader.ts` | Discovery, loading, `PluginRegistry` with scoping methods |
| `src/router.ts` | `routeOutbound()` — dispatches text to correct channel by JID; `routeOutboundFile()` — dispatches files |
| `src/index.ts` | Orchestrator: channel init loop (lines ~490–520), message polling |
| `src/container-mounts.ts` | Scoped plugin injection per channel/group |
| `src/container-runner.ts` | Container lifecycle (spawn, I/O, timeout) |
| `src/db.ts` | `channel` column migration on `registered_groups` |
| `src/config.ts` | `CHANNELS_DIR` path constant |

---

## The Channel Interface

Every channel plugin must return an object implementing this interface (defined in `src/types.ts`):

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string): Promise<void>;
  sendFile?(jid: string, buffer: Buffer, mime: string, fileName: string, caption?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  refreshMetadata?(): Promise<void>;
  listAvailableGroups?(): Promise<Array<{ jid: string; name: string }>>;
}
```

| Method | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Unique channel identifier (e.g. `"whatsapp"`, `"telegram"`). Must match the plugin directory name. |
| `connect()` | Yes | Establish the network connection. Should resolve when the channel is ready to send/receive messages. |
| `sendMessage(jid, text, sender?)` | Yes | Deliver a text message to the given JID. Must handle internal queuing if temporarily disconnected. The optional `sender` parameter carries the subagent's role/identity name (e.g. `"Researcher"`) — channels that support per-sender identities (e.g. Telegram bot pool, Discord webhooks) can use it to send from a distinct bot identity. Channels that don't support this can ignore the parameter. |
| `sendFile(jid, buffer, mime, fileName, caption?)` | No | Send a file (image, video, audio, document) to the given JID. Agents call this via the `send_file` MCP tool. The router dispatches to `routeOutboundFile()` which finds the correct channel. Channels that don't implement this will cause `send_file` to return an error to the agent. MIME type is provided so the channel can route to the appropriate platform API (e.g. image vs document upload). |
| `isConnected()` | Yes | Return `true` if the channel can currently send messages. |
| `ownsJid(jid)` | Yes | Return `true` if this channel is responsible for routing to the given JID. Must be non-overlapping across all channels. |
| `disconnect()` | Yes | Graceful shutdown. Called on SIGTERM/SIGINT. |
| `refreshMetadata()` | No | Force re-sync of group names/metadata from the platform. Called via IPC `syncGroupMetadata` command from agent containers. |
| `listAvailableGroups()` | No | Return all groups the bot has access to. Called via IPC `getAvailableGroups` command. |

The orchestrator calls `connect()` after receiving the Channel object — the `onChannel` hook should return the channel **without** connecting.

---

## Writing a Channel Plugin

### 1. Manifest (`plugin.json`)

```json
{
  "name": "telegram",
  "description": "Telegram channel via Bot API",
  "hooks": ["onChannel"],
  "channelPlugin": true,
  "authSkill": "setup-telegram"
}
```

Channel-specific manifest fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channelPlugin` | `boolean` | Yes | Must be `true`. Tells the loader to treat this as a channel plugin. |
| `hooks` | `string[]` | Yes | Must include `"onChannel"`. This is the factory hook. |
| `authSkill` | `string` | No | Name of a Claude Code skill for interactive auth setup (e.g. `"setup-telegram"`). Referenced by the `/setup` skill. |

All standard manifest fields (`containerEnvVars`, `containerHooks`, `containerMounts`, `dependencies`) also work on channel plugins. See [PLUGINS.md](PLUGINS.md) for the full manifest reference.

### 2. The `onChannel` Hook (`index.js`)

The plugin's `index.js` must export an async `onChannel` function:

```javascript
export async function onChannel(ctx, config) {
  const channel = new TelegramChannel(config, ctx.logger);
  return channel;  // DO NOT call connect() — the orchestrator does that
}
```

This function receives two arguments:

#### `ctx` — PluginContext

General API surface available to all plugins:

```typescript
interface PluginContext {
  insertMessage(chatJid: string, id: string, sender: string, senderName: string, text: string): void;
  sendMessage(jid: string, text: string): Promise<void>;
  getRegisteredGroups(): Record<string, RegisteredGroup>;
  getMainChannelJid(): string | null;
  logger: Logger;
}
```

| Field | Description |
|-------|-------------|
| `insertMessage(...)` | Inject a synthetic message into the processing queue (used by webhooks, not typically by channels) |
| `sendMessage(jid, text)` | Send via `routeOutbound` — dispatches to whichever channel owns the JID |
| `getRegisteredGroups()` | Returns current `Record<jid, RegisteredGroup>` snapshot |
| `getMainChannelJid()` | Returns the main admin channel's JID, or `null` |
| `logger` | Pino structured logger instance |

#### `config` — ChannelPluginConfig

Channel-specific configuration and callbacks:

```typescript
interface ChannelPluginConfig {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  paths: {
    storeDir: string;
    groupsDir: string;
    channelsDir: string;
  };
  assistantName: string;
  assistantHasOwnNumber: boolean;
  db: {
    getLastGroupSync(): string | null;
    setLastGroupSync(): void;
    updateChatName(jid: string, name: string): void;
  };
}
```

| Field | Description |
|-------|-------------|
| `onMessage` | Callback to deliver an inbound message to the core. **Only call for registered groups.** |
| `onChatMetadata` | Callback for chat discovery. **Call for every message**, including unregistered groups. The optional `name` parameter lets channels that deliver group names inline (e.g. Telegram) pass them here; channels that sync names separately (WhatsApp) can omit it. |
| `registeredGroups` | Live getter function (not a snapshot). Always returns current state. Use to check if a JID is registered before calling `onMessage`. |
| `paths.storeDir` | Absolute path to `store/` directory |
| `paths.groupsDir` | Absolute path to `groups/` directory |
| `paths.channelsDir` | Absolute path to `data/channels/` — store auth state under `{channelsDir}/{name}/` |
| `assistantName` | The trigger name (e.g. `"TARS"`). Used for message prefixing in shared-account mode. |
| `assistantHasOwnNumber` | If `true`, the bot has a dedicated platform identity. Skip prefixing outbound messages with `AssistantName:`. |
| `db.getLastGroupSync()` | Returns ISO timestamp of last group metadata sync, or `null` |
| `db.setLastGroupSync()` | Record that a metadata sync just happened |
| `db.updateChatName(jid, name)` | Store/update a chat's display name in the database |

### 3. Inbound Message Contract

When your channel receives a message from the network:

```javascript
// 1. ALWAYS call onChatMetadata — even for unregistered groups
//    This feeds group discovery so users can browse available groups
config.onChatMetadata(chatJid, timestamp, groupName);

// 2. Check if the group is registered
const groups = config.registeredGroups();
if (!groups[chatJid]) return;  // not registered, skip

// 3. Deliver the message to the core
config.onMessage(chatJid, {
  id: messageId,
  chat_jid: chatJid,
  sender: senderId,
  sender_name: senderDisplayName,
  content: messageText,
  timestamp: new Date().toISOString(),
  is_from_me: false,
  is_bot_message: false,
  // Optional media fields:
  mediaType: 'audio',           // 'image' | 'video' | 'audio' | 'document'
  mediaPath: '/workspace/group/media/voice.ogg',   // container-relative
  mediaHostPath: '/data/nanoclaw/groups/main/media/voice.ogg',  // absolute host
});
```

The `NewMessage` interface (from `src/types.ts`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique message identifier |
| `chat_jid` | `string` | Yes | Group or chat JID |
| `sender` | `string` | Yes | Sender JID or platform identifier |
| `sender_name` | `string` | Yes | Human-readable sender name |
| `content` | `string` | Yes | Message text content |
| `timestamp` | `string` | Yes | ISO 8601 timestamp |
| `is_from_me` | `boolean` | No | Sent by the authenticated account |
| `is_bot_message` | `boolean` | No | Sent by this assistant (set `true` to prevent loops) |
| `mediaType` | `string` | No | `'image'` / `'video'` / `'audio'` / `'document'` |
| `mediaPath` | `string` | No | Container-relative path to downloaded media |
| `mediaHostPath` | `string` | No | Absolute host path to downloaded media |

### 4. Bot Message Detection

Channels **must** set `is_bot_message: true` on messages the assistant sent. This prevents the agent from processing its own output in a loop. Two strategies:

- **Own-account mode** (`assistantHasOwnNumber: true`): The bot has a dedicated platform account. Simply check `is_from_me`.
- **Shared-account mode** (`assistantHasOwnNumber: false`): The bot shares a human's account (e.g. WhatsApp linked device). Check if the message content starts with `assistantName + ":"` — the prefix the bot adds to outbound messages.

### 5. Auth Script (`auth.js`)

Each channel plugin should provide a standalone auth script for first-time setup. This is run independently during `/setup` — it is **not** loaded by the plugin system.

Convention:
- Located at `plugins/channels/{name}/auth.js`
- Writes status to `data/channels/{name}/auth-status.txt`
- Should support headless operation (no blocking interactive prompts)

**Status file protocol:**

| Value | Meaning |
|-------|---------|
| `already_authenticated` | Valid credentials exist, no action needed |
| `authenticated` | Fresh authentication succeeded |
| `pairing_code:{CODE}` | Pairing code generated, awaiting user input |
| `failed:logged_out` | Credentials revoked, must re-authenticate |
| `failed:qr_timeout` | QR code expired before scan |
| `failed:{reason}` | Other failure (error code or description) |

The `/setup` skill polls this file to drive the interactive auth flow without parsing stdout.

### 6. Data Storage

All persistent channel data (auth credentials, session state, caches) belongs under `data/channels/{name}/`:

```javascript
const authDir = path.join(config.paths.channelsDir, 'telegram', 'auth');
fs.mkdirSync(authDir, { recursive: true });
```

This resolves to `data/channels/telegram/auth/`. The `data/` directory is gitignored. Never store runtime data in the plugin code directory or in `store/`.

---

## JID Namespacing

Each channel must claim a non-overlapping set of JID patterns. The `ownsJid(jid)` method is the **sole routing mechanism** — `routeOutbound()` iterates all connected channels and dispatches to the first one that returns `true`.

| Channel | Group JID | DM JID | `ownsJid` implementation |
|---------|-----------|--------|--------------------------|
| WhatsApp | `{id}@g.us` | `{number}@s.whatsapp.net` | `jid.endsWith('@g.us') \|\| jid.endsWith('@s.whatsapp.net')` |
| Telegram | `tg:{chatId}` | `tg:{chatId}` | `jid.startsWith('tg:')` |
| Discord | `dc:{channelId}` | `dc:{userId}` | `jid.startsWith('dc:')` |

The only hard requirement is that JID patterns **must not overlap** between channels. If two channels both claim a JID, routing behaviour is undefined.

When a group is registered, the `channel` field in the database records which channel owns it (see [Database](#database)).

---

## Message Flow

### Inbound (platform → agent)

```
Platform network (WhatsApp/Telegram/etc.)
  → Channel plugin receives message event
  → channel calls config.onChatMetadata(chatJid, timestamp, name)
  → channel checks config.registeredGroups()[chatJid]
  → channel calls config.onMessage(chatJid, newMessage)
    → orchestrator runs onInboundMessage hooks (e.g. voice transcription)
    → orchestrator stores transformed message in SQLite
  → message polling loop picks up new messages
  → trigger pattern matching (@AssistantName or no-trigger for main)
  → container spawned with conversation context
  → Claude agent processes and responds
  → agent output written via IPC
```

### Outbound text (agent → platform)

```
Agent container writes response
  → IPC watcher reads output file (including optional sender field)
  → routeOutbound(channels, jid, text, sender?)
    → channels.find(c => c.ownsJid(jid) && c.isConnected())
    → channel.sendMessage(jid, text, sender?)
      → platform SDK delivers message to network
      → if sender is set and channel supports it: sends from alternate identity
```

If no connected channel owns the JID, `routeOutbound` logs a warning and returns `false`. The message is dropped.

If the channel is temporarily disconnected, the channel implementation should queue outbound messages internally and flush them on reconnect. The WhatsApp plugin does this with an `outgoingQueue` array.

### Outbound file (agent → platform)

```
Agent calls send_file MCP tool (path, caption?, filename?)
  → MCP validates path starts with /workspace/, file exists, ≤64MB
  → writes IPC JSON: {type: 'send_file', chatJid, filePath, fileName, caption}
  → IPC watcher reads file, translates container path to host path
    → /workspace/group/... → groups/{folder}/...
  → reads file from host, infers MIME from extension
  → routeOutboundFile(channels, jid, buffer, mime, fileName, caption?)
    → channels.find(c => c.ownsJid(jid) && c.isConnected() && c.sendFile)
    → channel.sendFile(jid, buffer, mime, fileName, caption?)
      → channel routes by MIME type to appropriate platform API
```

If no connected channel with `sendFile` support owns the JID, `routeOutboundFile` returns `false` and the agent receives an error. Channels that don't implement `sendFile` simply won't be selected.

---

## Plugin Scoping

Non-channel plugins can restrict which containers they're injected into. This is useful for channel-specific tools (e.g. a WhatsApp voice transcription plugin shouldn't be mounted in Telegram containers).

Declare scoping in `plugin.json`:

```json
{
  "name": "whatsapp-voice-transcription",
  "hooks": ["onInboundMessage"],
  "containerHooks": ["hooks/post-tool-use.js"],
  "channels": ["whatsapp"],
  "groups": ["*"]
}
```

| Field | Default | Effect |
|-------|---------|--------|
| `channels` | `["*"]` (all) | Only inject this plugin's container resources (env vars, skills, hooks, mounts) into groups owned by the listed channel types |
| `groups` | `["*"]` (all) | Only inject into the listed group folders |

When the container runner spawns an agent, it calls `pluginRegistry.getPluginsForGroup(channel, groupFolder)` to determine which plugins contribute resources. The scoping values come from the registered group's `channel` field and `folder` field.

**Channel plugins themselves should NOT set `channels` or `groups`** — those fields are for non-channel plugins that want to limit their scope.

---

## Database

The `registered_groups` table includes a `channel` column that links each group to its owning channel plugin:

```sql
ALTER TABLE registered_groups ADD COLUMN channel TEXT;
```

This migration runs automatically on startup (`src/db.ts`). The column is added without a default value. Groups registered before this migration will have `channel = NULL`. New groups get the channel name set during registration.

When registering a new group:

```typescript
setRegisteredGroup(jid, group, 'telegram');  // third argument is the channel name
```

The `RegisteredGroup` type includes the `channel` field:

```typescript
interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  channel?: string;          // 'whatsapp', 'telegram', etc.
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
}
```

Query groups by channel:

```bash
sqlite3 store/messages.db "SELECT jid, name, folder, channel FROM registered_groups"
```

---

## WhatsApp Reference Implementation

The built-in WhatsApp plugin at `plugins/channels/whatsapp/` is the reference implementation. It demonstrates every aspect of the channel plugin pattern.

### Files

| File | Lines | Purpose |
|------|-------|---------|
| `plugin.json` | 7 | Manifest: `channelPlugin: true`, `hooks: ["onChannel"]`, `authSkill: "setup-whatsapp"` |
| `index.js` | ~415 | `WhatsAppChannel` class + `onChannel` factory function |
| `auth.js` | ~155 | Standalone auth: QR (terminal + HTTP server) and pairing code modes |

### Key Implementation Details

**Dependencies:** Uses `@whiskeysockets/baileys` from its own `package.json` (`dependencies: true` in manifest).

**JID ownership:** Claims `@g.us` (groups) and `@s.whatsapp.net` (DMs).

**LID translation:** WhatsApp sometimes uses "Linked Identity" JIDs (`@lid`) for DMs. The plugin translates these to phone-number JIDs using `sock.signalRepository.lidMapping.getPNForLID()`.

**Reconnection:** On any non-logout disconnect, reconnects automatically. If the first reconnect attempt fails, retries after 5 seconds. Sets `connected = false` during disconnection so `isConnected()` returns `false`.

**Outbound queueing:** Failed sends push `{ jid, text }` onto an `outgoingQueue` array. On reconnect, `flushOutgoingQueue()` drains the queue.

**Group metadata sync:** Calls `sock.groupFetchAllParticipating()` periodically (24h throttle) and writes group names via `config.db.updateChatName()`. The `refreshMetadata()` method bypasses the throttle for IPC-triggered syncs.

**Media handling (inbound):** Downloads images, audio, video, and documents to `groups/{folder}/media/` and sets `mediaPath` (container-relative) and `mediaHostPath` (absolute host path) on the `NewMessage`. Unwraps WhatsApp message wrappers (viewOnce, ephemeral, documentWithCaption) before extracting content, so these special message types are handled transparently.

**Media handling (outbound):** Implements `sendFile()` to send images, videos, audio, and documents back to users. Routes by MIME type: `image/*` uses Baileys' image API, `video/*` uses video API, `audio/*` uses audio API, everything else sends as a document with the original MIME type and filename.

**Message prefixing:** In shared-account mode (`assistantHasOwnNumber: false`), outbound messages are prefixed with `AssistantName: ` so users can distinguish bot messages from human ones. In own-account mode, messages are sent as-is.

**Bot detection:** In shared-account mode, checks `content.startsWith(assistantName + ':')`. In own-account mode, checks `is_from_me`.

### Auth Script Modes

| Flag | Behaviour |
|------|-----------|
| (none) | Terminal QR code via `qrcode-terminal` |
| `--serve` | HTTP server on port 8899 serving QR as HTML/canvas (for headless servers) |
| `--pairing-code --phone NUMBER` | Numeric pairing code instead of QR |

All modes write status to `data/channels/whatsapp/auth-status.txt` and handle 515 stream errors by auto-reconnecting.

---

## Removing a Channel Plugin

To uninstall a channel plugin:

1. **Stop NanoClaw** — the channel must not be connected during removal.

2. **Cancel affected tasks** — cancel scheduled tasks targeting groups on this channel before removing their registrations:
   ```bash
   sqlite3 store/messages.db "UPDATE scheduled_tasks SET status = 'completed' WHERE chat_jid IN (SELECT jid FROM registered_groups WHERE channel = 'telegram');"
   ```

3. **Remove group registrations** — delete entries for groups on this channel:
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel = 'telegram';"
   ```

4. **Remove the plugin directory:**
   ```bash
   rm -rf plugins/channels/telegram/
   ```

5. **Group folders are preserved** — the `groups/{folder}/` directories and their conversation history remain. Delete manually if not needed.

6. **Restart NanoClaw** — it will start without the removed channel.

---

## Adding a New Channel (Checklist)

Step-by-step guide for adding a new channel (using Telegram as an example):

### 1. Create the plugin directory

```
plugins/channels/telegram/
  plugin.json
  index.js
  auth.js
```

### 2. Write the manifest

```json
{
  "name": "telegram",
  "description": "Telegram channel via Bot API",
  "hooks": ["onChannel"],
  "channelPlugin": true,
  "authSkill": "setup-telegram"
}
```

### 3. Implement `index.js`

- Export `onChannel(ctx, config)` that returns a `Channel` object
- Implement all 6 required `Channel` methods
- Choose a non-overlapping JID format (e.g. `telegram:{chatId}`)
- Call `config.onChatMetadata()` for **every** inbound message
- Call `config.onMessage()` only for registered groups (`config.registeredGroups()[jid]`)
- Set `is_bot_message: true` on messages sent by the assistant
- Handle reconnection internally — the orchestrator won't retry for you
- Queue outbound messages during disconnection, flush on reconnect
- Store all persistent data under `config.paths.channelsDir + '/telegram/'`
- (Optional) Implement `sendFile(jid, buffer, mime, fileName, caption?)` to support agent file uploads via the `send_file` MCP tool. Route by MIME type to the appropriate platform API.

### 4. Implement `auth.js`

- Write status to `data/channels/telegram/auth-status.txt`
- Follow the status file protocol (see [Auth Script](#5-auth-script-authjs))
- Support headless operation (the `/setup` skill may run on a server without a display)

### 5. Create a setup skill (optional but recommended)

Create `.claude/skills/add-channel-telegram/CHANNEL.md` that guides users through:
- Bot token creation (BotFather)
- Running the auth script
- Registering their first Telegram group

Reference it as `"authSkill": "setup-telegram"` in the manifest.

### 6. Update `.gitignore`

Add an exception so the plugin is tracked:

```
!plugins/channels/telegram/
```

### 7. Add dependencies

Create a `package.json` in your plugin directory and set `"dependencies": true` in `plugin.json`:

```json
{
  "name": "nanoclaw-channel-telegram",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "grammy": "^1.0.0"
  }
}
```

Run `npm install` in your plugin directory. The plugin-loader runs `npm install` automatically when `dependencies: true` is set, but it's good practice to install once during development.

Each channel plugin manages its own `node_modules`, keeping the core installation lightweight.

### 8. Test

- [ ] `npm run build` passes (channel plugins are plain JS — no compilation needed, but must not break the TypeScript build)
- [ ] `npx vitest run` — existing tests still pass
- [ ] Start NanoClaw — look for `Channel connected` with your channel name in the logs
- [ ] Register a group with `channel: 'telegram'` in the database
- [ ] Send a message through your channel — verify the agent spawns and responds
- [ ] Verify `routeOutbound` delivers responses back through your channel
- [ ] (If `sendFile` implemented) Verify agent can send files via `send_file` MCP tool and they arrive in the chat
- [ ] Check plugin scoping: channel-specific plugins only inject into matching containers
- [ ] Graceful shutdown: `disconnect()` is called on SIGTERM

### 9. Document

Update this file's [JID Namespacing](#jid-namespacing) table with your channel's JID format.
