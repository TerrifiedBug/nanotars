---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate a channel, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (channel authentication, configuration choices).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Container Runtime

First, detect the platform and check what's available:

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
which docker && docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

### If NOT on macOS (Linux, etc.)

Apple Container is macOS-only. Use Docker instead.

Tell the user:
> You're on Linux, so we'll use Docker for container isolation. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

### If on macOS

**If Apple Container is already installed:** Continue to Section 3.

**If Apple Container is NOT installed:** Ask the user:
> NanoClaw needs a container runtime for isolated agent execution. You have two options:
>
> 1. **Apple Container** (default) - macOS-native, lightweight, designed for Apple silicon
> 2. **Docker** - Cross-platform, widely used, works on macOS and Linux
>
> Which would you prefer?

#### Option A: Apple Container

Tell the user:
> Apple Container is required for running agents in isolated environments.
>
> 1. Download the latest `.pkg` from https://github.com/apple/container/releases
> 2. Double-click to install
> 3. Run `container system start` to start the service
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
container system start
container --version
```

**Note:** NanoClaw automatically starts the Apple Container system when it launches, so you don't need to start it manually after reboots.

#### Option B: Docker

Tell the user:
> You've chosen Docker. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

## 3. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, add it to `.env`. **Never echo the full token in commands or output** — use the Write tool to write the `.env` file directly, or tell the user to add it themselves:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

### Option 2: API Key

Ask if they have an existing key to copy or need to create one.

**Copy existing:**
```bash
grep "^ANTHROPIC_API_KEY=" /path/to/source/.env > .env
```

**Create new:**
```bash
echo 'ANTHROPIC_API_KEY=' > .env
```

Tell the user to add their key from https://console.anthropic.com/

**Verify:**
```bash
KEY=$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:7}..." || echo "Missing"
```

## 4. Build Container Image

Build the NanoClaw agent container:

```bash
./container/build.sh
```

This creates the `nanoclaw-agent:latest` image with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify the build succeeded by running a simple test (this auto-detects which runtime you're using):

```bash
if which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
else
  echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
fi
```

## 5. Authenticate Channel

**USER ACTION REQUIRED**

NanoClaw uses channel plugins to connect to messaging platforms. Discover what's available.

### 5a. Discover channels

First, find **installed** channel plugins (already in `plugins/channels/`):

```bash
echo "=== INSTALLED ==="
for f in plugins/channels/*/plugin.json; do
  [ -f "$f" ] || continue
  DIR=$(dirname "$f")
  NAME=$(python3 -c "import json; print(json.load(open('$f'))['name'])" 2>/dev/null || basename "$DIR")
  DESC=$(python3 -c "import json; print(json.load(open('$f')).get('description',''))" 2>/dev/null || echo "")
  echo "$NAME|$DESC|$DIR"
done

echo "=== AVAILABLE (not yet installed) ==="
for s in .claude/skills/channels/*/SKILL.md; do
  [ -f "$s" ] || continue
  CHANNEL_NAME=$(basename "$(dirname "$s")")
  # Skip if already installed
  [ -d "plugins/channels/$CHANNEL_NAME" ] && continue
  echo "$CHANNEL_NAME|$(dirname "$s")"
done
```

### 5b. Select channel

Present both installed and available channels to the user. Mark which are installed and which need installation.

**If only one channel plugin is installed and none available** (default: WhatsApp ships with NanoClaw): Skip selection and proceed with that channel.

**If multiple channels available (installed or not)**: Ask the user which channel to set up as their main:

> I found these channels:
>
> **Installed (ready to use):**
> - **whatsapp** — WhatsApp channel via Baileys
>
> **Available (not yet installed):**
> - **telegram** — Not part of the core plugin set. I can install it for you.
>
> Which channel do you want to use for your main (admin) channel?

**If user picks an uninstalled channel**: Read the channel skill at `.claude/skills/channels/{name}/SKILL.md` and follow its installation instructions. This typically involves:
1. Installing npm dependencies (e.g., `npm install grammy` for Telegram)
2. Copying plugin files to `plugins/channels/{name}/` (if the skill has a `files/` directory)
3. Collecting credentials (bot tokens, API keys) and adding them to `.env`

After installation, continue with authentication below.

**If no channels found at all** (neither installed nor available): Tell the user:

> No channel plugins are installed or available. Use `/create-channel-plugin` to build one from scratch.

Store the chosen channel name — it will be used in later steps (registration, troubleshooting).

### 5b. Channel-specific authentication

Based on the chosen channel, follow the appropriate auth flow below.

#### WhatsApp Authentication

The auth script supports two methods: QR code scanning and pairing code (phone number). Ask the user which they prefer.

The auth script writes status to `data/channels/whatsapp/auth-status.txt`:
- `already_authenticated` — credentials already exist
- `pairing_code:<CODE>` — pairing code generated, waiting for user to enter it
- `authenticated` — successfully authenticated
- `failed:<reason>` — authentication failed

The script automatically handles error 515 (stream error after pairing) by reconnecting — this is normal and expected during pairing code auth.

##### Ask the user which method to use

> How would you like to authenticate WhatsApp?
>
> 1. **QR code in browser** (Recommended) — Opens a page with the QR code to scan
> 2. **Pairing code** — Enter a numeric code on your phone, no camera needed
> 3. **QR code in terminal** — Run the auth command yourself in another terminal

##### Option A: QR Code in Browser (Recommended)

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
  const template = fs.readFileSync('.claude/skills/setup/qr-auth.html', 'utf8');
  fs.writeFileSync('data/channels/whatsapp/qr-auth.html', template.replace('{{QR_SVG}}', svg));
  console.log('done');
});
"
open data/channels/whatsapp/qr-auth.html
```

Tell the user:
> The QR code is ready. It expires in about 60 seconds.
>
> Scan it with WhatsApp: **Settings → Linked Devices → Link a Device**

Then poll for completion (up to 120 seconds):

```bash
for i in $(seq 1 60); do STATUS=$(cat data/channels/whatsapp/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 2; done; echo "timeout"
```

- If `authenticated`, success — clean up with `rm -f data/channels/whatsapp/qr-auth.html` and continue.
- If `failed:qr_timeout`, offer to retry (re-run the auth and regenerate the HTML page).
- If `failed:logged_out`, delete `data/channels/whatsapp/auth/` and retry.

##### Option B: Pairing Code

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

Extract the code from the status (e.g. `pairing_code:ABC12DEF` → `ABC12DEF`) and tell the user:

> Your pairing code: **CODE_HERE**
>
> 1. Open WhatsApp on your phone
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Tap **"Link with phone number instead"**
> 4. Enter the code: **CODE_HERE**

Then poll for completion (up to 120 seconds):

```bash
for i in $(seq 1 60); do STATUS=$(cat data/channels/whatsapp/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 2; done; echo "timeout"
```

- If `authenticated` or `already_authenticated`, success — continue to next step.
- If `failed:logged_out`, delete `data/channels/whatsapp/auth/` and retry.
- If `failed:515` or timeout, the 515 reconnect should handle this automatically. If it persists, the user may need to temporarily stop other WhatsApp-connected apps on the same device.

##### Option C: QR Code in Terminal

Tell the user to run the auth command in another terminal window:

> Open another terminal and run:
> ```
> cd PROJECT_PATH && node plugins/channels/whatsapp/auth.js
> ```
> Scan the QR code that appears, then let me know when it says "Successfully authenticated".

Replace `PROJECT_PATH` with the actual project path (use `pwd`).

Wait for the user to confirm authentication succeeded, then continue to the next step.

#### Other Channel Authentication

For channels other than WhatsApp, check if the channel plugin has an `auth.js` script:

```bash
CHANNEL_DIR="plugins/channels/CHANNEL_NAME"
[ -f "$CHANNEL_DIR/auth.js" ] && echo "HAS_AUTH_SCRIPT" || echo "NO_AUTH_SCRIPT"
```

**If it has `auth.js`:** Run it and follow its instructions:
```bash
node plugins/channels/CHANNEL_NAME/auth.js
```

**If no `auth.js`:** Check the plugin's `plugin.json` for `containerEnvVars` — these are credentials the channel needs. Ask the user for each credential and add them to `.env`. Common patterns:
- Telegram: `TELEGRAM_BOT_TOKEN` — get from @BotFather
- Discord: `DISCORD_BOT_TOKEN` — get from Discord Developer Portal
- Slack: `SLACK_BOT_TOKEN` — get from Slack API console

Check for existing auth state:
```bash
ls data/channels/CHANNEL_NAME/auth/ 2>/dev/null && echo "ALREADY_AUTHENTICATED" || echo "NEEDS_AUTH"
```

## 6. Configure Assistant Name and Main Channel

This step configures three things at once: the trigger word, the main channel type, and the main channel selection.

### 6a. Ask for trigger word

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> In group chats, messages starting with `@TriggerWord` will be sent to Claude.
> In your main channel (and optionally solo chats), no prefix is needed — all messages are processed.

Store their choice for use in the steps below.

### 6b. Explain security model and ask about main channel type

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use a private/DM chat (just you and the bot) as your main channel. This ensures only you have admin control.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
> 1. Private/DM chat (just you and the bot) - Recommended
> 2. Solo group chat (just me)
> 3. Group chat with other people (I understand the security implications)

If they choose option 3, ask a follow-up:

> You've chosen a group with other people. This means everyone in that group will have admin privileges over NanoClaw.
>
> Are you sure you want to proceed? The other members will be able to:
> - Read messages from your other registered chats
> - Schedule and manage tasks
> - Access any directories you've mounted
>
> Options:
> 1. Yes, I understand and want to proceed
> 2. No, let me use a private chat instead

### 6c. Register the main channel

First build, then start the app briefly to connect to the channel and sync metadata. Use the Bash tool's timeout parameter (15000ms) — do NOT use the `timeout` shell command (it's not available on macOS). The app will be killed when the timeout fires, which is expected.

```bash
npm run build
```

Then run briefly (set Bash tool timeout to 15000ms):
```bash
npm run dev
```

Now get the chat identifier (JID) for the main channel. The process depends on the channel chosen in step 5.

#### WhatsApp: Get JID

**For private/DM chat** (they chose option 1):

Personal chats are NOT synced to the database on startup — only groups are. The JID for a personal chat is the phone number with `@s.whatsapp.net`. Use the number from the WhatsApp auth step and construct the JID as `{number}@s.whatsapp.net`.

Ask the user for the phone number if not already known (country code, no + or spaces, e.g. `14155551234`).

**For group** (they chose option 2 or 3):

Groups are synced on startup via `groupFetchAllParticipating`. Query the database for recent groups:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE '%@g.us' AND jid != '__group_sync__' ORDER BY last_message_time DESC LIMIT 40"
```

Show only the **10 most recent** group names to the user and ask them to pick one. If they say their group isn't in the list, show the next batch from the results you already have. If they tell you the group name directly, look it up:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE name LIKE '%GROUP_NAME%' AND jid LIKE '%@g.us'"
```

#### Telegram: Get JID

Tell the user:
> Send `/chatid` to the bot in the chat you want to use as your main channel. The bot will reply with the chat ID.

The JID format is `tg:{chat_id}` — for example `tg:123456789` for a DM or `tg:-1001234567890` for a group.

#### Other Channels: Get JID

For other channels, check if the channel has a `listAvailableGroups()` method by looking at its implementation. If not, ask the user to provide the chat identifier directly. Each channel has its own ID format — refer to the channel plugin's documentation or `docs/CHANNEL_PLUGINS.md` for JID format conventions.

### 6d. Configure Timezone

Ask the user:
> What timezone are you in? This ensures scheduled tasks (reminders, digests) know the correct day and time.

Detect the system timezone as a suggested default:

```bash
timedatectl show --property=Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "UTC"
```

Present common options using `AskUserQuestion`:
- Use detected system timezone (show what was detected)
- Europe/London
- America/New_York
- America/Los_Angeles
- Other (let me type it)

Validate their choice is a real IANA timezone:

```bash
TZ="THEIR_CHOICE" date "+%Z" 2>/dev/null && echo "valid" || echo "invalid"
```

Add it to `.env`:

```bash
echo "TZ=THEIR_CHOICE" >> .env
```

### 6e. Write the configuration

Once you have the JID, configure it. Use the assistant name from step 6a and the channel name from step 5.

For private/DM chats (solo, no prefix needed), set `requiresTrigger` to `false`:

```json
{
  "JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "requiresTrigger": false,
    "channel": "CHANNEL_NAME"
  }
}
```

For groups, keep `requiresTrigger` as `true` (default).

**Important:** Always include the `channel` field with the channel plugin name (e.g., `"whatsapp"`, `"telegram"`, `"discord"`). This is stored in the `registered_groups` table and used for plugin scoping.

Write to the database directly by creating a temporary registration script, or write `data/registered_groups.json` which will be auto-migrated on first run:

```bash
mkdir -p data
```

Then write `data/registered_groups.json` with the correct JID, trigger, channel, and timestamp.

The group CLAUDE.md files use the `$ASSISTANT_NAME` environment variable — no name replacement needed.

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 7. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

Skip to the next step.

If **yes**, ask follow-up questions:

### 7a. Collect Directory Paths

Ask the user:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory they provide, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?
>
> Read-write is needed for: code changes, creating files, git commits
> Read-only is safer for: reference docs, config examples, templates

### 7b. Configure Non-Main Group Access

Ask the user:
> Should **non-main groups** (other registered chats you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
>
> Recommended: **Yes** - this prevents other groups from modifying files even if you grant them access to a directory.

### 7c. Create the Allowlist

Create the allowlist file based on their answers:

```bash
mkdir -p ~/.config/nanoclaw
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/docs",
      "allowReadWrite": false,
      "description": "Reference documents"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

Verify the file:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the NanoClaw service
>
> To grant a group access to a directory, add it to their config in `data/registered_groups.json`:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app" }
>   ]
> }
> ```
> The folder appears inside the container at `/workspace/extra/<folder-name>` (derived from the last segment of the path). Add `"readonly": false` for write access, or `"containerPath": "custom-name"` to override the default name.

## 8. Configure launchd Service

Generate the plist file with correct paths automatically:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

echo "Created launchd plist with:"
echo "  Node: ${NODE_PATH}"
echo "  Project: ${PROJECT_PATH}"
```

Build and start the service:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:
```bash
launchctl list | grep nanoclaw
```

## 9. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.
>
> **Tip:** In your main channel, you don't need the `@` prefix — just send `hello` and the agent will respond.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in their registered channel.

## Troubleshooting

### General

**Service not starting**: Check `logs/nanoclaw.error.log`

**Container agent fails with "Claude Code process exited with code 1"**:
- Ensure the container runtime is running:
  - Apple Container: `container system start`
  - Docker: `docker info` (start Docker Desktop on macOS, or `sudo systemctl start docker` on Linux)
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Main channel doesn't require a prefix — all messages are processed
- Personal/solo chats with `requiresTrigger: false` also don't need a prefix
- Check that the chat JID is in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`
- Check `logs/nanoclaw.log` for errors

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

### WhatsApp-Specific

**Messages sent but not received by NanoClaw (DMs)**:
- WhatsApp may use LID (Linked Identity) JIDs for DMs instead of phone numbers
- Check logs for `Translated LID to phone JID` — if missing, the LID isn't being resolved
- The `translateJid` method in `plugins/channels/whatsapp/index.js` uses `sock.signalRepository.lidMapping.getPNForLID()` to resolve LIDs
- Verify the registered JID doesn't have a device suffix (should be `number@s.whatsapp.net`, not `number:0@s.whatsapp.net`)

**WhatsApp disconnected**:
- The service will show a macOS notification
- Run `node plugins/channels/whatsapp/auth.js` to re-authenticate
- Restart the service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

### Other Channels

For channel-specific troubleshooting, check the channel plugin's documentation or `auth.js` script. Common issues:
- **Token expired**: Re-run the channel's auth flow or update the token in `.env`
- **Bot not receiving messages**: Verify the bot has the right permissions in the platform
- **Chat not registered**: Check `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE channel = 'CHANNEL_NAME'"`
