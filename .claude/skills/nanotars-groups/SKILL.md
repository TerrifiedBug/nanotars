---
name: nanotars-groups
description: List, view, and manage NanoClaw group configurations
triggers:
  - list groups
  - show groups
  - manage groups
  - group config
  - group settings
  - edit group
  - update group
---

# Group Config Management

View and manage NanoClaw group registrations. For adding new groups, use `/nanotars-add-group`.

The entity model splits the old `registered_groups` table into three (migration 009): `agent_groups` (per-folder agent identity), `messaging_groups` (one chat on one platform), and `messaging_group_agents` (the many-to-many wiring with engage rules).

## Step 1: Determine the operation

Ask the user:
- **List** — Show all wired (agent_group, messaging_group) pairs
- **View** — Detailed config for one folder
- **Update** — Change a wiring or agent-group setting
- **Status** — Activity stats per folder

## Step 2a: List groups

```bash
sqlite3 -header -column store/messages.db "
  SELECT
    ag.folder,
    ag.name AS agent_name,
    COALESCE(mg.channel_type, '(unwired)') AS channel,
    COALESCE(mg.platform_id, '') AS platform_id,
    COALESCE(mga.engage_mode, '') AS engage_mode,
    COALESCE(mga.engage_pattern, '') AS engage_pattern,
    ag.created_at
  FROM agent_groups ag
  LEFT JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
  LEFT JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
  ORDER BY COALESCE(mg.channel_type, 'zz-unwired'), ag.folder;
"
```

Show disk usage per group:

```bash
for dir in groups/*/; do
  folder=$(basename "$dir")
  size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  echo "  $folder: $size"
done
```

## Step 2b: View group details

Ask which folder, then:

```bash
GROUP="{selected}"

# Agent group + every wiring + every wired messaging_group:
sqlite3 -header -column store/messages.db "
  SELECT ag.folder, ag.name, ag.agent_provider, ag.created_at,
         mg.channel_type, mg.platform_id, mg.name AS chat_name,
         mga.engage_mode, mga.engage_pattern, mga.sender_scope, mga.ignored_message_policy, mga.session_mode, mga.priority
  FROM agent_groups ag
  LEFT JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
  LEFT JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
  WHERE ag.folder = '${GROUP}';
"

# Message count joined via platform_id (chat_jid) → messaging_groups → wiring → agent_group:
echo "Messages: $(sqlite3 store/messages.db "
  SELECT COUNT(*)
  FROM messages m
  JOIN messaging_groups mg ON mg.platform_id = m.chat_jid
  JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
  JOIN agent_groups ag ON ag.id = mga.agent_group_id
  WHERE ag.folder = '${GROUP}';
")"

sqlite3 -header -column store/messages.db "
  SELECT id, substr(prompt,1,40) as prompt, schedule_type, status, next_run
  FROM scheduled_tasks WHERE group_folder = '${GROUP}';
"

echo "Files:"
ls -la "groups/${GROUP}/" 2>/dev/null

if [ -f "groups/${GROUP}/CLAUDE.md" ]; then
  echo "--- CLAUDE.md (first 10 lines) ---"
  head -10 "groups/${GROUP}/CLAUDE.md"
fi

if [ -d "groups/${GROUP}/agents" ]; then
  echo "Agents: $(ls "groups/${GROUP}/agents/" 2>/dev/null)"
fi
```

## Step 2c: Update group

Ask which field to change. The entity model splits old `registered_groups` columns across two tables — pick the right target:

- **engage_pattern** (was `trigger_pattern`) — the regex/string the @mention check uses. Lives on `messaging_group_agents`.
- **engage_mode** (was `requires_trigger`) — `'always'` (every message wakes the agent) or `'pattern'` (only when `engage_pattern` matches). Other values may exist; `sqlite3 store/messages.db "SELECT DISTINCT engage_mode FROM messaging_group_agents"` to inspect.
- **agent name** — the agent group's display name. Lives on `agent_groups`.
- **chat name** — the messaging group's name (per-chat). Lives on `messaging_groups`.

Confirm before applying:

```bash
GROUP="{folder}"

# engage_pattern (per-wiring):
sqlite3 store/messages.db "
  UPDATE messaging_group_agents
  SET engage_pattern = '{value}'
  WHERE agent_group_id = (SELECT id FROM agent_groups WHERE folder = '${GROUP}');
"

# engage_mode (per-wiring) — replaces requires_trigger:
sqlite3 store/messages.db "
  UPDATE messaging_group_agents
  SET engage_mode = '{value}'
  WHERE agent_group_id = (SELECT id FROM agent_groups WHERE folder = '${GROUP}');
"

# agent name:
sqlite3 store/messages.db "
  UPDATE agent_groups SET name = '{value}' WHERE folder = '${GROUP}';
"

# chat name (each wired chat individually — pick by platform_id):
sqlite3 store/messages.db "
  UPDATE messaging_groups SET name = '{value}' WHERE platform_id = '{platform_id}';
"

echo "Updated. Restart NanoClaw for changes to take effect."
```

## Step 2d: Status

```bash
sqlite3 -header -column store/messages.db "
  SELECT
    ag.folder,
    ag.name AS agent_name,
    COALESCE(mg.channel_type, '(unwired)') AS channel,
    COUNT(DISTINCT m.id) AS messages,
    MAX(m.timestamp) AS last_activity,
    (SELECT COUNT(*) FROM scheduled_tasks t
       WHERE t.group_folder = ag.folder AND t.status = 'active') AS tasks
  FROM agent_groups ag
  LEFT JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
  LEFT JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
  LEFT JOIN messages m ON m.chat_jid = mg.platform_id
  GROUP BY ag.folder
  ORDER BY last_activity DESC;
"
```
