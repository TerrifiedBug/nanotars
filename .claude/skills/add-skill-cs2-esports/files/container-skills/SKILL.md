---
name: cs2-esports
description: Check upcoming CS2 (Counter-Strike 2) esports matches. Use when asked about CS matches, esports schedule, or when building digests that include esports.
allowed-tools: Bash(python3:*)
---

# CS2 Esports Matches

Fetch upcoming Counter-Strike 2 matches from Liquipedia via the esports-ics feed.

## Usage

```bash
python3 /workspace/.claude/skills/cs2-esports/scripts/cs2-matches.py [days]
```

- Default: next 2 days (today + tomorrow)
- For a week ahead: `python3 /workspace/.claude/skills/cs2-esports/scripts/cs2-matches.py 7`

## For Digests

Use the default (2 days) for morning/evening digests. Format for WhatsApp:

- Use `*bold*` for tournament names
- Use `•` bullets for each match
- Group matches by tournament
- Show times in UK time (UTC or BST depending on season)
- If no matches, say "No CS2 matches today/tomorrow"

## Notes

- Data comes from Liquipedia via esports-ics — free, no API key
- Match times are scheduled start times — actual times may shift
- The feed updates frequently but is not real-time
