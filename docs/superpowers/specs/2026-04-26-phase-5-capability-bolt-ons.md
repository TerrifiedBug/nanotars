# Phase 5: Capability bolt-ons — Design

**Status:** Approved 2026-04-26 (per upstream-triage 2026-04-25 §"Phase 5 — Capability bolt-ons", reclassified ADOPT-rebuild items from Areas 3/5/6).

## Goal

Land four agent-capability features on v1-archive's per-group container model, reimplemented (not direct-ported) from v2's per-session container architecture:

1. **Self-modification** — `install_packages` and `add_mcp_server` MCP tools that go through the Phase 4C approval primitive: agent requests → admin approves → host rebuilds the per-group image (install_packages) or just restarts the container (add_mcp_server).
2. **Per-agent-group image build** — replaces the build-time concatenation of plugin Dockerfile.partials in `container/build.sh` with on-demand per-group image builds tagged `nanoclaw-agent:<agent-group-id>`. Required by self-mod's `install_packages`. Plugin partials still merge in but at per-group build time, not host-image build time.
3. **Lifecycle pause/resume** — process-level `paused` flag honored by `wakeContainer` (no-op while paused; messages queue in v1's IPC). Layered on top of v1's existing `GroupQueue.emergencyStop` / `MessageOrchestrator.pause` rather than replacing them. Exposed as MCP tool `emergency_stop` / `resume_processing` and as admin slash commands `/pause` / `/resume`.
4. **Provider abstraction (concept-level seam)** — `AgentProvider` interface in agent-runner with the existing Anthropic SDK call wrapped as the default `claude` provider. Per-group `agent_provider` column already exists from Phase 4A; this phase makes it load-bearing. Host-side `provider-container-registry` lets non-default providers contribute extra mounts/env. Plugin loader's existing `containerEnvVars` + `Dockerfile.partial` pipeline carries non-default providers.
5. **`create_agent` MCP tool** — admin-gated agent-provisioning primitive that creates a new `agent_groups` row + filesystem scaffold (`groups/<folder>/`). Wires the new agent_group as an `agent_group_member` of the requesting admin and registers it in the central DB.

After Phase 5, an agent on v1 can (with admin approval) extend its own runtime with apt/npm packages, register external MCP servers, halt and resume the bot, and provision peer agent groups — all through the Phase 4C/4D approval and command-gate rails. The same code is positioned to plug in non-Claude providers when a user-driven motivation surfaces (Codex, OpenCode, Ollama).

## Scope decisions (locked)

These follow from the upstream triage (Area 3 + Area 5 + Area 6 verdict matrices), the Phase 5 carved-out scope in the master triage doc, and the v1-archive constraints (per-group containers, plugin-loader, npm-on-container, vitest-on-host-and-container).

1. **Five sub-phases, ordered 5A → 5B → 5C → 5D → 5E.** Provider abstraction (5A) lands first because it sits underneath self-mod and create_agent — both want a clean answer to "what runtime is this group's container running?". Per-group image build (5B) lands second because self-mod's `install_packages` requires a per-group image as the rebuild target. Self-modification (5C) lands third. Lifecycle pause/resume (5D) lands fourth — it depends only on Phase 4 RBAC for the admin command gate. `create_agent` (5E) lands last — it depends on Phase 4 RBAC + the entity model and is the smallest of the five.

   **Why not collapse 5A into 5C?** The triage flagged provider abstraction as ADOPT-rebuild on its own merits (Phase 5 trigger: nanotars's eventual Codex/OpenCode/Ollama plugins). Treating the seam as a 5A foundation keeps 5C self-mod focused on the package-install rebuild flow without entangling provider questions. The seam is small (~150 LOC) and gated behind an `agent_provider`-resolution helper that defaults to `claude` so the runtime path for existing groups doesn't change.

2. **Self-mod uses Phase 4C's `requestApproval` primitive verbatim.** The two MCP tools (`install_packages`, `add_mcp_server`) write IPC tasks the host picks up; the host calls `requestApproval` with a registered handler that mutates `agent_groups.container_config`, optionally rebuilds the image, and restarts the per-group container by signaling the `GroupQueue` (via the existing `_close` sentinel + a `pendingMessages = true` flag, so the queue respawns on next inbound).

   **Migration policy applies** — every DDL change adds a `MIGRATIONS` entry. Phase 5 adds zero net-new central-DB tables, but DOES extend `agent_groups.container_config` JSON shape (new `packages`, `mcpServers`, `dockerfilePartials`, `imageTag` fields). Schema-on-JSON change with no DDL — but because v1's `ContainerConfig` is parsed at runtime from `agent_groups.container_config`, the type definition + parser updates ARE the migration, and Phase 5 codifies them in `src/types.ts` + `src/db/agent-groups.ts` so existing rows (with the old smaller shape) parse cleanly.

3. **Per-agent-group image build replaces NOTHING in `container/build.sh`.** The base image still gets built once per host with all plugin Dockerfile.partials concatenated (existing v1 behavior preserved). Per-group images layer ON TOP of that base. v1's `nanoclaw-agent:latest` is the base; per-group images are tagged `nanoclaw-agent:<agent-group-id>` and built lazily via `buildAgentGroupImage(agentGroupId)`. If a group's `container_config.imageTag` is unset, the runtime falls through to `CONTAINER_IMAGE` (= `nanoclaw-agent:latest`).

   This is a deliberate divergence from v2: v2 builds per-group images that include all plugin partials inline (its trunk has zero plugin partials, since channel/provider extensions land via skill-installed barrels). v1 keeps plugin partials in the base image AND allows per-group additions on top. The two layers stack: base image already has plugin tooling; per-group image adds whatever the agent installed. Agents can NOT redeclare plugin partials in `container_config.dockerfilePartials` (those are host-managed); they can only add apt/npm packages and (via `add_mcp_server`) register MCP servers.

4. **Lifecycle pause/resume EXTENDS, doesn't replace, v1's `emergencyStop`/`resumeProcessing`.** v1's `GroupQueue.emergencyStop` (lines 359-383) kills active containers via `containerRuntime.stop`, sets `shuttingDown = true`. v1's `MessageOrchestrator.pause`/`resume` (lines 435-460) suspends the message loop. Phase 5D adds a separate `pausedGate` module: a process-level boolean that `GroupQueue.runForGroup` and `enqueueMessageCheck` consult before spawning. While paused, inbound messages still ingest into IPC files / `messages_in`-equivalent (v1 uses `messages` table) but don't wake a container. This is queue-suspending pause (v2's pattern) layered alongside v1's existing kill-and-resume pause (preserved as a fallback for emergency).

   Both surfaces are exposed:
   - **Soft pause** (queue-suspending): `emergency_stop` MCP tool + `/pause` admin command → `pausedGate.pause(reason)`. Existing containers finish their current turn; new wakes blocked.
   - **Hard stop** (kill-and-resume): unchanged from v1; reachable via existing entry points only (no MCP tool exposure). Used internally by self-mod's container-restart-after-rebuild.

5. **Provider abstraction is concept-level only — Claude stays default, no new providers ship in 5A.** The 5A scope is the seam: `AgentProvider` interface in container, `provider-container-registry` on host, `agent_provider` column resolution (`session → group → 'claude'`). Plugin-loader extension is the future port path: a provider plugin contributes `containerEnvVars`, `containerHooks`, and a `Dockerfile.partial` for its CLI; on the host side it calls `registerProviderContainerConfig('codex', ctx => {...})`. Trunk ships only the `claude` provider implementation.

   **No skill-installed branches.** Unlike v2 (where `/add-codex` / `/add-opencode` install from sibling git branches), v1 keeps providers as plugins under `plugins/<provider-name>/`. The plugin manifest gains an `agentProvider: true` flag that the loader reads to register the provider's container-runner contributions.

6. **`create_agent` is admin-only.** The MCP tool is registered conditionally in the agent-runner: only when `process.env.NANOCLAW_IS_ADMIN === '1'` (set by the host based on `isAdminOfAgentGroup(senderUserId, agentGroupId)` resolution at spawn time). Defense in depth: the host re-validates admin on receive of the IPC `create_agent` task before mutating the DB. Non-admin agents never see the tool.

   The newly-created agent group is wired with the requesting admin as an `agent_group_member` (via Phase 4B `addAgentGroupMember`). It is NOT auto-wired to any messaging group — the admin runs `/wire <messaging_group> <agent_group>` separately (the Phase 4D operational helper).

7. **Container-runner reviewer-required for IPC + Dockerfile changes.** Any task that touches `src/container-runner.ts`, `container/Dockerfile`, `container/build.sh`, `container/agent-runner/src/ipc-mcp-stdio.ts`, or any new MCP-tool definition file needs cross-tier reviewer dispatch (memory: "always dispatch reviewer for IPC/schema/Dockerfile changes"). Single-file mechanical changes in tests / accessors / pure-helper files can skip review.

8. **Phase 4.5 (pnpm) lands before Phase 5 implementation.** The catch-up plan sequences pnpm hardening between Phases 4 and 5 specifically so Phase 5 self-mod inherits the `minimumReleaseAge` policy from day one. Phase 5 plans assume pnpm is on (root); the agent-runner stays npm-on-Node (v1's choice, distinct from v2's Bun split).

## Sub-phase boundaries

Each sub-phase produces one PR-equivalent that can be reviewed and merged independently. Tasks within a sub-phase are atomic commits.

```
5A  Provider abstraction seam
    ├─ Container-side AgentProvider interface + provider-registry (factory + claude default)
    ├─ Host-side provider-container-registry + resolveProviderName helper
    ├─ Plugin-loader: read manifest.agentProvider flag → call registerProviderContainerConfig
    └─ Wire current Anthropic-SDK call site behind the seam (no behavior change)

5B  Per-agent-group image build
    ├─ ContainerConfig type extension (packages, dockerfilePartials, imageTag)
    ├─ generateAgentGroupDockerfile (pure fn, no IO)
    ├─ buildAgentGroupImage (writes Dockerfile to data/, runs container build, updates container_config)
    ├─ container-runner consumes container_config.imageTag → falls back to CONTAINER_IMAGE
    └─ /rebuild-image admin slash command (manual trigger; self-mod will invoke programmatically in 5C)

5C  Self-modification
    ├─ Container-side install_packages + add_mcp_server MCP tools (new mcp-tools/self-mod.ts)
    ├─ IPC types: add 'install_packages' + 'add_mcp_server' task variants
    ├─ Host-side request handlers: handleInstallPackages, handleAddMcpServer (validate, requestApproval)
    ├─ Approval-handler registry entries: applyInstallPackages, applyAddMcpServer (mutate config, rebuild, restart)
    ├─ Container-restart helper (signals GroupQueue to drop active container, respawn on next inbound)
    └─ Tests: end-to-end approval → rebuild → container-restart flow

5D  Lifecycle pause/resume
    ├─ src/lifecycle.ts: pausedGate module (in-memory boolean, isPaused/pause/resume)
    ├─ GroupQueue gates wakeContainer / runForGroup on isPaused() before spawn
    ├─ Container-side emergency_stop + resume_processing MCP tools
    ├─ IPC types: 'emergency_stop' + 'resume_processing' task variants
    ├─ Host-side handlers (no approval — agent-emitted, with admin re-validation by sender role)
    ├─ /pause + /resume admin slash commands (command-gate.ts)
    └─ Status surface: include paused state in dashboard plugin's snapshot if installed

5E  create_agent MCP tool
    ├─ Container-side mcp-tools/create-agent.ts (admin-conditional registration)
    ├─ IPC types: 'create_agent' task variant
    ├─ Host-side handler: validate admin, generate folder, call createAgentGroup, addAgentGroupMember, scaffold groups/<folder>/
    ├─ initGroupFilesystem helper: creates IDENTITY.md, optional CLAUDE.md, ensures .claude/ skill-marketplace setting
    └─ Notification: system-message reply to the parent agent confirming creation
```

## Architecture decisions per sub-phase

### 5A — Provider abstraction seam

**The key decision: small concrete interface, big freedom underneath.**

The interface is intentionally narrow — `query(input): AgentQuery` plus `events: AsyncIterable<ProviderEvent>`. v2 has the same shape. v1's existing agent-runner has a single hardcoded `query(...)` call inside `container/agent-runner/src/index.ts:567-606`; 5A wraps that into a `claudeProvider.query()` and the rest of the file goes through the seam.

```ts
// container/agent-runner/src/providers/types.ts
export interface AgentProvider {
  readonly supportsNativeSlashCommands: boolean;
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(err: unknown): boolean;
}

export interface QueryInput {
  prompt: string;
  continuation?: string;     // session id, opaque to caller
  cwd: string;
  systemContext?: { instructions?: string };
  modelOverride?: string;
}

export interface AgentQuery {
  push(message: string): void;
  end(): void;
  events: AsyncIterable<ProviderEvent>;
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' };
```

**Resolution chain:** `process.env.NANOCLAW_AGENT_PROVIDER ?? 'claude'`. The host writes the env var on container spawn from `agentGroup.agent_provider ?? 'claude'`. No session-level override in v1 (no per-session containers). Tests mock the registry.

**Host-side provider-container-registry** mirrors v2. A provider that needs extra host-side spawn setup registers a `ProviderContainerConfigFn`. Plugin-loader scans `plugins/*/plugin.json` for `agentProvider: true`; if found, the loader imports the plugin's `index.js` and expects it to call `registerProviderContainerConfig(name, fn)` at top level (mirrors how v1 plugins already register channel adapters).

### 5B — Per-agent-group image build

**The key decision: stack on top of the base image, don't replace it.**

v1's `container/build.sh` already concatenates plugin Dockerfile.partials into `nanoclaw-agent:latest`. That stays. Per-group images use `nanoclaw-agent:latest` as the base (NOT `node:22-slim` — v2's mistake here was bypassing the partials). Each per-group image adds:
- apt packages from `container_config.packages.apt`
- npm packages from `container_config.packages.npm`
- per-group Dockerfile partials from `container_config.dockerfilePartials` (paths relative to project root, path-traversal-checked)

Generation is a pure function:

```ts
// src/container-runner.ts
export function generateAgentGroupDockerfile(args: {
  baseImage: string;            // 'nanoclaw-agent:latest'
  apt: string[];
  npm: string[];
  partials: string[];           // project-relative paths
  projectRoot: string;
}): string;
```

Build:

```ts
export async function buildAgentGroupImage(agentGroupId: string): Promise<void>;
```

writes `<DATA_DIR>/Dockerfile.<agent-group-id>`, runs `containerRuntime.cli() build -t nanoclaw-agent:<agent-group-id> -f <tmp> .`, then unlinks the tmp Dockerfile. Updates `agent_groups.container_config` with `imageTag` and persists via `updateAgentGroup`.

**Tag scheme:** `nanoclaw-agent:<agent-group-id>` — the agent group ID is already a UUID, so safe as a docker tag. On a multi-install host (rare for v1 but cheap to support), the existing install-slug pattern (`INSTALL_SLUG`) prefixes the tag: `nanoclaw-${INSTALL_SLUG}-agent:<agent-group-id>`. Falls through to plain `nanoclaw-agent:<agent-group-id>` when `INSTALL_SLUG` is empty.

**ContainerConfig JSON shape (new):**

```ts
export interface ContainerConfig {
  // existing
  additionalMounts?: AdditionalMount[];
  timeout?: number;

  // Phase 5B
  packages?: { apt: string[]; npm: string[] };
  dockerfilePartials?: string[];   // project-relative, host-managed (NOT agent-mutable)
  imageTag?: string | null;        // populated by buildAgentGroupImage; null/absent → use CONTAINER_IMAGE
}
```

Host-managed fields (`dockerfilePartials`) are documented as such — agents can never mutate them via self-mod. The self-mod handler explicitly enumerates `packages.apt` / `packages.npm` only.

**Container-runner consumes `imageTag`:**

```ts
// src/container-runner.ts buildContainerArgs
const imageTag = containerConfig?.imageTag ?? CONTAINER_IMAGE;
args.push(imageTag);
```

The fallback preserves existing behavior for groups that have never had self-mod fire.

### 5C — Self-modification

**The key decision: agent emits IPC, host validates + queues approval, approval-handler mutates config + rebuilds + restarts.**

Two MCP tools, both fire-and-forget:

```ts
install_packages({ apt: string[], npm: string[], reason: string })
add_mcp_server({ name: string, command: string, args: string[], env: Record<string,string> })
```

Both write a task IPC file under `data/ipc/<group-folder>/tasks/` with `type: 'install_packages'` or `type: 'add_mcp_server'`. Host's existing `ipc/tasks.ts` reader gains two new branches.

**Validation (host-side, defense-in-depth — MCP tool also validates):**

```ts
const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;
```

**Approval flow:**

1. Host's task-handler calls `requestApproval({ action: 'install_packages', agentGroupId, payload: {apt, npm, reason}, originatingChannel: ... })` (Phase 4C primitive).
2. `pickApprover` resolves the approver hierarchy (scoped admins → global admins → owners).
3. `pickApprovalDelivery` picks the channel (Phase 4C C3).
4. `requestApproval` writes the `pending_approvals` row + delivery card.
5. Admin clicks Approve → click-router → 4C registry dispatches to `applyInstallPackages` (registered at host startup).
6. `applyInstallPackages` updates `container_config.packages.apt/npm` (merge, not overwrite), calls `buildAgentGroupImage(agentGroupId)`, signals the GroupQueue to kill the active container if any.
7. On kill, the queue's `pendingMessages = true` flag on the group ensures the next inbound respawns on the new image.
8. A 5-second-deferred system message ("Packages installed; please verify") gets injected into the agent's IPC inbox via the existing `notifyAgent` path (`src/permissions/approval-primitive.ts:81`) — to be wired through to actual delivery in 5C-04.

**`add_mcp_server` is the same flow minus the rebuild:**

1-5: same as install_packages.
6: handler updates `container_config.mcpServers[name] = {command, args, env}`. No rebuild — the agent-runner reads `mcpServers` from container config at spawn time (existing v1 behavior; just gain a new code path that consumes the JSON).
7: kill container so it respawns with the updated config.

**Reviewer dispatch required** for: container-side MCP tool definitions, IPC type union additions, host-side handler files, `applyInstallPackages` (touches Dockerfile-equivalent + `containerRuntime`).

### 5D — Lifecycle pause/resume

**The key decision: small process-level gate; preserve v1's existing emergency stop.**

```ts
// src/lifecycle.ts
let paused = false;
export const pausedGate = {
  isPaused: () => paused,
  pause: (reason: string) => { /* set flag, log, optionally kill via queue.emergencyStop */ },
  resume: (reason: string) => { /* clear flag, log, drainWaiting */ },
};
```

Two MCP tools:

```ts
emergency_stop({ reason?: string })       // soft: pause future wakes; agent finishes current turn
resume_processing({ reason?: string })    // resume future wakes
```

The MCP tool emits IPC; the host receives it; the host does NOT require approval (v2's pattern, single-operator install assumption). Defense in depth: only an agent that resolves to an admin user can fire these — the host's `tasks.ts` IPC handler checks `isAdminOfAgentGroup(senderUserId, agentGroupId)` before applying. Non-admin agents see the tool fail at the host (the MCP tool succeeds locally, but the host drops the IPC task with a notify-back).

**Admin slash commands `/pause` and `/resume`:** added to `command-gate.ts` ADMIN_COMMANDS set. Handler in orchestrator/router calls `pausedGate.pause(reason)` directly.

**Interaction with `emergencyStop`:** `pausedGate.pause()` calls `groupQueue.emergencyStop()` synchronously (existing v1 path). The pause flag is the new layer; the kill of in-flight containers is preserved. `pausedGate.resume()` calls `groupQueue.resumeProcessing()` (existing path) plus clears the flag.

### 5E — `create_agent` MCP tool

**The key decision: admin-only at registration time + admin re-check at host receive.**

```ts
create_agent({ name: string, instructions?: string, folder?: string })
```

- `name`: human-readable, becomes the new group's `agent_groups.name`.
- `instructions`: optional CLAUDE.md content; written to `groups/<folder>/CLAUDE.md`.
- `folder`: optional; defaults to slugified name; collision-handled by appending `-2`, `-3`, etc.

**Container-side gating:** `mcp-tools/create-agent.ts` only calls `server.tool('create_agent', ...)` when `process.env.NANOCLAW_IS_ADMIN === '1'`. Set by the host during `runContainerAgent` from the resolved sender's role.

**Host-side handler (`src/permissions/create-agent.ts`):**

1. Re-validate admin: read the IPC task's `senderUserId`, call `isAdminOfAgentGroup(senderUserId, callerAgentGroupId) || isOwner || isGlobalAdmin`. If not, emit a notify-back and drop.
2. Validate `name` (1-64 chars, no control characters), `folder` (regex `/^[a-z0-9][a-z0-9_-]*$/`, max 64).
3. Generate folder if absent: `slugify(name)`, dedupe-check against `agent_groups.folder` UNIQUE.
4. Path-traversal check: `path.resolve(GROUPS_DIR, folder)` must start with `path.resolve(GROUPS_DIR) + path.sep`.
5. Call `createAgentGroup({ name, folder, agent_provider: null, container_config: null })` (existing Phase 4A accessor).
6. Call `addAgentGroupMember({ user_id: senderUserId, agent_group_id: newGroupId, added_by: senderUserId })` (Phase 4B).
7. `initGroupFilesystem(newGroup, { instructions })`: creates `groups/<folder>/`, optional `CLAUDE.md` from `instructions`, copies a default `IDENTITY.md` from `groups/global/` (existing v1 fallback).
8. Notify the parent agent: system-message via the existing approval-primitive `notifyAgent` stub (today: logger.warn; once 5D's notify-back is wired, real chat injection — flagged as a known limitation that resolves with 5D-04).

**No auto-wiring to messaging groups.** The admin must run `/wire` separately. This intentionally diverges from v2 (v2 wires to `agent_destinations` for cross-container messaging; v1 has no peer-agent IPC and that's PORT-ARCH for Phase 7).

## DDL changes per sub-phase

| Sub-phase | DDL changes | Migration entry |
|-----------|-------------|-----------------|
| 5A        | None — `agent_groups.agent_provider` already exists from Phase 4A | None |
| 5B        | None — extends `container_config` JSON shape (no schema change) | None; type-only |
| 5C        | None — adds rows to existing `pending_approvals` (Phase 4C table); extends `container_config` JSON shape | None; type-only |
| 5D        | None — runtime-only flag + admin commands | None |
| 5E        | None — uses existing `agent_groups`, `agent_group_members` (Phase 4B) | None |

**Phase 5 ships zero new central-DB tables.** The migration policy still applies to type-shape changes for `container_config` (parser updates land in the same commits as type updates so old-shape rows still parse).

## MCP tool surface (input/output schemas)

All tools follow v1's existing zod-based registration pattern in `container/agent-runner/src/ipc-mcp-stdio.ts`. The same file gains five new tools (or, preferred refactor: pulled out to `container/agent-runner/src/mcp-tools/{self-mod,lifecycle,create-agent}.ts` with a barrel that the existing stdio server imports).

### `install_packages` (5C)

```ts
{
  apt: z.array(z.string()).optional().describe('apt packages (names only)'),
  npm: z.array(z.string()).optional().describe('npm packages (global install, names only)'),
  reason: z.string().describe('Why these packages are needed'),
}
```

Output: text content `"Package install request submitted. You will be notified when admin approves or rejects."`. Errors: empty list, >20 packages, invalid name regex. Returns `isError: true`.

### `add_mcp_server` (5C)

```ts
{
  name: z.string().describe('MCP server name (unique identifier)'),
  command: z.string().describe('Command to run the MCP server'),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}
```

Output: text content `"MCP server request submitted. You will be notified when admin approves or rejects."`.

### `emergency_stop` (5D)

```ts
{
  reason: z.string().optional().describe('Free-form reason for the pause'),
}
```

Output: `"Pause request submitted."`. Host either applies (admin sender) or drops with a notify-back (non-admin).

### `resume_processing` (5D)

```ts
{
  reason: z.string().optional(),
}
```

Output: `"Resume request submitted."`.

### `create_agent` (5E, admin-only registration)

```ts
{
  name: z.string().min(1).max(64).describe('Display name'),
  instructions: z.string().optional().describe('CLAUDE.md content'),
  folder: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).max(64).optional().describe('Folder name'),
}
```

Output: `"Creating agent <name>. You will be notified when ready."`. Tool is omitted from registration entirely when `NANOCLAW_IS_ADMIN !== '1'`.

## Approval-handler integration points

Three new actions register against Phase 4C's `registerApprovalHandler`:

| Action | Registered by | Rendered card | Apply behavior |
|--------|---------------|---------------|----------------|
| `install_packages` | `src/permissions/install-packages.ts` (host startup) | "Agent <name> wants to install: apt=[…], npm=[…]. Reason: …" + Approve/Deny buttons | Update `container_config.packages`, call `buildAgentGroupImage`, kill container, defer notify-back +5s |
| `add_mcp_server` | `src/permissions/add-mcp-server.ts` (host startup) | "Agent <name> wants to add MCP server <name> (<command>)" + Approve/Deny | Update `container_config.mcpServers`, kill container, immediate notify-back |
| (none for 5D + 5E) | — | — | These do NOT use approval primitive — they go through admin-command/admin-only paths |

Both register via `registerApprovalHandler` in `src/index.ts` startup, alongside Phase 4C's existing handlers (sender-approval, channel-approval, OneCLI credential).

## Risks + rollback plan

| Risk | Severity | Mitigation |
|------|----------|------------|
| `buildAgentGroupImage` build hangs (large apt install, slow disk) | medium | 5-minute timeout on `execSync`. On timeout: throw, handler emits notify-back ("rebuild failed"). Container keeps running on old image. |
| `buildAgentGroupImage` succeeds but base image was rebuilt under it (plugin partials changed) | low | Per-group images explicitly base off `nanoclaw-agent:latest` by tag, not by digest. A `./container/build.sh` rerun bumps the latest tag; per-group images don't auto-rebase. **Documented:** `./container/build.sh` after a plugin install means agents on per-group images keep using the OLD plugin layer until they self-mod again. Acceptable for v1's plugin install cadence (rare, manual). Mitigation if it bites: add a `force` flag to `buildAgentGroupImage` and an admin command `/rebuild-all-group-images`. |
| Self-mod approval card delivered to dead/blocked admin | medium | Phase 4C's `pickApprover` walks the hierarchy (scoped → global → owner). If no admin reachable, `requestApproval` fails fast and the agent gets a notify-back. |
| `pausedGate.pause()` race with in-flight `wakeContainer` | low | `wakeContainer` re-checks `isPaused()` after acquiring the per-group state lock. Already-running containers complete their turn (queue-suspending semantics). |
| `create_agent` with malicious `folder` (../, abs path, …) | high if reachable | Path-traversal check after `path.resolve` (mirrors v2's check at line 66-72 of `create-agent.ts`). Folder regex enforced at MCP tool layer + host handler layer. |
| Provider seam refactor accidentally regresses Claude SDK call | high | Test plan: 5A includes a smoke test that spawns the agent-runner with mock-stdin, runs a single `Hello` prompt through the seam, and asserts the SDK output reaches the parser unchanged. |
| `add_mcp_server` lets agent register an arbitrary executable as a server | high | Validate `command` is on a server-allowlist (initial: `npx`, `node`, `python`, `bash`, `/usr/local/bin/*`, paths under `/workspace/`). Anything else fails validation and gets `notifyAgent("command not allowed")`. Allowlist source-controlled in `src/permissions/install-packages.ts`. **Locked in 5C-03.** |
| Per-group image build burns disk (one image per agent group, never GC'd) | medium | After each successful build, delete previous image with same tag prefix (`docker image prune -a --filter "label=nanoclaw.agent_group=<id>"` + retry-on-conflict). Phase 5 adds a `nanoclaw.agent_group=<id>` LABEL to per-group images for this purpose. Documented; not implemented as a periodic sweep in 5B (manual op for now). |

**Rollback plan, per sub-phase:**

- **5A:** `git revert <5A-commit-range>` removes the seam; the existing single-call SDK path still works because the seam was a wrapping refactor with the original code path preserved.
- **5B:** `git revert <5B-commit-range>` removes `buildAgentGroupImage` + the `imageTag` consumer in container-runner. Agents that already ran self-mod and have stale `container_config.imageTag` rows: add a one-shot DB sweep `UPDATE agent_groups SET container_config = json_remove(container_config, '$.imageTag')` documented in the rollback runbook.
- **5C:** revert removes the two MCP tools + IPC handlers + approval handlers; existing `container_config.packages` rows become inert (next spawn ignores them since `imageTag` is also gone after 5B revert).
- **5D:** revert removes the lifecycle module; v1's existing `emergencyStop` keeps working.
- **5E:** revert removes the MCP tool + handler; existing agent groups created by it are kept (they're regular `agent_groups` rows).

## Out of scope

These are SKIP / SKIP-ARCH per triage and explicitly NOT in Phase 5:

- **Cross-container agent messaging** (`agent_destinations` table, `channel_type='agent'` route, `send_to_agent` MCP tool). Triage classifies as Phase 7 — depends on Phase 6 per-session containers to have anything useful to send between. v2's `create_agent` writes destination rows; v1's `create_agent` does not (5E ships without destinations because there's no peer-agent IPC).
- **Per-session containers + two-DB IPC.** Phase 6.
- **Heartbeat-driven stuck detection.** Phase 6 (depends on per-session containers + cross-mount file-watch).
- **Pre-task script hook (`task-script.ts` in v2).** Already in v1 since CHANGES.md §6 (`scheduled_tasks.script` column + container-side `task-script.ts`). Confirmed grep on `/data/nanotars/container/agent-runner/src/task-script.ts` exists. Not Phase 5.
- **Real non-Claude provider implementations** (Codex, OpenCode, Ollama). Phase 5A ships only the seam + `claude` provider; concrete providers land as plugins post-Phase-5 when needed.
- **Skill-installable provider branches.** v1 keeps providers as plugins (decision #5 above).
- **Provider-aware session_state continuation namespacing.** v1 stores `sessionId` per group folder; namespacing per provider would require schema change. Triage flags this as PORT-trivial paired with provider abstraction; deferred to whenever the first non-Claude provider lands.
- **Container hardening flag set** (cap-drop, seccomp, etc.). v1 already has these (`container-runtime.ts:155-177`). No work in Phase 5.
- **OneCLI manual-approval bridge**: already shipped Phase 4C C6.

## Pre-flight invariants (verified by 5A-00)

A preflight task at the top of each sub-phase documents the actual state on disk before that sub-phase touches it. This addresses the Phase 4 lesson: D1's spec drifted from the code that landed.

**5A pre-flight** verifies:
- `agent_groups.agent_provider` column exists (Phase 4A) — `PRAGMA table_info(agent_groups)` confirms.
- `container/agent-runner/src/index.ts` calls `query(...)` exactly once at the SDK entry point (single-call invariant).
- No existing module imports a "provider" symbol — the namespace is free.

**5B pre-flight** verifies:
- `agent_groups.container_config` is `TEXT` (JSON-encoded) — `PRAGMA table_info`.
- `CONTAINER_IMAGE` resolves to `nanoclaw-agent:latest` (or env-var override) — `src/config.ts:41-42`.
- `container/build.sh` produces a working `nanoclaw-agent:latest` against the current Dockerfile (run `./container/build.sh` once and verify exit code 0; image inspect shows expected layers).

**5C pre-flight** verifies:
- Phase 4C's `requestApproval` + `registerApprovalHandler` exports exist — `grep` confirms.
- 5B's `buildAgentGroupImage` is exported and called-trivially in tests — smoke test green.
- 5A's `claudeProvider` is the active default — `grep` confirms registry entry.

**5D pre-flight** verifies:
- `GroupQueue.emergencyStop` exists and is unmodified — line 359.
- `command-gate.ADMIN_COMMANDS` includes the existing slash commands — Phase 4B.
- No process-level pause flag exists yet — `grep -n "let paused\|isPaused\|pausedGate"` returns nothing in `src/`.

**5E pre-flight** verifies:
- Phase 4B `addAgentGroupMember`, `isAdminOfAgentGroup`, `isGlobalAdmin`, `isOwner` all exported.
- `createAgentGroup` accessor exists with the current signature (`name, folder, agent_provider?, container_config?`).
- `groups/global/IDENTITY.md` exists as the fallback identity source.

## Test plan summary

Per Phase 4 lessons (D1 spec-drift, schema discovery), each sub-phase commits include schema/state verification commands in the preflight, and adds tests-first for new accessor functions.

| Sub-phase | New host-side tests | New container-side tests |
|-----------|---------------------|--------------------------|
| 5A        | provider-registry tests (factory + register + list); resolveProviderName tests; provider-container-registry tests; plugin-loader-agentProvider tests | AgentProvider claude impl smoke test (mocked SDK); QueryInput shape tests |
| 5B        | generateAgentGroupDockerfile tests (output assertion); buildAgentGroupImage integration tests (mocked execSync); imageTag fallback tests | none |
| 5C        | install_packages handler tests (validation matrix, approval call); add_mcp_server handler tests; applyInstallPackages tests (config mutation, build call, kill call); applyAddMcpServer tests | install_packages MCP tool tests (validation); add_mcp_server MCP tool tests |
| 5D        | pausedGate tests (state machine); GroupQueue paused-gate integration tests; admin command tests for /pause + /resume | emergency_stop / resume_processing MCP tool tests |
| 5E        | create_agent handler tests (admin gating, folder generation, path traversal, FS scaffold); initGroupFilesystem tests | create_agent MCP tool tests (admin-conditional registration) |

**Safety-critical test focus:** 5C's approval flow is the highest-risk surface. End-to-end test `tests/integration/self-mod-flow.test.ts` exercises:
1. Agent fires `install_packages({apt: ['curl']})`.
2. IPC reaches host; `handleInstallPackages` validates + queues approval.
3. Mock-admin clicks Approve on the rendered card.
4. `applyInstallPackages` mutates `container_config.packages.apt` (assert), calls `buildAgentGroupImage` (assert; mocked), schedules container kill (assert).
5. Verify `container_config.imageTag` is set to `nanoclaw-agent:<group-id>` (assert).

Plus a negative-path test: invalid apt name (`bad name with spaces`) → notify-back, no approval queued.

## Reviewer dispatch matrix

Per the catch-up convention "always dispatch reviewer for IPC/schema/Dockerfile changes":

| Task type | Reviewer dispatch? |
|-----------|---|
| Container-side MCP tool definition | YES — agent-runner schema change |
| IPC type union additions in `ipc/types.ts` | YES — host↔container contract |
| Dockerfile-generation code in `container-runner.ts` | YES — image-build surface |
| Per-group `Dockerfile.partial` plumbing changes | YES — image-build surface |
| Approval-handler registration | YES — security boundary |
| `pausedGate` module | NO — single-file mechanical |
| Pure helper / accessor / type-only changes | NO — single-file mechanical |
| `command-gate.ADMIN_COMMANDS` additions | NO — single-file mechanical |
| Plan steps that modify `src/index.ts` startup | YES if wiring approval handlers; NO if only logger config |

## Open questions surfaced (decided autonomously)

These are spec-locked decisions where the v2 reference and the v1 context disagreed and a choice had to be made. Flagged here for sanity-check.

1. **Per-group images stack on `nanoclaw-agent:latest` (which already has plugin partials), not on `node:22-slim` directly.** v2's `generateAgentGroupDockerfile` includes plugin partials inline because v2's trunk has zero of them; v1's trunk ships partials in the base. Stacking is the correct v1 answer; v2's pattern would lose plugin-installed tooling for self-mod-using groups. **Risk:** if a plugin partial is removed and the base rebuilt, per-group images become "frozen at last-build's plugin state". Acceptable trade given plugin churn rate; documented above.

2. **`add_mcp_server` does NOT rebuild the image.** v2's pattern, kept verbatim. The MCP server config is read at agent-runner startup from `container_config.mcpServers`; container restart is sufficient. Saves a rebuild for every server-add.

3. **Provider abstraction uses plugin manifests (v1 native), not skill branches (v2 native).** Spec decision #5. The plugin-loader's existing `containerEnvVars` + `Dockerfile.partial` + `containerHooks` pipeline is enough to express a provider; new `agentProvider: true` flag tells the loader to also call `registerProviderContainerConfig`.

4. **Pause/resume keeps v1's `emergencyStop` AND adds `pausedGate`.** v2 collapsed the two into one (v2's `pause()` calls `killAllContainers`). v1's `emergencyStop` already does the kill; the new layer is the "block future wakes" gate. Two layers, separate concerns: kill-now (existing) + suspend-future (new).

5. **`create_agent` does NOT auto-wire to messaging groups.** v2 wires destinations (its peer-agent rail); v1 has no peer-agent rail in Phase 5. The admin runs `/wire <messaging-group> <agent-group>` after creation. Avoids a coupling between 5E and the wiring command (which is itself a Phase 4D operational follow-up not yet shipped — flagged in 5E spec as a known dependency on operator action).

6. **5A is small enough that 5C could absorb it.** Considered but rejected: the seam has standalone value (clean test surface, future provider plugins, decouples 5C/5E from the SDK call). Splitting keeps the PR boundary clean and lets reviewer dispatch focus on the IPC + Dockerfile changes (5B/5C/5E) without conflating with the seam refactor (5A).

7. **`add_mcp_server` command-allowlist is locked, not an open question.** Allowlist: `npx`, `node`, `python`, `python3`, `bash`, `/usr/local/bin/<basename>`, `/workspace/<path>/<basename>`. Anything else rejects with `"command not allowed; common patterns: npx <pkg>, node <script>, /usr/local/bin/<binary>"`. Documented in 5C-03 plan task.

## Implementation references

- v2 self-mod handler: `/data/nanoclaw-v2/src/modules/self-mod/apply.ts` lines 21-66
- v2 self-mod request: `/data/nanoclaw-v2/src/modules/self-mod/request.ts` lines 20-91
- v2 self-mod MCP tool: `/data/nanoclaw-v2/container/agent-runner/src/mcp-tools/self-mod.ts` (full file)
- v2 generateAgentGroupDockerfile: `/data/nanoclaw-v2/src/container-runner.ts` lines 569-607
- v2 buildAgentGroupImage: `/data/nanoclaw-v2/src/container-runner.ts` lines 610-659
- v2 lifecycle module: `/data/nanoclaw-v2/src/modules/lifecycle/index.ts` (full file)
- v2 lifecycle actions: `/data/nanoclaw-v2/src/modules/lifecycle/actions.ts` (full file)
- v2 create_agent handler: `/data/nanoclaw-v2/src/modules/agent-to-agent/create-agent.ts` (full file)
- v2 create_agent MCP tool: `/data/nanoclaw-v2/container/agent-runner/src/mcp-tools/agents.ts` (full file)
- v2 AgentProvider interface: `/data/nanoclaw-v2/container/agent-runner/src/providers/types.ts` (full file)
- v2 provider-registry: `/data/nanoclaw-v2/container/agent-runner/src/providers/provider-registry.ts` (full file)
- v2 host provider-container-registry: `/data/nanoclaw-v2/src/providers/provider-container-registry.ts` (full file)
- v1 GroupQueue.emergencyStop: `/data/nanotars/src/group-queue.ts` lines 359-389
- v1 MessageOrchestrator.pause/resume: `/data/nanotars/src/orchestrator.ts` lines 435-460
- v1 ContainerConfig type: `/data/nanotars/src/types.ts` lines 30-33
- v1 Phase 4A agent_groups schema: `/data/nanotars/src/db/init.ts` lines 16-24
- v1 Phase 4C requestApproval: `/data/nanotars/src/permissions/approval-primitive.ts` lines 130-193
- v1 Phase 4B addAgentGroupMember: `/data/nanotars/src/permissions/agent-group-members.ts`
- v1 plugin-loader: `/data/nanotars/src/plugin-loader.ts` (full file, manifest schema lines 76-103)
- v1 IPC tasks reader: `/data/nanotars/src/ipc/tasks.ts`
- v1 ipc-mcp-stdio MCP server: `/data/nanotars/container/agent-runner/src/ipc-mcp-stdio.ts` (full file)
- v1 command-gate: `/data/nanotars/src/command-gate.ts` (full file)
- v1 container Dockerfile: `/data/nanotars/container/Dockerfile` (full file)
- v1 build.sh plugin partial concat: `/data/nanotars/container/build.sh` lines 25-66
