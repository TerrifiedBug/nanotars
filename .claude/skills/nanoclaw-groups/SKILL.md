---
name: nanoclaw-groups
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

View and manage NanoClaw group registrations. For adding new groups, use `/nanoclaw-add-group`.

## Step 1: Determine the operation

Ask the user:
- **List** — Show all registered groups
- **View** — Detailed config for one group
- **Update** — Change a group setting
- **Status** — Activity stats for all groups

## Step 2a: List groups

```bash
sqlite3 -header -column store/messages.db "
  SELECT folder, name, channel,
    CASE requires_trigger WHEN 1 THEN 'yes' ELSE 'no' END as trigger_req,
    trigger_pattern, added_at
  FROM registered_groups
  ORDER BY channel, folder;
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

Ask which group, then:

```bash
GROUP="{selected}"

sqlite3 -header -column store/messages.db "SELECT * FROM registered_groups WHERE folder = '${GROUP}';"

echo "Messages: $(sqlite3 store/messages.db "SELECT COUNT(*) FROM messages m JOIN registered_groups g ON m.chat_jid = g.jid WHERE g.folder = '${GROUP}';")"

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

Ask what to change:
- **trigger_pattern** — The @mention pattern
- **name** — Display name
- **requires_trigger** — Whether all messages or only @mentions trigger the bot

Confirm before applying:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET {field} = '{value}' WHERE folder = '{group}';"
echo "Updated. Restart NanoClaw for changes to take effect."
```

## Step 2d: Status

```bash
sqlite3 -header -column store/messages.db "
  SELECT g.folder, g.name, g.channel,
    COUNT(m.id) as messages,
    MAX(m.timestamp) as last_activity,
    (SELECT COUNT(*) FROM scheduled_tasks t WHERE t.group_folder = g.folder AND t.status = 'active') as tasks
  FROM registered_groups g
  LEFT JOIN messages m ON m.chat_jid = g.jid
  GROUP BY g.folder
  ORDER BY last_activity DESC;
"
```
