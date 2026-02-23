# NanoClaw Troubleshooting Guide

Quick reference for common issues. For interactive debugging, use `/nanoclaw-debug`.

## Quick Diagnosis

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Bot not responding | Service not running | `sudo systemctl status nanoclaw` |
| "Container timeout" in logs | Agent SDK hanging | Check auth token, increase timeout |
| Messages queuing up | Too many concurrent containers | Check `MAX_CONCURRENT_CONTAINERS` in `.env` |
| "EACCES permission denied" | Docker bind mount permissions | `chown -R 1000:1000 groups/` |
| "Raw mode not supported" | OAuth setup needs PTY | Use `expect` script (see Auth section) |
| Plugin not loading | Missing or invalid `plugin.json` | Check `plugins/{name}/plugin.json` exists |
| WhatsApp 515 errors | Stream restart needed | Auto-reconnects; check logs |

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Clean exit | Normal |
| 1 | Error | Check container log: `groups/{folder}/logs/container-*.log` |
| 137 | SIGKILL (OOM or timeout) | Increase memory limit or timeout |
| 143 | SIGTERM (graceful stop) | Normal timeout cleanup |

## Authentication

### Claude API Token

```bash
# Check current token
grep CLAUDE_CODE_OAUTH_TOKEN .env | head -c 30
# Re-authenticate
claude setup-token
```

### WhatsApp QR Re-pairing

```bash
# Start auth server (serves QR as web page)
node src/wa-auth-server.ts
# Open http://SERVER_IP:8899 in browser, scan QR
```

## Container Issues

### Container won't start

```bash
docker info                                      # Runtime running?
docker image inspect nanoclaw-agent:latest        # Image built?
./container/build.sh                              # Rebuild if needed
```

### Container timeout

Default 5 minutes. Override per-group:
```sql
sqlite3 store/messages.db "
  UPDATE registered_groups
  SET container_config = json_set(COALESCE(container_config, '{}'), '$.timeout', 600000)
  WHERE folder = 'group-name';
"
```

## Plugin Issues

```bash
# Check plugin loads
node -e "require('./plugins/{name}/index.js')"

# Check plugin dependencies
cd plugins/{name} && npm install

# Check logs for plugin errors
grep -i "plugin.*error" logs/nanoclaw.log | tail -10
```

## Database Issues

```bash
# Integrity check
sqlite3 store/messages.db "PRAGMA integrity_check;"

# If corrupt, restore from backup
ls store/backups/
cp store/backups/messages-LATEST.db store/messages.db
```

## Service Management

### Linux (systemd)
```bash
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
sudo systemctl restart nanoclaw
sudo journalctl -u nanoclaw -f
```

### macOS (launchd)
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
tail -f logs/nanoclaw.log
```

## Log Locations

| Log | Path |
|-----|------|
| Main | `logs/nanoclaw.log` |
| Errors | `logs/nanoclaw.error.log` |
| Container | `groups/{folder}/logs/container-*.log` |
