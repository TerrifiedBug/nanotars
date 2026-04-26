#!/usr/bin/env bash
# setup/lib/platform.sh — platform detection for install.sh and setup.sh.
# Sourced; do not execute. Sets globals; does not return values.
#
# After sourcing, the following are exported:
#   PLATFORM         macos | linux | unknown
#   IS_WSL           true  | false
#   IS_ROOT          true  | false
#   ARCH             arm64 | x86_64 | other
#   PKG_MANAGER      brew  | apt | dnf | unknown
#   SERVICE_MANAGER  launchd | systemd-user | nohup
#
# Detection is cheap and pure (no installs, no network); safe to source many
# times.

detect_platform() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    *)      PLATFORM=unknown ;;
  esac

  IS_WSL=false
  if [ "$PLATFORM" = "linux" ] && [ -r /proc/version ]; then
    if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL=true
    fi
  fi

  IS_ROOT=false
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    IS_ROOT=true
  fi

  case "$(uname -m 2>/dev/null)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=x86_64 ;;
    *)             ARCH=other ;;
  esac

  if   command -v brew    >/dev/null 2>&1; then PKG_MANAGER=brew
  elif command -v apt-get >/dev/null 2>&1; then PKG_MANAGER=apt
  elif command -v dnf     >/dev/null 2>&1; then PKG_MANAGER=dnf
  else                                          PKG_MANAGER=unknown
  fi

  if [ "$PLATFORM" = "macos" ]; then
    SERVICE_MANAGER=launchd
  elif [ "$PLATFORM" = "linux" ] && [ "$IS_ROOT" != "true" ] \
       && command -v systemctl >/dev/null 2>&1 \
       && systemctl --user daemon-reload >/dev/null 2>&1; then
    SERVICE_MANAGER=systemd-user
  else
    SERVICE_MANAGER=nohup
  fi

  export PLATFORM IS_WSL IS_ROOT ARCH PKG_MANAGER SERVICE_MANAGER
}

# Run detection at source time so callers don't have to remember to.
detect_platform
