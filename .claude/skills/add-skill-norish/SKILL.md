---
name: add-skill-norish
description: Add Norish recipe import to NanoClaw agents. Send recipe URLs to your Norish instance for automatic import. Triggers on "add norish", "norish setup", "recipe import", "norish integration".
---

# Add Norish

Adds the ability to import recipes into your Norish instance by URL. When the agent sees a recipe link, it can POST it to Norish for automatic scraping and import.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- A running Norish instance with an API key

## Install

1. Check current state:
   ```bash
   [ -d plugins/norish ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Verify.

2. Add your Norish credentials to `.env`:
   ```bash
   echo "NORISH_URL=https://your-norish-instance.example.com" >> .env
   echo "NORISH_API_KEY=your-api-key-here" >> .env
   ```
   Ask the user for their Norish URL (no trailing slash) and API key.

3. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-norish/files/ plugins/norish/
   ```

4. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Read the credentials from `.env`:
```bash
NORISH_URL=$(grep "^NORISH_URL=" .env | cut -d= -f2)
NORISH_API_KEY=$(grep "^NORISH_API_KEY=" .env | cut -d= -f2)
```

Test the connection (should return 400 since no URL provided, but proves auth works):
```bash
curl -s -X POST "${NORISH_URL}/api/import/recipe" \
  -H "x-api-key: ${NORISH_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

If you get a 400 with a message about missing URL, the connection and auth are working.

If you get a 401, the API key is wrong.

## Usage Examples

Send the agent a message like:
- "Save this recipe: https://www.bbcgoodfood.com/recipes/classic-lasagne"
- "Import https://cooking.nytimes.com/recipes/1234-pasta"
- Just paste a recipe URL in the chat

The agent will POST the URL to Norish and confirm it was queued.

## How It Works

The agent uses curl to POST recipe URLs to your Norish instance's `/api/import/recipe` endpoint. Norish scrapes the page, extracts structured recipe data, and adds it to your collection. Authentication is via the `x-api-key` header.

## Troubleshooting

### 401 Unauthorized
The API key is wrong. Check `.env` has the correct `NORISH_API_KEY`.

### Connection refused
Check `NORISH_URL` in `.env` is correct and the Norish instance is running. Make sure the URL is reachable from the NanoClaw server.

### Agent not using the skill
Make sure the plugin was copied correctly:
```bash
ls plugins/norish/container-skills/SKILL.md
```

## Remove

1. `rm -rf plugins/norish/`
2. Remove env vars from `.env`:
   ```bash
   sed -i '/^NORISH_URL=/d' .env
   sed -i '/^NORISH_API_KEY=/d' .env
   ```
3. Rebuild and restart.
