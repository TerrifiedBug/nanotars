---
name: manage-group-env
description: Manage environment variables passed into an agent group's containers. Add/remove/override vars, edit the allowlist in container.json, inspect provenance (global vs group override). Use when wiring a skill that needs an API key, rotating a credential, or changing which vars an agent can see.
---

# Manage Group Env

Per-group env passthrough is wired via `src/modules/group-env/`. At session spawn, the host merges the root `.env` with `groups/<folder>/.env` (group wins), filters by `container.json.envAllowlist`, shell-quotes the values, and mounts them at `/workspace/env-dir/env` (RO). The container's spawn command sources that file before execing the agent-runner, so vars land in `process.env` for every child process the agent starts (shells, CLIs, scripts).

**Opt-in per key.** `envAllowlist` is empty or missing → no mount, nothing passes through. Declaring a var in `.env` is not enough on its own; it also has to be in the allowlist.

## Locations

| File | Role |
|---|---|
| `.env` (project root) | Global values. Host process reads this too — don't put anything here that shouldn't touch the host. |
| `groups/<folder>/.env` | Per-group overrides. Shadows global for that group only. Gitignored via `.env*`. |
| `groups/<folder>/container.json` — `envAllowlist: string[]` | The opt-in list. Only keys here pass through. |
| `data/env/<agentGroupId>/env` | Generated staging file. Don't edit — regenerated every spawn. Gitignored via `data/`. |

## Assess Current State

For a target agent group (ask the user which one, default to the DM'd group if only one exists):

1. `jq '.envAllowlist // []' groups/<folder>/container.json` — the allowlist.
2. `cat groups/<folder>/.env 2>/dev/null` — group-level overrides.
3. `grep -E "^(<keys from allowlist>)=" .env` — which allowlisted keys are defined globally.
4. Build a provenance table:

   | Key | In allowlist? | Global .env? | Group .env? | Effective source |
   |---|---|---|---|---|
   | `FOO` | ✅ | ✅ | — | global |
   | `BAR` | ✅ | ✅ | ✅ | group (overrides global) |
   | `BAZ` | ✅ | — | — | ⚠ declared but no value anywhere |
   | `QUX` | — | ✅ | — | ⚠ in .env but not in allowlist → not passed |

   The two warning rows are the actionable ones. Present them so the user sees what's misconfigured.

## Operations

### Add a var that should reach the agent

1. Confirm scope: **global** (shared across all groups) or **group-only** (this group gets it, others don't).
2. Append `KEY=VALUE` to the appropriate `.env` file. Quote values that contain spaces, `$`, or `#` — e.g. `KEY="my value"`.
3. If the key isn't already in `envAllowlist`, append it via `jq`:
   ```bash
   jq '.envAllowlist = ((.envAllowlist // []) + ["KEY"] | unique)' \
     groups/<folder>/container.json > /tmp/cc.json && \
     mv /tmp/cc.json groups/<folder>/container.json
   ```
4. Remind the user: **existing running containers keep their old env** (file was captured at spawn). Next session spawn picks up the new value. To force-refresh immediately, kill the running container: `docker kill nanoclaw-v2-<folder>-<sessionId>` — the next inbound message respawns with the updated env.

### Override a global var for just this group

Global has `NOTION_API_KEY=...` but this group should use a different one:

1. Add `NOTION_API_KEY=<group-specific-value>` to `groups/<folder>/.env`.
2. Allowlist already covers it (it was the global value being passed through). No `container.json` change needed.

### Remove a var from an agent's view

Usually you want the var to still exist in `.env` but this agent shouldn't see it. Remove the key from `envAllowlist`:

```bash
jq '.envAllowlist |= map(select(. != "KEY"))' \
  groups/<folder>/container.json > /tmp/cc.json && \
  mv /tmp/cc.json groups/<folder>/container.json
```

If you want the value physically gone (group-level only), delete the line from `groups/<folder>/.env` too. Don't touch global `.env` unless the user explicitly asks — other groups may depend on it.

### Rotate a credential

1. Replace the value in whichever `.env` owns the current one (global or group).
2. Kill the running container for that group (see above) so the new value takes effect.
3. Confirm the new value by having the agent echo `$KEY` in a bash tool call (should show the rotated value, not the old one).

### Purge per-group overrides

To make a group fall back entirely to the global `.env`:

```bash
rm groups/<folder>/.env
```

Allowlist can stay as-is; it'll just resolve to global values for every key.

## Verification

After any change, confirm with the user before declaring done. Two quick checks:

1. **Staging file renders correctly** — after next session spawn (or `buildGroupEnvMount` dry-run):
   ```bash
   cat data/env/<agentGroupId>/env
   ```
   Should show `KEY='value'` lines, one per allowlisted key that resolved.

2. **Agent sees the var** — ask the agent to run `echo "$KEY"` via its Bash tool. If empty, either the key isn't in the allowlist, the `.env` files don't define it, or the container predates the change (needs a respawn).

## What this skill does NOT do

- **Does not edit the host `.env`** beyond the bare minimum for adding a passthrough var. The host reads that file too (TELEGRAM_BOT_TOKEN, DASHBOARD_*, etc.); don't put group-specific noise in it.
- **Does not commit changes** — `.env*` and `data/` are gitignored. Credentials should stay local.
- **Does not restart the host** — this flow is purely per-group container spawn config. The host service runs independently.

## Common Patterns

- **Porting a skill that reads `process.env.X`**: add `X` to the group's `envAllowlist` and ensure it's defined somewhere (global or group .env).
- **Per-environment secrets** (dev vs prod tokens for the same service): use `groups/<folder>/.env` to pin the group to its environment-specific value.
- **Least privilege**: allowlist only what the group's skills actually need. Adding `*` semantics isn't supported (and deliberately so).
