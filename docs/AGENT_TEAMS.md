# Agent Teams Guide

Define persistent subagents for each group. Each agent has its own identity, instructions, and model.

## Quick Start

1. Create directory: `groups/{folder}/agents/{name}/`
2. Create `agent.json`:
   ```json
   {"description": "Research specialist", "model": "haiku", "maxTurns": 10}
   ```
3. Create `IDENTITY.md` with personality
4. Create `CLAUDE.md` with instructions (optional)
5. Next container spawn discovers the agent

## File Structure

```
groups/{folder}/agents/{name}/
├── agent.json      (required)
├── IDENTITY.md     (optional)
└── CLAUDE.md       (optional)
```

### agent.json

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| description | string | yes | — | Shown to lead agent |
| model | string | no | inherit | `"haiku"`, `"sonnet"`, `"opus"` |
| maxTurns | number | no | 10 | Max conversation turns |

## How It Works

1. Container starts → agent-runner scans `agents/*/agent.json`
2. Each agent registered as `subagent_type` on Task tool
3. Lead agent dispatches: `Task(subagent_type="research", prompt="...")`
4. Agent runs with its own IDENTITY.md and CLAUDE.md
5. Agent sends results via `send_message` with bold name prefix

## Communication

Agents use the NanoClaw MCP tool:
```
mcp__nanoclaw__send_message(text="Findings here...", sender="Research")
```

Display format:
- WhatsApp: **Research**: Findings here...
- Slack: Posted as "Research" username

## Background Execution

Agents run in background by default. A heartbeat mechanism keeps the parent container alive while subagents work.

## Example: Research + Writer

```
groups/team/agents/
├── research/
│   ├── agent.json    {"description": "Research specialist", "model": "haiku"}
│   └── IDENTITY.md   "You are a thorough researcher..."
└── writer/
    ├── agent.json    {"description": "Content writer", "model": "sonnet"}
    └── IDENTITY.md   "You are a clear, engaging writer..."
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Agent not appearing | Missing `agent.json` |
| Agent not responding | Increase `maxTurns` |
| Agent uses wrong model | Check `model` field value |
