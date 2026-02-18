---
name: add-skill-brave-search
description: Add Brave Search API access to NanoClaw agent containers. Enables web search for research, current events, and fact-checking. Guides through free API key setup. Triggers on "add brave search", "brave search", "web search setup", "add search".
---

# Add Brave Search

Configures Brave Search API access for agent containers, enabling web search for research, current events, and fact-checking.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- A Brave Search API key (free tier: 2,000 queries/month)

## Install

1. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-brave-search/files/ plugins/brave-search/
   ```
2. Get a free API key:
   - Go to https://brave.com/search/api/
   - Click "Get Started" and create an account
   - Subscribe to the **Free** plan (2,000 queries/month)
   - Copy your API key from the dashboard
3. Add to `.env`:
   ```bash
   echo 'BRAVE_API_KEY=YOUR_KEY_HERE' >> .env
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
curl -s "https://api.search.brave.com/res/v1/web/search?q=test&count=1" \
  -H "X-Subscription-Token: $BRAVE_API_KEY" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if 'web' in r and r['web'].get('results'):
    print(f\"OK - got {len(r['web']['results'])} result(s)\")
else:
    print(f\"FAILED - {r.get('message', r.get('type', 'unknown error'))}\")
"
```

## Remove

1. ```bash
   rm -rf plugins/brave-search/
   ```
2. Remove `BRAVE_API_KEY` from `.env`
3. Rebuild and restart
