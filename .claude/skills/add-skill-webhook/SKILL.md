---
name: add-skill-webhook
description: Add a webhook HTTP endpoint so external services (Home Assistant, uptime monitors, Proxmox) can push events that trigger agent turns. Avoids token-wasting cron polling. Triggers on "webhook", "add webhook", "http endpoint", "push events", "webhook endpoint".
---

# Add Webhook Endpoint

HTTP webhook endpoint for NanoClaw. External services POST events to per-group endpoints, which get injected into the message pipeline — no cron polling needed.

Each group gets its own URL path (`/webhook/<group-folder>`) and unique secret token for isolation.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- At least one channel group must be registered (via `/nanoclaw-add-group`)

## Install / Add Route

### 1. Check current state

```bash
[ -d plugins/webhook ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
[ -f data/webhook-routes.json ] && echo "ROUTES_EXIST" || echo "NEED_ROUTES"
```

If `NEED_PLUGIN`: copy plugin files first:
```bash
cp -r .claude/skills/add-skill-webhook/files/ plugins/webhook/
```

### 2. Show existing routes (if any)

If `data/webhook-routes.json` exists, read and display current routes:
```bash
cat data/webhook-routes.json
```
Show the user which groups already have webhook endpoints (group name + creation date). **Never display full tokens** — show only the first 8 characters.

### 3. Ask the user what to do

**If no routes exist (first run):** skip to step 4.

**If routes exist (re-run),** ask:
- **Add a new group endpoint** — proceed to step 4
- **Regenerate token for an existing group** — proceed to step 6

### 4. Choose target group

Query the database for registered groups and show the user the list. Ask which group should receive webhook events.

```bash
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups"
```

### 5. Generate route and save

```bash
# Generate unique token
TOKEN="whk_$(openssl rand -hex 32)"

# Read existing routes or create new file
if [ -f data/webhook-routes.json ]; then
  # Add new route using jq
  jq --arg folder "GROUP_FOLDER" --arg secret "$TOKEN" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.routes[$folder] = {secret: $secret, createdAt: $date}' data/webhook-routes.json > data/webhook-routes.tmp \
    && mv data/webhook-routes.tmp data/webhook-routes.json
else
  # Create new routes file
  cat > data/webhook-routes.json << EOF
{
  "routes": {
    "GROUP_FOLDER": {
      "secret": "$TOKEN",
      "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    }
  }
}
EOF
fi
```

Replace `GROUP_FOLDER` with the actual group folder name (e.g., `main`, `family-chat`).

### 5a. Network config (first run only)

If `WEBHOOK_PORT` and `WEBHOOK_HOST` are not already in `.env`:

Ask the user which network interface to bind on:

- **Localhost only (recommended)** — `WEBHOOK_HOST=127.0.0.1`. Only services on this machine can reach the webhook. Use this if external services connect via a VPN/tunnel (WireGuard, Tailscale) that terminates locally, or if you use a reverse proxy (nginx, Caddy).
- **All interfaces** — `WEBHOOK_HOST=0.0.0.0`. Services on the LAN can reach the webhook directly. Convenient for Home Assistant, n8n, etc. on the same network.

If the user chooses **all interfaces**, warn them:
> **Security note:** Binding to all interfaces exposes the webhook to your entire network. The endpoint is protected by Bearer token auth, but the token is sent in cleartext over HTTP. Recommendations:
> - **Do not expose the port to the internet** — use a firewall rule to restrict access to your LAN/VPN only
> - For remote access, use a VPN (WireGuard, Tailscale, Pangolin) rather than port-forwarding
> - If you must expose it publicly, put it behind a reverse proxy with TLS (nginx, Caddy)

Save the choice:
```bash
echo "WEBHOOK_PORT=3457" >> .env
echo "WEBHOOK_HOST=127.0.0.1" >> .env   # or 0.0.0.0
```

### 5b. Show the user their webhook details

```
Webhook endpoint created:

  URL:    http://HOST:PORT/webhook/GROUP_FOLDER
  Token:  whk_...full token here...

  Test:
  curl -s -X POST http://HOST:PORT/webhook/GROUP_FOLDER \
    -H "Authorization: Bearer whk_..." \
    -H "Content-Type: application/json" \
    -d '{"source": "test", "text": "Hello from webhook test!"}' | jq .
```

For the main group, also mention: `POST /webhook` (no path suffix) routes to main as a shorthand.

### 5c. Restart

```bash
npm run build && systemctl restart nanoclaw  # or launchctl on macOS
```

The routes file is also hot-reloaded — after the first restart, adding new routes takes effect without restarting.

### 6. Regenerate token (re-run)

If the user wants to regenerate a token for an existing group:

1. **Warn:** "This will invalidate the current token. Any external services using the old token will stop working and need to be updated. Continue?"
2. If confirmed:
   ```bash
   TOKEN="whk_$(openssl rand -hex 32)"
   jq --arg folder "GROUP_FOLDER" --arg secret "$TOKEN" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.routes[$folder].secret = $secret | .routes[$folder].createdAt = $date' data/webhook-routes.json > data/webhook-routes.tmp \
     && mv data/webhook-routes.tmp data/webhook-routes.json
   ```
3. Show the new token.
4. The routes file is hot-reloaded — no restart needed.

## Migration from NANOCLAW_WEBHOOK_SECRET

If `.env` contains `NANOCLAW_WEBHOOK_SECRET` but no `data/webhook-routes.json` exists:

1. Read the existing secret:
   ```bash
   SECRET=$(grep "^NANOCLAW_WEBHOOK_SECRET=" .env | cut -d= -f2)
   ```
2. Create routes file with it as the main route:
   ```bash
   cat > data/webhook-routes.json << EOF
   {
     "routes": {
       "main": {
         "secret": "$SECRET",
         "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
       }
     }
   }
   EOF
   ```
3. Tell the user: "Migrated your existing webhook secret to the new per-group routes system. Your existing callers will continue working. You can remove `NANOCLAW_WEBHOOK_SECRET` from `.env`."

## Verify

Read the token for the target group:
```bash
TOKEN=$(jq -r '.routes["GROUP_FOLDER"].secret' data/webhook-routes.json)
```

### Test auth rejection (should return 401):
```bash
curl -s -X POST http://localhost:3457/webhook/GROUP_FOLDER \
  -H "Content-Type: application/json" \
  -d '{"source": "test", "text": "hello"}' | jq .
```

### Test wrong token (should return 401):
```bash
curl -s -X POST http://localhost:3457/webhook/GROUP_FOLDER \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"source": "test", "text": "hello"}' | jq .
```

### Test successful injection (should return 200):
```bash
curl -s -X POST http://localhost:3457/webhook/GROUP_FOLDER \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"source": "test", "text": "This is a test webhook message. Reply with OK if you received it."}' | jq .
```

### Verify in database:
```bash
sqlite3 store/messages.db "SELECT id, sender_name, content, timestamp FROM messages WHERE id LIKE 'wh-%' ORDER BY timestamp DESC LIMIT 5"
```

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
    url: "http://NANOCLAW_IP:3457/webhook/main"
    method: POST
    headers:
      Authorization: "Bearer YOUR_WEBHOOK_TOKEN"
      Content-Type: "application/json"
    payload: '{"source": "{{ source }}", "text": "{{ text }}"}'
```

### Uptime Kuma / Generic Monitor
```bash
curl -X POST http://NANOCLAW_IP:3457/webhook/admin \
  -H "Authorization: Bearer YOUR_ADMIN_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "uptime-kuma", "text": "ALERT: website.com is DOWN. Status: 503."}'
```

## How It Works

- Routes are stored in `data/webhook-routes.json` — each group gets a unique path and token
- Server starts only if routes file exists with at least one route (safe default = off)
- `POST /webhook/<group-folder>` validates the per-group Bearer token, parses JSON body `{ source, text }`
- `POST /webhook` (no suffix) routes to the `main` group as a shorthand
- Message is inserted into the group's pipeline via `ctx.insertMessage()`
- Routes file is watched for changes — adding new routes takes effect without restart
- No new npm dependencies — uses Node.js built-in `http`, `crypto`, `fs`

## Security

- **Per-group auth:** Each group has its own unique Bearer token — compromising one doesn't affect others
- **Path isolation:** Groups only receive webhooks on their own path
- **Payload limit:** 64KB max body size prevents memory exhaustion
- **Network:** Defaults to localhost only (`127.0.0.1`). Can be opened to LAN via `WEBHOOK_HOST=0.0.0.0`
- **Default off:** Server doesn't start without routes configured
- **Not internet-safe:** Tokens are sent in cleartext over HTTP. For remote access, use a VPN or reverse proxy with TLS

## Remove

### Remove a single group's webhook:
```bash
jq 'del(.routes["GROUP_FOLDER"])' data/webhook-routes.json > data/webhook-routes.tmp \
  && mv data/webhook-routes.tmp data/webhook-routes.json
```

### Remove webhook plugin entirely:
1. `rm -rf plugins/webhook/`
2. `rm -f data/webhook-routes.json`
3. Remove env vars from `.env`:
   ```bash
   sed -i '/^NANOCLAW_WEBHOOK_SECRET=/d' .env
   sed -i '/^WEBHOOK_PORT=/d' .env
   sed -i '/^WEBHOOK_HOST=/d' .env
   sed -i '/^NANOCLAW_WEBHOOK_URL=/d' .env
   ```
4. Rebuild and restart.
