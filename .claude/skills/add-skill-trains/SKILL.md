---
name: add-skill-trains
description: Add UK train departure/arrival information to NanoClaw via National Rail Darwin API. Guides through free API token registration and configures environment. Triggers on "add trains", "train times", "national rail", "uk trains setup".
---

# Add UK Trains

Configures live UK train departure and arrival data for agent containers using the National Rail Darwin API.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Step 1: Check Existing Configuration

```bash
grep "^NATIONAL_RAIL_TOKEN=" .env 2>/dev/null && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
```

If `ALREADY_CONFIGURED`, ask the user if they want to reconfigure or test the existing token.

## Step 2: Register for Darwin API Token

Tell the user:

> You need a free Darwin API token from National Rail. Here's how:
>
> 1. Go to https://realtime.nationalrail.co.uk/OpenLDBWSRegistration/
> 2. Fill in the registration form (name, email, reason: "personal use")
> 3. You'll receive an email with your API token
> 4. Paste the token here when ready

Wait for the user to provide the token.

## Step 3: Save to .env

```bash
# Remove existing line if present
sed -i '/^NATIONAL_RAIL_TOKEN=/d' .env

# Add the new token
echo 'NATIONAL_RAIL_TOKEN=THE_TOKEN_HERE' >> .env
```

## Step 4: Install Plugin

```bash
cp -r .claude/skills/add-skill-trains/files/ plugins/trains/
chmod +x plugins/trains/container-skills/scripts/trains.py
```

## Step 5: Test the Token

```bash
source .env
[ -n "$NATIONAL_RAIL_TOKEN" ] && echo "OK - token is set (${#NATIONAL_RAIL_TOKEN} chars)" || echo "FAILED - NATIONAL_RAIL_TOKEN is empty"
```

For a deeper test (optional -- the Darwin API can be slow):
```bash
source .env
python3 plugins/trains/container-skills/scripts/trains.py departures PAD --rows 3
```

If it fails:
- **HTTP 401**: Token is invalid or not yet activated (can take a few minutes after registration)
- **Connection timeout**: Network issue, try again

## Step 6: Build and Restart

```bash
npm run build
systemctl restart nanoclaw  # or launchctl on macOS
```

## Verify

Send a WhatsApp message like "when's the next train from Didcot to Paddington?"

## Remove

1. `rm -rf plugins/trains/`
2. Remove env vars from .env:
   ```bash
   sed -i '/^NATIONAL_RAIL_TOKEN=/d' .env
   ```
3. Rebuild and restart
