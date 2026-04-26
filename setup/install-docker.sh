#!/usr/bin/env bash
# setup/install-docker.sh — verify a container runtime is installed AND running.
# Does NOT auto-install (Docker installation is invasive: sudo, license, restart).
# Accepts docker, podman (via docker-shim), or colima as drop-in equivalents.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/log.sh
source "$SCRIPT_DIR/lib/log.sh"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

probe_runtime() {
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      RUNTIME="docker"
      RUNTIME_VERSION="$(docker --version 2>/dev/null | head -1)"
      return 0
    fi
    RUNTIME="docker"
    RUNTIME_VERSION="$(docker --version 2>/dev/null | head -1)"
    return 1
  fi
  if command -v podman >/dev/null 2>&1; then
    RUNTIME="podman"
    RUNTIME_VERSION="$(podman --version 2>/dev/null | head -1)"
    return 1
  fi
  RUNTIME="none"
  RUNTIME_VERSION=""
  return 2
}

# Capture probe_runtime's exit status without losing it to the `if` branch.
# Disable -e for the call so a non-zero return doesn't terminate the script.
set +e
probe_runtime
PROBE_RC=$?
set -e

if [ "$PROBE_RC" -eq 0 ]; then
  log_info "${RUNTIME_VERSION} present and daemon responsive"
  echo "STATUS: already-installed"
  echo "RUNTIME: $RUNTIME"
  echo "RUNTIME_VERSION: $RUNTIME_VERSION"
  exit 0
fi

case "$PROBE_RC" in
  1)
    log_error "${RUNTIME} CLI is installed but the daemon isn't running."
    case "$PLATFORM" in
      macos)
        log_error "  Start Docker Desktop (open -a Docker), wait for the whale icon to settle, and re-run setup.sh."
        ;;
      linux)
        log_error "  Start the daemon: sudo systemctl start docker"
        log_error "  And add yourself to the docker group: sudo usermod -aG docker \$USER (then log out/in)."
        ;;
    esac
    ;;
  2)
    log_error "No container runtime found (docker / podman)."
    case "$PLATFORM" in
      macos)
        log_error "  Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
        log_error "  Or with Homebrew: brew install --cask docker"
        ;;
      linux)
        log_error "  Install Docker via the convenience script: curl -fsSL https://get.docker.com | sh"
        log_error "  Then: sudo systemctl enable --now docker && sudo usermod -aG docker \$USER"
        ;;
    esac
    ;;
esac

echo "STATUS: missing"
echo "RUNTIME: $RUNTIME"
echo "RUNTIME_VERSION: $RUNTIME_VERSION"
exit 1
