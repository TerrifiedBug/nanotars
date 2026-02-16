---
name: add-parallel
description: Add Parallel AI web research to NanoClaw via MCP Servers. Enables quick web search and deep research tasks with citations. Guides through API key setup. Triggers on "add parallel", "parallel ai", "parallel setup", "web research".
---

# Add Parallel AI (MCP Servers)

Configures Parallel AI web research for agent containers using their HTTP-based MCP servers. Agents get tools for quick web search and deep research tasks.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- Parallel AI API key from https://platform.parallel.ai

## Step 1: Check Existing Configuration

```bash
grep "^PARALLEL_API_KEY=" .env 2>/dev/null && echo "KEY_SET" || echo "KEY_MISSING"
[ -d plugins/parallel ] && echo "PLUGIN_EXISTS" || echo "PLUGIN_MISSING"
```

If already configured, ask the user if they want to reconfigure or just verify.

## Step 2: Get API Key

Ask the user:

> Do you have a Parallel AI API key, or should I help you get one?

**If they need one:**

> 1. Go to https://platform.parallel.ai
> 2. Sign up or log in
> 3. Navigate to API Keys section
> 4. Create a new API key
> 5. Copy the key and paste it here

Wait for the API key.

## Step 3: Save to .env

```bash
sed -i '/^PARALLEL_API_KEY=/d' .env
echo "PARALLEL_API_KEY=THE_KEY_HERE" >> .env
```

Sync to container environment:

```bash
cp .env data/env/env
```

## Step 4: Install Plugin

```bash
cp -r .claude/skills/add-parallel/files/ plugins/parallel/
```

## Step 5: Build and Restart

```bash
npm run build
systemctl restart nanoclaw  # or launchctl on macOS
```

## Verify

Send a message in your channel like:
- "What's the latest news about AI?"
- "Search for recent developments in quantum computing"

The agent now has Parallel AI search and deep research tools. Quick search is used freely; deep research asks for permission first.

## Troubleshooting

- **Agent says "no Parallel tools available"**: Check that `plugins/parallel/mcp.json` has the MCP server entries and `PARALLEL_API_KEY` is in `.env`
- **401 Unauthorized**: API key is invalid -- regenerate at https://platform.parallel.ai
- **Connection timeout**: Parallel AI servers may be down -- check https://status.parallel.ai
- **Deep research tasks never complete**: Check that the scheduler is running and the polling task was created

## Remove

1. `rm -rf plugins/parallel/`
2. Remove env var from .env:
   ```bash
   sed -i '/^PARALLEL_API_KEY=/d' .env
   cp .env data/env/env
   ```
3. Rebuild and restart
