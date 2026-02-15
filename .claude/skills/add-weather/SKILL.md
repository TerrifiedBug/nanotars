---
name: add-weather
description: Add weather lookup capability to NanoClaw agents. Uses free wttr.in and Open-Meteo APIs — no API key needed. Triggers on "add weather", "weather setup", "weather skill".
---

# Add Weather

Adds weather forecast capability to NanoClaw agents using free public APIs (no API key required).

## Prerequisites

- NanoClaw must be set up and running (`/setup`)

## Install

1. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-weather/files/ plugins/weather/
   ```
2. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Ask the agent about the weather in any city.

## Remove

1. ```bash
   rm -rf plugins/weather/
   ```
2. Rebuild and restart
