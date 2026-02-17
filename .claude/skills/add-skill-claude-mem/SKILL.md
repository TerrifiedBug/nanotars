---
name: add-skill-claude-mem
description: Add persistent memory (claude-mem) to NanoClaw agent containers. Creates systemd services for the worker daemon and Docker bridge, configures env vars. Run once after claude-mem plugin is installed.
---

# Add Claude-Mem to Agent Containers

Run all commands automatically. Only pause if a step fails.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## How It Works

The claude-mem worker daemon runs on the host (port 37777) and stores observations in a SQLite + vector DB at `/root/.claude-mem/`. A socat bridge exposes it to Docker containers via 172.17.0.1:37777.

## Prerequisites

- claude-mem plugin installed (`claude plugin add @thedotmack/claude-mem`)
- Bun runtime installed

## Install

1. Verify prerequisites:
   ```bash
   ls /root/.claude-mem/claude-mem.db
   ls /root/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/worker-service.cjs 2>/dev/null | head -1
   BUN_PATH=$(which bun 2>/dev/null || echo "/root/.bun/bin/bun")
   $BUN_PATH --version
   ```
   If the database does not exist, stop and tell the user to install claude-mem first.

2. Kill orphaned worker processes:
   ```bash
   pkill -f 'worker-service.cjs.*--daemon' 2>/dev/null || true
   sleep 2
   curl -s --max-time 2 http://127.0.0.1:37777/api/health >/dev/null 2>&1 && echo "WARNING: Port 37777 still in use" || echo "Port 37777 is free"
   ```

3. Install socat:
   ```bash
   which socat >/dev/null 2>&1 && echo "socat already installed" || (apt-get update && apt-get install -y socat)
   ```

4. Create wrapper scripts at `/root/.claude-mem/`:

   **`/root/.claude-mem/run-worker.sh`:**
   ```bash
   #!/bin/bash
   PLUGIN_DIR="/root/.claude/plugins/cache/thedotmack/claude-mem"
   WORKER=$(ls -td "$PLUGIN_DIR"/*/scripts/worker-service.cjs 2>/dev/null | head -1)
   if [ -z "$WORKER" ]; then
     echo "Error: claude-mem worker script not found in $PLUGIN_DIR" >&2
     exit 1
   fi
   echo "Starting worker from: $WORKER"
   exec /root/.bun/bin/bun "$WORKER" start
   ```

   **`/root/.claude-mem/stop-worker.sh`:**
   ```bash
   #!/bin/bash
   PLUGIN_DIR="/root/.claude/plugins/cache/thedotmack/claude-mem"
   WORKER=$(ls -td "$PLUGIN_DIR"/*/scripts/worker-service.cjs 2>/dev/null | head -1)
   if [ -z "$WORKER" ]; then
     curl -s -X POST http://127.0.0.1:37777/api/admin/shutdown 2>/dev/null
     exit 0
   fi
   exec /root/.bun/bin/bun "$WORKER" stop
   ```

   Make executable: `chmod +x /root/.claude-mem/run-worker.sh /root/.claude-mem/stop-worker.sh`

5. Create systemd service for claude-mem worker at `/etc/systemd/system/claude-mem-worker.service`:
   ```ini
   [Unit]
   Description=Claude-Mem Worker Daemon
   After=network.target

   [Service]
   Type=oneshot
   RemainAfterExit=yes
   ExecStart=/root/.claude-mem/run-worker.sh
   ExecStop=/root/.claude-mem/stop-worker.sh
   WorkingDirectory=/root/.claude-mem
   Environment=HOME=/root
   Environment=PATH=/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin

   [Install]
   WantedBy=multi-user.target
   ```

6. Create systemd service for socat bridge at `/etc/systemd/system/claude-mem-bridge.service`:
   ```ini
   [Unit]
   Description=Claude-Mem Docker Bridge (socat)
   After=claude-mem-worker.service docker.service
   Requires=claude-mem-worker.service

   [Service]
   Type=simple
   ExecStart=/usr/bin/socat TCP-LISTEN:37777,bind=172.17.0.1,reuseaddr,fork TCP:127.0.0.1:37777
   Restart=always
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```

7. Enable and start services:
   ```bash
   systemctl daemon-reload
   systemctl enable claude-mem-worker claude-mem-bridge
   systemctl start claude-mem-worker
   sleep 3
   curl -s http://127.0.0.1:37777/api/health
   systemctl start claude-mem-bridge
   ```

8. Test connectivity from a container:
   ```bash
   docker run --rm --entrypoint node nanoclaw-agent:latest \
     -e "fetch('http://172.17.0.1:37777/api/health').then(r=>r.json()).then(d=>console.log('OK:',JSON.stringify(d))).catch(e=>console.error('FAIL:',e.message))"
   ```

9. Add environment variable:
   ```bash
   grep -q "^CLAUDE_MEM_URL=" .env 2>/dev/null || echo "CLAUDE_MEM_URL=http://172.17.0.1:37777" >> .env
   ```

10. Copy plugin files:
    ```bash
    cp -r .claude/skills/add-skill-claude-mem/files/ plugins/claude-mem/
    ```

11. Rebuild and restart:
    ```bash
    npm run build
    systemctl restart nanoclaw
    ```

## Verify

Tell the user:
> Setup is complete. Test it by sending a WhatsApp message like "remember that my favorite coffee is a flat white" and then in a new conversation ask "what's my favorite coffee?"

## Version Management

The wrapper scripts dynamically resolve the plugin version at runtime. After upgrading:
```bash
systemctl stop claude-mem-worker
pkill -f 'worker-service.cjs' 2>/dev/null; sleep 2
systemctl start claude-mem-worker
```

## Troubleshooting

- **Worker not starting:** `journalctl -u claude-mem-worker -f` and check `/root/.claude-mem/logs/`
- **Bridge not working:** Verify Docker bridge IP: `docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`
- **Port conflict:** `lsof -i :37777` -- kill orphaned workers first
- **Services status:** `systemctl status claude-mem-worker claude-mem-bridge`

## Uninstall

1. Stop the services:
   ```bash
   sudo systemctl stop claude-mem-bridge claude-mem-worker
   sudo systemctl disable claude-mem-bridge claude-mem-worker
   ```

2. Remove the plugin:
   ```bash
   rm -rf plugins/claude-mem/
   ```

3. Remove `CLAUDE_MEM_URL` from `.env`

4. Rebuild and restart NanoClaw

**Warning:** Do NOT delete `/root/.claude-mem/`. This directory contains the shared memory database used by both the host and container agents. Removing the plugin only stops container access — the host's claude-mem continues to function independently.
