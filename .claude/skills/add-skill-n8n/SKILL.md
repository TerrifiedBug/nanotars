---
name: add-n8n
description: Add n8n workflow automation integration to NanoClaw. Enables agents to create monitoring workflows that trigger webhooks instead of burning tokens on frequent polling. Guides through MCP server setup and configures environment. Triggers on "add n8n", "n8n setup", "n8n integration", "workflow automation".
---

# Add n8n Workflow Automation

Connects NanoClaw to an n8n instance so agents can create and manage automated workflows. Instead of burning agent tokens on frequent scheduled tasks that poll for changes, n8n does the polling (free) and only triggers the agent via webhook when something actually happens.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- An n8n instance with MCP server enabled (Settings > MCP Server)
- **Optional:** The webhook plugin (`/add-skill-webhook`) -- only needed if you want n8n workflows to trigger agent turns

## Step 1: Check Existing Configuration

```bash
grep "^N8N_URL=" .env 2>/dev/null && echo "N8N_CONFIGURED" || echo "N8N_NEEDS_SETUP"
[ -d plugins/n8n ] && echo "PLUGIN_EXISTS" || echo "PLUGIN_MISSING"
grep "^NANOCLAW_WEBHOOK_SECRET=" .env 2>/dev/null && echo "WEBHOOK_AVAILABLE" || echo "NO_WEBHOOK"
grep "^NANOCLAW_WEBHOOK_URL=" .env 2>/dev/null && echo "WEBHOOK_URL_CONFIGURED" || echo "WEBHOOK_URL_NEEDS_SETUP"
```

If `N8N_CONFIGURED`, ask the user if they want to reconfigure.

If `NO_WEBHOOK`, inform the user:
> The webhook plugin isn't configured yet. n8n will work for workflow management, but if you want n8n workflows to trigger agent turns (e.g., alert you when something happens), run `/add-skill-webhook` first, then re-run `/add-n8n` to configure the callback URL.

## Step 2: Gather n8n Details

Ask the user for:

1. **n8n URL** -- the base URL of their n8n instance (e.g. `https://n8n.example.com` or `http://192.168.1.x:5678`)
2. **n8n API Key** -- generate one in n8n: Settings > API > Create API Key

Tell the user:
> To create an n8n API key:
> 1. Open your n8n instance
> 2. Go to **Settings** (bottom-left gear icon)
> 3. Click **API** in the left sidebar
> 4. Click **Create API Key**
> 5. Copy the key and paste it here

## Step 3: Configure Webhook URL (optional)

**Skip this step if the webhook plugin isn't set up or the user doesn't need n8n->NanoClaw callbacks yet.**

If `NANOCLAW_WEBHOOK_SECRET` exists in `.env`, offer to configure the callback URL so n8n workflows can trigger agent turns.

Determine the webhook URL that n8n can reach:
- If n8n and NanoClaw are on the same machine: `http://localhost:3457/webhook` or `http://HOST_IP:3457/webhook`
- If on different machines: use the NanoClaw host's LAN IP or DNS name

```bash
# Get the current webhook port
grep "^WEBHOOK_PORT=" .env 2>/dev/null || echo "WEBHOOK_PORT=3457 (default)"
grep "^NANOCLAW_WEBHOOK_SECRET=" .env 2>/dev/null && echo "SECRET_EXISTS" || echo "NO_SECRET"
```

Ask the user: "What URL can your n8n instance use to reach NanoClaw's webhook?" and suggest the likely value based on the network setup.

## Step 4: Save to .env

```bash
# Remove existing lines if present
sed -i '/^N8N_URL=/d' .env
sed -i '/^N8N_API_KEY=/d' .env

# Add n8n credentials
echo 'N8N_URL=THE_N8N_URL_HERE' >> .env
echo 'N8N_API_KEY=THE_API_KEY_HERE' >> .env
```

**If webhook is configured (Step 3 was not skipped):**

```bash
sed -i '/^NANOCLAW_WEBHOOK_URL=/d' .env

echo 'NANOCLAW_WEBHOOK_URL=THE_WEBHOOK_URL_HERE' >> .env
```

## Step 5: Install Plugin

```bash
cp -r .claude/skills/add-skill-n8n/files/ plugins/n8n/
```

## Step 6: Test n8n API Connection

```bash
source .env
curl -s "$N8N_URL/api/v1/workflows?limit=1" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if 'data' in r:
    count = len(r.get('data', []))
    print(f'OK - n8n API accessible ({r.get(\"count\", count)} workflows)')
else:
    print(f'FAILED - {r.get(\"message\", json.dumps(r)[:200])}')
"
```

If the test fails:
- **401/403**: API key is wrong or not activated
- **Connection refused**: Check n8n URL and that the instance is running
- **Timeout**: Network/firewall issue between NanoClaw host and n8n

## Step 7: Test Webhook Reachability from n8n's Perspective

**Skip if webhook was not configured in Step 3.**

```bash
source .env
curl -s -X POST "$NANOCLAW_WEBHOOK_URL" \
  -H "Authorization: Bearer $NANOCLAW_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"source": "n8n-test", "text": "n8n integration test -- if you see this, the webhook is working"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
print('OK' if r.get('ok') else f'FAILED - {json.dumps(r)}')
"
```

## Step 8: Build and Restart

```bash
npm run build
systemctl restart nanoclaw  # or launchctl on macOS
```

## Verify

Send a WhatsApp message like "create an n8n workflow that checks my email every 5 minutes and alerts me if I get anything from my boss".

## Remove

1. `rm -rf plugins/n8n/`
2. Remove env vars from .env:
   ```bash
   sed -i '/^N8N_URL=/d' .env
   sed -i '/^N8N_API_KEY=/d' .env
   sed -i '/^NANOCLAW_WEBHOOK_URL=/d' .env
   ```
3. Rebuild and restart
