---
name: nanoclaw-add-agent
description: >
  Add a persistent agent definition to a group. Creates IDENTITY.md and CLAUDE.md files
  for a specialized subagent that the lead agent can spawn via Agent Teams.
  Triggers on "add agent", "create agent", "new agent", "agent team", "add subagent".
---

# Add Agent to Group

This skill creates persistent agent definitions for NanoClaw groups. Each agent gets an identity and instruction set that the lead agent reads and passes to `TeamCreate` when spawning subagents via Agent Teams.

Agent definitions are just files — no core code changes, no database changes.

## Architecture

```
groups/{folder}/
  agents/
    {name}/
      IDENTITY.md    ← "You are a research specialist..."
      CLAUDE.md      ← capabilities, rules, tools to focus on
```

The lead agent reads these files and uses them when creating teammates. Subagent memory lives in the group's session (SDK-managed).

## Workflow

### Step 1: Choose a Group

List registered groups:

```bash
sqlite3 store/messages.db "SELECT folder, name, channel FROM registered_groups ORDER BY folder"
```

If only one group exists, use it automatically. Otherwise ask:

> "Which group should this agent be added to?"

Present the groups as options.

### Step 2: Show Status and Choose What to Add

Discover the full picture — what's installed in this group vs what templates are available:

```bash
# Installed agents in this group (already active)
ls -d groups/{folder}/agents/*/IDENTITY.md 2>/dev/null

# Available pre-built templates (not yet installed)
ls -d .claude/skills/nanoclaw-add-agent/agents/*/IDENTITY.md 2>/dev/null
```

For each entry found, read the first line of its IDENTITY.md to get a one-line description.

Compare the two lists: a template is "available" only if its name does NOT already exist in `groups/{folder}/agents/`. Present both lists clearly:

> "Here's the agent status for `{folder}`:
>
> *Installed:*
> - research — You are a research specialist...
> - dev — You are a software developer...
>
> *Available to add:*
> - writer — You are a writer and editor...
> - coordinator — You are a project coordinator...
>
> Want to add one of the available agents, or create a custom one?"

If no agents are installed yet, skip the "Installed" section. If all templates are already installed, only show "Custom agent" as an option.

Present options using `AskUserQuestion` — list each available (uninstalled) template, plus "Custom agent" as the last option. Read descriptions dynamically from the template files — do NOT hardcode them.

#### Pre-built templates

If the user picks a template, copy the files from the template directory and skip Steps 3-4:

```bash
cp -r .claude/skills/nanoclaw-add-agent/agents/{name}/ groups/{folder}/agents/{name}/
```

Confirm the name with the user — they may want to rename it (e.g., `research` → `marine-biologist`). If renamed, copy the files and update the `sender` references in CLAUDE.md.

Then proceed directly to Step 5 (which just verifies the files).

#### Custom agent

If the user picks "Custom agent", continue to Steps 3-4.

### Step 3: Agent Name (Custom only)

Ask the user:

> "What's a short name for this agent? This is used as the folder name and the identity the lead agent will use when spawning it."
>
> Examples: `research`, `dev`, `coordinator`, `writer`, `analyst`

Validate: lowercase, alphanumeric with hyphens, no spaces. Suggest a sanitized version if needed.

Check for conflicts:

```bash
[ -d "groups/{folder}/agents/{name}" ] && echo "EXISTS" || echo "OK"
```

If it already exists, ask if they want to overwrite or pick a different name.

### Step 4: Agent Role & Capabilities (Custom only)

Ask the user:

> "What does this agent do? Describe its role and expertise in a sentence or two."

Then ask:

> "What tools or skills should this agent focus on?"

Options (multi-select):
1. **Web search & research** — Browse the web, fetch URLs, search for information
2. **Code & development** — Write, review, and debug code
3. **File management** — Read, write, and organize workspace files
4. **Communication** — Send messages to the chat, coordinate with teammates
5. **All capabilities** — Full access to everything the lead agent can do

### Step 5: Generate Agent Files

#### If using a pre-built template

The files were already copied in Step 2. Verify they're in place:

```bash
ls groups/{folder}/agents/{name}/IDENTITY.md groups/{folder}/agents/{name}/CLAUDE.md
```

If the user renamed the agent, update the `sender` value in CLAUDE.md to match the new name.

#### If creating a custom agent

Create the agent directory and files:

```bash
mkdir -p groups/{folder}/agents/{name}
```

**IDENTITY.md** — Write based on the role description from Step 4. Keep it concise — 3-5 sentences that define who this agent is.

**CLAUDE.md** — Write based on capabilities from Step 4. Follow the same structure as the pre-built templates in `.claude/skills/nanoclaw-add-agent/agents/` — include "Your Role", "How to Work", and "Communication Rules" sections. The communication rules are critical for Agent Teams to work properly (sender parameter, message formatting, internal tags).

### Step 6: Optional Scheduled Task

Ask the user:

> "Want to create a recurring task for this agent? For example, a research agent could run a daily briefing."

Options:
1. **No thanks** — Just the agent definition
2. **Yes, set up a recurring task** — I'll help you create a scheduled task

If yes, guide through task creation (prompt, schedule, model). Use the `schedule_task` IPC tool or direct DB insert.

### Step 7: Confirm

Tell the user:

> "Done! Created the `{name}` agent in `groups/{folder}/agents/{name}/`.
>
> The lead agent discovers agents automatically by scanning `/workspace/group/agents/` at runtime. No restart needed.
>
> Files created:
> - `groups/{folder}/agents/{name}/IDENTITY.md` — Agent personality
> - `groups/{folder}/agents/{name}/CLAUDE.md` — Agent instructions"

## Listing Existing Agents

If the user asks to list agents, scan:

```bash
for agent_dir in groups/*/agents/*/; do
  folder=$(echo "$agent_dir" | cut -d/ -f2)
  name=$(echo "$agent_dir" | cut -d/ -f4)
  role=$(head -1 "$agent_dir/IDENTITY.md" 2>/dev/null || echo "No identity")
  echo "$folder/$name: $role"
done
```

## Removing an Agent

If the user asks to remove an agent:

1. Delete the agent directory: `rm -rf groups/{folder}/agents/{name}`

That's it — the lead agent discovers agents by scanning the directory, so removal is immediate.

## Adding New Templates

To add a new pre-built agent template, create a directory under `.claude/skills/nanoclaw-add-agent/agents/`:

```
.claude/skills/nanoclaw-add-agent/agents/{name}/
  IDENTITY.md    ← First line should be a one-sentence summary
  CLAUDE.md      ← Instructions following the standard structure (Your Role, How to Work, Communication Rules)
```

The skill discovers templates dynamically — no SKILL.md edits needed. New templates appear as options the next time `/nanoclaw-add-agent` is run.

## Boundaries

This skill MUST NOT modify:
- `src/` — no TypeScript source changes
- `container/` — no container changes
- `plugins/` — no plugin changes
- Root `package.json` — no dependency changes

All changes are limited to files under `groups/`.
