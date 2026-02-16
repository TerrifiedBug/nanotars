---
name: add-skill-freshrss
description: Add FreshRSS feed reader integration to NanoClaw. Connects agents to a self-hosted FreshRSS instance for news summaries, unread articles, feed management, and daily digests. Guides through API key setup and configures environment. Triggers on "add freshrss", "freshrss setup", "rss feeds", "add rss".
---

# Add FreshRSS

Configures RSS feed access for agent containers using a self-hosted FreshRSS instance and its Google Reader API.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- A self-hosted FreshRSS instance with API access enabled

## Step 1: Check Existing Configuration

```bash
grep "^FRESHRSS_URL=" .env 2>/dev/null && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
ls plugins/freshrss/plugin.json 2>/dev/null && echo "PLUGIN_EXISTS" || echo "NO_PLUGIN"
```

If `ALREADY_CONFIGURED`, ask the user if they want to reconfigure or test the existing setup.

## Step 2: Gather FreshRSS Details

Ask the user for:

1. **FreshRSS URL** -- the base URL of their instance (e.g. `https://freshrss.example.com`), no trailing slash
2. **FreshRSS username** -- the login username (e.g. `admin`, `fruity`)
3. **FreshRSS API password** -- this is NOT the web login password

Tell the user:
> To get your FreshRSS API password:
> 1. Log in to your FreshRSS instance
> 2. Go to **Settings** (gear icon) > **Profile**
> 3. Scroll to **API Management**
> 4. Set an API password if you haven't already, then click **Submit**
> 5. Copy the API password and paste it here

Wait for the user to provide all three values.

## Step 3: Save to .env

```bash
# Remove existing lines if present
sed -i '/^FRESHRSS_URL=/d' .env
sed -i '/^FRESHRSS_USER=/d' .env
sed -i '/^FRESHRSS_API_KEY=/d' .env

# Add FreshRSS credentials
echo 'FRESHRSS_URL=THE_URL_HERE' >> .env
echo 'FRESHRSS_USER=THE_USERNAME_HERE' >> .env
echo 'FRESHRSS_API_KEY=THE_API_KEY_HERE' >> .env
```

## Step 4: Install Plugin

```bash
cp -r .claude/skills/add-skill-freshrss/files/ plugins/freshrss/
```

## Step 5: Test the API Connection

```bash
source .env
AUTH=$(curl -s "$FRESHRSS_URL/api/greader.php/accounts/ClientLogin" \
  -d "Email=$FRESHRSS_USER&Passwd=$FRESHRSS_API_KEY" | grep -oP 'Auth=\K.*')

if [ -n "$AUTH" ]; then
  UNREAD=$(curl -s "$FRESHRSS_URL/api/greader.php/reader/api/0/unread-count?output=json" \
    -H "Authorization: GoogleLogin auth=$AUTH" | python3 -c "
import sys, json
r = json.load(sys.stdin)
total = sum(int(f.get('count', 0)) for f in r.get('unreadcounts', []))
print(f'OK - {total} unread articles')
")
  echo "$UNREAD"
else
  echo "FAILED - Could not authenticate. Check URL, username, and API password."
fi
```

If the test fails:
- **Empty auth token**: Wrong username or API password (not the web login password)
- **Connection refused**: Check FreshRSS URL and that the instance is running
- **404**: FreshRSS API may not be enabled -- check Settings > Authentication > Allow API access

## Step 6: Build and Restart

```bash
npm run build
systemctl restart nanoclaw  # or launchctl on macOS
```

## Verify

Send a WhatsApp message like "what's in my RSS feeds?" or "give me a news summary".

## Remove

1. `rm -rf plugins/freshrss/`
2. Remove env vars from .env:
   ```bash
   sed -i '/^FRESHRSS_URL=/d' .env
   sed -i '/^FRESHRSS_USER=/d' .env
   sed -i '/^FRESHRSS_API_KEY=/d' .env
   ```
3. Rebuild and restart
