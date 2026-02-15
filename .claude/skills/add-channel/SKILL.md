---
name: add-channel
description: >
  Add a channel group to NanoClaw. Discovers installed channel plugins, guides through
  group registration (admin or regular), and handles channel-specific auth setup.
  Triggers on "add channel", "add channel group", "register group", "add whatsapp group",
  "add telegram group", "add discord group", "new group", "connect channel".
---

# Add Channel Group

This skill adds a new group (chat) to an existing channel plugin in NanoClaw. It discovers which channel plugins are installed, presents them to the user, and walks through group registration — including whether the group should be the admin (main) channel or a regular group.

This is NOT for creating new channel plugins from scratch — use `/create-channel-plugin` for that.

## Workflow

### Step 1: Discover Available Channels

Scan for installed channel plugins:

```bash
ls -d plugins/channels/*/plugin.json 2>/dev/null
```

For each found plugin, read its `plugin.json` to get the name and description. Also check for existing registered groups:

```bash
sqlite3 data/messages.db "SELECT jid, name, folder, channel FROM registered_groups ORDER BY channel, added_at"
```

Present the findings to the user:

> "I found these channel plugins installed:
> - **whatsapp** — WhatsApp channel via Baileys
>   - Registered groups: main (admin), family-chat
> - **telegram** — Telegram channel via Grammy
>   - No groups registered yet
>
> Which channel do you want to add a group for?"

If only one channel plugin is installed, skip the selection and proceed directly.

If NO channel plugins are found:

> "No channel plugins are installed. Use `/create-channel-plugin` to create one, or `/add-telegram` to install Telegram."

### Step 2: Determine Group Type

Ask the user what kind of group they want to add:

> "What kind of group do you want to add?"

Options:
1. **Admin channel (main)** — The primary chat where you interact with the assistant. Gets elevated privileges (scheduled task output, system notifications, no trigger required).
2. **Regular group** — A standard group chat. Requires @mention or trigger word to activate the assistant.
3. **Solo/DM chat** — A private conversation (1:1 with the bot).

**Important checks:**

- If `main` folder already exists in `registered_groups`, warn the user:
  > "You already have a main (admin) group registered: `{name}` on `{channel}`. Registering a new main group will replace it. Do you want to continue?"

- If the user picks "Regular group" or "Solo/DM", ask for a folder name:
  > "What should I call this group's folder? This is used for isolated storage. Examples: `family`, `work-team`, `fitness-club`"

  Suggest a name based on the chat name if known.

### Step 3: Get the Chat JID

This step varies by channel. The approach depends on the channel plugin.

#### WhatsApp Groups

WhatsApp groups are discoverable. Check if the service is running and the channel is connected:

```bash
# Check if nanoclaw is running
pgrep -f 'node.*nanoclaw' > /dev/null && echo "RUNNING" || echo "STOPPED"
```

If running, the agent can discover WhatsApp groups via IPC. But since we're in Claude Code (not inside a container), we need to guide the user:

> "For WhatsApp groups, I need the group's JID. Here's how to get it:
>
> **Option A**: If the group has already messaged while NanoClaw was running, I can look it up:
> ```bash
> sqlite3 data/messages.db "SELECT jid, name, last_message_time FROM chats WHERE jid LIKE '%@g.us' ORDER BY last_message_time DESC LIMIT 20"
> ```
>
> **Option B**: Send a message in the WhatsApp group, then I can find it in the chats table.
>
> **Option C**: Paste the JID directly if you have it (format: `120363XXXXXXXXX@g.us`)."

For WhatsApp DMs:

> "For a WhatsApp DM, the JID is the phone number followed by `@s.whatsapp.net`. Example: `14155551234@s.whatsapp.net`"

#### Telegram Chats

> "For Telegram, the chat ID is shown when someone sends `/chatid` to the bot in that chat. The JID format is `tg:{chat_id}` — for example `tg:123456789` for a DM or `tg:-1001234567890` for a group."

#### Other Channels

For unknown channels, ask the user directly:

> "What's the chat identifier for this group? (The format depends on the channel — check the channel plugin's documentation)"

### Step 4: Set the Trigger

Ask about the trigger pattern:

> "How should the assistant be activated in this group?"

Options:
1. **Respond to all messages** (no trigger needed) — Best for admin/main and solo DMs. Sets `requiresTrigger: false`.
2. **Require @mention** (e.g., `@Andy`) — Default for groups. Sets `requiresTrigger: true` with trigger `@{ASSISTANT_NAME}`.
3. **Custom trigger** — A different trigger word or pattern.

For admin/main groups, default to "Respond to all messages". For regular groups, default to "Require @mention".

### Step 5: Register the Group

Read the assistant name from config:

```bash
grep '^ASSISTANT_NAME=' .env | cut -d= -f2 || echo "Andy"
```

Determine the channel name from the plugin. Then register via SQLite:

```bash
sqlite3 data/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, channel) VALUES ('{jid}', '{name}', '{folder}', '{trigger}', datetime('now'), {requiresTrigger}, '{channel}')"
```

Create the group's directory structure:

```bash
mkdir -p groups/{folder}
```

Create a basic `CLAUDE.md` for the group:

```bash
cat > groups/{folder}/CLAUDE.md << 'EOF'
# {Group Name}

This is the {folder} group on {channel}.

## Instructions

{Customize this file to give the assistant context about this group.}
EOF
```

### Step 6: Channel-Specific Auth (if needed)

Check if the channel is already authenticated:

For WhatsApp:
```bash
ls data/channels/whatsapp/auth/creds.json 2>/dev/null && echo "AUTHENTICATED" || echo "NEEDS_AUTH"
```

If not authenticated, guide through the channel's auth flow:

> "This channel needs authentication first. Let me run the auth setup."

For WhatsApp, run:
```bash
node plugins/channels/whatsapp/auth.js --serve
```

For other channels, check if they have an `auth.js`:
```bash
[ -f plugins/channels/{name}/auth.js ] && echo "HAS_AUTH" || echo "NO_AUTH"
```

If they have `auth.js`, run it. If not, check for credential env vars and guide the user through adding them to `.env`.

### Step 7: Restart and Verify

```bash
npm run build && systemctl restart nanoclaw
```

Wait a few seconds, then verify:

```bash
# Check service is running
sleep 3
pgrep -f 'node.*nanoclaw' > /dev/null && echo "SERVICE_RUNNING" || echo "SERVICE_FAILED"

# Verify group is registered
sqlite3 data/messages.db "SELECT jid, name, folder, channel FROM registered_groups WHERE folder = '{folder}'"

# Check logs for channel connection
tail -20 logs/nanoclaw.log | grep -i '{channel}'
```

Tell the user:

> "Done! The `{name}` group is registered on `{channel}`.
>
> **To test**: Send a message in the group{trigger_instruction}.
>
> **To customize**: Edit `groups/{folder}/CLAUDE.md` to give the assistant context about this group."

## State Detection

Before starting, always check the current state to avoid redundant work:

```bash
# What channels are installed?
for d in plugins/channels/*/plugin.json; do echo "$(dirname $d): $(cat $d | python3 -c 'import sys,json; print(json.load(sys.stdin).get(\"name\",\"unknown\"))' 2>/dev/null || echo 'unknown')"; done

# What groups are already registered?
sqlite3 data/messages.db "SELECT jid, name, folder, channel, requires_trigger FROM registered_groups" 2>/dev/null

# Is there a main group?
sqlite3 data/messages.db "SELECT jid, name, channel FROM registered_groups WHERE folder = 'main'" 2>/dev/null

# Is the service running?
pgrep -f 'node.*nanoclaw' > /dev/null && echo "RUNNING" || echo "STOPPED"
```

## Multi-Instance Support

A user might want multiple groups on the same channel (e.g., two WhatsApp groups — one admin, one for a family chat). This is fully supported:

- Each group has a unique JID (different WhatsApp group = different JID)
- Each group has a unique folder name (different isolated storage)
- The `channel` column tracks which channel plugin owns each group
- Plugin scoping (`channels` and `groups` fields in plugin.json) controls which plugins are injected into which group's container

## Error Handling

- **Channel not connected**: If the channel plugin exists but isn't connected (e.g., WhatsApp auth expired), guide through re-authentication before registering
- **Duplicate folder**: If the user picks a folder name that already exists, warn and suggest alternatives
- **Invalid JID**: Validate JID format matches the channel's convention before registering
- **Service not running**: If nanoclaw isn't running, register the group in the DB and tell the user to start the service

## Quick Reference: JID Formats

| Channel | Groups | DMs | Example |
|---------|--------|-----|---------|
| WhatsApp | `{id}@g.us` | `{phone}@s.whatsapp.net` | `120363336345536173@g.us` |
| Telegram | `tg:-{id}` | `tg:{id}` | `tg:-1001234567890` |
| Discord | `dc:{channel_id}` | `dc:{dm_id}` | `dc:123456789012345678` |
| Slack | `slack:{channel_id}` | `slack:{dm_id}` | `slack:C01ABCDEF` |
