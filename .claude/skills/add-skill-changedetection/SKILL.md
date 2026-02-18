---
name: add-skill-changedetection
description: Add changedetection.io integration to NanoClaw. Enables agents to create and manage website watches for price monitoring, stock alerts, and content changes. Guides through API key setup and webhook configuration. Triggers on "add changedetection", "changedetection setup", "price monitoring", "website monitoring".
---

# Add ChangeDetection.io

Configures changedetection.io API access for agent containers and sets up webhook notifications so changes trigger the agent automatically.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- A running changedetection.io instance (self-hosted)
- NanoClaw webhook server must be configured (`/add-skill-webhook`)

## Step 1: Check Existing Configuration

```bash
grep "^CHANGEDETECTION_URL=" .env 2>/dev/null && echo "URL_SET" || echo "NEED_URL"
grep "^CHANGEDETECTION_API_KEY=" .env 2>/dev/null && echo "KEY_SET" || echo "NEED_KEY"
grep "^NANOCLAW_WEBHOOK_SECRET=" .env 2>/dev/null && echo "WEBHOOK_SET" || echo "NEED_WEBHOOK"
ls plugins/changedetection/plugin.json 2>/dev/null && echo "PLUGIN_EXISTS" || echo "NO_PLUGIN"
```

If `NEED_WEBHOOK`, tell the user to run `/add-skill-webhook` first -- changedetection.io needs somewhere to send notifications.

If both URL and KEY are set, ask if they want to reconfigure.

## Step 2: Get Connection Details

Ask the user:
> Please provide your changedetection.io details:
> 1. **Instance URL** (e.g. `http://192.168.1.100:5000` or `https://cd.yourdomain.com`)
> 2. **API key** (found in Settings > API tab in the changedetection.io dashboard)

## Step 3: Save to .env

```bash
# Remove existing lines if present
sed -i '/^CHANGEDETECTION_URL=/d' .env
sed -i '/^CHANGEDETECTION_API_KEY=/d' .env

# Add the new values
echo 'CHANGEDETECTION_URL=THE_URL_HERE' >> .env
echo 'CHANGEDETECTION_API_KEY=THE_KEY_HERE' >> .env
```

## Step 4: Install Plugin

```bash
cp -r .claude/skills/add-skill-changedetection/files/ plugins/changedetection/
```

## Step 5: Test the Connection

```bash
source .env
curl -s "${CHANGEDETECTION_URL}/api/v1/watch" \
  -H "x-api-key: ${CHANGEDETECTION_API_KEY}" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, dict):
    print(f'OK - {len(r)} watch(es) found')
else:
    print(f'FAILED - unexpected response: {str(r)[:200]}')
"
```

If the test fails:
- **Connection refused**: Check the URL and that changedetection.io is running
- **401/403**: API key is wrong -- regenerate in Settings > API
- **Timeout**: Check network/firewall between NanoClaw and changedetection.io

## Step 6: Test Webhook Connectivity

Verify changedetection.io can reach NanoClaw's webhook endpoint:

```bash
source .env
SECRET=$(grep "^NANOCLAW_WEBHOOK_SECRET=" .env | cut -d= -f2)
curl -s -X POST http://localhost:3457/webhook \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"source": "changedetection-test", "text": "Test notification from changedetection.io setup"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('ok'):
    print('OK - webhook endpoint reachable')
else:
    print(f'FAILED - {r}')
"
```

## Step 7: Build and Restart

```bash
npm run build
systemctl restart nanoclaw  # or launchctl on macOS
```

## Verify

Ask the agent to:
- "Monitor this product page for price changes: [URL]"
- "Show me all active changedetection watches"

When a watched page changes, changedetection.io will webhook NanoClaw and the agent will notify you automatically.

## Remove

1. `rm -rf plugins/changedetection/`
2. Remove env vars from .env:
   ```bash
   sed -i '/^CHANGEDETECTION_URL=/d' .env
   sed -i '/^CHANGEDETECTION_API_KEY=/d' .env
   ```
3. Rebuild and restart
