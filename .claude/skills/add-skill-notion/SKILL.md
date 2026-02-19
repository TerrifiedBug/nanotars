---
name: add-skill-notion
description: Add Notion API access to NanoClaw. Enables agents to read and update Notion pages and databases for project management, notes, and tracking. Guides through integration setup. Triggers on "add notion", "notion setup", "notion integration", "notion api".
---

# Add Notion

Configures Notion API access for agent containers, enabling reading and updating Notion pages and databases.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- A Notion account with pages you want the agent to access

## Install

1. Create a Notion internal integration:
   - Go to https://www.notion.so/my-integrations
   - Click **New integration**
   - Select the workspace to connect
   - Enable capabilities: Read content, Update content, Insert content
   - Click **Submit** and copy the **Internal Integration Secret** (starts with `ntn_`)
   - For each page the agent should access: open page > **...** > **Connections** > add your integration
2. Add to `.env`:
   ```bash
   echo 'NOTION_API_KEY=YOUR_KEY_HERE' >> .env
   ```
3. **Group Scoping** -- Ask the user which groups should have access to Notion:

   - **All groups** (default) -- every group's agent can read and update Notion pages
   - **Specific groups only** -- e.g., only `main`

   If the user wants to restrict access, update `plugins/notion/plugin.json` after copying (step 4) to set `"groups"` to the list of group folder names:

   ```json
   "groups": ["main"]
   ```

   If all groups (or the user doesn't care), leave as `"groups": ["*"]`.

   Restricting access means only those groups' agents will have Notion tools. Other groups won't see the Notion API or credentials.

4. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-notion/files/ plugins/notion/
   ```

5. Rebuild and restart:
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
