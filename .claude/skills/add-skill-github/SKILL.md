---
name: add-skill-github
description: Add GitHub API access to NanoClaw. Enables agents to monitor repos, check PRs, issues, commits, and CI status. Guides through Personal Access Token setup. Triggers on "add github", "github setup", "github integration", "github token".
---

# Add GitHub

Configures GitHub API access for agent containers, enabling repo monitoring, PR/issue tracking, and CI status checks.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- A GitHub account

## Install

1. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-github/files/ plugins/github/
   ```
2. Create a fine-grained Personal Access Token:
   - Go to https://github.com/settings/tokens?type=beta
   - Click **Generate new token**
   - Set expiration (recommended: 90 days or longer)
   - Under **Repository access**, select repos to monitor
   - Under **Permissions**, enable read-only for: Contents, Pull requests, Issues, Actions
   - Click **Generate token** and copy it
3. Add to `.env`:
   ```bash
   echo 'GH_TOKEN=YOUR_TOKEN_HERE' >> .env
   ```
4. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Test the token:
```bash
source .env
curl -s -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | python3 -c "
import sys, json
r = json.load(sys.stdin)
if 'login' in r:
    print(f'OK - {r[\"login\"]}')
else:
    print(f'FAILED - {r}')
"
```

## Remove

1. ```bash
   rm -rf plugins/github/
   ```
2. Remove `GH_TOKEN` from `.env`
3. Rebuild and restart
