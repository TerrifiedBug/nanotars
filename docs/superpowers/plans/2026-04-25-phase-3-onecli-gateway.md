# Phase 3: OneCLI gateway port + Phase 2 cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port v2's OneCLI gateway credential model onto v1's per-group container model (gateway only — manual-approval bridge defers to Phase 4 C). Address Phase 2 cleanup: declare migration policy, backfill the `005_engage_mode` migration, plumb `script` through `updateTask`, remove dead `ensureClaudeLocal`. Optional pnpm supply-chain hardening at the end.

**Architecture:** OneCLI integration is additive on v1's existing per-group container model. `container-runner.buildContainerArgs` gets two new lines (`onecli.ensureAgent` + `onecli.applyContainerConfig`) that inject `HTTPS_PROXY` + a CA-cert mount when the gateway is reachable; falls through silently if not. v1's existing stdin-pipe of Anthropic creds (`readSecrets`) stays as the no-OneCLI fallback path — operators with no OneCLI install keep working unchanged. The manual-approval bridge (`onecli-approvals.ts`) is **explicitly deferred** to Phase 4 because it depends on `pickApprover` (`user_roles` RBAC).

**Tech Stack:** Node 22, TypeScript 5.9, vitest 4, better-sqlite3 11, pino 9. New runtime dep: `@onecli-sh/sdk` (pin same minor as v2: `^0.3.1`). pnpm 10.x.

**Spec input:**
- `/data/nanotars/docs/upstream-triage-2026-04-25.md` Phase 3 sequencing (lines 188-198)
- `/data/nanotars/docs/upstream-triage-2026-04-25-area-6-security-ipc-build.md` (OneCLI verdict + per-row matrix)
- v2 reference: `src/container-runner.ts:486-500`, `src/modules/approvals/onecli-approvals.ts`, `.claude/skills/{init-onecli,manage-group-env,use-native-credential-proxy}/SKILL.md`
- Phase 2 final-review carryovers: migration-policy gap (memory `project-migration-policy.md`), `ensureClaudeLocal` dead-code (B2 superseded), `updateTask` missing `script` field

---

## Migration policy decision (locked before any DB work)

**Policy: every schema change adds both a `createSchema` DDL line AND a numbered `MIGRATIONS` array entry, even when "no users yet."** v1-archive is a long-lived branch with at least one in-use install (the operator's). The defensive migration cost is trivial; the cleanup cost when "no users" breaks is not.

Implementation rule lands in `CLAUDE.md` as Task A1; A2 backfills the missing migration created by Phase 2 commit `1e086d2` (engage_mode 4-axis change) so the existing dev DB stays in sync.

---

## CONTRIBUTE upstream PRs — out of scope for this plan

Same as Phase 1+2 — CONTRIBUTE-class items are PRs to `qwibitai/nanoclaw`, separate workstream.

---

## Items deferred from Phase 3

- **OneCLI manual-approval bridge** (`src/modules/approvals/onecli-approvals.ts` in v2) — depends on `pickApprover` + `pickApprovalDelivery` (Phase 4 RBAC + approval primitive). Defer to Phase 4 C. Phase 3 ports the gateway only; OneCLI's `configureManualApproval` callback is **not** wired. If OneCLI's server-side has approval rules configured before Phase 4 lands, credentialed calls will hang until OneCLI's own TTL — operator should not configure server-side approval rules until Phase 4 C wires the host callback.
- **`ONECLI_API_KEY` in `SECRET_ENV_VARS`** — already landed in Phase 2 secret-redaction port (commit `f421b9e`). No-op here.
- **`manage-group-env` skill** — v2's skill targets v2's `container.json:envAllowlist` model, which is structurally different from v1's plugin-loader-driven env passthrough. Under the technical-merit lens, v1's plugin-loader env wiring is **different but not strictly better/worse**; SKIP-ALT. If v1's env model is later replaced with v2's, port the skill then.
- **OneCLI "Phase 4 secrets list" semantics** — `onecli agents set-secret-mode --mode all` requirement (CLAUDE.md gotcha at `/data/nanoclaw-v2/CLAUDE.md`) is documentation, not code. Port if the operator hits it; not blocking.

---

## Pre-flight verification

- [ ] **Step 1: Verify nanotars is on v1-archive with clean tree**

Run: `cd /data/nanotars && git status --short --branch`
Expected: `## v1-archive...origin/v1-archive` with no other lines.

- [ ] **Step 2: Verify Phase 2 HEAD**

Run: `cd /data/nanotars && git log --oneline -1`
Expected: `3ab46d0 fix(scheduling): plumb task.script end-to-end host → container`

- [ ] **Step 3: Verify baseline test counts**

Run: `cd /data/nanotars && npm test 2>&1 | tail -5`
Expected: 500 passed (host) — see memory `nanotars-catchup-state.md`.

Run: `cd /data/nanotars/container/agent-runner && bun test 2>&1 | tail -5`
Expected: 29 passed.

- [ ] **Step 4: Re-confirm typecheck clean**

Run: `cd /data/nanotars && npm run typecheck`
Expected: clean exit (no errors). The container has its own typecheck — `cd container/agent-runner && bun run typecheck` should also be clean if v1 has it; otherwise just `npm run typecheck` from root.

- [ ] **Step 5: Verify HEAD does NOT contain OneCLI integration**

Run: `cd /data/nanotars && grep -rn "@onecli-sh\|applyContainerConfig" src/ package.json 2>&1 | head -5`
Expected: zero hits. (v1's only OneCLI mention is `ONECLI_API_KEY` in test files, which is fine.)

---

## Cluster A — Phase 2 cleanup (blockers for Phase 3 schema work)

These four tasks address Phase 2 final-reviewer carryovers. A1 + A2 must land before any Phase 3 work that touches the DB (none currently does, but the policy stays binding for Phase 4+).

### Task A1: Declare migration policy in CLAUDE.md

**Triage row:** Phase 2 carryover. Phase 2's plan said "no migrations needed — operator confirmed no users yet, start fresh," but commit `1e086d2` (A2 engage_mode) and commit `67c5a29` (D3 task.script) ended up taking opposite approaches: A2 dropped/added columns in DDL with no migration; D3 added DDL + a defensive migration. The inconsistency was flagged in the Phase 2 final review. Operator decision (this session): **always add a migration entry**.

**Files:**
- Modify: `/data/nanotars/CLAUDE.md`

- [ ] **Step 1: Read existing CLAUDE.md**

Run: `cd /data/nanotars && wc -l CLAUDE.md && head -10 CLAUDE.md`
Expected: ~99 lines. Note where to append the policy (probably under a "Database" or "Schema changes" section, or add a new top-level section near the end).

- [ ] **Step 2: Append the migration policy section**

Append the following section to `/data/nanotars/CLAUDE.md` (immediately before the docs-index section if one exists, otherwise at end):

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
cd /data/nanotars
git add CLAUDE.md
git commit -m "docs: declare migration policy — always add MIGRATIONS entry alongside DDL

Resolves Phase 2 inconsistency between commit 1e086d2 (engage_mode,
DDL only — no migration) and commit 67c5a29 (task.script, DDL +
defensive migration 006). Operator decision: always add the migration
entry, even when no users yet — v1-archive is long-lived and at least
one dev DB is in active use.

Backfill of 1e086d2 follows in next commit."
```

**No reviewer dispatch — single-file documentation change.**

---

### Task A2: Backfill `007_add_engage_mode_axes` migration

**Triage row:** Phase 2 commit `1e086d2` dropped `requires_trigger` + `trigger_pattern` and added `engage_mode`, `pattern`, `sender_scope`, `ignored_message_policy` directly in `createSchema` DDL with no migration entry. Per Task A1's policy, this needs a backfill so existing dev DBs (which would have `requires_trigger` + `trigger_pattern` from before the commit) converge cleanly.

**Files:**
- Modify: `/data/nanotars/src/db/init.ts` (append migration entry to `MIGRATIONS` array, currently ends at `006_add_task_script`)
- Modify: `/data/nanotars/src/__tests__/init.test.ts` or new test file

- [ ] **Step 1: Inspect commit 1e086d2 to confirm the schema delta**

Run: `cd /data/nanotars && git show 1e086d2 -- src/db/init.ts`

Expected: shows `requires_trigger` + `trigger_pattern` removed; `engage_mode`, `pattern`, `sender_scope`, `ignored_message_policy` added (with their NOT NULL DEFAULT clauses). Read the current `createSchema` DDL in `src/db/init.ts` to confirm exact column names and defaults.

Cross-check: `grep -nE "engage_mode|pattern|sender_scope|ignored_message_policy" src/db/init.ts` — these should all appear in `createSchema`'s `registered_groups` block.

- [ ] **Step 2: Write failing test for backfill migration**

Open `/data/nanotars/src/__tests__/init.test.ts` (or whichever test file already exercises migrations). If no migration test file exists, create `/data/nanotars/src/__tests__/migration-007.test.ts`. Pattern:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

describe('migration 007_add_engage_mode_axes', () => {
  it('adds the four engage-axis columns to a pre-1e086d2 registered_groups schema', async () => {
    const db = new Database(':memory:');

    // Simulate the pre-engage_mode schema (matches what existed before commit 1e086d2):
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        requires_trigger INTEGER DEFAULT 0,
        trigger_pattern TEXT,
        is_main INTEGER DEFAULT 0,
        added_at TEXT NOT NULL
      );
    `);
    db.exec(`CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);

    // Pretend migrations 001–006 already ran
    const stmt = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
    for (const v of ['001_add_context_mode', '002_add_model', '003_add_channel', '004_add_is_bot_message', '005_add_reply_context', '006_add_task_script']) {
      stmt.run(v, new Date().toISOString());
    }

    // Apply the new migration directly. Adjust the import to match the actual export.
    const { runMigrationsForTesting } = await import('../db/init.js');
    runMigrationsForTesting(db);

    const cols = db.pragma('table_info(registered_groups)') as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('engage_mode');
    expect(names).toContain('pattern');
    expect(names).toContain('sender_scope');
    expect(names).toContain('ignored_message_policy');

    // schema_version row added
    const versions = db.prepare('SELECT version FROM schema_version').all().map((r: any) => r.version);
    expect(versions).toContain('007_add_engage_mode_axes');
  });
});
```

If `runMigrationsForTesting` isn't already exported from `src/db/init.ts`, export it (rename the existing `runMigrations` if it's currently un-exported). The point is: the test must be able to drive the migrations array against a hand-crafted DB. Don't introduce any new abstractions for testing — match the pattern of any existing migration test file.

- [ ] **Step 3: Run the test to confirm it fails**

Run: `cd /data/nanotars && npx vitest run src/__tests__/migration-007.test.ts`
Expected: FAIL — `engage_mode` column missing because no migration adds it yet.

- [ ] **Step 4: Add the migration entry**

Edit `/data/nanotars/src/db/init.ts`. After the `006_add_task_script` entry, append:

```ts
  {
    name: '007_add_engage_mode_axes',
    up: (db) => {
      // Phase 2 commit 1e086d2 replaced requires_trigger + trigger_pattern
      // with the 4-axis engage model directly in createSchema DDL. Backfill
      // for any dev DB that pre-dates that commit. safeAddColumn is
      // idempotent — re-running is a no-op when the column already exists.
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN engage_mode TEXT NOT NULL DEFAULT 'pattern'`);
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN pattern TEXT`);
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN sender_scope TEXT NOT NULL DEFAULT 'all'`);
      safeAddColumn(db, `ALTER TABLE registered_groups ADD COLUMN ignored_message_policy TEXT NOT NULL DEFAULT 'drop'`);

      // Best-effort copy from old columns if they exist. SQLite has no
      // "drop column" pre-3.35; leave the legacy columns in place — they're
      // just unused dead weight after this point.
      const cols = db.pragma('table_info(registered_groups)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      if (names.includes('trigger_pattern')) {
        db.exec(`UPDATE registered_groups SET pattern = trigger_pattern WHERE pattern IS NULL AND trigger_pattern IS NOT NULL`);
      }
      if (names.includes('requires_trigger')) {
        db.exec(`UPDATE registered_groups SET engage_mode = CASE WHEN requires_trigger = 0 THEN 'always' ELSE 'pattern' END WHERE engage_mode = 'pattern'`);
      }
    },
  },
```

Note: the legacy `requires_trigger` and `trigger_pattern` columns can't be dropped without a full table rebuild (SQLite ≤3.35 doesn't support `DROP COLUMN`). Leaving them as unused dead weight is fine and matches the original `1e086d2` strategy of "no migration" — except now the new columns are populated correctly. If the operator later wants them physically gone, that's a separate table-rebuild migration; not in scope here.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd /data/nanotars && npx vitest run src/__tests__/migration-007.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `cd /data/nanotars && npm test`
Expected: 501 passed (500 baseline + 1 new). If anything else broke, the new migration may be running unexpectedly against the existing test DBs — investigate before continuing.

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars
git add src/db/init.ts src/__tests__/migration-007.test.ts
git commit -m "fix(db): backfill migration 007_add_engage_mode_axes

Phase 2 commit 1e086d2 replaced requires_trigger + trigger_pattern
with the 4-axis engage model directly in createSchema DDL but skipped
adding a MIGRATIONS entry. Existing dev DBs that pre-date that commit
would fail on next startup.

Per the migration policy declared in CLAUDE.md (commit prior), this
backfill makes the engage_mode change idempotent against any DB shape
old or new. Best-effort copy from the legacy columns; the legacy
columns themselves stay (SQLite cannot drop columns without a full
table rebuild)."
```

**Reviewer dispatch — DB schema change.** After commit, dispatch a combined spec+quality reviewer for A2 only. Reviewer prompt template at the bottom of this plan ("Reviewer prompt — schema change").

---

### Task A3: Plumb `script` through `updateTask`

**Triage row:** Phase 2 D3 (commit `67c5a29`) added `task.script` end-to-end through `createTask` and the host → container plumbing, but the IPC `update_task` path's `Pick` type doesn't list `'script'` in the allowed-update keys. Final reviewer flagged this — the column exists, but `updateTask({ script: '...' })` is a TypeScript error.

**Files:**
- Modify: `/data/nanotars/src/plugin-types.ts` (line 85, the `updateTask` signature)
- Modify: `/data/nanotars/src/db.ts` (the actual `updateTask` implementation must accept `script`)
- Modify: `/data/nanotars/src/ipc/tasks.ts` (the IPC handler that calls `updateTask`)
- Modify: `/data/nanotars/src/ipc/__tests__/ipc.test.ts`

- [ ] **Step 1: Locate the existing surface**

Run: `cd /data/nanotars && grep -nE "updateTask\b" src/plugin-types.ts src/db.ts src/ipc/tasks.ts | head -10`

Confirm: `plugin-types.ts:85` has the `Pick` constraining allowed update keys; `db.ts` has the implementation; `ipc/tasks.ts` has at least one path that calls `updateTask` from an inbound `update_task` IPC message.

- [ ] **Step 2: Write failing test**

Add to `/data/nanotars/src/ipc/__tests__/ipc.test.ts` (match the pattern of the existing `expect(updateTask).toHaveBeenCalledWith(..., expect.objectContaining({ prompt: 'new prompt' }))` test). Pattern:

```ts
it('passes script through to updateTask when set on the IPC payload', async () => {
  // ... existing test setup ...
  await handleUpdateTask({ taskId: 't1', script: 'cd /tmp && echo hi' } as any);
  expect(updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ script: 'cd /tmp && echo hi' }));
});
```

(Read the existing tests around lines 290-330 to mirror their setup; don't refactor the harness.)

- [ ] **Step 3: Run the test to confirm it fails**

Run: `cd /data/nanotars && npx vitest run src/ipc/__tests__/ipc.test.ts -t "passes script"`
Expected: FAIL — either compile-time TS error (Pick doesn't include 'script') or runtime miss (handler ignores `script`).

- [ ] **Step 4: Add `'script'` to the Pick type**

Edit `/data/nanotars/src/plugin-types.ts:85`:

```ts
  updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'model' | 'script'>>): void;
```

- [ ] **Step 5: Add `script` handling in db.ts updateTask**

Open `/data/nanotars/src/db.ts`. The `updateTask` function builds a SQL `UPDATE` from the keys present on `updates`. Verify it iterates over the input keys (not a hand-coded list) — if it's hand-coded, add `script` to the allowed list. Common pattern:

```ts
const allowedKeys = ['prompt', 'schedule_type', 'schedule_value', 'next_run', 'status', 'model', 'script'] as const;
```

If the function instead just iterates `Object.keys(updates)` and trusts the caller, no change is needed beyond the type — but read it carefully because some implementations whitelist explicitly.

- [ ] **Step 6: Add the IPC handler propagation**

Open `/data/nanotars/src/ipc/tasks.ts` around the `update_task` handler. The pattern (from earlier `prompt` plumbing) is `updateTask(data.taskId, updates)` where `updates` is built from incoming fields. Confirm `script` is included in the field-to-update mapping; add it if missing:

```ts
if (typeof data.script === 'string') {
  updates.script = data.script;
}
```

(Match the existing field-pickup pattern — don't introduce something new.)

- [ ] **Step 7: Run targeted test, then full suite**

Run: `cd /data/nanotars && npx vitest run src/ipc/__tests__/ipc.test.ts`
Expected: all pass.

Run: `cd /data/nanotars && npm test`
Expected: 502 passed (501 from A2 + 1 new).

- [ ] **Step 8: Typecheck**

Run: `cd /data/nanotars && npm run typecheck`
Expected: clean exit. (The Pick widening can ripple; if it doesn't compile, follow the error.)

- [ ] **Step 9: Commit**

```bash
cd /data/nanotars
git add src/plugin-types.ts src/db.ts src/ipc/tasks.ts src/ipc/__tests__/ipc.test.ts
git commit -m "fix(scheduling): allow updateTask to mutate script field

Phase 2 D3 (67c5a29) added task.script end-to-end on the create path
but the updateTask Pick type didn't list 'script', so once a task is
created its script is immutable via IPC update_task. Tighten the type,
db.ts, and the IPC handler so script is updateable like every other
ScheduledTask field."
```

**Reviewer dispatch — IPC contract change.** After commit, dispatch a combined spec+quality reviewer covering A3. Reviewer prompt template at the bottom ("Reviewer prompt — IPC contract").

---

### Task A4: Remove dead `ensureClaudeLocal`

**Triage row:** Phase 2 commit `9675421` introduced `src/ensure-claude-local.ts` as "Phase 1 of the CLAUDE.md compose pipeline." Phase 2 commit `8ff2015` then landed the full compose pipeline (`src/claude-md-compose.ts`), and that pipeline's `composeClaudeMd` itself ensures `CLAUDE.local.md` exists (`claude-md-compose.ts:106`). The standalone helper is now unreachable dead code. Final reviewer flagged.

**Files:**
- Delete: `/data/nanotars/src/ensure-claude-local.ts`
- Modify: `/data/nanotars/src/__tests__/container-mounts.test.ts` (delete the `ensureClaudeLocal` describe block, lines 641-680ish)
- Modify: any caller (verify with grep below — likely none)

- [ ] **Step 1: Confirm no callers**

Run: `cd /data/nanotars && grep -rn "ensureClaudeLocal\b" src/ container/ 2>/dev/null`

Expected: only the file itself, the test file, and possibly a single import that's no longer wired (which is the bug). If any production call exists, **stop and surface to the operator** — the dead-code claim is wrong and removal would regress.

If grep shows only `src/ensure-claude-local.ts:15` (the export) and `src/__tests__/container-mounts.test.ts` lines: clean.

- [ ] **Step 2: Verify claude-md-compose owns the responsibility**

Run: `cd /data/nanotars && grep -n "CLAUDE.local.md" src/claude-md-compose.ts`
Expected: at least one hit at `claude-md-compose.ts:106` (the file-creation line). If not present, **stop** — the claim "B2 superseded it" is wrong.

- [ ] **Step 3: Delete the file**

```bash
cd /data/nanotars
rm src/ensure-claude-local.ts
```

- [ ] **Step 4: Remove the test block**

Open `/data/nanotars/src/__tests__/container-mounts.test.ts`. Find the `// --- ensureClaudeLocal ---` comment around line 641, and delete from there through the end of the `describe('ensureClaudeLocal', ...)` block. Use `Read` first to see exact line range, then `Edit` to delete the block. Don't accidentally delete adjacent unrelated blocks.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /data/nanotars && npm test && npm run typecheck`
Expected: 502 passed (test count drops if `ensureClaudeLocal` had assertions, then climbs back via prior tasks); typecheck clean. If a stray import broke, the typecheck error tells you which file — fix that file (probably an `import { ensureClaudeLocal }` line that got missed).

- [ ] **Step 6: Commit**

```bash
cd /data/nanotars
git add -u src/ensure-claude-local.ts src/__tests__/container-mounts.test.ts
git commit -m "refactor: remove dead ensureClaudeLocal helper

Phase 2 commit 8ff2015 (claude-md-compose host-side regenerator)
made composeClaudeMd ensure CLAUDE.local.md exists itself
(claude-md-compose.ts:106). The standalone ensureClaudeLocal helper
was Phase 1 scaffolding; it has no remaining callers."
```

**No reviewer dispatch — mechanical multi-file delete with grep-confirmed zero callers.**

---

## Cluster B — OneCLI gateway port

OneCLI gateway integration into v1's per-group container model. Manual-approval bridge stays out of scope (Phase 4 C). Operator-facing skills (`init-onecli`, `use-native-credential-proxy`) ported in B3+B4.

### Task B1: Add `@onecli-sh/sdk` dep + config

**Triage row:** Area 6 ADOPT v2 → v1, medium-large effort. The SDK is one runtime dep + two config vars (`ONECLI_URL`, `ONECLI_API_KEY`).

**Files:**
- Modify: `/data/nanotars/package.json` (add dep)
- Modify: `/data/nanotars/src/config.ts` (add `ONECLI_URL`, `ONECLI_API_KEY` exports)
- Modify: `/data/nanotars/.env.example` (document the vars)

- [ ] **Step 1: Inspect v2's pinned version**

Run: `grep "@onecli-sh" /data/nanoclaw-v2/package.json`
Expected: `"@onecli-sh/sdk": "^0.3.1"` (or similar — record exact pin).

- [ ] **Step 2: Add the dep**

Edit `/data/nanotars/package.json`. Add to `dependencies`:

```json
"@onecli-sh/sdk": "^0.3.1",
```

(Use the exact version found in Step 1.)

- [ ] **Step 3: Install**

Run: `cd /data/nanotars && pnpm install`
Expected: lockfile updates. If the install rejects on `minimumReleaseAge` (Cluster C may have already landed), pin `0.3.1` exactly and add it to `minimumReleaseAgeExclude` — but **do not bypass without surfacing**; ask the operator first per CLAUDE.md supply-chain rules.

If you hit `ERR_PNPM_TOO_NEW` for `@onecli-sh/sdk@0.3.1` because the package was published <3 days ago: stop, surface to the operator. Do not silently exclude.

If Cluster C has not yet landed (the order in this plan), no release-age gate exists yet and the install should just work.

- [ ] **Step 4: Add config exports**

Read `/data/nanotars/src/config.ts`. Match the pattern of existing env-var-backed exports (e.g. how `ANTHROPIC_BASE_URL` or any optional URL is exposed). Add:

```ts
export const ONECLI_URL = process.env.ONECLI_URL ?? 'http://127.0.0.1:10254';
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY ?? '';
```

The default `127.0.0.1:10254` matches the OneCLI gateway's default port. Empty `ONECLI_API_KEY` means "anonymous mode" — the gateway accepts unauthenticated calls if it's also configured anonymous, and B2 will degrade gracefully if the gateway is unreachable or rejects anonymous.

- [ ] **Step 5: Document in .env.example**

If `/data/nanotars/.env.example` exists, append:

```
# OneCLI Agent Vault — outbound credential gateway. Optional.
# When set, container API calls are routed through OneCLI for per-agent
# credential injection. Run /init-onecli to install + configure.
# ONECLI_URL=http://127.0.0.1:10254
# ONECLI_API_KEY=
```

If `.env.example` doesn't exist, skip — don't introduce one solely for this.

- [ ] **Step 6: Typecheck + tests**

Run: `cd /data/nanotars && npm run typecheck && npm test`
Expected: clean typecheck, 502 passed (no new tests yet).

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars
git add package.json pnpm-lock.yaml src/config.ts .env.example
git commit -m "feat(onecli): add @onecli-sh/sdk dep and ONECLI_* config vars

Lays the groundwork for Phase 3 OneCLI gateway port. SDK on its own
does nothing; B2 wires applyContainerConfig into container-runner.

ONECLI_URL defaults to OneCLI's standard port (127.0.0.1:10254);
ONECLI_API_KEY defaults to empty (anonymous, gateway-side policy
permitting). When ONECLI_URL is unreachable, B2 degrades to v1's
existing readSecrets stdin-pipe path with no behavior change."
```

**No reviewer dispatch — single-file mechanical (config + deps).**

---

### Task B2: Wire OneCLI gateway into container-runner

**Triage row:** Area 6 row 1 — the actual gateway port. Two SDK calls in `buildContainerArgs`:

1. `onecli.ensureAgent({ name, identifier })` — registers the agent group with OneCLI keyed on its folder name.
2. `onecli.applyContainerConfig(args, { addHostMapping: false, agent: identifier })` — appends `-e HTTPS_PROXY=...` + `-v <ca-cert-path>:/etc/ssl/certs/...` mounts to the docker run args.

If `applyContainerConfig` returns false (gateway unreachable, no cert, etc.) or throws, the spawn proceeds without OneCLI — v1's existing `readSecrets` stdin pipe still passes Anthropic creds the legacy way, so containers keep working.

**Files:**
- Modify: `/data/nanotars/src/container-runner.ts`
- Modify: `/data/nanotars/src/__tests__/container-runner.test.ts` (or create if not present — match existing test layout)

- [ ] **Step 1: Read the relevant slices**

Read `/data/nanotars/src/container-runner.ts:1-100` (top/imports/buildContainerArgs signature). Read v2's reference at `/data/nanoclaw-v2/src/container-runner.ts:464-550` for the ensureAgent + applyContainerConfig pattern.

Identify:
- v1's `buildContainerArgs(mounts, containerName)` signature — needs a third arg for `agentIdentifier` (the folder name, since v1 keys per-group by folder).
- The caller of `buildContainerArgs` — where `containerName` is computed. That's where `agentIdentifier` should be threaded through.

- [ ] **Step 2: Write failing tests**

Open or create `/data/nanotars/src/__tests__/container-runner.test.ts`. Add tests for the two behaviors:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('buildContainerArgs OneCLI integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls ensureAgent + applyContainerConfig when identifier is provided', async () => {
    const ensureAgent = vi.fn().mockResolvedValue(undefined);
    const applyContainerConfig = vi.fn().mockImplementation(async (args: string[]) => {
      args.push('-e', 'HTTPS_PROXY=http://onecli.test', '-v', '/tmp/ca.pem:/etc/ssl/certs/onecli.pem:ro');
      return true;
    });
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: vi.fn().mockImplementation(() => ({ ensureAgent, applyContainerConfig })),
    }));

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', 'main');
    expect(ensureAgent).toHaveBeenCalledWith({ name: 'main', identifier: 'main' });
    expect(applyContainerConfig).toHaveBeenCalledWith(args, expect.objectContaining({ agent: 'main' }));
    expect(args).toContain('HTTPS_PROXY=http://onecli.test');
  });

  it('continues without OneCLI when applyContainerConfig returns false', async () => {
    const ensureAgent = vi.fn().mockResolvedValue(undefined);
    const applyContainerConfig = vi.fn().mockResolvedValue(false);
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: vi.fn().mockImplementation(() => ({ ensureAgent, applyContainerConfig })),
    }));

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', 'main');
    expect(args).toContain('--rm'); // base args still present
    expect(args.find((a) => a.startsWith('HTTPS_PROXY'))).toBeUndefined();
  });

  it('continues without OneCLI when ensureAgent throws', async () => {
    const ensureAgent = vi.fn().mockRejectedValue(new Error('gateway down'));
    const applyContainerConfig = vi.fn().mockResolvedValue(false);
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: vi.fn().mockImplementation(() => ({ ensureAgent, applyContainerConfig })),
    }));

    const { buildContainerArgsForTesting } = await import('../container-runner.js');
    const args = await buildContainerArgsForTesting([], 'nc-test', 'main');
    expect(args).toContain('--rm');
    // Test passes if no throw escapes buildContainerArgs.
  });
});
```

If `buildContainerArgs` is currently un-exported (it's a local helper), expose a `buildContainerArgsForTesting` shim — keep the production export untouched. If the function is already exported, use it directly. **Don't rename or restructure** the production function for testability.

- [ ] **Step 3: Run tests to confirm failure**

Run: `cd /data/nanotars && npx vitest run src/__tests__/container-runner.test.ts`
Expected: FAIL — either `buildContainerArgsForTesting` not exported, or no OneCLI calls made.

- [ ] **Step 4: Implement the OneCLI calls**

Edit `/data/nanotars/src/container-runner.ts`:

a) Add imports near the top:

```ts
import { OneCLI } from '@onecli-sh/sdk';
import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
```

b) Add a module-scoped client (matches v2's pattern at `container-runner.ts:50`):

```ts
const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
```

c) Change `buildContainerArgs` to accept `agentIdentifier` and become async:

```ts
async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier: string, // group folder name — stable across container restarts
): Promise<string[]> {
  const args: string[] = [
    'run', '-i', '--rm', '--name', containerName,
    '--label', `nanoclaw.install=${INSTALL_SLUG}`,
    ...containerRuntime.extraRunArgs(),
  ];

  // OneCLI gateway — injects HTTPS_PROXY + CA cert mount so outbound
  // API calls from the container are routed through the agent vault.
  // Falls through silently when OneCLI is not reachable; v1's existing
  // readSecrets stdin pipe is the no-OneCLI fallback for Anthropic creds.
  try {
    await onecli.ensureAgent({ name: agentIdentifier, identifier: agentIdentifier });
    const applied = await onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: agentIdentifier,
    });
    if (applied) {
      logger.info({ containerName }, 'OneCLI gateway applied');
    } else {
      logger.warn({ containerName }, 'OneCLI gateway not applied — falling back to .env credentials');
    }
  } catch (err) {
    logger.warn({ containerName, err }, 'OneCLI gateway error — falling back to .env credentials');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      // ... existing readonly-mount code ...
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // ... the rest of buildContainerArgs unchanged ...
  return args;
}
```

The exact tail of the function is whatever's already there in v1 — do not restructure it. Just insert the OneCLI block right after the initial args array and before the existing mount loop, and change the function signature + return type.

d) Thread `agentIdentifier` through every caller of `buildContainerArgs`. Each caller already has the `groupFolder` in scope (it's the input to all container-spawn paths). Pass it through.

e) Export the testing shim at the very end of the file:

```ts
/** @internal Test-only shim for unit tests. */
export const buildContainerArgsForTesting = buildContainerArgs;
```

(Match v1's existing export-naming convention — if there's a `*ForTesting` pattern, use it; otherwise pick one and stick to it.)

- [ ] **Step 5: Run unit tests**

Run: `cd /data/nanotars && npx vitest run src/__tests__/container-runner.test.ts`
Expected: PASS (3 new tests).

- [ ] **Step 6: Run the full suite**

Run: `cd /data/nanotars && npm test`
Expected: 505 passed (502 + 3 new).

If anything else breaks, check whether changing `buildContainerArgs` to async cascaded — every caller awaits now. Other tests that mock the function may need their mock signatures updated.

- [ ] **Step 7: Container-side verify (no change expected)**

The container-runner change is host-only. No agent-runner change is required for this task — the container's `ANTHROPIC_BASE_URL`-via-`HTTPS_PROXY` routing is transparent to the agent SDK. To sanity check:

Run: `cd /data/nanotars/container/agent-runner && bun test`
Expected: 29 passed (no change).

- [ ] **Step 8: Smoke test against an offline OneCLI**

Run: `cd /data/nanotars && ONECLI_URL=http://127.0.0.1:65534 npm run dev` (background; let it sit for ~10 seconds; kill).

Inspect log output: should see `OneCLI gateway error — falling back to .env credentials` for any container spawn that happened during those 10 seconds. The host should NOT crash. If the host crashes or hangs on OneCLI's connection attempt, the try/catch in step 4c isn't catching the right error class — surface this and adjust (likely need to also catch the SDK's own connection-refused error).

If no container spawn happened in the 10-second window, that's fine — just verify the host stayed up.

- [ ] **Step 9: Typecheck**

Run: `cd /data/nanotars && npm run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
cd /data/nanotars
git add src/container-runner.ts src/__tests__/container-runner.test.ts
git commit -m "feat(onecli): wire gateway into container-runner spawn path

Adds onecli.ensureAgent + onecli.applyContainerConfig calls in
buildContainerArgs. When OneCLI is reachable, every container's
outbound HTTPS gets routed through the gateway via HTTPS_PROXY +
CA cert injection — credentials never enter the container env or
filesystem. When OneCLI is unreachable or returns false, fall
through silently; v1's existing readSecrets stdin pipe still
passes Anthropic creds the legacy way, so non-OneCLI installs
keep working unchanged.

Manual-approval bridge (onecli.configureManualApproval) is NOT
wired here — it depends on Phase 4 RBAC's pickApprover. If the
operator configures server-side approval rules before Phase 4 C
lands, credentialed calls will hang until OneCLI's own TTL.

Triage: docs/upstream-triage-2026-04-25.md Phase 3 cluster F.
Reference: nanoclaw-v2/src/container-runner.ts:486-500."
```

**Reviewer dispatch — cross-tier IPC change.** After commit, dispatch a combined spec+quality reviewer. Reviewer prompt template at the bottom ("Reviewer prompt — OneCLI integration").

---

### Task B3: Port `init-onecli` skill (adapted to v1)

**Triage row:** Area 6 conditional ADOPT — only meaningful with B2 landed. v2's skill installs OneCLI, configures the gateway, migrates `.env` credentials into the vault. v1's adaptation: same flow, but the build/restart step uses v1's `npm run build` (not `pnpm run build` unless Cluster C lands), and the credential check looks for v1's stdin-pipe vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`).

**Files:**
- Create: `/data/nanotars/.claude/skills/init-onecli/SKILL.md`

- [ ] **Step 1: Read v2's skill verbatim**

Read `/data/nanoclaw-v2/.claude/skills/init-onecli/SKILL.md` (lines 1-271, full file).

- [ ] **Step 2: Create v1's adapted skill**

Create `/data/nanotars/.claude/skills/init-onecli/SKILL.md`. Copy v2's content with these adaptations:

a) **Frontmatter `description`** — same.

b) **Phase 1 "Check the codebase expects OneCLI"** — same `grep "@onecli-sh/sdk" package.json` check; if missing, tell the user to merge the Phase 3 OneCLI commits or re-run the appropriate update flow. v1 doesn't have `/update-nanoclaw`; instead reference the operator's catch-up doc path (or just say "ensure the OneCLI gateway commits are present").

c) **Phase 2 install commands** — same `curl -fsSL onecli.sh/install | sh` and CLI install. No change.

d) **Phase 3 credential-migration table** — same Anthropic vars. v1's `readSecrets` reads `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (`container-mounts.ts:414`). The skill should migrate the same set. Keep v2's table.

e) **Phase 4 build + restart**:
- v1 build command: `npm run build` (not `pnpm run build`). If Cluster C lands first and v1 has migrated to pnpm, switch to `pnpm run build`. **Check at execution time** — `grep '"build"' package.json` to see what's there.
- Service restart: v1 has its own setup (likely systemd or launchd, mirroring the v2 commands). Use the same commands as v2.

f) **Phase 5 verify** — same. Check `logs/nanoclaw.log` for OneCLI messages.

g) **Troubleshooting** — same. Add one v1-specific note: "If v1's stdin-pipe credentials are still being honored when OneCLI should be active, that's expected fallback behavior — the gateway path applies on next container spawn. The legacy stdin-pipe is silently superseded once OneCLI is reachable."

- [ ] **Step 3: Validate the SKILL.md frontmatter**

Run: `head -5 /data/nanotars/.claude/skills/init-onecli/SKILL.md`
Expected: `---\nname: init-onecli\ndescription: ...\n---`. The frontmatter must be valid YAML or skill loading fails.

- [ ] **Step 4: Commit**

```bash
cd /data/nanotars
git add .claude/skills/init-onecli/SKILL.md
git commit -m "feat(skills): port init-onecli for v1 OneCLI gateway setup

Walks the operator through OneCLI install, gateway config, and
.env credential migration into the agent vault. Companion to
the gateway port in B2 — the gateway integration is dormant
until OneCLI is installed and an Anthropic secret is registered.

Adapted from upstream nanoclaw-v2/.claude/skills/init-onecli for
v1's npm-based build and v1's readSecrets credential set."
```

**No reviewer dispatch — operational skill, instruction-only.**

---

### Task B4: Port `use-native-credential-proxy` skill (adapted to v1)

**Triage row:** Area 6 conditional ADOPT — alternative to OneCLI for users who want a `.env`-only workflow. v2's skill is "merge in the upstream skill branch that disables OneCLI." For v1, the equivalent is "no-op" — v1's existing `readSecrets`+stdin path **already** is the native-credential-proxy equivalent. The v1 version of this skill is therefore much smaller: it documents the default behavior and tells the user how to switch back FROM OneCLI to the .env path, if they ever ran `/init-onecli`.

**Files:**
- Create: `/data/nanotars/.claude/skills/use-native-credential-proxy/SKILL.md`

- [ ] **Step 1: Create the v1-adapted skill**

Create `/data/nanotars/.claude/skills/use-native-credential-proxy/SKILL.md`:

```markdown
---
name: use-native-credential-proxy
description: Use NanoClaw's built-in .env-based credential pipe instead of the OneCLI gateway. v1's default path; this skill documents how to switch back from OneCLI if /init-onecli was previously run.
---

# Use Native Credential Pipe (v1)

In v1-archive, the native credential pipe is the **default**: container spawn calls `readSecrets()` (`src/container-mounts.ts:413`) which reads `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` from `.env` and pipes them via stdin to the container.

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

You don't need to remove `@onecli-sh/sdk` from the codebase — the host's `buildContainerArgs` already falls through silently when OneCLI is unreachable. Two options:

**Option A — leave OneCLI installed but unused:** Just delete the OneCLI vault data and let the host fail-soft. Containers will fall back to the .env stdin pipe automatically.

**Option B — point ONECLI_URL at a dead address:** In `.env`, set `ONECLI_URL=http://127.0.0.1:65535`. The host will log "OneCLI gateway error — falling back to .env credentials" once per spawn but otherwise behave identically.

**Option C — uninstall OneCLI fully:** Remove the OneCLI service per OneCLI's own docs (`onecli stop`, then remove its install dir).

Pick one. There's no "remove the SDK from the codebase" step needed — v1 does not branch behavior on whether the dep is installed; it branches on whether the runtime call succeeds.

## Phase 3: Verify

Restart the service:

- macOS (launchd): `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux (systemd): `systemctl --user restart nanoclaw`

Send a test message in a registered chat. Inspect logs:

```bash
tail -30 logs/nanoclaw.log | grep -iE "onecli|gateway|secret"
```

Expected: either no OneCLI lines (if uninstalled), or "OneCLI gateway error — falling back" (if dead address). The agent should respond normally because the .env stdin pipe is delivering credentials.

## Troubleshooting

**Agent stops responding after switching:** Likely the .env value is missing or stale. Run `claude setup-token` (subscription path) or grab a new key from console.anthropic.com (API path), update `.env`, restart.

**OneCLI keeps trying to handle credentials:** Verify `ONECLI_URL` is unset or points at a dead address. The fallback is per-spawn; existing running containers may still be using the OneCLI proxy until they're killed and respawned.
```

- [ ] **Step 2: Commit**

```bash
cd /data/nanotars
git add .claude/skills/use-native-credential-proxy/SKILL.md
git commit -m "feat(skills): port use-native-credential-proxy as v1's default-path doc

In v1-archive, the .env stdin-pipe is the default credential path,
so this skill is much smaller than v2's: it explains how to switch
BACK to it after running /init-onecli, rather than a full code-merge
flow. v1's buildContainerArgs already falls through to the legacy
path when OneCLI is unreachable, so 'switching back' is a config-only
operation (delete vault data or point ONECLI_URL at a dead address)."
```

**No reviewer dispatch — operational skill, instruction-only.**

---

## Cluster C — pnpm supply-chain hardening (optional)

This cluster is gated on operator approval at execution time. The triage classifies it as ADOPT medium, optional, lower priority than the OneCLI work. **The orchestrator should pause after Cluster B and ask the operator: "Cluster C (pnpm supply-chain hardening) is optional. Land it now, or skip and move to Phase 4 planning?"** If skip, drop these tasks and complete the phase.

If accepted: only one task here — `minimumReleaseAge` + `onlyBuiltDependencies` allowlist.

### Task C1: Add `minimumReleaseAge: 4320` and `onlyBuiltDependencies` allowlist

**Triage row:** Area 6 ADOPT v2 → v1, medium. Two pnpm-side hardening flags from v2:
1. `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml` — blocks installing packages published <3 days ago. Mitigates supply-chain attacks via just-published malicious versions.
2. `onlyBuiltDependencies` allowlist in the same file — only listed packages may run install scripts.

**Files:**
- Modify: `/data/nanotars/pnpm-workspace.yaml` (or create if it doesn't exist)
- Modify: `/data/nanotars/.npmrc` (fallback `minReleaseAge=3d` for non-pnpm consumers)
- Modify: `/data/nanotars/CLAUDE.md` (mirror v2's "Supply Chain Security" section)

- [ ] **Step 1: Audit which deps run install scripts**

Run: `cd /data/nanotars && pnpm list --depth=0 --json 2>/dev/null | head -40`

Then run: `cd /data/nanotars && find node_modules -maxdepth 3 -name 'package.json' -exec grep -l '"install"\|"postinstall"\|"preinstall"' {} \; 2>/dev/null | head -20`

This produces the candidate allowlist. Common entries: `better-sqlite3`, `esbuild`, `@swc/core` (if present). Cross-check against v2's allowlist:

Run: `grep -A20 "onlyBuiltDependencies" /data/nanoclaw-v2/pnpm-workspace.yaml`

Use v2's list as a starting point and add anything v1 has that v2 doesn't. **Do NOT add packages to the allowlist that don't actually need it** — that's the threat surface this is meant to shrink.

- [ ] **Step 2: Add to pnpm-workspace.yaml**

If the file doesn't exist, create it:

```yaml
packages:
  - .
  - container/agent-runner

# 3-day hold on new package versions to mitigate supply-chain attacks via
# malicious just-published versions. See CLAUDE.md "Supply Chain Security".
minimumReleaseAge: 4320

# Only these packages may execute install scripts. Audit this list before
# adding anything — install scripts are arbitrary code execution.
onlyBuiltDependencies:
  - better-sqlite3
  # ... add others from Step 1's audit ...
```

If the file exists, edit it to add the two new keys. Keep the existing `packages:` list — don't restructure.

- [ ] **Step 3: Add .npmrc fallback**

If `/data/nanotars/.npmrc` doesn't exist, create:

```
minReleaseAge=3d
```

If it exists, append the line if not already present.

- [ ] **Step 4: Verify install still works**

Run: `cd /data/nanotars && pnpm install --frozen-lockfile`
Expected: clean install. No new packages added; the policy applies prospectively. If the install fails because an existing dep was published <3 days ago, **stop and surface to the operator** — don't silently `--force` past the gate.

- [ ] **Step 5: Document in CLAUDE.md**

Append the following section to `/data/nanotars/CLAUDE.md` (after the migration policy section landed in A1):

```markdown
## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.
```

- [ ] **Step 6: Run typecheck + tests**

Run: `cd /data/nanotars && npm run typecheck && npm test`
Expected: clean typecheck, 505 passed (no functional change).

- [ ] **Step 7: Commit**

```bash
cd /data/nanotars
git add pnpm-workspace.yaml .npmrc CLAUDE.md
git commit -m "chore: enforce pnpm minimumReleaseAge + onlyBuiltDependencies

3-day supply-chain hold on new package versions, plus an explicit
allowlist for packages allowed to execute install scripts. Mirrors
upstream v2's security posture.

Allowlist scoped to existing build-script-needing deps only; expand
with explicit human approval per CLAUDE.md rules."
```

**No reviewer dispatch — npm config tweak, no code change.**

---

## Final phase review

After all clusters land (or after Cluster B if Cluster C is skipped), dispatch a final phase reviewer per memory `feedback-cross-tier-reviews` ("Final phase review (after all tasks land) is always worth it").

**Reviewer prompt — final Phase 3 review:**

```
Final review of Phase 3 catch-up commits on /data/nanotars v1-archive.
Phase 3 head is at <HEAD>; phase started at 3ab46d0. Review:

git log 3ab46d0..HEAD --oneline

For each commit, verify:
1. Spec compliance against
   /data/nanotars/docs/superpowers/plans/2026-04-25-phase-3-onecli-gateway.md
2. Tests added per the plan and passing
3. Cross-tier integrity (host change picked up by container, type
   contracts match between IPC sides)

Specific cross-tier checks for Phase 3:
- B2 OneCLI integration: does the host fall through cleanly when
  OneCLI is unreachable? Run a short host-only smoke test under
  ONECLI_URL=http://127.0.0.1:65534 and verify no crash, just a
  warn-level log line per spawn.
- A2 migration: does the migration entry actually run on a
  pre-1e086d2 schema? Confirm by hand-crafting an in-memory DB
  with the legacy registered_groups schema and running migrations.
- A3 updateTask: does the IPC path actually pass `script` through
  end-to-end now? Trace from ipc/tasks.ts → updateTask → SQL
  UPDATE statement.

Report findings as: Critical / High / Medium / Low / Nit, with
file:line citations.

Do NOT propose architectural changes. Phase 3 is intentionally
additive on v1's per-group container model; the manual-approval
bridge stays deferred to Phase 4 by design.
```

---

## Reviewer prompt templates

Use these as agent prompts when dispatching reviewers per the cross-tier rule.

### Reviewer prompt — schema change (A2)

```
Review the engage_mode migration backfill on /data/nanotars v1-archive.
The commit being reviewed is the one immediately following the
'docs: declare migration policy' commit. Compare against the plan at
/data/nanotars/docs/superpowers/plans/2026-04-25-phase-3-onecli-gateway.md
Task A2.

Verify:
1. Migration name is sequenced correctly (007 follows 006, no gaps).
2. safeAddColumn is used for ADD COLUMN (idempotent).
3. NOT NULL DEFAULTs match the createSchema DDL exactly — mismatch
   between createSchema and migration causes silent divergence.
4. Best-effort copy from legacy columns is correct (engage_mode
   inferred from requires_trigger; pattern copied from trigger_pattern).
5. Test exercises the migration against a hand-crafted pre-1e086d2 schema.
6. Migration is wired into MIGRATIONS array (not just declared).

Report Critical / High / Medium / Low / Nit with file:line.
```

### Reviewer prompt — IPC contract (A3)

```
Review the script-field plumbing on /data/nanotars v1-archive. Compare
against plan Task A3.

Verify the script field is present at every layer:
1. plugin-types.ts updateTask Pick — includes 'script'.
2. db.ts updateTask SQL — includes script column in UPDATE.
3. ipc/tasks.ts update_task handler — picks up data.script and passes
   it into the updates object.
4. Test asserts updateTask was called with script in the updates object.

Verify the symmetric path: createTask already writes script (D3 from
Phase 2); confirm the read path (getTaskById, etc.) returns the column.

Report Critical / High / Medium / Low / Nit with file:line.
```

### Reviewer prompt — OneCLI integration (B2)

```
Review the OneCLI gateway integration on /data/nanotars v1-archive.
Compare against plan Task B2 and the v2 reference at
/data/nanoclaw-v2/src/container-runner.ts:486-500.

Verify:
1. ensureAgent is called once per spawn with the agent group folder
   as both name and identifier (matching v2's pattern of using the
   stable per-group key).
2. applyContainerConfig is called with addHostMapping: false (v1
   doesn't have the host-mapping feature; this matches v2's flag).
3. The try/catch wraps both calls — a thrown ensureAgent should not
   abort the spawn, just downgrade to the no-OneCLI fallback.
4. applyContainerConfig returning false is logged as warn (not error).
5. v1's readSecrets stdin pipe is UNCHANGED — non-OneCLI installs
   must keep working. This is the most important regression check.
6. agentIdentifier threading: every caller of buildContainerArgs
   passes the correct group folder. A wrong identifier here means
   credentials get scoped to the wrong agent group.
7. Manual-approval handler is NOT wired (configureManualApproval
   should not appear). If it is wired, that's a Critical — Phase 4
   RBAC isn't there yet to drive it.

Report Critical / High / Medium / Low / Nit with file:line.
```

---

## Self-review checklist (run before declaring plan complete)

- [x] **Spec coverage:** Phase 3 cluster F (OneCLI gateway), cluster G (pnpm), and the three Phase 2 carryovers (migration policy, ensureClaudeLocal, updateTask script) all map to tasks. Phase 4 items (manual-approval bridge, manage-group-env) are explicitly deferred.
- [x] **Placeholders:** No "TBD"/"implement later"/"add error handling" — every step has the actual content.
- [x] **Type consistency:** `agentIdentifier` (string, group folder) used consistently in B2; `script` field name matches across plugin-types/db/ipc.
- [x] **Reviewer dispatch:** A2 (schema), A3 (IPC), B2 (cross-tier). Final phase review at end. A1, A4, B1, B3, B4, C1 skip review per cross-tier-reviewers memory.
- [x] **Migration policy:** A1 lands the policy, A2 backfills the missing 005-era migration, the policy then governs all Phase 4+ DB work.
