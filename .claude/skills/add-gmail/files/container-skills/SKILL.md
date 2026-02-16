---
name: gmail
description: Read, search, and send Gmail emails. Manage labels, drafts, filters, and vacation settings. Uses gog CLI for Google Workspace access.
allowed-tools: Bash(gog:*)
---

# Gmail

Read and send emails via the `gog` CLI (Google Workspace CLI). If `gog` is not available or returns auth errors, tell the user to run `/add-gmail` on the host.

## Quick Reference

Search emails (last 7 days):
```bash
gog gmail search 'newer_than:7d'
```

Search by sender:
```bash
gog gmail search 'from:user@example.com'
```

Search with multiple criteria:
```bash
gog gmail search 'from:boss@company.com subject:urgent newer_than:30d'
```

Send an email:
```bash
gog gmail send --to "user@example.com" --subject "Subject" --body "Message body"
```

List labels:
```bash
gog gmail labels list
```

## Gmail Search Syntax

Use standard Gmail search operators with `gog gmail search`:
- `from:user@example.com` -- From specific sender
- `to:user@example.com` -- To specific recipient
- `subject:keyword` -- Subject contains keyword
- `newer_than:7d` -- Within last 7 days (use d/m/y)
- `older_than:30d` -- Older than 30 days
- `has:attachment` -- Has attachments
- `label:important` -- In a specific label
- `is:unread` -- Unread messages
- `is:starred` -- Starred messages

Combine with spaces (AND) or `OR`:
```bash
gog gmail search 'from:alice OR from:bob newer_than:7d'
```

## Full Command Help

For complete command options:
```bash
gog gmail --help
gog gmail send --help
gog gmail search --help
gog gmail labels --help
```

## Multiple Accounts

If multiple Google accounts are configured, gog uses `$GOG_ACCOUNT` as the default. To target a specific account, pass `--account`:
```bash
gog gmail search 'newer_than:7d' --account user@gmail.com
```

List all available accounts:
```bash
gog auth list
```

## Tips

- Always confirm with the user before sending emails
- Default to 7-day search range unless the user specifies otherwise
- Use `--output json` for structured data when processing results
- If gog reports "invalid_grant", the OAuth token has expired -- tell user to refresh via `/add-gmail`
- **If the imap-read skill is also available:** Use `gog gmail` for accounts configured in gog. imap-read is a separate read-only tool with its own accounts -- don't mix them up
