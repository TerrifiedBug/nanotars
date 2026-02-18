---
name: add-skill-imap-read
description: Add read-only IMAP email access to NanoClaw agent containers. Supports multiple providers (Gmail, Yahoo, Outlook, any IMAP server). Guides through app password setup and configures environment variables. Triggers on "add email", "add imap", "email integration", "read emails".
---

# Add IMAP Email Reader

Read-only email access for agent containers via IMAP. Supports multiple providers simultaneously.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- For Gmail: 2-Step Verification enabled on the Google Account
- For Yahoo: Account Security settings accessible

## Install

1. Check existing configuration:
   ```bash
   grep "^IMAP_READ_ACCOUNTS=" .env 2>/dev/null && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
   ls plugins/imap-read/plugin.json 2>/dev/null && echo "PLUGIN_EXISTS" || echo "NO_PLUGIN"
   ```
   If `ALREADY_CONFIGURED`, ask the user if they want to add another account or reconfigure.

2. Gather account details for each email provider. Collect:
   - **Provider name** (e.g., "Gmail", "Yahoo", "Work")
   - **IMAP host** (auto-fill based on provider):
     - Gmail: `imap.gmail.com`
     - Yahoo: `imap.mail.yahoo.com`
     - Outlook/Hotmail: `outlook.office365.com`
     - Other: ask for the IMAP server address
   - **Email address** (username for IMAP login)
   - **App password** (NOT the regular account password)

   ### App Password Instructions

   **Gmail:**
   > 1. Go to https://myaccount.google.com/apppasswords
   > 2. You must have 2-Step Verification enabled
   > 3. Select "Other" as the app name, enter "NanoClaw"
   > 4. Copy the 16-character password (spaces don't matter)

   **Yahoo:**
   > 1. Go to https://login.yahoo.com/account/security
   > 2. Click "Generate app password"
   > 3. Select "Other app", enter "NanoClaw"
   > 4. Copy the generated password

   **Outlook/Hotmail:**
   > 1. Go to https://account.microsoft.com/security
   > 2. Under "Additional security", enable 2-Step Verification if not already
   > 3. Go to "App passwords" > Create a new app password
   > 4. Copy the generated password

3. Build `IMAP_READ_ACCOUNTS` JSON array and save to `.env`:
   ```bash
   sed -i '/^IMAP_READ_ACCOUNTS=/d' .env
   echo 'IMAP_READ_ACCOUNTS=[{"name":"Gmail","host":"imap.gmail.com","port":993,"user":"user@gmail.com","pass":"xxxx xxxx xxxx xxxx"}]' >> .env
   ```
   (Substitute actual account details. JSON must be on a single line.)

4. Test credentials before deploying:
   ```bash
   python3 -c "
   import imaplib, json
   accounts = json.loads('''THE_JSON_ARRAY_HERE''')
   for a in accounts:
       try:
           m = imaplib.IMAP4_SSL(a['host'], a.get('port', 993))
           m.login(a['user'], a['pass'])
           m.select('INBOX', readonly=True)
           _, data = m.search(None, 'UNSEEN')
           count = len(data[0].split()) if data[0] else 0
           print(f\"{a['name']}: OK - {count} unread emails\")
           m.close(); m.logout()
       except Exception as e:
           print(f\"{a['name']}: FAILED - {e}\")
   "
   ```

5. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-imap-read/files/ plugins/imap-read/
   ```

6. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Tell the user:
> Email access is configured. Test it by sending a WhatsApp message like "check my email" or "how many unread emails do I have?"

## Troubleshooting

- **"IMAP_READ_ACCOUNTS not defined" in container**: Check that `plugins/imap-read/plugin.json` exists with the correct `containerEnvVars`, and that `.env` has the variable set.
- **Authentication failures**: App passwords expire if the account password changes. Regenerate and re-run this skill.
- **Gmail blocks access**: Ensure 2-Step Verification is ON and you're using an app password.
- **Timeout errors**: Some corporate IMAP servers require VPN.

## Remove

1. `rm -rf plugins/imap-read/`
2. Remove env vars from `.env`:
   ```bash
   sed -i '/^IMAP_READ_ACCOUNTS=/d' .env
   ```
3. Rebuild and restart.
4. Revoke app passwords in each provider's security settings.
