#!/usr/bin/env bash
# setup.sh — install or upgrade nanotars.
#
# Two ways to invoke:
#   1. Inside the repo (after manual git clone):
#        bash setup.sh
#   2. Via the wget one-liner (auto-clones into $HOME/nanotars first):
#        curl -fsSL https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/setup.sh | bash
#
# Idempotent; safe to re-run for upgrades.
#
# Honours:
#   NANOTARS_DIR                            install location (default $HOME/nanotars; bootstrap mode only)
#   NANOTARS_BRANCH                         branch (default v1-archive; bootstrap mode only)
#   NANOTARS_REPO                           git URL (default https://github.com/TerrifiedBug/nanotars.git)
#   NANOTARS_MARKETPLACE                    override default Claude marketplace (default TerrifiedBug/nanotars-skills)
#   NO_COLOR=1                              plain output

set -euo pipefail

# ────────────────────────────────────────────────────────────────────────
# Bootstrap mode — only fires when piped from `curl | bash` (no real
# BASH_SOURCE file). Clones the repo, then exec's the in-tree setup.sh.
# ────────────────────────────────────────────────────────────────────────

if [ -z "${BASH_SOURCE[0]:-}" ] || [ ! -f "${BASH_SOURCE[0]:-/dev/null}" ]; then
  REPO_URL="${NANOTARS_REPO:-https://github.com/TerrifiedBug/nanotars.git}"
  BRANCH="${NANOTARS_BRANCH:-v1-archive}"
  TARGET_DIR="${NANOTARS_DIR:-$HOME/nanotars}"

  _bootstrap_color() {
    [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && printf '\033[0;36m[bootstrap]\033[0m' || printf '[bootstrap]'
  }
  _bootstrap_log() { printf '%s %s\n' "$(_bootstrap_color)" "$*"; }
  _bootstrap_die() { printf '\033[0;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

  case "$(uname -s 2>/dev/null)" in
    Darwin|Linux) ;;
    *) _bootstrap_die "Unsupported platform: $(uname -s 2>/dev/null). Supported: macOS, Linux." ;;
  esac

  for cmd in git bash; do
    command -v "$cmd" >/dev/null 2>&1 || _bootstrap_die "Required command not found: $cmd"
  done

  _bootstrap_log "platform: $(uname -s) $(uname -m)"
  _bootstrap_log "target:   $TARGET_DIR"
  _bootstrap_log "branch:   $BRANCH"

  if [ -d "$TARGET_DIR/.git" ]; then
    EXISTING_REMOTE="$(git -C "$TARGET_DIR" remote get-url origin 2>/dev/null || echo '')"
    case "$EXISTING_REMOTE" in
      *TerrifiedBug/nanotars*|*nanotars.git|*/nanotars)
        _bootstrap_log "existing checkout at $TARGET_DIR; running in-tree setup.sh"
        ;;
      *)
        _bootstrap_die "$TARGET_DIR is a git checkout of '$EXISTING_REMOTE', not nanotars. Set NANOTARS_DIR to a different path or remove the directory."
        ;;
    esac
  elif [ -d "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]; then
    _bootstrap_die "$TARGET_DIR exists and is not a nanotars checkout. Set NANOTARS_DIR to a different path or remove the directory."
  else
    _bootstrap_log "cloning $REPO_URL#$BRANCH into $TARGET_DIR"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET_DIR"
  fi

  if [ ! -f "$TARGET_DIR/setup.sh" ]; then
    _bootstrap_die "$TARGET_DIR/setup.sh not found. Repo may be on the wrong branch."
  fi

  _bootstrap_log "handing off to in-tree setup.sh"
  exec bash "$TARGET_DIR/setup.sh"
fi

# ────────────────────────────────────────────────────────────────────────
# In-repo mode — the actual installer.
# ────────────────────────────────────────────────────────────────────────

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
  log_info "running as root — service install will use the nohup wrapper path (launchd/systemd-user need a per-user session)"
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

# Run a noisy command silently to logs/setup.log; print one ✓ line on
# success or tail the log on failure. Keeps the user-facing output tight.
run_quiet() {
  local label="$1"; shift
  log_step "$label"
  if "$@" >> "$PROJECT_ROOT/logs/setup.log" 2>&1; then
    log_info "✓ $label"
  else
    log_error "$label failed — last 20 lines of logs/setup.log:"
    tail -n 20 "$PROJECT_ROOT/logs/setup.log" >&2
    exit 1
  fi
}

run_quiet "pnpm install" pnpm install --frozen-lockfile

if ! node -e "require('better-sqlite3')" >> "$PROJECT_ROOT/logs/setup.log" 2>&1; then
  log_error "better-sqlite3 native binding failed to load — check logs/setup.log"
  exit 1
fi
log_info "✓ better-sqlite3 binding"

run_quiet "pnpm run build" pnpm run build
if [ ! -f "$PROJECT_ROOT/dist/index.js" ]; then
  log_error "build did not produce dist/index.js — check logs/setup.log"
  exit 1
fi

run_quiet "container build (this can take a few minutes on first run)" bash "$PROJECT_ROOT/container/build.sh"

# --- Service install + start ---

log_step "Installing service"
case "$PLATFORM" in
  macos) bash "$PROJECT_ROOT/setup/service-launchd.sh" ;;
  linux) bash "$PROJECT_ROOT/setup/service-systemd.sh" ;;
  *)
    log_error "Unsupported platform: $PLATFORM"
    exit 1
    ;;
esac

# launchd's RunAtLoad=true and systemd-user's restart line both start the
# service automatically. The nohup branch (root, WSL, no-systemd) writes a
# wrapper but does not run it — invoke it now so every platform ends with
# a running service.
if [ "$SERVICE_MANAGER" = "nohup" ]; then
  WRAPPER="$PROJECT_ROOT/start-nanotars.sh"
  if [ -x "$WRAPPER" ]; then
    run_quiet "starting nanotars (nohup)" bash "$WRAPPER"
  fi
fi

# Quick liveness check — give the service ~3s to boot before we banner
# "started" and let the user run nanotars.sh logs.
sleep 3
SERVICE_LIVE=false
case "$SERVICE_MANAGER" in
  launchd)
    launchctl list 2>/dev/null | grep -q "com.nanotars" && SERVICE_LIVE=true
    ;;
  systemd-user)
    systemctl --user is-active nanotars >/dev/null 2>&1 && SERVICE_LIVE=true
    ;;
  nohup)
    PIDFILE="$PROJECT_ROOT/nanotars.pid"
    if [ -f "$PIDFILE" ]; then
      PID="$(cat "$PIDFILE" 2>/dev/null || echo "")"
      [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && SERVICE_LIVE=true
    fi
    ;;
esac

# --- OneCLI hint ---

if command -v onecli >/dev/null 2>&1; then
  log_info "OneCLI detected ($(onecli version 2>/dev/null | head -1))"
else
  log_info "OneCLI not detected — to enable the credential vault later, open Claude Code in this directory and run /init-onecli"
fi

# --- Install user wrapper: ~/.local/bin/nanotars ---

WRAPPER_DIR="$HOME/.local/bin"
WRAPPER_PATH="$WRAPPER_DIR/nanotars"
log_step "Installing 'nanotars' wrapper at $WRAPPER_PATH"
mkdir -p "$WRAPPER_DIR"
sed "s|__INSTALL_DIR__|$PROJECT_ROOT|g" "$PROJECT_ROOT/setup/wrapper-template.sh" > "$WRAPPER_PATH"
chmod +x "$WRAPPER_PATH"

# Ensure ~/.local/bin is on PATH for future shells. Idempotent — only
# appends to the rc file if the line isn't already there.
# Sets PATH_RC_TO_SOURCE if the parent shell needs to source an rc file
# to pick up the wrapper.
PATH_RC_TO_SOURCE=
ensure_local_bin_on_path() {
  case ":$PATH:" in
    *":$WRAPPER_DIR:"*) return 0 ;;
  esac
  case "${SHELL:-}" in
    */zsh)  RC="$HOME/.zshrc" ;;
    */bash) RC="$HOME/.bashrc" ;;
    *)      RC="" ;;
  esac
  if [ -z "${RC:-}" ]; then
    log_warn "$WRAPPER_DIR is not on PATH and shell ($SHELL) is unrecognized."
    log_warn "Add this to your shell rc file: export PATH=\"$WRAPPER_DIR:\$PATH\""
    return 0
  fi
  if [ -f "$RC" ] && grep -qE "PATH=.*\.local/bin" "$RC" 2>/dev/null; then
    PATH_RC_TO_SOURCE="$RC"
    return 0
  fi
  printf '\n# Added by nanotars setup.sh\nexport PATH="%s:$PATH"\n' "$WRAPPER_DIR" >> "$RC"
  PATH_RC_TO_SOURCE="$RC"
}
ensure_local_bin_on_path

# --- Onboarding bridge: name + channels ---

# We can only collect this interactively. Honor a TTY check + an explicit
# skip flag so CI / scripted re-runs don't hang.
if [ "${NANOTARS_SKIP_ONBOARDING_PROMPT:-}" != "true" ] && [ -t 0 ]; then
  echo
  echo "  ─── Onboarding (saves to data/onboarding.json) ────────────────"
  echo

  # 1. User's name (so TARS addresses them by name).
  read -r -p "  What's your name? (used by TARS when addressing you): " USER_NAME </dev/tty
  USER_NAME="${USER_NAME:-}"

  # 2. Channel multi-select. Catalog mirrors .claude/skills/nanotars-setup
  #    — these are the channels the in-claude setup skill knows how to install.
  echo
  echo "  Available chat channels:"
  echo "    1) telegram   (bot API)"
  echo "    2) discord    (servers + DMs)"
  echo "    3) whatsapp   (via Baileys)"
  echo "    4) slack      (socket mode)"
  echo
  read -r -p "  Pick numbers (space-separated, e.g. '1 3'; blank = decide later): " PICKS </dev/tty

  declare -a CHANNELS_PICKED=()
  for n in $PICKS; do
    case "$n" in
      1) CHANNELS_PICKED+=("telegram") ;;
      2) CHANNELS_PICKED+=("discord") ;;
      3) CHANNELS_PICKED+=("whatsapp") ;;
      4) CHANNELS_PICKED+=("slack") ;;
    esac
  done

  # 3. Persist the selections so the in-claude /nanotars-setup skill can
  #    read them and dispatch the right /add-* skills.
  mkdir -p "$PROJECT_ROOT/data"
  CHANNELS_JSON="["
  first=1
  for c in "${CHANNELS_PICKED[@]:-}"; do
    [ -z "$c" ] && continue
    if [ "$first" = "1" ]; then first=0; else CHANNELS_JSON="${CHANNELS_JSON},"; fi
    CHANNELS_JSON="${CHANNELS_JSON}\"${c}\""
  done
  CHANNELS_JSON="${CHANNELS_JSON}]"

  cat > "$PROJECT_ROOT/data/onboarding.json" <<EOF
{
  "name": "${USER_NAME}",
  "channels": ${CHANNELS_JSON},
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  log_info "saved $PROJECT_ROOT/data/onboarding.json"

  # 4. Bake the user's name into groups/main/IDENTITY.md so TARS knows
  #    who it's talking to from the very first message. Idempotent —
  #    re-running setup.sh updates the User block without duplicating it.
  IDENTITY="$PROJECT_ROOT/groups/main/IDENTITY.md"
  mkdir -p "$(dirname "$IDENTITY")"
  if [ -n "$USER_NAME" ]; then
    if [ -f "$IDENTITY" ] && grep -q '^## User$' "$IDENTITY" 2>/dev/null; then
      # Replace existing User block (between '## User' and next '## ' or EOF).
      python3 - "$IDENTITY" "$USER_NAME" <<'PY' 2>/dev/null || true
import sys, re
path, name = sys.argv[1], sys.argv[2]
with open(path) as f: t = f.read()
new = f"## User\n\nYou are working with **{name}**. Address them as {name} when greeting and replying.\n\n"
t = re.sub(r"## User\n.*?(?=\n## |\Z)", new, t, count=1, flags=re.DOTALL)
with open(path, "w") as f: f.write(t)
PY
    else
      cat >> "$IDENTITY" <<EOF

## User

You are working with **${USER_NAME}**. Address them as ${USER_NAME} when greeting and replying.
EOF
    fi
    log_info "set user name in $IDENTITY"
  fi

  echo
fi

# --- Skill marketplace auto-registration ---

DEFAULT_MARKETPLACE="${NANOTARS_MARKETPLACE:-TerrifiedBug/nanotars-skills}"
if command -v claude >/dev/null 2>&1; then
  if claude plugin marketplace add "$DEFAULT_MARKETPLACE" >> "$PROJECT_ROOT/logs/setup.log" 2>&1; then
    log_info "✓ marketplace $DEFAULT_MARKETPLACE registered with Claude Code"
  else
    log_warn "claude plugin marketplace add failed (non-fatal). To retry later, run: claude plugin marketplace add $DEFAULT_MARKETPLACE"
  fi
else
  log_info "claude CLI not on PATH — install Claude Code, then run: claude plugin marketplace add $DEFAULT_MARKETPLACE"
fi

# --- Post-install banner ---

if [ "$SERVICE_LIVE" = "true" ]; then
  SERVICE_LINE="Service:  $SERVICE_MANAGER (running)"
else
  SERVICE_LINE="Service:  $SERVICE_MANAGER (NOT running — see logs/nanotars.error.log)"
fi

PATH_HINT=
if [ -n "${PATH_RC_TO_SOURCE:-}" ]; then
  PATH_HINT="
    First — pick up the new PATH for the 'nanotars' command:
      source $PATH_RC_TO_SOURCE
    (or just open a new shell)
"
fi

cat <<EOF

  ================================================================
    nanotars setup complete
  ================================================================

    Install:  $PROJECT_ROOT
    $SERVICE_LINE
${PATH_HINT}
  ─── Next: bootstrap your first agent ────────────────────────────

    1. Open Claude in the install dir:
         nanotars

    2. Inside Claude, run:
         /nanotars-setup
       (Reads data/onboarding.json — your name + channel picks — and
       walks through channel install, auth, wiring, and verification.)

    3. (Optional) Tune personality:  groups/main/IDENTITY.md
       (Optional) OneCLI vault:      /init-onecli (inside Claude)

    Service control:  nanotars start | stop | restart | status | logs
    Logs:             $PROJECT_ROOT/logs/nanotars.log

EOF

log_info "setup.sh finished cleanly"
