---
name: add-cal
description: Add calendar access to NanoClaw. Supports Google Calendar (gog CLI with OAuth) and CalDAV providers (iCloud, Nextcloud, Fastmail via cal CLI). Guides through authentication and configures environment variables. Triggers on "add calendar", "add caldav", "icloud calendar", "google calendar", "calendar setup".
---

# Add Calendar Access

Calendar integration for NanoClaw agent containers. Two tools are available:

- **`gog`** -- Google Calendar (OAuth, read/write)
- **`cal`** -- CalDAV providers: iCloud, Nextcloud, Fastmail (Basic Auth, read/write)

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

## Install

1. Check existing configuration:
   ```bash
   grep "^GOG_KEYRING_PASSWORD=" .env 2>/dev/null && echo "GOOGLE: CONFIGURED" || echo "GOOGLE: NOT SET"
   grep "^CALDAV_ACCOUNTS=" .env 2>/dev/null && echo "CALDAV: CONFIGURED" || echo "CALDAV: NOT SET"
   ```
   If already configured, ask the user if they want to add another provider or reconfigure.

2. Choose provider:
   - **Google Calendar** -- Go to Step 3A
   - **iCloud / Nextcloud / Fastmail / Other CalDAV** -- Go to Step 3B

### Step 3A: Google Calendar (gog CLI)

Install gog on the host if needed:
```bash
which gog && echo "GOG_INSTALLED" || curl -sL "https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin gog
```

gogcli is installed automatically when the container image is built (via `plugins/calendar/Dockerfile.partial`). No manual Dockerfile changes needed.

Import OAuth credentials (user provides their client_secret.json path):
```bash
gog auth credentials /path/to/client_secret.json
```

OAuth login (include gmail if the Gmail plugin is already installed to preserve its scopes):
```bash
if [ -d plugins/gmail ]; then
  GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog auth login --services calendar,gmail
else
  GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog auth login --services calendar
fi
```

On a headless server, add `--manual` to the gog command above.

Verify: `GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog calendar calendars`

Configure environment:
```bash
grep "^GOG_KEYRING_PASSWORD=" .env 2>/dev/null && echo "ALREADY_SET" || echo 'GOG_KEYRING_PASSWORD=THEIR_PASSWORD_HERE' >> .env
```

Copy gog config for containers:
```bash
mkdir -p data/gogcli
cp -r ~/.config/gogcli/* data/gogcli/
chown -R 1000:1000 data/gogcli
```

### Step 3B: CalDAV (iCloud, Nextcloud, Fastmail)

Gather account details:
- **Provider name** (e.g., "iCloud", "Nextcloud", "Fastmail")
- **CalDAV server URL**:
  - iCloud: `https://caldav.icloud.com`
  - Nextcloud: `https://YOUR_SERVER/remote.php/dav`
  - Fastmail: `https://caldav.fastmail.com`
- **Username** (usually email address)
- **App-specific password**

App-specific password instructions:

**iCloud:**
> 1. Go to https://appleid.apple.com/account/manage
> 2. Sign in > "Sign-In and Security" > "App-Specific Passwords"
> 3. Click + > Name it "NanoClaw" > Create
> 4. Copy the password (format: xxxx-xxxx-xxxx-xxxx)

**Nextcloud:**
> 1. Settings > Security > "Devices & Sessions"
> 2. Enter "NanoClaw" > "Create new app password"

**Fastmail:**
> 1. Settings > Privacy & Security > Integrations
> 2. "New app password" > Select CalDAV > Name it "NanoClaw"

Save to `.env`:
```bash
sed -i '/^CALDAV_ACCOUNTS=/d' .env
echo 'CALDAV_ACCOUNTS=[{"name":"iCloud","serverUrl":"https://caldav.icloud.com","user":"user@icloud.com","pass":"xxxx-xxxx-xxxx-xxxx"}]' >> .env
```

### Step 4: Group Scoping

Ask the user which groups should have access to Calendar:

- **All groups** (default) -- every group's agent can read and manage calendar events
- **Specific groups only** -- e.g., only `main` and `family-chat`

If the user wants to restrict access, update `plugins/calendar/plugin.json` after copying (Step 5) to set `"groups"` to the list of group folder names:

```json
"groups": ["main", "family-chat"]
```

If all groups (or the user doesn't care), leave as `"groups": ["*"]`.

Restricting access means only those groups' agents will have calendar tools. Other groups won't see calendar commands or credentials.

### Step 5: Deploy Plugin

Copy plugin files:
```bash
mkdir -p plugins/calendar/container-skills plugins/calendar/cal-cli/src
cp .claude/skills/add-skill-cal/files/plugin.json plugins/calendar/
cp .claude/skills/add-skill-cal/files/container-skills/SKILL.md plugins/calendar/container-skills/
cp .claude/skills/add-skill-cal/files/Dockerfile.partial plugins/calendar/
cp .claude/skills/add-skill-cal/files/package.json .claude/skills/add-skill-cal/files/package-lock.json .claude/skills/add-skill-cal/files/tsconfig.json plugins/calendar/cal-cli/
cp .claude/skills/add-skill-cal/files/src/*.ts plugins/calendar/cal-cli/src/
```

### Step 6: Configure Container Mounts

The only mount needed is the gogcli config directory so the container can access Google OAuth tokens:

```bash
NANOCLAW_DIR=$(pwd)
cat > plugins/calendar/plugin.json << EOF
{
  "name": "calendar",
  "description": "Calendar access via gog CLI and CalDAV",
  "containerEnvVars": ["GOG_KEYRING_PASSWORD", "GOG_ACCOUNT", "CALDAV_ACCOUNTS"],
  "containerMounts": [
    {"hostPath": "data/gogcli", "containerPath": "/home/node/.config/gogcli"}
  ],
  "hooks": []
}
EOF
```

Rebuild and restart:
```bash
./container/build.sh
systemctl restart nanoclaw 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || echo "Restart the NanoClaw service manually"
```

## Verify

Tell the user:
> Calendar access is configured. Test via WhatsApp: "list my calendars" or "what's on my calendar today?"

## Refresh Google OAuth Token

Google OAuth tokens expire periodically. When the agent reports `"invalid_grant" "Token has been expired or revoked."`, re-authenticate:

### On a machine with a browser:
```bash
GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog auth add EMAIL --services=calendar --force-consent
```

### On a headless server (no browser):
```bash
GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) gog auth add EMAIL --manual --services=calendar --force-consent
```
This prints an OAuth URL. Open it in any browser, authorize, then copy the `localhost:1` redirect URL from the address bar and paste it back at the prompt.

If the process can't accept interactive input (e.g. from Claude Code), use `expect`:
```bash
export GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2)
expect -c '
set timeout 30
spawn gog auth add EMAIL --manual --services=calendar --force-consent
expect -re {state=([^\s&]+)}
set state $expect_out(1,string)
expect "Paste redirect URL"
send "http://localhost:1/?state=$state&code=AUTH_CODE_HERE&scope=email%20https://www.googleapis.com/auth/calendar%20https://www.googleapis.com/auth/userinfo.email%20openid&authuser=0&prompt=consent\r"
expect eof
'
```

### CRITICAL: Sync credentials to container mount

After re-auth, `gog` writes tokens to `~/.config/gogcli/` but containers mount `data/gogcli/`. You MUST sync:
```bash
cp -r ~/.config/gogcli/* data/gogcli/
chown -R 1000:1000 data/gogcli/
```
Without this step, containers will still see the old expired token.

Verify from the container mount path:
```bash
GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD .env | cut -d'=' -f2) XDG_CONFIG_HOME=$(pwd)/data gog calendar list --account EMAIL --all
```

## Troubleshooting

- **gog "invalid_grant" / "Token has been expired or revoked"**: Follow the "Refresh Google OAuth Token" section above.
- **gog works on host but not in container**: Credentials not synced — run `cp -r ~/.config/gogcli/* data/gogcli/ && chown -R 1000:1000 data/gogcli/`.
- **gog config not found in container**: Ensure `data/gogcli/` exists and is chowned to 1000:1000.
- **iCloud "401 Unauthorized"**: Use an app-specific password, not your Apple ID password.
- **"CALDAV_ACCOUNTS not defined"**: Check it's in both `.env` and `plugin.json` containerEnvVars.
- **Nextcloud connection refused**: Verify the server URL includes `/remote.php/dav`.

## Remove

1. `rm -rf plugins/calendar/`
2. Remove env vars from `.env`:
   ```bash
   sed -i '/^GOG_KEYRING_PASSWORD=/d' .env
   sed -i '/^GOG_ACCOUNT=/d' .env
   sed -i '/^CALDAV_ACCOUNTS=/d' .env
   ```
3. `rm -rf data/gogcli`
4. Remove the plugin directory and rebuild the container image:
   ```bash
   ./container/build.sh
   ```
5. Restart the service.
6. Revoke app-specific passwords in provider security settings.
