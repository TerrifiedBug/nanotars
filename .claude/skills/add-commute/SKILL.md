---
name: add-commute
description: Add travel time and commute lookup to NanoClaw agents using Waze live traffic data. No API key needed. Triggers on "add commute", "commute setup", "travel time", "waze".
---

# Add Commute

Adds live traffic-based travel time lookups using the Waze routing API (no API key required).

## Prerequisites

- NanoClaw must be set up and running (`/setup`)

## Install

1. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-commute/files/ plugins/commute/
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
