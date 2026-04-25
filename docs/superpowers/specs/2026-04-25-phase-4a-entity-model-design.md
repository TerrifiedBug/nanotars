# Phase 4A: Entity-model migration — Design

**Status:** Approved 2026-04-25 (Danny accepted all decisions in brainstorming session).

## Goal

Split v1's single `registered_groups` table into v2's three-table entity model (`agent_groups`, `messaging_groups`, `messaging_group_agents`) on v1-archive. Refactor router/db/IPC callers to use `(messaging_group, agent_group)`-pair routing. Keep v1's existing per-group container model untouched (per-group containers stay; this phase is purely the central-DB shape change).

This is the foundation for Phase 4B (RBAC), Phase 4C (approval primitive), Phase 4D (multi-user flows).

## Scope decisions (locked)

1. **Filesystem mapping:** keep `groups/<folder>/` as v1 has it; add `agent_groups.folder UNIQUE` column pointing at it. Folder remains user-visible identity; `agent_groups.id` is the internal key for foreign references.
2. **Sender-allowlist subsumption:** preserved both axes — `sender_scope='all'|'known'` AND `ignored_message_policy='drop'|'observe'` migrate from `registered_groups` (Phase 2 columns) into `messaging_group_agents`. The legacy `src/sender-allowlist.ts` two-mode richness gets reconciled in Phase 4B; 4A just moves the columns into the new wiring table.
3. **Cutover:** hard cutover in one phase. Drop `registered_groups`, refactor all callers to the new tables. Single coherent change.
4. **`unknown_sender_policy` default:** v2 uses `'strict' | 'request_approval' | 'public'`. Default for legacy migrated rows = `'public'` (preserves v1's current "any sender can engage" behavior; flip per-group once 4D ships).
5. **Migration policy applies:** every new table gets `CREATE TABLE` in `createSchema` AND a numbered `MIGRATIONS` entry. The data migration (split rows) gets its own migration entry.

## Schema

Three new tables on the central DB (`STORE_DIR/messages.db`):

```sql
-- Agent workspaces. Folder is filesystem identity (groups/<folder>/);
-- id is internal key for FK references.
CREATE TABLE agent_groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  folder          TEXT NOT NULL UNIQUE,
  agent_provider  TEXT,                              -- nullable; defaults to 'claude' at read time
  container_config TEXT,                             -- JSON, retained from v1's registered_groups.container_config
  created_at      TEXT NOT NULL
);

-- Platform groups/channels (one chat on one platform).
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,                -- v1 calls this jid; v2's name
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'public',
                                                     -- 'strict' | 'request_approval' | 'public'
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

-- M:N wiring: which agents handle which messaging groups, with engage rules.
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'pattern',
                                                    -- 'pattern' | 'always' | 'mention-sticky'
                                                    -- (v1 keeps 'always' from Phase 2; v2 calls this 'mention'/'mention-sticky')
  engage_pattern         TEXT,                       -- regex; v1 was 'pattern' on registered_groups
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'observe'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

CREATE INDEX idx_messaging_group_agents_mg ON messaging_group_agents(messaging_group_id);
CREATE INDEX idx_messaging_group_agents_ag ON messaging_group_agents(agent_group_id);
```

Notes on the schema:
- v2 uses `engage_pattern` for the regex column; v1's existing `pattern` (from Phase 2 commit `1e086d2`) is the same thing under the v1 name. Keep the v1 name `pattern` on the new `messaging_group_agents` table to minimize caller refactoring (v1 callers already reference `pattern`). This is one tiny v1↔v2 column-name divergence; it's deliberate and documented in the 4A migration.
- Wait — actually let me settle this in the implementation plan. For now: rename to `engage_pattern` to match v2 and update callers as part of the same atomic refactor. v1↔v2 alignment value > one-line caller churn.
- `session_mode` and `priority` are v2 concepts that don't yet matter for v1's per-group container model. Carried as columns with defaults, unused until Phase 5 needs them.
- `agent_provider` on `agent_groups` carries v1's existing `agent_provider` concept (currently set per-group via plugin config). Default `'claude'`.
- `container_config` JSON retained on `agent_groups` to match v1's existing read path. v2 moved this to disk-only; v1 doesn't have to.

## Migration: `008_split_registered_groups`

Single migration entry in `MIGRATIONS` array (next sequential number after 007 from Phase 3). Steps:

1. `CREATE TABLE` for the three new tables (idempotent — `IF NOT EXISTS`).
2. For each row in `registered_groups`:
   - Insert into `agent_groups`: `id = newUuid()`, `name = row.name`, `folder = row.folder`, `agent_provider = NULL`, `container_config = row.container_config`, `created_at = row.added_at`.
   - Insert into `messaging_groups`: `id = newUuid()`, `channel_type = row.channel`, `platform_id = row.jid`, `name = row.name`, `is_group = 0`, `unknown_sender_policy = 'public'`, `created_at = row.added_at`. Use `INSERT OR IGNORE` so duplicate `(channel_type, platform_id)` pairs (multiple agents on the same chat) only insert once.
   - Insert into `messaging_group_agents`: link the two via the IDs above; carry `engage_mode`, `pattern`→`engage_pattern`, `sender_scope`, `ignored_message_policy` from the legacy row; `created_at = row.added_at`; `session_mode = 'shared'`; `priority = 0`.
3. After successful migration: `DROP TABLE registered_groups`. (SQLite ≥3.35 supports DROP TABLE — confirm v1's `better-sqlite3` ships with that. Phase 3 A2 noted SQLite ≤3.35 cannot drop columns; full table drops are fine on any version.)

The migration is idempotent: running twice on a DB where `registered_groups` already dropped is a no-op (the legacy table doesn't exist; the loop skips). Running on a fresh DB created via `createSchema` (which now creates the three new tables directly): the legacy table never exists; migration is a no-op.

## Caller refactor

Files that read or write `registered_groups` (per `grep -rn 'registered_groups\|getAllRegisteredGroups\|getRegisteredGroup' src/`):

- `src/db/init.ts` — schema + migration definition
- `src/db/state.ts` — `getAllRegisteredGroups`, `getRegisteredGroup`, `addRegisteredGroup`, `updateRegisteredGroup`, `removeRegisteredGroup`. Refactor to read/write the three new tables.
- `src/router.ts` — looks up the (channel, jid) → group; refactor to look up `messaging_groups` by `(channel_type, platform_id)`, then `messaging_group_agents` for the wiring rows, then `agent_groups` for the workspace.
- `src/orchestrator.ts` — uses `pattern`, `sender_scope`, `engage_mode` to drive routing decisions. Now reads from `messaging_group_agents` (pair-keyed).
- `src/sender-allowlist.ts` — currently reads chat-id-keyed allowlist; for 4A keep as-is (subsumption is 4B work); just re-route any DB lookups it does to use the new tables.
- `src/ipc/*.ts` — IPC handlers that reference group state (`update_group`, `available_groups` snapshot, etc.). Refactor to address by `(messaging_group_id, agent_group_id)` pair or by `agent_group.folder` depending on the operation.
- `src/snapshots.ts` — `available_groups.json` writer. Update to source from new tables.
- `src/__tests__/*` — every test that creates a `registered_groups` row needs to create the three new rows instead. There's a small risk this is a lot of churn; mitigation is a test helper `seedAgentGroup({ folder, jid, channel, ... })` that does the three-row insert in one call.

## Hooks (placeholder)

Phase 4A adds two named hook callsites in `router.ts` that 4B will populate:

1. **Sender-resolver hook** — given `(channel, platform_id, sender_name, sender_handle)`, return a `users.id` or `undefined`. 4A: stub returns `undefined`. 4B: real implementation against the `users` table.
2. **Access-gate hook** — given `(user_id, agent_group_id)`, return `boolean`. 4A: stub returns `true`. 4B: real `canAccessAgentGroup` against `user_roles` + `agent_group_members`.

Stubs are explicit `function name() { return X; }` exports in `src/permissions.ts` (new file) so 4B can drop them in without changing call sites.

## Tests

Each task ships its own tests, but the phase's overall testing posture:

- `MIGRATIONS` test (mirrors Phase 3 A2): in-memory DB built with v1's pre-008 schema (with `registered_groups` populated) → run migrations → assert the three new tables have the expected rows; `registered_groups` is gone.
- DB accessor tests (`src/db/__tests__/state.test.ts` or new file): `getAllAgentGroups()`, `getMessagingGroup(channel, platform_id)`, `getWiringForMessagingGroup(messaging_group_id)`, etc. Each accessor gets unit tests against an in-memory DB.
- Router tests (`src/__tests__/router.test.ts`): inbound message arrives → router resolves messaging group → finds wiring rows → dispatches to the agent group. A second test where multiple wiring rows match (same chat, two agents) → both dispatched.
- Hook callsite tests: stub returns are exercised; placeholder hooks visible at the right lines.

## Out of scope (deferred to 4B/4C/4D)

- `users` / `user_roles` / `agent_group_members` / `user_dms` tables (4B).
- `pending_approvals` table + `requestApproval` + `pickApprover` (4C).
- OneCLI manual-approval bridge (4C — depends on `pickApprover`).
- `pending_sender_approvals`, `pending_channel_approvals`, `pending_questions`, `ask_question` MCP tool (4D).
- Reconciliation of v1's `src/sender-allowlist.ts` semantic richness against v2's binary `sender_scope` (4B).
- v1's `__group_sync__` magic-row hack on `chats` (out of scope for 4A; CONTRIBUTE-as-cleanup if v1 wants it gone).

## Effort

Triage estimates 4A at ~3-4 weeks for a full team. With subagent-driven-development on a focused single-DB-tier project, expect 8-12 task commits + 1 phase-final review. Sub-tasks roughly:

- A1: schema + migration entry + migration tests
- A2: db/state.ts accessor refactor (CRUD) + tests
- A3: router refactor + tests
- A4: orchestrator refactor + tests
- A5: IPC handlers refactor + tests
- A6: snapshots.ts update
- A7: hook stubs in permissions.ts + callsite wiring
- A8: cleanup (remove dead `registered_groups` references) + final phase review

The actual plan will be more granular per-task; this section is a sizing estimate.
