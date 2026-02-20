---
name: create-skill-plugin
description: >
  Create a new NanoClaw skill plugin from an idea. Guides through design choices and
  generates a complete add-skill-* installation skill. Triggers on "create skill plugin",
  "create plugin", "new plugin", "make a plugin", "build a plugin".
---

# Create Plugin

## Overview

This skill creates new NanoClaw plugins through guided conversation. The user describes what they want in plain language — a new integration, automation, tool, or capability — and this skill figures out the right architecture, asks clarifying questions, and produces a complete `add-skill-*` installation skill ready to be committed upstream.

You are the plugin system expert. Your job is to translate the user's idea into a working plugin without exposing internal details. Keep questions simple and focused on what the user wants the plugin to *do*, not how the plugin system works under the hood. Never surface implementation concepts like hook types, mount strategies, or container internals in user-facing questions — handle those decisions yourself based on what the plugin needs.

The output of this skill is always a self-contained `add-skill-*` skill directory (with its own `SKILL.md`) that, when invoked, installs and configures the plugin end-to-end.

## Conversational Flow

Guide the user through plugin creation one question at a time. Use `AskUserQuestion` with multiple-choice options when possible, and open-ended questions only when the answer space is too large. Keep language simple and focused on what the plugin *does*, never on how it works internally.

### Phase 1: Understand the Idea

Start with a single open-ended question:

> "What capability do you want to add?"

Let the user describe their idea in their own words. Then, based on their answer, ask follow-up questions **one at a time** to fill in the gaps:

1. **What external service or API is involved?** (if any) — e.g., "Does this connect to a specific service like Notion, GitHub, or a weather API?"
2. **Does it need credentials?** — e.g., "Does [service] require an API key, token, or URL to connect?"
3. **What should the agent be able to do?** — e.g., "What specific actions should the agent perform? For example: look up data, create items, send notifications?"

Skip questions whose answers are already obvious from the user's initial description. Never repeat what they already told you.

### Phase 2: Determine Architecture

**Do this internally. Do NOT ask the user about architecture, hook types, or archetypes.**

Based on the user's answers, determine which archetype(s) apply using this decision tree:

- The agent just needs instructions to call a public API with curl/fetch → **skill-only**
- There is an MCP server available for the service → **MCP integration**
- Something needs to run as a background process in NanoClaw (HTTP server, polling loop, message transformer) → **host process hook**
- Something needs to observe or react to what the agent does during conversations (logging, memory, analytics) → **container hook**

Most plugins combine archetypes. For example:
- An API integration = MCP + skill
- A webhook receiver = host hook + skill
- A conversation logger = container hook + skill

Choose the simplest combination that fulfills the user's request.

### Phase 3: Fill in Details

Ask about specifics based on the archetype(s) you determined. Again, **one question at a time**:

- **For services with APIs:** "Does [service] require an API key? How do you get one?" (skip if already answered in Phase 1)
- **For MCP integrations:** "Do you know the MCP server package or URL, or should I look it up?"
- **For background processes:** "What port should it listen on?" or "How often should it check for updates?"
- **For all plugins:** "What should I call this plugin?" — suggest a name based on the conversation (e.g., "How about `add-skill-weather`?")
- **For sensitive plugins:** If the plugin handles personal data (email, calendar, financial), controls physical systems (home automation), or accesses private accounts (GitHub, Notion), add a **Group Scoping** step to the generated installation SKILL.md. This step asks the user whether all groups should have access or only specific ones, and sets the `"groups"` field in `plugin.json` accordingly. Informational plugins (weather, search, trains) don't need this — default `["*"]` is fine.

### Phase 4: Confirm and Generate

Before generating anything:

1. **Summarize in plain language** what will be created. For example:
   > "I'll create an `add-skill-weather` skill that teaches the agent to look up weather forecasts using the wttr.in API."

2. **List the files** that will be generated.

3. **Ask for confirmation** before proceeding.

4. **Generate all files** for the complete `add-skill-*` skill.

   **Important:** The generated SKILL.md MUST include the Preflight section. This is mandatory for all installation skills.

5. **Run `/nanoclaw-security-audit`** on the generated files before offering to install. If the audit returns FAIL, fix the issues before proceeding. If REVIEW NEEDED, show the findings to the user.

6. **Offer to install immediately** — "Want me to install this plugin now?"

### User-Facing Language

When explaining what a plugin does, translate internal concepts into simple language:

| Internal concept | What to say to the user |
|---|---|
| Skill-only plugin | "The agent will use web requests to do this" |
| MCP integration | "This service has a ready-made connector the agent can use" |
| Host hook (onStartup/onShutdown) | "This needs a background service running alongside NanoClaw" |
| Host hook (onInboundMessage) | "This processes messages before the agent sees them" |
| Container hook | "This observes what the agent does during conversations" |
| containerEnvVars | "The agent needs credentials to connect to this service" |

### Anti-Patterns

**Never do any of these:**

- Never ask "which hook type do you need?" or any variant
- Never mention `plugin.json`, `containerHooks`, `PluginContext`, `SDK events`, or other implementation details
- Never present the archetype decision as a choice to the user — infer it from the conversation
- Never ask multiple questions at once — always one question at a time
- Never use jargon like "mount strategy", "container internals", or "host process" in user-facing language
- Never modify files under `src/`, `container/`, `package.json`, or existing plugins — see Boundaries

## Boundaries

Hard constraints on what this skill can and cannot touch.

### MUST NOT modify:

- `src/` — no TypeScript source changes, ever. The whole point of plugins is to extend without touching core code.
- `container/Dockerfile` or `container/agent-runner/` — no direct Docker image changes (use `Dockerfile.partial` instead)
- `package.json` or `package-lock.json` — no dependency changes
- `groups/` — no agent memory changes
- Existing plugins under `plugins/` — no cross-plugin modifications
- Any other file outside the skill's output directory

### CAN create/modify:

- `.claude/skills/add-skill-{name}/` — the installation skill being generated (the entire purpose of this skill)
- `plugins/{name}/Dockerfile.partial` — optional, for system packages needed inside the container
- `.env` — adding environment variable values, but ONLY with explicit user confirmation
- `plugins/{name}/` — but ONLY via the `cp -r` install step when the generated add-skill-* skill is run, never directly

### Escalation:

- If the user's idea requires changes to NanoClaw source code — explain clearly: "This would need changes to NanoClaw's core code, which is beyond what a plugin can do."
- If the idea requires npm dependencies — don't run `npm install`. Instead, document it as a manual prerequisite in the generated add-skill-* SKILL.md (like how add-channel-telegram documents `npm install grammy`).
- If the idea requires system packages in the Docker image (e.g., ffmpeg) — generate a `Dockerfile.partial` in the plugin's `files/` directory. The generated install skill should include `./container/build.sh` as a step.

## Output Structure

This skill generates the following file tree:

```
.claude/skills/add-skill-{name}/
├── SKILL.md                        # Installation skill (invoked via /add-skill-{name})
└── files/                          # Template files, copied to plugins/{name}/ on install
    ├── plugin.json                 # Plugin manifest (always present)
    ├── container-skills/
    │   ├── SKILL.md                # Agent-facing instructions (if needed)
    │   └── scripts/                # Standalone scripts called by the agent (if needed)
    │       └── {script}.py         # Python, Bash, etc.
    ├── mcp.json                    # MCP server config (if needed)
    ├── index.js                    # Host process hooks (if needed)
    └── hooks/
        └── {event-name}.js         # Container SDK hooks (if needed)
```

- **`files/`** contains the actual plugin — everything the agent or NanoClaw needs at runtime. When the generated `add-skill-*` skill runs, this entire directory is copied to `plugins/{name}/`.
- **`SKILL.md`** contains the installation instructions — what runs when someone invokes `/add-skill-{name}`. It handles env vars, copying files, rebuilding, and verification.
- Only **`plugin.json`** is always present. Everything else is included based on the plugin's needs. A simple skill-only plugin might have just `plugin.json` and a `container-skills/SKILL.md`. A complex integration might include all of the above.

### Code Separation Convention

**container-skills/SKILL.md must never contain inline code blocks with logic.** The SKILL.md is for agent instructions — usage docs, not code. If the plugin needs scripts (Python, Bash, etc.), put them in `files/container-skills/scripts/` and have the SKILL.md reference them by path.

- **OK in SKILL.md**: Simple `curl` one-liners, CLI command examples, tool invocation syntax
- **NOT OK in SKILL.md**: Multi-line Python/Bash scripts, data parsing logic, anything over ~3 lines of code

The entire `container-skills/` directory is mounted into the container at `/workspace/.claude/skills/{name}/`. So `container-skills/scripts/foo.py` on the host becomes `/workspace/.claude/skills/{name}/scripts/foo.py` inside the container:

```bash
python3 /workspace/.claude/skills/{name}/scripts/{script}.py [args]
```

### Dockerfile.partial (Optional)

If the plugin requires system packages or CLI tools inside the agent container (e.g., `ffmpeg` for media, `gog` for Google APIs), create a `Dockerfile.partial` in the `files/` directory. It is automatically merged into the container image by `container/build.sh`.

```dockerfile
USER root
RUN apt-get update && apt-get install -y --no-install-recommends some-package && rm -rf /var/lib/apt/lists/*
USER node
```

Add a rebuild step to the generated SKILL.md install instructions:
```bash
./container/build.sh  # Required when Dockerfile.partial is present
```

See `plugins/calendar/Dockerfile.partial` for a real example (installs `gogcli` and `cal-cli`).

## Generated SKILL.md Template

This is the template for the `add-skill-*` SKILL.md that this skill produces. It follows the pattern used by existing NanoClaw installation skills. Replace all `{placeholders}` with actual values when generating a real skill.

```markdown
---
name: add-skill-{name}
description: {description}. Triggers on "{trigger phrases}".
---

# Add {Title}

{One-line description of what this adds.}

## Preflight

Before installing, verify NanoClaw is set up:

\`\`\`bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
\`\`\`

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
{Additional prerequisites if needed — e.g., npm packages, API key signup}

## Install

1. Check current state:
   ```bash
   [ -d plugins/{name} ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Verify.

2. {If env vars needed: generate/collect API keys, add to .env}

3. {If sensitive plugin — Group Scoping step:}
   Ask the user: "This plugin can {capability}. Should all groups have access, or only specific ones?"
   - If specific groups: update `plugins/{name}/plugin.json` to set `"groups": ["folder1", "folder2"]`
   - If all groups: leave as `"groups": ["*"]` (the default)
   {Skip this step for informational/utility plugins that don't handle personal data or control external systems.}

4. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-{name}/files/ plugins/{name}/
   ```

5. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

{Test commands to confirm the plugin is working}

## Usage Examples

{How to use the new capability}

## How It Works

{Brief explanation of the plugin's mechanism — 2-3 sentences}

## Troubleshooting

{Common issues and how to fix them}

## Remove

1. `rm -rf plugins/{name}/`
2. {Remove env vars from .env if applicable}
3. Rebuild and restart.
```

This template is parameterized. When generating a real skill, adapt sections based on the plugin's complexity — simple plugins (like weather) can skip Troubleshooting; complex ones (like webhook) should include security notes.

## Archetype Templates

Reference templates for each plugin archetype. Use these as the structural foundation when generating plugin code. Replace `{placeholders}` with real values. The code structure is correct and production-ready — not pseudocode.

### Archetype 1: Skill-Only

**When to use:** The agent just needs instructions to call a public API or use existing tools (curl, Bash). No credentials, no background processes, no SDK hooks. This is the simplest plugin type.

**Files:** `plugin.json` + `container-skills/SKILL.md`

#### plugin.json

```json
{
  "name": "{name}",
  "description": "{DESCRIPTION}",
  "containerEnvVars": [],
  "hooks": [],
  "channels": ["*"],
  "groups": ["*"]
}
```

#### container-skills/SKILL.md

For simple one-liner APIs (just curl):

```markdown
---
name: {name}
description: {AGENT_FACING_DESCRIPTION}. Use whenever {TRIGGER_CONTEXT}.
allowed-tools: Bash(curl:*)
---

# {Title}

\```bash
curl -s "{API_ENDPOINT}/{parameter}?format=json"
\```

Tips:
- {Usage tip 1}
- {Usage tip 2}
```

For anything requiring data processing, use a separate script file:

#### container-skills/scripts/{name}.py (or .sh)

Put all logic in a standalone script under `files/container-skills/scripts/`. The SKILL.md just documents how to call it.

#### container-skills/SKILL.md (with script)

```markdown
---
name: {name}
description: {AGENT_FACING_DESCRIPTION}. Use whenever {TRIGGER_CONTEXT}.
allowed-tools: Bash(python3:*,curl:*)
---

# {Title}

{Brief description of what this does.}

## Usage

\```bash
python3 /workspace/.claude/skills/{name}/scripts/{name}.py [args]
\```

{Explain the arguments and output format.}

## Notes

- {Relevant notes about the data source, limitations, etc.}
```

**Notes:**
- `containerEnvVars` is empty — skill-only plugins don't need credentials
- `hooks` is empty — nothing runs in the host process or container hooks
- The `allowed-tools` frontmatter in SKILL.md controls which tools the agent can use (e.g., `Bash(curl:*)` for curl commands)
- **SKILL.md is for instructions, not code.** Simple curl one-liners are fine inline. Anything more complex (parsing, filtering, multi-step logic) must go in `scripts/` as a standalone file
- Scripts are mounted at `/workspace/.claude/skills/{name}/scripts/` inside the container

---

### Archetype 2: MCP Integration

**When to use:** A service has an MCP server the agent can connect to. The agent gets native MCP tools for the service, with a curl fallback. Requires credentials (URL, token) passed as environment variables.

**Files:** `plugin.json` + `mcp.json` + `container-skills/SKILL.md`

#### plugin.json

```json
{
  "name": "{name}",
  "description": "{DESCRIPTION}",
  "containerEnvVars": ["{SERVICE_URL_VAR}", "{SERVICE_TOKEN_VAR}"],
  "hooks": [],
  "channels": ["*"],
  "groups": ["*"]
}
```

#### mcp.json

```json
{
  "mcpServers": {
    "{server-name}": {
      "type": "http",
      "url": "${SERVICE_URL_VAR}/{mcp-endpoint}",
      "headers": {
        "Authorization": "Bearer ${SERVICE_TOKEN_VAR}"
      }
    }
  }
}
```

#### container-skills/SKILL.md

```markdown
---
name: {name}
description: {AGENT_FACING_DESCRIPTION}. Uses native MCP tools for {SERVICE}.
allowed-tools: mcp__{server-name}(*), Bash(curl:*)
---

# {Title}

Control {SERVICE} via its MCP Server integration. If MCP tools and `${SERVICE_URL_VAR}`/`${SERVICE_TOKEN_VAR}` are not configured, tell the user to run `/add-skill-{name}` on the host to set it up.

## How It Works

{SERVICE} is connected as an MCP server. You have native MCP tools available — use them directly. Look for tools prefixed with `mcp__{server-name}`.

## Usage

Use the MCP tools naturally. Examples:
- {Action 1}
- {Action 2}
- {Action 3}

## Fallback: REST API

If MCP tools are unavailable, fall back to the REST API with curl:

\```bash
# Get resource
curl -s "${SERVICE_URL_VAR}/api/{resource}" -H "Authorization: Bearer ${SERVICE_TOKEN_VAR}"

# Create/update resource
curl -s -X POST "${SERVICE_URL_VAR}/api/{resource}" \
  -H "Authorization: Bearer ${SERVICE_TOKEN_VAR}" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
\```

## Notes

- MCP tools are the preferred method — only use curl as a fallback
- {Service-specific note 1}
- {Service-specific note 2}
```

**Notes:**
- `mcp.json` uses `${ENV_VAR}` syntax for variable substitution — NanoClaw expands these from the container environment at runtime
- The `mcpServers` key maps server names to their config; the server name becomes the MCP tool prefix (`mcp__{server-name}`)
- `containerEnvVars` lists the env var names; the actual values come from `.env` and are injected into the container
- Always include a curl fallback in the skill so the agent can function if MCP is misconfigured

---

### Archetype 3: Host Process Hook

**When to use:** Something needs to run as a long-lived process or react to events in the NanoClaw main process — HTTP servers, polling loops, message transformers, startup/shutdown lifecycle. Code runs in Node.js on the host, NOT inside agent containers.

**Files:** `plugin.json` + `index.js` + optionally `container-skills/SKILL.md`

#### plugin.json

```json
{
  "name": "{name}",
  "description": "{DESCRIPTION}",
  "containerEnvVars": ["{ENV_VARS_AGENTS_NEED}"],
  "hooks": ["onStartup", "onShutdown"],
  "channels": ["*"],
  "groups": ["*"]
}
```

#### index.js

```javascript
import http from 'http';

let server;

export async function onStartup(ctx) {
  const secret = process.env.{AUTH_SECRET_VAR};
  if (!secret) {
    ctx.logger.debug('{Name} plugin: {AUTH_SECRET_VAR} not set, skipping');
    return;
  }

  const port = parseInt(process.env.{PORT_VAR} || '{DEFAULT_PORT}', 10);
  const host = process.env.{HOST_VAR} || '127.0.0.1';

  server = http.createServer((req, res) => {
    // Validate method and path
    if (req.method !== 'POST' || req.url !== '/{endpoint}') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Authenticate
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${secret}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Read and parse body
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const text = payload.text;
      if (!text || typeof text !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "text" field' }));
        return;
      }

      // Inject message into the main channel
      const mainJid = ctx.getMainChannelJid();
      if (!mainJid) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No main channel configured' }));
        return;
      }

      const messageId = `{prefix}-${Date.now()}`;
      ctx.insertMessage(mainJid, messageId, '{source-tag}', '{source-label}', text);

      ctx.logger.info({ messageId }, '{Name} message injected');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageId }));
    });
  });

  server.listen(port, host, () => {
    ctx.logger.info({ port, host }, '{Name} server listening');
  });
}

export async function onShutdown() {
  if (server) {
    server.close();
    server = null;
  }
}
```

**Notes:**
- `index.js` must be vanilla JavaScript (not TypeScript) — it is loaded via dynamic `import()` at runtime
- Export named async functions matching the hook names listed in `plugin.json`'s `hooks` array
- Available hooks: `onStartup(ctx)`, `onShutdown()`, `onInboundMessage(msg, channel)`, `onChannel(ctx)`
- The `ctx` (PluginContext) provides: `insertMessage(jid, messageId, sender, senderName, text)`, `sendMessage(jid, text)`, `getRegisteredGroups()`, `getMainChannelJid()`, `logger`
- `containerEnvVars` lists env vars that agents need (e.g., a webhook URL so they can tell other services where to send data) — these are separate from `process.env` vars the host hook itself reads
- Always guard with early return if required env vars are missing
- Always clean up resources (close servers, clear intervals) in `onShutdown()`

---

### Archetype 4: Container Hook

**When to use:** Code needs to observe or react to what the agent does during conversations — logging tool usage, saving memories, analytics, post-processing. Runs inside agent containers, attached to Claude SDK events.

**Files:** `plugin.json` + `hooks/{event-name}.js` + optionally `container-skills/SKILL.md`

#### plugin.json

```json
{
  "name": "{name}",
  "description": "{DESCRIPTION}",
  "containerEnvVars": ["{SERVICE_URL_VAR}"],
  "containerHooks": ["hooks/{event-name}.js"],
  "hooks": [],
  "channels": ["*"],
  "groups": ["*"]
}
```

#### hooks/{event-name}.js

```javascript
// {Description of what this hook does}

function log(msg) {
  console.error(`[agent-runner] [{name}] ${msg}`);
}

function post(url, path, body) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fireAndForget(url, path, body) {
  post(url, path, body).then(
    (res) => log(`${path} ${res.status}`),
    () => {},
  );
}

export function register(ctx) {
  const url = ctx.env.{SERVICE_URL_VAR};
  if (!url) return {};

  log(`Hooks enabled: ${url}`);

  return {
    // ── {Event 1 description} ──
    UserPromptSubmit: [{
      hooks: [async (input) => {
        log(`UserPromptSubmit: session=${input.session_id}`);
        fireAndForget(url, '/api/{endpoint1}', {
          sessionId: input.session_id,
          prompt: input.prompt || '',
        });
        return {};
      }],
    }],

    // ── {Event 2 description} ──
    PostToolUse: [{
      hooks: [async (input) => {
        log(`PostToolUse: tool=${input.tool_name} session=${input.session_id}`);
        fireAndForget(url, '/api/{endpoint2}', {
          sessionId: input.session_id,
          tool_name: input.tool_name,
          tool_input: input.tool_input,
          tool_response: input.tool_response,
        });
        return {};
      }],
    }],

    // ── {Event 3 description} ──
    Stop: [{
      hooks: [async (input) => {
        log(`Stop: session=${input.session_id}`);
        fireAndForget(url, '/api/{endpoint3}', {
          sessionId: input.session_id,
        });
        return {};
      }],
    }],
  };
}
```

**Notes:**
- The hook file exports a `register(ctx)` function — NOT individual event handlers
- `register()` returns an object mapping SDK event names to arrays of hook configs
- Each hook config is `{ hooks: [asyncFunction] }` — the nested structure is required by the SDK
- Every hook function receives an `input` object and MUST return `{}` (empty object)
- Available SDK events:
  - `UserPromptSubmit` — fires when a user message is submitted. Input: `{ session_id, prompt }`
  - `PostToolUse` — fires after each tool call completes. Input: `{ session_id, tool_name, tool_input, tool_response }`
  - `Stop` — fires when the agent turn ends. Input: `{ session_id, stop_reason }`
  - `PreCompact` — fires before context compaction. Input: `{ session_id }`. Use for summarization before context is trimmed
- `ctx.env` contains the container environment variables (from `containerEnvVars` in plugin.json)
- Use `console.error()` for logging (stdout is reserved for SDK communication)
- Use fire-and-forget for non-critical calls; use `await` only when ordering matters (e.g., summarize before complete)
- If `containerHooks` is present in plugin.json, the file is bind-mounted into the container and loaded by the agent runner automatically
- You don't need to subscribe to all events — return only the ones you need

---

### Combining Archetypes

Most real plugins combine multiple archetypes. When generating a plugin, mix and match templates as needed:

- **API integration** = MCP (archetype 2) + skill instructions for the agent
- **Webhook receiver** = host hook (archetype 3) + skill so the agent knows the webhook URL exists
- **Conversation logger** = container hook (archetype 4) + skill explaining what gets logged
- **Full-stack integration** = host hook for background services + container hook for SDK events + MCP for tool access + skill for agent instructions

When combining, merge the `plugin.json` fields: list all `containerEnvVars`, all `hooks` (host), and all `containerHooks` (container) in a single `plugin.json`. Each archetype's files coexist in the same plugin directory.

### containerMounts — Sharing Host Directories with Agents

If a plugin stores data on the host that agents need to read inside their containers (e.g., auth tokens, credential files, cached data), use `containerMounts` in `plugin.json`:

```json
{
  "containerMounts": [
    {"hostPath": "data/my-plugin", "containerPath": "/home/node/.config/my-tool"}
  ]
}
```

- **`hostPath`** — relative to the NanoClaw project root (resolved to absolute at load time). Must exist on disk.
- **`containerPath`** — absolute path inside the container where the directory is mounted read-only.

Use this when the agent needs access to files that persist across container invocations (e.g., OAuth tokens saved by a CLI tool, cached API responses). The mount is read-only inside the container.

Real-world example: the `gmail` and `cal` plugins mount `data/gogcli` at `/home/node/.config/gogcli` so agents can use the `gog` CLI with pre-authenticated credentials.

## Plugin System Reference

Concise technical cheat sheet for generating plugins. Complements the archetype templates above.

### plugin.json Schema

```json
{
  "name": "string (required) — plugin identifier, used for directory and logging",
  "description": "string — human-readable description",
  "containerEnvVars": ["string — env var NAMES from .env to pass into agent containers"],
  "hooks": ["string — host-side hook function names exported from index.js. Valid: onStartup, onShutdown, onInboundMessage, onChannel"],
  "containerHooks": ["string — relative paths to JS files loaded as SDK hooks inside agent containers. E.g., hooks/post-tool-use.js"],
  "containerMounts": [{"hostPath": "string", "containerPath": "string — additional read-only mounts for agent containers"}],
  "dependencies": "boolean — set true if plugin has its own package.json/node_modules. If the plugin also has hooks + index.js, package.json should include \"type\": \"module\" (the loader uses import())",
  "channels": ["string — filter which channel types get this plugin. Default: [\"*\"] (all channels)"],
  "groups": ["string — filter which group folders get this plugin's container injection. Default: [\"*\"] (all groups)"]
}
```

### How Plugins Are Loaded

Source: `src/plugin-loader.ts`

1. On startup, NanoClaw scans `plugins/` for directories containing `plugin.json`
2. Each manifest is parsed and validated
3. If `hooks` are declared, `index.js` is dynamically imported and hook functions are extracted
4. All plugins are registered in a PluginRegistry
5. `container-skills/` directories are discovered and bind-mounted into containers at `/workspace/.claude/skills/{name}/`
6. `mcp.json` fragments are merged with the root `.mcp.json` to build the container's MCP config
7. `containerHooks` files are bind-mounted and registered with the SDK in the agent runner
8. `containerEnvVars` names are collected; their values are read from `.env` and injected into the container environment

### Environment Variable Flow

`.env` -> listed in `containerEnvVars` -> container process environment -> accessible in:

- **Agent skills** (via Bash: `$VAR_NAME`)
- **MCP configs** (via `${VAR_NAME}` substitution in mcp.json)
- **Container hooks** (via `ctx.env.VAR_NAME` in register function)

Host hooks access env vars directly via `process.env.VAR_NAME` (they run in the main NanoClaw process).

### Skill Mount Path

Container skills from `plugins/{name}/container-skills/` are mounted read-only at:

```
/workspace/.claude/skills/{name}/
```

Claude Code's walk-up discovery finds them automatically — no configuration needed.

### Container Hook Mount Path

Container hooks from `plugins/{name}/hooks/` are mounted into the container and registered with the agent runner SDK automatically. The mount name is `{plugin-name}--{filename}`.
