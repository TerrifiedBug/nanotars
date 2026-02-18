---
name: add-skill-homeassistant
description: Add Home Assistant integration to NanoClaw via official MCP Server. Enables agents to control smart home devices, query states, and manage automations. Guides through HA MCP Server setup and configures environment. Triggers on "add home assistant", "add homeassistant", "home assistant setup", "smart home".
---

# Add Home Assistant (MCP Server)

Configures Home Assistant integration for agent containers using HA's official MCP Server integration. Agents get native MCP tools to control devices, query states, and manage automations.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- Home Assistant instance accessible from this server (local network or remote)
- Home Assistant 2025.2 or newer (MCP Server integration was introduced in 2025.2)

## Step 1: Check Existing Configuration

```bash
grep "^HA_URL=" .env 2>/dev/null && echo "HA_URL_SET" || echo "HA_URL_MISSING"
grep "^HA_TOKEN=" .env 2>/dev/null && echo "HA_TOKEN_SET" || echo "HA_TOKEN_MISSING"
[ -d plugins/homeassistant ] && echo "PLUGIN_EXISTS" || echo "PLUGIN_MISSING"
```

If already configured, ask the user if they want to reconfigure or just verify the setup.

## Step 2: Enable MCP Server Integration in Home Assistant

Tell the user:

> **Enable the MCP Server integration in Home Assistant:**
> 1. Open your Home Assistant web UI
> 2. Go to **Settings > Devices & Services**
> 3. Click **+ Add Integration**
> 4. Search for **"Model Context Protocol Server"** and add it
> 5. Once added, it exposes an MCP endpoint at `/api/mcp`
>
> **Expose entities to the agent:**
> 1. Go to **Settings > Voice assistants**
> 2. Click **Expose** tab
> 3. Select entities you want the agent to control (lights, switches, sensors, etc.)
> 4. Only exposed entities will be available -- start conservative, expand later

Ask the user to confirm they've done this before proceeding.

## Step 3: Gather Connection Details

Collect from the user:

1. **Home Assistant URL** -- e.g., `http://192.168.1.100:8123` or `https://ha.example.com`
   - Must be reachable from this server (not just from the user's browser)
   - No trailing slash

2. **Long-Lived Access Token** -- created in HA:
   > To create a long-lived access token:
   > 1. In Home Assistant, click your profile icon (bottom-left)
   > 2. Scroll to **Long-Lived Access Tokens**
   > 3. Click **Create Token**, name it "NanoClaw"
   > 4. Copy the token immediately (it's only shown once)

## Step 4: Test Connection

Verify the HA instance is reachable and the token works:

```bash
curl -sf -o /dev/null -w "%{http_code}" \
  "$HA_URL/api/" \
  -H "Authorization: Bearer $HA_TOKEN"
```

Expected: `200`. If it fails:
- **Connection refused / timeout**: HA URL is wrong or not reachable from this server
- **401**: Token is invalid -- regenerate it
- **404**: URL may need a port (`:8123`) or the path is wrong

Then test that the MCP endpoint exists:

```bash
curl -sf -o /dev/null -w "%{http_code}" \
  "$HA_URL/api/mcp" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"nanoclaw","version":"1.0"}}}'
```

Expected: `200`. If `404`, the MCP Server integration is not enabled in HA.

## Step 5: Save to .env

```bash
# Remove existing lines if present
sed -i '/^HA_URL=/d' .env
sed -i '/^HA_TOKEN=/d' .env

# Add the new configuration
echo "HA_URL=THE_URL_HERE" >> .env
echo "HA_TOKEN=THE_TOKEN_HERE" >> .env
```

## Step 6: Install Plugin

```bash
cp -r .claude/skills/add-skill-homeassistant/files/ plugins/homeassistant/
```

## Step 7: Build and Restart

```bash
npm run build
systemctl restart nanoclaw  # or launchctl on macOS
```

## Verify

Send a WhatsApp message like:
- "What lights are on?"
- "Turn off the living room lights"
- "What's the temperature in the bedroom?"

The agent now has native MCP tools for Home Assistant. Only the entities you exposed in Step 2 are accessible.

## Exposing More Entities

To give the agent access to more devices:
1. Go to HA > **Settings > Voice assistants > Expose**
2. Toggle on additional entities
3. No rebuild needed -- changes are reflected immediately via MCP

## Troubleshooting

- **Agent says "no MCP tools available"**: Check that `plugins/homeassistant/mcp.json` has the `home-assistant` entry, HA MCP Server integration is enabled, and entities are exposed
- **Connection errors in agent**: Verify HA is reachable from this server (`curl $HA_URL/api/`), not just from the user's local network
- **Agent can't control a device**: The entity isn't exposed -- go to HA Voice assistants > Expose and toggle it on
- **"401 Unauthorized"**: Long-lived access token is invalid -- regenerate in HA profile settings
- **"404 Not Found" on /api/mcp**: MCP Server integration is not enabled in HA -- add it via Settings > Devices & Services

## Remove

1. `rm -rf plugins/homeassistant/`
2. Remove env vars from .env:
   ```bash
   sed -i '/^HA_URL=/d' .env
   sed -i '/^HA_TOKEN=/d' .env
   ```
3. Rebuild and restart
4. Optionally disable the MCP Server integration in HA and revoke the access token
