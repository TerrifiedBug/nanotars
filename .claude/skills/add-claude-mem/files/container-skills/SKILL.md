---
name: claude-mem
description: Search the claude-mem persistent database for past context. Tool use is auto-captured — use this skill to search and recall. Standing rules and preferences go in MEMORY.md instead.
allowed-tools: Bash(curl:*)
---

# Persistent Memory

You have a persistent memory database that survives across sessions. Requires `$CLAUDE_MEM_URL` environment variable. If not configured, run `/add-claude-mem` on the host to set it up.

**Important:** Always use `project=nanoclaw-$NANOCLAW_GROUP_FOLDER` in all API calls (e.g., `nanoclaw-main`, `nanoclaw-family`). This keeps memories scoped per group.

## What's Captured Automatically

Every tool use (Bash, Read, WebSearch, MCP calls, etc.) is automatically saved to the database with the tool name, input, and output. You don't need to manually save tool results — they're already searchable.

## Where to Store What

| What | Where | Why |
|------|-------|-----|
| Standing rules ("always use metric") | **MEMORY.md** | Auto-loaded every session, always visible |
| Personal facts ("user likes flat whites") | **MEMORY.md** | Should be available without searching |
| Preferences and routines | **MEMORY.md** | Persistent across all conversations |
| Important conclusions from this conversation | **claude-mem save** | Searchable later, not needed every session |
| "Remember this for later" (user request) | **claude-mem save** | Explicit user request to persist a fact |
| Tool outputs and actions taken | **Auto-captured** | Already saved, no action needed |

### Manual Save

Use the save endpoint for important conclusions or facts the user shares that aren't from a tool call:

```bash
curl -s -X POST "$CLAUDE_MEM_URL/api/memory/save" \
  -H "Content-Type: application/json" \
  -d '{"text": "User prefers flat white coffee", "project": "nanoclaw-mem"}'
```

## When to Search Memory

- User asks about something discussed previously
- User references a person, project, or recurring topic
- User says "remember when...", "last time...", or "did I tell you..."
- You need context about past decisions or plans
- Before making assumptions about recurring topics
- Be proactive — search memory at the start of conversations about recurring topics

## Search Memory

```bash
curl -s "$CLAUDE_MEM_URL/api/search?query=morning+routine+preferences&project=nanoclaw-$NANOCLAW_GROUP_FOLDER" | jq -r '.content[0].text // .'
```

Search returns an index with observation IDs and titles. If you need full details for specific results, fetch them by ID.

## Get Full Details

```bash
curl -s -X POST "$CLAUDE_MEM_URL/api/observations/batch" \
  -H "Content-Type: application/json" \
  -d '{"ids": [42, 43]}' | jq '.[].narrative // .[].text'
```

## Get Timeline Context

See what happened around a specific observation:

```bash
curl -s "$CLAUDE_MEM_URL/api/timeline?anchor=42&project=nanoclaw-$NANOCLAW_GROUP_FOLDER"
```

## Tips

- Use broad search queries to find related memories (e.g., "coffee preferences" not just "flat white")
- Use timeline to understand the context around a specific observation
- **MEMORY.md** = things you need every session (rules, preferences, personal facts)
- **claude-mem save** = things you might need later (decisions, conclusions, user requests to remember)
- **Don't manually save** tool outputs — they're already auto-captured
