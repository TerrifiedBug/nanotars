# Setup script port (lean bash-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** Land a bash-only one-line installer + service-mgmt wrapper for v1-archive nanotars. After this plan, `curl -fsSL .../install.sh | bash` produces a running service on macOS launchd or Linux systemd-user. No TS UI, no per-channel installers, no PostHog.

**Architecture:** 12 tasks → 12 commits → 11 new files + 1 README edit. Each task is independent enough to be a stand-alone commit. Tasks 6 and 11 are the only ones with optional sub-test requirements; the rest are content-only.

**Tech Stack:** Pure bash (no Node, no pnpm, no TS at the script layer). Tests via bash assertions, run by the existing `pnpm test:bash` target. Pinned versions: Node 22 LTS, pnpm 9.15.0.

**Spec input:** `/data/nanotars/docs/superpowers/specs/2026-04-26-setup-script-port.md`

---

## Pre-flight verification

- [ ] **Step 1: Clean tree on `v1-archive`, Phase 5 complete**

```
cd /data/nanotars && git status --short --branch && git log --oneline -3
```

Expected: clean tree on `v1-archive`. HEAD is `f1e2594` or later (last commit on Phase 5: `fix(container): cast Task PreToolUse hook to HookCallback`).

- [ ] **Step 2: Setup-script files do not already exist**

```
cd /data/nanotars && ls install.sh setup.sh nanotars.sh setup/ 2>&1
```

Expected: all four `ls: cannot access` errors. If any of `install.sh`, `setup.sh`, `nanotars.sh`, or `setup/` already exist, STOP and ask before proceeding — the plan assumes greenfield.

- [ ] **Step 3: Container build script unchanged**

```
cd /data/nanotars && ls -la container/build.sh
```

Expected: file present, executable. The plan does NOT modify `container/build.sh` — `setup.sh` only calls it.

- [ ] **Step 4: Existing test:bash target works**

```
cd /data/nanotars && pnpm run test:bash 2>&1 | tail -10
```

Expected: passes (no setup tests yet — only existing `container/__tests__/*.test.sh`).

---

## Task 1: `setup/lib/platform.sh` and `setup/lib/log.sh`

**Files:** `/data/nanotars/setup/lib/platform.sh` (new), `/data/nanotars/setup/lib/log.sh` (new)

Sourced by every other setup script. Must be self-contained (no deps on each other beyond `log.sh` being optionally loaded by `platform.sh`).

- [ ] **Step 1: Create `setup/lib/log.sh`**

```bash
mkdir -p /data/nanotars/setup/lib
```

Then write `/data/nanotars/setup/lib/log.sh` with this exact content:

```bash
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
```

- [ ] **Step 2: Create `setup/lib/platform.sh`**

Write `/data/nanotars/setup/lib/platform.sh` with this exact content:

```bash
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
```

- [ ] **Step 3: Verify both files parse**

```
cd /data/nanotars && bash -n setup/lib/log.sh && bash -n setup/lib/platform.sh && echo OK
```

Expected: `OK`. Any syntax error → fix before commit.

- [ ] **Step 4: Verify platform detection runs cleanly**

```
cd /data/nanotars && bash -c 'source setup/lib/platform.sh && echo "P=$PLATFORM W=$IS_WSL R=$IS_ROOT A=$ARCH PM=$PKG_MANAGER SM=$SERVICE_MANAGER"'
```

Expected (in this Linux container): `P=linux W=false R=true A=x86_64 PM=apt SM=nohup` (root user, so no systemd-user). Values vary by host — what matters is no error and all six vars populated.

- [ ] **Step 5: Commit**

```
cd /data/nanotars && git add setup/lib/log.sh setup/lib/platform.sh && git commit -m "feat(setup): add platform detection + log helpers (setup/lib)"
```

---

## Task 2: `install.sh` (wget-able bootstrap)

**Files:** `/data/nanotars/install.sh` (new)

Pure-bash entry. Detects platform, refuses root, clones the repo if absent, hands off to `setup.sh`.

- [ ] **Step 1: Create `install.sh`**

Write `/data/nanotars/install.sh` with this exact content:

```bash
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

if [ "$(id -u 2>/dev/null)" = "0" ]; then
  _install_die "Do not run install.sh as root. nanotars installs per-user (\$HOME/nanotars). Re-run as your normal user."
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
```

- [ ] **Step 2: Make it executable + parse-check**

```
cd /data/nanotars && chmod +x install.sh && bash -n install.sh && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Smoke test the help-path (no clone)**

```
cd /data/nanotars && NANOTARS_DIR=/data/nanotars bash install.sh 2>&1 | head -10
```

Expected: detects existing checkout (because `/data/nanotars` IS a nanotars checkout), prints "existing checkout detected", then fails because `setup.sh` doesn't exist yet (next task creates it). The error message should be exactly: `${TARGET_DIR}/setup.sh not found.` — that's the expected behaviour at this stage.

- [ ] **Step 4: Commit**

```
cd /data/nanotars && git add install.sh && git commit -m "feat(setup): add install.sh wget-able bootstrap"
```

---

## Task 3: `setup/install-node.sh`

**Files:** `/data/nanotars/setup/install-node.sh` (new)

Idempotent Node 22 install via brew or NodeSource apt. Sourced helpers from `setup/lib/`.

- [ ] **Step 1: Create the script**

Write `/data/nanotars/setup/install-node.sh` with this exact content:

```bash
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
```

- [ ] **Step 2: Parse-check + idempotent dry-run**

```
cd /data/nanotars && chmod +x setup/install-node.sh && bash -n setup/install-node.sh
```

If Node ≥ 20 is present in the environment, run it for the idempotent path:

```
cd /data/nanotars && bash setup/install-node.sh 2>&1 | tail -5
```

Expected: ends with `STATUS: already-installed` and `NODE_VERSION: …`.

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add setup/install-node.sh && git commit -m "feat(setup): add install-node.sh (Node 22 LTS, idempotent)"
```

---

## Task 4: `setup/install-pnpm.sh`

**Files:** `/data/nanotars/setup/install-pnpm.sh` (new)

Install pnpm 9.15.0 via corepack, falling back to `npm install -g`. Mirrors v2's `setup.sh` install_deps function but as a standalone script.

- [ ] **Step 1: Create the script**

Write `/data/nanotars/setup/install-pnpm.sh` with this exact content:

```bash
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
```

- [ ] **Step 2: Parse-check**

```
cd /data/nanotars && chmod +x setup/install-pnpm.sh && bash -n setup/install-pnpm.sh && echo OK
```

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add setup/install-pnpm.sh && git commit -m "feat(setup): add install-pnpm.sh (pnpm 9.15.0, idempotent)"
```

---

## Task 5: `setup/install-docker.sh`

**Files:** `/data/nanotars/setup/install-docker.sh` (new)

Docker is presence-check + instructions only. Auto-install is too invasive (sudo, license dialogs, kernel module compatibility) and the Docker installer's UX is already good.

- [ ] **Step 1: Create the script**

Write `/data/nanotars/setup/install-docker.sh` with this exact content:

```bash
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

if probe_runtime; then
  log_info "${RUNTIME_VERSION} present and daemon responsive"
  echo "STATUS: already-installed"
  echo "RUNTIME: $RUNTIME"
  echo "RUNTIME_VERSION: $RUNTIME_VERSION"
  exit 0
fi

PROBE_RC=$?

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
```

- [ ] **Step 2: Parse-check**

```
cd /data/nanotars && chmod +x setup/install-docker.sh && bash -n setup/install-docker.sh && echo OK
```

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add setup/install-docker.sh && git commit -m "feat(setup): add install-docker.sh (presence check + install hints)"
```

---

## Task 6: Service install scripts (launchd + systemd)

**Files:**
- `/data/nanotars/setup/service-launchd.sh` (new)
- `/data/nanotars/setup/service-systemd.sh` (new)

- [ ] **Step 1: Create `setup/service-launchd.sh`**

Write `/data/nanotars/setup/service-launchd.sh` with this exact content:

```bash
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
```

- [ ] **Step 2: Create `setup/service-systemd.sh`**

Write `/data/nanotars/setup/service-systemd.sh` with this exact content:

```bash
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
```

- [ ] **Step 3: Parse-check both**

```
cd /data/nanotars && chmod +x setup/service-launchd.sh setup/service-systemd.sh \
  && bash -n setup/service-launchd.sh \
  && bash -n setup/service-systemd.sh \
  && echo OK
```

- [ ] **Step 4: Commit**

```
cd /data/nanotars && git add setup/service-launchd.sh setup/service-systemd.sh && git commit -m "feat(setup): add service-launchd.sh + service-systemd.sh (with WSL nohup fallback)"
```

---

## Task 7: `setup.sh` (orchestrator)

**Files:** `/data/nanotars/setup.sh` (new)

Sequences install-node → install-pnpm → install-docker → `pnpm install --frozen-lockfile` → `./container/build.sh` → service install → optional first-agent prompt.

- [ ] **Step 1: Create `setup.sh`**

Write `/data/nanotars/setup.sh` with this exact content:

```bash
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

if [ "$IS_ROOT" = "true" ]; then
  log_error "Do not run setup.sh as root. nanotars installs per-user."
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
```

- [ ] **Step 2: Parse-check**

```
cd /data/nanotars && chmod +x setup.sh && bash -n setup.sh && echo OK
```

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add setup.sh && git commit -m "feat(setup): add setup.sh orchestrator (prereqs + pnpm install + container build + service)"
```

---

## Task 8: `nanotars.sh` (service-mgmt wrapper)

**Files:** `/data/nanotars/nanotars.sh` (new)

User-facing thin wrapper: `start | stop | restart | status | logs`.

- [ ] **Step 1: Create the script**

Write `/data/nanotars/nanotars.sh` with this exact content:

```bash
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
  [ -f "$LOG" ] || { log_warn "$LOG not yet present — service may not have started"; exit 0; }
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
```

- [ ] **Step 2: Parse-check + dry-run usage**

```
cd /data/nanotars && chmod +x nanotars.sh && bash -n nanotars.sh && bash nanotars.sh help | head -5
```

Expected: prints `Usage: bash nanotars.sh <command>` and the command list.

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add nanotars.sh && git commit -m "feat(setup): add nanotars.sh service-mgmt wrapper (start/stop/restart/status/logs)"
```

---

## Task 9: `setup/probe.sh` (post-install sanity check)

**Files:** `/data/nanotars/setup/probe.sh` (new)

Read-only system probe — used by `nanotars.sh status` and as a manual smoke test after `setup.sh`.

- [ ] **Step 1: Create the script**

Write `/data/nanotars/setup/probe.sh` with this exact content:

```bash
#!/usr/bin/env bash
# setup/probe.sh — read-only sanity check. Prints a KEY: value block; exit 0
# if every probed component is healthy, exit 1 if any is missing/broken.
#
# Used by:
#   - nanotars.sh status (cosmetic — display only)
#   - manual smoke test after setup.sh (gate the install completed)
#
# Pure-bash by design (runs even if Node/pnpm haven't installed yet); kept
# fast (<2s total).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

EXIT=0

probe() {
  local name=$1 value=$2 ok=$3
  printf '%-22s %s\n' "${name}:" "$value"
  if [ "$ok" != "true" ]; then EXIT=1; fi
}

# Node
if command -v node >/dev/null 2>&1; then
  V="$(node --version 2>/dev/null | sed 's/^v//')"
  M="$(echo "$V" | cut -d. -f1)"
  if [ "$M" -ge 20 ] 2>/dev/null; then
    probe "node" "v$V" true
  else
    probe "node" "v$V (< v20 — too old)" false
  fi
else
  probe "node" "missing" false
fi

# pnpm
if command -v pnpm >/dev/null 2>&1; then
  probe "pnpm" "v$(pnpm --version 2>/dev/null)" true
else
  probe "pnpm" "missing" false
fi

# Container runtime
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  probe "docker" "$(docker --version 2>/dev/null | head -1)" true
elif command -v docker >/dev/null 2>&1; then
  probe "docker" "installed but daemon not running" false
else
  probe "docker" "missing" false
fi

# Container image
if command -v docker >/dev/null 2>&1 && docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
  probe "agent image" "nanoclaw-agent:latest present" true
else
  probe "agent image" "missing (run ./container/build.sh)" false
fi

# Host deps
NM="$PROJECT_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ -d "$PROJECT_ROOT/node_modules" ] && [ -f "$NM" ]; then
  probe "host deps" "ok (better-sqlite3 native binding present)" true
else
  probe "host deps" "missing (run pnpm install --frozen-lockfile)" false
fi

# Service
case "$SERVICE_MANAGER" in
  launchd)
    if launchctl list 2>/dev/null | grep -q com.nanotars; then
      probe "service" "launchd: com.nanotars loaded" true
    else
      probe "service" "launchd: com.nanotars not loaded" false
    fi
    ;;
  systemd-user)
    if systemctl --user is-active nanotars >/dev/null 2>&1; then
      probe "service" "systemd-user: nanotars active" true
    else
      probe "service" "systemd-user: nanotars not active" false
    fi
    ;;
  nohup)
    PIDFILE="$PROJECT_ROOT/nanotars.pid"
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null || echo 0)" 2>/dev/null; then
      probe "service" "nohup: PID $(cat "$PIDFILE") running" true
    else
      probe "service" "nohup: not running" false
    fi
    ;;
  *)
    probe "service" "unknown SERVICE_MANAGER=$SERVICE_MANAGER" false
    ;;
esac

# OneCLI (informational — don't fail probe on absence)
if command -v onecli >/dev/null 2>&1; then
  probe "onecli" "$(onecli version 2>/dev/null | head -1)" true
else
  probe "onecli" "not installed (optional)" true
fi

exit $EXIT
```

- [ ] **Step 2: Parse-check + run-against-current-host**

```
cd /data/nanotars && chmod +x setup/probe.sh && bash -n setup/probe.sh && bash setup/probe.sh
```

Expected: prints the KEY: value block. Exit code may be 0 or 1 depending on this host's state — that's fine for now; the script itself is correct if it parses + prints.

- [ ] **Step 3: Commit**

```
cd /data/nanotars && git add setup/probe.sh && git commit -m "feat(setup): add probe.sh post-install sanity check"
```

---

## Task 10: README.md update

**Files:** `/data/nanotars/README.md` (edit)

Add the one-liner install command and the manual install path at the top, before the existing content. Add an Uninstall block at the bottom.

- [ ] **Step 1: Read the current README to find the insertion points**

```
cd /data/nanotars && head -40 README.md && echo '---' && tail -20 README.md
```

- [ ] **Step 2: Insert one-liner block near the top**

Find the existing "Quick Start" or first H2 (`## `) heading. Above it, insert this block (use the Edit tool to do it precisely; do NOT clobber existing content):

```markdown
## Install

**One-liner (macOS or Linux):**

```bash
curl -fsSL https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/install.sh | bash
```

This clones into `$HOME/nanotars` (override with `NANOTARS_DIR`), installs Node 22 + pnpm + verifies Docker, builds the agent container, writes a launchd plist (macOS) or systemd-user unit (Linux), and starts the service.

**Manual install:**

```bash
git clone -b v1-archive https://github.com/TerrifiedBug/nanotars.git
cd nanotars
bash setup.sh
```

**After install — manage the service:**

```bash
bash nanotars.sh status     # health check
bash nanotars.sh logs       # tail logs
bash nanotars.sh restart    # restart
```

**Bootstrap the first agent:** open a Claude Code session in the install directory and run `/nanoclaw-setup`.
```

- [ ] **Step 3: Insert Uninstall section near the bottom**

Append (or insert before any "License" section, if present) this block:

```markdown
## Uninstall

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanotars.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.nanotars.plist
rm -rf "${NANOTARS_DIR:-$HOME/nanotars}"

# Linux
systemctl --user disable --now nanotars 2>/dev/null
rm -f ~/.config/systemd/user/nanotars.service
systemctl --user daemon-reload
rm -rf "${NANOTARS_DIR:-$HOME/nanotars}"
```
```

- [ ] **Step 4: Commit**

```
cd /data/nanotars && git add README.md && git commit -m "docs: install + uninstall instructions for setup.sh / nanotars.sh"
```

---

## Task 11: Platform-detection unit test

**Files:** `/data/nanotars/setup/__tests__/platform.test.sh` (new)

Bash-on-bash unit test. Mocks `uname` and `/proc/version` via shimmed `PATH` to verify `detect_platform` produces the expected globals on each platform fixture.

- [ ] **Step 1: Create test directory + script**

```
mkdir -p /data/nanotars/setup/__tests__
```

Write `/data/nanotars/setup/__tests__/platform.test.sh` with this exact content:

```bash
#!/usr/bin/env bash
# setup/__tests__/platform.test.sh — unit test for setup/lib/platform.sh.
# Mocks `uname` via a temporary shim on PATH; mocks /proc/version by setting
# a sentinel via custom probe (not /proc itself, which we can't write to).
#
# Run with: bash setup/__tests__/platform.test.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$PROJECT_ROOT/setup/lib/platform.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

assert_eq() {
  local name=$1 want=$2 got=$3
  if [ "$want" = "$got" ]; then
    printf '  PASS  %s (got=%s)\n' "$name" "$got"
    PASS=$((PASS+1))
  else
    printf '  FAIL  %s (want=%s got=%s)\n' "$name" "$want" "$got"
    FAIL=$((FAIL+1))
  fi
}

# Build a uname shim that prints whatever we set in $UNAME_S / $UNAME_M.
make_uname_shim() {
  local dir=$1
  mkdir -p "$dir"
  cat > "$dir/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "${UNAME_S:-Linux}" ;;
  -m) echo "${UNAME_M:-x86_64}" ;;
  *)  echo "${UNAME_S:-Linux}" ;;
esac
EOF
  chmod +x "$dir/uname"
}

run_case() {
  local name=$1 expected_platform=$2
  shift 2
  local shim_dir="$TMP/$name"
  make_uname_shim "$shim_dir"
  PATH="$shim_dir:$PATH" UNAME_S="$3" UNAME_M="$4" bash -c "
    source '$LIB'
    echo \"PLATFORM=\$PLATFORM\"
    echo \"ARCH=\$ARCH\"
  " > "$TMP/$name.out"

  local got_platform got_arch
  got_platform="$(grep '^PLATFORM=' "$TMP/$name.out" | cut -d= -f2)"
  got_arch="$(grep '^ARCH=' "$TMP/$name.out" | cut -d= -f2)"
  assert_eq "$name PLATFORM" "$expected_platform" "$got_platform"
  assert_eq "$name ARCH" "$5" "$got_arch"
}

echo "Running platform.test.sh"
echo

run_case "macos_arm64"  "macos"   "Darwin" "arm64"  "arm64"
run_case "macos_x86"    "macos"   "Darwin" "x86_64" "x86_64"
run_case "linux_x86"    "linux"   "Linux"  "x86_64" "x86_64"
run_case "linux_arm64"  "linux"   "Linux"  "aarch64" "arm64"
run_case "freebsd_x86"  "unknown" "FreeBSD" "x86_64" "x86_64"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run the test**

```
cd /data/nanotars && bash setup/__tests__/platform.test.sh
```

Expected: 10 PASS lines (5 cases × 2 assertions each), `Results: 10 passed, 0 failed`, exit 0.

- [ ] **Step 3: Wire the test into `pnpm test:bash`**

Verify the existing target picks up `setup/__tests__/*.test.sh`:

```
cd /data/nanotars && grep -A1 '"test:bash"' package.json
```

Current target only globs `container/__tests__/*.test.sh`. Edit `package.json` to add the new path:

Replace:
```json
"test:bash": "for f in container/__tests__/*.test.sh; do [ -f \"$f\" ] && bash \"$f\"; done",
```

With:
```json
"test:bash": "for f in container/__tests__/*.test.sh setup/__tests__/*.test.sh; do [ -f \"$f\" ] && bash \"$f\"; done",
```

Then run:

```
cd /data/nanotars && pnpm run test:bash 2>&1 | tail -10
```

Expected: existing container bash tests run + the new platform test runs, all pass.

- [ ] **Step 4: Commit**

```
cd /data/nanotars && git add setup/__tests__/platform.test.sh package.json && git commit -m "test(setup): platform.sh detection unit test (5 fixtures)"
```

---

## Task 12: Final tightening + push prep

**Files:** none new — verify + tidy.

- [ ] **Step 1: Whole-tree parse-check**

```
cd /data/nanotars && for f in install.sh setup.sh nanotars.sh setup/lib/*.sh setup/*.sh setup/__tests__/*.sh; do bash -n "$f" || echo "PARSE FAIL: $f"; done
```

Expected: no `PARSE FAIL` lines.

- [ ] **Step 2: Verify install.sh raw URL is consistent across files**

The README says `https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/install.sh`. The `install.sh` itself has a banner referencing the same URL. Verify:

```
cd /data/nanotars && grep -rn 'raw.githubusercontent.com/TerrifiedBug/nanotars' install.sh README.md
```

Expected: at least 2 hits, all pointing at `v1-archive/install.sh`. If a hit references a different branch, fix it.

- [ ] **Step 3: shellcheck (best-effort, non-blocking)**

If shellcheck is installed, run it. If not, skip:

```
cd /data/nanotars && (command -v shellcheck >/dev/null 2>&1 && shellcheck install.sh setup.sh nanotars.sh setup/*.sh setup/lib/*.sh 2>&1 | head -50) || echo "shellcheck not installed — skipping"
```

Triage warnings inline. Anything in SC1090/SC1091 (sourced file not found) is fine — those paths are runtime-resolved. Other warnings should be addressed with a small follow-up edit if quick, otherwise noted.

- [ ] **Step 4: Verify all commits land cleanly**

```
cd /data/nanotars && git log --oneline | head -15
```

Expected: 11 new commits at the top of the log (Tasks 1–11), each with the prefix `feat(setup):`, `test(setup):`, or `docs:`. No stray "WIP" or fixup commits.

- [ ] **Step 5: Final tree listing**

```
cd /data/nanotars && ls -la install.sh setup.sh nanotars.sh setup/ setup/lib/ setup/__tests__/ 2>&1
```

Expected: all 11 new files present and executable where expected.

- [ ] **Step 6: One last full test run**

```
cd /data/nanotars && pnpm run test:bash 2>&1 | tail -10
cd /data/nanotars && pnpm typecheck 2>&1 | tail -5
```

Expected: bash tests + typecheck both green. (The setup scripts don't affect typecheck — this is a sanity gate that nothing leaked into TS sources.)

- [ ] **Step 7: Done — no commit for this task**

Task 12 produces no new commit; it's a verification gate. If Step 3 or 4 surfaced anything, file it as a follow-up commit before declaring done.

---

## Test plan summary

| Layer | What's tested | Where |
|---|---|---|
| Platform detection | `detect_platform` against 5 fixtures (macOS arm64/x86, Linux x86/arm64, FreeBSD) | `setup/__tests__/platform.test.sh` |
| Parse correctness | `bash -n` on every shell file | Task 12 step 1 |
| End-to-end smoke | Manual: run `bash install.sh` on a fresh VM (acceptance criteria in spec §12) | Out of CI |
| Idempotency | Manual: re-run `bash setup.sh`; expect "already-installed" lines | Out of CI |

No vitest tests for the bash scripts — bash-on-bash is the right granularity.

---

## Commit summary (12 commits expected)

1. `feat(setup): add platform detection + log helpers (setup/lib)`
2. `feat(setup): add install.sh wget-able bootstrap`
3. `feat(setup): add install-node.sh (Node 22 LTS, idempotent)`
4. `feat(setup): add install-pnpm.sh (pnpm 9.15.0, idempotent)`
5. `feat(setup): add install-docker.sh (presence check + install hints)`
6. `feat(setup): add service-launchd.sh + service-systemd.sh (with WSL nohup fallback)`
7. `feat(setup): add setup.sh orchestrator (prereqs + pnpm install + container build + service)`
8. `feat(setup): add nanotars.sh service-mgmt wrapper (start/stop/restart/status/logs)`
9. `feat(setup): add probe.sh post-install sanity check`
10. `docs: install + uninstall instructions for setup.sh / nanotars.sh`
11. `test(setup): platform.sh detection unit test (5 fixtures)`
12. (no commit — verification gate)
