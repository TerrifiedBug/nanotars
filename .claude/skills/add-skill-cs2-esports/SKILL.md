---
name: add-skill-cs2-esports
description: Add CS2 esports match tracking to NanoClaw. Shows upcoming Counter-Strike 2 matches from Liquipedia. Triggers on "cs2 matches", "esports schedule", "counter-strike".
---

# Add CS2 Esports

Adds CS2 esports match tracking. Agents can check upcoming Counter-Strike 2 matches (Majors and S-tier tournaments) from Liquipedia. No API key needed.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- No API keys or credentials required

## Install

1. Check current state:
   ```bash
   [ -d plugins/cs2-esports ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Verify.

2. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-cs2-esports/files/ plugins/cs2-esports/
   ```

3. Rebuild and restart:
   ```bash
   npm run build
   sudo systemctl restart nanoclaw
   ```

## Verify

Test that the ICS feed is reachable and returns CS2 match data:

```bash
curl -s "https://ics.snwfdhmp.com/matches.ics?url=https%3A%2F%2Fliquipedia.net%2Fcounterstrike%2FLiquipedia%3AMatches" | head -5
```

Should show `BEGIN:VCALENDAR` and ICS header lines.

## Usage Examples

- "Are there any CS2 matches today?"
- "What's the CS2 schedule this week?"
- Include in morning/evening digests: the agent will check for upcoming matches automatically

## How It Works

The agent curls a public ICS feed from esports-ics (backed by Liquipedia data), parses VEVENT entries with Python, and filters to S-tier tournaments (PGL Major, IEM, BLAST Premier, ESL Pro League). No API key or authentication needed.

## Remove

1. `rm -rf plugins/cs2-esports/`
2. Rebuild and restart.
