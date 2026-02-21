---
name: add-channel-whatsapp
description: >
  Add WhatsApp as a channel. Install the WhatsApp channel plugin and authenticate.
  Use when WhatsApp is not already installed as a core plugin.
  Triggers on "add whatsapp", "whatsapp setup", "whatsapp channel".
---

# Add WhatsApp Channel

Adds WhatsApp as a messaging channel to NanoClaw using the Baileys library.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- A phone number with WhatsApp installed (for QR code authentication)

## Install

1. Check current state:
   ```bash
   [ -d plugins/channels/whatsapp ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Auth.

2. Copy channel plugin files into place:
   ```bash
   mkdir -p plugins/channels/whatsapp
   cp -r .claude/skills/add-channel-whatsapp/files/* plugins/channels/whatsapp/
   ```

3. The plugin has `"dependencies": true` in its manifest, so the plugin-loader will run `npm install` automatically on first startup. To install dependencies now:
   ```bash
   cd plugins/channels/whatsapp && npm install && cd -
   ```

4. Rebuild and restart:
   ```bash
   npm run build
   ```

   Then restart the service:
   ```bash
   systemctl restart nanoclaw 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || echo "Restart the NanoClaw service manually"
   ```

## Auth

### Check Existing Auth

```bash
[ -f data/channels/whatsapp/auth/creds.json ] && echo "AUTHENTICATED" || echo "NEEDS_AUTH"
```

If `AUTHENTICATED`, tell the user:

> WhatsApp is already authenticated. Want to re-authenticate? (This will disconnect the current session.)

If they say no, skip to "Register a Chat" below.

### Authenticate

**USER ACTION REQUIRED**

The auth script supports two methods: QR code scanning and pairing code (phone number). Ask the user which they prefer.

The auth script writes status to `data/channels/whatsapp/auth-status.txt`:
- `already_authenticated` — credentials already exist
- `pairing_code:<CODE>` — pairing code generated, waiting for user to enter it
- `authenticated` — successfully authenticated
- `failed:<reason>` — authentication failed

The script automatically handles error 515 (stream error after pairing) by reconnecting — this is normal and expected during pairing code auth.

### Ask the user which method to use

> How would you like to authenticate WhatsApp?
>
> 1. **QR code in browser** (Recommended) — Opens a page with the QR code to scan
> 2. **Pairing code** — Enter a numeric code on your phone, no camera needed
> 3. **QR code in terminal** — Run the auth command yourself in another terminal

### Option A: QR Code in Browser (Recommended)

Detect if headless or has a display:

```bash
[ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ] || echo "HEADLESS"
```

Clean any stale auth state and start auth in background:

**Headless (server/VPS)** — use `--serve` to start an HTTP server:
```bash
rm -rf data/channels/whatsapp/auth data/channels/whatsapp/qr-data.txt data/channels/whatsapp/auth-status.txt
node plugins/channels/whatsapp/auth.js --serve
```

**macOS/desktop** — use the file-based approach:
```bash
rm -rf data/channels/whatsapp/auth data/channels/whatsapp/qr-data.txt data/channels/whatsapp/auth-status.txt
node plugins/channels/whatsapp/auth.js
```

Run this with `run_in_background: true`.

Poll for QR data (up to 15 seconds):

```bash
for i in $(seq 1 15); do if [ -f data/channels/whatsapp/qr-data.txt ]; then echo "qr_ready"; exit 0; fi; STATUS=$(cat data/channels/whatsapp/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; fi; sleep 1; done; echo "timeout"
```

If `already_authenticated`, skip to the next step.

**Headless:** Tell the user to open `http://SERVER_IP:8899` in their browser to see and scan the QR code.

**macOS/desktop:** Generate the QR as SVG and inject it into the HTML template, then open it:

```bash
node -e "
const QR = require('qrcode');
const fs = require('fs');
const qrData = fs.readFileSync('data/channels/whatsapp/qr-data.txt', 'utf8');
QR.toString(qrData, { type: 'svg' }, (err, svg) => {
  if (err) process.exit(1);
  const template = fs.readFileSync('.claude/skills/nanoclaw-setup/qr-auth.html', 'utf8');
  fs.writeFileSync('data/channels/whatsapp/qr-auth.html', template.replace('{{QR_SVG}}', svg));
  console.log('done');
});
"
open data/channels/whatsapp/qr-auth.html
```

Tell the user:
> The QR code is ready. It expires in about 60 seconds.
>
> Scan it with WhatsApp: **Settings > Linked Devices > Link a Device**

Then poll for completion (up to 120 seconds):

```bash
for i in $(seq 1 60); do STATUS=$(cat data/channels/whatsapp/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 2; done; echo "timeout"
```

- If `authenticated`, success — clean up with `rm -f data/channels/whatsapp/qr-auth.html` and continue.
- If `failed:qr_timeout`, offer to retry (re-run the auth and regenerate the HTML page).
- If `failed:logged_out`, delete `data/channels/whatsapp/auth/` and retry.

### Option B: Pairing Code

Ask the user for their phone number (with country code, no + or spaces, e.g. `14155551234`).

Clean any stale auth state and start:

```bash
rm -rf data/channels/whatsapp/auth data/channels/whatsapp/qr-data.txt data/channels/whatsapp/auth-status.txt
node plugins/channels/whatsapp/auth.js --pairing-code --phone PHONE_NUMBER
```

Run this with `run_in_background: true`.

Poll for the pairing code (up to 15 seconds):

```bash
for i in $(seq 1 15); do STATUS=$(cat data/channels/whatsapp/auth-status.txt 2>/dev/null || echo "waiting"); if echo "$STATUS" | grep -q "^pairing_code:"; then echo "$STATUS"; exit 0; elif [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 1; done; echo "timeout"
```

Extract the code from the status (e.g. `pairing_code:ABC12DEF` -> `ABC12DEF`) and tell the user:

> Your pairing code: **CODE_HERE**
>
> 1. Open WhatsApp on your phone
> 2. Tap **Settings > Linked Devices > Link a Device**
> 3. Tap **"Link with phone number instead"**
> 4. Enter the code: **CODE_HERE**

Then poll for completion (up to 120 seconds):

```bash
for i in $(seq 1 60); do STATUS=$(cat data/channels/whatsapp/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 2; done; echo "timeout"
```

- If `authenticated` or `already_authenticated`, success — continue to next step.
- If `failed:logged_out`, delete `data/channels/whatsapp/auth/` and retry.
- If `failed:515` or timeout, the 515 reconnect should handle this automatically. If it persists, the user may need to temporarily stop other WhatsApp-connected apps on the same device.

### Option C: QR Code in Terminal

Tell the user to run the auth command in another terminal window:

> Open another terminal and run:
> ```
> cd PROJECT_PATH && node plugins/channels/whatsapp/auth.js
> ```
> Scan the QR code that appears, then let me know when it says "Successfully authenticated".

Replace `PROJECT_PATH` with the actual project path (use `pwd`).

Wait for the user to confirm authentication succeeded, then continue to the next step.

## Agent Teams

WhatsApp supports Agent Teams out of the box — no extra setup needed (unlike Telegram, which requires a bot pool). When subagents specify a `sender` parameter, their messages appear with a bold name prefix:

```
TARS: *Research Specialist*
Here's what I found...
```

To add persistent agent definitions to a group, run `/nanoclaw-add-agent`.

## Register a Chat

After authentication, the main chat is registered by `/nanoclaw-setup` (section 6c). Additional groups can be added later with `/nanoclaw-add-group`.

### WhatsApp JID Formats

| Type | Format | Example |
|------|--------|---------|
| Group | `{id}@g.us` | `120363336345536173@g.us` |
| Personal/DM | `{phone}@s.whatsapp.net` | `14155551234@s.whatsapp.net` |

### Finding Groups

Start the app briefly to sync group metadata, then query:

```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE '%@g.us' AND jid != '__group_sync__' ORDER BY last_message_time DESC LIMIT 20"
```

### Finding Personal Chat JID

The "Message Yourself" JID is the bot's own phone number. Check the auth state:

```bash
node -e "const c = JSON.parse(require('fs').readFileSync('data/channels/whatsapp/auth/creds.json','utf8')); const id = c.me?.id || ''; console.log(id.split(':')[0] + '@s.whatsapp.net')"
```

## Verify

- Check logs: `tail -20 logs/nanoclaw.log | grep -i whatsapp`
- Send a test message in the registered WhatsApp chat and confirm the agent responds

## Troubleshooting

- **Error 515 "restart required"**: This is normal during initial pairing — the auth script auto-reconnects. If it persists, temporarily stop other WhatsApp-connected apps on the same device. Wait 30 seconds.
- **QR code too wide**: Use `--serve` flag to get an HTTP-served QR at `http://SERVER_IP:8899`.
- **Messages sent but not received (DMs)**: WhatsApp may use LID (Linked Identity) JIDs for DMs instead of phone numbers. Check logs for `Translated LID to phone JID`. The WhatsApp plugin handles this automatically via `translateJid`.
- **Messages not received**: Verify the JID is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE channel = 'whatsapp'"`
- **WhatsApp disconnected**: The service will show a notification (macOS) or log an error. Run `node plugins/channels/whatsapp/auth.js` to re-authenticate, then restart the service.

## Uninstall

1. Stop the NanoClaw service
2. Remove the plugin directory: `rm -rf plugins/channels/whatsapp/`
3. Remove WhatsApp auth data: `rm -rf data/channels/whatsapp/`
4. Remove registered groups for this channel:
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel = 'whatsapp'"
   ```
5. Rebuild and restart NanoClaw
6. Group folders under `groups/` are preserved (not automatically deleted)
