---
name: create-skill-plugin
description: Create a new skill plugin from chat. Walks through requirements and submits for admin approval. Triggers on "create skill", "make a plugin", "build a skill", "new plugin".
---

# Create Skill Plugin

Create a new NanoClaw plugin from chat. Use when the user asks for a new capability, integration, or tool.

## What you can create from chat

Two archetypes are allowed:

- **skill-only** — agent calls a public API with curl/Bash. No credentials or background processes. Examples: weather (wttr.in), public RSS feed reader, public train times API.
- **mcp** — connects to an MCP server with optional env-var credentials. Examples: GitHub, Notion, anything in the MCP marketplace.

## What you CANNOT create from chat

If the user's request would need any of these, refuse the chat path and tell them to run `/create-skill-plugin` on the host:

- A long-lived background process in NanoClaw (HTTP servers, polling loops, message middleware) → archetype 3, host-process hook
- Code that observes or modifies what the agent does in every turn (tool-use loggers, conversation summarizers) → archetype 4, container hook
- System packages installed in the container image (ffmpeg, ImageMagick) → needs `Dockerfile.partial` and rebuild
- Anything requiring `npm install` of plugin-local node_modules → needs `dependencies: true`

For these, sketch the design in chat and tell the user:

> "This needs to be built on the host because <reason>. Run `/create-skill-plugin` on the host with this spec: <one-paragraph summary>."

## Conversational flow

Ask one question at a time. Multiple-choice when possible. Skip questions whose answer is already obvious from earlier user replies.

### Phase 1 — what does it do?

Open-ended:

> "What capability do you want to add?"

Listen. Then internally classify into archetype 1 or 2 based on:
- "I want to look up X using a public API" → archetype 1 (skill-only)
- "I want to use service Y, here's its MCP server" → archetype 2 (mcp)
- "I want to receive webhooks / poll a feed / forward messages from elsewhere" → STOP, redirect to host

### Phase 2 — specifics

For archetype 1 (skill-only):
- "What's the API URL or curl command?"
- "Does it need an API key?" (if yes, plan to collect in Phase 4)

For archetype 2 (mcp):
- "Do you have an MCP server in mind, or should I look for one?"
- "What's its launch command? (npx package, node script, or absolute path)"
- "What env vars does it need?"

### Phase 3 — scope

Ask:

> "Should this be available in all groups, or just this one?"

Set `groups`:
- "all groups" → `["*"]`
- "just this one" → `["<your current group folder>"]` (you know your folder from the system prompt)

For `channels`, default to `["*"]` unless the user says otherwise.

### Phase 4 — credentials (only if needed)

If the plugin needs an API key or token AND you are in a 1:1 DM with the user:
- Ask: "Please paste the <env var name>."
- Capture in `envVarValues`.

If the plugin needs credentials AND you are in a group chat:
- Do NOT ask for credentials in the group chat.
- Generate the spec WITHOUT `envVarValues`.
- After submitting, tell the user: "I've submitted the install. The plugin needs `<VAR_NAME>` — DM me the value, or set it manually in `.env` on the host."

### Phase 5 — confirm + submit

Summarize in plain language:

> "I'll install a `<archetype>` plugin called `<name>` that <description>. Available to <scope>. <Credentials line if relevant>. Submitting for admin approval."

Then call `mcp__nanoclaw__create_skill_plugin` with the assembled payload (see "Building the payload" below).

After submission, tell the user:

> "Submitted. You'll see an approval card in the admin chat. I'll let you know when it's live."

## Building the payload

The MCP tool takes:

```
{
  name: string,             // lowercase-with-dashes, 2-31 chars
  description: string,      // 1-200 chars
  archetype: "skill-only" | "mcp",
  pluginJson: { ... },      // the runtime plugin manifest
  containerSkillMd: string, // agent-facing SKILL.md content
  mcpJson?: string,         // required for archetype="mcp"
  envVarValues?: { ... }    // optional credential values
}
```

### Archetype 1 template (skill-only)

`pluginJson`:

```json
{
  "name": "<name>",
  "description": "<description>",
  "version": "1.0.0",
  "containerEnvVars": [],
  "channels": ["*"],
  "groups": ["*"]
}
```

`containerSkillMd`:

```markdown
---
name: <name>
description: <agent-facing description>. Use when <trigger context>.
allowed-tools: Bash(curl:*)
---

# <Title>

<One-line description.>

\`\`\`bash
curl -s "<API_URL>"
\`\`\`

Tips:
- <Usage tip>
```

### Archetype 2 template (mcp)

`pluginJson`:

```json
{
  "name": "<name>",
  "description": "<description>",
  "version": "1.0.0",
  "containerEnvVars": ["<TOKEN_NAME>"],
  "channels": ["*"],
  "groups": ["*"]
}
```

`mcpJson`:

```json
{
  "mcpServers": {
    "<server-key>": {
      "command": "npx",
      "args": ["-y", "<package>"],
      "env": { "<TOKEN_NAME>": "${<TOKEN_NAME>}" }
    }
  }
}
```

`containerSkillMd`:

```markdown
---
name: <name>
description: <agent-facing description>. Uses MCP tools for <service>.
allowed-tools: mcp__<server-key>(*)
---

# <Title>

Connect to <service> via the MCP server. Tools are prefixed `mcp__<server-key>`.

## Usage

Call the MCP tools directly. Examples:
- <example 1>
- <example 2>
```

## After submission

The host validates the spec, queues an admin approval card, and on approve:
1. Writes `plugins/<name>/`
2. Writes `.claude/skills/add-skill-<name>/`
3. Appends env vars (if any) to root `.env` or per-group `.env` based on scope
4. Restarts your container

You'll get a system message when the plugin is live. From then on, the new tool/skill is available in the chat.

If the admin rejects, you'll get a system message — apologize to the user and ask if they want to try a different approach.

## Boundary reminders

- You are NOT allowed to set `pluginJson.hooks`, `pluginJson.containerHooks`, or `pluginJson.dependencies = true`. The host will reject any of those.
- You are NOT allowed to install plugins for a different group. `groups` must be `["*"]` (global) or `["<your current group folder>"]` (just this one).
- Reserved env var names cannot be set: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ASSISTANT_NAME`, `CLAUDE_MODEL`, `PATH`, `HOME`, `USER`, `SHELL`, `PWD`. Reserved prefixes also blocked: `NANOCLAW_`, `LD_`, `DYLD_`, `NODE_`.

If the user pushes for something outside these rules, tell them what the boundary is and offer the host workflow as the alternative.
