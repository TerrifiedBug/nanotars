---
name: manage-mounts
description: Configure which host directories nanotars agent containers can access. View, add, or remove mount allowlist entries. Triggers on "mounts", "mount allowlist", "agent access to directories", "container mounts".
---

# Manage Mounts

Configure which host directories nanotars agent containers can access. The mount allowlist lives at `~/.config/nanoclaw/mount-allowlist.json` (outside the project root, so agents cannot tamper with it from inside their containers).

## Show current config

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null || echo "No mount allowlist configured (additional mounts will be BLOCKED)"
```

If the file exists, present each `allowedRoots` entry to the user with its `path`, `allowReadWrite` flag, and optional `description`. Report `nonMainReadOnly` (whether non-main groups are forced read-only) and the additional `blockedPatterns` (on top of the built-in defaults: `.ssh`, `.gnupg`, `.aws`, `credentials`, `.env`, `id_rsa`, etc. — see `src/mount-security.ts:24-45`).

## Add an allowed root

Ask the user:

1. The host path (absolute, or starting with `~/`).
2. Whether the agent needs read-write access (default: read-only).
3. An optional one-line description.

Validate the path exists:

```bash
realpath "<expanded-path>" >/dev/null 2>&1 && echo "exists" || echo "missing"
```

If the path doesn't exist, ask the user whether to add it anyway (mount validation will reject it at runtime, but adding it pre-creation is sometimes intentional).

Read the current config, splice in a new `allowedRoots` entry:

```bash
mkdir -p ~/.config/nanoclaw
node -e '
  const fs = require("fs");
  const path = "/root/.config/nanoclaw/mount-allowlist.json".replace("/root", process.env.HOME);
  const cfg = fs.existsSync(path)
    ? JSON.parse(fs.readFileSync(path, "utf8"))
    : { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true };
  cfg.allowedRoots.push({ path: "<USER-PATH>", allowReadWrite: <true|false>, description: "<USER-DESC-OR-OMIT>" });
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
  console.log(JSON.stringify(cfg, null, 2));
'
```

Replace the `<USER-PATH>`, `<true|false>`, `<USER-DESC-OR-OMIT>` placeholders. If the user didn't provide a description, omit the `description` key entirely.

## Add a blocked pattern

Ask which path component the user wants to block (e.g., `password`, `secrets`). Append to `blockedPatterns`:

```bash
node -e '
  const fs = require("fs");
  const path = require("path").join(process.env.HOME, ".config/nanoclaw/mount-allowlist.json");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!cfg.blockedPatterns.includes("<PATTERN>")) cfg.blockedPatterns.push("<PATTERN>");
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
'
```

## Remove an entry

Read the current config, ask which entry to remove (1-indexed), splice and write:

```bash
node -e '
  const fs = require("fs");
  const path = require("path").join(process.env.HOME, ".config/nanoclaw/mount-allowlist.json");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  cfg.allowedRoots.splice(<INDEX>, 1);  // or cfg.blockedPatterns.splice(<INDEX>, 1)
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
'
```

## Reset to empty (no additional mounts allowed)

```bash
mkdir -p ~/.config/nanoclaw
echo '{"allowedRoots":[],"blockedPatterns":[],"nonMainReadOnly":true}' > ~/.config/nanoclaw/mount-allowlist.json
```

This is the safest default — no host directories accessible to agents beyond the workspace.

## After changes

Mount-security caches the allowlist in memory per host process. Restart the service so the new config is picked up:

- **macOS:** `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- **Linux (systemd):** `systemctl --user restart nanoclaw`
- **Foreground dev:** Stop and re-run `npm run dev`

The change takes effect for new container spawns after the restart; already-running containers continue to use the old allowlist.

## Security model

- The allowlist file is **outside the project root**, so an agent inside a container cannot modify it — they don't have a mount that reaches `~/.config/nanoclaw/`.
- Built-in `blockedPatterns` (`.ssh`, `.gnupg`, `credentials`, `.env`, etc.) are always applied even when not listed in the user config — see `src/mount-security.ts:24-45`.
- `nonMainReadOnly: true` (the default) forces non-main groups to read-only mounts regardless of `allowReadWrite`. Main group can mount read-write where the root permits.

For the full security model, see `docs/SECURITY.md`.
