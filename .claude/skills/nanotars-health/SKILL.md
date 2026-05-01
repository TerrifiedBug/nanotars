---
name: nanotars-health
description: Quick system health check — shows status of all NanoTars components at a glance
triggers:
  - health check
  - system health
  - status check
  - is everything ok
  - system status
---

# NanoTars Health Check

Use the typed NanoTars CLI. Do not hand-roll health checks with raw shell, Docker, or SQLite snippets from this skill.

## Run Health Summary

```bash
nanotars doctor
```

For machine-readable output:

```bash
nanotars doctor --json
```

## Check Recent Errors

```bash
nanotars logs errors
```

## Check Env Drift

```bash
nanotars env audit
```

## Present Results

Summarize:

- service status
- database integrity
- plugin and channel counts
- log availability
- recent errors, if any
- missing declared plugin env vars, if any

If a check fails or recent errors are present, recommend `/nanotars-debug` and carry the relevant CLI output forward so the next diagnostic step starts with evidence.
