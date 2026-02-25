---
name: nanoclaw-update-skill
description: Sync improved local plugins to the NanoClaw skills marketplace and create a PR. Detects which plugins changed, shows a diff, and handles the git workflow. Triggers on "update skill", "sync plugin to marketplace", "publish update".
---

# Update Plugin in Marketplace

Syncs changes from locally installed plugins to the NanoClaw skills marketplace at `TerrifiedBug/nanoclaw-skills` via a pull request.

Use `/nanoclaw-publish-skill` for **new** plugins. Use this skill for **updating** existing marketplace plugins.

Run `/nanoclaw-update-skill` (all changed plugins) or `/nanoclaw-update-skill weather` (specific plugin).

## Step 0: Preflight

Check GitHub CLI authentication:
```bash
gh auth status
```

If not authenticated, tell the user to run `gh auth login` first and stop.

Verify marketplace cache exists:
```bash
[ -d ~/.claude/plugins/marketplaces/nanoclaw-skills ] && echo "CACHE: ok" || echo "CACHE: missing"
```

If missing, tell the user:
> Marketplace cache not found. Run `/plugin marketplace update nanoclaw-skills` to sync, then re-run this skill.

Then stop.

## Step 1: Detect changed plugins

If the user provided a plugin name argument, resolve it:
- `weather` → `plugins/weather/` (marketplace: `nanoclaw-weather`)
- `whatsapp` → `plugins/channels/whatsapp/` (marketplace: `nanoclaw-whatsapp`)
- If not found, list installed plugins and ask

If no argument, scan all installed plugins.

For each plugin directory under `plugins/` and `plugins/channels/`:
1. Extract the directory name (e.g., `weather`, `whatsapp`)
2. Locate marketplace cache: `~/.claude/plugins/marketplaces/nanoclaw-skills/plugins/nanoclaw-{name}/files/`
3. If no marketplace match, skip (local-only plugin — use `/nanoclaw-publish-skill` instead)
4. Diff installed vs marketplace cache (excluding `node_modules`, `package-lock.json`, and user-scoping fields in `plugin.json`):
   ```bash
   diff -rq -x node_modules -x package-lock.json -x plugin.json {installed}/ {cache}/
   jq 'del(.channels, .groups)' {installed}/plugin.json > /tmp/installed-pj.json
   jq 'del(.channels, .groups)' {cache}/plugin.json > /tmp/cache-pj.json
   diff -q /tmp/installed-pj.json /tmp/cache-pj.json
   ```
5. Collect plugins with differences
6. For each plugin with differences, check directionality — determine whether local is ahead of marketplace or behind:
   ```bash
   # Count lines only in local (local additions)
   LOCAL_ONLY=$(diff -r -x node_modules -x package-lock.json -x plugin.json {installed}/ {cache}/ | grep -c '^< ' || true)
   # Count lines only in marketplace (marketplace additions)
   MARKET_ONLY=$(diff -r -x node_modules -x package-lock.json -x plugin.json {installed}/ {cache}/ | grep -c '^> ' || true)
   # Files only in local
   FILES_LOCAL=$(diff -rq -x node_modules -x package-lock.json -x plugin.json {installed}/ {cache}/ | grep -c "^Only in {installed}" || true)
   # Files only in marketplace
   FILES_MARKET=$(diff -rq -x node_modules -x package-lock.json -x plugin.json {installed}/ {cache}/ | grep -c "^Only in {cache}" || true)
   ```
   - If marketplace has more content (MARKET_ONLY > LOCAL_ONLY or FILES_MARKET > FILES_LOCAL): marketplace may be **ahead** of local — flag as "marketplace ahead"
   - If local has more content: local is likely **ahead** — flag as "local ahead" (safe to sync)
   - If roughly equal (both have similar additions/removals): flag as "unclear direction" — show the diff summary and ask the user whether to sync or skip

## Step 2: Present changes

If no changes detected:
> All marketplace plugins are up to date with your local installation.

Then stop.

Otherwise, show what changed with directionality:
```
Local improvements (safe to sync → marketplace):
  - weather: 3 files differ

⚠ Marketplace may be ahead of local (sync would downgrade):
  - slack: 1 file differs — marketplace has additions not in local

? Unclear direction (similar changes on both sides):
  - calendar: 2 files differ — review diff before syncing
```

**If ALL plugins are flagged "marketplace ahead"**, tell the user:
> No local improvements detected. The marketplace appears to be ahead of your local plugins.
> Run `/nanoclaw-update` to pull marketplace updates into your local installation instead.

Then stop.

For "unclear direction" plugins, show the `diff` output and ask the user whether to include them.

Only auto-proceed with plugins flagged "local ahead". Warn about and skip "marketplace ahead" plugins unless the user explicitly overrides.

If a plugin name argument was given, skip selection and proceed with that plugin.

Otherwise, use `AskUserQuestion` with `multiSelect: true`:
> Which plugins would you like to sync to the marketplace?

Options: list each changed plugin as an option.

## Step 3: Clone or update marketplace repo

```bash
if [ -d /tmp/nanoclaw-skills/.git ]; then
  cd /tmp/nanoclaw-skills && git checkout main && git pull origin main
else
  gh repo clone TerrifiedBug/nanoclaw-skills /tmp/nanoclaw-skills
  cd /tmp/nanoclaw-skills
fi
```

Create a feature branch:
```bash
NAMES=$(echo "{selected_plugins}" | tr ' ' '-')
git checkout -b "update/${NAMES}"
```

## Step 4: Sync files

For each selected plugin:

Determine paths:
- Installed: `plugins/{name}/` or `plugins/channels/{name}/`
- Marketplace: `/tmp/nanoclaw-skills/plugins/nanoclaw-{name}/files/`

Sync plugin runtime files (excluding `plugin.json` which needs special handling):
```bash
rsync -av \
  --exclude node_modules \
  --exclude package-lock.json \
  --exclude plugin.json \
  {installed}/ /tmp/nanoclaw-skills/plugins/nanoclaw-{name}/files/
```

**Do NOT use `--delete`** — the marketplace may contain files not present locally (README, docs added by other contributors). Only sync files that exist locally.

Sync `plugin.json` separately, preserving marketplace `version`, `channels`, and `groups` fields:
```bash
# Start with marketplace plugin.json (preserves version + scoping)
MARKET_PJ="/tmp/nanoclaw-skills/plugins/nanoclaw-{name}/files/plugin.json"
LOCAL_PJ="{installed}/plugin.json"

# Merge: take all fields from local EXCEPT version/channels/groups which stay from marketplace
jq -s '.[0] as $market | .[1] | .version = $market.version | .channels = $market.channels | .groups = $market.groups' \
  "$MARKET_PJ" "$LOCAL_PJ" > "${MARKET_PJ}.tmp" && mv "${MARKET_PJ}.tmp" "$MARKET_PJ"
```

This prevents three problems:
- **Scoping leak**: local `"channels": ["whatsapp"]` overwriting marketplace `"channels": ["*"]`
- **Version downgrade**: local `1.0.0` overwriting marketplace `1.0.3` (auto-bumped by CI)
- **File deletion**: marketplace-only files being removed by `--delete`

Also sync the install skill if it exists in the main repo:
```bash
SKILL_TYPE="skill"  # or "channel" for channel plugins
SKILL_DIR="add-${SKILL_TYPE}-${name}"
if [ -d ".claude/skills/${SKILL_DIR}" ]; then
  rsync -av \
    .claude/skills/${SKILL_DIR}/ /tmp/nanoclaw-skills/plugins/nanoclaw-{name}/skills/${SKILL_DIR}/
fi
```

## Step 5: Review changes

Show what will be committed:
```bash
cd /tmp/nanoclaw-skills && git diff --stat
```

For a detailed diff:
```bash
git diff
```

Scan for potential credentials:
```bash
git diff --diff-filter=ACM -z --name-only | xargs -0 grep -lnE '(password|secret|token|api_key|private_key)\s*[:=]' 2>/dev/null | grep -v plugin.json || echo "No credential patterns found"
```

If matches found, warn the user and ask for confirmation before proceeding.

## Step 6: Commit and create PR

```bash
cd /tmp/nanoclaw-skills
git add .
git commit -m "update: sync {plugin_names} from local"
git push -u origin "update/${NAMES}"
```

Create the pull request. **Must use `--head`** because cwd may not be the marketplace checkout:
```bash
gh pr create \
  --repo TerrifiedBug/nanoclaw-skills \
  --head "update/${NAMES}" \
  --title "update: {plugin_names}" \
  --body "$(cat <<'PREOF'
## Summary
Syncs latest local changes for: {plugin_list}

## Changed files
{git_diff_stat}

## Notes
Version will be auto-bumped on merge (patch by default).
Add label `minor` or `major` to this PR to change bump level.
PREOF
)"
```

## Step 7: Auto-label version bump

Analyze the diff from Step 5 and determine the semver bump level:

- **patch** (default — no label needed): Bug fixes, performance improvements, internal refactors that don't change behavior. Examples: fixing a reconnect loop, filtering noisy messages, improving error handling.
- **minor** (add `minor` label): New features or capabilities. Examples: new config options, new exported functions, new message types handled, new files added.
- **major** (add `major` label): Breaking changes. Examples: removed functions/config, renamed env vars, changed message format, changed plugin.json schema.

If the bump level is `minor` or `major`, apply the label:
```bash
gh pr edit {pr_number} --repo TerrifiedBug/nanoclaw-skills --add-label "{level}"
```

Tell the user what you chose and why:
> Version bump: **{level}** — {one-sentence reasoning}
> You can change this by editing PR labels before merging.

## Step 8: Summary

Show the PR URL.

Tell the user:
> PR created. The GitHub Action will auto-bump the version on merge ({level}).
>
> After merge, users running `/nanoclaw-update` will see the new version and be offered the update.
