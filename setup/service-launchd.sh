#!/usr/bin/env bash
# setup/service-launchd.sh — write ~/Library/LaunchAgents/com.nanotars.plist
# and reload it. macOS only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/log.sh
source "$SCRIPT_DIR/lib/log.sh"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

if [ "$PLATFORM" != "macos" ]; then
  log_error "service-launchd.sh is macOS-only (PLATFORM=$PLATFORM). Use service-systemd.sh on Linux."
  exit 1
fi

LABEL="com.nanotars"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_PATH="$(command -v node)"
LOGS_DIR="$PROJECT_ROOT/logs"

if [ -z "$NODE_PATH" ]; then
  log_error "node not found on PATH — install-node.sh must run first."
  exit 1
fi

mkdir -p "$LOGS_DIR" "$(dirname "$PLIST_PATH")"

log_step "Writing ${PLIST_PATH}"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_ROOT}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_ROOT}/logs/nanotars.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_ROOT}/logs/nanotars.error.log</string>
</dict>
</plist>
EOF

# unload always succeeds (or noops) — load fails if already loaded with stale plist.
launchctl unload "$PLIST_PATH" 2>/dev/null || true
log_step "launchctl load ${PLIST_PATH}"
launchctl load "$PLIST_PATH"

if launchctl list | grep -q "$LABEL"; then
  log_info "Service ${LABEL} loaded"
  echo "STATUS: success"
  echo "SERVICE_TYPE: launchd"
  echo "PLIST_PATH: $PLIST_PATH"
else
  log_error "launchctl load did not register ${LABEL}"
  echo "STATUS: failed"
  exit 1
fi
