---
name: nanotars-add-agent
description: >
  Add a persistent agent definition to a group. Creates agent.json, IDENTITY.md, and CLAUDE.md
  files for a specialized subagent auto-discovered by the SDK via Agent Teams.
  Triggers on "add agent", "create agent", "new agent", "agent team", "add subagent".
---

# Add Agent to Group

This skill creates persistent agent definitions for NanoClaw groups. Each agent gets a configuration file (`agent.json`) plus identity and instructions that the agent-runner auto-discovers and registers as SDK `subagent_type` options via Agent Teams.

Agent definitions are just files — no core code changes, no database changes.

## Architecture

```
groups/{folder}/
  agents/
    {name}/
      agent.json     ← REQUIRED: description, model, maxTurns (discovery marker)
      IDENTITY.md    ← "You are a research specialist..."
      CLAUDE.md      ← capabilities, rules, tools to focus on
```

The agent-runner auto-discovers agents by scanning for `agent.json` files and registers them as SDK subagent types. The lead agent sees them as `subagent_type` options on the Task tool.

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
ls -d groups/{folder}/agents/*/agent.json 2>/dev/null

# Available pre-built templates (not yet installed)
ls -d .claude/skills/nanotars-add-agent/agents/*/agent.json 2>/dev/null
```

For each entry found, read the description from its `agent.json`.

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
cp -r .claude/skills/nanotars-add-agent/agents/{name}/ groups/{folder}/agents/{name}/
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

Based on the capabilities NOT selected, build a `disallowedTools` list:
- Missing "Code & development" → add `Write`, `Edit`, `Bash`
- Missing "File management" → add `Write`, `Edit`
- Missing "Web search & research" → add `WebSearch`, `WebFetch`
- "All capabilities" selected → no restrictions (omit `disallowedTools`)
- Always disallow `NotebookEdit` unless "Code & development" is selected

Then ask:

> "What model should this agent use?"
>
> Options:
> 1. **haiku** — Fast and cheap, good for research and simple tasks (Recommended)
> 2. **sonnet** — Balanced, good for coding and complex reasoning
> 3. **opus** — Most capable, good for difficult tasks
> 4. **inherit** — Use the same model as the lead agent

### Step 5: Generate Agent Files

#### If using a pre-built template

The files were already copied in Step 2. Verify they're in place:

```bash
ls groups/{folder}/agents/{name}/agent.json groups/{folder}/agents/{name}/IDENTITY.md groups/{folder}/agents/{name}/CLAUDE.md
```

If the user renamed the agent, update the `sender` value in CLAUDE.md to match the new name.

#### If creating a custom agent

Create the agent directory and files:

```bash
mkdir -p groups/{folder}/agents/{name}
```

**agent.json** — Write based on the description from Step 4, model choice, and disallowed tools:
```json
{
  "description": "<one-line action-oriented description from Step 4>",
  "model": "<model choice from Step 4>",
  "maxTurns": 30,
  "disallowedTools": ["<tools not needed based on capabilities from Step 4>"]
}
```
Omit `disallowedTools` entirely if "All capabilities" was selected.

**IDENTITY.md** — Write based on the role description from Step 4. Keep it concise — 3-5 sentences that define who this agent is.

**CLAUDE.md** — Write based on capabilities from Step 4. Follow the same structure as the pre-built templates in `.claude/skills/nanotars-add-agent/agents/` — include "Your Role", "How to Work", and "Communication Rules" sections. The communication rules are critical for Agent Teams to work properly (sender parameter, message formatting, internal tags).

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
> The agent-runner discovers agents automatically by scanning for `agent.json` files at container startup. No restart needed.
>
> Files created:
> - `groups/{folder}/agents/{name}/agent.json` — Agent configuration
> - `groups/{folder}/agents/{name}/IDENTITY.md` — Agent personality
> - `groups/{folder}/agents/{name}/CLAUDE.md` — Agent instructions"

## Listing Existing Agents

If the user asks to list agents, scan:

```bash
for agent_dir in groups/*/agents/*/; do
  folder=$(echo "$agent_dir" | cut -d/ -f2)
  name=$(echo "$agent_dir" | cut -d/ -f4)
  if [ -f "${agent_dir}agent.json" ]; then
    desc=$(python3 -c "import json; print(json.load(open('${agent_dir}agent.json'))['description'])" 2>/dev/null || echo "No description")
    echo "$folder/$name: $desc"
  fi
done
```

## Removing an Agent

If the user asks to remove an agent:

1. Delete the agent directory: `rm -rf groups/{folder}/agents/{name}`

That's it — the lead agent discovers agents by scanning the directory, so removal is immediate.

## Adding New Templates

To add a new pre-built agent template, create a directory under `.claude/skills/nanotars-add-agent/agents/`:

```
.claude/skills/nanotars-add-agent/agents/{name}/
  agent.json     ← REQUIRED: description, model, maxTurns
  IDENTITY.md    ← First line should be a one-sentence summary
  CLAUDE.md      ← Instructions following the standard structure (Your Role, How to Work, Communication Rules)
```

The skill discovers templates dynamically — no SKILL.md edits needed. New templates appear as options the next time `/nanotars-add-agent` is run.

## Boundaries

This skill MUST NOT modify:
- `src/` — no TypeScript source changes
- `container/` — no container changes
- `plugins/` — no plugin changes
- Root `package.json` — no dependency changes

All changes are limited to files under `groups/`.
