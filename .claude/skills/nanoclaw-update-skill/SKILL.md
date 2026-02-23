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

## Step 2: Present changes

If no changes detected:
> All marketplace plugins are up to date with your local installation.

Then stop.

Otherwise, show what changed:
```
Changed plugins (local vs marketplace cache):
  - whatsapp: 1 file differs
  - calendar: 3 files differ
```

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

Sync plugin runtime files:
```bash
rsync -av --delete \
  --exclude node_modules \
  --exclude package-lock.json \
  {installed}/ /tmp/nanoclaw-skills/plugins/nanoclaw-{name}/files/
```

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
git diff --cached --diff-filter=ACM -z --name-only | xargs -0 grep -lnE '(password|secret|token|api_key|private_key)\s*[:=]' 2>/dev/null | grep -v plugin.json || echo "No credential patterns found"
```

If matches found, warn the user and ask for confirmation before proceeding.

## Step 6: Commit and create PR

```bash
cd /tmp/nanoclaw-skills
git add .
git commit -m "update: sync {plugin_names} from local"
git push -u origin "update/${NAMES}"
```

Create the pull request:
```bash
gh pr create \
  --repo TerrifiedBug/nanoclaw-skills \
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

## Step 7: Summary

Show the PR URL.

Tell the user:
> PR created. When merged, the GitHub Action will auto-bump the plugin version (patch by default).
> To bump minor or major instead, add a `minor` or `major` label to the PR before merging.
>
> After merge, users running `/nanoclaw-update` will see the new version and be offered the update.
