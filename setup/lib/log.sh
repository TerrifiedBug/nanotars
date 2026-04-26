#!/usr/bin/env bash
# setup/lib/log.sh — logging helpers shared by install.sh, setup.sh, and the
# per-prereq scripts under setup/. Source this file; do not execute it.
#
# Public API:
#   log_init <path>      — set the destination file (default: logs/setup.log)
#   log_info <msg...>    — info line (timestamped, written to file + stdout)
#   log_warn <msg...>    — warn line (yellow if tty)
#   log_error <msg...>   — error line (red if tty), still exits 0
#   log_step <msg...>    — section header (bold), no timestamp on stdout
#
# Honours NO_COLOR and non-tty stdout (no ANSI codes when redirected/piped).

NANOTARS_LOG_FILE="${NANOTARS_LOG_FILE:-}"

_log_use_color() {
  [ -t 1 ] && [ -z "${NO_COLOR:-}" ]
}

_log_color() {
  local code=$1; shift
  if _log_use_color; then
    printf '\033[%sm%s\033[0m' "$code" "$*"
  else
    printf '%s' "$*"
  fi
}

log_init() {
  NANOTARS_LOG_FILE="$1"
  mkdir -p "$(dirname "$NANOTARS_LOG_FILE")"
  : > "$NANOTARS_LOG_FILE" 2>/dev/null || true
}

_log_emit() {
  local level=$1; shift
  local color=$1; shift
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  local line="[${ts}] [${level}] $*"
  if [ -n "${NANOTARS_LOG_FILE}" ]; then
    echo "$line" >> "$NANOTARS_LOG_FILE" 2>/dev/null || true
  fi
  printf '%s %s\n' "$(_log_color "$color" "[$level]")" "$*"
}

log_info()  { _log_emit info  "0;36" "$*"; }
log_warn()  { _log_emit warn  "0;33" "$*"; }
log_error() { _log_emit error "0;31" "$*" >&2; }

log_step() {
  if _log_use_color; then
    printf '\n\033[1;36m== %s ==\033[0m\n' "$*"
  else
    printf '\n== %s ==\n' "$*"
  fi
  if [ -n "${NANOTARS_LOG_FILE}" ]; then
    echo "" >> "$NANOTARS_LOG_FILE" 2>/dev/null || true
    echo "== $* ==" >> "$NANOTARS_LOG_FILE" 2>/dev/null || true
  fi
}
