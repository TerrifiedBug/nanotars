---
name: use-native-credential-proxy
description: Use NanoTars's built-in .env-based credential pipe instead of the OneCLI gateway. v1's default path; this skill documents how to switch back from OneCLI if /init-onecli was previously run.
---

# Use Native Credential Pipe (v1)

In v1-archive, the native credential pipe is the **default**: container spawn calls `readSecrets()` (`src/container-mounts.ts`) which reads `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` from `.env` and pipes them via stdin to the container.

If you've never run `/init-onecli`, you're already using this. **Nothing to do.**

If you HAVE run `/init-onecli` and want to switch back, follow the steps below.

## Phase 1: Restore .env credentials

If you migrated credentials into the OneCLI vault, retrieve them and put them back in `.env`:

```bash
onecli secrets list
onecli secrets get --name Anthropic   # or whatever name you used
```

Add the value back to `.env`:

```bash
echo 'ANTHROPIC_API_KEY=<your-value>' >> .env
# OR
echo 'CLAUDE_CODE_OAUTH_TOKEN=<your-value>' >> .env
```

Verify the host can read it:

```bash
grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env
```

## Phase 2: Disable OneCLI gateway

You don't need to remove `@onecli-sh/sdk` from the codebase — the host's `buildContainerArgs` already falls through silently when OneCLI is unreachable. Three options:

**Option A — leave OneCLI installed but unused:** Just delete the OneCLI vault data and let the host fail-soft. Containers will fall back to the .env stdin pipe automatically.

**Option B — point ONECLI_URL at a dead address:** In `.env`, set `ONECLI_URL=http://127.0.0.1:65535`. The host will log "OneCLI gateway error — falling back to .env credentials" once per spawn but otherwise behave identically.

**Option C — uninstall OneCLI fully:** Stop and remove the OneCLI service per OneCLI's own docs (`onecli stop`, then remove its install dir).

Pick one. There's no "remove the SDK from the codebase" step needed — v1 does not branch behavior on whether the dep is installed; it branches on whether the runtime call succeeds.

## Phase 3: Verify

Restart the service:

- macOS (launchd): `nanotars restart`
- Linux (systemd): `nanotars restart`
- WSL/manual: stop and re-run `nanotars restart`

Send a test message in a registered chat. Inspect logs:

```bash
tail -30 logs/nanotars.log | grep -iE "onecli|gateway|secret"
```

Expected: either no OneCLI lines (if uninstalled), or "OneCLI gateway error — falling back" (if dead address). The agent should respond normally because the .env stdin pipe is delivering credentials.

## Troubleshooting

**Agent stops responding after switching:** Likely the .env value is missing or stale. Run `claude setup-token` (subscription path) or grab a new key from console.anthropic.com (API path), update `.env`, restart.

**OneCLI keeps trying to handle credentials:** Verify `ONECLI_URL` is unset or points at a dead address. The fallback is per-spawn; existing running containers may still be using the OneCLI proxy until they're killed and respawned. Use `docker ps` to find them and `docker kill <container-id>`; the next inbound message respawns the container with the new env.
