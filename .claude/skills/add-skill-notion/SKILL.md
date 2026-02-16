---
name: add-skill-notion
description: Add Notion API access to NanoClaw. Enables agents to read and update Notion pages and databases for project management, notes, and tracking. Guides through integration setup. Triggers on "add notion", "notion setup", "notion integration", "notion api".
---

# Add Notion

Configures Notion API access for agent containers, enabling reading and updating Notion pages and databases.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- A Notion account with pages you want the agent to access

## Install

1. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-notion/files/ plugins/notion/
   ```
2. Create a Notion internal integration:
   - Go to https://www.notion.so/my-integrations
   - Click **New integration**
   - Select the workspace to connect
   - Enable capabilities: Read content, Update content, Insert content
   - Click **Submit** and copy the **Internal Integration Secret** (starts with `ntn_`)
   - For each page the agent should access: open page > **...** > **Connections** > add your integration
3. Add to `.env`:
   ```bash
   echo 'NOTION_API_KEY=YOUR_KEY_HERE' >> .env
   ```
4. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Test the token:
```bash
source .env
curl -s "https://api.notion.com/v1/users/me" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if 'id' in r:
    print(f'OK - {r.get(\"name\", \"connected\")}')
else:
    print(f'FAILED - {r}')
"
```

## Remove

1. ```bash
   rm -rf plugins/notion/
   ```
2. Remove `NOTION_API_KEY` from `.env`
3. Rebuild and restart
