---
name: add-skill-commute
description: Add travel time and commute lookup to NanoClaw agents using Waze live traffic data. No API key needed. Triggers on "add commute", "commute setup", "travel time", "waze".
---

# Add Commute

Adds live traffic-based travel time lookups using the Waze routing API (no API key required).

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Install

1. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-commute/files/ plugins/commute/
   ```
2. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Ask the agent "how long to drive from Oxford to London?" -- it should use the Waze API to get live traffic times.

## Remove

1. ```bash
   rm -rf plugins/commute/
   ```
2. Rebuild and restart
