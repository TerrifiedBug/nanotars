# Plugin System

NanoClaw plugins are runtime-loaded extensions that add capabilities to agent containers without modifying core source code. A plugin can provide container skills, MCP server configs, environment variables, SDK hooks, additional filesystem mounts, host-side hooks, or even entirely new messaging channels.

Plugins are discovered at startup by scanning the `plugins/` directory. Each subdirectory with a `plugin.json` manifest is loaded into a `PluginRegistry` that the rest of the system queries for container configuration.

## Directory Structure

```
plugins/{name}/
  plugin.json              # Required — manifest declaring capabilities
  index.js                 # Host-side hook implementations (if hooks declared)
  mcp.json                 # MCP server config fragment (merged into container)
  Dockerfile.partial       # Dockerfile commands merged at image build time
  container-skills/        # Agent skill files mounted into containers
    SKILL.md               # Claude Code skill (instructions + allowed-tools)
  hooks/                   # SDK hook scripts run inside containers
    post-tool-use.js       # Example: hook that runs after each tool call
```

Only `plugin.json` is required. Everything else is optional depending on what the plugin does.

**Note:** All skills — including core skills like `agent-browser` — are delivered as plugins. There is no separate `container/skills/` path; the plugin system is the single mechanism for making skills available to agents.

## Plugin Manifest (`plugin.json`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Unique plugin identifier |
| `description` | `string` | No | Human-readable description |
| `containerEnvVars` | `string[]` | No | Env var names from `.env` to pass into agent containers |
| `hooks` | `string[]` | No | Host-side hook function names exported by `index.js` |
| `containerHooks` | `string[]` | No | JS files (relative paths) loaded as SDK hooks inside containers |
| `containerMounts` | `Array<{hostPath, containerPath}>` | No | Additional read-only mounts for containers |
| `dependencies` | `boolean` | No | Whether the plugin has its own `package.json`/`node_modules` |
| `channelPlugin` | `boolean` | No | `true` if this plugin provides a messaging channel (requires `onChannel` hook) |
| `authSkill` | `string` | No | Name of a Claude Code skill for interactive auth setup (e.g., `"add-channel-discord"`) |
| `channels` | `string[]` | No | Only inject into containers for these channels (default: `["*"]` = all). See [Plugin Scoping](CHANNEL_PLUGINS.md#plugin-scoping). |
| `groups` | `string[]` | No | Only inject into containers for these group folders (default: `["*"]` = all). See [Plugin Scoping](CHANNEL_PLUGINS.md#plugin-scoping). |
| `version` | `string` | No | Plugin version (semver). Informational. |
| `minCoreVersion` | `string` | No | Minimum NanoClaw core version required (semver). Informational. |

### Examples

Minimal plugin (container skill only):

```json
{
  "name": "weather",
  "description": "Weather forecasts and current conditions",
  "containerEnvVars": [],
  "hooks": []
}
```

Plugin with env vars and MCP config:

```json
{
  "name": "homeassistant",
  "description": "Home Assistant smart home integration via MCP",
  "containerEnvVars": ["HA_URL", "HA_TOKEN"],
  "hooks": []
}
```

Plugin with host-side hooks:

```json
{
  "name": "webhook",
  "description": "HTTP webhook endpoint for external event ingestion",
  "containerEnvVars": ["NANOCLAW_WEBHOOK_URL", "NANOCLAW_WEBHOOK_SECRET"],
  "hooks": ["onStartup", "onShutdown"]
}
```

Plugin with container hooks and env vars:

```json
{
  "name": "claude-mem",
  "description": "Persistent cross-session memory",
  "containerEnvVars": ["CLAUDE_MEM_URL"],
  "containerHooks": ["hooks/post-tool-use.js"],
  "hooks": []
}
```

Plugin with additional container mounts:

```json
{
  "name": "calendar",
  "description": "Calendar access via gog CLI and CalDAV",
  "containerEnvVars": ["GOG_KEYRING_PASSWORD", "GOG_ACCOUNT", "CALDAV_ACCOUNTS"],
  "containerMounts": [
    {
      "hostPath": "data/gogcli",
      "containerPath": "/home/node/.config/gogcli"
    }
  ],
  "hooks": []
}
```

## Hook Lifecycle

Plugins can export four hook functions, declared in the `hooks` array and implemented in `index.js`.

### `onStartup(ctx: PluginContext)`

Called once during NanoClaw startup, after the plugin is loaded. Use for starting servers, initializing connections, or any setup that needs to happen before message processing begins.

The `PluginContext` provides:

| Method/Property | Description |
|----------------|-------------|
| `ctx.insertMessage(chatJid, id, sender, senderName, text)` | Inject a message into the processing queue |
| `ctx.sendMessage(jid, text)` | Send a message to any registered chat |
| `ctx.getRegisteredGroups()` | Get all registered groups |
| `ctx.getMainChannelJid()` | Get the main (admin) channel JID |
| `ctx.logger` | Pino logger instance |

### `onShutdown()`

Called during graceful shutdown. Clean up servers, connections, timers. Errors are caught and logged without blocking other plugins from shutting down.

### `onInboundMessage(msg: InboundMessage, channel: string)`

Called for every inbound message before it reaches the agent. Hooks run in plugin load order (alphabetical by directory name). Each hook receives the message and returns a (potentially modified) message. This enables message transformation, filtering, enrichment, or logging.

The `InboundMessage` has the same shape as `NewMessage`: `id`, `chat_jid`, `sender`, `sender_name`, `content`, `timestamp`, plus optional `is_from_me`, `is_bot_message`, `mediaType`, `mediaPath`, and `reply_context`.

### `onChannel(ctx: PluginContext, config: ChannelPluginConfig)`

Return a `Channel` object to register a messaging channel (WhatsApp, Telegram, etc.). Channel plugins are a specialized plugin type with their own directory convention, interfaces, and lifecycle. See **[Channel Plugins](CHANNEL_PLUGINS.md)** for the full guide.

### Execution Order

During startup, the registry processes each plugin in load order:
1. `onChannel` is called first (if present) to register the channel
2. `onStartup` is called second (if present)

During message processing:
1. All `onInboundMessage` hooks run in sequence before the message reaches the agent

During shutdown:
1. All `onShutdown` hooks run; errors are caught per-plugin so one failure does not block others

## Container Integration

Plugins affect agent containers through six mechanisms, all managed by the `PluginRegistry` and applied by `container-runner.ts` when spawning containers.

### Environment Variables

Each plugin declares which env var names from the host `.env` should be passed into containers via `containerEnvVars`. These are merged with the core set (`ANTHROPIC_API_KEY`, `ASSISTANT_NAME`, `CLAUDE_MODEL`) and deduplicated. Only lines matching declared var names are extracted from `.env` and written to a filtered env file mounted into the container.

### Container Skills (`container-skills/`)

If a plugin has a `container-skills/` subdirectory, it is mounted read-only into the container at:

```
/workspace/.claude/skills/{plugin-name}/
```

This makes skill files (like `SKILL.md`) available to Claude Code inside the container. Skills define instructions and `allowed-tools` that the agent can use.

### MCP Config (`mcp.json`)

If a plugin has an `mcp.json` file, its `mcpServers` entries are merged with the root `.mcp.json` (if present) and any other in-scope plugins' MCP configs. The merged result is written per-group to `data/env/{groupFolder}/merged-mcp.json` and mounted read-only at `/workspace/.mcp.json` inside that group's container. Plugin scoping means each group only gets the MCP servers from plugins that apply to its channel and folder.

Example `mcp.json`:

```json
{
  "mcpServers": {
    "home-assistant": {
      "type": "http",
      "url": "${HA_URL}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${HA_TOKEN}"
      }
    }
  }
}
```

### Container Hooks (`containerHooks`)

JS files declared in `containerHooks` are mounted into the container at:

```
/workspace/plugin-hooks/{plugin-name}--{filename}
```

These are SDK hook scripts (e.g., `post-tool-use.js`) that the agent-runner loads at startup inside the container. They run in the container's Node.js process, not on the host.

### Container Mounts (`containerMounts`)

Additional host directories declared in `containerMounts` are mounted read-only into the container at the specified `containerPath`. Paths that do not exist on the host are skipped with a warning.

### Container Build Steps (`Dockerfile.partial`)

Plugins that need system-level tools or compiled dependencies baked into the container image can include a `Dockerfile.partial` file. During `./container/build.sh`, all plugin partials are merged into the base Dockerfile before the `USER node` line.

Example `plugins/calendar/Dockerfile.partial`:

```dockerfile
# Install gog CLI for Google Calendar
RUN curl -sL "https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin gog

# Build cal-cli for CalDAV support
COPY plugins/calendar/cal-cli/ /opt/cal-cli/
RUN cd /opt/cal-cli && npm install --omit=dev && npm run build && rm -rf src/ tsconfig.json
```

**When to use:**
- Installing system binaries (CLI tools, native libraries)
- Building TypeScript/compiled tools that run inside containers
- Any dependency that should persist across container spawns (baked into the image)

**When NOT to use:**
- Runtime data that changes (use `containerMounts` instead)
- Environment variables (use `containerEnvVars`)
- Node.js packages available via npm (install in the plugin's own `package.json`)

**Build context:** The build context is the project root, so `COPY` paths are relative to the NanoClaw directory. After adding or modifying a `Dockerfile.partial`, rebuild the container image with `./container/build.sh`.

**Ordering:** Plugin partials are inserted in filesystem order (alphabetical by plugin path), after all base image setup but before the `USER node` line that switches to the non-root user.

## How Skills Create Plugins

Installation skills live in `.claude/skills/add-skill-{name}/` and contain a `SKILL.md` that guides Claude Code through creating a plugin. The typical pattern is:

1. The skill's `SKILL.md` contains step-by-step instructions
2. Steps create `plugins/{name}/` with all necessary files (manifest, skills, MCP config, etc.)
3. Environment variables are added to `.env`
4. The project is rebuilt (`npm run build`) and the service restarted

Example from `add-skill-brave-search`:

```
Step 1: Check if already configured
Step 2: Get API key from user
Step 3: Save BRAVE_API_KEY to .env
Step 4: Create plugins/brave-search/ with plugin.json and container-skills/
Step 5: Test the key
Step 6: Build and restart
```

This pattern means skills are idempotent install scripts. The skill contains the knowledge; the plugin directory is the artifact.

## Plugin Discovery and Loading

The `loadPlugins()` function:

1. Scans `plugins/` for subdirectories containing `plugin.json`
2. Parses and validates each manifest via `parseManifest()`
3. If the manifest declares `hooks`, imports `index.js` from the plugin directory and extracts the named functions
4. Registers each plugin in the `PluginRegistry`

Plugins are loaded in filesystem order (alphabetical by directory name). The registry is set on the container runner via `setPluginRegistry()` so that all subsequent container spawns include plugin configuration.

## Removal

To fully uninstall a plugin:

1. Remove the plugin directory:
   ```bash
   rm -rf plugins/{name}/
   ```

2. Remove any env vars the plugin added to `.env` (check `containerEnvVars` in the manifest first):
   ```bash
   sed -i '/^VAR_NAME=/d' .env
   ```

3. If the plugin had an `mcp.json`, the merged config will be regenerated on next startup without it.

4. Rebuild and restart:
   ```bash
   npm run build
   # Then restart the service
   ```

## Why Plugins

NanoClaw upstream uses a single-process architecture where new capabilities require modifying core source files (`src/index.ts`, `src/container-runner.ts`, etc.). This works well for a single maintainer but creates friction when multiple people want different integrations:

- **Merge conflicts**: Every integration touches the same hot files. Rebasing against upstream means resolving conflicts in `index.ts` every time.
- **Growing complexity**: Each integration adds conditionals to the startup path, shutdown path, and message loop. The core files grow unbounded.
- **All-or-nothing**: You can't install one integration without carrying the code for all of them.

The plugin system solves this by moving integrations out of core source entirely:

| Aspect | Without plugins (upstream) | With plugins |
|--------|--------------------------|--------------|
| Adding a capability | Modify `src/index.ts`, `container-runner.ts`, etc. | Drop a directory in `plugins/` |
| Upstream sync | Resolve merge conflicts in modified files | `git pull` — no conflicts (plugins aren't in core) |
| Removing a capability | Revert scattered changes across files | `rm -rf plugins/{name}/` |
| Container env vars | Hardcode in `container-runner.ts` | Declare in `plugin.json` → auto-injected |
| MCP servers | Edit container's `.mcp.json` directly | Drop `mcp.json` in plugin dir → auto-merged |
| Agent skills | Modify container build or mount scripts | Put in `container-skills/` → auto-mounted |
| Testing in isolation | Difficult — changes are interleaved | Each plugin is self-contained |

The tradeoff is a small abstraction layer (`plugin-loader.ts`, `plugin-types.ts`, ~280 lines total). The runtime cost is negligible — plugins are loaded once at startup.

### Security Model

Plugins run with the same trust level as core code — they execute in the host Node.js process and have full access to `PluginContext`. This is intentional: plugins are installed by the operator, not by end users or agents.

Container-side components (skills, hooks, MCP configs) are mounted read-only and run inside the sandboxed agent container. An agent cannot install, modify, or remove plugins — it can only use what's mounted into its container.

| Component | Runs where | Trust level |
|-----------|-----------|-------------|
| `index.js` hooks | Host process | Full (operator-installed) |
| `container-skills/` | Agent container (read-only mount) | Sandboxed |
| `containerHooks` | Agent container (read-only mount) | Sandboxed |
| `mcp.json` | Merged config mounted into container | Sandboxed |

## Source Code Changes

The plugin system adds two new files and modifies five existing files. Total footprint: ~280 lines of new code.

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/plugin-loader.ts` | ~230 | Plugin discovery, manifest parsing, `PluginRegistry` class, hook execution, env/skill/mount/MCP collection |
| `src/plugin-types.ts` | ~45 | TypeScript interfaces: `PluginManifest`, `PluginContext`, `PluginHooks`, `LoadedPlugin` |

### Modified Files

**`src/index.ts`** — Plugin lifecycle integration into the main process:
- Import and call `loadPlugins()` at startup
- Pass `PluginRegistry` to the container runner via `setPluginRegistry()`
- Build `PluginContext` (wiring `insertMessage`, `sendMessage`, `getRegisteredGroups`, `getMainChannelJid`, `logger`)
- Call `registry.startup(ctx)` after WhatsApp connects
- Call `registry.shutdown()` on graceful exit
- Run `registry.runInboundHooks(msg, channel)` on every inbound message before queueing
- Register plugin channels alongside WhatsApp

**`src/container-mounts.ts`** — Container mount construction (extracted from container-runner):
- Query `pluginRegistry.getContainerEnvVars()` to build the env var filter list
- Query `pluginRegistry.getSkillPaths()` and mount each plugin's `container-skills/` read-only at `/workspace/.claude/skills/{name}`
- Query `pluginRegistry.getContainerHookPaths()` and mount hook JS files at `/workspace/plugin-hooks/{name}`
- Query `pluginRegistry.getContainerMounts()` for additional read-only mounts
- Call `pluginRegistry.getMergedMcpConfig()` to write a unified MCP config into the container

**`src/container-runner.ts`** — Container lifecycle (spawn, I/O, timeout, logging)

**`src/types.ts`** — Type changes:
- `OnInboundMessage` callback made `async` (returns `Promise`) to support async plugin hooks

**`container/Dockerfile`** — Container image:
- Added `jq` to system packages (used by some plugin skills)
- Added `/workspace/.claude/skills` directory creation
- Added env-dir sourcing in entrypoint (plugin env vars)

**`container/agent-runner/src/index.ts`** — Agent runner inside containers:
- Scan `/workspace/plugin-hooks/` for JS files at startup
- Import each hook file and call its `register(ctx)` function
- Merge returned SDK hook registrations into the agent's hook chain

### Supporting Changes

| File | Change |
|------|--------|
| `.gitignore` | Added `plugins/*`, `!plugins/.gitkeep` |
| `plugins/.gitkeep` | Empty file to track the directory |
| `src/plugin-loader.test.ts` | Unit tests for manifest parsing, env var collection, skill path discovery, MCP merging |

## Example: Minimal Plugin (Weather)

A weather plugin that gives agents access to weather data via a container skill, using free public APIs (no API key required).

### `plugins/weather/plugin.json`

```json
{
  "name": "weather",
  "description": "Weather forecasts and current conditions",
  "containerEnvVars": [],
  "hooks": []
}
```

### `plugins/weather/container-skills/SKILL.md`

```markdown
---
name: weather
description: Get weather forecasts and current conditions for any location.
allowed-tools: Bash(curl:*)
---

# Weather Lookup

Use curl for weather lookups (no API key needed):

```bash
curl -s "wttr.in/CityName?format=3"          # One-line summary
curl -s "wttr.in/CityName?T"                  # Full forecast
```

Tips:
- URL-encode spaces (`New+York`)
- `?m` metric, `?u` USCS
- `?1` today only, `?0` current only
```

That is the entire plugin. On startup, NanoClaw discovers `plugins/weather/plugin.json`, sees the `container-skills/` directory, and mounts it into every agent container at `/workspace/.claude/skills/weather/`. Agents can then answer weather questions using the skill instructions.

## Example: Host-Side Hooks (Webhook)

The webhook plugin demonstrates `onStartup`/`onShutdown` hooks — it runs an HTTP server alongside WhatsApp so external services can push events into the message pipeline.

### `plugins/webhook/plugin.json`

```json
{
  "name": "webhook",
  "description": "HTTP webhook endpoint for external event ingestion",
  "containerEnvVars": ["NANOCLAW_WEBHOOK_URL", "NANOCLAW_WEBHOOK_SECRET"],
  "hooks": ["onStartup", "onShutdown"]
}
```

### `plugins/webhook/index.js`

The hook implementations are plain ESM functions matching the names in the `hooks` array:

```javascript
import crypto from 'crypto';
import http from 'http';

let server;

export async function onStartup(ctx) {
  const secret = process.env.NANOCLAW_WEBHOOK_SECRET;
  if (!secret) return;

  const port = parseInt(process.env.WEBHOOK_PORT || '3457', 10);

  server = http.createServer((req, res) => {
    // Validate Bearer token, parse JSON body { source, text }
    // ...
    const mainJid = ctx.getMainChannelJid();
    const messageId = `wh-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    ctx.insertMessage(mainJid, messageId, `webhook:${source}`, source, text);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messageId }));
  });

  server.listen(port, () => ctx.logger.info({ port }, 'Webhook server listening'));
}

export async function onShutdown() {
  if (server) { server.close(); server = null; }
}
```

Key patterns:
- `ctx.insertMessage()` injects messages into the queue — the normal processing loop picks them up
- `ctx.getMainChannelJid()` routes to the admin channel
- `ctx.logger` provides structured logging
- The server only starts if the env var is set (safe default = off)
- No npm dependencies — uses Node.js built-in `http` and `crypto`

## Example: Container Hooks (Claude-Mem)

The claude-mem plugin demonstrates `containerHooks` — JS files that run inside the agent container as SDK hooks, separate from the host-side `index.js` hooks.

### `plugins/claude-mem/plugin.json`

```json
{
  "name": "claude-mem",
  "description": "Persistent cross-session memory",
  "containerEnvVars": ["CLAUDE_MEM_URL"],
  "containerHooks": ["hooks/post-tool-use.js"],
  "hooks": []
}
```

Note: `hooks` is empty (no host-side hooks), but `containerHooks` declares a JS file that runs inside every agent container.

### `plugins/claude-mem/hooks/post-tool-use.js`

```javascript
export function register(ctx) {
  const url = ctx.env.CLAUDE_MEM_URL;
  if (!url) return {};

  return {
    PostToolUse: [{
      hooks: [async (input) => {
        const text = `[${ctx.groupFolder}] Tool: ${input.tool_name}\n` +
          `Input: ${JSON.stringify(input.tool_input).slice(0, 500)}\n` +
          `Output: ${JSON.stringify(input.tool_response).slice(0, 2000)}`;

        fetch(`${url}/api/memory/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, project: `nanoclaw-${ctx.groupFolder || 'main'}` }),
        }).catch(() => {});

        return {};
      }],
    }],
  };
}
```

This hook auto-captures every tool use (Bash, Read, MCP calls) to a persistent vector database. The `register()` function receives a context object with `env` and `groupFolder`, and returns SDK hook registrations.

### Available SDK Events

| Event | Input fields | When it fires |
|-------|-------------|---------------|
| `UserPromptSubmit` | `session_id`, `prompt` | When a user message is submitted to the agent. |
| `PostToolUse` | `session_id`, `tool_name`, `tool_input`, `tool_response` | After each tool call completes. |
| `Stop` | `session_id`, `stop_reason` | When the agent turn ends. |
| `PreCompact` | `session_id` | Before context compaction. Use for summarization before context is trimmed. |

Every hook function **must** return `{}` (empty object). Use `console.error()` for logging inside containers (stdout is reserved for SDK communication).

### How container hooks differ from host hooks

| | Host hooks (`hooks`) | Container hooks (`containerHooks`) |
|--|---------------------|-----------------------------------|
| Runs in | Host Node.js process | Agent container |
| Has access to | `PluginContext` (messages, channels) | SDK hook API (tool inputs/outputs) |
| Lifecycle | `onStartup`/`onShutdown` per-process | Per-container invocation |
| Use case | Servers, message transformation, channels | Observability, guardrails, tool augmentation |
