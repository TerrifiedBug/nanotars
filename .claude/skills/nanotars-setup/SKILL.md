---
name: nanotars-setup
description: Run initial NanoTars setup. Use when user wants to install dependencies, authenticate a channel, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanotars", or first-time setup requests.
---

# NanoTars Setup

Run all commands automatically. Only pause when user action is required (channel authentication, configuration choices).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## 0a. Read onboarding selections (if present)

Legacy installs may have `data/onboarding.json` from the old shell-side onboarding flow. If it exists, load it and use those values as defaults — don't re-ask.

```bash
if [ -f data/onboarding.json ]; then
  cat data/onboarding.json
fi
```

If the file exists and has `name` set: greet the user by that name on first message. Don't re-prompt for it.

If the file has `channels` populated: that's the user's pre-picked channel install list. Skip the channel-discovery prompt in section 5b and proceed to install + authenticate each channel in order. After each channel is authenticated, move on to the next one. After all picked channels are done, ask the user which one to wire as the **main** channel for their first agent group.

If `data/onboarding.json` is missing or empty: proceed with the normal interactive flow (sections 0+ below).

## 0. Detect Existing Setup

Before doing anything, check what's already configured:

```bash
echo "=== SETUP STATE ==="
[ -d node_modules ] && echo "DEPS: installed" || echo "DEPS: missing"
(which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo "CONTAINER_RUNTIME: docker") || (which container >/dev/null 2>&1 && echo "CONTAINER_RUNTIME: apple_container") || echo "CONTAINER_RUNTIME: none"
(docker image inspect nanoclaw-agent:latest >/dev/null 2>&1 || container image list 2>/dev/null | grep -q nanoclaw-agent) && echo "IMAGE: built" || echo "IMAGE: not_built"
if grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f "$HOME/.claude/.credentials.json" ]; then echo "AUTH: configured"; else echo "AUTH: missing"; fi
ls plugins/channels/*/plugin.json 2>/dev/null | head -1 | xargs -I{} sh -c '
  DIR=$(dirname "{}")
  NAME=$(basename "$DIR")
  [ -f "data/channels/$NAME/auth/creds.json" ] || [ -f "data/channels/$NAME/auth-status.txt" ] && echo "CHANNEL_AUTH: $NAME" || echo "CHANNEL_AUTH: none"
' 2>/dev/null || echo "CHANNEL_AUTH: no_channels"
[ -d groups/main ] && echo "MAIN_GROUP: folder_exists" || echo "MAIN_GROUP: not_registered"
grep -q "^TZ=" .env 2>/dev/null && echo "TIMEZONE: configured" || echo "TIMEZONE: not_set"
[ -f ~/.config/nanotars/mount-allowlist.json ] && echo "MOUNT_ALLOWLIST: configured" || echo "MOUNT_ALLOWLIST: missing"
which ffmpeg >/dev/null 2>&1 && echo "FFMPEG: installed" || echo "FFMPEG: not_installed (optional)"
(pgrep -f 'node.*dist/index.js' >/dev/null 2>&1 || launchctl list 2>/dev/null | grep -q nanotars || systemctl is-active nanotars >/dev/null 2>&1) && echo "SERVICE: running" || echo "SERVICE: not_running"
```

Based on the results, determine the setup state:

**If everything shows configured/installed/running**: NanoTars is already fully set up. Tell the user:

> NanoTars is already set up and running. Here's what I found:
> - Dependencies: installed
> - Container runtime: {docker/apple_container}
> - Container image: built
> - Claude auth: configured
> - Channel: {channel_name} (authenticated)
> - Main group: registered
> - Service: running
>
> What would you like to do?

Use `AskUserQuestion` with options:
1. **Re-authenticate channel** — Re-run channel auth (e.g., if WhatsApp got disconnected)
2. **Add another channel or group** — Use `/nanotars-add-group`
3. **Reconfigure from scratch** — Start over from step 1
4. **Nothing, looks good** — Exit

If they pick option 1: Skip to section 5 (Authenticate Channel).
If they pick option 2: Tell them to use `/nanotars-add-group` instead.
If they pick option 3: Continue with section 1 below.
If they pick option 4: Done.

**If partially configured**: Show what's done and what's missing, then start from the first incomplete step. For example:

> NanoTars is partially set up:
> - [x] Dependencies installed
> - [x] Container runtime (Docker)
> - [x] Container image built
> - [x] Claude auth configured
> - [ ] Channel authentication — not yet done
> - [ ] Main group — not registered
>
> I'll continue from where you left off.

Skip completed steps and start from the first missing one.

**If nothing configured** (fresh install): Proceed with section 1 below without asking.

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

Docker is supported natively. Tell the user:
> You're on Linux, so we'll use Docker for container isolation.

Verify Docker is installed and running:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker ready" || echo "Docker not installed or not running"
```

If not installed:
> Docker is required for running agents in isolated containers.
>
> ```bash
> curl -fsSL https://get.docker.com | sh
> sudo systemctl start docker
> sudo usermod -aG docker $USER  # Then log out and back in
> ```
>
> Let me know when Docker is running.

Wait for confirmation, verify with `docker info`, then continue to Section 3.

### If on macOS

**If Apple Container is already installed:** Continue to Section 3.

**If Apple Container is NOT installed:** Ask the user:
> NanoTars needs a container runtime for isolated agent execution. You have two options:
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

**Note:** NanoTars automatically starts the Apple Container system when it launches, so you don't need to start it manually after reboots.

#### Option B: Docker

Docker is supported natively. Verify it's installed:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker ready" || echo "Docker not installed or not running"
```

If not installed, tell the user:
> Download Docker Desktop from https://docker.com/products/docker-desktop
> Install and start it, then let me know when the whale icon stops animating.

Wait for confirmation, verify with `docker info`, then continue to Section 3.

## 3. Configure Claude Authentication

First, check if auth is already configured:

```bash
echo "=== AUTH CHECK ==="
[ -f ~/.claude/.credentials.json ] && echo "CREDENTIALS_FILE: found" || echo "CREDENTIALS_FILE: missing"
grep -q "ANTHROPIC_API_KEY" .env 2>/dev/null && echo "API_KEY: found" || echo "API_KEY: missing"
grep -q "CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null && echo "OAUTH_TOKEN: found" || echo "OAUTH_TOKEN: missing"
```

**If any auth method is found**, tell the user and skip to section 4:
> Claude authentication is already configured. Moving on.

**If no auth found**, ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the credentials are saved to `~/.claude/.credentials.json` and containers will pick them up automatically.
>
> Alternatively, you can paste the OAuth token here and I'll add it to `.env`.

If they give you the token, add it to `.env`. **Never echo the full token in commands or output** — use the Write tool to write the `.env` file directly, or tell the user to add it themselves:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

If they ran `claude setup-token` or `claude login` successfully, verify:
```bash
[ -f ~/.claude/.credentials.json ] && echo "Credentials file found — auth is configured" || echo "No credentials file found"
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

Build the NanoTars agent container:

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

## 4b. Add Skill Marketplace

Check if the NanoTars skills marketplace is configured:

```bash
grep -q "nanoclaw-skills" .claude/settings.json 2>/dev/null && echo "MARKETPLACE: configured" || echo "MARKETPLACE: not configured"
```

**If marketplace is configured**, tell the user:
> The NanoTars skills marketplace is available. After setup, you can add optional capabilities like weather, email, search, smart home, and more.
>
> Browse available plugins:
> - `/plugin` Discover tab in Claude Code
> - Or visit: https://github.com/TerrifiedBug/nanotars-skills
>
> Install example:
> 1. `/plugin install nanoclaw-weather@nanoclaw-skills`
> 2. Run the install skill: `/add-skill-weather`
>
> Popular plugins: weather, brave-search, homeassistant, stocks, gmail, calendar.
> You can install plugins at any time after setup completes.

**If NOT configured** and the user wants integrations:
> NanoTars ships with no plugins installed — you add only what you need from the skills marketplace.
>
> To enable the marketplace:
> ```
> /plugin marketplace add TerrifiedBug/nanotars-skills
> ```
>
> After adding, browse with `/plugin` or install directly:
> ```
> /plugin install nanoclaw-weather@nanoclaw-skills
> ```
>
> You can skip this now and add the marketplace later.

## 5. Authenticate Channel

**USER ACTION REQUIRED**

NanoTars uses channel plugins to connect to messaging platforms. Discover what's available.

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
```

Available channels (not yet installed) are in the NanoTars skills marketplace. If no channels are installed:
> Channel plugins are available from the NanoTars skills marketplace:
> - **discord** — Discord (servers + DMs)
> - **telegram** — Telegram (bot API)
> - **whatsapp** — WhatsApp via Baileys
> - **slack** — Slack (Socket Mode)
>
> Install one with: `/plugin install nanoclaw-<name>@nanoclaw-skills`
> Then run `/add-channel-<name>` to configure it.

### 5b. Select channel

Present installed channels to the user. If none are installed, show the marketplace options above.

**If only one channel plugin is installed**: Skip selection and proceed with that channel.

**If multiple channels installed**: Ask the user which channel to set up as their main.

**If user picks an uninstalled channel**: Tell them to install it from the marketplace:
> Install the channel plugin first:
> `/plugin install nanoclaw-{name}@nanoclaw-skills`
> Then run `/add-channel-{name}` to configure it.

**If no channels found at all** (neither installed nor in marketplace): Tell the user:

> No channel plugins are installed. Use `/create-channel-plugin` to build one from scratch.

Store the chosen channel name — it will be used in later steps (registration, troubleshooting).

### 5c. Channel-specific authentication

Based on the chosen channel, authenticate using the channel's own auth mechanism.

#### Generic auth flow

First, check if the channel is already authenticated:

```bash
CHANNEL_NAME="CHOSEN_CHANNEL"
CHANNEL_DIR="plugins/channels/$CHANNEL_NAME"
[ -f "data/channels/$CHANNEL_NAME/auth/creds.json" ] || [ -f "data/channels/$CHANNEL_NAME/auth-status.txt" ] && echo "ALREADY_AUTHENTICATED" || echo "NEEDS_AUTH"
```

If already authenticated, skip to section 6.

**If the channel has `auth.js`:**

```bash
[ -f "plugins/channels/$CHANNEL_NAME/auth.js" ] && echo "HAS_AUTH_SCRIPT" || echo "NO_AUTH_SCRIPT"
```

Run the auth script. It follows the standard status protocol — writes to `data/channels/{name}/auth-status.txt`:
- `already_authenticated` — credentials already exist
- `authenticated` — successfully authenticated
- `pairing_code:<CODE>` — interactive pairing (WhatsApp-specific)
- `failed:<reason>` — authentication failed

```bash
node plugins/channels/$CHANNEL_NAME/auth.js
```

Run with `run_in_background: true`, then poll for status (up to 120 seconds):

```bash
for i in $(seq 1 60); do STATUS=$(cat data/channels/$CHANNEL_NAME/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 2; done; echo "timeout"
```

**If no `auth.js`:** Check the plugin's `plugin.json` for `containerEnvVars` — these are credentials the channel needs. Ask the user for each value and add them to `.env`.

#### Known channel auth patterns

These are common channels with specific auth requirements:

**WhatsApp** — Interactive auth via QR code or pairing code. The auth script supports `--serve` (HTTP QR for headless servers) and `--pairing-code --phone NUMBER` (numeric code entry). Handles error 515 reconnection automatically. If the WhatsApp plugin is installed, read `plugins/channels/whatsapp/auth.js` for the full auth flow.

**Telegram** — Token-based. Needs `TELEGRAM_BOT_TOKEN` in `.env` (get from @BotFather). No interactive auth needed.

**Discord** — Token-based. Needs `DISCORD_BOT_TOKEN` in `.env` (get from Discord Developer Portal). Enable Message Content Intent in bot settings. No interactive auth needed.

For WhatsApp specifically, if you need the detailed QR/pairing code flow, check the installed plugin at `plugins/channels/whatsapp/` or the marketplace skill for setup instructions.

## 6. Configure Assistant Name and Main Channel

This step configures three things at once: the trigger word, the main channel type, and the main channel selection.

### 6a. Ask for trigger word

Ask the user:
> What trigger word do you want to use? (default: `TARS`)
>
> In group chats, messages starting with `@TriggerWord` will be sent to Claude.
> In your main channel (and optionally solo chats), no prefix is needed — all messages are processed.

Store their choice for use in the steps below.

### 6a-ii. Set assistant name environment variable

Write the chosen name to `.env` so the global config picks it up:

```bash
grep -q "^ASSISTANT_NAME=" .env 2>/dev/null && sed -i "s/^ASSISTANT_NAME=.*/ASSISTANT_NAME=CHOSEN_NAME/" .env || echo "ASSISTANT_NAME=CHOSEN_NAME" >> .env
```

Replace `CHOSEN_NAME` with the trigger word the user chose above (without the `@` prefix).

> This sets the global assistant name used for bot message detection, log messages, and the default trigger pattern. The per-group trigger in `messaging_group_agents.engage_pattern` takes precedence for individual chat wirings.

### 6b. Explain security model and ask about main channel type

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoTars project
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

> You've chosen a group with other people. This means everyone in that group will have admin privileges over NanoTars.
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

Groups are synced on startup via `groupFetchAllParticipating`. To find the group JID, use `/nanotars-groups` (queries the live Baileys connection's `groupFetchAllParticipating()`) — or skip the JID lookup entirely and use the cross-channel pairing-code flow: `/register-group <folder>` from main → 4-digit code → send the code from the WhatsApp chat you want to wire up. The pairing flow sidesteps the JID lookup entirely.

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

Register the main chat by issuing a pairing code from the host:

```bash
nanotars pair-main
```

The CLI prints a 4-digit pairing code. Send that code as a message from the chat you want to register; the channel plugin's inbound interceptor consumes the code and creates the entity-model rows (`agent_groups` + `messaging_groups` + `messaging_group_agents`) atomically through `src/db/agent-groups.ts` helpers — no manual SQL needed.

- For DMs or main groups, set `requires_trigger` to `0` (responds to all messages)
- For group chats, keep `requires_trigger` as `1` (default, needs @mention)
- Always include the `channel` value (e.g., `whatsapp`, `telegram`, `discord`) — used for plugin scoping

The group CLAUDE.md files use the `$ASSISTANT_NAME` environment variable — no name replacement needed.

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 7. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoTars project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

```bash
mkdir -p ~/.config/nanotars
cat > ~/.config/nanotars/mount-allowlist.json << 'EOF'
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
mkdir -p ~/.config/nanotars
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/nanotars/mount-allowlist.json << 'EOF'
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
cat ~/.config/nanotars/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the NanoTars service
>
> To grant a group access to an external directory:
>
> Per-group `additionalMounts` can currently only be set at registration time (the `container_config` field on `agent_groups`). Mutating it later via slash command isn't shipped yet — file a backlog item if you need this. Workaround: re-register the group via `/delete-group <folder>` + `/register-group <folder>` and pass the desired mounts at registration.
>
> The folder appears inside the container at `/workspace/extra/<folder-name>` (derived from the last segment of the path). Add `"readonly": false` for write access, or `"containerPath": "custom-name"` to override the default name.

## 8. Configure Background Service

The TypeScript CLI owns service generation. Do not write launchd plists, systemd units, or nohup launchers by hand.

```bash
npm run build
mkdir -p logs
node dist/cli/nanotars.js service install
node dist/cli/nanotars.js status
```

`service install` automatically chooses launchd on macOS, systemd-user on Linux when available, and a nohup launcher for root/WSL-style hosts.

## 9. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.
>
> **Tip:** In your main channel, you don't need the `@` prefix — just send `hello` and the agent will respond.

Check the logs:
```bash
tail -f logs/nanotars.log
```

The user should receive a response in their registered channel.

## Troubleshooting

### General

**Service not starting**: Check `logs/nanotars.error.log`

**Container agent fails with "Claude Code process exited with code 1"**:
- Ensure the container runtime is running:
  - Apple Container: `container system start`
  - Docker: `docker info` (start Docker Desktop on macOS, or `sudo systemctl start docker` on Linux)
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Main channel doesn't require a prefix — all messages are processed
- Personal/solo chats with `requiresTrigger: false` also don't need a prefix
- From your main chat, run `/list-groups` to see what's registered. The output groups by channel_type and shows the wired chats; you can spot a missing wiring or wrong engage_mode at a glance. Don't reach into the SQLite schema directly — the entity-model migration silently breaks inline SQL.
- Check `logs/nanotars.log` for errors

**Unload service**:
```bash
nanotars stop
```

**Restart service**:
```bash
nanotars restart
```

**Stop service**:
```bash
nanotars stop
```

**View logs**:
```bash
nanotars logs
```

### WhatsApp-Specific

**Messages sent but not received by NanoTars (DMs)**:
- WhatsApp may use LID (Linked Identity) JIDs for DMs instead of phone numbers
- Check logs for `Translated LID to phone JID` — if missing, the LID isn't being resolved
- The `translateJid` method in `plugins/channels/whatsapp/index.js` uses `sock.signalRepository.lidMapping.getPNForLID()` to resolve LIDs
- Verify the registered JID doesn't have a device suffix (should be `number@s.whatsapp.net`, not `number:0@s.whatsapp.net`)

**WhatsApp disconnected**:
- The service will show a macOS notification
- Run `node plugins/channels/whatsapp/auth.js` to re-authenticate
- Restart the service: `nanotars restart`

### Other Channels

For channel-specific troubleshooting, check the channel plugin's documentation or `auth.js` script. Common issues:
- **Token expired**: Re-run the channel's auth flow or update the token in `.env`
- **Bot not receiving messages**: Verify the bot has the right permissions in the platform
- **Chat not registered**: From your main chat, run `/list-groups` to see what's registered. The output groups by channel_type and shows the wired chats; you can spot a missing wiring or wrong engage_mode at a glance. Don't reach into the SQLite schema directly — the entity-model migration silently breaks inline SQL.
