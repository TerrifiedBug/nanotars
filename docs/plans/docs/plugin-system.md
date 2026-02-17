# Plugin System

## Overview

NanoClaw's plugin system extends functionality without modifying core `src/` code. Plugins provide channels (messaging platforms), container skills, hooks, environment variables, MCP server configs, and custom mounts.

## Plugin Discovery

Plugins are loaded from the `plugins/` directory with one level of nesting:

```
plugins/
├── channels/
│   ├── whatsapp/plugin.json    ← plugins/channels/whatsapp
│   ├── telegram/plugin.json    ← plugins/channels/telegram
│   └── discord/plugin.json     ← plugins/channels/discord
├── commute/plugin.json         ← plugins/commute
└── agent-browser/plugin.json   ← plugins/agent-browser
```

Each plugin requires a `plugin.json` manifest.

## Plugin Manifest (plugin.json)

```json
{
  "name": "my-plugin",
  "description": "What this plugin does",
  "version": "1.0.0",
  "channelPlugin": false,
  "dependencies": true,
  "hooks": ["onStartup"],
  "containerHooks": ["hooks/my-hook.js"],
  "containerEnvVars": ["MY_API_KEY"],
  "containerMounts": [
    { "hostPath": "/path/on/host", "containerPath": "/workspace/extra/name" }
  ],
  "channels": ["*"],
  "groups": ["*"],
  "authSkill": "setup-my-plugin"
}
```

### Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique plugin identifier |
| `description` | string | No | Human-readable description |
| `version` | string | No | Semver version |
| `channelPlugin` | boolean | No | `true` if this provides a Channel |
| `dependencies` | boolean | No | `true` if plugin has its own `package.json` |
| `hooks` | string[] | No | Runtime hooks: `onChannel`, `onStartup`, `onShutdown`, `onInboundMessage` |
| `containerHooks` | string[] | No | JS files mounted into container as SDK hooks |
| `containerEnvVars` | string[] | No | Env var names to expose to containers |
| `containerMounts` | object[] | No | Additional host→container bind mounts |
| `channels` | string[] | No | Scope to specific channels (`["*"]` = all) |
| `groups` | string[] | No | Scope to specific groups (`["*"]` = all) |
| `authSkill` | string | No | Reference to interactive auth skill |
| `minCoreVersion` | string | No | Minimum NanoClaw version required |

## Channel Plugins

Channel plugins connect messaging platforms to NanoClaw. They have `channelPlugin: true` and `hooks: ["onChannel"]`.

### Channel Interface

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  refreshMetadata?(): Promise<void>;
  listAvailableGroups?(): Promise<Array<{ jid: string; name: string }>>;
}
```

### JID Namespacing

Each channel claims non-overlapping JID patterns. `ownsJid()` is the sole routing mechanism.

| Channel | Group JID | DM JID | `ownsJid` |
|---------|-----------|--------|-----------|
| WhatsApp | `{id}@g.us` | `{number}@s.whatsapp.net` | `endsWith('@g.us') \|\| endsWith('@s.whatsapp.net')` |
| Telegram | `tg:{chatId}` | `tg:{chatId}` | `startsWith('tg:')` |
| Discord | `dc:{channelId}` | `dc:{userId}` | `startsWith('dc:')` |

### Channel Implementation Pattern

```javascript
// plugins/channels/{name}/index.js
class MyChannel {
  name = 'my-channel';
  #client = null;
  #connected = false;
  #config;
  #logger;

  constructor(config, logger) {
    this.#config = config;
    this.#logger = logger;
  }

  async connect() {
    // Initialize client
    // Set up message listeners
    // Call this.#config.onMessage(chatJid, message) for inbound
    // Call this.#config.onChatMetadata(chatJid, timestamp, name) for discovery
  }

  async sendMessage(jid, text, sender) {
    const platformId = jid.replace(/^prefix:/, '');
    // Send via platform API
  }

  isConnected() { return this.#connected; }
  ownsJid(jid) { return jid.startsWith('prefix:'); }
  async disconnect() { /* cleanup */ }
}

export async function onChannel(ctx, config) {
  return new MyChannel(config, ctx.logger);
}
```

### ChannelPluginConfig (provided to onChannel)

| Property | Type | Description |
|----------|------|-------------|
| `onMessage(jid, msg)` | function | Deliver inbound message to NanoClaw |
| `onChatMetadata(jid, ts, name?)` | function | Report chat metadata for discovery |
| `registeredGroups()` | function | Get all registered groups |
| `paths` | object | Data directories for this channel |
| `assistantName` | string | Bot's display name |
| `assistantHasOwnNumber` | boolean | WhatsApp-specific: shared phone number |
| `db` | object | Direct database access |

## Skill Plugins

Skill plugins add agent capabilities by mounting `container-skills/` directories into containers.

```
plugins/my-skill/
├── plugin.json
├── container-skills/
│   └── SKILL.md         # Claude reads this as instructions
└── package.json         # Optional: if dependencies: true
```

The `SKILL.md` file is mounted into the container and auto-loaded by the Claude Agent SDK via `CLAUDE.md` discovery.

## Container Hooks

Plugins can provide JavaScript files that run inside the agent container as SDK hooks.

```json
{
  "containerHooks": ["hooks/my-hook.js"]
}
```

Hook files must export a `register()` function:

```javascript
export function register(ctx) {
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [async (input) => {
        // Inspect/modify tool input
        return undefined; // allow, or return { decision: 'deny', reason: '...' }
      }]
    }],
    PreCompact: [{
      hooks: [async (input) => {
        // Archive conversation before compaction
      }]
    }]
  };
}
```

## Plugin Scoping

Plugins can be scoped to specific channels or groups:

```json
{
  "channels": ["whatsapp"],
  "groups": ["main", "work-chat"]
}
```

- `["*"]` or omitted → applies to all
- Specific names → only those channels/groups see the plugin's skills, hooks, and mounts

## Dockerfile.partial

Plugins that need system packages inside the agent container can provide a `Dockerfile.partial`:

```
plugins/my-plugin/
├── plugin.json
├── Dockerfile.partial    # Merged into container image on build
└── ...
```

The `container/build.sh` script scans `plugins/*/Dockerfile.partial` and `plugins/*/*/Dockerfile.partial`, inserting their contents before the final `USER node` line.

```dockerfile
# Example Dockerfile.partial
USER root
RUN apt-get update && apt-get install -y --no-install-recommends some-package \
    && rm -rf /var/lib/apt/lists/*
USER node
```

## MCP Server Configuration

Plugins can provide MCP server configs in `mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/workspace/extra/my-server/index.js"],
      "env": { "API_KEY": "${MY_API_KEY}" }
    }
  }
}
```

These are merged with the root `.mcp.json` and written per-group to prevent race conditions during concurrent container spawns.
