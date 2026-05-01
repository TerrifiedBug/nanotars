---
name: nanotars-debug
description: Debug container agent issues and run health checks. Use when things aren't working, container fails, authentication problems, plugin issues, or to understand how the system works. Covers logs, environment variables, mounts, plugins, and common issues.
---

# NanoTars Debugging & Health Check

Use the typed NanoTars CLI first. Do not query NanoTars SQLite tables directly from this skill and do not duplicate broad health-check shell snippets here.

## First Pass

Run:

```bash
nanotars doctor --json
nanotars logs errors
nanotars env audit
nanotars channels list
nanotars plugins list
nanotars groups list
nanotars tasks list
```

Interpret the results before running targeted commands. Call out the most likely failing layer:

- service not running or stale pid
- database integrity failure
- missing channel authentication
- missing declared env vars
- plugin scope or manifest issue
- failing scheduled task
- recent application or container errors

## Targeted Diagnostics

### Service

```bash
nanotars status
nanotars logs errors
```

If the service is stopped, use:

```bash
nanotars restart
```

### Channels

```bash
nanotars channels list
nanotars channels auth <channel>
```

Use `channels auth` only when the output shows missing or stale auth, or when the operator asks to re-authenticate.

### Plugins

```bash
nanotars plugins list
nanotars env audit
```

Check plugin scopes, declared env vars, and whether the plugin has container skills, MCP config, or a Dockerfile partial.

### Groups

```bash
nanotars groups list
nanotars groups show <folder>
```

Use this to confirm the chat is wired to the expected group and to inspect group agents and scheduled tasks.

### Scheduled Tasks

```bash
nanotars tasks list
nanotars tasks list --group <folder>
nanotars tasks cancel <task-id>
```

Task cancellation is dry-run by default. Only run with `--apply` after operator confirmation.

### Users And Roles

```bash
nanotars users list
nanotars users list --group <folder>
```

Role changes are dry-run by default through `nanotars users grant|revoke`; require explicit operator confirmation before adding `--apply`.

### Database

```bash
nanotars db stats
nanotars db integrity
nanotars db maintenance
```

`db maintenance` is dry-run by default. Only use `--apply` after confirming retention windows with the operator.

## Log Locations

If CLI output points at a specific failing run, inspect the relevant files directly:

| Log | Location | Content |
|---|---|---|
| Main app | `logs/nanotars.log` | Routing, container spawning, plugin lifecycle, message loop |
| Main errors | `logs/nanotars.error.log` | Errors only |
| Container runs | `groups/{folder}/logs/container-*.log` | Per-run input, mounts, stderr, stdout, exit code |
| Conversations | `groups/{folder}/conversations/*.md` | Archived agent transcripts |

Read only the relevant recent log. Prefer `tail` and focused searches over dumping whole logs.

## Common Fixes

- Missing channel auth: run `nanotars channels auth <channel>`.
- Missing plugin env var: add the variable to `.env` or the relevant group `.env`, then restart.
- Model override issue: use `/nanotars-set-model`, which calls `nanotars model`.
- Mount issue: use `/manage-mounts`, which calls `nanotars mounts`.
- Database bloat or integrity concern: use `/nanotars-db-maintenance`, which calls `nanotars db`.

When a fix mutates production state, state the exact command, explain the expected effect, and ask for confirmation before using an `--apply` flag or re-authenticating a channel.
