#!/usr/bin/env bash
# setup/install-node.sh — install Node 22 LTS if missing or too old.
# Idempotent: exits 0 with STATUS: already-installed if Node ≥ 20 is present.
#
# macOS  — brew install node@22
# Linux  — NodeSource apt repo + apt install nodejs
# Other  — fail with clear error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/log.sh
source "$SCRIPT_DIR/lib/log.sh"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

REQUIRED_MAJOR=20
TARGET_MAJOR=22

if command -v node >/dev/null 2>&1; then
  CURRENT_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
  CURRENT_MAJOR="$(echo "$CURRENT_VERSION" | cut -d. -f1)"
  if [ "$CURRENT_MAJOR" -ge "$REQUIRED_MAJOR" ] 2>/dev/null; then
    log_info "Node v${CURRENT_VERSION} present (>= ${REQUIRED_MAJOR}) — skipping install"
    echo "STATUS: already-installed"
    echo "NODE_VERSION: $CURRENT_VERSION"
    exit 0
  else
    log_warn "Node v${CURRENT_VERSION} is too old (need >= ${REQUIRED_MAJOR}); installing Node ${TARGET_MAJOR}"
  fi
fi

case "$PLATFORM" in
  macos)
    if [ "$PKG_MANAGER" != "brew" ]; then
      log_error "Homebrew not found. Install brew from https://brew.sh and re-run."
      echo "STATUS: failed"
      exit 1
    fi
    log_step "brew install node@${TARGET_MAJOR}"
    brew install "node@${TARGET_MAJOR}"
    BREW_PREFIX="$(brew --prefix 2>/dev/null || echo /usr/local)"
    if [ -d "${BREW_PREFIX}/opt/node@${TARGET_MAJOR}/bin" ]; then
      export PATH="${BREW_PREFIX}/opt/node@${TARGET_MAJOR}/bin:$PATH"
      log_info "Prepended ${BREW_PREFIX}/opt/node@${TARGET_MAJOR}/bin to PATH"
    fi
    ;;
  linux)
    if [ "$PKG_MANAGER" != "apt" ]; then
      log_error "Only apt-based Linux is supported automatically. PKG_MANAGER=${PKG_MANAGER}."
      log_error "Install Node ${TARGET_MAJOR} manually (https://nodejs.org/en/download/package-manager) and re-run setup.sh."
      echo "STATUS: failed"
      exit 1
    fi
    log_step "NodeSource setup for Node ${TARGET_MAJOR}"
    curl -fsSL "https://deb.nodesource.com/setup_${TARGET_MAJOR}.x" | sudo -E bash -
    log_step "apt-get install nodejs"
    sudo apt-get install -y nodejs
    ;;
  *)
    log_error "Unsupported platform: ${PLATFORM}"
    echo "STATUS: failed"
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  log_error "Node not found on PATH after install"
  echo "STATUS: failed"
  exit 1
fi

INSTALLED_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
log_info "Node v${INSTALLED_VERSION} installed"
echo "STATUS: installed"
echo "NODE_VERSION: $INSTALLED_VERSION"
