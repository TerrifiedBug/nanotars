#!/usr/bin/env bash
# setup.sh — main installer. Run after install.sh has cloned the repo, or
# directly after a manual `git clone`. Idempotent; safe to re-run.
#
# Honours:
#   NANOTARS_SKIP_FIRST_AGENT_PROMPT=true   skip the y/N prompt at the end
#   NO_COLOR=1                              plain output
#
# Logs to logs/setup.log.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# shellcheck source=setup/lib/log.sh
source "$PROJECT_ROOT/setup/lib/log.sh"
# shellcheck source=setup/lib/platform.sh
source "$PROJECT_ROOT/setup/lib/platform.sh"

log_init "$PROJECT_ROOT/logs/setup.log"

log_step "nanotars setup"
log_info "platform: $PLATFORM (arch=$ARCH, wsl=$IS_WSL, pkg=$PKG_MANAGER, service=$SERVICE_MANAGER)"
log_info "project:  $PROJECT_ROOT"

if [ "$IS_ROOT" = "true" ] && [ "${NANOTARS_ALLOW_ROOT:-0}" != "1" ]; then
  log_error "Do not run setup.sh as root. nanotars installs per-user."
  log_error "Set NANOTARS_ALLOW_ROOT=1 if root really is your normal account on this host."
  exit 1
fi

# --- Prereqs ---

log_step "Checking prerequisites"

bash "$PROJECT_ROOT/setup/install-node.sh" || {
  log_error "install-node.sh failed"
  exit 1
}

# Ensure freshly-installed Node ends up on PATH for this shell.
hash -r 2>/dev/null || true

bash "$PROJECT_ROOT/setup/install-pnpm.sh" || {
  log_error "install-pnpm.sh failed"
  exit 1
}

# Replay the npm-prefix-on-PATH lookup that install-pnpm.sh did internally,
# in case it installed pnpm into a prefix that's not on our PATH.
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
  fi
fi

bash "$PROJECT_ROOT/setup/install-docker.sh" || {
  log_error "install-docker.sh failed — install Docker and re-run setup.sh"
  exit 1
}

# --- Host install ---

log_step "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile 2>&1 | tee -a "$PROJECT_ROOT/logs/setup.log"

log_step "Verifying better-sqlite3 native binding"
if ! node -e "require('better-sqlite3')" 2>&1 | tee -a "$PROJECT_ROOT/logs/setup.log"; then
  log_error "better-sqlite3 failed to load — check logs/setup.log"
  exit 1
fi
log_info "better-sqlite3 loads OK"

# --- Container build ---

log_step "Building agent container image (this can take a few minutes on first run)"
bash "$PROJECT_ROOT/container/build.sh" 2>&1 | tee -a "$PROJECT_ROOT/logs/setup.log"

# --- Service install ---

log_step "Installing service"
case "$PLATFORM" in
  macos) bash "$PROJECT_ROOT/setup/service-launchd.sh" ;;
  linux) bash "$PROJECT_ROOT/setup/service-systemd.sh" ;;
  *)
    log_error "Unsupported platform: $PLATFORM"
    exit 1
    ;;
esac

# --- OneCLI hint ---

if command -v onecli >/dev/null 2>&1; then
  log_info "OneCLI detected ($(onecli version 2>/dev/null | head -1))"
else
  log_info "OneCLI not detected — to enable the credential vault later, open Claude Code in this directory and run /init-onecli"
fi

# --- First-agent prompt ---

log_step "Setup complete"
cat <<EOF

  nanotars is installed and the service is running.

  Manage it with:
    bash nanotars.sh status
    bash nanotars.sh logs
    bash nanotars.sh restart

  Logs: $PROJECT_ROOT/logs/nanotars.log

EOF

FIRST_AGENT_HINT='  Bootstrap the first agent: open a Claude Code session in this directory and run:

      /nanoclaw-setup

  This walks through channel auth, main-channel selection, and verifies the agent.
'

if [ "${NANOTARS_SKIP_FIRST_AGENT_PROMPT:-}" = "true" ] || [ ! -t 0 ]; then
  printf '\n%s\n' "$FIRST_AGENT_HINT"
else
  read -r -p "  Bootstrap your first agent now? (y/N) " ANS </dev/tty
  printf '\n%s\n' "$FIRST_AGENT_HINT"
fi

log_info "setup.sh finished cleanly"
