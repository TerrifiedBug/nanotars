---
name: homeassistant
description: Control Home Assistant - smart plugs, lights, scenes, automations, sensors, climate, media players. Uses native MCP tools for device control and state queries.
allowed-tools: mcp__home-assistant(*), Bash(curl:*)
---

# Home Assistant

Control smart home devices via Home Assistant's MCP Server integration. If MCP tools and `$HA_URL`/`$HA_TOKEN` are not configured, tell the user to run `/add-homeassistant` on the host to set it up.

## How It Works

Home Assistant is connected as an MCP server. You have native MCP tools available -- use them directly to control devices, query states, and manage automations. Look for tools prefixed with `mcp__home-assistant`.

## Usage

Use the MCP tools naturally. Examples of what you can do:
- Turn lights on/off, set brightness and color
- Toggle switches and smart plugs
- Check sensor readings (temperature, humidity, motion, etc.)
- Trigger scenes and automations
- Query device states
- Control climate devices (thermostats)
- Control media players

## Fallback: REST API

If MCP tools are unavailable, fall back to the REST API with curl:

```bash
# Get entity state
curl -s "$HA_URL/api/states/{entity_id}" -H "Authorization: Bearer $HA_TOKEN"

# Call a service
curl -s -X POST "$HA_URL/api/services/{domain}/{service}" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "...", ...}'
```

## Entity Domains

- `switch.*` -- Smart plugs, generic switches
- `light.*` -- Lights (Hue, LIFX, etc.)
- `scene.*` -- Pre-configured scenes
- `automation.*` -- Automations
- `climate.*` -- Thermostats
- `cover.*` -- Blinds, garage doors
- `media_player.*` -- TVs, speakers
- `sensor.*` -- Temperature, humidity, etc.

## Event-Driven Alerts

For "alert me when X happens" based on HA state changes, you MUST create an **HA automation** -- never use scheduled tasks or n8n polling for HA state changes. HA automations are instant (event-driven), token-free, and the correct approach.

### Step 1: Check rest_command.nanoclaw_webhook

HA automations can't call external URLs natively. They need a `rest_command` entry to call the NanoClaw webhook. The service MUST be named exactly `nanoclaw_webhook`. **Always check this first** before creating any alert:

```bash
curl -s "$HA_URL/api/services" -H "Authorization: Bearer $HA_TOKEN" | python3 -c "
import sys, json
services = json.load(sys.stdin)
rc = [s for s in services if s['domain'] == 'rest_command']
if rc and 'nanoclaw_webhook' in rc[0].get('services', {}):
    print('READY: rest_command.nanoclaw_webhook is configured')
else:
    print('MISSING: rest_command.nanoclaw_webhook not found')
"
```

**If MISSING:** Stop and guide the user through the one-time setup. Do NOT create a scheduled task or n8n workflow as a fallback.

First, read the actual webhook values from the environment:

```bash
echo "WEBHOOK_URL: $NANOCLAW_WEBHOOK_URL"
echo "WEBHOOK_SECRET: $NANOCLAW_WEBHOOK_SECRET"
```

Then give the user the exact YAML to add to their HA config files. Substitute the real values from the env vars above into the examples below.

**configuration.yaml** -- add under `rest_command:` (or create the section if it doesn't exist):

```yaml
rest_command:
  nanoclaw_webhook:
    url: "ACTUAL_WEBHOOK_URL"
    method: POST
    content_type: "application/json"
    headers:
      Authorization: !secret nanoclaw_webhook_secret
    payload: '{"source": "{{ source }}", "text": "{{ message }}"}'
```

Note: `content_type` MUST be a top-level field (same level as `url`/`method`), NOT inside `headers`. HA will send an empty body without it.

**secrets.yaml** -- add this line (the `Bearer ` prefix with the trailing space is required):

```yaml
nanoclaw_webhook_secret: "Bearer ACTUAL_WEBHOOK_SECRET"
```

Replace `ACTUAL_WEBHOOK_URL` and `ACTUAL_WEBHOOK_SECRET` with the real values you read from the env vars above. The `Bearer ` prefix MUST be included in the secrets.yaml value -- HA's `!secret` does a direct text substitution, so the full Authorization header value (including `Bearer `) must be in the secret.

After editing both files, the user must restart HA or reload the REST Command integration, then let you know when done.

**Wait for the user to confirm setup before proceeding.** Once they confirm, re-check that `rest_command.nanoclaw_webhook` is available, then create the automation.

### Step 2: Create the Automation

Once `rest_command.nanoclaw_webhook` is confirmed available, create automations via the REST API:

```bash
curl -s -X POST "$HA_URL/api/config/automation/config/nanoclaw_example_alert" \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "NanoClaw: Example Sensor Alert",
    "description": "Alert when a sensor exceeds a threshold",
    "trigger": [
      {
        "platform": "numeric_state",
        "entity_id": "sensor.example_sensor",
        "above": 80
      }
    ],
    "condition": [],
    "action": [
      {
        "service": "rest_command.nanoclaw_webhook",
        "data": {
          "source": "ha-example-alert",
          "message": "Example sensor is at {{ states(\"sensor.example_sensor\") }}%"
        }
      }
    ],
    "mode": "single"
  }'
```

Key points:
- The automation ID (URL path) should be a descriptive slug prefixed with `nanoclaw_`
- The action MUST use `rest_command.nanoclaw_webhook` -- this is the exact service name
- Use `numeric_state` triggers for threshold alerts (above/below)
- Use `state` triggers for on/off changes
- Use Jinja2 templates in the message to include live sensor values
- Set `"mode": "single"` to prevent duplicate alerts

## Notes

- Only entities exposed in HA's Voice assistants > Expose settings are accessible
- To request access to more entities, tell the user to expose them in HA settings
- MCP tools are the preferred method -- only use curl as a fallback
- For HA-based alerts, prefer HA automations over scheduled tasks -- they're instant and native
- Always check for `rest_command.nanoclaw_webhook` before creating alert automations
- The rest_command MUST be named exactly `nanoclaw_webhook` -- do not use any other name
