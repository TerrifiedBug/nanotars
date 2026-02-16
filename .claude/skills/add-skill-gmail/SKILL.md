---
name: add-skill-gmail
description: Add Gmail access to NanoClaw via gog CLI (Google Workspace CLI). Agents can search, read, and send emails. Shares OAuth credentials with Google Calendar if already configured. Triggers on "add gmail", "gmail setup", "gmail integration", "email setup".
---

# Add Gmail (gog CLI)

Configures Gmail access for agent containers using the `gog` CLI, the same tool used for Google Calendar. If the user already has Calendar set up via `/add-skill-cal`, Gmail just needs the scope added.

**Mode:** Tool Mode only -- agents can read/send emails when triggered from a channel (e.g., "check my email", "send an email to..."). This is NOT a channel (emails don't trigger the agent).

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- A Google account with Gmail

## Step 1: Check Existing Configuration

```bash
which gog && echo "GOG_INSTALLED" || echo "GOG_MISSING"
grep "^GOG_KEYRING_PASSWORD=" .env 2>/dev/null && echo "GOG_CONFIGURED" || echo "GOG_NOT_CONFIGURED"
[ -d plugins/gmail ] && echo "PLUGIN_EXISTS" || echo "PLUGIN_MISSING"
[ -d data/gogcli ] && echo "GOG_CREDS_EXIST" || echo "GOG_CREDS_MISSING"
```

**If gog is already installed and configured** (Calendar is set up via `/add-skill-cal`):
- Skip to Step 3 to add Gmail scopes
- The same OAuth credentials and gog config are reused

**If gog is not installed:**
- Continue with Step 2

## Step 2: Install gog and Set Up OAuth

**Only needed if `/add-skill-cal` hasn't been run yet.**

Install gog:
```bash
which gog && echo "Already installed" || curl -sL "https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin gog
```

**USER ACTION REQUIRED**

Tell the user:

> I need you to set up Google Cloud OAuth credentials:
>
> 1. Go to https://console.cloud.google.com
> 2. Create a new project (or select an existing one)
> 3. Go to **APIs & Services > Library**, search for **Gmail API**, and **Enable** it
> 4. Go to **APIs & Services > Credentials**
> 5. Click **+ CREATE CREDENTIALS > OAuth client ID**
> 6. If prompted for consent screen, choose "External", fill in app name, save
> 7. Application type: **Desktop app**, name it anything
> 8. Click **Create**, then **DOWNLOAD JSON**
> 9. Tell me where you saved the file

Import the credentials:
```bash
gog auth credentials /path/to/client_secret.json
```

Set keyring password:
```bash
grep "^GOG_KEYRING_PASSWORD=" .env 2>/dev/null && echo "ALREADY_SET" || echo 'GOG_KEYRING_PASSWORD=CHOOSE_A_PASSWORD' >> .env
```

Optionally set `GOG_ACCOUNT` if the user has multiple Google accounts (gog defaults to the first):
```bash
echo 'GOG_ACCOUNT=user@gmail.com' >> .env
```

## Step 3: Enable Gmail API and Authorize

**If gog was already set up for Calendar (via /add-cal):**

Tell the user:

> You already have a GCP project from Calendar setup. I just need you to enable the Gmail API in that same project:
>
> 1. Go to https://console.cloud.google.com
> 2. Select your existing project (the one used for Calendar)
> 3. Go to **APIs & Services > Library**
> 4. Search for **Gmail API** and click **Enable**
> 5. Let me know when done

Wait for confirmation, then re-auth with both scopes. gog stores one token per account — re-authing with expanded scopes replaces the old token. Google will prompt the user to grant the additional Gmail permission:

```bash
GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog auth login --services gmail,calendar
```

On a headless server (no browser):
```bash
GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog auth login --services gmail,calendar --manual
```

This prints an OAuth URL. Tell the user to open it in any browser, authorize the expanded permissions, then paste back the redirect URL.

**If this is a fresh gog setup (Step 2 was completed):**

```bash
GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog auth login --services gmail
```

Verify Gmail access:
```bash
GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog gmail labels list
```

## Step 4: Sync Credentials for Containers

```bash
mkdir -p data/gogcli
cp -r ~/.config/gogcli/* data/gogcli/
chown -R 1000:1000 data/gogcli
```

## Step 5: Install Plugin

```bash
cp -r .claude/skills/add-skill-gmail/files/ plugins/gmail/
```

## Step 6: Build and Restart

```bash
./container/build.sh && npm run build
systemctl restart nanoclaw 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || echo "Restart the NanoClaw service manually"
```

## Verify

Send a message in your channel like:
- "Check my recent emails"
- "Search my inbox for messages from John"
- "Send an email to jane@example.com about the meeting"

## Troubleshooting

- **"invalid_grant" / token expired**: Re-run Step 3 to re-authorize, then Step 4 to sync credentials
- **gog works on host but not in container**: Credentials not synced -- run Step 4 again
- **"GOG_KEYRING_PASSWORD not set"**: Check it's in `.env` and the plugin's `containerEnvVars` includes it
- **Gmail commands fail but Calendar works**: Gmail scopes not authorized -- re-run Step 3 with `--services gmail,calendar`

## Remove

1. `rm -rf plugins/gmail/`
2. Rebuild and restart
3. Gmail scopes remain in the OAuth token but are harmless; to fully revoke, re-auth with `--services calendar` only
