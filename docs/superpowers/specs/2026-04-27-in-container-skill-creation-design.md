# In-Container Skill Creation — Design Spec

**Date:** 2026-04-27
**Slice:** v1↔v2 catch-up — in-container skill-creation flow correctness
**Status:** Approved for planning
**BACKLOG entry:** lines 72-77

## Problem

When a user in a Telegram (or other channel) chat asks TARS "build me a skill that does X", in-container TARS has no awareness of NanoClaw's plugin format and no primitive to install a new plugin. The host has `/create-skill-plugin` and `/nanotars-publish-skill` SKILLs that handle this end-to-end, but they require the operator to be at the host. The plugin-boundary rules in `CLAUDE.md` are also host-only.

Result: TARS either improvises (producing non-marketplace-compliant output) or punts entirely. The chat-first UX promised by NanoClaw's design — "ask in chat, get a working capability" — is broken for skill creation.

## Goals

1. In-chat skill creation works end-to-end for skill-only and MCP-integration plugins.
2. The operator does not need to SSH to the host for the common case.
3. Security boundary preserved: container submits structured data, host validates and acts under admin approval.
4. Three sources of truth (host create-skill-plugin SKILL, host publish SKILL, container create-skill-plugin SKILL) stay in sync via a drift-detection workflow.

## Non-goals

- In-chat creation of host-process hooks (archetype 3) or container hooks (archetype 4) — operator runs `/create-skill-plugin` on the host for those.
- In-chat publishing to the `nanotars-skills` marketplace — operator runs `/nanotars-publish-skill` on the host.
- `gh` CLI availability or GitHub auth inside agent containers (BACKLOG line 76 — deferred; not unblocked or blocked by this slice).
- Credential collection at approval-card time (a richer per-channel UX). For now, credentials are gathered in DM during the conversational flow.
- Plugins that require system packages (`Dockerfile.partial`) — these need an image rebuild and stay host-only.

## Architecture

Three layered artifacts, each with one clear responsibility.

### 1. Boundary rules in `groups/global/CLAUDE.md`

Always loaded for every in-container TARS. Tells TARS what it can and cannot create from chat. Short — under 30 lines. Lives next to existing memory-tier and communication rules.

### 2. Conversational SKILL in `container/skills/create-skill-plugin/SKILL.md`

Mounted at `/workspace/.claude/skills/create-skill-plugin/` for every agent container (matching how `agent-browser` and `self-customize` are mounted today). Loaded on demand when triggers fire ("create a skill", "make a plugin", "build a skill"). Contains the conversational flow, archetype templates for archetypes 1 and 2 only, and the call to the `create_skill_plugin` MCP tool. Roughly 300 lines, scoped down from the host's 818-line SKILL.

### 3. `create_skill_plugin` MCP tool

Container-side: registered in `container/agent-runner/src/mcp-tools/`, mirrors `add_mcp_server`'s shape. Emits an IPC task with the full plugin spec.

Host-side: `src/permissions/create-skill-plugin.ts` validates the spec, queues an approval card via the existing `requestApproval` primitive, and on approve writes plugin files + restarts the originating group's container.

## Data flow

```
[Chat]                                      [Container]                              [Host]
User: "make me a weather skill"
        ↓
TARS conducts design conversation
(asks about API, env vars, scope)
        ↓
TARS invokes create-skill-plugin SKILL
        ↓
                                  mcp__nanoclaw__create_skill_plugin({...})
                                  → emits IPC task JSON to shared volume
                                                                                IPC watcher reads task
                                                                                handleCreateSkillPluginRequest
                                                                                validates spec (defense-in-depth)
                                                                                requestApproval('create_skill_plugin', ...)
                                                                                pending_approvals row created
                                                                                approval card → admin chat
[Admin chat]
Admin clicks Approve
                                                                                applyDecision('approved'):
                                                                                  1. write plugins/{name}/
                                                                                  2. write .claude/skills/add-skill-{name}/
                                                                                  3. append .env (root or per-group)
                                                                                  4. restartGroup(folder)
                                                                                  5. notifyAgent
[Original chat]
TARS: "Plugin live — try it"
```

## Component specs

### Component 1: Boundary rules in `groups/global/CLAUDE.md`

New section to be added (placement: between "Workspace & Memory" and "External vs Internal Actions"):

```markdown
## Creating Skills/Plugins

If a user asks you to build a new skill or plugin, you can do it directly when the request fits these archetypes:

- **Skill-only** — agent calls a public API with curl/Bash. No credentials or background processes.
- **MCP integration** — connects to an MCP server with optional env-var credentials.

To create one, invoke your `create-skill-plugin` skill — it walks through the design and submits the install for admin approval.

You CANNOT create plugins from chat that:
- Run as host-process hooks (HTTP servers, polling loops, message middleware) → these install into NanoClaw's main process and need a host-side review
- Run as container hooks (SDK observers, tool-use loggers) → these run unattended in every agent turn and need a host-side review

For those, sketch the design in chat and tell the user to run `/create-skill-plugin` on the host with your spec.
```

### Component 2: `container/skills/create-skill-plugin/SKILL.md`

Sections (in order):

1. **Frontmatter** — `name`, `description` with triggers ("create skill", "make a plugin", "build a skill", "new plugin")
2. **Quick gate** — if user's idea requires archetype 3 or 4 (host hook, container hook), refuse and redirect to host. Do not proceed past this gate. Examples of gating heuristics ("they want a webhook receiver / polling loop / message middleware / SDK observer").
3. **Conversational flow** (one question at a time, multiple-choice where possible):
   - Phase 1 — what does the plugin do?
   - Phase 2 — archetype detection (skill-only vs MCP); detected internally, not exposed
   - Phase 3 — specifics (API endpoint, MCP server URL/package, etc.)
   - Phase 4 — scope: "available to all groups, or just this one?" Sets `groups` field
   - Phase 5 — credentials: if needed, gate on DM-only context. If group chat, generate spec without credentials and tell user to DM the key OR set manually in `.env`
4. **Archetype 1 (skill-only) template** — `plugin.json` + `container-skills/SKILL.md` with curl-style or scripts/ pattern
5. **Archetype 2 (MCP) template** — `plugin.json` + `mcp.json` + `container-skills/SKILL.md` with MCP tool prefix and curl fallback
6. **Final step** — assemble payload, call `mcp__nanoclaw__create_skill_plugin(...)`, tell user "submitted for approval"

Hard cuts from host SKILL: archetype 3 + 4 templates, `Dockerfile.partial` section, host-only references (`./container/build.sh`, `npm install`, `cp -r ${CLAUDE_PLUGIN_ROOT}`), per-group credential override pattern (handled by the scope question instead).

### Component 3: `create_skill_plugin` MCP tool (container-side)

Location: `container/agent-runner/src/mcp-tools/create-skill-plugin.ts`

Schema:

```ts
{
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  description: z.string().min(1).max(200),
  archetype: z.enum(['skill-only', 'mcp']),
  pluginJson: z.object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    containerEnvVars: z.array(z.string()).optional(),
    publicEnvVars: z.array(z.string()).optional(),
    channels: z.array(z.string()).default(['*']),
    groups: z.array(z.string()).default(['*']),
  }).strict(),
  containerSkillMd: z.string().min(1).max(20000),
  mcpJson: z.string().optional(),
  envVarValues: z.record(z.string()).optional(),
}
```

Behavior: validates with Zod, then writes an IPC task identical in shape to `add_mcp_server`'s (`{ action: 'create_skill_plugin', payload: { ...input, groupFolder: <current> } }`).

### Component 4: Host handler `src/permissions/create-skill-plugin.ts`

Mirrors `src/permissions/add-mcp-server.ts` exactly:

- `handleCreateSkillPluginRequest(task, originatingChannel)`:
  - Resolve `agentGroup` from `task.groupFolder`
  - Run all validation rules (Section "Validation rules" below)
  - On any failure: `notifyAgent(ag.id, 'create_skill_plugin failed: <reason>')`, return undefined
  - On success: `await requestApproval({ action: 'create_skill_plugin', agentGroupId: ag.id, payload, originatingChannel })`
  - Return `approvalId`

- `registerCreateSkillPluginHandler(deps: { restartGroup })`:
  - `render({ payload })` — builds the approval card body (see "Approval card content" below)
  - `applyDecision({ approvalId, payload, decision })`:
    - On `rejected` or `expired`: `notifyAgent` and return
    - On `approved`: execute the write+restart sequence (see "Atomicity" below)

### Component 5: Wiring in `src/index.ts`

One new line at boot, next to existing handler registrations:

```ts
registerCreateSkillPluginHandler({ restartGroup: queue.restartGroup.bind(queue) });
```

And one new dispatch line in the IPC watcher (matching the existing `add_mcp_server` dispatch).

## Validation rules

All rules enforced **both** container-side (Zod, fast feedback to TARS) and host-side (final gate, untrusted-input model).

| Rule | Check | Reason |
|---|---|---|
| Name format | `^[a-z][a-z0-9-]{1,30}$` | Filesystem path safety |
| Name uniqueness | `plugins/{name}/` doesn't exist | No silent overwrite |
| Archetype | `'skill-only' \| 'mcp'` only | Reject 3/4 even if container side allowed |
| `pluginJson.hooks` | Empty or absent | Host hooks not allowed |
| `pluginJson.containerHooks` | Empty or absent | Container hooks not allowed |
| `pluginJson.dependencies` | False or absent | No `npm install` shell-out |
| Forbidden files | No `Dockerfile.partial` | No image rebuild path |
| Env var name format | `^[A-Z][A-Z0-9_]{0,63}$` | Standard env var naming |
| Reserved env var names | Reject `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ASSISTANT_NAME`, `CLAUDE_MODEL`, `NANOCLAW_*` | Prevent clobbering install-level secrets and runtime config |
| Payload size | `containerSkillMd` ≤ 20 KB, `mcpJson` ≤ 4 KB | Bound `pending_approvals` row size |
| `mcpJson` shape | Valid JSON; only `mcpServers.<name>.{type,url,command,args,env,headers}` keys; `command` matches existing add-mcp-server allowlist | Reuse existing trust model |
| Channel allowlist | Each entry from `{'*', 'whatsapp', 'discord', 'telegram', 'slack', 'webhook'}` | Catch typos that silently disable plugin |
| Group scope | `groups` is `['*']` OR contains only `originatingGroupFolder` | TARS can only install for itself or globally |

## Approval card content

```
TARS wants to install a new plugin: "weather"

Description: Look up current weather for a location

Archetype: skill-only
Channels: [*]   Groups: [*]
Files to create:
  .claude/skills/add-skill-weather/SKILL.md (4.2 KB)
  .claude/skills/add-skill-weather/files/plugin.json
  .claude/skills/add-skill-weather/files/container-skills/SKILL.md
  plugins/weather/plugin.json
  plugins/weather/container-skills/SKILL.md

Credentials: none
Restart: per-group container only

[ Approve ]   [ Reject ]
```

For credential cases, env vars rendered with redacted values and explicit destination:

```
Credentials:
  OPENWEATHER_API_KEY = ab****xz   → root .env (global)
```

or

```
Credentials:
  GMAIL_TOKEN = gh_****abc   → groups/work/.env (work group only)
```

The destination is determined by `groups` scope: `['*']` → root `.env`; specific folder → `groups/{folder}/.env`.

## Atomicity (file-write ordering)

`applyDecision('approved')` writes in this order so any partial failure rolls back cleanly:

1. **Write `plugins/{name}/`** (the install target) — fail here: drop, notify, no published artifact exists yet
2. **Write `.claude/skills/add-skill-{name}/`** (template, useful for later publishing) — fail here: also delete `plugins/{name}/`, notify
3. **Append `.env`** (root or per-group, based on `groups` scope) — fail here: delete both directories, notify
4. **Restart per-group container** via `deps.restartGroup(folder, 'create_skill_plugin applied')` — fail here: leave files in place (matches `add_mcp_server` behavior), notify with "will load on next restart"

## Failure paths

| Failure | Detection | Behavior | User-visible |
|---|---|---|---|
| Container-side validation | Zod throws | TARS retries or apologizes | "Spec was malformed: <reason>" |
| IPC task malformed | Host watcher rejects | Drop, log warn | (silent) |
| Host validation fail | Pre-approval reject | `notifyAgent` with reason | TARS surfaces to user |
| Approval rejected/expired | `applyDecision` non-approve | `notifyAgent("rejected/expired, NOT installed")` | TARS tells user |
| File write fail | try/catch around `fs.writeFile` | Roll back per atomicity above | TARS surfaces error |
| `.env` append fail | try/catch | Roll back both directories | TARS surfaces error |
| `restartGroup` fail | try/catch at end | Files persist, "load on next restart" notify | TARS tells user |
| Plugin loads but is broken | Not detectable from `applyDecision` | Out of scope; matches `add_mcp_server` risk surface | User runs `/nanotars-remove-plugin` |

No new schema. Reuses existing `pending_approvals` table — just a new `action` value (`'create_skill_plugin'`).

## Restart strategy

Per-group container only. Same as `add_mcp_server`. The main NanoClaw process keeps running; other groups' containers keep running. The originating group's container stops, and the next inbound message respawns it with the new plugin loaded — `plugin-loader.getPluginsForGroup(channel, folder)` rescans on each spawn.

No image rebuild. Skill-only and MCP archetypes don't ship `Dockerfile.partial` (rejected at validation).

## Periodic accuracy re-check

Three SKILLs/docs at risk of drift when the plugin interface evolves:
- `.claude/skills/create-skill-plugin/SKILL.md` (host)
- `.claude/skills/nanotars-publish-skill/SKILL.md` (host)
- `container/skills/create-skill-plugin/SKILL.md` (container — this slice's new artifact)
- Plus the Plugin Boundary section in `CLAUDE.md` and the new "Creating Skills/Plugins" section in `groups/global/CLAUDE.md`

Mechanism: a soft CI hint via `scripts/check-skill-drift.sh` that runs in PR checks. When any of these files change without a corresponding SKILL update, emits a non-blocking warning:

```
⚠️ Plugin interface files changed but skill docs were not updated:
  src/plugin-loader.ts modified
  → please review:
    .claude/skills/create-skill-plugin/SKILL.md
    .claude/skills/nanotars-publish-skill/SKILL.md
    container/skills/create-skill-plugin/SKILL.md
    groups/global/CLAUDE.md (Creating Skills/Plugins section)
    CLAUDE.md (Plugin Boundary section)
```

Watched files: `src/plugin-loader.ts`, `src/plugin-types.ts`, `src/container-mounts.ts`, `src/permissions/create-skill-plugin.ts`.

Author acknowledges by amending the commit with `skills-reviewed: yes` (or by updating the relevant SKILL).

Manual baseline log at `docs/skill-drift-log.md`:

| Skill | Last verified | Commit |
|---|---|---|
| host create-skill-plugin | 2026-04-27 | (initial) |
| host nanotars-publish-skill | 2026-04-27 | (initial) |
| container create-skill-plugin | (this slice) | (this slice) |
| boundary rules in groups/global/CLAUDE.md | (this slice) | (this slice) |

Soft, not blocking — text-diff CI cannot semantically verify accuracy. The hint surfaces the review, the human does the actual check.

## Testing

### Unit tests

| File | Coverage |
|---|---|
| `src/permissions/__tests__/create-skill-plugin.test.ts` | Every validation rule (Section "Validation rules"); `requestApproval` queues row; `applyDecision('approved')` writes files in order, appends `.env`, calls `restartGroup`; `applyDecision('rejected')` notifies, no files written; rollback when middle write fails |
| `container/agent-runner/src/mcp-tools/__tests__/create-skill-plugin.test.ts` | Zod schema rejects malformed inputs; IPC task emitted with correct shape and `groupFolder` populated |

### E2E test

`src/__tests__/e2e/create-skill-plugin-flow.test.ts`:

1. Setup: temp project root, fake IPC volume, in-memory DB, mock `restartGroup`
2. Inject IPC task representing TARS calling `create_skill_plugin` with a skill-only spec for "weather"
3. Assert `pending_approvals` row created with correct agent group and payload
4. Simulate admin approval via direct `applyDecision('approved')` call
5. Assert `plugins/weather/plugin.json` has correct contents
6. Assert `plugins/weather/container-skills/SKILL.md` exists
7. Assert `.claude/skills/add-skill-weather/` exists
8. Assert `restartGroup` called once with correct folder
9. Assert second `getPluginsForGroup(channel, folder)` returns the new plugin
10. Negative: same flow with `archetype: 'host-hook'` rejected pre-approval, no files written

This is the test BACKLOG line 75 calls for, minus the marketplace PR step (publishing stays a host-side operation).

### Manual smoke test

In the implementation plan's last task:

1. Real Telegram message: "TARS, build a wttr.in weather skill"
2. TARS conducts conversation, calls MCP tool
3. Approval card appears in admin chat
4. Approve
5. After restart, verify the skill is mounted: `docker exec <container> ls /workspace/.claude/skills/weather/`
6. Send "What's the weather in London?" — TARS uses the new skill

## Migration / rollout

No schema migration needed (reuses `pending_approvals`). No backwards-compat concerns (new feature, no existing users of in-chat skill creation).

Rollout: ship the host handler + MCP tool + container SKILL + boundary rules together in one PR. The new MCP tool is invisible to TARS until the container SKILL is mounted, and the SKILL is invisible until the boundary rules tell TARS it exists. Atomic.

## Security summary

- Container submits structured data only; host writes files
- Two validation surfaces (Zod container-side, full re-validation host-side)
- Approval gate enforced by admin (existing `pending_approvals` routing, unchanged)
- Archetype 3 + 4 hard-rejected — no path to install host-process or container hooks from chat
- Group scope restricted to `['*']` or originating folder — TARS cannot install for a different group
- Reserved env var names protected (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ASSISTANT_NAME`, `CLAUDE_MODEL`, `NANOCLAW_*`)
- `secret-redact.ts` already redacts plugin env vars from outbound messages once registered
- Approval card displays redacted credential values (`ab****xz`) and explicit destination path

## File list

**New files:**
- `container/skills/create-skill-plugin/SKILL.md`
- `container/agent-runner/src/mcp-tools/create-skill-plugin.ts`
- `container/agent-runner/src/mcp-tools/__tests__/create-skill-plugin.test.ts`
- `src/permissions/create-skill-plugin.ts`
- `src/permissions/__tests__/create-skill-plugin.test.ts`
- `src/__tests__/e2e/create-skill-plugin-flow.test.ts`
- `scripts/check-skill-drift.sh`
- `docs/skill-drift-log.md`

**Modified files:**
- `groups/global/CLAUDE.md` — add "Creating Skills/Plugins" section
- `src/index.ts` — wire `registerCreateSkillPluginHandler`
- `src/ipc.ts` (or wherever IPC dispatch lives) — add dispatch case for `create_skill_plugin` action
- `docs/CHANGES.md` — entry for the slice
- `docs/BACKLOG.md` — close the in-container skill-creation tasks (lines 72-77)

**Deferred (kept in BACKLOG):**
- `gh` in container + auth surface
- In-chat publishing to marketplace
- Archetypes 3 + 4 in chat
- Credential collection at approval-card time
- Auto-rollback on plugin load failure

## Estimated size

4-6 days of implementation work. Roughly:
- Day 1-2: host handler + validation + unit tests
- Day 2-3: container MCP tool + IPC dispatch + tests
- Day 3-4: container SKILL.md content + boundary rules
- Day 4-5: E2E test + manual smoke test
- Day 5-6: drift-check script + docs/CHANGES + BACKLOG cleanup
