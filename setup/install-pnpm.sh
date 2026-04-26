#!/usr/bin/env bash
# setup/install-pnpm.sh — install pnpm 9.15.0 if missing or too old.
# Tries corepack first (preferred), falls back to npm install -g.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/log.sh
source "$SCRIPT_DIR/lib/log.sh"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

PINNED_VERSION="9.15.0"
REQUIRED_MAJOR=9

if command -v pnpm >/dev/null 2>&1; then
  CURRENT_VERSION="$(pnpm --version 2>/dev/null)"
  CURRENT_MAJOR="$(echo "$CURRENT_VERSION" | cut -d. -f1)"
  if [ "$CURRENT_MAJOR" -ge "$REQUIRED_MAJOR" ] 2>/dev/null; then
    log_info "pnpm v${CURRENT_VERSION} present (>= ${REQUIRED_MAJOR}) — skipping install"
    echo "STATUS: already-installed"
    echo "PNPM_VERSION: $CURRENT_VERSION"
    exit 0
  fi
  log_warn "pnpm v${CURRENT_VERSION} is too old (need >= ${REQUIRED_MAJOR}); installing pnpm@${PINNED_VERSION}"
fi

if ! command -v node >/dev/null 2>&1; then
  log_error "Node is required to install pnpm but is not on PATH. Run setup/install-node.sh first."
  echo "STATUS: failed"
  exit 1
fi

# Auto-accept corepack's first-use download prompt (would otherwise hang in
# non-tty contexts).
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if command -v corepack >/dev/null 2>&1; then
  log_step "corepack enable + prepare pnpm@${PINNED_VERSION}"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare "pnpm@${PINNED_VERSION}" --activate >/dev/null 2>&1 || true

  # Linux+sudo retry: corepack-on-system-Node may need root to write /usr/bin/pnpm.
  if ! command -v pnpm >/dev/null 2>&1 \
      && [ "$PLATFORM" = "linux" ] \
      && command -v sudo >/dev/null 2>&1; then
    log_info "pnpm not on PATH after corepack — retrying with sudo"
    sudo corepack enable >/dev/null 2>&1 || true
    sudo corepack prepare "pnpm@${PINNED_VERSION}" --activate >/dev/null 2>&1 || true
  fi
fi

# npm fallback
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  log_step "npm install -g pnpm@${PINNED_VERSION}"
  npm install -g "pnpm@${PINNED_VERSION}" \
    || ([ "$PLATFORM" = "linux" ] && command -v sudo >/dev/null 2>&1 \
         && sudo npm install -g "pnpm@${PINNED_VERSION}") \
    || true
fi

# npm-prefix-not-on-PATH recovery
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
    log_info "Prepended ${NPM_PREFIX}/bin to PATH"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log_error "pnpm not found on PATH after corepack + npm fallback"
  echo "STATUS: failed"
  exit 1
fi

INSTALLED_VERSION="$(pnpm --version 2>/dev/null)"
log_info "pnpm v${INSTALLED_VERSION} installed"
echo "STATUS: installed"
echo "PNPM_VERSION: $INSTALLED_VERSION"
