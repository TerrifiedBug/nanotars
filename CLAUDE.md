# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to messaging channels via plugins, routes messages to Claude Agent SDK running in containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/plugin-loader.ts` | Plugin discovery, loading, and registry |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Container runtime abstraction (Docker/Apple Container) |
| `src/mount-security.ts` | Mount path validation and allowlist |
| `src/group-queue.ts` | Concurrency management, container lifecycle |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/plugin-types.ts` | Plugin system type definitions |
| `src/container-mounts.ts` | Volume mount construction, env files, secrets |
| `src/snapshots.ts` | Task/group snapshot utilities for IPC |
| `src/secret-redact.ts` | Outbound secret redaction (strips .env values from messages/logs) |
| `plugins/channels/*/index.js` | Channel plugins (WhatsApp, Discord, etc.) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Security

Agents run in containers with explicit mount boundaries. Before modifying files that handle mounts, paths, credentials, or IPC authorization, read [docs/SECURITY.md](docs/SECURITY.md) and consider the security implications.

## Plugin Boundary

NanoClaw's plugin system is designed so that all capabilities are added through defined interfaces — never by modifying core source code. When creating, installing, or modifying plugins (via `/create-skill-plugin`, `/create-channel-plugin`, `/add-skill-*`, `/add-channel-*`), you MUST NOT modify:

- `src/` — no TypeScript source changes
- `container/agent-runner/` — no agent runner changes
- `container/Dockerfile` — use `Dockerfile.partial` in the plugin directory instead
- Root `package.json` or `package-lock.json` — plugin deps go in per-plugin packages
- Existing plugins under `plugins/` — no cross-plugin modifications

All capabilities must be achieved through the plugin interface: `plugin.json`, `index.js` hooks, `container-skills/`, `mcp.json`, `containerHooks`, and `Dockerfile.partial`. If a plugin idea genuinely requires core code changes, say so clearly and stop — do not attempt workarounds.

**Skills MUST NOT query the SQLite database directly via `sqlite3` (or any other SQLite client).** Schema changes in core (e.g. the entity-model migration of 2026-04 that dropped `registered_groups` in favour of `agent_groups` / `messaging_groups` / `messaging_group_agents`) silently break every skill that inlines raw SQL — operator runs the skill, query fails mid-conversation, agent returns a confusing error. Use the existing IPC actions (`register_group`, `refresh_groups`, `emergency_stop`, etc.) or `nanotars` CLI subcommands for any DB read/write. If an operator-facing skill needs visibility that no IPC/CLI surface provides, propose adding the missing surface to core rather than reaching into the schema.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/nanotars-setup` | First-time installation, authentication, service configuration |
| `/create-channel-plugin` | Build a new channel plugin (Discord, Slack, etc.) from scratch |
| `/nanotars-add-group` | Add a group/chat to an existing channel plugin |
| `/create-skill-plugin` | Build a new skill plugin (integrations, tools, hooks) from scratch |
| `/nanotars-publish-skill` | Publish a local skill to the marketplace repo |
| `/nanotars-update-skill` | Sync improved local plugins to the marketplace repo |
| `/nanotars-remove-plugin` | Remove a plugin (runtime + env vars + marketplace cleanup) |
| `/nanotars-debug` | Container issues, logs, troubleshooting |
| `/nanotars-health` | Quick system health check with pass/fail status |
| `/nanotars-db-maintenance` | Database optimization, cleanup, integrity checks |
| `/nanotars-groups` | List, view, and manage group configurations |

## Change Tracking

All significant changes (features, improvements, bug fixes) to this fork MUST be documented in `docs/CHANGES.md`. When you add or modify functionality, update the relevant section in CHANGES.md as part of the same commit.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
nanotars start | stop | restart | status | logs
```

Or directly:

macOS:
```bash
launchctl load ~/Library/LaunchAgents/com.nanotars.plist
launchctl unload ~/Library/LaunchAgents/com.nanotars.plist
```

Linux (systemd-user):
```bash
systemctl --user start nanotars
systemctl --user stop nanotars
journalctl --user -u nanotars -f   # follow logs
```

## Supply Chain Security (pnpm)

This project uses pnpm at the repo root with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them. The `container/agent-runner/` subpackage stays on npm and gets the same 3-day hold via `.npmrc` (`minimumReleaseAge=4320`).

**Two-package layout:**
- **Root (`/data/nanotars/`)** — pnpm. Lockfile: `pnpm-lock.yaml`. Install: `pnpm install --frozen-lockfile`.
- **Container agent-runner (`container/agent-runner/`)** — npm. Lockfile: `package-lock.json`. Install: `npm install` (run inside the Docker build).

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release-age gate, the human must approve and pin the exact version (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages without human approval — build scripts execute arbitrary code during install. Current allowlist: `[better-sqlite3]`.
- **`pnpm install --frozen-lockfile`** in CI, automation, and container builds. Never bare `pnpm install` in those contexts.
- **Lockfile conversion**: Use `pnpm import` (not `pnpm install`) to generate `pnpm-lock.yaml` from a legacy `package-lock.json`. Fresh `pnpm install` re-resolves versions and risks native-binding clobbers.

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

## Schema changes — migration policy

**Every schema change adds both a `createSchema` DDL line AND a numbered `MIGRATIONS` array entry in `src/db/init.ts`. No exceptions, even when "no users yet."**

Why: v1-archive is a long-lived branch with at least one in-use dev DB (the operator's own). A bare DDL change without a migration entry leaves `schema_version` out of sync and breaks the dev DB on next startup. The defensive migration is ~5 lines per change; the cleanup cost when the "no users" assumption ages out is not.

Pattern:

```ts
// In createSchema's CREATE TABLE block:
ALTER TABLE foo ADD COLUMN bar TEXT NOT NULL DEFAULT 'baz';

// In the MIGRATIONS array (next sequential number):
{
  name: 'NNN_add_foo_bar',
  up: (db) => safeAddColumn(db, `ALTER TABLE foo ADD COLUMN bar TEXT NOT NULL DEFAULT 'baz'`),
},
```

`safeAddColumn` is idempotent — running the same migration twice on a DB that already has the column is a no-op. Use it for any `ADD COLUMN`. For column drops or renames, write the migration manually with `IF EXISTS` guards.

If a Phase 2 schema change shipped without a migration entry (the engage_mode 4-axis change in commit `1e086d2`), retroactively backfill the migration so existing dev DBs converge cleanly.
