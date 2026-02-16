---
name: add-telegram-swarm
description: Add Agent Swarm (Teams) support to Telegram. Each subagent gets its own bot identity in the group. Requires Telegram channel to be set up first (use /add-telegram). Triggers on "agent swarm", "agent teams telegram", "telegram swarm", "bot pool".
---

# Add Agent Swarm to Telegram

This skill adds Agent Teams (Swarm) support to an existing Telegram channel. Each subagent in a team gets its own bot identity in the Telegram group, so users can visually distinguish which agent is speaking.

**Prerequisite**: Telegram must already be set up via the `/add-telegram` skill. If `plugins/channels/telegram/` does not exist or `TELEGRAM_BOT_TOKEN` is not configured, tell the user to run `/add-telegram` first.

## How It Works

- The **main bot** receives messages and sends lead agent responses (already set up)
- **Pool bots** are send-only — each gets a Grammy `Api` instance (no polling)
- When a subagent calls `send_message` with a `sender` parameter, the host assigns a pool bot and renames it to match the sender's role
- Messages appear in Telegram from different bot identities

The swarm pool is a separate module (`pool.js`) that gets installed alongside the Telegram plugin. The base plugin dynamically loads it when `TELEGRAM_BOT_POOL` is set.

## Step 0: Install Pool Module

Copy `pool.js` into the Telegram plugin directory:

```bash
cp .claude/skills/add-telegram-swarm/files/pool.js plugins/channels/telegram/pool.js
```

If `plugins/channels/telegram/` does not exist, the user needs to run `/add-telegram` first.

## Step 1: Create Pool Bots

Tell the user:

> I need you to create 3-5 Telegram bots to use as the agent pool. These will be renamed dynamically to match agent roles.
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` for each bot:
>    - Give them any placeholder name (e.g., "Bot 1", "Bot 2")
>    - Usernames like `myproject_swarm_1_bot`, `myproject_swarm_2_bot`, etc.
> 3. Copy all the tokens
> 4. Add all bots to your Telegram group(s) where you want agent teams

Wait for user to provide the tokens.

## Step 2: Disable Group Privacy for Pool Bots

Tell the user:

> For each pool bot in `@BotFather`:
> 1. Send `/mybots` and select the bot
> 2. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> Then add all pool bots to your Telegram group(s).

## Step 3: Set Environment Variable

Add pool tokens to `.env`:

```bash
TELEGRAM_BOT_POOL=TOKEN1,TOKEN2,TOKEN3
```

Sync to container environment:

```bash
cp .env data/env/env
```

## Step 4: Add Agent Teams Instructions to Group CLAUDE.md

For each Telegram group that will use agent teams, read the existing `groups/{folder}/CLAUDE.md` and add the Agent Teams section. Do NOT replace existing content — append this:

```markdown
## Agent Teams

When creating a team to tackle a complex task, follow these rules:

### CRITICAL: Follow the user's prompt exactly

Create *exactly* the team the user asked for — same number of agents, same roles, same names. Do NOT add extra agents, rename roles, or use generic names like "Researcher 1". If the user says "a marine biologist, a physicist, and Alexander Hamilton", create exactly those three agents with those exact names.

### Team member instructions

Each team member MUST be instructed to:

1. *Share progress in the group* via `mcp__nanoclaw__send_message` with a `sender` parameter matching their exact role/character name (e.g., `sender: "Marine Biologist"` or `sender: "Alexander Hamilton"`). This makes their messages appear from a dedicated bot in the Telegram group.
2. *Also communicate with teammates* via `SendMessage` as normal for coordination.
3. Keep group messages *short* — 2-4 sentences max per message. Break longer content into multiple `send_message` calls. No walls of text.
4. Use the `sender` parameter consistently — always the same name so the bot identity stays stable.
5. NEVER use markdown formatting. Use ONLY WhatsApp/Telegram formatting: single *asterisks* for bold (NOT **double**), _underscores_ for italic, • for bullets, ```backticks``` for code. No ## headings, no [links](url), no **double asterisks**.

### Lead agent behavior

As the lead agent who created the team:

- You do NOT need to react to or relay every teammate message. The user sees those directly from the teammate bots.
- Send your own messages only to comment, share thoughts, synthesize, or direct the team.
- When processing an internal update from a teammate that doesn't need a user-facing response, wrap your *entire* output in `<internal>` tags.
- Focus on high-level coordination and the final synthesis.
```

## Step 5: Restart Service

Restart NanoClaw so the plugin picks up the new pool tokens.

Check logs for pool initialization:

```bash
grep -i "pool bot" logs/nanoclaw.log
```

You should see "Pool bot initialized" for each token and "Telegram bot pool ready".

## Architecture Notes

- Pool bots use Grammy's `Api` class — lightweight, no polling, just send
- Bot names are set via `setMyName` — changes are global to the bot, not per-chat
- A 2-second delay after `setMyName` allows Telegram to propagate the name change
- Sender-to-bot mapping is stable (keyed by sender name)
- Mapping resets on service restart — pool bots get reassigned fresh
- If pool runs out, bots are reused (round-robin wraps)

## Troubleshooting

### Pool bots not sending messages

1. Verify tokens: `curl -s "https://api.telegram.org/botTOKEN/getMe"`
2. Check pool initialized: `grep "Pool bot" logs/nanoclaw.log`
3. Ensure all pool bots are members of the Telegram group
4. Check Group Privacy is disabled for each pool bot

### Bot names not updating

Telegram caches bot names client-side. The 2-second delay after `setMyName` helps, but users may need to restart their Telegram client to see updated names.

### Subagents not using send_message

Check the group's `CLAUDE.md` has the Agent Teams instructions. The lead agent reads this when creating teammates and must include the `send_message` + `sender` instructions in each teammate's prompt.

## Removal

To remove Agent Swarm support while keeping basic Telegram:

1. Remove `pool.js`: `rm plugins/channels/telegram/pool.js`
2. Remove `TELEGRAM_BOT_POOL` from `.env`
3. Sync: `cp .env data/env/env`
4. Remove Agent Teams section from group CLAUDE.md files
5. Restart NanoClaw
