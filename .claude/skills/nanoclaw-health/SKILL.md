---
name: nanoclaw-health
description: Quick system health check — shows status of all NanoClaw components at a glance
triggers:
  - health check
  - system health
  - status check
  - is everything ok
  - system status
---

# NanoClaw Health Check

Quick pass/fail check on all system components. For deeper investigation, use `/nanoclaw-debug`.

## Run all checks

Execute each check and present results as a summary table.

### 1. Service

```bash
if command -v systemctl &>/dev/null; then
  systemctl is-active nanoclaw 2>/dev/null && echo "SERVICE: PASS" || echo "SERVICE: FAIL"
fi
```

### 2. Container Runtime

```bash
if command -v docker &>/dev/null; then
  docker info &>/dev/null && echo "RUNTIME: PASS (docker)" || echo "RUNTIME: FAIL"
elif command -v container &>/dev/null; then
  container ls &>/dev/null && echo "RUNTIME: PASS (apple-container)" || echo "RUNTIME: FAIL"
else
  echo "RUNTIME: FAIL (not found)"
fi
```

### 3. Container Image

```bash
if command -v docker &>/dev/null; then
  docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: PASS" || echo "IMAGE: FAIL"
fi
```

### 4. Authentication

```bash
if [ -f .env ]; then
  if grep -q 'CLAUDE_CODE_OAUTH_TOKEN\|ANTHROPIC_API_KEY' .env; then
    echo "AUTH: PASS"
  else
    echo "AUTH: FAIL (no API key)"
  fi
else
  echo "AUTH: FAIL (.env missing)"
fi
```

### 5. Database

```bash
if [ -f store/messages.db ]; then
  INTEGRITY=$(sqlite3 store/messages.db "PRAGMA integrity_check;" 2>&1)
  [ "$INTEGRITY" = "ok" ] && echo "DATABASE: PASS ($(du -sh store/messages.db | cut -f1))" || echo "DATABASE: FAIL"
else
  echo "DATABASE: FAIL (not found)"
fi
```

### 6. Plugins

```bash
TOTAL=$(ls -d plugins/*/plugin.json plugins/channels/*/plugin.json 2>/dev/null | wc -l)
CHANNELS=$(ls -d plugins/channels/*/plugin.json 2>/dev/null | wc -l)
echo "PLUGINS: ${TOTAL} loaded (${CHANNELS} channels)"
```

### 7. Active Containers

```bash
if command -v docker &>/dev/null; then
  ACTIVE=$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" 2>/dev/null | wc -l)
  echo "CONTAINERS: ${ACTIVE} active"
fi
```

### 8. Disk Usage

```bash
echo "DISK:"
du -sh groups/ 2>/dev/null | awk '{print "  groups: " $1}'
du -sh store/ 2>/dev/null | awk '{print "  store: " $1}'
du -sh logs/ 2>/dev/null | awk '{print "  logs: " $1}'
```

### 9. Recent Errors

```bash
if [ -f logs/nanoclaw.error.log ]; then
  LINES=$(wc -l < logs/nanoclaw.error.log)
  echo "ERRORS: ${LINES} lines in error log"
else
  echo "ERRORS: none"
fi
```

## Present results

Format as a clean summary table. If any check is FAIL, recommend `/nanoclaw-debug`.
