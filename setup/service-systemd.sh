#!/usr/bin/env bash
# setup/service-systemd.sh — write ~/.config/systemd/user/nanotars.service and
# enable+start it. Linux only. Falls back to a nohup wrapper on WSL or hosts
# without a systemd-user session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/log.sh
source "$SCRIPT_DIR/lib/log.sh"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

if [ "$PLATFORM" != "linux" ]; then
  log_error "service-systemd.sh is Linux-only (PLATFORM=$PLATFORM). Use service-launchd.sh on macOS."
  exit 1
fi

NODE_PATH="$(command -v node)"
LOGS_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOGS_DIR"

if [ -z "$NODE_PATH" ]; then
  log_error "node not found on PATH — install-node.sh must run first."
  exit 1
fi

write_nohup_wrapper() {
  WRAPPER="$PROJECT_ROOT/start-nanotars.sh"
  PIDFILE="$PROJECT_ROOT/nanotars.pid"
  log_step "Writing nohup wrapper ${WRAPPER}"
  cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# start-nanotars.sh — fallback launcher when systemd-user isn't available.
# Stop with: kill \$(cat "${PIDFILE}")
set -euo pipefail
cd "${PROJECT_ROOT}"
if [ -f "${PIDFILE}" ]; then
  OLD=\$(cat "${PIDFILE}" 2>/dev/null || echo "")
  if [ -n "\$OLD" ] && kill -0 "\$OLD" 2>/dev/null; then
    echo "Stopping existing nanotars (PID \$OLD)..."
    kill "\$OLD" 2>/dev/null || true
    sleep 2
  fi
fi
echo "Starting nanotars..."
nohup "${NODE_PATH}" "${PROJECT_ROOT}/dist/index.js" \\
  >> "${PROJECT_ROOT}/logs/nanotars.log" \\
  2>> "${PROJECT_ROOT}/logs/nanotars.error.log" &
echo \$! > "${PIDFILE}"
echo "nanotars started (PID \$!)"
echo "Logs: tail -f ${PROJECT_ROOT}/logs/nanotars.log"
EOF
  chmod +x "$WRAPPER"
  log_info "nohup wrapper ready — start with: bash ${WRAPPER}"
  echo "STATUS: success"
  echo "SERVICE_TYPE: nohup"
  echo "WRAPPER_PATH: $WRAPPER"
}

if [ "$SERVICE_MANAGER" != "systemd-user" ]; then
  log_warn "systemd-user not available (SERVICE_MANAGER=$SERVICE_MANAGER); writing nohup fallback"
  write_nohup_wrapper
  exit 0
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_NAME="nanotars"
UNIT_PATH="$UNIT_DIR/${UNIT_NAME}.service"

mkdir -p "$UNIT_DIR"

log_step "Writing ${UNIT_PATH}"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Nanotars Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${NODE_PATH} ${PROJECT_ROOT}/dist/index.js
WorkingDirectory=${PROJECT_ROOT}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin
EnvironmentFile=-${PROJECT_ROOT}/.env
StandardOutput=append:${PROJECT_ROOT}/logs/nanotars.log
StandardError=append:${PROJECT_ROOT}/logs/nanotars.error.log

[Install]
WantedBy=default.target
EOF

# Enable lingering so the service survives SSH logout.
loginctl enable-linger "$USER" 2>/dev/null || \
  log_warn "loginctl enable-linger failed — service may stop on logout"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"
# restart (not start) so config changes take effect on a re-run.
systemctl --user restart "$UNIT_NAME"

if systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
  log_info "Service ${UNIT_NAME} active"
  echo "STATUS: success"
  echo "SERVICE_TYPE: systemd-user"
  echo "UNIT_PATH: $UNIT_PATH"
else
  log_error "systemctl --user is-active reports inactive — check journalctl --user -u ${UNIT_NAME}"
  echo "STATUS: failed"
  exit 1
fi
