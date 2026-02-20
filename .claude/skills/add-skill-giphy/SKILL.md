---
name: add-skill-giphy
description: Add GIF search and sending to NanoClaw agents via Giphy API. Enables humorous GIF reactions in conversations. Guides through free API key setup. Triggers on "add giphy", "gif search", "add gifs", "giphy setup".
---

# Add GIF Search (Giphy)

Configures Giphy API access for agent containers, enabling GIF search and sending for humorous reactions in conversations.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- A Giphy API key (free tier: 100 requests/hour)

## Install

1. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-giphy/files/ plugins/gif-search/
   ```
2. Get a free API key:
   - Go to https://developers.giphy.com/
   - Click "Create an App" and sign up / log in
   - Choose **API** (not SDK)
   - Copy your API key from the app dashboard
3. Add to `.env`:
   ```bash
   echo 'GIPHY_API_KEY=YOUR_KEY_HERE' >> .env
   ```
4. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Test the API key:
```bash
source .env
curl -s "https://api.giphy.com/v1/gifs/search?q=thumbs+up&limit=1&api_key=$GIPHY_API_KEY" | python3 -c "
import sys, json
r = json.load(sys.stdin)
d = r.get('data', [])
if d:
    print(f\"OK - got {len(d)} result(s): {d[0].get('title', 'untitled')}\")
else:
    print(f\"FAILED - {r.get('message', 'no results')}\")
"
```

## Remove

1. ```bash
   rm -rf plugins/gif-search/
   ```
2. Remove `GIPHY_API_KEY` from `.env`
3. Rebuild and restart
