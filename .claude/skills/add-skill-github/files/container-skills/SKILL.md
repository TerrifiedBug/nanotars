---
name: github
description: Monitor GitHub repositories, check PRs, issues, commits, and releases. Use for tracking development activity and code management.
allowed-tools: Bash(curl:*)
---

# GitHub API Access

Monitor GitHub repositories and activity. Requires `$GH_TOKEN` environment variable. If not configured, tell the user to run `/add-github` on the host to set it up.

```bash
# Check for new PRs on main repos
curl -s "https://api.github.com/repos/OWNER/REPO/pulls" \
  -H "Authorization: token $GH_TOKEN"

curl -s "https://api.github.com/repos/OWNER/REPO/pulls" \
  -H "Authorization: token $GH_TOKEN"

# Check specific PR details
curl -s "https://api.github.com/repos/OWNER/REPO/pulls/PR_NUMBER" \
  -H "Authorization: token $GH_TOKEN"

# Recent commits
curl -s "https://api.github.com/repos/OWNER/REPO/commits?since=2024-01-01T00:00:00Z" \
  -H "Authorization: token $GH_TOKEN"

# Repository activity
curl -s "https://api.github.com/repos/OWNER/REPO/events" \
  -H "Authorization: token $GH_TOKEN"

# Check CI status
curl -s "https://api.github.com/repos/OWNER/REPO/actions/runs" \
  -H "Authorization: token $GH_TOKEN"
```

## Key Repositories
Discover repositories by querying the GitHub API:
```bash
# List user's repositories
curl -s "https://api.github.com/user/repos?sort=updated&per_page=10" \
  -H "Authorization: token $GH_TOKEN"
```

## Environment
- `GH_TOKEN` environment variable contains GitHub PAT
- Token has read/write access to contents and pull requests
- Never add Co-authored-by lines to commits

## Use Cases
- Monitor for new PRs requiring review
- Check CI/CD status
- Track development activity
- Get notifications for repository changes
