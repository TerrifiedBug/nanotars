#!/usr/bin/env bash
# setup/probe.sh — read-only sanity check. Prints a KEY: value block; exit 0
# if every probed component is healthy, exit 1 if any is missing/broken.
#
# Used by:
#   - nanotars.sh status (cosmetic — display only)
#   - manual smoke test after setup.sh (gate the install completed)
#
# Pure-bash by design (runs even if Node/pnpm haven't installed yet); kept
# fast (<2s total).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

EXIT=0

probe() {
  local name=$1 value=$2 ok=$3
  printf '%-22s %s\n' "${name}:" "$value"
  if [ "$ok" != "true" ]; then EXIT=1; fi
}

# Node
if command -v node >/dev/null 2>&1; then
  V="$(node --version 2>/dev/null | sed 's/^v//')"
  M="$(echo "$V" | cut -d. -f1)"
  if [ "$M" -ge 20 ] 2>/dev/null; then
    probe "node" "v$V" true
  else
    probe "node" "v$V (< v20 — too old)" false
  fi
else
  probe "node" "missing" false
fi

# pnpm
if command -v pnpm >/dev/null 2>&1; then
  probe "pnpm" "v$(pnpm --version 2>/dev/null)" true
else
  probe "pnpm" "missing" false
fi

# Container runtime
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  probe "docker" "$(docker --version 2>/dev/null | head -1)" true
elif command -v docker >/dev/null 2>&1; then
  probe "docker" "installed but daemon not running" false
else
  probe "docker" "missing" false
fi

# Container image
if command -v docker >/dev/null 2>&1 && docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
  probe "agent image" "nanoclaw-agent:latest present" true
else
  probe "agent image" "missing (run ./container/build.sh)" false
fi

# Host deps
NM="$PROJECT_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ -d "$PROJECT_ROOT/node_modules" ] && [ -f "$NM" ]; then
  probe "host deps" "ok (better-sqlite3 native binding present)" true
else
  probe "host deps" "missing (run pnpm install --frozen-lockfile)" false
fi

# Service
case "$SERVICE_MANAGER" in
  launchd)
    if launchctl list 2>/dev/null | grep -q com.nanotars; then
      probe "service" "launchd: com.nanotars loaded" true
    else
      probe "service" "launchd: com.nanotars not loaded" false
    fi
    ;;
  systemd-user)
    if systemctl --user is-active nanotars >/dev/null 2>&1; then
      probe "service" "systemd-user: nanotars active" true
    else
      probe "service" "systemd-user: nanotars not active" false
    fi
    ;;
  nohup)
    PIDFILE="$PROJECT_ROOT/nanotars.pid"
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null || echo 0)" 2>/dev/null; then
      probe "service" "nohup: PID $(cat "$PIDFILE") running" true
    else
      probe "service" "nohup: not running" false
    fi
    ;;
  *)
    probe "service" "unknown SERVICE_MANAGER=$SERVICE_MANAGER" false
    ;;
esac

# OneCLI (informational — don't fail probe on absence)
if command -v onecli >/dev/null 2>&1; then
  probe "onecli" "$(onecli version 2>/dev/null | head -1)" true
else
  probe "onecli" "not installed (optional)" true
fi

exit $EXIT
