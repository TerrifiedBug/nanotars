---
name: nanotars-add-group
description: >
  Add a channel group to NanoTars. Discovers installed channel plugins, guides through
  group registration (admin or regular), and handles channel-specific auth setup.
  Triggers on "add channel", "add channel group", "register group", "add whatsapp group",
  "add telegram group", "add discord group", "new group", "connect channel".
---

# Add Channel Group

This skill adds a new group (chat) to an existing channel plugin in NanoTars. It discovers which channel plugins are installed, presents them to the user, and walks through group registration — including whether the group should be the admin (main) channel or a regular group.

This is NOT for creating new channel plugins from scratch — use `/create-channel-plugin` for that.

All registration goes through the canonical operator surfaces (admin slash-commands and `nanotars` CLI subcommands). Skills MUST NOT touch the SQLite schema directly — the entity-model migration (2026-04) split `registered_groups` into `agent_groups` / `messaging_groups` / `messaging_group_agents`, and inlined SQL silently breaks every time the schema evolves.

## Workflow

### Step 1: Discover Available Channels

Scan for installed channel plugins:

```bash
ls -d plugins/channels/*/plugin.json 2>/dev/null
```

For each found plugin, read its `plugin.json` to get the name and description.

To see what groups are already registered (and on which channels), tell the user:

> "From your main chat, send `/list-groups`. The bot will reply with all registered agent groups grouped by channel — that's how we'll see the current state."

If this is a brand-new install with no main chat yet, skip the `/list-groups` step — there is nothing to list. Proceed to Step 2.

If only one channel plugin is installed, skip the channel-selection prompt and proceed directly.

If NO channel plugins are found:

> "No channel plugins are installed. Use `/create-channel-plugin` to create one, or `/add-channel-telegram` to install Telegram."

### Step 2: Determine Group Type (Smart Defaults)

Before asking the user, figure out the current state. Ask the operator to run `/list-groups` from their main chat and paste the output, OR — if no main chat exists yet — assume this is the very first group.

**Apply these rules in order:**

1. **No main group exists at all** (no main chat to run `/list-groups` from, or `/list-groups` output shows no `folder=main` entry) → This is the first group being registered. Default to admin/main. Tell the user:
   > "This will be your admin (main) channel — it gets elevated privileges and responds to all messages. I'll set it up as your primary control channel."

   Skip the group type question entirely. Use folder `main`, `requiresTrigger: false`. The bootstrap path is `nanotars pair-main` (see Step 5) because `/register-group` requires an existing admin chat to type from.

2. **Main exists, but this is the first group on a NEW channel** (`/list-groups` output has a `main` entry but no rows for the channel selected in Step 1) → Default to a personal DM, but offer the option to move admin here. Ask with `AskUserQuestion`:
   > "You already have a main (admin) channel on {other_channel}. How should I set up this {channel} chat?"

   Options:
   1. **Personal chat** (Recommended) — Responds to all your messages, isolated memory, no admin privileges. Auto-named `{channel}-dm`.
   2. **Move admin here** — This becomes the new main channel, replacing `{other_channel}`. Your old main keeps its memory but loses admin privileges.
   3. **Group chat** — Register a group channel. Requires @mention or trigger word.

   For "Personal chat": use folder `{channel}-dm`, `requiresTrigger: false`.
   For "Move admin here": use folder `main` (the registration flow replaces the existing wiring), `requiresTrigger: false`. Warn before proceeding.
   For "Group chat": ask for folder name, default `requiresTrigger: true`.

3. **Channel already has groups registered** (`/list-groups` output has rows for the selected channel) → This is an additional group. NOW ask the full question:

   > "You already have groups on {channel}. What kind of group do you want to add?"

   Options:
   1. **Regular group** — A group chat. Requires @mention or trigger word to activate the assistant.
   2. **Solo/DM chat** — A private conversation for someone else (1:1 with the bot).
   3. **Admin channel (main)** — Replace your current main group with this one.

   If they pick "Admin channel (main)", warn:
   > "You already have a main group: `{name}` on `{channel}`. Registering a new one will replace it. Continue?"

   For "Regular group" or "Solo/DM", ask for a folder name:
   > "What should I call this group's folder? This is used for isolated storage. Examples: `family`, `work-team`, `friend-alice`"

   Suggest a name based on the chat name if known.

### Step 3: Identify the Target Chat

The pairing-code flow (Step 5) doesn't need a JID up front — the operator just sends the code from the chat they want to register, and the host's inbound interceptor figures out which chat that is. So in most cases, you can skip JID-hunting entirely.

The only thing you need before Step 5 is confidence that the target chat actually exists and the bot is present in it.

#### WhatsApp Groups

> "Make sure the bot is added to the WhatsApp group you want to register. After WhatsApp is authenticated (`nanotars auth whatsapp`), you can also run `/nanotars-groups` — it queries the live Baileys connection's `groupFetchAllParticipating()` and lists every group the bot can see."

For WhatsApp DMs: just message the bot's number from your phone. The pairing-code flow will pick it up.

#### Telegram Chats

> "Add the bot to the Telegram group, or open a DM with it. The pairing-code flow works in either — no chat-id lookup needed."

#### Discord / Slack / Other Channels

> "Make sure the bot is in the target channel. The pairing-code flow is channel-agnostic — once the bot is present, it can claim the chat."

If the operator specifically wants the JID for some other reason (logging, manual debugging), see the "Quick Reference: JID Formats" table at the bottom of this file.

### Step 4: Set the Trigger

Ask about the trigger pattern:

> "How should the assistant be activated in this group?"

Options:
1. **Respond to all messages** (no trigger needed) — Best for admin/main and solo DMs. Sets `requiresTrigger: false`.
2. **Require @mention** (e.g., `@TARS`) — Default for groups. Sets `requiresTrigger: true` with trigger `@{ASSISTANT_NAME}`.
3. **Custom trigger** — A different trigger word or pattern.

For admin/main groups, default to "Respond to all messages". For regular groups, default to "Require @mention".

Note: trigger settings come from the registration flow's defaults plus per-group config. The pairing-code flow registers the group with sensible defaults (admin/main → engage always, regular → engage on trigger). Adjust afterward via group-management commands if needed.

### Step 5: Register the Group (Pairing-Code Flow)

Read the assistant name from config:

```bash
grep '^ASSISTANT_NAME=' .env | cut -d= -f2 || echo "TARS"
```

Registration always goes through the canonical pairing-code flow. **Never write to `agent_groups` / `messaging_groups` / `messaging_group_agents` directly** — direct SQL bypasses validation and idempotency in `src/db/agent-groups.ts` (`createAgentGroup` / `createMessagingGroup` / `createWiring`), and silently desyncs `schema_version`.

#### First-time main-group bootstrap (folder = `main`, no admin chat exists yet)

From the install host:

```bash
nanotars pair-main
```

This emits a 4-digit pairing code. The operator sends the code as a normal message from the chat they want to register as `main`; the channel plugin's inbound interceptor consumes the code and creates the `agent_groups` + `messaging_groups` + `messaging_group_agents` rows atomically.

`/pair-telegram` is kept as a legacy alias for `/register-group main` (zero-arg, hard-coded to the bootstrap folder) — prefer `nanotars pair-main` for the very-first-time case.

#### Subsequent groups (any folder, on any channel where the bot is present)

From a chat that already has admin privileges (typically your `main` chat), send the admin slash-command:

```
/register-group <folder>
```

For example: `/register-group work`. The host replies with a 4-digit code. The operator then sends that code as a normal message from the new chat to claim it for `<folder>`. Works on any channel (Telegram / WhatsApp / Discord / Slack / webhook) where the bot is present — pairing codes are channel-agnostic.

If the operator picked "Move admin here" in Step 2, the same flow applies: `/register-group main` from the existing admin chat, then send the code from the new chat. The wiring rewires atomically.

Both paths are idempotent and route through the same database accessors as the IPC `register_group` action — no manual SQL needed.

After the host confirms the registration, create the group's directory:

```bash
mkdir -p groups/{folder}
```

No per-group CLAUDE.md needed — the global `groups/global/CLAUDE.md` applies automatically. Group-specific personality goes in IDENTITY.md (see Step 5.5).

### Step 5.5: Group Identity

Ask the user if they want a custom personality for this group:

> "Want a custom personality for this group, or use the default TARS identity?"

Options:
1. **Use default** (Recommended) — The global IDENTITY.md personality applies automatically. No action needed.
2. **Custom personality** — Write a custom personality for this group only.

If the user picks **Use default**: do nothing. The global `groups/global/IDENTITY.md` applies as a fallback.

If the user picks **Custom personality**: ask them to describe the personality they want, then write it to `groups/{folder}/IDENTITY.md`. The per-group file takes priority over the global one.

**Important**: Do NOT create an IDENTITY.md file when the user picks the default option. The fallback mechanism handles it.

### Step 6: Channel-Specific Auth (if needed)

Check if the channel is already authenticated:

For WhatsApp:
```bash
ls data/channels/whatsapp/auth/creds.json 2>/dev/null && echo "AUTHENTICATED" || echo "NEEDS_AUTH"
```

If not authenticated, guide through the channel's auth flow:

> "This channel needs authentication first. Let me run the auth setup."

For WhatsApp:
```bash
nanotars auth whatsapp
```

Fallback for older installs without the `auth` subcommand:
```bash
node plugins/channels/whatsapp/auth.js
```

For other channels, check if they have an `auth.js`:
```bash
[ -f plugins/channels/{name}/auth.js ] && echo "HAS_AUTH" || echo "NO_AUTH"
```

If they have `auth.js`, run it (preferring `nanotars auth <channel>` if the wrapper exposes the channel). If not, check for credential env vars and guide the user through adding them to `.env`.

Auth must complete *before* the pairing-code flow in Step 5, because the bot has to actually be online in the channel to receive the operator's code message.

### Step 7: Restart and Verify

```bash
npm run build && nanotars restart
```

Wait a few seconds, then verify:

```bash
# Check service is running
sleep 3
nanotars status
```

Then confirm the registration landed:

> "From your main chat, send `/list-groups`. You should see a row with `folder={folder}` on `channel={channel}`. If it's there, you're done."

Check logs for channel connection:

```bash
tail -20 logs/nanotars.log | grep -i '{channel}'
```

Tell the user:

> "Done! The `{name}` group is registered on `{channel}`.
>
> **To test**: Send a message in the group{trigger_instruction}.
>
> **To customize**: Edit `groups/{folder}/CLAUDE.md` to give the assistant context about this group.
>
> **Agent Teams**: Want specialized subagents (research, dev, coordinator) in this group? Run `/nanotars-add-agent` to create persistent agent definitions."

## State Detection

Before starting, always check the current state to avoid redundant work:

```bash
# What channels are installed?
for d in plugins/channels/*/plugin.json; do
  echo "$(dirname $d): $(cat $d | python3 -c 'import sys,json; print(json.load(sys.stdin).get(\"name\",\"unknown\"))' 2>/dev/null || echo 'unknown')"
done

# Is the service running?
nanotars status
```

For registered-group state and main-group existence, use the operator surface:

> "Send `/list-groups` from your main chat (or any chat with admin privileges) and paste the output. That's the source of truth — it tells me which folders exist, which channels they're wired to, and which one is `main`."

If no main chat exists yet, that's itself a signal: this install is pre-bootstrap and `nanotars pair-main` is the next move.

## Multi-Instance Support

A user might want multiple groups on the same channel (e.g., two WhatsApp groups — one admin, one for a family chat). This is fully supported:

- Each group has a unique platform identifier (different WhatsApp group = different JID)
- Each group has a unique folder name (different isolated storage)
- The `channel_type` column on `messaging_groups` tracks which channel plugin owns each chat
- Plugin scoping (`channels` and `groups` fields in plugin.json) controls which plugins are injected into which group's container

Run `/list-groups` to see the full picture.

## Error Handling

- **Channel not connected**: If the channel plugin exists but isn't connected (e.g., WhatsApp auth expired), guide through re-authentication before registering — the pairing-code flow can't complete if the bot isn't online to receive the code message.
- **Duplicate folder**: If the user picks a folder name that already exists, `/register-group` will reject it. Suggest alternatives.
- **Pairing code never claimed**: Codes have a short TTL (see `src/command-gate.ts`). If it expires, just re-issue with `/register-group <folder>`.
- **Service not running**: If `nanotars status` shows stopped, run `nanotars start` before attempting registration.
- **`/list-groups` returns nothing**: Either no groups are registered yet, or the chat you're typing from isn't recognized as admin. For first-ever bootstrap, use `nanotars pair-main`.

## Quick Reference: JID Formats

You don't need these for the pairing-code flow — included only for debugging or log-grepping.

| Channel | Groups | DMs | Example |
|---------|--------|-----|---------|
| WhatsApp | `{id}@g.us` | `{phone}@s.whatsapp.net` | `120363336345536173@g.us` |
| Telegram | `tg:-{id}` | `tg:{id}` | `tg:-1001234567890` |
| Discord | `dc:{channel_id}` | `dc:{dm_id}` | `dc:123456789012345678` |
| Slack | `slack:{channel_id}` | `slack:{dm_id}` | `slack:C01ABCDEF` |
