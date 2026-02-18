---
name: add-skill-stocks
description: Add stock price and financial data lookups via Yahoo Finance. Triggers on stock price questions, ticker lookups, market data requests.
---

# Add Stock Lookup

Adds stock price and financial data lookups using Yahoo Finance's free API. No API key needed.

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

## Install

1. Check current state:
   ```bash
   [ -d plugins/stocks ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Verify.

2. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-stocks/files/ plugins/stocks/
   ```

3. Rebuild and restart:
   ```bash
   npm run build
   sudo systemctl restart nanoclaw  # or: launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
   ```

## Verify

Check that the plugin loaded:

```bash
grep -i "stocks" logs/nanoclaw.log | tail -5
```

Test from a chat by asking: "What's the current price of AAPL?"

## Usage Examples

- "What's Apple's stock price?"
- "Compare MSFT and GOOG prices"
- "What's Tesla's P/E ratio and 52-week range?"
- "Show me Amazon's stock performance this year"

## How It Works

The agent uses curl to query Yahoo Finance's free chart API endpoint. No API key or authentication is needed. The skill teaches the agent the correct endpoints, parameters, and response parsing with jq.

## Troubleshooting

- **Request blocked / empty response:** Yahoo occasionally rate-limits. The agent will retry automatically. If persistent, the `User-Agent` header may need updating.
- **Ticker not found:** Check the symbol on Yahoo Finance — some international stocks need exchange suffixes (e.g., `.L` for London, `.TO` for Toronto).

## Remove

1. `rm -rf plugins/stocks/`
2. Rebuild and restart.
