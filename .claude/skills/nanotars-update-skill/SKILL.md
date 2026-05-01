---
name: nanotars-update-skill
description: Sync improved local plugins to the NanoTars skills marketplace and create a PR. Detects which plugins changed, shows a diff, and handles the git workflow. Triggers on "update skill", "sync plugin to marketplace", "publish update".
---

# Update Plugin in Marketplace

Syncs local plugin changes to the NanoTars skills marketplace at `TerrifiedBug/nanotars-skills` via a pull request.

Use `/nanotars-publish-skill` for **new** plugins. Use this skill for **updating** existing marketplace plugins.

Run `/nanotars-update-skill` (all changed plugins) or `/nanotars-update-skill weather` (specific plugin).

## Where skills live (read this if confused)

Four directories use the name "skills" for different jobs. Only **two** of them participate in this sync:

| Location | Audience | Synced by this skill? |
|---|---|---|
| `~/nanotars/.claude/skills/` | Operator (host slash commands like `/nanotars-setup`) | **No** — host-only, never published |
| `~/nanotars/container/skills/` | Agent (core skills mounted into every container) | **No** — fork-local |
| `~/nanotars/plugins/{name}/container-skills/` | Agent (per-plugin, mounted when installed) | **Yes** — synced as a runtime file under `files/` |
| `marketplaces/nanotars-skills/plugins/nanotars-{name}/skills/add-skill-{name}/` | Operator (the install workflow Claude executes for `/add-skill-{name}`) | **Yes** — operators edit this *directly in the marketplace cache*, dirty changes get bundled |

So this skill picks up changes from **two sources**:
1. **Runtime files** in `~/nanotars/plugins/{name}/` (rsync into marketplace `files/`)
2. **Install skill edits** already present as uncommitted changes in `~/.claude/plugins/marketplaces/nanotars-skills/plugins/nanotars-{name}/skills/` (left in place, committed)

## Step 0: Preflight

```bash
gh auth status 2>&1 | head -3
[ -d ~/.claude/plugins/marketplaces/nanotars-skills/.git ] && echo "MARKETPLACE: ok" || echo "MARKETPLACE: missing"
```

If `gh` is not authenticated, tell the user to run `gh auth login` and stop.
If marketplace cache is missing, tell the user to run `/plugin marketplace update nanotars-skills` and stop.

Refuse to proceed if the marketplace cache is in a weird state — it's our working tree, so it must be on a clean known branch:

```bash
cd ~/.claude/plugins/marketplaces/nanotars-skills
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "BRANCH: $BRANCH"
git status --porcelain | head
```

If branch is not `main`, tell the user the cache is on `$BRANCH` (likely from a prior run). Show the dirty status. Ask whether to:
- Return to main (`git checkout main` — dirty edits are preserved if they don't conflict, otherwise stop and let the user resolve manually)
- Proceed on the current branch (only if they intentionally want to amend an in-flight PR)

Default to returning to main if uncertain.

If on main, pull (preserve dirty changes — uncommitted edits are the operator's intentional install-skill work):

```bash
cd ~/.claude/plugins/marketplaces/nanotars-skills && git pull --rebase --autostash origin main 2>&1 | tail -3
```

## Step 1: Detect changes per plugin

Define paths once (used in every later step):

```bash
NANOTARS=~/nanotars
MARKETPLACE=~/.claude/plugins/marketplaces/nanotars-skills
```

If the user passed a plugin name argument (e.g., `calendar`), restrict scanning to that one. Otherwise scan everything under `$NANOTARS/plugins/` and `$NANOTARS/plugins/channels/`, excluding private plugins.

Private/local-only plugins are never synced upstream. Skip a plugin when either condition is true:
- its path is under `$NANOTARS/plugins/private/`
- its `plugin.json` has `"private": true`

For each local plugin, find the marketplace counterpart by **matching `plugin.json.name`**, not directory name. Directories diverge (e.g. local `gif-search/` ↔ marketplace `nanotars-giphy/`) but the canonical identity is the `name` field inside `plugin.json`.

```bash
# Build a map of marketplace plugins keyed by their plugin.json name.
declare -A MARKET_BY_NAME
for d in "$MARKETPLACE/plugins/"nanotars-*/; do
  pj="$d/files/plugin.json"
  [ -f "$pj" ] || continue
  n=$(jq -r '.name // empty' "$pj")
  [ -n "$n" ] && MARKET_BY_NAME["$n"]="${d%/}"
done

# For each local plugin (`{name}` is the local directory name), resolve
# its marketplace dir by plugin.json `name`, then fall back to the
# `nanotars-{name}` directory convention.
declare -A MARKET_DIRS
declare -A LOCAL_DIRS
LOCAL_DIR="$NANOTARS/plugins/{name}"
LOCAL_PJ="$LOCAL_DIR/plugin.json"
if [ "$(jq -r '.private // false' "$LOCAL_PJ")" = "true" ] || [[ "$LOCAL_DIR" == "$NANOTARS/plugins/private/"* ]]; then
  # private/local-only — skip without publish hint
  continue
fi
LOCAL_NAME=$(jq -r '.name' "$LOCAL_PJ")
RESOLVED="${MARKET_BY_NAME[$LOCAL_NAME]:-}"
if [ -z "$RESOLVED" ] && [ -d "$MARKETPLACE/plugins/nanotars-{name}" ]; then
  RESOLVED="$MARKETPLACE/plugins/nanotars-{name}"
fi
MARKET_DIRS[{name}]="$RESOLVED"
LOCAL_DIRS[{name}]="$LOCAL_DIR"
MARKET_DIR="$RESOLVED"
```

If no marketplace counterpart is found via either lookup, classify the plugin:

- **Fork-bundled core plugin** — the plugin directory is git-tracked in the nanotars fork (e.g. `agent-browser`). These ship via the fork itself, not the marketplace. Skip silently — no publish needed, no warning.
- **Private / local-only** — under `plugins/private/` or `plugin.json.private == true`. Skip with a note that private plugins are intentionally not synced.
- **Local-only / unpublished** — not git-tracked. Skip with a note suggesting `/nanotars-publish-skill`.

Detect via:
```bash
if git -C "$NANOTARS" ls-files --error-unmatch "plugins/{name}/plugin.json" >/dev/null 2>&1 || \
   git -C "$NANOTARS" ls-files --error-unmatch "plugins/channels/{name}/plugin.json" >/dev/null 2>&1; then
  # fork-bundled — skip silently
  continue
elif [ "$(jq -r '.private // false' "$LOCAL_PJ")" = "true" ]; then
  # private/local-only — skip silently or note "private"
  continue
else
  # local-only — emit "use /nanotars-publish-skill" hint
fi
```

Track resolved paths in `MARKET_DIRS` so later steps (commit/stage) can reference each plugin's marketplace dir without re-resolving.

Once `MARKET_DIR` is resolved for each plugin, detect changes from **both sources**.

**Source A — runtime files** (local install vs marketplace `files/`):

```bash
diff -rq -x node_modules -x package-lock.json -x plugin.json \
  "$LOCAL_DIR/" "$MARKET_DIR/files/"
# plus a content-only plugin.json diff (ignoring scoping fields):
jq 'del(.channels, .groups, .version, .private)' "$LOCAL_PJ" > /tmp/local-pj.json
jq 'del(.channels, .groups, .version)' "$MARKET_DIR/files/plugin.json" > /tmp/market-pj.json
diff /tmp/local-pj.json /tmp/market-pj.json
```

**Source B — install-skill edits** (any uncommitted changes in the marketplace cache scoped to this plugin):

```bash
cd $MARKETPLACE
MARKET_REL=$(realpath --relative-to="$MARKETPLACE" "$MARKET_DIR")
git status --porcelain "$MARKET_REL/" 2>/dev/null
```

If both sources are empty for a plugin, mark it unchanged.

## Step 2: Present and select

If nothing changed anywhere:

> All marketplace plugins are up to date.

Then stop.

Otherwise show a per-plugin summary like:

```
calendar:
  runtime files: 0 changed
  install skill: 1 file modified (skills/add-skill-calendar/SKILL.md)

gmail:
  runtime files: 2 changed (Dockerfile.partial, plugin.json)
  install skill: clean
```

If a plugin name was passed in, proceed with that plugin only. Otherwise use `AskUserQuestion` with `multiSelect: true` to let the operator pick which to include.

## Step 3: Branch off main

```bash
cd $MARKETPLACE
NAMES=$(echo "{selected_plugins}" | tr ' ' '-')
git checkout -b "update/${NAMES}"
```

Uncommitted install-skill edits travel into the new branch automatically (git carries dirty files when switching to a new branch from clean state — and we're branching off main where the only diff is the operator's intentional edits).

## Step 4: Sync runtime files into the marketplace tree

For each selected plugin, copy runtime files into `$MARKET_DIR/files/`. **No `--delete`** — the marketplace may have files we don't carry locally.

```bash
rsync -av \
  --exclude node_modules \
  --exclude package-lock.json \
  --exclude plugin.json \
  "$LOCAL_DIR/" "$MARKET_DIR/files/"
```

Merge `plugin.json` separately, preserving the marketplace's `version`, `channels`, and `groups` (operator scoping must not leak into the marketplace, and the version is auto-bumped by CI):

```bash
MARKET_PJ="$MARKET_DIR/files/plugin.json"
LOCAL_PJ="$LOCAL_DIR/plugin.json"
jq -s '.[0] as $m | .[1] | del(.private) | .version = $m.version | .channels = $m.channels | .groups = $m.groups' \
  "$MARKET_PJ" "$LOCAL_PJ" > "${MARKET_PJ}.tmp" && mv "${MARKET_PJ}.tmp" "$MARKET_PJ"
```

## Step 5: Review

```bash
cd $MARKETPLACE
git status -s
git diff --stat
```

Show the per-file diff stat. For non-trivial changes also show the full diff of any `add-skill-*/SKILL.md` files (these are the operator-facing instructions Claude will execute — worth eyeballing).

Credential scan (post-rsync, after all files are in place):

```bash
git diff --diff-filter=ACM -z --name-only HEAD | xargs -0 -r grep -lnE '(password|secret|token|api_key|private_key)\s*[:=]' 2>/dev/null
```

If anything matches, show the matched lines and confirm with the operator before committing.

## Step 6: Commit, push, PR

Stage only the directories of the selected plugins (don't sweep up unrelated dirty files). Use the resolved `MARKET_DIR` for each selected plugin — local-name → marketplace-dir is not always a simple `nanotars-{name}` prefix (e.g. local `gif-search` ↔ marketplace `nanotars-giphy`).

```bash
cd $MARKETPLACE
for name in {selected_plugins}; do
  market_rel=$(realpath --relative-to="$MARKETPLACE" "${MARKET_DIRS[$name]}")
  git add "$market_rel/"
done
```

Write a commit message that names what actually changed. Look at the diff and produce something specific — e.g., `update: nanotars-calendar — add mount-allowlist preflight to install skill`. Generic `sync {names} from local` is a fallback only if the diff doesn't tell a clear story.

```bash
git -c user.name='TARS' -c user.email='dannyfeates@yahoo.co.uk' commit -m "<your-message>"
git push -u origin "update/${NAMES}"
```

Create the PR (always pass `--head` — cwd may have been reset):

```bash
gh pr create \
  --repo TerrifiedBug/nanotars-skills \
  --head "update/${NAMES}" \
  --title "<short title matching commit>" \
  --body "$(cat <<'PREOF'
## Summary
<2–3 bullets — what changed and why, derived from the diff>

## Changed files
<git diff --stat output>

## Notes
Version will be auto-bumped on merge. Add the `minor` or `major` label to override.
PREOF
)"
```

## Step 7: Auto-label version bump

Pick the bump level by reading the diff:

- **patch** (no label needed, default): bug fixes, performance tweaks, internal refactors that don't change behavior or surface area
- **minor** (add `minor` label): new features — new config options, new mount paths, new Step in an install skill, additional plugin capabilities
- **major** (add `major` label): breaking changes — removed/renamed env vars, schema changes in `plugin.json`, removed install steps that operators relied on

```bash
gh pr edit <pr-number> --repo TerrifiedBug/nanotars-skills --add-label "<level>"
```

Tell the operator: `Version bump: <level> — <one-sentence reason>. Edit PR labels to override.`

## Step 8: Done

Show the PR URL.

> PR opened. The GitHub Action will auto-bump the version on merge (`<level>`). After merge, `/nanotars-update` will see the new version and offer the update.
