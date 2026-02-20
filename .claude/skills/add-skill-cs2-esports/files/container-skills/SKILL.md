---
name: cs2-esports
description: Check upcoming CS2 (Counter-Strike 2) esports matches. Use when asked about CS matches, esports schedule, or when building digests that include esports.
allowed-tools: Bash(python3:*)
---

# CS2 Esports Matches

Fetch upcoming Counter-Strike 2 matches from Liquipedia via the esports-ics feed.

## Usage

```bash
python3 /workspace/.claude/skills/cs2-esports/scripts/cs2-matches.py [days] [options]
```

**Arguments:**
- `days` — Number of days to look ahead (default: 1 = today only)

**Options:**
- `--team REGEX` / `-t REGEX` — Filter by team name (e.g. `NAVI`, `MOUZ|Vitality`)
- `--competition REGEX` / `-c REGEX` — Filter by competition (e.g. `PGL`, `IEM|BLAST`)
- `--no-tbd` — Hide matches with TBD/unannounced teams

**Examples:**
```bash
# Today's matches
python3 /workspace/.claude/skills/cs2-esports/scripts/cs2-matches.py

# This week's matches
python3 /workspace/.claude/skills/cs2-esports/scripts/cs2-matches.py 7

# NAVI matches in the next 30 days
python3 /workspace/.claude/skills/cs2-esports/scripts/cs2-matches.py 30 --team NAVI

# Only PGL Major matches, no TBD
python3 /workspace/.claude/skills/cs2-esports/scripts/cs2-matches.py 7 -c PGL --no-tbd
```

## For Digests

Use default (1 day) for evening digests, `2` for morning digests (today + tomorrow). Format for WhatsApp:

- Use `*bold*` for tournament names
- Use `•` bullets for each match
- Group matches by tournament
- Show times in UK time (UTC or BST depending on season)
- If no matches, say "No CS2 matches today/tomorrow"

## Notes

- Data comes from Liquipedia via esports-ics — free, no API key
- Match times are scheduled start times — actual times may shift
- Team/competition filters use regex and are applied server-side
- The feed updates frequently but is not real-time
