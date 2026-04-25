# Phase 2: Medium architecture-preserving — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land all medium-effort PORT/ADOPT items from Phase 2 of the upstream triage onto `v1-archive`, plus the 3 Phase-1 polish items the final reviewer flagged. ~17 items across 5 clusters. No architectural commitment (Phase 4+ scope unchanged).

**Architecture:** Each item is independently shippable on top of v1's existing per-group container model with file-IPC. New optional Channel-interface methods land alongside the ones added in Phase 1 (`transformOutboundText`, `openDM`). The CLAUDE.md compose pipeline is the largest content-quality win. No migrations are needed — operator confirmed "no users yet, start fresh"; all schema changes go directly into `createSchema`'s DDL block in `src/db/init.ts`.

**Tech Stack:** Node 22, TypeScript 5.9, vitest 4, better-sqlite3 11, pino 9. Container side: Node + `@anthropic-ai/claude-agent-sdk` (v1 has not split to Bun).

**Spec input:** `/data/nanotars/docs/upstream-triage-2026-04-25.md` Phase 2 sequencing section + per-area verdict matrices + final code review of Phase 1 (recommendations 1-5).

---

## CONTRIBUTE upstream PRs — out of scope for this plan

Same as Phase 1 — CONTRIBUTE-class items are PRs to `qwibitai/nanoclaw`, separate workstream. Phase 2 does not include any new CONTRIBUTE items; the ones surfaced during Phase 1 (auth-error patterns, container hardening, MAX_CONCURRENT_CONTAINERS, ffmpeg thumbnails, magic-bytes detection, mount tests) remain on the parallel CONTRIBUTE list.

---

## Items deferred from Phase 2

- **Per-provider session_state continuation namespacing pattern** (Area 1, PORT trivial) — only meaningful if v1 grows non-Anthropic providers. Defer to Phase 5 alongside the provider-abstraction port.
- **Numbered migration framework** (Area 2, originally PORT small) — operator decision: "ignore migrations, no users, start fresh." Schema changes go directly in `createSchema` DDL. The `runMigrations` system already in v1 stays as-is; Phase 2 doesn't add any new migration entries.
- **Mount allowlist tests as a CONTRIBUTE PR** — separate workstream.

---

## Items folded in from Phase 1 follow-ups (per final reviewer)

- **F1: Wire `recordUnregisteredSender` into router** — the diagnostic table from C3 needs a caller. Rolls into Cluster A (DB-shape evolution).
- **F2: Use `splitForLimit` in at least one channel** — folded into Cluster C (channels & media UX). The Discord channel template is the natural first consumer (2000-char limit).
- **F3: Add `container/__tests__/build-partials.test.sh` to npm test scripts** — folded into Cluster D (runtime hygiene).

---

## Pre-flight verification

- [ ] **Step 1: Verify nanotars is on v1-archive with clean tree**

Run: `cd /data/nanotars && git status --short --branch`
Expected: `## v1-archive...origin/v1-archive` with no other lines.

- [ ] **Step 2: Verify Phase 1 commits are present**

Run: `cd /data/nanotars && git log --oneline 52a91f5..HEAD | wc -l`
Expected: 18 (Phase 1's 14 tasks + 4 follow-up fixes).

- [ ] **Step 3: Verify baseline test counts**

Run: `cd /data/nanotars && npm test 2>&1 | grep -E "Tests" | tail -1` and `cd container/agent-runner && npx vitest run 2>&1 | grep -E "Tests" | tail -1`
Expected: 429 host, 23 container.

- [ ] **Step 4: Re-confirm typecheck clean**

Run: `cd /data/nanotars && npm run typecheck`
Expected: clean exit.

---

## Cluster A — DB-shape evolution + Phase 1 polish

### Task A1: Wire `recordUnregisteredSender` into router (Phase 1 polish)

**Triage row (Phase 1 follow-up #5 from final review):** Phase 1 added the `unregistered_senders` table + accessor (commit `6de0f31`) but no caller. The router's "no group matches this sender's JID" branch should call `recordUnregisteredSender` so the table fills with real diagnostic data.

**Files:**
- Modify: `/data/nanotars/src/router.ts` (or wherever inbound routing decides "no group matches")
- Modify: `/data/nanotars/src/__tests__/router.test.ts` (or new test file)

- [ ] **Step 1: Locate the "no group matches" branch**

Run: `grep -nE "registered_groups|getRegisteredGroup|no group|unknown sender" /data/nanotars/src/router.ts /data/nanotars/src/index.ts /data/nanotars/src/orchestrator.ts | head -20`

The router (or index.ts onMessage callback) has a path for inbound messages from JIDs that don't match any registered group. Identify it; that's where the call goes.

- [ ] **Step 2: Write failing test**

Add a test that invokes the inbound-routing path with a JID that matches no registered group and asserts `recordUnregisteredSender` is called with `(channel, platformId, senderName)`.

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
// Use existing test harness for inbound routing — match the pattern of
// surrounding tests (mock plugin registry, mock channel, etc.)

describe('unknown-sender diagnostic', () => {
  it('records senders not matching any registered group', async () => {
    // Set up: empty registered_groups, simulated inbound from "alice@s.whatsapp.net"
    // Trigger the inbound flow
    // Assert: listUnregisteredSenders(db) contains the expected row
  });
});
```

(Match the existing test file's mocking pattern — read the file first.)

- [ ] **Step 3: Run test to confirm failure**

Expected: test fails — `recordUnregisteredSender` is not yet called.

- [ ] **Step 4: Add the call**

In the router's "no group matches this JID" branch, call:

```ts
import { recordUnregisteredSender } from './db.js'; // via the db barrel

// In the no-match branch:
recordUnregisteredSender(getDb(), channel.name, message.chat_jid, message.sender_name);
```

The exact location depends on Step 1's findings. Place the call where the message would otherwise be silently dropped.

- [ ] **Step 5: Run tests; full suite**

Run: `cd /data/nanotars && npm test`
Expected: all pass (429 + 1 new = 430).

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/router.ts src/__tests__/router.test.ts && git commit -m "$(cat <<'EOF'
feat(router): wire recordUnregisteredSender into no-match branch

Phase 1's unregistered_senders table (commit 6de0f31) had no caller.
Add the call in the router's "no group matches this JID" branch so
inbound messages from unknown senders increment the diagnostic table
instead of being silently dropped.

Useful for the eventual Phase 4 D "register this user?" cards, but
also valuable now as a standalone diagnostic ("which senders keep
DMing the bot but aren't registered?").

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 polish)
EOF
)"
```

### Task A2: Four-axis engage model (PORT medium)

**Triage row (Area 1, Area 2):** v2 splits trigger into `engage_mode` + `pattern` + `sender_scope` + `ignored_message_policy` — four orthogonal axes vs v1's two (`requires_trigger` + `trigger_pattern`). Even without v2's entity model, v1 can split cleanly.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` (`registered_groups` schema — add 2 new columns to existing 8)
- Modify: `/data/nanotars/src/db/state.ts` (row mapper + accessors)
- Modify: `/data/nanotars/src/types.ts` (`RegisteredGroup` interface)
- Modify: `/data/nanotars/src/router.ts` or `src/orchestrator.ts` (consumers of trigger logic)
- Test: `/data/nanotars/src/db/__tests__/db.test.ts` (or `state.test.ts`)

**Operator note:** "ignore migrations, no users, start fresh." Schema change goes directly into `createSchema` DDL. Existing in-the-wild databases need not be migrated (there are none).

- [ ] **Step 1: Read current schema and consumers**

Read `/data/nanotars/src/db/init.ts` lines 80-89 (`registered_groups` table) and `/data/nanotars/src/db/state.ts` (row mapper). Also grep for callers: `grep -nE "trigger_pattern|requiresTrigger|requires_trigger" /data/nanotars/src/`.

- [ ] **Step 2: Define the four-axis schema**

The new columns alongside the existing `trigger_pattern` and `requires_trigger`:

| Column | Type | Default | Meaning |
|---|---|---|---|
| `engage_mode` | TEXT NOT NULL | `'pattern'` | `'pattern'` (v1's existing trigger-pattern behavior) \| `'always'` (no trigger required) \| `'mention-sticky'` (engage when mentioned, stay until idle) |
| `sender_scope` | TEXT NOT NULL | `'all'` | `'all'` (anyone in the chat can trigger) \| `'known'` (only senders we've seen before, gated via Phase 4 RBAC; for now equivalent to `'all'`) |
| `ignored_message_policy` | TEXT NOT NULL | `'drop'` | `'drop'` (silently ignore non-trigger messages) \| `'observe'` (store in messages table, do not invoke agent) |

Map old columns to new:
- `engage_mode = 'always'` ⟸ `requires_trigger = 0`
- `engage_mode = 'pattern'` ⟸ `requires_trigger = 1` (default)
- `pattern` ⟸ `trigger_pattern` (renamed for clarity)

**Decision:** add new columns, deprecate old ones gradually. Keep `trigger_pattern` and `requires_trigger` columns for one phase of compatibility — fill both old and new fields on insert; readers prefer new columns. **Or, since "no users, start fresh":** drop the old columns entirely in this commit, since no in-the-wild data to break.

**Operator's "start fresh" guidance** = drop old columns. New schema only.

- [ ] **Step 3: Write failing tests**

Add to `src/db/__tests__/db.test.ts` (or a new state.test.ts):

```ts
describe('four-axis engage model', () => {
  it('createSchema includes engage_mode/pattern/sender_scope/ignored_message_policy columns', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const cols = db.pragma('table_info(registered_groups)') as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['engage_mode', 'pattern', 'sender_scope', 'ignored_message_policy']),
    );
    // Old columns are gone (no-users start-fresh decision)
    expect(cols.map((c) => c.name)).not.toContain('trigger_pattern');
    expect(cols.map((c) => c.name)).not.toContain('requires_trigger');
  });

  it('round-trip insert + read preserves engage axes', () => {
    // Insert a registered group with engage_mode='mention-sticky', sender_scope='known'
    // Read it back, assert all 4 axes match
  });
});
```

(Match existing test patterns — use `_initTestDatabase` if it exists, or `createSchema(new Database(':memory:'))`.)

- [ ] **Step 4: Run tests to confirm failure**

Expected: schema test fails (new columns absent); insert test fails (no accessor for new shape).

- [ ] **Step 5: Update schema in `createSchema`**

In `src/db/init.ts` lines 80-89, replace the `registered_groups` block with:

```sql
CREATE TABLE IF NOT EXISTS registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  engage_mode TEXT NOT NULL DEFAULT 'pattern',
  sender_scope TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
  channel TEXT
);
```

(Old `trigger_pattern` → `pattern`, old `requires_trigger` removed.)

- [ ] **Step 6: Update `RegisteredGroup` interface**

In `src/types.ts:35-43`:

```ts
export type EngageMode = 'pattern' | 'always' | 'mention-sticky';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'observe';

export interface RegisteredGroup {
  name: string;
  folder: string;
  pattern: string;
  added_at: string;
  channel?: string;
  containerConfig?: ContainerConfig;
  engage_mode: EngageMode;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
}
```

(Drop the old `trigger` and `requiresTrigger` fields.)

- [ ] **Step 7: Update row mapper + accessors in `src/db/state.ts`**

The mapper currently reads `trigger_pattern` and `requires_trigger`. Update to read the new columns; insert/replace queries write the new columns.

- [ ] **Step 8: Update consumers**

Grep for `trigger_pattern` and `requiresTrigger` usage in `src/router.ts`, `src/orchestrator.ts`, `src/ipc/*`, etc. Replace each with the new fields:

- `requires_trigger === 0` (engage always) → `engage_mode === 'always'`
- `requires_trigger === 1` and pattern match → `engage_mode === 'pattern'` and pattern matches

The `mention-sticky` mode is new; it's a no-op for now (Phase 4 wires it). But the schema should accept it.

`sender_scope: 'known'` is also a no-op for now (Phase 4 wires it via user_dms). Schema accepts it.

`ignored_message_policy: 'drop'` is the default and matches v1's existing behavior. `'observe'` is also new; honor it: if non-trigger and policy is `'observe'`, store the message but don't invoke the agent.

- [ ] **Step 9: Run tests; full suite**

Run: `cd /data/nanotars && npm run typecheck && npm test`
Expected: typecheck clean; all 432 tests pass.

- [ ] **Step 10: Commit**

```bash
cd /data/nanotars && git add src/db/init.ts src/db/state.ts src/types.ts src/router.ts src/orchestrator.ts src/db/__tests__/db.test.ts && git commit -m "$(cat <<'EOF'
feat(db): replace requires_trigger/trigger_pattern with 4-axis engage model

Splits v1's two-axis trigger config (requires_trigger + trigger_pattern)
into four orthogonal axes per upstream v2:
- engage_mode: 'pattern' | 'always' | 'mention-sticky'
- pattern: trigger regex (renamed from trigger_pattern)
- sender_scope: 'all' | 'known' (Phase 4 wires 'known' via user_dms)
- ignored_message_policy: 'drop' | 'observe' (observe stores
  non-trigger messages without invoking the agent)

No migration needed — operator confirmed "no users yet, start fresh."
Schema goes directly into createSchema DDL; old columns removed.

mention-sticky and sender_scope='known' are accepted by the schema
but not yet enforced — Phase 4 wires them via the entity model and
user_dms cache. Today they behave as 'pattern' and 'all' respectively.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 1 PORT)
EOF
)"
```

---

## Cluster B — Compose pipeline for CLAUDE.md

### Task B1: `groups/<folder>/CLAUDE.local.md` per-group writable memory (PORT small)

**Triage row (Area 5):** v2's `groups/<folder>/CLAUDE.local.md` is a per-group writable memory file the agent owns; the host never edits it. Auto-loaded by Claude Code via the `CLAUDE.local.md` convention. v1 currently has no equivalent — the agent's per-group memory is whatever it chooses to remember in `CLAUDE.md` (which v1 *does* edit, conflating host-owned and agent-owned content).

This is phase 1 of the compose pipeline (Task B2 lands the regenerator).

**Files:**
- Modify: `/data/nanotars/src/index.ts` or wherever group setup happens — ensure `CLAUDE.local.md` exists for every registered group
- Modify: `/data/nanotars/container/agent-runner/src/index.ts` — instruct the agent that `CLAUDE.local.md` is its writable memory (per the v2 convention)
- Modify: `/data/nanotars/container/CLAUDE.md` (if it exists) or `groups/global/CLAUDE.md` — add the "use CLAUDE.local.md for per-group memory" guidance

- [ ] **Step 1: Read v2's container/CLAUDE.md for memory conventions**

Run: `cd /data/nanoclaw-v2 && cat container/CLAUDE.md`
Note the "Memory" and "Workspace" sections — they instruct the agent to use `CLAUDE.local.md` for per-group memory.

- [ ] **Step 2: Decide where to ensure-exists**

The simplest place: at host startup, after registered groups are loaded, iterate and `fs.writeFileSync(path.join('groups', group.folder, 'CLAUDE.local.md'), '')` if absent (no overwrite). Or: do it lazily in `src/container-runner.ts buildMounts`/`container-mounts.ts` right before spawn, mirroring v2's `composeGroupClaudeMd`.

Lazy-on-spawn is cleaner — runs every time, idempotent, no host-startup ordering concerns.

- [ ] **Step 3: Write failing test**

Add a test in `src/__tests__/container-mounts.test.ts` (or wherever the pre-spawn setup is tested):

```ts
it('ensures CLAUDE.local.md exists in the group folder before spawn', () => {
  // Set up a tmp groups/<folder>/ dir without CLAUDE.local.md
  // Invoke the pre-spawn helper
  // Assert: CLAUDE.local.md exists, is empty, is a regular file (not symlink)
});
```

- [ ] **Step 4: Run test to confirm failure**

- [ ] **Step 5: Implement the ensure-exists helper**

Create `src/ensure-claude-local.ts` (or co-locate in `container-mounts.ts`):

```ts
import fs from 'fs';
import path from 'path';

/**
 * Ensure groups/<folder>/CLAUDE.local.md exists. Auto-loaded by Claude Code
 * via the CLAUDE.local.md convention; the agent uses it as per-group writable
 * memory. Host never edits this file.
 */
export function ensureClaudeLocal(groupsDir: string, folder: string): void {
  const groupDir = path.join(groupsDir, folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}
```

Call it from the spawn path before mounting.

- [ ] **Step 6: Update container/CLAUDE.md (or groups/global/CLAUDE.md) with memory guidance**

Add a section mirroring v2's:

```markdown
## Memory

The file `CLAUDE.local.md` in your group folder is your per-group writable memory. Record things there that you'll want to remember in future sessions — user preferences, project context, recurring facts. Keep entries short and structured.

The host never edits CLAUDE.local.md — it is yours.
```

- [ ] **Step 7: Run tests; full suite**

Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd /data/nanotars && git add src/ensure-claude-local.ts src/container-mounts.ts src/__tests__/container-mounts.test.ts container/CLAUDE.md && git commit -m "$(cat <<'EOF'
feat(groups): add per-group CLAUDE.local.md writable memory file

Phase 1 of the CLAUDE.md compose pipeline. Adds CLAUDE.local.md to
every registered group's folder; auto-loaded by Claude Code; the
agent uses it as per-group writable memory. Host never edits.

Decoupling host-owned content (CLAUDE.md, regenerated in Phase 2 B2)
from agent-owned content (CLAUDE.local.md, this commit) lets the
host re-write CLAUDE.md from skill fragments without trampling
agent memory.

Adopted from upstream nanoclaw v2 src/claude-md-compose.ts:126-129.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 5 PORT)
EOF
)"
```

### Task B2: `claude-md-compose.ts` host-side regenerator (PORT medium)

**Triage row (Area 5):** v2's `src/claude-md-compose.ts` regenerates `groups/<folder>/CLAUDE.md` at every spawn from a shared base + skill fragments + per-MCP-server fragments + per-group `CLAUDE.local.md`. Solves v1's "plugin instructions live only in container-skills/, no path into the conversation context" problem.

**Files:**
- Create: `/data/nanotars/src/claude-md-compose.ts` (new)
- Modify: `/data/nanotars/src/container-mounts.ts` or `src/container-runner.ts` (call composer pre-spawn)
- Modify: `/data/nanotars/src/index.ts` (call once-cutover migration on startup)
- Test: `/data/nanotars/src/__tests__/claude-md-compose.test.ts` (new)

**v1 adaptation:** v2's compose reads `container.json:mcpServers` for inline instructions and `container/skills/<name>/instructions.md` for skill fragments. v1 has plugin-loader instead — adapt:
- Skill fragments: every plugin that ships a `container-skills/SKILL.md` (or `container-skills/instructions.md` if we add the convention) gets a fragment
- MCP fragments: each plugin's `mcp.json` doesn't have inline instructions today, so this slot is empty initially (forward-compat)
- Per-group selection: v2 has `container.json:skills` to enable/disable; v1 has plugin scoping (`channels`, `groups`) — use that

- [ ] **Step 1: Read v2's source verbatim**

`/data/nanoclaw-v2/src/claude-md-compose.ts` is 200 lines. Read it. Note:
- `composeGroupClaudeMd(group)` regenerates `groups/<folder>/CLAUDE.md`, `.claude-shared.md`, `.claude-fragments/*.md`
- Symlinks to `/app/CLAUDE.md` (the shared base) and `/app/skills/<name>/instructions.md` (which are container-paths — dangling on host but valid in the container via mounts)
- `migrateGroupsToClaudeLocal()` is a one-time cutover from `groups/<folder>/CLAUDE.md` → `CLAUDE.local.md`. v1 doesn't need this since v1 starts fresh; skip the migration helper.
- `writeAtomic` for safety

- [ ] **Step 2: Write failing tests**

Create `src/__tests__/claude-md-compose.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { composeGroupClaudeMd } from '../claude-md-compose.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'groups', 'test-group'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'plugins'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('composeGroupClaudeMd', () => {
  it('writes a CLAUDE.md with the shared-base import', () => {
    composeGroupClaudeMd({ folder: 'test-group' }, { projectRoot: tmpRoot });
    const composed = fs.readFileSync(path.join(tmpRoot, 'groups', 'test-group', 'CLAUDE.md'), 'utf-8');
    expect(composed).toContain('@./.claude-shared.md');
  });

  it('creates an empty CLAUDE.local.md if missing', () => {
    composeGroupClaudeMd({ folder: 'test-group' }, { projectRoot: tmpRoot });
    expect(fs.existsSync(path.join(tmpRoot, 'groups', 'test-group', 'CLAUDE.local.md'))).toBe(true);
  });

  it('preserves existing CLAUDE.local.md content (host never overwrites)', () => {
    fs.writeFileSync(path.join(tmpRoot, 'groups', 'test-group', 'CLAUDE.local.md'), 'agent memory');
    composeGroupClaudeMd({ folder: 'test-group' }, { projectRoot: tmpRoot });
    expect(fs.readFileSync(path.join(tmpRoot, 'groups', 'test-group', 'CLAUDE.local.md'), 'utf-8')).toBe('agent memory');
  });

  it('imports skill fragments from plugins that ship instructions.md', () => {
    fs.mkdirSync(path.join(tmpRoot, 'plugins', 'weather', 'container-skills', 'weather'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'plugins', 'weather', 'container-skills', 'weather', 'instructions.md'), 'Weather skill instructions');
    composeGroupClaudeMd({ folder: 'test-group' }, { projectRoot: tmpRoot });
    const composed = fs.readFileSync(path.join(tmpRoot, 'groups', 'test-group', 'CLAUDE.md'), 'utf-8');
    expect(composed).toMatch(/skill-weather\.md/);
  });

  it('prunes stale fragments when a plugin is uninstalled', () => {
    const fragmentsDir = path.join(tmpRoot, 'groups', 'test-group', '.claude-fragments');
    fs.mkdirSync(fragmentsDir, { recursive: true });
    fs.writeFileSync(path.join(fragmentsDir, 'skill-deleted.md'), 'stale');
    composeGroupClaudeMd({ folder: 'test-group' }, { projectRoot: tmpRoot });
    expect(fs.existsSync(path.join(fragmentsDir, 'skill-deleted.md'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

Expected: 5 FAIL — module doesn't exist.

- [ ] **Step 4: Implement `composeGroupClaudeMd` in `src/claude-md-compose.ts`**

Adapt v2's logic to v1:

```ts
/**
 * CLAUDE.md composition for v1 registered groups.
 *
 * Regenerates groups/<folder>/CLAUDE.md at every spawn from:
 *   - shared base (container/CLAUDE.md mounted RO at /app/CLAUDE.md)
 *   - per-plugin skill fragments (plugins that ship container-skills/<name>/instructions.md)
 *   - per-group writable memory (CLAUDE.local.md, agent-owned)
 *
 * Deterministic — same inputs produce the same CLAUDE.md. Stale fragments
 * are pruned. Host never overwrites CLAUDE.local.md.
 *
 * Adopted from upstream nanoclaw v2 src/claude-md-compose.ts.
 */
import fs from 'fs';
import path from 'path';

const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

export interface ComposeOptions {
  projectRoot?: string;
}

export interface ComposableGroup {
  folder: string;
}

export function composeGroupClaudeMd(group: ComposableGroup, options: ComposeOptions = {}): void {
  const projectRoot = options.projectRoot ?? process.cwd();
  const groupDir = path.resolve(projectRoot, 'groups', group.folder);
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

  // Shared base — symlink targets a container-only path
  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) fs.mkdirSync(fragmentsDir, { recursive: true });

  // Discover per-plugin skill fragments
  const desired = new Map<string, string>();  // fragment-name → host path of source
  const pluginsDir = path.join(projectRoot, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const pluginName of fs.readdirSync(pluginsDir)) {
      const skillsDir = path.join(pluginsDir, pluginName, 'container-skills');
      if (!fs.existsSync(skillsDir)) continue;
      // Each subdir under container-skills/ may have instructions.md
      for (const skillDir of fs.readdirSync(skillsDir)) {
        const instructionsPath = path.join(skillsDir, skillDir, 'instructions.md');
        if (fs.existsSync(instructionsPath)) {
          desired.set(`skill-${skillDir}.md`, instructionsPath);
        }
      }
    }
  }

  // Reconcile: drop stale, write desired (inline copy — v1 doesn't have v2's
  // /app/skills mount surface that v2 uses for symlinks).
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, srcPath] of desired) {
    const fragPath = path.join(fragmentsDir, name);
    const content = fs.readFileSync(srcPath, 'utf-8');
    writeAtomic(fragPath, content);
  }

  // Composed entry — imports only.
  const imports = ['@./.claude-shared.md'];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  imports.push('@./CLAUDE.local.md');
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  // Per-group writable memory — never overwrite if exists
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) fs.writeFileSync(localFile, '');
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try { currentTarget = fs.readlinkSync(linkPath); } catch { /* missing */ }
  if (currentTarget === target) return;
  try { fs.unlinkSync(linkPath); } catch { /* missing */ }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
```

(Note the v1-vs-v2 divergence: v1 reads plugin instructions inline rather than symlinking to `/app/skills/...` because v1 doesn't have the same container-skills mount surface. v1's plugins live in gitignored `plugins/` and contribute their `container-skills/` via plugin-loader's existing mount mechanism; the inline-copy works without any new mount.)

- [ ] **Step 5: Wire into the spawn path**

In `src/container-mounts.ts` (or `src/container-runner.ts` `buildMounts`), call `composeGroupClaudeMd(group)` immediately before constructing mount args. The `groups/<folder>/CLAUDE.md` mount continues to apply; now it's a generated file rather than a hand-edited one.

- [ ] **Step 6: Run tests; full suite**

Expected: 5 new pass; full suite still green.

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars && git add src/claude-md-compose.ts src/container-mounts.ts src/__tests__/claude-md-compose.test.ts && git commit -m "$(cat <<'EOF'
feat(groups): add claude-md-compose host-side regenerator

Regenerates groups/<folder>/CLAUDE.md at every spawn from:
- shared base (symlink to /app/CLAUDE.md, valid in container)
- per-plugin skill fragments (plugins with container-skills/<name>/instructions.md)
- per-group writable memory (CLAUDE.local.md, host never overwrites)

Solves v1's "plugin instructions live in container-skills/ but have
no path into the conversation context" problem.

Stale fragments are pruned on each compose. CLAUDE.local.md is
created empty if missing; never modified once present.

Adapted from upstream nanoclaw v2 src/claude-md-compose.ts. Key
adaptation: v1 inline-copies plugin instructions rather than
symlinking through /app/skills — v1's plugin-loader uses different
mount surfaces than v2's container.json model.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 5 PORT)
EOF
)"
```

### Task B3: Three-tier container skills (ADOPT medium)

**Triage row (Area 5):** v2's three-tier model: shared `container/skills/` + per-group `groups/<folder>/skills/` + per-group `container.json:skills` selection list. Coexists with v1's plugin-loader. Adds per-group skill enable/disable UX without replacing plugin contributions.

**Files:**
- Create: `/data/nanotars/groups/<folder>/skills/.gitkeep` pattern (per-group skills dir)
- Modify: `/data/nanotars/src/container-mounts.ts` (mount the three tiers)
- Modify: `/data/nanotars/container/Dockerfile` (mount point at `/workspace/.claude/skills/group/`)
- Test: `/data/nanotars/src/__tests__/container-mounts.test.ts`

**Note:** v2's `container.json:skills` selection list adds policy. For v1 (no `container.json` system), the simplest adoption is mount the three tiers but always enable all skills found. Selection-list UX defers to a Phase 5 task that introduces a per-group config equivalent.

- [ ] **Step 1: Decide tier hierarchy and mount points**

Three tiers, each mounted into the container:
1. **Shared (existing):** `container/skills/` (or upstream's `/app/skills/`) — already present in v1 as `/workspace/.claude/skills/` per plugin contributions
2. **Per-group new:** `groups/<folder>/skills/` → `/workspace/.claude/skills/group/`
3. **Per-plugin (existing):** plugins ship `container-skills/<name>/` via plugin-loader — already wired

- [ ] **Step 2: Write failing test**

Add to `src/__tests__/container-mounts.test.ts`:

```ts
it('mounts groups/<folder>/skills if it exists', () => {
  // Set up tmp groups/test/skills with a skill file
  // Invoke buildMounts
  // Assert: returned mounts include the per-group skills dir mounted at /workspace/.claude/skills/group/
});
```

- [ ] **Step 3: Run test to confirm failure**

- [ ] **Step 4: Implement the per-group skills mount**

In `src/container-mounts.ts`, after the existing skill mounts:

```ts
const groupSkillsDir = path.join(GROUPS_DIR, group.folder, 'skills');
if (fs.existsSync(groupSkillsDir)) {
  mounts.push({
    hostPath: groupSkillsDir,
    containerPath: '/workspace/.claude/skills/group',
    readonly: true,
  });
}
```

- [ ] **Step 5: Run tests; full suite**

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/container-mounts.ts src/__tests__/container-mounts.test.ts && git commit -m "$(cat <<'EOF'
feat(groups): add per-group skills tier (groups/<folder>/skills/)

Adds a per-group skills directory mounted at /workspace/.claude/skills/group/
in the container. Coexists with the existing shared-skills (container/skills)
and per-plugin (container-skills/) tiers — gives operators a place to put
group-specific skill content without packaging it as a plugin.

v2's selection-list UX (container.json:skills) is deferred to Phase 5 when
a per-group config equivalent lands. Today: any file under groups/<folder>/skills/
is mounted RO.

Adopted from upstream nanoclaw v2 three-tier container skills model.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 5 ADOPT)
EOF
)"
```

---

## Cluster C — Channels & media UX

### Task C1: Telegram typed-media routing (ADOPT small)

**Triage row (Area 4):** v2's `src/channels/telegram.ts:78-116` has `sendPhoto` / `sendVideo` / `sendAudio` extension-dispatch via the Bot API's typed endpoints. v1's Telegram channel template has no `sendFile` at all — agents can only send text. This task adds typed-media routing to v1's existing Telegram plugin (in `plugins/channels/telegram/` if installed via the marketplace).

**Note:** Telegram channel plugins live in the gitignored `plugins/channels/telegram/` directory, installed via `/plugin install nanoclaw-telegram@nanoclaw-skills`. The plan's modifications target the marketplace template at `TerrifiedBug/nanoclaw-skills` rather than the local v1-archive (which doesn't have the plugin source). For Phase 2, document the change as a follow-up PR to the marketplace.

**Decision:** Phase 2 lands a *helper module* in v1-archive's `src/channel-helpers.ts` (or a new `src/telegram-media.ts`) that the marketplace's Telegram plugin can import. The marketplace plugin gets updated separately (post-Phase 2 marketplace push) to use the helper.

**Files:**
- Modify: `/data/nanotars/src/channel-helpers.ts` (add `sendTelegramMedia` function + types)
- Test: `/data/nanotars/src/__tests__/channel-helpers.test.ts`

- [ ] **Step 1: Read v2's `sendTelegramMedia` shape**

Read `/data/nanoclaw-v2/src/channels/telegram.ts:75-116`. Note:
- `sendTelegramMedia(token, platformId, threadId, file, kind, caption)` — typed dispatch via `TELEGRAM_API_FIELD[kind]` and `TELEGRAM_API_METHOD[kind]`
- `kind: 'photo' | 'video' | 'audio'` — extension-driven, callers map by file extension
- Returns the chat-sdk composite message id (`chatId:msgId`)

- [ ] **Step 2: Write failing tests**

Add to `src/__tests__/channel-helpers.test.ts`:

```ts
import { mediaKindFromExtension } from '../channel-helpers.js';

describe('mediaKindFromExtension', () => {
  it('returns "photo" for image extensions', () => {
    expect(mediaKindFromExtension('foo.jpg')).toBe('photo');
    expect(mediaKindFromExtension('foo.png')).toBe('photo');
    expect(mediaKindFromExtension('foo.gif')).toBe('photo');
    expect(mediaKindFromExtension('foo.webp')).toBe('photo');
  });
  it('returns "video" for video extensions', () => {
    expect(mediaKindFromExtension('foo.mp4')).toBe('video');
    expect(mediaKindFromExtension('foo.webm')).toBe('video');
    expect(mediaKindFromExtension('foo.mov')).toBe('video');
  });
  it('returns "audio" for audio extensions', () => {
    expect(mediaKindFromExtension('foo.mp3')).toBe('audio');
    expect(mediaKindFromExtension('foo.ogg')).toBe('audio');
    expect(mediaKindFromExtension('foo.opus')).toBe('audio');
  });
  it('returns "document" for unknown extensions', () => {
    expect(mediaKindFromExtension('foo.txt')).toBe('document');
    expect(mediaKindFromExtension('foo.zip')).toBe('document');
  });
  it('handles uppercase and mixed-case extensions', () => {
    expect(mediaKindFromExtension('foo.JPG')).toBe('photo');
    expect(mediaKindFromExtension('foo.Mp4')).toBe('video');
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

- [ ] **Step 4: Implement `mediaKindFromExtension`**

Add to `src/channel-helpers.ts`:

```ts
export type TelegramMediaKind = 'photo' | 'video' | 'audio' | 'document';

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.opus', '.m4a', '.wav']);

/**
 * Classify a filename for Telegram's typed-media endpoints.
 *
 * Telegram's Bot API has separate methods (sendPhoto/sendVideo/sendAudio/sendDocument)
 * with different display behaviors. This helper routes based on extension —
 * a misclassified file falls back to sendDocument which works for everything
 * but loses the inline-preview UX.
 *
 * Adopted from upstream nanoclaw v2 src/channels/telegram.ts:25-35.
 */
export function mediaKindFromExtension(filename: string): TelegramMediaKind {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'document';
}
```

- [ ] **Step 5: Run tests; full suite**

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/channel-helpers.ts src/__tests__/channel-helpers.test.ts && git commit -m "$(cat <<'EOF'
feat(channels): add mediaKindFromExtension helper for Telegram typed-media

Helper that classifies a filename for Telegram's Bot API typed endpoints
(sendPhoto/sendVideo/sendAudio/sendDocument). Channel plugins that
ship sendFile() can use this to dispatch to the right endpoint based
on file extension — preserves Telegram's inline-preview UX instead of
falling back to sendDocument for everything.

The marketplace's nanoclaw-telegram plugin gets a separate update to
import this helper and call the typed Bot API methods. Today's commit
just lands the classification logic with tests; the plugin wiring
ships in the next nanoclaw-skills marketplace push.

Adopted from upstream nanoclaw v2 src/channels/telegram.ts:25-35.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 4 ADOPT)
EOF
)"
```

### Task C2: `extractReplyContext` hook on Channel interface (deferred from Phase 1)

**Triage row (Area 4):** Per-channel `extractReplyContext` hook — formalizes the inline reply-context parsing that v1's WhatsApp plugin already does. Adding the hook lets multiple channels (Telegram, Discord) implement reply-quoting consistently.

**Files:**
- Modify: `/data/nanotars/src/types.ts` (Channel interface — add optional method)
- Modify: `/data/nanotars/src/router.ts` (call hook after inbound message arrives, before storing)
- Test: `/data/nanotars/src/__tests__/router.test.ts`

- [ ] **Step 1: Read v2's hook signature**

In v2 the hook lives on `ChannelAdapter` — read `/data/nanoclaw-v2/src/channels/adapter.ts` for the exact signature. Approximate shape:

```ts
extractReplyContext?(rawMessage: unknown): ReplyContext | null;
```

The hook receives the channel-platform-native raw message object (Baileys' `WAMessage`, Telegram's update payload, etc.) and returns a normalized `ReplyContext` if the message is a reply, otherwise null.

- [ ] **Step 2: Write failing test**

Add to `src/__tests__/router.test.ts`:

```ts
describe('extractReplyContext hook', () => {
  it('calls extractReplyContext if the channel implements it', () => {
    const extract = vi.fn(() => ({ sender_name: 'Bob', text: 'original' }));
    const channel = makeChannel({ extractReplyContext: extract });
    // Wire inbound flow: deliver a raw message with reply context
    // Assert extract was called and the returned ReplyContext was stored on the message
  });
  it('skips when channel does not implement the hook', () => {
    // Plain channel, no hook
    // Assert message.reply_context remains undefined (or whatever the existing default is)
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

- [ ] **Step 4: Add hook to Channel interface**

In `src/types.ts`, after `openDM?`:

```ts
/**
 * Optional: extract reply context from a channel-platform-native raw message.
 *
 * Returns the normalized ReplyContext if the message is a reply, or null
 * otherwise. Receives the raw platform message (Baileys WAMessage, Telegram
 * update payload, etc.); the channel knows how to interpret its own format.
 *
 * If the hook is undefined, the inbound flow uses whatever reply_context
 * the channel itself populated on the NewMessage object.
 */
extractReplyContext?(rawMessage: unknown): ReplyContext | null;
```

- [ ] **Step 5: Wire in the inbound path**

In the inbound handler (likely `src/index.ts` `onMessage` callback or `src/router.ts`), after the channel delivers an inbound message:

```ts
if (channel.extractReplyContext && rawMessage) {
  const ctx = channel.extractReplyContext(rawMessage);
  if (ctx) message.reply_context = ctx;
}
```

(Locate exact placement by reading the inbound flow.)

- [ ] **Step 6: Run tests; full suite**

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars && git add src/types.ts src/router.ts src/__tests__/router.test.ts && git commit -m "$(cat <<'EOF'
feat(channels): add optional extractReplyContext hook on Channel

Channels can now declare a per-message reply-context extractor that
runs in the inbound flow. Receives the channel-platform-native raw
message; returns a normalized ReplyContext or null.

Formalizes the pattern v1's WhatsApp plugin already uses inline
(parsing Baileys' contextInfo). Other channels (Telegram, Discord)
gain a clean extension point for reply-quote support.

Hook is optional — existing channels keep working unchanged. The
inbound flow falls back to channel-populated reply_context when
the hook is undefined.

Adopted from upstream nanoclaw v2 src/channels/adapter.ts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 4 ADOPT, deferred from Phase 1)
EOF
)"
```

### Task C3: Telegram pairing flow + interceptor (ADOPT medium)

**Triage row (Area 4):** v2's Telegram pairing flow at `/data/nanoclaw-v2/src/channels/telegram-pairing.ts` solves a real security gap: a BotFather-only token has no user-binding, so anyone who DMs the bot is treated as an authorized user. The pairing flow gates first contact behind a code the operator types into the chat.

**Files:**
- Create: `/data/nanotars/src/telegram-pairing.ts` (new)
- Test: `/data/nanotars/src/__tests__/telegram-pairing.test.ts`

**v1 adaptation:** v1's Telegram plugin lives in the marketplace; the pairing logic ships as a v1-side helper module that the marketplace plugin imports.

- [ ] **Step 1: Read v2's pairing flow**

Read `/data/nanoclaw-v2/src/channels/telegram-pairing.ts`. Note: pairing state, code generation, code-acceptance window.

- [ ] **Step 2: Write failing tests** (~5 cases covering code lifecycle: generation, acceptance, expiry, double-use rejection, mismatched code rejection).

- [ ] **Step 3: Run tests to confirm failure**

- [ ] **Step 4: Port the pairing module**

Adapt v2's logic; replace v2-specific types with v1-equivalent. Include:
- `generatePairingCode()` — produces a short random code + expiry
- `acceptPairingCode(submittedCode)` — validates against state, marks accepted, returns true on success
- `isPaired(platformId)` — checks pairing state for a Telegram user

State storage: use the existing `router_state` KV (via `src/db/state.ts`) keyed on `telegram_pairing_<state>`. Pairing-specific state shape: `{ code, expires_at, paired_users: string[] }`.

- [ ] **Step 5: Run tests; full suite**

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/telegram-pairing.ts src/__tests__/telegram-pairing.test.ts && git commit -m "$(cat <<'EOF'
feat(channels): add Telegram pairing flow helper

Telegram's BotFather token has no user-binding — anyone who DMs the
bot is treated as authorized. This module gates first contact behind
a one-time code the operator types into the chat.

Lifecycle: generatePairingCode() creates a short random code with
expiry; acceptPairingCode validates against state and marks the
sender paired; isPaired checks status for subsequent messages.

State stored in router_state KV; the marketplace plugin imports
this module and gates inbound first-contacts via isPaired().

Adopted from upstream nanoclaw v2 src/channels/telegram-pairing.ts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 4 ADOPT)
EOF
)"
```

### Task C4: CLI always-on local-socket channel (ADOPT medium)

**Triage row (Area 4):** v2's `src/channels/cli.ts` is an always-on local-socket channel for terminal-based interaction with the host. Useful for debugging, scripting, and ops tasks without going through Telegram/WhatsApp.

**Files:**
- Create: `/data/nanotars/plugins/cli/plugin.json`
- Create: `/data/nanotars/plugins/cli/index.js`
- Test: integration test deferred to manual

**v1 adaptation:** v1's CLI lands as a *plugin* (under the standard plugin-loader convention), not as a core feature. The plugin implements the `Channel` interface, listens on a Unix socket, and bridges stdin/stdout to inbound/outbound messages.

- [ ] **Step 1: Read v2's CLI channel implementation**

Read `/data/nanoclaw-v2/src/channels/cli.ts`. Note the message shape, JID convention (`cli:default` or similar), and reconnection behavior.

- [ ] **Step 2: Write the plugin manifest**

Create `plugins/cli/plugin.json`:

```json
{
  "name": "cli",
  "description": "Local-socket CLI channel for terminal interaction with nanotars",
  "version": "1.0.0",
  "channelPlugin": true,
  "channels": ["*"],
  "groups": ["main"],
  "hooks": ["onChannel"]
}
```

- [ ] **Step 3: Implement the plugin entry point**

Create `plugins/cli/index.js` implementing the `Channel` interface:

- `connect()`: bind to a Unix socket at `~/.local/share/nanoclaw/cli.sock`
- `sendMessage(jid, text, ...)`: write to all connected stdout streams
- `ownsJid(jid)`: returns `jid.startsWith('cli:')`
- `disconnect()`: close the socket server

The actual socket loop reads stdin from any client (e.g., `nc` connecting to the socket), forwards as inbound messages, and writes outbound responses back.

- [ ] **Step 4: Smoke-test**

Manual: start the host with the plugin loaded, connect via `nc -U ~/.local/share/nanoclaw/cli.sock`, type a message, observe agent response.

- [ ] **Step 5: Commit**

```bash
cd /data/nanotars && git add plugins/cli/ && git commit -m "$(cat <<'EOF'
feat(channels): add CLI local-socket channel as a plugin

Adds the cli channel plugin: listens on a Unix socket at
~/.local/share/nanoclaw/cli.sock and bridges stdin/stdout to
inbound/outbound messages. JID convention: 'cli:default'.

Useful for terminal-based interaction without going through
Telegram/WhatsApp — debugging, scripting, ops tasks.

Adopted from upstream nanoclaw v2 src/channels/cli.ts (with v1
adaptation: ships as a plugin under v1's plugin-loader rather
than as a core channel).

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 4 ADOPT)
EOF
)"
```

### Task C5: Wire `splitForLimit` into Discord channel template (Phase 1 polish)

**Triage row (Phase 1 follow-up #4):** The `splitForLimit` helper from Phase 1 has no callers. Discord's 2000-char limit makes it the natural first consumer.

**Files:**
- This task targets the marketplace's nanoclaw-discord plugin template, not v1-archive's source. The work for v1-archive: add documentation in `docs/CHANNEL_PLUGINS.md` recommending channels use `splitForLimit` + a JSDoc note in `channel-helpers.ts`.

- [ ] **Step 1: Update `docs/CHANNEL_PLUGINS.md`**

Add a short section: "Long messages — use `splitForLimit`"

```markdown
## Long messages — use splitForLimit

Channels with a per-message size limit (Discord's 2000 chars, Telegram's 4096) should use the `splitForLimit` helper from `src/channel-helpers.ts` to split outbound text rather than hard-cutting:

```js
import { splitForLimit } from 'nanoclaw/channel-helpers.js';

async sendMessage(jid, text, sender, replyTo) {
  const chunks = splitForLimit(text, 2000);
  for (const chunk of chunks) {
    await sendOneMessage(jid, chunk, sender, replyTo);
  }
}
```

The function splits at the last paragraph break (`\n\n`) before the limit, falling back to single newline, then space, then a hard cut. Each chunk is `.trimEnd()`-ed and the next chunk's leading whitespace is `.trimStart()`-ed.
```

- [ ] **Step 2: Commit**

```bash
cd /data/nanotars && git add docs/CHANNEL_PLUGINS.md && git commit -m "$(cat <<'EOF'
docs(channels): recommend splitForLimit for long-message-handling channels

Phase 1 added the splitForLimit helper but it had no callers. Document
the recommended usage in CHANNEL_PLUGINS.md so the marketplace plugins
(Discord 2000-char, Telegram 4096-char) can adopt consistently.

The actual plugin code update ships in the next nanoclaw-skills
marketplace push — this commit just lands the documentation.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 polish #4)
EOF
)"
```

---

## Cluster D — Runtime hygiene + Phase 1 polish

### Task D1: Source-as-RO-bind-mount (ADOPT small)

**Triage row (Area 3):** v1 currently uses `COPY` + `npm run build` + `tsc` recompile in the Dockerfile, plus mounts `agent-runner/src` RO at runtime. The `COPY` is redundant — the RO mount supersedes it. Drop the `COPY`/`tsc` steps; the runtime mount is the source of truth.

**Files:**
- Modify: `/data/nanotars/container/Dockerfile`
- Modify: `/data/nanotars/container/agent-runner/src/index.ts` (run via tsx, no precompiled output)

- [ ] **Step 1: Read current Dockerfile structure**

The current Dockerfile copies `container/agent-runner/` into the image, runs `npm install` and `npm run build`, then prunes devDeps. Find the `COPY` and `RUN npm run build` lines.

- [ ] **Step 2: Modify Dockerfile**

Drop the `COPY agent-runner/` and `RUN npm run build` (the tsc invocation). Keep the `npm install` (deps are still needed). The runtime mount of `agent-runner/src` provides the source.

Update the entrypoint to run `tsx src/index.ts` directly (which it already does — verify).

- [ ] **Step 3: Build the image and confirm it works**

Run: `cd /data/nanotars && bash container/build.sh 2>&1 | tail -20`
Expected: image builds, `agent-runner/dist/` is absent, runtime `tsx` invokes from the mounted source.

- [ ] **Step 4: Smoke-test**

Spawn a container manually (`docker run` or via the existing runner). Confirm the agent-runner starts.

- [ ] **Step 5: Commit**

```bash
cd /data/nanotars && git add container/Dockerfile && git commit -m "$(cat <<'EOF'
build(container): drop COPY+tsc step, use RO mount as source

container/agent-runner/src is mounted RO into every container at
runtime; the Dockerfile's COPY+npm run build was redundant work
that produced a dist/ no one used. Drop both — tsx invokes from
the mounted source at startup, same as v2's pattern.

Image build is faster (no tsc); image is smaller (no dist).

Adopted from upstream nanoclaw v2 (which uses tsx-from-mount-source).

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 3 ADOPT)
EOF
)"
```

### Task D2: Label-scoped orphan cleanup per install (ADOPT small)

**Triage row (Area 3):** v1's orphan-cleanup uses `nanoclaw-` name-prefix filter, which conflicts when multiple nanoclaw installs share a host. v2 uses a per-install slug label so cleanup only touches its own install.

**Files:**
- Modify: `/data/nanotars/src/container-runtime.ts`
- Modify: `/data/nanotars/src/container-runner.ts` (apply the label on spawn)
- Test: `/data/nanotars/src/__tests__/container-runtime.test.ts`

- [ ] **Step 1: Define the install slug**

The slug should be deterministic per install — derive from `path.basename(process.cwd())` or a fixed value in `src/config.ts`. Pick: `INSTALL_SLUG = path.basename(process.cwd())`.

- [ ] **Step 2: Apply on spawn**

In `src/container-runner.ts`, every `docker run` invocation gets a `--label nanoclaw.install=${INSTALL_SLUG}` arg.

- [ ] **Step 3: Filter cleanup**

In `src/container-runtime.ts`'s orphan-cleanup, replace the `nanoclaw-` name-prefix filter with `--filter=label=nanoclaw.install=${INSTALL_SLUG}`.

- [ ] **Step 4: Add test**

Mock the docker invocation; confirm the label is added on run and the filter is added on cleanup.

- [ ] **Step 5: Run tests; full suite**

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/container-runtime.ts src/container-runner.ts src/config.ts src/__tests__/container-runtime.test.ts && git commit -m "$(cat <<'EOF'
build(container): label-scope orphan cleanup per nanoclaw install

Replaces the 'nanoclaw-' name-prefix orphan-cleanup filter with a
per-install Docker label (nanoclaw.install=<install-slug>). Multiple
nanoclaw installs sharing a host no longer step on each other's
container cleanup.

INSTALL_SLUG derived from path.basename(process.cwd()) — deterministic
per checkout/clone.

Adopted from upstream nanoclaw v2 src/container-runtime.ts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 3 ADOPT)
EOF
)"
```

### Task D3: Pre-task `script` hook for scheduled tasks (ADOPT medium)

**Triage row (Area 3):** v2's `task-script.ts` adds a pre-task script that runs before the agent is invoked — outputs JSON `{wakeAgent: bool, data?: any}`. If `wakeAgent: false`, the task is skipped (cheap pre-checks gate model spend). If `true`, optional `data` is passed to the agent prompt.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` — add `script TEXT NULL` column to `scheduled_tasks`
- Modify: `/data/nanotars/src/db/tasks.ts` — accessor handles new field
- Create: `/data/nanotars/container/agent-runner/src/task-script.ts` — pre-execution runner
- Modify: `/data/nanotars/container/agent-runner/src/index.ts` — call the runner before invoking the agent
- Test: `/data/nanotars/container/agent-runner/src/__tests__/task-script.test.ts`

- [ ] **Step 1: Read v2's `runScript` and `applyPreTaskScripts`**

Read `/data/nanoclaw-v2/container/agent-runner/src/scheduling/task-script.ts`. The 30s timeout, `1MB` buffer cap, JSON parse on last stdout line, `wakeAgent` boolean.

- [ ] **Step 2: Add `script` column to `scheduled_tasks`**

Per "no users, start fresh," update the `createSchema` DDL directly:

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  ...existing columns...
  script TEXT,
  ...
);
```

- [ ] **Step 3: Update accessor**

`src/db/tasks.ts`'s `insertScheduledTask` and row mapper handle the new field.

- [ ] **Step 4: Write failing tests**

For the runScript helper:

```ts
describe('runScript', () => {
  it('returns null when script errors', async () => {
    const result = await runScript('exit 1', 'task-1');
    expect(result).toBe(null);
  });
  it('returns null when last line is not JSON', async () => {
    const result = await runScript('echo hello', 'task-1');
    expect(result).toBe(null);
  });
  it('returns the parsed object when last line is valid JSON', async () => {
    const result = await runScript('echo \'{"wakeAgent":true,"data":{"x":1}}\'', 'task-1');
    expect(result).toEqual({ wakeAgent: true, data: { x: 1 } });
  });
  it('returns null when JSON lacks wakeAgent boolean', async () => {
    const result = await runScript('echo \'{"data":1}\'', 'task-1');
    expect(result).toBe(null);
  });
});
```

- [ ] **Step 5: Implement `runScript`**

Port v2's `runScript` (sans `touchHeartbeat` — v1 doesn't have heartbeat-based stuck-detection). Same script timeout (30s), max buffer (1 MiB), JSON-on-last-line contract.

- [ ] **Step 6: Wire into agent-runner**

In `container/agent-runner/src/index.ts`, before invoking the agent: if the inbound message is a scheduled task and the task has a `script` field, run the script. If `wakeAgent: false`, skip the task entirely (mark complete, don't invoke). If `true`, append `script_output: result.data` to the prompt.

- [ ] **Step 7: Run tests; full suite**

- [ ] **Step 8: Commit**

```bash
cd /data/nanotars && git add src/db/init.ts src/db/tasks.ts container/agent-runner/src/task-script.ts container/agent-runner/src/index.ts container/agent-runner/src/__tests__/task-script.test.ts && git commit -m "$(cat <<'EOF'
feat(scheduling): add pre-task script hook

Scheduled tasks can now declare a pre-task bash script (script field).
The script runs in the container before the agent is invoked; output
must end with a JSON line: {wakeAgent: bool, data?: any}.

If wakeAgent=false, the task is skipped entirely — cheap pre-checks
gate model spend. If true, optional data is passed to the agent
prompt as script_output.

Schema change: scheduled_tasks gains a 'script' TEXT NULL column.
No migration needed (operator confirmed "no users yet").

30s timeout, 1MB stdout buffer cap, parse-last-line JSON contract.

Adopted from upstream nanoclaw v2 container/agent-runner/src/scheduling/task-script.ts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 3 ADOPT)
EOF
)"
```

### Task D4: tini as PID 1 (deferred from Phase 1)

**Triage row (Area 3):** v1 uses Docker's `--init` flag; v2 uses `tini` baked into the image as PID 1 via ENTRYPOINT. Functionally equivalent for signal forwarding; tini gives slightly cleaner ps output.

**Files:**
- Modify: `/data/nanotars/container/Dockerfile`

- [ ] **Step 1: Add tini install + ENTRYPOINT**

In the Dockerfile, after the apt-get install block, ensure `tini` is installed (`apt-get install -y tini`). Then add at the end:

```dockerfile
ENTRYPOINT ["/usr/bin/tini", "--"]
```

The existing CMD/exec pattern in `entrypoint.sh` continues to work; tini just wraps it.

- [ ] **Step 2: Drop `--init` from container-runtime.ts**

In `src/container-runtime.ts extraRunArgs()`, remove `--init` (now redundant since tini is in the image).

- [ ] **Step 3: Build + smoke-test**

`./container/build.sh` → spawn → confirm signals propagate (Ctrl-C kills the agent cleanly).

- [ ] **Step 4: Commit**

```bash
cd /data/nanotars && git add container/Dockerfile src/container-runtime.ts && git commit -m "$(cat <<'EOF'
build(container): use tini as PID 1 instead of Docker --init

Bakes tini into the image and uses it as ENTRYPOINT. Equivalent to
Docker's --init flag for signal forwarding, but baked into the image
gives consistent behavior whether the host runs Docker or Apple
Container.

Drops --init from container-runtime.ts extraRunArgs since it's
now redundant.

Adopted from upstream nanoclaw v2 container/Dockerfile pattern.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 3 ADOPT, deferred from Phase 1)
EOF
)"
```

### Task D5: GitHub Actions CI workflow (ADOPT small)

**Triage row (Area 6):** v1 has zero workflow files. v2 has a CI workflow that runs typecheck + tests on every PR. Port a minimal version.

**Files:**
- Create: `/data/nanotars/.github/workflows/ci.yml`

- [ ] **Step 1: Read v2's CI workflow**

Run: `cat /data/nanoclaw-v2/.github/workflows/ci.yml`

- [ ] **Step 2: Adapt for v1's npm-based toolchain**

v1 uses npm (not pnpm) and doesn't have the bun/agent-runner split. Simplify accordingly.

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, v1-archive]
  pull_request:
    branches: [main, v1-archive]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm install --frozen-lockfile
      - run: npm run typecheck
      - run: npm test
      - run: cd container/agent-runner && npm install --frozen-lockfile
      - run: cd container/agent-runner && npx vitest run

  bash-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash container/__tests__/build-partials.test.sh
```

(Note: `npm install --frozen-lockfile` is the npm equivalent of `pnpm install --frozen-lockfile`; 4320-min `minimumReleaseAge` from `.npmrc` applies.)

- [ ] **Step 3: Verify YAML lints**

Optional: install `actionlint` and run it. If not available, skip.

- [ ] **Step 4: Commit**

```bash
cd /data/nanotars && git add .github/workflows/ci.yml && git commit -m "$(cat <<'EOF'
ci: add GitHub Actions workflow for typecheck + tests

Runs on push and PR to main and v1-archive branches:
- Host: typecheck + npm test (host vitest suite, currently 432)
- Container: npx vitest run (agent-runner suite, currently 23)
- Bash: container/__tests__/build-partials.test.sh

Mirrors upstream nanoclaw v2 .github/workflows/ci.yml, adapted to
v1's npm-only toolchain (no pnpm, no bun split).

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 6 ADOPT)
EOF
)"
```

### Task D6: Bash test integration into npm scripts (Phase 1 polish)

**Triage row (Phase 1 follow-up #6):** The build-partials.test.sh ships in Phase 1 but isn't part of `npm test`. Add a script that runs all bash tests.

**Files:**
- Modify: `/data/nanotars/package.json`

- [ ] **Step 1: Add `test:bash` script**

Update `package.json`'s `scripts` section:

```json
{
  "scripts": {
    ...
    "test:bash": "find container/__tests__ -name '*.test.sh' -exec bash {} \\;",
    "test:all": "npm test && npm run test:bash"
  }
}
```

- [ ] **Step 2: Verify the script runs**

Run: `cd /data/nanotars && npm run test:bash`
Expected: build-partials test passes.

- [ ] **Step 3: Update CI to use test:all**

Edit `.github/workflows/ci.yml` (from D5) to use `npm run test:all` instead of `npm test`.

- [ ] **Step 4: Commit**

```bash
cd /data/nanotars && git add package.json .github/workflows/ci.yml && git commit -m "$(cat <<'EOF'
test: add npm scripts for bash tests + combined test:all

The container/__tests__/build-partials.test.sh ships in Phase 1
(commit 4e1a8f2) but wasn't wired into the npm test surface — manual
invocation only. Adds:
- test:bash — runs all *.test.sh files under container/__tests__
- test:all — runs vitest + bash tests in one go

CI workflow updated to use test:all for full coverage.

Triage: docs/upstream-triage-2026-04-25.md (Phase 1 polish #3)
EOF
)"
```

---

## Cluster E — Secret-redaction body PORT

### Task E1: Secret redaction module body (PORT small)

**Triage row (Area 6):** v2's secret-redaction has 4 improvements over v1: (a) length-sort secrets so longer matches don't get pre-empted by shorter prefixes; (b) Set-dedup of secret values; (c) injectable paths for testing; (d) `ONECLI_API_KEY` in `NEVER_EXEMPT`.

**Files:**
- Modify: `/data/nanotars/src/secret-redact.ts`
- Modify: `/data/nanotars/src/__tests__/secret-redact.test.ts`

- [ ] **Step 1: Read v1's current and v2's body**

Already done — v1's `src/secret-redact.ts` is 171 lines; v2's is 172 lines with the improvements.

Key differences:
- v2 has `LoadSecretsOptions` interface with `projectRoot`, `additionalSafeVars`, `credentialsPath` — injectable for tests
- v2 sorts: `secretValues = [...new Set(secretValues)].sort((a, b) => b.length - a.length);`
- v2 has `ONECLI_API_KEY` in `NEVER_EXEMPT`

- [ ] **Step 2: Write failing tests**

Add to `src/__tests__/secret-redact.test.ts`:

```ts
describe('length-sorted redaction', () => {
  it('matches longer secrets before shorter prefixes', () => {
    // Inject two secrets where one is a prefix of the other
    // After redaction, the longer one's full value should be replaced, not just the prefix
  });
});

describe('NEVER_EXEMPT', () => {
  it('does not exempt ONECLI_API_KEY even when added to additionalSafeVars', () => {
    // Set ONECLI_API_KEY=abcd1234efgh in env
    // Call loadSecrets({ additionalSafeVars: ['ONECLI_API_KEY'] })
    // Assert: redactSecrets('abcd1234efgh') returns '[REDACTED]'
  });
});

describe('injectable paths', () => {
  it('reads .env from a custom projectRoot', () => {
    // Create a tmp .env, call loadSecrets({ projectRoot: tmpDir })
    // Assert: secrets are loaded from the tmp dir
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

- [ ] **Step 4: Port v2's body**

Replace v1's body with v2's verbatim (modulo `ONECLI_API_KEY` already being there):
- Add `LoadSecretsOptions` interface
- Change `loadSecrets()` signature to take options
- Add length-sort + Set-dedup
- Add `ONECLI_API_KEY` to `NEVER_EXEMPT`

Update callers in `src/index.ts` to pass `{}` (defaults match the old behavior).

- [ ] **Step 5: Run tests; full suite**

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars && git add src/secret-redact.ts src/index.ts src/__tests__/secret-redact.test.ts && git commit -m "$(cat <<'EOF'
fix(security): port v2's secret-redaction improvements

Four improvements over v1's implementation:

1. Length-sort: secrets sorted longest-first before regex compilation,
   so a longer value that contains a shorter one as a prefix is
   matched in full (was a real bug — partial match left the suffix).

2. Set-dedup: composite regex is built from a Set, so duplicate values
   from ~/.claude/.credentials.json + .env don't bloat the pattern.

3. Injectable paths: loadSecrets now takes LoadSecretsOptions
   { projectRoot, additionalSafeVars, credentialsPath } — testable
   without mocking process.cwd().

4. ONECLI_API_KEY added to NEVER_EXEMPT (was in v2's list, missing in
   v1's). Phase 3 OneCLI port will populate this.

Existing callers: src/index.ts updated to pass {} for default behavior.

Adopted from upstream nanoclaw v2 src/modules/secret-redaction/index.ts.

Triage: docs/upstream-triage-2026-04-25.md (Phase 2 — Area 6 PORT)
EOF
)"
```

---

## Phase 2 acceptance check

- [ ] **Step 1: All tasks committed individually**

Run: `cd /data/nanotars && git log --oneline 2d10ba4..HEAD | wc -l`
Expected: 16-18 (16 task commits + a few follow-up fixes if needed).

- [ ] **Step 2: Full test suite passes**

Run: `cd /data/nanotars && npm run test:all`
Expected: vitest 442+ passing (host) + 23+ container + bash test passing.

- [ ] **Step 3: Typecheck clean**

Run: `cd /data/nanotars && npm run typecheck`
Expected: clean.

- [ ] **Step 4: No untracked files**

Run: `cd /data/nanotars && git status --short`
Expected: clean.

- [ ] **Step 5: Push to origin**

Run: `cd /data/nanotars && git push origin v1-archive`
Expected: clean push.

---

## Out of scope (deferred to Phase 3+)

- **OneCLI gateway adoption** — Phase 3
- **pnpm migration** — Phase 3 (optional)
- **Multi-user RBAC + entity model** — Phase 4
- **Approval primitive standalone** — Phase 4 C
- **Self-modification, lifecycle pause/resume, provider abstraction** — Phase 5
- **Per-session containers + two-DB IPC** — Phase 6 (optional architectural pickup)
- **Phase 6-enabled bolt-ons (cross-container agent messaging, supportsThreads, subscribe, admin-transport, session_state per provider)** — Phase 7

The triage doc remains the master reference for these.
