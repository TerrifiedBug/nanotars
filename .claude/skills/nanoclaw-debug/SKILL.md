---
name: nanoclaw-debug
description: Debug container agent issues and run health checks. Use when things aren't working, container fails, authentication problems, plugin issues, or to understand how the system works. Covers logs, environment variables, mounts, plugins, and common issues.
---

# NanoClaw Debugging & Health Check

Start with the health check. Then use targeted diagnostics based on what fails.

## Architecture Overview

```
Host (macOS/Linux)                        Container (Docker/Apple Container)
───────────────────────────────────────────────────────────────────────────
src/index.ts                              container/agent-runner/src/
    │                                          │
    │ orchestrator                             │ runs Claude Agent SDK
    │                                          │ with MCP servers + plugin hooks
    │
src/plugin-loader.ts                      /workspace/ (container filesystem)
    │ discovers plugins/*/plugin.json     ├── group/           (rw) cwd
    │ loads hooks, env vars, MCP          ├── project/         (rw) main only
    │ scopes by channel + group           ├── global/          (ro) non-main only
    │                                     ├── extra/           (ro) additional mounts
src/container-runtime.ts                  ├── env-dir/env      (ro) env vars
    │ detects Docker vs Apple Container   ├── ipc/             (rw) host<->container IPC
    │ orphan cleanup, mount permissions   │   ├── messages/    agent → host: outgoing messages
    │                                     │   ├── tasks/       agent → host: task operations
src/container-runner.ts                   │   ├── input/       host → agent: piped messages
    │ builds mounts from plugins + core   │   └── *.json       host → agent: snapshots
    │ passes secrets via stdin            ├── .mcp.json        (ro) merged MCP config
    │ streams output via markers          ├── .claude/skills/  (ro) core + plugin skills
    │                                     └── plugin-hooks/    (ro) plugin SDK hooks
src/group-queue.ts
    │ concurrency limit (MAX_CONCURRENT_CONTAINERS)
    │ per-group queuing, retry with backoff
    │
src/task-scheduler.ts
    │ polls SQLite for due tasks
    │ per-task model selection
```

## 1. Health Check

Run this first. It checks every layer of the system.

```bash
echo "=== NanoClaw Health Check ==="

echo -e "\n--- Runtime ---"
(which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo "RUNTIME: docker (running)") || \
(which container >/dev/null 2>&1 && container system status >/dev/null 2>&1 && echo "RUNTIME: apple_container (running)") || \
echo "RUNTIME: NONE — no container runtime found"

echo -e "\n--- Container Image ---"
(docker image inspect nanoclaw-agent:latest >/dev/null 2>&1 && echo "IMAGE: built (docker)") || \
(container image list 2>/dev/null | grep -q nanoclaw-agent && echo "IMAGE: built (apple container)") || \
echo "IMAGE: NOT BUILT — run ./container/build.sh"

echo -e "\n--- Authentication ---"
if [ -f .env ] && grep -q "CLAUDE_CODE_OAUTH_TOKEN" .env; then echo "AUTH: OAuth token in .env"
elif [ -f .env ] && grep -q "ANTHROPIC_API_KEY" .env; then echo "AUTH: API key in .env"
elif [ -f ~/.claude/.credentials.json ]; then echo "AUTH: OAuth credentials file (~/.claude/.credentials.json)"
else echo "AUTH: MISSING — add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env, or run claude login"
fi

echo -e "\n--- Env File (container) ---"
[ -f data/env/env ] && echo "ENV_FILE: exists ($(wc -l < data/env/env) vars)" || echo "ENV_FILE: not yet created (created on first run)"

echo -e "\n--- Plugins ---"
PLUGIN_COUNT=$(ls -d plugins/*/plugin.json plugins/*/*/plugin.json 2>/dev/null | wc -l)
echo "PLUGINS: $PLUGIN_COUNT found"
for pj in plugins/*/plugin.json plugins/*/*/plugin.json; do
  [ -f "$pj" ] || continue
  DIR=$(dirname "$pj")
  NAME=$(basename "$DIR")
  TYPE=$(python3 -c "import json; print(json.load(open('$pj')).get('type','skill'))" 2>/dev/null || echo "unknown")
  echo "  - $NAME ($TYPE)"
done

echo -e "\n--- Channel Plugins ---"
CHANNELS=0
for pj in plugins/*/plugin.json plugins/channels/*/plugin.json; do
  [ -f "$pj" ] || continue
  IS_CHANNEL=$(python3 -c "import json; d=json.load(open('$pj')); print('yes' if d.get('channelPlugin') or d.get('type')=='channel' else 'no')" 2>/dev/null)
  if [ "$IS_CHANNEL" = "yes" ]; then
    DIR=$(dirname "$pj")
    NAME=$(basename "$DIR")
    CHANNELS=$((CHANNELS+1))
    # Check auth
    [ -f "data/channels/$NAME/auth/creds.json" ] && AUTH="authenticated" || AUTH="not authenticated"
    echo "  - $NAME ($AUTH)"
  fi
done
[ $CHANNELS -eq 0 ] && echo "  NONE — install a channel with /add-channel-whatsapp, /add-channel-discord, or /add-channel-telegram"

echo -e "\n--- Registered Groups ---"
sqlite3 store/messages.db "SELECT folder, jid, name FROM registered_groups" 2>/dev/null || echo "  No database or no groups registered"

echo -e "\n--- Service ---"
if systemctl is-active nanoclaw >/dev/null 2>&1; then
  echo "SERVICE: running (systemd)"
  echo "  PID: $(systemctl show nanoclaw --property=MainPID --value)"
  echo "  Uptime: $(systemctl show nanoclaw --property=ActiveEnterTimestamp --value)"
elif launchctl list 2>/dev/null | grep -q nanoclaw; then
  echo "SERVICE: running (launchd)"
elif pgrep -f 'node.*dist/index.js' >/dev/null 2>&1; then
  echo "SERVICE: running (manual process)"
  echo "  PID: $(pgrep -f 'node.*dist/index.js')"
else
  echo "SERVICE: NOT RUNNING"
fi

echo -e "\n--- Active Containers ---"
if which docker >/dev/null 2>&1; then
  docker ps --filter name=nanoclaw- --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}" 2>/dev/null || echo "  None"
elif which container >/dev/null 2>&1; then
  container ls 2>/dev/null | grep nanoclaw || echo "  None"
fi

echo -e "\n--- Recent Container Logs ---"
LATEST=$(ls -t groups/*/logs/container-*.log 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  echo "Latest: $LATEST"
  echo "  Exit status: $(grep -o '"status":"[^"]*"' "$LATEST" | tail -1 || echo 'unknown')"
else
  echo "  No container logs yet"
fi

echo -e "\n--- Scheduled Tasks ---"
sqlite3 store/messages.db "SELECT id, substr(prompt,1,40), schedule_type, status, next_run, model FROM scheduled_tasks WHERE status <> 'cancelled' ORDER BY id" 2>/dev/null || echo "  No tasks"

echo -e "\n--- Disk Usage ---"
echo "  Groups: $(du -sh groups/ 2>/dev/null | cut -f1 || echo 'N/A')"
echo "  Data: $(du -sh data/ 2>/dev/null | cut -f1 || echo 'N/A')"
echo "  Sessions: $(du -sh data/sessions/ 2>/dev/null | cut -f1 || echo 'N/A')"
echo "  Logs: $(du -sh logs/ 2>/dev/null | cut -f1 || echo 'N/A')"

echo -e "\n--- Recent Errors ---"
tail -20 logs/nanoclaw.log 2>/dev/null | grep -i '"level":50' | tail -5 || echo "  No recent errors"
```

Interpret the results and tell the user what's healthy and what needs fixing. If everything passes, say so.

## 2. Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app** | `logs/nanoclaw.log` | Routing, container spawning, plugin lifecycle, message loop |
| **Main errors** | `logs/nanoclaw.error.log` | Errors only |
| **Container runs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout, exit code |
| **Conversations** | `groups/{folder}/conversations/*.md` | Archived agent transcripts |

### Reading container logs

Each container run creates a timestamped log file. Read the most recent one for the failing group:

```bash
# Latest log for a specific group
ls -t groups/{folder}/logs/container-*.log | head -1 | xargs cat

# Latest log across all groups
ls -t groups/*/logs/container-*.log | head -1 | xargs cat
```

Key things to look for:
- `"status":"error"` — container failed
- `exit code 1` — usually auth issue or SDK error
- `EACCES` — permission denied (Docker bind mount issue)
- `timeout` — container took too long

### Enabling debug logging

```bash
# Development
LOG_LEVEL=debug npm run dev

# systemd service
# Add Environment=LOG_LEVEL=debug to [Service] section
systemctl edit nanoclaw
systemctl restart nanoclaw

# launchd service
# Add to plist EnvironmentVariables:
# <key>LOG_LEVEL</key><string>debug</string>
```

Debug level shows full mount configurations, container args, real-time stderr.

## 3. Common Issues

### 3.1 Container exits with code 1

**Check the container log** in `groups/{folder}/logs/container-*.log`.

#### Missing authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` has either:
```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # subscription
ANTHROPIC_API_KEY=sk-ant-api03-...          # pay-per-use
```

#### Root user restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root. Check Dockerfile has `USER node`.

### 3.2 Environment variables not reaching container

The system collects env vars from two sources:
1. **Core:** `ANTHROPIC_API_KEY`, `ASSISTANT_NAME`, `CLAUDE_MODEL`
2. **Plugins:** Each plugin declares `containerEnvVars` in `plugin.json`

Only declared vars are written to `data/env/env`. If a plugin needs a var, it must be in the manifest.

**Verify what reaches the container:**
```bash
# Check what's in the env file
cat data/env/env

# Check what a specific plugin declares
cat plugins/{name}/plugin.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('containerEnvVars',[]))"

# Test inside a container
echo '{}' | docker run -i --rm \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); env | grep -v "^_"'
```

**Common cause:** Plugin declares the var in `plugin.json` but it's missing from `.env`. Add it to `.env` and restart.

### 3.3 Docker bind mount permissions (Linux only)

```
EACCES: permission denied, mkdir '/home/node/.claude/debug'
```

Docker containers run as `node` (UID 1000) but host directories created by root have root ownership. The system runs `chown -R 1000:1000` on writable mount paths before spawning, but this can fail.

**Fix:**
```bash
# Fix ownership on common writable paths
chown -R 1000:1000 data/sessions/ data/ipc/ groups/
```

### 3.4 Plugin not loading

```bash
# Check plugin loader output in logs
grep -i "plugin" logs/nanoclaw.log | tail -20
```

Common issues:
- **Missing `plugin.json`:** Every plugin needs a valid manifest
- **Hook declared but missing:** Manifest references `hooks: ["onInboundMessage"]` but `index.js` doesn't export it
- **Missing `index.js`:** If manifest declares hooks, the plugin dir must have an `index.js`
- **Bad JSON:** Syntax error in `plugin.json` or `mcp.json`

**Verify a plugin's structure:**
```bash
PLUGIN=plugins/{name}
echo "=== Manifest ==="
cat $PLUGIN/plugin.json
echo -e "\n=== Files ==="
ls -la $PLUGIN/
echo -e "\n=== Container skills ==="
ls -la $PLUGIN/container-skills/ 2>/dev/null || echo "None"
echo -e "\n=== Hooks ==="
ls -la $PLUGIN/*.js 2>/dev/null || echo "None"
```

### 3.5 Plugin skills not visible in container

Plugin skills are mounted based on **scoping**. A plugin with `"channels": ["whatsapp"]` won't be visible in a Discord container.

**Check scoping:**
```bash
# See what channels/groups a plugin targets
python3 -c "
import json, glob
for f in sorted(glob.glob('plugins/*/plugin.json') + glob.glob('plugins/*/*/plugin.json')):
    d = json.load(open(f))
    name = d.get('name', f)
    channels = d.get('channels', ['*'])
    groups = d.get('groups', ['*'])
    skills = 'yes' if any(True for _ in glob.glob(f.replace('plugin.json','container-skills/*'))) else 'no'
    print(f'{name}: channels={channels} groups={groups} has_skills={skills}')
"
```

### 3.6 MCP server issues

Plugin MCP configs are merged into `data/merged-mcp.json`. If an MCP server fails to start, the agent may exit.

**Check merged config:**
```bash
cat data/merged-mcp.json | python3 -m json.tool
```

**Common issues:**
- MCP server binary not found (not installed in container)
- Missing env var that MCP server needs
- Port conflict between MCP servers

### 3.7 Container timeout (no output)

```
Container timed out with no output
```

The container didn't produce any `OUTPUT_START_MARKER` before the hard timeout.

**Possible causes:**
- SDK initialization failure (check container log stderr)
- Model overloaded (try again)
- Prompt too large for context window
- Plugin hook blocking startup

**Versus idle timeout (normal):**
```
Container timed out after output (idle cleanup)
```
This is normal — the agent finished responding but the idle timer expired before the `_close` sentinel was sent.

### 3.8 Chromium/browser issues (Docker)

Docker needs extra flags for Chromium:
- `--cap-add=SYS_PTRACE` — crashpad handler
- `--security-opt seccomp=chromium-seccomp.json` — allows clone/unshare syscalls
- `--ipc=host` — prevents OOM from small `/dev/shm`
- `--init` — reaps zombie processes

These are added automatically by `container-runtime.ts` for Docker. If browser still fails:

```bash
# Test Chromium inside container
docker run --rm -it \
  --cap-add=SYS_PTRACE \
  --security-opt seccomp=$(pwd)/container/chromium-seccomp.json \
  --ipc=host --init \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'chromium --headless --no-sandbox --dump-dom https://example.com 2>&1 | head -20'
```

### 3.9 Session not resuming

If sessions aren't being resumed (new session ID every time):

**Check:** The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the container, `HOME=/home/node`.

```bash
# Check session directory exists and has content
ls -la data/sessions/{groupFolder}/.claude/ 2>/dev/null

# Check mount target in container
docker run --rm \
  -v $(pwd)/data/sessions/main/.claude:/home/node/.claude \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'echo "HOME=$HOME"; ls -la $HOME/.claude/projects/ 2>&1 | head -5'
```

### 3.10 Messages not being processed

**Check the message loop:**
```bash
# Recent message activity
grep "New messages\|Processing messages\|Piped messages" logs/nanoclaw.log | tail -10

# Check if queue is stuck
grep "concurrency limit\|Max retries\|scheduling retry" logs/nanoclaw.log | tail -10

# Check active containers
docker ps --filter name=nanoclaw-
```

**Common causes:**
- Trigger pattern not matching (non-main groups need `@AssistantName` prefix)
- Queue at concurrency limit (`MAX_CONCURRENT_CONTAINERS`, default 2)
- All retries exhausted (exponential backoff up to 5 retries)
- Channel plugin disconnected

## 4. Manual Container Testing

### Test full agent flow
```bash
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@test","isMain":false}' | \
  docker run -i --rm \
  --cap-add=SYS_PTRACE --security-opt seccomp=$(pwd)/container/chromium-seccomp.json --ipc=host --init \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/main:/workspace/group \
  -v $(pwd)/data/ipc/main:/workspace/ipc \
  nanoclaw-agent:latest
```

### Test Claude Code directly
```bash
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
'
```

### Interactive shell
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

### Check what's in the image
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node ===" && node --version
  echo "=== Claude Code ===" && claude --version
  echo "=== Chromium ===" && chromium --version 2>/dev/null || echo "not found"
  echo "=== Workspace ===" && ls -la /workspace/
  echo "=== App ===" && ls -la /app/src/
'
```

## 5. IPC Debugging

The container communicates with the host via files:

```bash
# Check pending outgoing messages
ls -la data/ipc/*/messages/ 2>/dev/null

# Check pending task operations
ls -la data/ipc/*/tasks/ 2>/dev/null

# Check input messages (host → container)
ls -la data/ipc/*/input/ 2>/dev/null

# Read snapshots
cat data/ipc/{groupFolder}/current_tasks.json 2>/dev/null | python3 -m json.tool
cat data/ipc/{groupFolder}/available_groups.json 2>/dev/null | python3 -m json.tool
```

**IPC stuck?** Files accumulating in `messages/` or `tasks/` means the host IPC watcher isn't processing them. Check if the main process is running and look for IPC errors in logs.

## 6. Security Hooks

The agent-runner loads security hooks that:
- **Block** Bash access to `/proc/*/environ` (leaks secrets)
- **Block** Read access to `/tmp/input.json` (contains stdin with secrets)
- **Prepend** `unset ANTHROPIC_API_KEY; unset CLAUDE_CODE_OAUTH_TOKEN;` to every Bash command

Secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) are passed via stdin JSON and injected into the SDK's `env` option. They never appear in `process.env` inside the container.

**If agent reports "permission denied" for a legitimate tool call**, check if security hooks are blocking it:
```bash
grep "blocked\|denied\|sanitiz" groups/{folder}/logs/container-*.log | tail -10
```

## 7. Rebuilding

```bash
# Rebuild main app
npm run build

# Rebuild container image
./container/build.sh

# Force clean rebuild (Docker)
docker builder prune -af
./container/build.sh

# Force clean rebuild (Apple Container)
container builder stop && container builder rm && container builder start
./container/build.sh
```

**Remember:** Agent-runner source is bind-mounted at `/app/src` (ro) — code changes take effect on next container spawn without rebuild. But `tsconfig.json` and `package.json` are baked into the image — those need a rebuild.

## 8. Database

```bash
# List tables
sqlite3 store/messages.db ".tables"

# Check registered groups
sqlite3 store/messages.db "SELECT * FROM registered_groups"

# Check recent messages
sqlite3 store/messages.db "SELECT id, jid, substr(content,1,50), timestamp FROM messages ORDER BY id DESC LIMIT 10"

# Check scheduled tasks
sqlite3 store/messages.db "SELECT id, substr(prompt,1,40), schedule_type, status, next_run, model FROM scheduled_tasks"

# Check task run history
sqlite3 store/messages.db "SELECT task_id, status, duration_ms, substr(result,1,50), run_at FROM task_run_logs ORDER BY run_at DESC LIMIT 10"

# Check sessions
sqlite3 store/messages.db "SELECT * FROM sessions"
```

## 9. Service Management

### systemd (Linux)
```bash
systemctl status nanoclaw
systemctl restart nanoclaw
journalctl -u nanoclaw -f          # follow logs
journalctl -u nanoclaw --since "1 hour ago"
```

### launchd (macOS)
```bash
launchctl list | grep nanoclaw
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Clear sessions (fresh start)
```bash
# All groups
rm -rf data/sessions/

# Specific group
rm -rf data/sessions/{groupFolder}/.claude/
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```
