#!/usr/bin/env bash
# nanotars.sh — user-facing service-mgmt wrapper. Thin shim over launchctl /
# systemctl --user / nohup-wrapper depending on platform.
#
# Subcommands:
#   start   — start the service
#   stop    — stop the service
#   restart — restart the service
#   status  — service + dependency snapshot (calls setup/probe.sh)
#   logs    — tail -f logs/nanotars.log

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=setup/lib/log.sh
source "$PROJECT_ROOT/setup/lib/log.sh"
# shellcheck source=setup/lib/platform.sh
source "$PROJECT_ROOT/setup/lib/platform.sh"

LABEL_LAUNCHD="com.nanotars"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL_LAUNCHD}.plist"
UNIT_NAME="nanotars"
WRAPPER_PATH="$PROJECT_ROOT/start-nanotars.sh"
PIDFILE="$PROJECT_ROOT/nanotars.pid"

usage() {
  cat <<EOF
Usage: bash nanotars.sh <command>

Commands:
  start    Start the nanotars service
  stop     Stop the nanotars service
  restart  Restart the nanotars service
  status   Show service + dependency status
  logs     Tail logs/nanotars.log
EOF
}

cmd_start() {
  case "$SERVICE_MANAGER" in
    launchd)
      [ -f "$PLIST_PATH" ] || { log_error "$PLIST_PATH not found — run setup.sh first"; exit 1; }
      launchctl load "$PLIST_PATH" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/${LABEL_LAUNCHD}"
      ;;
    systemd-user)
      systemctl --user start "$UNIT_NAME"
      ;;
    nohup)
      [ -x "$WRAPPER_PATH" ] || { log_error "$WRAPPER_PATH not found — run setup.sh first"; exit 1; }
      bash "$WRAPPER_PATH"
      ;;
  esac
  log_info "started"
}

cmd_stop() {
  case "$SERVICE_MANAGER" in
    launchd)
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      ;;
    systemd-user)
      systemctl --user stop "$UNIT_NAME"
      ;;
    nohup)
      if [ -f "$PIDFILE" ]; then
        PID="$(cat "$PIDFILE" 2>/dev/null || echo "")"
        [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
        rm -f "$PIDFILE"
      fi
      ;;
  esac
  log_info "stopped"
}

cmd_restart() {
  case "$SERVICE_MANAGER" in
    launchd)
      launchctl kickstart -k "gui/$(id -u)/${LABEL_LAUNCHD}"
      ;;
    systemd-user)
      systemctl --user restart "$UNIT_NAME"
      ;;
    nohup)
      cmd_stop
      cmd_start
      ;;
  esac
  log_info "restarted"
}

cmd_status() {
  case "$SERVICE_MANAGER" in
    launchd)
      if launchctl list 2>/dev/null | grep -q "$LABEL_LAUNCHD"; then
        log_info "launchd: ${LABEL_LAUNCHD} loaded"
      else
        log_warn "launchd: ${LABEL_LAUNCHD} not loaded"
      fi
      ;;
    systemd-user)
      if systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
        log_info "systemd-user: ${UNIT_NAME} active"
      else
        log_warn "systemd-user: ${UNIT_NAME} not active"
      fi
      ;;
    nohup)
      if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        log_info "nohup: PID $(cat "$PIDFILE") running"
      else
        log_warn "nohup: not running"
      fi
      ;;
  esac
  if [ -x "$PROJECT_ROOT/setup/probe.sh" ] || [ -f "$PROJECT_ROOT/setup/probe.sh" ]; then
    echo
    bash "$PROJECT_ROOT/setup/probe.sh" || true
  fi
}

cmd_logs() {
  LOG="$PROJECT_ROOT/logs/nanotars.log"
  ERR="$PROJECT_ROOT/logs/nanotars.error.log"

  # If main log doesn't exist yet, fall through to error-log diagnostics.
  if [ ! -f "$LOG" ] && [ ! -f "$ERR" ]; then
    log_warn "$LOG not present — service may not have started"
    exit 0
  fi

  # If main log is empty but error log has content, the service crashed
  # before producing any normal output. Show the error log instead.
  if [ ! -s "$LOG" ] && [ -f "$ERR" ] && [ -s "$ERR" ]; then
    log_warn "$LOG is empty; service likely crashed at start. Last 30 lines of $ERR:"
    echo "----------------------------------------------------------------"
    tail -n 30 "$ERR"
    echo "----------------------------------------------------------------"
    if [ -f "$PIDFILE" ]; then
      PID="$(cat "$PIDFILE" 2>/dev/null || echo "")"
      if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
        log_warn "PID $PID in $PIDFILE is no longer running. Run: bash nanotars.sh start"
      fi
    fi
    exit 0
  fi

  tail -f "$LOG"
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  ""|-h|--help|help) usage ;;
  *)       usage; exit 1 ;;
esac
