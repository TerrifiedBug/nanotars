# Phase 4A: Entity-model migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split v1's `registered_groups` table into `agent_groups` + `messaging_groups` + `messaging_group_agents`. Refactor all callers to read/write the new tables. Drop `registered_groups`. Add hook stubs (sender-resolver, access-gate) for Phase 4B to fill in.

**Architecture:** Soft cutover within Phase 4A — schema + new accessors land first; existing callers migrate one tier at a time (orchestrator, IPC, snapshots, container-runner); legacy table dropped in the final cleanup task. Each task ships a working v1-archive. Hard cutover at the phase boundary (no `registered_groups` after 4A).

**Tech Stack:** Node 22, TypeScript 5.9, vitest 4, better-sqlite3 11, pino 9. **npm**, not pnpm — v1-archive uses npm with `package-lock.json`. Run `npm test`, `npm run typecheck`, `npm install`. Never run pnpm.

**Spec input:** `/data/nanotars/docs/superpowers/specs/2026-04-25-phase-4a-entity-model-design.md` — locks scope decisions and schema.

---

## CONTRIBUTE upstream PRs — out of scope

Same as Phases 1-3. CONTRIBUTE-class items (e.g., `isValidGroupFolder` defense-in-depth on v2's `agent_groups.folder` reads) are PRs to qwibitai/nanoclaw, separate workstream.

---

## Items deferred from Phase 4A

- `users` / `user_roles` / `agent_group_members` / `user_dms` (Phase 4B).
- `pending_approvals` table + `requestApproval` + `pickApprover` (Phase 4C).
- OneCLI manual-approval bridge (Phase 4C — depends on `pickApprover`).
- `pending_sender_approvals`, `pending_channel_approvals`, `pending_questions`, `ask_question` MCP tool (Phase 4D).
- Reconciliation of `src/sender-allowlist.ts` semantic richness against the new `messaging_group_agents` columns (Phase 4B).

---

## Pre-flight verification

- [ ] **Step 1: Verify nanotars is on v1-archive with clean tree**

Run: `cd /data/nanotars && git status --short --branch`
Expected: `## v1-archive...origin/v1-archive` with no other lines.

- [ ] **Step 2: Verify Phase 3 + spec HEAD**

Run: `cd /data/nanotars && git log --oneline -2`
Expected: `9a16dd9 docs(spec): Phase 4A entity-model design` then `d6ec400 docs(triage): mark Phase 3 done...`

- [ ] **Step 3: Verify baseline test counts**

Run: `cd /data/nanotars && npm test 2>&1 | tail -5`
Expected: 504 passing.

Run: `cd /data/nanotars/container/agent-runner && bun test 2>&1 | tail -5`
Expected: 29 passing.

- [ ] **Step 4: Re-confirm typecheck clean**

Run: `cd /data/nanotars && npm run typecheck`
Expected: clean exit.

---

## Task A1: Schema + migration `008_split_registered_groups`

**Triage row:** Spec section "Schema" + "Migration." Land the three new tables in `createSchema` AND a numbered migration entry that splits existing `registered_groups` rows into the new shape. Do NOT drop `registered_groups` yet — that's Task A7. This task ensures the new tables exist and are populated; existing callers keep working off the legacy table.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` — add three CREATE TABLE statements to `createSchema`; append `008_split_registered_groups` migration entry.
- New: `/data/nanotars/src/__tests__/migration-008.test.ts` — migration test mirroring Phase 3 A2's pattern (migration-007.test.ts).

- [ ] **Step 1: Read existing schema + migration framework**

Read `/data/nanotars/src/db/init.ts` in full. Note:
- Where `createSchema` is defined (the SQL-block function near top).
- Where `MIGRATIONS` array ends — currently `007_add_engage_mode_axes`.
- The `safeAddColumn` helper, `runMigrations` (exported), `hasTable` (exported).
- Whether there's a `newUuid()` or similar helper already in use; if not, the migration can use `crypto.randomUUID()` (Node 22 has it).

- [ ] **Step 2: Write failing migration test**

Create `/data/nanotars/src/__tests__/migration-008.test.ts`. Pattern mirrors migration-007.test.ts:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('migration 008_split_registered_groups', () => {
  it('splits a populated registered_groups into agent_groups + messaging_groups + messaging_group_agents', async () => {
    const db = new Database(':memory:');

    // Build the pre-008 schema (registered_groups with 4-axis engage cols + Phase 3 backfill applied)
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        pattern TEXT,
        added_at TEXT NOT NULL,
        container_config TEXT,
        engage_mode TEXT NOT NULL DEFAULT 'pattern',
        sender_scope TEXT NOT NULL DEFAULT 'all',
        ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
        channel TEXT
      );
      CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    `);

    const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
    for (const v of [
      '001_add_context_mode', '002_add_model', '003_add_channel',
      '004_add_is_bot_message', '005_add_reply_context', '006_add_task_script',
      '007_add_engage_mode_axes',
    ]) stmt.run(v, new Date().toISOString());

    // Seed two registered_groups rows on the same channel but distinct folders
    db.prepare(`INSERT INTO registered_groups (jid, name, folder, pattern, added_at, container_config, engage_mode, sender_scope, ignored_message_policy, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('alice@s.whatsapp.net', 'Alice', 'alice', '\\bhi\\b', '2026-01-01T00:00:00Z', '{"foo":1}', 'pattern', 'all', 'drop', 'whatsapp');
    db.prepare(`INSERT INTO registered_groups (jid, name, folder, pattern, added_at, container_config, engage_mode, sender_scope, ignored_message_policy, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('bob@s.whatsapp.net', 'Bob', 'bob', null, '2026-01-02T00:00:00Z', null, 'always', 'known', 'observe', 'whatsapp');

    const { runMigrations } = await import('../db/init.js');
    runMigrations(db);

    // Verify three new tables exist
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{name: string}>).map(r => r.name);
    expect(tables).toContain('agent_groups');
    expect(tables).toContain('messaging_groups');
    expect(tables).toContain('messaging_group_agents');

    // agent_groups: one row per legacy folder
    const ags = db.prepare(`SELECT * FROM agent_groups ORDER BY folder`).all() as any[];
    expect(ags).toHaveLength(2);
    expect(ags[0].folder).toBe('alice');
    expect(ags[0].name).toBe('Alice');
    expect(ags[0].container_config).toBe('{"foo":1}');

    // messaging_groups: one row per (channel, jid) pair
    const mgs = db.prepare(`SELECT * FROM messaging_groups ORDER BY platform_id`).all() as any[];
    expect(mgs).toHaveLength(2);
    expect(mgs[0].channel_type).toBe('whatsapp');
    expect(mgs[0].platform_id).toBe('alice@s.whatsapp.net');
    expect(mgs[0].unknown_sender_policy).toBe('public');

    // messaging_group_agents: one wiring row per legacy registered_groups row
    const mga = db.prepare(`SELECT * FROM messaging_group_agents`).all() as any[];
    expect(mga).toHaveLength(2);
    const aliceWiring = mga.find((r: any) => ags.find((a: any) => a.id === r.agent_group_id)?.folder === 'alice');
    expect(aliceWiring.engage_mode).toBe('pattern');
    expect(aliceWiring.engage_pattern).toBe('\\bhi\\b');
    expect(aliceWiring.sender_scope).toBe('all');
    expect(aliceWiring.ignored_message_policy).toBe('drop');

    // schema_version row
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{version: string}>).map(r => r.version);
    expect(versions).toContain('008_split_registered_groups');

    // registered_groups still present (drop is in A7)
    expect(tables).toContain('registered_groups');
  });

  it('is idempotent on a DB created via createSchema (fresh install — no legacy rows)', async () => {
    // Drive the live createSchema so the test catches drift between createSchema and the migration.
    const db = new Database(':memory:');
    const { initDatabase } = await import('../db/init.js');
    initDatabase(db);

    // Migration must be a no-op (registered_groups exists empty); new tables exist (from createSchema).
    const ags = db.prepare(`SELECT * FROM agent_groups`).all();
    expect(ags).toHaveLength(0);
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{version: string}>).map(r => r.version);
    expect(versions).toContain('008_split_registered_groups');
  });
});
```

If `initDatabase` isn't shaped exactly like the second test assumes, adjust based on the file's actual exports. Important: the second test catches schema/migration divergence — if createSchema doesn't include the three new tables, this test will fail.

- [ ] **Step 3: Run failing tests**

Run: `cd /data/nanotars && npx vitest run src/__tests__/migration-008.test.ts`
Expected: FAIL — tables don't exist, migration not registered.

- [ ] **Step 4: Add the three new tables to `createSchema`**

In `/data/nanotars/src/db/init.ts`, find the SQL block in `createSchema` (the `database.exec(...)` call). After the existing tables, add:

```sql
CREATE TABLE IF NOT EXISTS agent_groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  folder          TEXT NOT NULL UNIQUE,
  agent_provider  TEXT,
  container_config TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'public',
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

CREATE TABLE IF NOT EXISTS messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'pattern',
  engage_pattern         TEXT,
  sender_scope           TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_group_agents_mg ON messaging_group_agents(messaging_group_id);
CREATE INDEX IF NOT EXISTS idx_messaging_group_agents_ag ON messaging_group_agents(agent_group_id);
```

- [ ] **Step 5: Append migration `008_split_registered_groups`**

In `MIGRATIONS` array, after `007_add_engage_mode_axes`:

```ts
{
  name: '008_split_registered_groups',
  up: (db) => {
    // 1. Ensure the three new tables exist (idempotent; createSchema also creates them)
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_groups (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        folder          TEXT NOT NULL UNIQUE,
        agent_provider  TEXT,
        container_config TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messaging_groups (
        id                    TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        platform_id           TEXT NOT NULL,
        name                  TEXT,
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'public',
        created_at            TEXT NOT NULL,
        UNIQUE(channel_type, platform_id)
      );
      CREATE TABLE IF NOT EXISTS messaging_group_agents (
        id                     TEXT PRIMARY KEY,
        messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
        agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
        engage_mode            TEXT NOT NULL DEFAULT 'pattern',
        engage_pattern         TEXT,
        sender_scope           TEXT NOT NULL DEFAULT 'all',
        ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
        session_mode           TEXT DEFAULT 'shared',
        priority               INTEGER DEFAULT 0,
        created_at             TEXT NOT NULL,
        UNIQUE(messaging_group_id, agent_group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_group_agents_mg ON messaging_group_agents(messaging_group_id);
      CREATE INDEX IF NOT EXISTS idx_messaging_group_agents_ag ON messaging_group_agents(agent_group_id);
    `);

    // 2. If registered_groups exists, copy its rows into the new tables.
    // Skip if already migrated (idempotent: re-running won't duplicate).
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='registered_groups'`).all() as any[]);
    if (tables.length === 0) return;

    const rows = db.prepare(`SELECT * FROM registered_groups`).all() as any[];
    if (rows.length === 0) return;

    const insertAg = db.prepare(`INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    const insertMg = db.prepare(`INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, 0, 'public', ?)`);
    const findAg = db.prepare(`SELECT id FROM agent_groups WHERE folder = ?`);
    const findMg = db.prepare(`SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?`);
    const insertMga = db.prepare(`INSERT OR IGNORE INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', 0, ?)`);

    for (const row of rows) {
      const channelType = row.channel ?? 'whatsapp'; // Phase 1 default — pre-channel-aware rows
      insertAg.run(crypto.randomUUID(), row.name, row.folder, null, row.container_config, row.added_at);
      insertMg.run(crypto.randomUUID(), channelType, row.jid, row.name, row.added_at);
      const ag = findAg.get(row.folder) as { id: string };
      const mg = findMg.get(channelType, row.jid) as { id: string };
      insertMga.run(
        crypto.randomUUID(),
        mg.id,
        ag.id,
        row.engage_mode ?? 'pattern',
        row.pattern,
        row.sender_scope ?? 'all',
        row.ignored_message_policy ?? 'drop',
        row.added_at,
      );
    }
  },
},
```

Important: top of file needs `import crypto from 'crypto';` if not already imported. Check the file's existing imports.

- [ ] **Step 6: Confirm tests pass**

Run: `cd /data/nanotars && npx vitest run src/__tests__/migration-008.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 7: Run full suite**

Run: `cd /data/nanotars && npm test`
Expected: 506 passing (504 + 2 new).

If anything else breaks, the most likely cause is `db.test.ts`'s schema_version assertions — Phase 3 A2 bumped them from 6 to 7; this task bumps to 8. Bump them again. Other potential issue: a test that expects only one `CREATE TABLE` block — should be fine since we used `IF NOT EXISTS`.

- [ ] **Step 8: Typecheck**

Run: `cd /data/nanotars && npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
cd /data/nanotars
git add src/db/init.ts src/__tests__/migration-008.test.ts src/db/__tests__/db.test.ts
git commit -m "$(cat <<'EOF'
feat(db): split registered_groups into agent_groups + messaging_groups + wiring

Phase 4A foundation: introduces v2's three-table entity model
(agent_groups, messaging_groups, messaging_group_agents) and
populates from the existing registered_groups via migration 008.

Old table stays in place; subsequent 4A tasks refactor callers
one tier at a time. Final cleanup task drops registered_groups.

Schema notes:
- agent_groups carries v1's container_config JSON column for
  backward-compat reads (v2 moved this to disk; v1 keeps it).
- messaging_groups.unknown_sender_policy defaults to 'public'
  to preserve v1's "any sender can engage" behavior. Operators
  flip per-group once Phase 4D ships.
- messaging_group_agents.engage_pattern is the v2 name for what
  v1 stored as 'pattern' on registered_groups. The migration
  copies row.pattern into engage_pattern.

Spec: docs/superpowers/specs/2026-04-25-phase-4a-entity-model-design.md
EOF
)"
```

**Reviewer dispatch — DB schema + cross-tier migration.** After commit, dispatch combined spec+quality reviewer focused on this commit.

---

## Task A2: New DB accessors for agent_groups / messaging_groups / messaging_group_agents

**Triage row:** Spec section "Caller refactor." Add new accessor functions in a new file `src/db/agent-groups.ts` (mirroring v2's structure). Existing `getRegisteredGroup` / `getAllRegisteredGroups` / `setRegisteredGroup` stay untouched — they still query the legacy table. New accessors query the new tables. Subsequent tasks switch callers from old to new.

**Files:**
- New: `/data/nanotars/src/db/agent-groups.ts`
- Modify: `/data/nanotars/src/db/index.ts` (re-export the new accessors)
- Modify: `/data/nanotars/src/types.ts` (add `AgentGroup`, `MessagingGroup`, `MessagingGroupAgent` interfaces)
- New: `/data/nanotars/src/db/__tests__/agent-groups.test.ts`

- [ ] **Step 1: Add types**

In `/data/nanotars/src/types.ts`, alongside the existing `RegisteredGroup` interface, add:

```ts
export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  container_config: string | null;          // JSON-serialized; consumers parse on read
  created_at: string;
}

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number;                         // 0|1
  unknown_sender_policy: 'strict' | 'request_approval' | 'public';
  created_at: string;
}

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: 'pattern' | 'always' | 'mention-sticky';
  engage_pattern: string | null;
  sender_scope: 'all' | 'known';
  ignored_message_policy: 'drop' | 'observe';
  session_mode: string | null;
  priority: number;
  created_at: string;
}
```

`engage_mode` enum: v1 keeps `'always'` (Phase 2 four-axis port), v2 uses `'mention'`/`'mention-sticky'`. v1's set is `'pattern' | 'always' | 'mention-sticky'`. If you discover during implementation that v1 has additional values, surface as DONE_WITH_CONCERNS — don't widen the type without surfacing.

- [ ] **Step 2: Create accessor file**

Create `/data/nanotars/src/db/agent-groups.ts`. Match the style of existing `src/db/state.ts` accessors (use `getDb()`, prepared statements, return mapped row objects).

```ts
import crypto from 'crypto';
import { getDb } from './connection.js';   // adjust to whatever v1's getDb path is
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../types.js';
import { logger } from '../logger.js';
import { isValidGroupFolder } from './state.js';

// AGENT GROUPS

export function getAgentGroupById(id: string): AgentGroup | undefined {
  return getDb().prepare(`SELECT * FROM agent_groups WHERE id = ?`).get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  if (!isValidGroupFolder(folder)) {
    logger.warn({ folder }, 'getAgentGroupByFolder rejected unsafe folder');
    return undefined;
  }
  return getDb().prepare(`SELECT * FROM agent_groups WHERE folder = ?`).get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  const rows = getDb().prepare(`SELECT * FROM agent_groups`).all() as AgentGroup[];
  return rows.filter((r) => isValidGroupFolder(r.folder));
}

export function createAgentGroup(args: { name: string; folder: string; container_config?: string | null; agent_provider?: string | null }): AgentGroup {
  if (!isValidGroupFolder(args.folder)) throw new Error(`invalid folder: ${args.folder}`);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, args.name, args.folder, args.agent_provider ?? null, args.container_config ?? null, now);
  return { id, name: args.name, folder: args.folder, agent_provider: args.agent_provider ?? null, container_config: args.container_config ?? null, created_at: now };
}

// MESSAGING GROUPS

export function getMessagingGroup(channel_type: string, platform_id: string): MessagingGroup | undefined {
  return getDb().prepare(`SELECT * FROM messaging_groups WHERE channel_type = ? AND platform_id = ?`).get(channel_type, platform_id) as MessagingGroup | undefined;
}

export function getMessagingGroupById(id: string): MessagingGroup | undefined {
  return getDb().prepare(`SELECT * FROM messaging_groups WHERE id = ?`).get(id) as MessagingGroup | undefined;
}

export function createMessagingGroup(args: { channel_type: string; platform_id: string; name?: string | null; is_group?: number; unknown_sender_policy?: 'strict' | 'request_approval' | 'public' }): MessagingGroup {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, args.channel_type, args.platform_id, args.name ?? null, args.is_group ?? 0, args.unknown_sender_policy ?? 'public', now);
  return { id, channel_type: args.channel_type, platform_id: args.platform_id, name: args.name ?? null, is_group: args.is_group ?? 0, unknown_sender_policy: args.unknown_sender_policy ?? 'public', created_at: now };
}

// WIRING

export function getWiringForMessagingGroup(messaging_group_id: string): MessagingGroupAgent[] {
  return getDb().prepare(`SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?`).all(messaging_group_id) as MessagingGroupAgent[];
}

export function getWiringForAgentGroup(agent_group_id: string): MessagingGroupAgent[] {
  return getDb().prepare(`SELECT * FROM messaging_group_agents WHERE agent_group_id = ?`).all(agent_group_id) as MessagingGroupAgent[];
}

export function getWiring(messaging_group_id: string, agent_group_id: string): MessagingGroupAgent | undefined {
  return getDb().prepare(`SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?`).get(messaging_group_id, agent_group_id) as MessagingGroupAgent | undefined;
}

export function createWiring(args: {
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode?: 'pattern' | 'always' | 'mention-sticky';
  engage_pattern?: string | null;
  sender_scope?: 'all' | 'known';
  ignored_message_policy?: 'drop' | 'observe';
}): MessagingGroupAgent {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', 0, ?)`)
    .run(id, args.messaging_group_id, args.agent_group_id, args.engage_mode ?? 'pattern', args.engage_pattern ?? null, args.sender_scope ?? 'all', args.ignored_message_policy ?? 'drop', now);
  return { id, messaging_group_id: args.messaging_group_id, agent_group_id: args.agent_group_id, engage_mode: args.engage_mode ?? 'pattern', engage_pattern: args.engage_pattern ?? null, sender_scope: args.sender_scope ?? 'all', ignored_message_policy: args.ignored_message_policy ?? 'drop', session_mode: 'shared', priority: 0, created_at: now };
}

export function deleteWiring(messaging_group_id: string, agent_group_id: string): void {
  getDb().prepare(`DELETE FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?`).run(messaging_group_id, agent_group_id);
}

// CONVENIENCE: legacy-compat lookup (used by router refactor in A3)

/**
 * Resolve all wiring rows for an inbound message keyed by (channel, platform_id).
 * Returns [] if no messaging group is registered. Each returned row carries the
 * resolved AgentGroup and MessagingGroupAgent for routing decisions.
 */
export function resolveAgentsForInbound(channel: string, platform_id: string): Array<{ agentGroup: AgentGroup; wiring: MessagingGroupAgent; messagingGroup: MessagingGroup }> {
  const mg = getMessagingGroup(channel, platform_id);
  if (!mg) return [];
  const wirings = getWiringForMessagingGroup(mg.id);
  const out: Array<{ agentGroup: AgentGroup; wiring: MessagingGroupAgent; messagingGroup: MessagingGroup }> = [];
  for (const w of wirings) {
    const ag = getAgentGroupById(w.agent_group_id);
    if (!ag) continue;
    out.push({ agentGroup: ag, wiring: w, messagingGroup: mg });
  }
  return out;
}
```

The exact `getDb()` import path depends on v1's structure — read `/data/nanotars/src/db/index.ts` and `/data/nanotars/src/db/state.ts` to confirm. Match the import shape used by other accessor files.

- [ ] **Step 3: Re-export from db barrel**

Edit `/data/nanotars/src/db/index.ts` (or wherever the db barrel exports live). Append:

```ts
export * from './agent-groups.js';
```

Or — if the barrel uses named re-exports — add the relevant function names. Match the existing style.

- [ ] **Step 4: Write tests**

Create `/data/nanotars/src/db/__tests__/agent-groups.test.ts`. Test each accessor against an in-memory DB. Pattern from existing `src/db/__tests__/db.test.ts`. Cover:

- `createAgentGroup` + `getAgentGroupByFolder` round trip
- `getAllAgentGroups` returns multiple
- `getMessagingGroup` by (channel, platform_id) round trip
- `createWiring` + `getWiring` + `getWiringForMessagingGroup` + `getWiringForAgentGroup`
- `resolveAgentsForInbound` returns the cross-joined result
- `isValidGroupFolder` rejection: try to create an agent group with `folder = '../etc/passwd'` → throws

12-15 tests, mirroring the existing test file's structure. Don't over-test: each function's happy-path + one edge case.

- [ ] **Step 5: Run tests, full suite, typecheck**

Run: `cd /data/nanotars && npx vitest run src/db/__tests__/agent-groups.test.ts && npm test && npm run typecheck`
Expected: new accessor tests pass; full suite 506 + N (where N is the number of new tests, ~15); typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars
git add src/db/agent-groups.ts src/db/index.ts src/types.ts src/db/__tests__/agent-groups.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add agent-groups accessors for new entity model

Phase 4A: new accessor functions for agent_groups, messaging_groups,
and messaging_group_agents tables. Existing registered_groups
accessors are unchanged — they still drive production. Subsequent
tasks switch callers to the new accessors.

resolveAgentsForInbound is the convenience function the router
refactor in A3 will use to translate (channel, platform_id) inbound
messages into a list of (agent group, wiring) pairs.
EOF
)"
```

**No reviewer dispatch — additive code, no caller refactor yet.**

---

## Task A3: Refactor `orchestrator.ts` to use new accessors

**Triage row:** Spec section "Caller refactor." v1's orchestrator is the central routing module. It currently caches `this.registeredGroups: Record<string, RegisteredGroup>` from `getAllRegisteredGroups()` and uses it for inbound matching. Switch to the new accessors via the `resolveAgentsForInbound` function.

**Files:**
- Modify: `/data/nanotars/src/orchestrator.ts`
- Modify: `/data/nanotars/src/__tests__/orchestrator.test.ts`
- Modify: `/data/nanotars/src/index.ts` (the wiring/dep-injection block)

- [ ] **Step 1: Read orchestrator + understand the routing path**

Read `/data/nanotars/src/orchestrator.ts` carefully. Note:
- The `Deps` interface (around line 29) listing `getAllRegisteredGroups`, `setRegisteredGroup`.
- `this.registeredGroups` cache (line 115) populated on startup.
- `getRegisteredGroups()` method (line 157) — public API that plugins consume.
- The inbound-matching logic: how it uses the cache to resolve a chat to a group.
- Where `setRegisteredGroup` is called (e.g., when a new group is registered via IPC).

- [ ] **Step 2: Plan the swap**

Strategy:
- Replace the `registeredGroups` cache with a method `getAgentsForInbound(channel, platformId)` that calls `resolveAgentsForInbound` from db/agent-groups.ts.
- Keep `getRegisteredGroups()` PUBLIC METHOD as a backward-compat shim: synthesize a `Record<string, RegisteredGroup>` from `getAllAgentGroups() + getAllMessagingGroups() + getAllWirings()`, returning the legacy shape so plugins keep working.
- `setRegisteredGroup` callers split into: (a) "add new agent" path (IPC) → calls `createAgentGroup` + `createMessagingGroup` + `createWiring` instead; (b) "update existing" → reduce to a no-op for now (deferred to a future patch — no real callers exist for "rename group" in 4A).

The deps injected into orchestrator change: `getAllRegisteredGroups` + `setRegisteredGroup` are removed; the orchestrator instead imports the new accessors directly OR receives them as deps.

Implementation choice: import the new accessors directly. v1's orchestrator pattern of injecting DB deps was for testability; the new accessors can be tested by injecting a `getDb` factory at the module level OR by using vitest module mocks. Mirror what v2 does in its routing code — simplest to import directly.

- [ ] **Step 3: Refactor**

In `/data/nanotars/src/orchestrator.ts`:

a) Remove `getAllRegisteredGroups` and `setRegisteredGroup` from the `Deps` interface.

b) Add imports at the top:

```ts
import {
  resolveAgentsForInbound,
  getAllAgentGroups,
  getAgentGroupByFolder,
  createAgentGroup,
  createMessagingGroup,
  createWiring,
  getMessagingGroup,
  type AgentGroup,
  type MessagingGroup,
  type MessagingGroupAgent,
} from './db/agent-groups.js';
```

c) Remove `this.registeredGroups` cache. Replace usages with on-demand lookups via `resolveAgentsForInbound(channel, platformId)` at the inbound entry point.

d) `getRegisteredGroups()` public method — turn into a synthesizer that builds the legacy `Record<jid, RegisteredGroup>`. The synthesizer reads new tables and produces RegisteredGroup-shape objects, keyed by `messaging_groups.platform_id`. If multiple wirings exist for the same messaging group (multi-agent), the synthesizer can either pick the first (lossy backward compat) OR throw (forces plugin authors to migrate). For 4A: pick the first, log a warning. Note: v1 today doesn't support multi-agent-per-chat anyway; the issue only matters once 4D ships.

e) The "register a new group" path (currently `setRegisteredGroup`) splits into:
   ```ts
   addAgentForChat(args: { channel: string; platformId: string; name: string; folder: string; engage_mode?: ...; pattern?: ...; container_config?: ... }) {
     // ensure messaging group
     let mg = getMessagingGroup(args.channel, args.platformId);
     if (!mg) mg = createMessagingGroup({ channel_type: args.channel, platform_id: args.platformId, name: args.name });
     // ensure agent group
     let ag = getAgentGroupByFolder(args.folder);
     if (!ag) ag = createAgentGroup({ name: args.name, folder: args.folder, container_config: args.container_config });
     // wire
     createWiring({ messaging_group_id: mg.id, agent_group_id: ag.id, engage_mode: args.engage_mode, engage_pattern: args.pattern });
   }
   ```

f) Update orchestrator tests (`src/__tests__/orchestrator.test.ts`). The dep-injection-based tests will need to swap out for module-mock-based tests OR for in-memory DB-backed tests. Match whichever pattern the existing tests use; refactor consistently.

- [ ] **Step 4: Update `src/index.ts` wiring**

In `/data/nanotars/src/index.ts`, find where the orchestrator is constructed (around line 133 per the grep earlier). Remove `getAllRegisteredGroups` and `setRegisteredGroup` from the deps object passed in. Don't break adjacent unrelated wiring.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /data/nanotars && npx vitest run src/__tests__/orchestrator.test.ts && npm test && npm run typecheck`
Expected: all green. Test count similar (some legacy tests removed/rewritten; final count is roughly equal to pre-task count).

If the routing.test.ts tests fail, that's expected — they exercise routing through the orchestrator. Update them. The pattern: where they previously seeded `registered_groups`, now seed `agent_groups` + `messaging_groups` + `messaging_group_agents` via the new accessors.

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars
git add src/orchestrator.ts src/index.ts src/__tests__/orchestrator.test.ts src/__tests__/routing.test.ts
git commit -m "$(cat <<'EOF'
refactor(orchestrator): switch routing to new entity-model accessors

Orchestrator now resolves inbound messages via resolveAgentsForInbound
against the new tables instead of the in-memory registeredGroups cache.
Public getRegisteredGroups() preserved as a legacy-compat shim that
synthesizes the old shape from the new tables (lossy when multi-agent
wirings exist on the same chat — log warning, pick first).

addAgentForChat replaces setRegisteredGroup's compound write semantics:
ensures messaging_group + agent_group + wiring rows in the right tables.

Plugins consuming registeredGroups keep working unchanged.
registered_groups table is still in place; A7 drops it after all callers
migrate.
EOF
)"
```

**Reviewer dispatch — orchestrator is cross-tier (touches IPC plugin contract).**

---

## Task A4: Refactor `db/state.ts`, `container-mounts.ts`, `container-runner.ts`, `task-scheduler.ts`

**Triage row:** Spec section "Caller refactor." Catch-up sweep for the production callers that read `registered_groups` directly via `getRegisteredGroup` / `getAllRegisteredGroups`. Many do so just to look up a folder name — they can switch to `getAgentGroupByFolder` or similar.

**Files:** Per `grep -ln 'registered_groups\|RegisteredGroup\b' src/`:
- /data/nanotars/src/db/state.ts (the legacy accessors stay; we just don't add new ones)
- /data/nanotars/src/container-mounts.ts
- /data/nanotars/src/container-runner.ts
- /data/nanotars/src/task-scheduler.ts
- /data/nanotars/src/db/migrate.ts (the JSON-to-SQLite migrate; check if it still needs updating)
- Their test files

- [ ] **Step 1: Audit each caller**

For each file in the list above, run:

```
cd /data/nanotars && grep -n "RegisteredGroup\|getRegisteredGroup\|getAllRegisteredGroups\|setRegisteredGroup" <file>
```

Categorize each call:
- Pure folder lookup → swap to `getAgentGroupByFolder`
- Container config access → swap to `getAgentGroupByFolder().container_config`
- Channel/jid access → look up `messaging_groups` via the wiring
- Engage rules → look up `messaging_group_agents` via the wiring

- [ ] **Step 2: Refactor each file in turn**

Mechanical refactor — the new accessors return objects with `agent_group.folder`, `agent_group.container_config`, etc. Most callers just need their imports + variable references updated.

If any file is doing something non-trivial (e.g., joining across tables in unusual ways), surface that as DONE_WITH_CONCERNS rather than papering over.

- [ ] **Step 3: Update tests**

Each refactored file has tests that may seed `registered_groups`. Swap their seed code to use the new accessors. Pattern:

Before:
```ts
db.prepare(`INSERT INTO registered_groups (jid, name, folder, ...) VALUES (...)`).run(...);
```

After:
```ts
const ag = createAgentGroup({ name: 'X', folder: 'x' });
const mg = createMessagingGroup({ channel_type: 'whatsapp', platform_id: 'x@s.whatsapp.net', name: 'X' });
createWiring({ messaging_group_id: mg.id, agent_group_id: ag.id, engage_pattern: '\\bhi\\b' });
```

Consider extracting a test helper `seedAgent(db, { folder, channel, jid, ...opts })` if you find yourself repeating this 3+ times across test files. Pure refactoring — don't introduce abstractions that aren't used.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd /data/nanotars && npm test && npm run typecheck`
Expected: clean. If any test fails because it asserted on `registered_groups` table state, update the assertion to check the new tables.

- [ ] **Step 5: Commit**

```bash
cd /data/nanotars
git add -A   # all the refactored files + their tests
git commit -m "$(cat <<'EOF'
refactor(callers): switch container-runner, task-scheduler, mounts to new accessors

Catch-up sweep for non-orchestrator production callers that read
registered_groups. Most callers do pure folder lookup — straightforward
swap to getAgentGroupByFolder. Tests updated to seed the new tables
via createAgentGroup + createMessagingGroup + createWiring.

After this commit, the only remaining src/ reader of registered_groups
is the legacy state.ts accessors themselves (getRegisteredGroup et al.),
preserved for the public plugin-types contract until A7's cleanup.
EOF
)"
```

**No reviewer dispatch — mechanical multi-file refactor with full test coverage.**

---

## Task A5: Refactor IPC handlers

**Triage row:** Spec section "Caller refactor." IPC handlers in `src/ipc/*.ts` reference group state (auth checks, message logging, task scheduling). Handlers that take a `group_folder` and look up a `RegisteredGroup` swap to `getAgentGroupByFolder`. Handlers that send updates back to the host need to think about whether they expose `messaging_group`/`agent_group` ids vs the legacy folder/jid keys.

**Files:**
- /data/nanotars/src/ipc/auth.ts
- /data/nanotars/src/ipc/messages.ts
- /data/nanotars/src/ipc/tasks.ts
- /data/nanotars/src/ipc/types.ts
- /data/nanotars/src/ipc/__tests__/*.test.ts

- [ ] **Step 1: Audit each IPC handler**

Same as A4 step 1, scoped to `src/ipc/`. For each handler, identify what state it reads. Most likely: folder → look up agent group, jid/platform_id → look up messaging group.

- [ ] **Step 2: Refactor + update tests**

Same pattern as A4. Match each refactored handler with its test file's seed code.

- [ ] **Step 3: Run tests + typecheck**

Run: `cd /data/nanotars && npx vitest run src/ipc/ && npm test && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /data/nanotars
git add -A
git commit -m "$(cat <<'EOF'
refactor(ipc): switch IPC handlers to new entity-model accessors

ipc/auth, ipc/messages, ipc/tasks now look up agent groups and
messaging groups via the new accessors instead of registered_groups.
The IPC wire format is unchanged — handlers still receive group_folder
and chat_jid in inbound payloads; internally those resolve to
agent_groups + messaging_groups rows.

Test seed code updated.
EOF
)"
```

**Reviewer dispatch — IPC contract surface.** The wire format should be unchanged but the data flow changed; verify no IPC payload field changed shape.

---

## Task A6: Refactor `snapshots.ts` and add hook stubs

**Triage row:** Spec section "Hooks (placeholder)" + caller refactor.

**Files:**
- /data/nanotars/src/snapshots.ts
- New: /data/nanotars/src/permissions.ts (sender-resolver + access-gate stubs)
- /data/nanotars/src/orchestrator.ts (call the hook stubs at the right points)
- Test files for both

- [ ] **Step 1: Refactor snapshots.ts**

`available_groups.json` writer currently sources `registered_groups`. Refactor to source from the new tables — produce one row per agent group (since that's what the container needs to know about, not the per-chat wiring).

- [ ] **Step 2: Create `src/permissions.ts`**

```ts
// Phase 4A stubs. Phase 4B replaces these with real implementations
// against users / user_roles / agent_group_members tables.

export interface SenderInfo {
  channel: string;
  platform_id: string;
  sender_handle: string;
  sender_name?: string;
}

/**
 * Resolve a platform-level sender to a users.id.
 * Phase 4A stub: always returns undefined (no users table yet).
 * Phase 4B: real implementation against the users table + user_dms cache.
 */
export function resolveSender(_info: SenderInfo): string | undefined {
  return undefined;
}

/**
 * Gate access to an agent group.
 * Phase 4A stub: always returns true (no RBAC yet).
 * Phase 4B: real implementation against user_roles + agent_group_members.
 */
export function canAccessAgentGroup(_userId: string | undefined, _agentGroupId: string): boolean {
  return true;
}
```

- [ ] **Step 3: Wire stubs into orchestrator**

In the inbound-routing path of orchestrator.ts, add explicit calls to both stubs at the appropriate points:

```ts
// After resolveAgentsForInbound returns wirings:
const userId = resolveSender({ channel, platform_id: jid, sender_handle: msg.sender_jid, sender_name: msg.sender_name });
for (const { agentGroup, wiring } of wirings) {
  if (!canAccessAgentGroup(userId, agentGroup.id)) continue;
  // ... proceed to dispatch ...
}
```

Stubs return `true`/`undefined` so behavior is unchanged, but the callsites are anchored for 4B.

- [ ] **Step 4: Test**

`src/__tests__/permissions.test.ts` (new): one test per stub asserting current return values. These tests guard against accidental behavior change before 4B replaces the stubs.

`src/__tests__/orchestrator.test.ts`: verify the stubs are invoked during the routing path. Mock the permissions module and assert calls.

- [ ] **Step 5: Run + commit**

```bash
cd /data/nanotars && npm test && npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat(permissions): add sender-resolver + access-gate hook stubs

Phase 4A scaffolding for Phase 4B. Stubs return undefined / true so
current routing behavior is unchanged, but the callsites are wired
into orchestrator's inbound path. Phase 4B replaces both with real
implementations against users / user_roles / agent_group_members.

snapshots.ts also updated to source available_groups.json from
agent_groups instead of registered_groups.
EOF
)"
```

**No reviewer dispatch — additive scaffolding + mechanical snapshot refactor.**

---

## Task A7: Drop legacy `registered_groups` + remove old accessors + cleanup

**Triage row:** Spec section "Migration: 008..." final step + cleanup.

**Files:**
- /data/nanotars/src/db/init.ts (extend migration 008 OR add migration 009 for the drop)
- /data/nanotars/src/db/state.ts (remove getRegisteredGroup et al.)
- /data/nanotars/src/types.ts (remove `RegisteredGroup` interface)
- /data/nanotars/src/plugin-types.ts (remove `RegisteredGroup` from PluginContext + Plugin interfaces, OR rename to `AgentGroup`-shaped equivalent)
- Any remaining reference to `RegisteredGroup` across src/

- [ ] **Step 1: Confirm no live readers**

```
cd /data/nanotars && grep -rn "registered_groups\|getRegisteredGroup\|getAllRegisteredGroups\|setRegisteredGroup\|RegisteredGroup\b" src/
```

Expected: zero hits in production code, possibly some in test seed code (which should already be migrated by A4/A5). If there are live readers, STOP — go back and refactor them.

- [ ] **Step 2: Add migration `009_drop_registered_groups`**

In `/data/nanotars/src/db/init.ts`, after `008_split_registered_groups`:

```ts
{
  name: '009_drop_registered_groups',
  up: (db) => {
    db.exec(`DROP TABLE IF EXISTS registered_groups`);
  },
},
```

Remove the `CREATE TABLE registered_groups` from `createSchema` (since fresh installs no longer need it).

- [ ] **Step 3: Remove old accessors**

In `/data/nanotars/src/db/state.ts`, delete `getRegisteredGroup`, `setRegisteredGroup`, `getAllRegisteredGroups`, the `RegisteredGroupRow` type, and `mapRegisteredGroupRow`. Keep `isValidGroupFolder` (still used).

- [ ] **Step 4: Remove `RegisteredGroup` interface**

In `/data/nanotars/src/types.ts`, delete the `RegisteredGroup` interface. Update `plugin-types.ts` so plugins receive `AgentGroup[]` (or the synthesized `Record<string, AgentGroup>`) — make this a deliberate breaking change for the plugin contract.

If a plugin in `/data/nanotars/plugins/` references `RegisteredGroup`, surface as DONE_WITH_CONCERNS so the operator can migrate the plugin code. Don't try to update plugin code automatically — it's gitignored and operator-owned.

- [ ] **Step 5: Update orchestrator's legacy-compat shim**

The `getRegisteredGroups()` shim from A3 returned a `Record<jid, RegisteredGroup>`. Now that `RegisteredGroup` is gone, the shim either:
- Returns `Record<jid, AgentGroup & { engage_pattern: string | null }>` (a new compatibility shape)
- Or rename to `getAgentsByPlatformId()` and update plugin contract

Pick one. The operator's plugins will need to be aware. Since the plugin folder is gitignored, this is a documented breaking change.

- [ ] **Step 6: Migration test for 009**

Append to `src/__tests__/migration-008.test.ts` (or new file `migration-009.test.ts` if cleaner):

```ts
it('migration 009 drops registered_groups', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE registered_groups (jid TEXT PRIMARY KEY); CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  // pre-mark 001-008 applied
  // ...
  const { runMigrations } = await import('../db/init.js');
  runMigrations(db);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[]).map(r => r.name);
  expect(tables).not.toContain('registered_groups');
});
```

- [ ] **Step 7: Run + commit**

```bash
cd /data/nanotars && npm test && npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
chore(db): drop registered_groups + remove legacy accessors

Final Phase 4A cleanup. The new entity model fully replaces the
legacy table; A1-A6 migrated all callers. Migration 009 drops
the table on dev DBs that pre-date this commit. createSchema
no longer creates registered_groups.

Plugin contract change: PluginContext.registeredGroups is now
agentGroups (returns AgentGroup[]). Operator plugins in plugins/
that consume the legacy shape need a one-line update.
EOF
)"
```

**Reviewer dispatch — schema + plugin-contract change.**

---

## Task A8: Final phase review

After A7 commits, dispatch the final phase reviewer per memory `feedback-cross-tier-reviews`. Use the prompt template below.

**Reviewer prompt — Phase 4A final review:**

```
Final review of Phase 4A on /data/nanotars v1-archive. Phase 4A
started at 9a16dd9 (the spec commit); HEAD is now at <SHA>. Review:

git log 9a16dd9..HEAD --oneline

Verify:
1. Spec compliance against
   /data/nanotars/docs/superpowers/specs/2026-04-25-phase-4a-entity-model-design.md
2. Schema integrity: createSchema and migrations are in sync (no DDL
   without a migration entry; CLAUDE.md policy applied).
3. registered_groups is gone after the migration sequence. Run a
   smoke test: build a fresh DB via createSchema, run migrations,
   confirm registered_groups doesn't exist.
4. Old accessors (getRegisteredGroup et al.) are fully removed.
   grep -rn 'registered_groups\\|RegisteredGroup\\b' src/ should
   return zero hits.
5. Plugin contract change is documented in the A7 commit message
   (PluginContext.registeredGroups → agentGroups).
6. Hook stubs in src/permissions.ts are wired into orchestrator's
   inbound path. resolveSender + canAccessAgentGroup are called.
7. Tests: full host vitest passes. Container bun test passes.
   Typecheck clean.

Specifically check for end-to-end regressions:
- Inbound message → orchestrator → resolveAgentsForInbound →
  agent group dispatched. Trace the path.
- IPC update_group / register_group → new tables populated.
- snapshots.ts produces an available_groups.json that the container
  can still consume.

Out of scope for this review:
- Phase 4B+ (RBAC, approval primitive, multi-user flows).
- Sender-allowlist subsumption (Phase 4B).
- Phase 4.5 pnpm migration.

Report findings: Critical / High / Medium / Low / Nit with
file:line. End with PHASE 4A APPROVED or PHASE 4A NEEDS FIXES.
```

---

## Self-review checklist

- [x] Spec coverage: all spec sections (schema, migration, caller refactor, hooks, out-of-scope) map to tasks.
- [x] Placeholders: each task has concrete file paths and code skeletons. Where v1's exact structure isn't known in advance (e.g., db barrel name), the task says "match the existing style" rather than guessing.
- [x] Type consistency: `AgentGroup`, `MessagingGroup`, `MessagingGroupAgent` defined in A2, used consistently in A3-A7.
- [x] Reviewer dispatch: A1 (schema), A3 (orchestrator/IPC contract), A5 (IPC), A7 (schema + plugin contract). A2/A4/A6 mechanical.
- [x] Migration policy: every DDL change (008, 009) has a MIGRATIONS entry. createSchema kept in sync.
- [x] npm-not-pnpm warnings present in pre-flight + tech stack.
- [x] Hook stubs are explicit pre-stubs for 4B; wired but no-op.
