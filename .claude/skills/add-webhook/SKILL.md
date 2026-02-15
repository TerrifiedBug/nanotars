---
name: add-webhook
description: Add a webhook HTTP endpoint so external services (Home Assistant, uptime monitors, Proxmox) can push events that trigger agent turns. Avoids token-wasting cron polling. Triggers on "webhook", "add webhook", "http endpoint", "push events", "webhook endpoint".
---

# Add Webhook Endpoint

This skill adds an HTTP webhook endpoint to NanoClaw as a plugin. External services POST events to it, which get injected into the main channel's message pipeline and processed by the agent -- no cron polling needed.

**Why:** Cron-scheduled tasks waste tokens polling for "nothing to report." Webhooks flip the model: external services push events only when something happens. A Home Assistant automation, uptime monitor, or CI pipeline fires a POST, and the agent processes it within 2 seconds.

**Architecture:** The webhook plugin uses `onStartup`/`onShutdown` hooks to run a lightweight Node.js `http` server alongside WhatsApp. Incoming webhooks are inserted into the message pipeline via `PluginContext.insertMessage`. The existing polling loop picks them up and routes them through the normal container pipeline. No new npm dependencies -- uses Node.js built-in `http` and `crypto`.

## Prerequisites

- NanoClaw must be set up and running (`/setup`)
- A main channel must be registered (via `/setup`)

## Step 1: Check Current State

```bash
grep "NANOCLAW_WEBHOOK_SECRET" .env 2>/dev/null && echo "SECRET_EXISTS" || echo "NEED_SECRET"
[ -d plugins/webhook ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
```

If both exist, skip to Step 4 (Test).

## Step 2: Add Environment Variable

Generate a secure random token and add it to `.env`:

```bash
# Generate a 32-byte random token
TOKEN=$(openssl rand -hex 32)
echo "NANOCLAW_WEBHOOK_SECRET=${TOKEN}" >> .env
echo "Generated NANOCLAW_WEBHOOK_SECRET: ${TOKEN}"
```

Optionally set a custom port (default is 3457):
```bash
echo "WEBHOOK_PORT=3457" >> .env
```

## Step 3: Create Plugin

Create the `plugins/webhook/` directory with `plugin.json` and `index.js`.

```bash
mkdir -p plugins/webhook
```

### 3a. Create `plugins/webhook/plugin.json`

```json
{
  "name": "webhook",
  "description": "HTTP webhook endpoint for external event ingestion (HA, uptime monitors, changedetection, etc.)",
  "containerEnvVars": ["NANOCLAW_WEBHOOK_URL", "NANOCLAW_WEBHOOK_SECRET"],
  "hooks": ["onStartup", "onShutdown"]
}
```

### 3b. Create `plugins/webhook/index.js`

This is the plugin's hook code. It starts an HTTP server on startup and stops it on shutdown. The server uses `ctx.insertMessage` and `ctx.getMainChannelJid` from the plugin context.

```javascript
import crypto from 'crypto';
import http from 'http';

const MAX_BODY_SIZE = 65536; // 64KB
let server;

export async function onStartup(ctx) {
  const secret = process.env.NANOCLAW_WEBHOOK_SECRET;
  if (!secret) {
    ctx.logger.debug('Webhook plugin: NANOCLAW_WEBHOOK_SECRET not set, skipping');
    return;
  }

  const port = parseInt(process.env.WEBHOOK_PORT || '3457', 10);

  server = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;

    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${secret}`) {
      ctx.logger.warn({ ip }, 'Webhook 401: auth rejected');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (res.writableEnded) return;

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const source = payload.source || 'webhook';
      const text = payload.text;

      if (!text || typeof text !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "text" field' }));
        return;
      }

      const mainJid = ctx.getMainChannelJid();
      if (!mainJid) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No main channel configured' }));
        return;
      }

      const messageId = `wh-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      ctx.insertMessage(mainJid, messageId, `webhook:${source}`, source, text);

      ctx.logger.info({ source, messageId, length: text.length }, 'Webhook message injected');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageId }));
    });
  });

  server.listen(port, () => {
    ctx.logger.info({ port }, 'Webhook server listening');
  });
}

export async function onShutdown() {
  if (server) {
    server.close();
    server = null;
  }
}
```

## Step 4: Build and Restart

```bash
npm run build
```

Restart the service:

```bash
# Linux
systemctl restart nanoclaw

# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Step 5: Test

Read the secret from `.env`:

```bash
SECRET=$(grep "^NANOCLAW_WEBHOOK_SECRET=" .env | cut -d= -f2)
```

### Test auth rejection (should return 401):

```bash
curl -s -X POST http://localhost:3457/webhook \
  -H "Content-Type: application/json" \
  -d '{"source": "test", "text": "hello"}' | jq .
```

### Test with wrong token (should return 401):

```bash
curl -s -X POST http://localhost:3457/webhook \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"source": "test", "text": "hello"}' | jq .
```

### Test successful injection (should return 200):

```bash
curl -s -X POST http://localhost:3457/webhook \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"source": "test", "text": "This is a test webhook message. Reply with OK if you received it."}' | jq .
```

### Verify in database:

```bash
sqlite3 store/messages.db "SELECT id, sender_name, content, timestamp FROM messages WHERE id LIKE 'wh-%' ORDER BY timestamp DESC LIMIT 5"
```

The agent should process the message within ~2 seconds and reply on WhatsApp.

## Usage Examples

### Home Assistant Automation

```yaml
automation:
  - alias: "Notify NanoClaw on motion"
    trigger:
      - platform: state
        entity_id: binary_sensor.front_door_motion
        to: "on"
    action:
      - service: rest_command.nanoclaw_webhook
        data:
          source: home-assistant
          text: "Motion detected on front door camera at {{ now().strftime('%H:%M') }}"

rest_command:
  nanoclaw_webhook:
    url: "http://NANOCLAW_IP:3457/webhook"
    method: POST
    headers:
      Authorization: "Bearer YOUR_NANOCLAW_WEBHOOK_SECRET"
      Content-Type: "application/json"
    payload: '{"source": "{{ source }}", "text": "{{ text }}"}'
```

### Uptime Kuma / Generic Monitor

```bash
curl -X POST http://NANOCLAW_IP:3457/webhook \
  -H "Authorization: Bearer YOUR_NANOCLAW_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"source": "uptime-kuma", "text": "ALERT: website.com is DOWN. Status: 503. Downtime: 2 minutes."}'
```

### Proxmox Backup Alert

```bash
curl -X POST http://NANOCLAW_IP:3457/webhook \
  -H "Authorization: Bearer YOUR_NANOCLAW_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"source": "proxmox", "text": "Backup completed for VM 100 (homelab). Size: 12GB. Duration: 8m 32s."}'
```

## How It Works

- The webhook plugin starts only if `NANOCLAW_WEBHOOK_SECRET` is set in `.env` (safe default = off)
- `POST /webhook` validates Bearer token, parses JSON body `{ source, text }`
- Generates a unique `wh-*` message ID and calls `ctx.insertMessage()`
- Message is inserted into the message pipeline
- The existing polling loop picks it up via `getNewMessages()`
- Agent sees it as `<message sender="home-assistant" time="...">Motion detected...</message>`
- Agent processes it in the main channel container and replies on WhatsApp
- No new npm dependencies -- uses Node.js built-in `http` and `crypto`

## Security

- **Auth:** Every request requires `Authorization: Bearer <NANOCLAW_WEBHOOK_SECRET>`
- **Isolation:** `NANOCLAW_WEBHOOK_SECRET` is passed to containers via the plugin's `containerEnvVars` so agents can configure external callbacks (n8n, etc.), but the webhook server itself runs on the host -- agents can't start or stop it
- **Payload limit:** 64KB max body size prevents memory exhaustion
- **SQL safety:** All inserts use parameterized queries
- **XSS safety:** Message content passes through `escapeXml()` in `formatMessages()`
- **Network:** Designed for VPN/mesh networks (Tailscale, Pangolin) -- not internet-facing
- **Default off:** Server doesn't start without `NANOCLAW_WEBHOOK_SECRET` configured

## Troubleshooting

### Server not starting

```bash
grep -i "webhook" logs/nanoclaw.log | tail -10
```

Check that `NANOCLAW_WEBHOOK_SECRET` is set:
```bash
grep "^NANOCLAW_WEBHOOK_SECRET=" .env
```

### Port already in use

Change the port:
```bash
# In .env
WEBHOOK_PORT=3458
```

### Messages not being processed

Verify the main channel is registered:
```bash
sqlite3 store/messages.db "SELECT jid, folder FROM registered_groups WHERE folder = 'main'"
```

Check that webhook messages are in the database:
```bash
sqlite3 store/messages.db "SELECT * FROM messages WHERE id LIKE 'wh-%' ORDER BY timestamp DESC LIMIT 5"
```

### Firewall

If calling from another machine, ensure the webhook port is open:
```bash
# Check if port is listening
ss -tlnp | grep 3457

# If using ufw
sudo ufw allow 3457/tcp
```

## Removal

1. Remove the plugin:
```bash
rm -rf plugins/webhook/
```

2. Remove env vars:
```bash
sed -i '/^NANOCLAW_WEBHOOK_SECRET=/d' .env
sed -i '/^WEBHOOK_PORT=/d' .env
```

3. Rebuild and restart NanoClaw.
