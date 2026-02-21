---
name: nanoclaw-update
description: Pull updates from the nanoclaw fork, preview core and plugin changes, and optionally update installed plugins.
---

> **Plugin architecture means most customizations live in gitignored directories** (`plugins/`, `groups/`, `.env`). Fork updates should always be clean merges — if conflicts arise, something is wrong with the fork and the update should be aborted.

# About

Your NanoClaw installation (nanotars) tracks the fork at `TerrifiedBug/nanoclaw`. This skill fetches from the fork, shows you exactly what would change — both code and plugins — then lets you decide whether to apply the update.

Run `/nanoclaw-update` in Claude Code.

## How it works

**Fetch & assess**: checks for clean working tree, fetches from `nanoclaw` remote, then shows a full preview of what changed — commits, file categories, and plugin version differences. You see everything before any merge happens.

**Merge**: `git merge nanoclaw/main --no-edit`. This should always be clean. If conflicts arise, the merge is aborted — conflicts mean the fork has diverged and needs to be fixed first.

**Plugin updates**: after merge, if any skill templates have newer versions than installed plugins, offers to update them (copies template files, preserves your group/channel scoping).

**Validation**: `npm run build` to confirm nothing broke.

## Rollback

A backup tag is created before any changes:
```
git reset --hard pre-update-<hash>-<timestamp>
```

## Token usage

Uses `git log`, `git diff`, and `git status` for previews. Plugin version comparison reads only `plugin.json` files. Does not open or scan unrelated code.

---

# Goal
Help a user safely pull fork updates into their NanoClaw installation, with full preview of both code and plugin changes before committing to anything.

# Quick Update (try first)

For installs where customizations live in gitignored directories:

```bash
git fetch nanoclaw
git merge nanoclaw/main --no-edit
npm run build
```

If the merge succeeds cleanly, skip directly to Step 5 (Validation). If conflicts arise, abort the merge and tell the user — do not attempt conflict resolution.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- **Fetch-then-assess**: always show the user what would change (code + plugins) before performing any merge.
- **Conflicts = abort**: nanotars should always be a clean superset of the fork. If the merge produces conflicts, something is wrong with the fork — abort the merge (`git merge --abort`), explain the situation, and stop. Do not attempt to resolve conflicts.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and only read `plugin.json` files for version comparison.

# Step 0: Preflight (stop early if unsafe)
Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Confirm remotes:
- `git remote -v`
If `nanoclaw` remote is missing:
- Ask the user for the fork repo URL (default: `https://github.com/TerrifiedBug/nanoclaw.git`).
- Add it: `git remote add nanoclaw <url>`

Determine the fork branch name:
- `git branch -r | grep nanoclaw/`
- If `nanoclaw/main` exists, use `main`.
- If only `nanoclaw/master` exists, use `master`.
- Otherwise, ask the user which branch to use.
- Store this as FORK_BRANCH for all subsequent commands.

Fetch:
- `git fetch nanoclaw --prune`

# Step 1: Create a safety net
Capture current state:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag (using timestamp to avoid collisions on retry):
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for later reference in the summary and rollback instructions.

# Step 2: Preview what the fork changed (no edits yet)

## 2a: Core code preview

Compute common base:
- `BASE=$(git merge-base HEAD nanoclaw/$FORK_BRANCH)`

Show fork commits since BASE:
- `git log --oneline $BASE..nanoclaw/$FORK_BRANCH`

Show local commits since BASE (nanotars-only drift):
- `git log --oneline $BASE..HEAD`

Show file-level impact from fork:
- `git diff --name-only $BASE..nanoclaw/$FORK_BRANCH`

Bucket the fork changed files:
- **Source** (`src/`): core code changes
- **Skills** (`.claude/skills/`): skill template updates — may include plugin version bumps
- **Build/config** (`package.json`, `package-lock.json`, `tsconfig*.json`, `container/`): build system changes
- **Other**: docs, tests, misc

## 2b: Plugin version preview

Before any merge, compare what the fork's skill templates would bring vs what's currently installed. This shows the user plugin updates as part of the preview.

For each `.claude/skills/add-skill-*/files/plugin.json` and `add-channel-*/files/plugin.json` **in the fork** (use `git show nanoclaw/$FORK_BRANCH:<path>` to read without checking out):

1. Read the template's `plugin.json` from the fork: `git show nanoclaw/$FORK_BRANCH:.claude/skills/<skill>/files/plugin.json`
2. Get the `name` and `version` fields
3. Find matching installed plugin under `plugins/` (match by `name` field in the installed `plugin.json`)
4. If installed plugin exists and has a `version` field, compare versions
5. If fork template version > installed version → flag as "update available"
6. If installed plugin has no `version` field → flag as "version tracking now available"

## 2c: Conflict check

Dry-run merge to check for conflicts. Run as a single chained command so the abort always executes:
```
git merge --no-commit --no-ff nanoclaw/$FORK_BRANCH; CONFLICTS=$(git diff --name-only --diff-filter=U); git merge --abort
```

## 2d: Present combined summary

```
Fork update preview:
  Core: X commits, Y files changed
    - src/: A files
    - .claude/skills/: B files
    - container/: C files
    - other: D files

  Conflicts: none (clean merge) ← or list conflicted files

  Plugin updates available:
    - weather: 1.0.0 → 1.1.0
    - brave-search: 1.0.0 → 1.2.0

  New skill templates (not installed):
    - some-new-skill: available to install via /add-skill-some-new-skill
```

**If conflicts were detected**: tell the user the merge cannot proceed because the fork has diverged from nanotars. This needs to be fixed on the fork side first. List the conflicting files. **Stop here — do not offer to merge.**

**If no conflicts**: ask the user to choose using AskUserQuestion:
- A) **Apply update**: merge all fork changes
- B) **Abort**: they only wanted the preview

If Abort: stop here.

# Step 3: Apply update (MERGE)
Run:
- `git merge nanoclaw/$FORK_BRANCH --no-edit`

The merge should succeed cleanly (conflicts were already checked in Step 2c). If it somehow fails:
- `git merge --abort`
- Tell the user the merge failed and stop.

# Step 4: Validation
Run:
- `npm run build`
- `npm test` (do not fail the flow if tests are not configured)

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches from merged code).
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.

# Step 5: Plugin updates (after successful merge + build)

Now that the fork code is merged and built, apply plugin updates if any were detected in Step 2b.

Re-scan the local (now merged) skill templates vs installed plugins to confirm version differences:

For each `.claude/skills/add-skill-*/files/plugin.json` and `add-channel-*/files/plugin.json`:
1. Read the template's `plugin.json` → get `name` and `version`
2. Find matching installed plugin under `plugins/` or `plugins/channels/` by `name` field
3. Compare versions (semver string comparison)
4. If template version > installed version → add to update list

If updates are available, present them:
```
Plugin updates available after merge:
  - weather: 1.0.0 → 1.1.0
  - brave-search: 1.0.0 → 1.2.0

Would you like to update these plugins? (Updates copy template files over installed plugin directories, preserving your group/channel scoping.)
```

If user says yes, for each plugin to update:
1. Read the installed `plugin.json` to capture current `channels` and `groups` arrays (user scoping)
2. Copy all files from the skill template directory (`.claude/skills/add-skill-<name>/files/`) over the installed plugin directory (`plugins/<name>/`)
3. Re-apply the preserved `channels` and `groups` arrays to the new `plugin.json` (overwrite what the template set)
4. If the plugin has `dependencies: true`, run `npm install` in the plugin directory
5. Report what was updated

If user says no, skip — they can update individual plugins later via their `/add-skill-*` skills.

# Step 6: Summary + rollback instructions
Show:
- Backup tag: the tag name created in Step 1
- New HEAD: `git rev-parse --short HEAD`
- Fork HEAD: `git rev-parse --short nanoclaw/$FORK_BRANCH`
- Remaining local diff vs fork: `git diff --name-only nanoclaw/$FORK_BRANCH..HEAD`

Update summary:
- **Core code**: "X files changed in src/, container/, etc."
- **Skill templates**: "Y skill templates updated in .claude/skills/"
- **Plugins updated**: list plugins that were updated (or "none — user deferred" / "none — all up to date")

Tell the user:
- To rollback: `git reset --hard <backup-tag-from-step-1>`
- Backup branch also exists: `backup/pre-update-<HASH>-<TIMESTAMP>`
- If plugins were updated or core code changed, restart the service:
  - If using systemd: `sudo systemctl restart nanoclaw`
  - If running manually: restart `npm run dev`
