#!/usr/bin/env bash
# install.sh — one-line bootstrap for nanotars.
#
# Run via:
#   curl -fsSL https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/install.sh | bash
#
# Or locally:
#   bash install.sh
#
# Honours:
#   NANOTARS_DIR     install location (default: $HOME/nanotars)
#   NANOTARS_BRANCH  branch to check out (default: v1-archive)
#   NANOTARS_REPO    git URL (default: https://github.com/TerrifiedBug/nanotars.git)

set -euo pipefail

REPO_URL="${NANOTARS_REPO:-https://github.com/TerrifiedBug/nanotars.git}"
BRANCH="${NANOTARS_BRANCH:-v1-archive}"
TARGET_DIR="${NANOTARS_DIR:-$HOME/nanotars}"

# When piped from curl we don't have BASH_SOURCE pointing at a real file, so
# we can't rely on a sibling setup/lib. Use minimal inline logging here.
_install_color() {
  [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && printf '\033[0;36m[install]\033[0m' || printf '[install]'
}
_install_log() { printf '%s %s\n' "$(_install_color)" "$*"; }
_install_die() {
  printf '\033[0;31m[install]\033[0m %s\n' "$*" >&2
  exit 1
}

# --- pre-flight ---

if [ "$(id -u 2>/dev/null)" = "0" ] && [ "${NANOTARS_ALLOW_ROOT:-0}" != "1" ]; then
  _install_die "Do not run install.sh as root. nanotars installs per-user (\$HOME/nanotars). Re-run as your normal user, or set NANOTARS_ALLOW_ROOT=1 if root really is your normal account on this host."
fi

case "$(uname -s 2>/dev/null)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      _install_die "Unsupported platform: $(uname -s 2>/dev/null). Supported: macOS, Linux." ;;
esac

_install_log "platform: ${PLATFORM} ($(uname -m 2>/dev/null))"
_install_log "target:   ${TARGET_DIR}"
_install_log "branch:   ${BRANCH}"

for cmd in git bash; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    _install_die "Required command not found: $cmd. Install it and re-run."
  fi
done

# --- clone or reuse ---

if [ -d "$TARGET_DIR" ]; then
  if [ -d "$TARGET_DIR/.git" ]; then
    EXISTING_REMOTE="$(git -C "$TARGET_DIR" remote get-url origin 2>/dev/null || echo '')"
    case "$EXISTING_REMOTE" in
      *TerrifiedBug/nanotars*|*nanotars.git|*/nanotars)
        _install_log "existing checkout detected at ${TARGET_DIR}; running setup.sh"
        ;;
      *)
        _install_die "${TARGET_DIR} is a git checkout of '${EXISTING_REMOTE}', not nanotars. Set NANOTARS_DIR to a different path or remove the directory."
        ;;
    esac
  else
    if [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]; then
      _install_die "${TARGET_DIR} exists and is not a nanotars checkout. Set NANOTARS_DIR to a different path or remove the directory."
    fi
    _install_log "empty directory ${TARGET_DIR} — cloning into it"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET_DIR"
  fi
else
  _install_log "cloning ${REPO_URL}#${BRANCH} into ${TARGET_DIR}"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET_DIR"
fi

# --- handoff ---

if [ ! -x "$TARGET_DIR/setup.sh" ] && [ ! -f "$TARGET_DIR/setup.sh" ]; then
  _install_die "${TARGET_DIR}/setup.sh not found. Repo may be on the wrong branch (current: $(git -C "$TARGET_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null))."
fi

_install_log "handing off to setup.sh"
exec bash "$TARGET_DIR/setup.sh"
