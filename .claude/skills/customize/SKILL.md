---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Workflow

1. **Understand the request** - Ask clarifying questions
2. **Plan the changes** - Identify files to modify
3. **Implement** - Make changes directly to the code
4. **Test guidance** - Tell user how to verify

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/types.ts` | TypeScript interfaces (includes Channel) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | Database initialization and queries |
| `src/whatsapp-auth.ts` | Standalone WhatsApp authentication script |
| `groups/CLAUDE.md` | Global memory/persona |

## Adding Skills to NanoClaw Agents

**Important distinction:**
- `.claude/skills/` in the project root → for Claude Code in this terminal (setup, debug, customize)
- `plugins/{name}/container-skills/SKILL.md` → agent instructions, auto-mounted into containers by the plugin loader

### How agent skills work

The plugin loader discovers `plugins/*/container-skills/` directories and mounts them read-only into containers at `/workspace/.claude/skills/{name}/`. Claude Code's walk-up discovery finds them automatically — no rebuild needed.

The agent also loads knowledge from:
1. **`groups/global/CLAUDE.md`** — shared across ALL groups
2. **`groups/{folder}/CLAUDE.md`** — specific to one group

### Adding a skill via a plugin

Create a plugin directory with a manifest and skill file:

```bash
mkdir -p plugins/my-skill/container-skills
```

Write `plugins/my-skill/plugin.json`:
```json
{
  "name": "my-skill",
  "description": "What this plugin does",
  "containerEnvVars": [],
  "hooks": []
}
```

Write `plugins/my-skill/container-skills/SKILL.md` with standard Claude Code skill frontmatter:

```markdown
---
name: my-skill
description: What this skill does and when to use it.
allowed-tools: Bash(tool-name:*)
---

# Skill instructions here
```

If the skill needs environment variables passed to containers, list them in `containerEnvVars` and add the values to `.env`.

No container rebuild needed — just add the plugin and restart NanoClaw.

### Adding knowledge for one group only

Add a section to that group's `groups/{folder}/CLAUDE.md`.

### Importing skills from OpenClaw or external sources

1. Fetch the skill content (e.g., from `https://github.com/openclaw/openclaw/blob/main/skills/{name}/SKILL.md`)
2. Create a plugin: `mkdir -p plugins/{name}/container-skills`
3. Write a `plugin.json` manifest (see above)
4. Save the skill as `plugins/{name}/container-skills/SKILL.md` (keep the frontmatter — the agent uses it)
5. If the skill requires system packages (e.g., `ffmpeg`) not in the container, add them to `container/Dockerfile` and rebuild with `./container/build.sh`
6. If the skill requires npm packages, install them in `container/agent-runner/` and rebuild
7. Restart NanoClaw

## Common Customization Patterns

### Adding a New Input Channel (e.g., Telegram, Slack, Email)

Questions to ask:
- Which channel? (Telegram, Slack, Discord, email, SMS, etc.)
- Same trigger word or different?
- Same memory hierarchy or separate?
- Should messages from this channel go to existing groups or new ones?

Implementation pattern:
1. Create `src/channels/{name}.ts` implementing the `Channel` interface from `src/types.ts` (see `src/channels/whatsapp.ts` for reference)
2. Add the channel instance to `main()` in `src/index.ts` and wire callbacks (`onMessage`, `onChatMetadata`)
3. Messages are stored via the `onMessage` callback; routing is automatic via `ownsJid()`

### Adding a New MCP Integration

Questions to ask:
- What service? (Calendar, Notion, database, etc.)
- What operations needed? (read, write, both)
- Which groups should have access?

Implementation:
1. Create a plugin directory: `mkdir -p plugins/{name}/container-skills`
2. Write `plugin.json` with any needed `containerEnvVars`
3. Add an `mcp.json` fragment in the plugin directory with the MCP server config (the plugin loader merges it with the root `.mcp.json`)
4. Write `container-skills/SKILL.md` documenting the available tools for the agent
5. Add env var values to `.env` and restart

### Changing Assistant Behavior

Questions to ask:
- What aspect? (name, trigger, persona, response style)
- Apply to all groups or specific ones?

Simple changes → edit `src/config.ts`
Persona changes → edit `groups/CLAUDE.md`
Per-group behavior → edit specific group's `CLAUDE.md`

### Adding New Commands

Questions to ask:
- What should the command do?
- Available in all groups or main only?
- Does it need new MCP tools?

Implementation:
1. Commands are handled by the agent naturally — add instructions to `groups/CLAUDE.md` or the group's `CLAUDE.md`
2. For trigger-level routing changes, modify `processGroupMessages()` in `src/index.ts`

### Changing Deployment

Questions to ask:
- Target platform? (Linux server, Docker, different Mac)
- Service manager? (systemd, Docker, supervisord)

Implementation:
1. Create appropriate service files
2. Update paths in config
3. Provide setup instructions

## After Changes

Rebuild and restart. Detect the platform first:

```bash
npm run build
# Linux (systemd):
systemctl restart nanoclaw
# macOS (launchd):
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Example Interaction

User: "Add Telegram as an input channel"

1. Ask: "Should Telegram use the same @Andy trigger, or a different one?"
2. Ask: "Should Telegram messages create separate conversation contexts, or share with WhatsApp groups?"
3. Create `src/channels/telegram.ts` implementing the `Channel` interface (see `src/channels/whatsapp.ts`)
4. Add the channel to `main()` in `src/index.ts`
5. Tell user how to authenticate and test
