# Setup script port (lean bash-only) — Design Spec

> **Goal:** A user can run a single `curl | bash` one-liner pointing at the v1-archive raw GitHub URL and end up with a fully-installed, running nanotars service on macOS (launchd) or Linux (systemd). All bash, no TypeScript UI, no per-channel installer scripts, no PostHog.

**Date:** 2026-04-26
**Branch base:** `v1-archive` (HEAD `f1e2594`)
**Status:** spec ready for implementation

---

## 1. Background

v2 ships an end-to-end setup machinery: `setup.sh` (bash bootstrap) hands off to `pnpm run setup:auto` (`@clack/prompts` TS UI) which calls per-step modules (`setup/install-node.sh`, `setup/install-docker.sh`, `setup/service.ts`, …). It also has per-channel installers (`setup/install-discord.sh` etc.) that run as part of an interactive flow, plus a PostHog diagnostics emitter.

v1-archive (nanotars) currently has **no** equivalent. The only on-rails install path is the `/nanoclaw-setup` Claude Code skill — which assumes the user has already cloned the repo, has Node + pnpm + Docker, and is sitting in front of a Claude session. There is no entrypoint that goes from "I just heard about this project" to "the service is running on my machine".

This spec defines the leanest port that closes that gap, deliberately scoping out the parts of v2's setup that don't fit v1's plugin-loader architecture or the user's stated preference.

---

## 2. Goals

1. **One-line install.** `curl -fsSL https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/install.sh | bash` clones the repo into `~/nanotars` (configurable), runs `setup.sh`, and produces a running service.
2. **Idempotent.** Re-running `install.sh` or `setup.sh` on an existing checkout does not corrupt state — it skips done work and reports "already installed" where appropriate.
3. **Cross-platform.** macOS (Apple silicon + Intel via Homebrew), Linux (Debian/Ubuntu via apt; Fedora/RHEL fallback handled by clear error). WSL falls back to a manual nohup wrapper.
4. **Service-ready.** After `setup.sh` finishes the service is loaded into launchd (macOS) or systemd --user (Linux) and starts at next login. No reboot required.
5. **Discoverable management.** `bash nanotars.sh start|stop|restart|status|logs` wraps the service manager so users don't have to remember `launchctl kickstart` syntax.
6. **Bash-only.** No Node, no pnpm, no TypeScript at the installer layer. Every script is greppable on a fresh box with nothing but `bash`, `curl`, and the package manager.

---

## 3. Non-goals (deliberate scope cuts)

These were on v2's plate. They are explicitly **out** for v1.

- **TS clack-prompts UI.** No `setup/auto.ts`, `setup/index.ts`, `pnpm run setup:auto`. v1's per-channel auth still lives in the `/nanoclaw-setup` skill and the per-channel skills (`/add-channel-discord` et al.). The bash setup script does not run any prompt UI beyond simple `read` for y/N.
- **Per-channel installer scripts.** No `setup/install-discord.sh`, `setup/install-slack.sh`, `setup/install-telegram.sh`, `setup/install-whatsapp.sh`, etc. v1's plugin-loader installs channels via Claude Code skills (`/add-channel-<name>`), and that path is unchanged.
- **PostHog / diagnostics emission.** No `setup/lib/diagnostics.sh`, no `ph_event` calls, no install funnel. v1 doesn't have an opted-in telemetry consent flow and is not adding one in this work.
- **Per-checkout install slugs.** v2 supports multiple co-existing installs by hashing the checkout path into the launchd label (`com.nanoclaw.<slug>`). v1 keeps it simple: one install per machine, label `com.nanotars`.
- **Peer cleanup of unhealthy installs.** Tied to slugs above — out.
- **Internal `NANOCLAW_*` env-var rename.** Internal env vars (`NANOCLAW_BOOTSTRAPPED`, etc.) and image names (`nanoclaw-agent:latest`) stay as-is — load-bearing through host + container code. Branding only at the user-facing wrapper level.
- **Brew auto-install on macOS.** v2 prompts to install Homebrew. v1 fails fast with a clear "install brew from https://brew.sh and re-run" message — installing brew under another script is invasive (sudo, CLT prompts, 5-10 min wait) and the user's machine should have it before they run nanotars.
- **OneCLI auto-install.** OneCLI is optional for first launch; setup.sh probes for it and prints a hint to run `/init-onecli` later. It does not download or install OneCLI itself.

---

## 4. User-facing flow

```
$ curl -fsSL https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/install.sh | bash
[install] detected: macos / arm64 / brew
[install] cloning TerrifiedBug/nanotars#v1-archive into /Users/dan/nanotars ...
[install] handing off to setup.sh
[setup]   node 22 OK (v22.11.0)
[setup]   pnpm 9.15.0 OK
[setup]   docker OK (running)
[setup]   pnpm install --frozen-lockfile ... done (12s)
[setup]   ./container/build.sh ... done (94s)
[setup]   wrote ~/Library/LaunchAgents/com.nanotars.plist
[setup]   launchctl load ... loaded
[setup]
[setup]   nanotars is running. Manage it with:
[setup]     bash nanotars.sh status
[setup]     bash nanotars.sh logs
[setup]     bash nanotars.sh restart
[setup]
[setup]   Bootstrap your first agent? (y/N) _
```

If the user answers `y`, setup.sh prints the next step:

```
Open a Claude Code session in /Users/dan/nanotars and run:
    /nanoclaw-setup
This walks through channel auth, main-channel selection, and verifies the agent.
```

If `N`, the same hint is printed as an "if you want to do this later" footer.

---

## 5. File layout

All paths relative to repo root.

| Path | Type | Purpose |
|---|---|---|
| `install.sh` | bash | wget-able bootstrap. Detects platform, clones repo to `${NANOTARS_DIR:-$HOME/nanotars}`, runs `setup.sh` inside it. |
| `setup.sh` | bash | Main installer. Runs prereq installers, `pnpm install`, `./container/build.sh`, writes service file, optional first-agent prompt. |
| `nanotars.sh` | bash | User-facing service-mgmt wrapper (`start/stop/restart/status/logs`). |
| `setup/lib/platform.sh` | bash (sourced) | `detect_platform`, `is_wsl`, `service_manager`, `node_path` helpers. |
| `setup/lib/log.sh` | bash (sourced) | `log_info`, `log_warn`, `log_error`, append to `logs/setup.log`. Color-aware via tty detect. |
| `setup/install-node.sh` | bash | Install Node 22 LTS via brew (macOS) or NodeSource apt (Linux). Idempotent. |
| `setup/install-pnpm.sh` | bash | Install pnpm 9.15.0 via corepack-or-npm fallback. Idempotent. |
| `setup/install-docker.sh` | bash | Detect docker/colima/podman. If missing, print install instructions and exit non-zero. Does NOT auto-install (Docker installer is invasive). |
| `setup/service-launchd.sh` | bash | Generate `~/Library/LaunchAgents/com.nanotars.plist`, run `launchctl unload && launchctl load`. |
| `setup/service-systemd.sh` | bash | Generate `~/.config/systemd/user/nanotars.service`, run `systemctl --user daemon-reload && systemctl --user enable --now nanotars`. WSL fallback emits a `start-nanotars.sh` nohup wrapper. |
| `setup/probe.sh` | bash | Single read-only sanity check (Node, pnpm, docker, image, service). Prints `KEY: value` block. Used by `nanotars.sh status` and `setup.sh` for "what's already done". |
| `setup/__tests__/platform.test.sh` | bats-style bash | Unit test for `detect_platform` against fixtured `uname -s` outputs. |

**Total new files:** 10 scripts + 1 test = 11.
**Total existing files modified:** `README.md` (add one-liner), `.gitignore` (already covers `logs/`).

---

## 6. Key design decisions

### 6.1 Repository details

- **Repo URL:** `https://github.com/TerrifiedBug/nanotars.git`
- **Default branch:** `v1-archive` (parameterizable via `NANOTARS_BRANCH` env var)
- **Default install dir:** `${NANOTARS_DIR:-$HOME/nanotars}`
- **install.sh raw URL:** `https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/install.sh`

### 6.2 Idempotency

- **install.sh** — if `${NANOTARS_DIR}` exists and is a git checkout of the nanotars repo, skip clone and `cd` into it. If it exists but is not a nanotars checkout, abort with a clear error (don't risk clobbering the user's data).
- **setup.sh** — every step is gated:
  - Node: skip if `node --version` ≥ v20.
  - pnpm: skip if `pnpm --version` ≥ 9.0.0.
  - Docker: skip if `docker info` succeeds; abort with help text if missing.
  - `pnpm install`: idempotent by design (frozen lockfile, content-addressed store).
  - Container build: always re-run (`./container/build.sh` checks the image cache itself).
  - Service file: write unconditionally (templates are deterministic — no diff if nothing changed); reload service.
  - First-agent prompt: only ask if no `groups/main/CLAUDE.md` exists yet (proxy for "not yet bootstrapped").

### 6.3 Version pins

- **Node:** 22 LTS (matches `engines.node: ">=20"` in `package.json`; pin to 22 for predictability).
- **pnpm:** `9.15.0` (matches Phase 4.5 baseline).
- **Docker:** any version that responds to `docker info`. Colima and Podman accepted as drop-in replacements (Podman aliases `docker` via `podman-docker` package on most distros).

### 6.4 Platform detection

`setup/lib/platform.sh` exports:

| Var | Values |
|---|---|
| `PLATFORM` | `macos`, `linux`, `unknown` |
| `IS_WSL` | `true`, `false` (Linux only) |
| `IS_ROOT` | `true`, `false` |
| `SERVICE_MANAGER` | `launchd`, `systemd-user`, `nohup` |
| `PKG_MANAGER` | `brew`, `apt`, `dnf`, `unknown` |
| `ARCH` | `arm64`, `x86_64` |

Detection order:
1. `uname -s` → Darwin / Linux / other.
2. On Linux: `grep -qi 'microsoft\|wsl' /proc/version` → `IS_WSL=true`.
3. Service manager: macOS always launchd; Linux + non-root + `systemctl --user daemon-reload` succeeds → `systemd-user`; else `nohup`. (Root systemd-system path skipped — root install is uncommon and not the supported flow on v1.)
4. Package manager: `brew` (macOS), `apt-get` then `dnf` then `yum` (Linux). Unknown → fail fast in `install-node.sh` with a clear error.

### 6.5 Service files

**launchd (`~/Library/LaunchAgents/com.nanotars.plist`):**

- Label `com.nanotars` (single-install assumption).
- ProgramArguments: `[<NODE_PATH>, <PROJECT_ROOT>/dist/index.js]`
- WorkingDirectory: `<PROJECT_ROOT>`
- RunAtLoad + KeepAlive both true.
- Env: `PATH`, `HOME`. (No `ASSISTANT_NAME` baked in — the upstream v1 plist had `Andy` hardcoded; we leave it to `.env` so users don't need to edit the plist.)
- Logs: `<PROJECT_ROOT>/logs/nanotars.log` and `<PROJECT_ROOT>/logs/nanotars.error.log`.

**systemd-user (`~/.config/systemd/user/nanotars.service`):**

- Description `Nanotars Personal Assistant`.
- ExecStart `<NODE_PATH> <PROJECT_ROOT>/dist/index.js`
- WorkingDirectory `<PROJECT_ROOT>`
- Restart=always, RestartSec=5, KillMode=process.
- `EnvironmentFile=-<PROJECT_ROOT>/.env` (optional).
- `loginctl enable-linger` so service survives SSH logout.

**Logs:**

- Service stdout → `logs/nanotars.log`
- Service stderr → `logs/nanotars.error.log`
- Setup-flow log → `logs/setup.log`

(Mirroring v1's existing convention. No `logs/setup-steps/NN-name.log` per-step machinery — bash redirects everything to one log.)

### 6.6 First-agent bootstrap

setup.sh **never** auto-bootstraps. After service start, it prints:

```
Bootstrap your first agent? (y/N)
```

On `y`: print "Open a Claude Code session in <repo> and run /nanoclaw-setup" — that's the existing v1 skill that handles channel auth + main-channel registration.
On `N` (or non-interactive stdin): print the same instruction as a hint footer.

(v1 does not have a `/init-first-agent` skill — that's a v2 thing. v1's `/nanoclaw-setup` already covers the equivalent ground.)

### 6.7 OneCLI

Probe only:

```
if command -v onecli >/dev/null 2>&1; then
  log_info "OneCLI detected ($(onecli version 2>/dev/null | head -1))"
else
  log_info "OneCLI not detected — to enable credential vault later, run /init-onecli in Claude Code"
fi
```

Never auto-install.

### 6.8 nanotars.sh subcommands

| Subcommand | macOS | Linux (systemd-user) | Linux (nohup fallback) |
|---|---|---|---|
| `start` | `launchctl load ~/Library/LaunchAgents/com.nanotars.plist` | `systemctl --user start nanotars` | `bash start-nanotars.sh` |
| `stop` | `launchctl unload ~/Library/LaunchAgents/com.nanotars.plist` | `systemctl --user stop nanotars` | `kill $(cat nanotars.pid)` |
| `restart` | `launchctl kickstart -k gui/$(id -u)/com.nanotars` | `systemctl --user restart nanotars` | stop + start |
| `status` | `launchctl list \| grep com.nanotars` + `setup/probe.sh` | `systemctl --user status nanotars --no-pager` + probe | pid check + probe |
| `logs` | `tail -f logs/nanotars.log` | same | same |

### 6.9 Branding boundary

Only user-facing strings rename. Internal stays NANOCLAW.

| Layer | Brand |
|---|---|
| `install.sh`, `setup.sh`, `nanotars.sh` console output | nanotars |
| Service label / unit | `com.nanotars`, `nanotars.service` |
| Service log files | `logs/nanotars.log`, `logs/nanotars.error.log` |
| `NANOCLAW_BOOTSTRAPPED`, `NANOCLAW_*` env vars | unchanged (load-bearing) |
| `nanoclaw-agent:latest` image tag | unchanged |
| `data/v2.db`, `store/messages.db` paths | unchanged |
| Source-code identifiers in `src/`, `container/` | unchanged |

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `apt` vs `brew` vs `dnf` dispatch grows hairy. | Restrict v1 to brew + apt for now. dnf prints "manual install required: brew/apt only" and exits 1. Fedora/RHEL users get a clean message instead of a confusing partial install. |
| WSL has no systemd. | Detect via `/proc/version`; fall back to `start-nanotars.sh` nohup wrapper (mirroring v2). |
| User's `${NANOTARS_DIR}` already exists with unrelated content. | Check for `.git` + remote URL match. If `.git` is a different repo or the dir has files but no `.git`, abort with a "rename or set NANOTARS_DIR" error. |
| Corepack first-use prompt hangs in non-tty contexts. | Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` before any corepack call (lifted from v2). |
| `npm install -g pnpm` writes to a prefix not on PATH. | After install, query `npm config get prefix` and prepend `$prefix/bin` to PATH for the rest of the session (lifted from v2). |
| Docker is installed but daemon not running. | `docker info` (not just `command -v docker`) is the gate. On failure, print "start Docker Desktop / `sudo systemctl start docker` and re-run". |
| User on Apple silicon hits brew formula `node@22` keg-only PATH issue. | After `brew install node@22`, add `eval "$(brew --prefix)/opt/node@22/bin"` to PATH for the session and instruct the user to run `brew link --overwrite node@22` if a future session can't find Node. |
| `launchctl load` errors with "already loaded" if plist was previously loaded. | Always `launchctl unload` first (ignore unload errors). Lifted from v2. |
| `systemctl --user` works in current session but service stops on logout. | `loginctl enable-linger $USER` after service install. |
| Container image build (~95s) feels frozen with no output. | setup.sh tees `./container/build.sh` to stdout (not silent). No spinner needed for v1 — just stream the build log. |
| User runs `install.sh` as root via `sudo bash`. | Detect `IS_ROOT=true` and abort with "do not run install.sh as root — service is per-user". (Avoid the subtle bugs of `~` being `/root` mid-install.) |

---

## 8. Rollback plan

A failed install is fully reversible by removing the install dir and the service file:

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

Documented in README under "Uninstall". No special uninstaller script — these five commands are the canonical procedure.

---

## 9. Testing strategy

- **Unit:** `setup/__tests__/platform.test.sh` covers `detect_platform`, `is_wsl`, `service_manager` selection by mocking `uname` and `/proc/version` via fixtured env. Bash-test-style (assert + exit code) — runnable as `bash setup/__tests__/platform.test.sh`.
- **Integration smoke:** `setup/probe.sh` itself acts as a post-install smoke test — exit non-zero if any expected component is missing. CI does not run it (no Docker in CI), but a developer can run it locally after `bash setup.sh` to gate "did setup actually finish".
- **Dry-run:** every script supports `--dry-run` (top-level flag); when set, `log_info` prints the command without executing it. Used by the test suite and by users wanting to inspect what setup.sh will do.
- **CI:** add `setup/__tests__/platform.test.sh` to the existing `pnpm test:bash` target (already runs `container/__tests__/*.test.sh`). This is the only setup-script test that runs in CI; the rest require a real machine.

No vitest tests for the bash scripts — the unit-test surface is too thin to justify the binding cost. Bash-on-bash is the pragmatic choice.

---

## 10. Deferred / future work

Called out so reviewers don't expect them in this PR:

- **Per-channel installer scripts** (`setup/install-discord.sh`, etc.) — v1's plugin-loader handles channels via `/add-channel-<name>` skills. If the channel-install UX wants a non-Claude-CLI path later, it can be a separate piece of work.
- **Dashboard install** (`setup/install-dashboard.sh`) — v1's dashboard is skill-installed; same reasoning.
- **claw CLI install** (`setup/install-claw.sh`) — same reasoning.
- **`setup:auto` TS UI** — explicitly cut. If usage grows and bash flow can't render the polish needed, port `@clack/prompts` later.
- **PostHog telemetry** — explicitly cut. If v1 ever adopts opt-in telemetry, gate it on a separate `NANOTARS_TELEMETRY_OPT_IN=true` env var with a consent prompt at install time.
- **Per-checkout slug** for multi-install support — explicitly cut. If users start running multiple v1 installs side by side, hash the canonicalised checkout path into the launchd label and the systemd unit name (lift `setup/lib/install-slug.sh` from v2).
- **Brew auto-install on macOS** — explicitly cut. If Mac onboarding friction becomes a real issue, lift v2's brew-prompt block.
- **OneCLI auto-install** — explicitly cut. The `/init-onecli` skill is the documented path.
- **Dependency probe before clone** — `install.sh` does not check Node/pnpm/Docker before cloning. Only `setup.sh` does. If clone succeeds but prereqs are missing, the user has a stranded checkout to clean up; tolerable for v1, can tighten later.

---

## 11. Open questions resolved by this spec

| Question | Resolution |
|---|---|
| Spec script name? | `install.sh` (wget-able), `setup.sh` (post-clone main), `nanotars.sh` (service mgmt). |
| Repo branch? | `v1-archive` for now (parameterizable via `NANOTARS_BRANCH`). |
| Install dir override? | `NANOTARS_DIR` env var; default `$HOME/nanotars`. |
| Node version? | 22 LTS, hard-pinned. |
| pnpm version? | 9.15.0, hard-pinned. |
| Docker auto-install? | No. Detect-and-instruct only. |
| Service manager? | macOS launchd, Linux systemd-user, WSL nohup wrapper. |
| First-agent UX? | Optional y/N prompt at end of setup.sh; never auto-runs; hands off to `/nanoclaw-setup` skill. |
| OneCLI? | Probe only; never auto-install. Hint to run `/init-onecli` later. |
| Branding extent? | User-facing only. Internal env vars + image tags + DB paths unchanged. |

---

## 12. Acceptance criteria

A run of:

```bash
NANOTARS_DIR=/tmp/nanotars-acceptance \
  bash <(curl -fsSL https://raw.githubusercontent.com/TerrifiedBug/nanotars/v1-archive/install.sh)
```

on a fresh Ubuntu 22.04 VM with only `bash`, `curl`, `git` pre-installed should:

1. Install Node 22 + pnpm 9.15.0 (apt + corepack).
2. Detect Docker missing → print install instructions → exit non-zero. (User installs Docker, re-runs.)
3. On second run: install Docker present → continue → `pnpm install` succeeds → `./container/build.sh` succeeds → `nanotars.service` written + started → `systemctl --user is-active nanotars` returns `active`.
4. `bash /tmp/nanotars-acceptance/nanotars.sh status` shows green for service + Docker + image.
5. `bash /tmp/nanotars-acceptance/setup/probe.sh` exits 0 with all OK fields.
6. `bash /tmp/nanotars-acceptance/setup.sh` re-run is fully idempotent — finishes in <5s with "already done" lines for every step.

Equivalent flow on macOS (with brew preinstalled) reaches the same end state via launchd.
