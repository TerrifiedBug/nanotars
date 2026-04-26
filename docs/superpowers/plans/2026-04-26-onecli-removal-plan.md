# OneCLI removal — high-level plan (deferred)

**Status:** Deferred. Option A (de-emphasize in user-facing surfaces) landed in commit covering setup.sh + README. Option B (rip the dep + integration out entirely) is documented here for when single-user homelab deployment becomes the only deployment shape we commit to.

## Why this is on the deferred list

OneCLI was ported in Phase 3 from upstream qwibitai/nanoclaw v2. It's wired silently (falls back when not reachable, doesn't break anything), but in nanotars's actual deployment shape (single-user homelab, root or single-user box) it offers little value over the existing plugin-loader `containerEnvVars` allowlist + per-group `.env` overrides + `secret-redact.ts`.

It also depends on `@onecli-sh/sdk`, a third-party SDK on a separate vendor track. Removing it eliminates a vendor coupling and trims operational surface.

**Don't pull this trigger if:**
- nanotars is being used as a multi-tenant install (the entity-model + RBAC support this even though it isn't the primary use case)
- You explicitly want the credential vault + audit-trail for third-party API keys (Telegram tokens, weather API keys, etc.)
- You expect to run agents that hit credentialed external APIs and want a centralized rotation point

**Pull the trigger if:**
- nanotars is staying single-user homelab forever
- The "vendor coupling to OneCLI's SaaS service" outweighs the credential vault value
- You're done iterating on the multi-user features and they were nice-to-have, not load-bearing

## What "rip it out" means concretely

### Files to remove

- `src/permissions/onecli-bridge.ts` (Phase 4C — the manual-approval bridge that long-polls OneCLI's `/api/approvals/pending`)
- `src/__tests__/onecli-bridge.test.ts` (or wherever the corresponding tests live)
- `.claude/skills/init-onecli/` (the install skill)
- `.claude/skills/use-native-credential-proxy/` (the switch-back skill — only useful as a counterpart to OneCLI)

### Files to edit (remove OneCLI-specific blocks)

- `package.json` — remove `@onecli-sh/sdk` from `dependencies`
- `pnpm-lock.yaml` — regenerate via `pnpm install --frozen-lockfile=false` post-edit
- `src/container-runner.ts` — remove the `OneCLI` import + `onecli.ensureAgent` + `onecli.applyContainerConfig` block (lines ~169-190)
- `src/index.ts` — remove `startOneCLIBridge` import + invocation
- `src/permissions/approval-primitive.ts` — remove any OneCLI-specific handler registrations
- `src/secret-redact.ts` — remove OneCLI-specific allowlist entries (`ONECLI_API_KEY` exemption etc.)
- `CLAUDE.md` — remove the entire "Secrets / Credentials / OneCLI" section + the "Gotcha: auto-created agents start in `selective` secret mode" block + the "Requiring approval for credential use" block
- `setup.sh` — remove the (now-silent) OneCLI presence check
- `setup/probe.sh` — remove OneCLI version detection
- `README.md` — already clean post-Option-A; double-check no remaining refs
- `CONTRIBUTING.md` — check for OneCLI mentions in skill-type docs
- Memory files at `/root/.claude/projects/-data-nanoclaw-v2/memory/` — remove or update OneCLI refs

### Behavior changes for users

- **Credentialed agents fall back to `.env` + plugin-loader's `containerEnvVars` allowlist exclusively.** This is already the no-OneCLI fallback path; everything keeps working, just without the proxy/audit/approval layer for third-party credentials.
- **Phase 4C approval primitive stays.** The manual-approval flow itself is generic; only the OneCLI-specific bridge that feeds it pending approvals from a remote vault is removed. Other approval handlers (sender-approval, channel-approval, install_packages, add_mcp_server, create_agent) are unaffected.
- **`/init-onecli` skill disappears.** Anyone who had OneCLI configured before the removal would need to switch to plain `.env` for credentials. Migration: copy any vault-stored secrets into `.env` (or per-group `.env` overrides), rebuild the container.

### Test impact

Expect ~5-10 host tests removed (OneCLI bridge tests, OneCLI integration tests). No new tests needed.

### Estimated effort

~1 day, ~5-8 commits broken into:

1. Remove `src/permissions/onecli-bridge.ts` + its tests + the `startOneCLIBridge` wiring
2. Remove the OneCLI gateway block from `src/container-runner.ts`
3. Remove `init-onecli` and `use-native-credential-proxy` skills
4. Remove `@onecli-sh/sdk` from package.json + regenerate lockfile
5. Strip OneCLI sections from CLAUDE.md + setup.sh probe + setup/probe.sh
6. Update memory file
7. Tests pass (1011 baseline minus removed OneCLI tests)
8. Single push to `v1-archive`

## Pre-removal sanity check

Before doing the rip-out, confirm:

- [ ] You're not running nanotars as a multi-user install where OneCLI is providing real isolation
- [ ] You've migrated any vault-stored credentials to `.env` or per-group `.env` overrides
- [ ] You're OK losing the audit trail OneCLI provides for credential use
- [ ] Phase 4C's approval primitive is still wired for non-OneCLI flows (it is — separate from the OneCLI bridge)

## How to run the removal

When ready, dispatch a single agent with this plan as input. The work is mechanical sed + delete + test pass. Follow the 8-commit sequence above; push to `v1-archive`.

## Why we're not doing it now

1. It's not breaking anything (silent fallback works).
2. The multi-user RBAC entity model from Phase 4 might find a use for it.
3. We just shipped a bunch of v2 ports; let those settle before architectural simplification.
4. The user-facing visibility — the actual annoyance — is the easy fix. That's Option A. This file documents Option B for whenever it makes sense.
