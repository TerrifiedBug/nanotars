---
name: nanoclaw-publish-skill
description: Publish a local skill to the NanoClaw skills marketplace. Restructures a .claude/skills/add-* skill into Claude Code plugin format and creates a PR on TerrifiedBug/nanoclaw-skills. Triggers on "publish skill", "publish to marketplace", "nanoclaw publish".
---

# Publish Skill to Marketplace

Publishes a local skill (`.claude/skills/add-skill-{name}/` or `.claude/skills/add-channel-{name}/`) to the NanoClaw skills marketplace at `TerrifiedBug/nanoclaw-skills` via a pull request.

## Step 0: Prerequisites

Check GitHub CLI authentication:
```bash
gh auth status
```

If not authenticated, tell the user to run `gh auth login` first and stop.

If the user is not the owner of `TerrifiedBug/nanoclaw-skills`, they need to fork it first:
```bash
gh repo fork TerrifiedBug/nanoclaw-skills --clone=false
```

## Step 1: Identify the Skill

If the user provided a skill name, resolve it:
- If they said "weather", look for `.claude/skills/add-skill-weather/`
- If they said "discord", look for `.claude/skills/add-channel-discord/`
- If ambiguous, list matching skills and ask

Verify the skill directory exists and has a `SKILL.md` file.

## Step 2: Validate Local Skill

Check prerequisites:
```bash
[ -f ".claude/skills/${SKILL_DIR}/SKILL.md" ] && echo "SKILL.MD: ok" || echo "SKILL.MD: missing"
[ -d ".claude/skills/${SKILL_DIR}/files" ] && echo "FILES: ok" || echo "FILES: missing (may be ok for skills without templates)"
```

Read the SKILL.md frontmatter to extract `name` and `description`.

If `files/plugin.json` exists, read it to verify the runtime manifest has required fields (`name`, `description`, `containerEnvVars`, `hooks`). This file is the **runtime plugin manifest** — it will be copied as-is to the marketplace `files/` directory.

## Step 3: Test Locally

Before publishing, verify the skill works:

1. Run the skill's installation command (e.g., `/add-skill-weather`)
2. Check the plugin was created correctly in `plugins/`
3. Verify the service works with the plugin installed

Ask the user: **"Have you tested this skill locally? It should run to completion and create a working plugin."**

If they haven't tested, recommend doing so before publishing. Do not block if they choose to skip.

## Step 4: Clone or Locate Marketplace Repo

Check if the marketplace repo is already cloned:
```bash
[ -d "/data/nanoclaw-skills/.git" ] && echo "MARKETPLACE: local at /data/nanoclaw-skills" || echo "MARKETPLACE: needs clone"
```

If not found, clone it:
```bash
gh repo clone TerrifiedBug/nanoclaw-skills /data/nanoclaw-skills
```

Pull latest and create a feature branch:
```bash
cd /data/nanoclaw-skills && git checkout main && git pull
git checkout -b feat/add-${SHORT_NAME}
```

## Step 5: Restructure into Plugin Format

Derive names:
- `SKILL_DIR` = e.g. `add-skill-weather`
- `SHORT_NAME` = strip `add-skill-` or `add-channel-` prefix (e.g. `weather`)
- `PLUGIN_NAME` = `nanoclaw-${SHORT_NAME}`

Create the plugin directory:
```bash
PLUGIN_DIR="/data/nanoclaw-skills/plugins/${PLUGIN_NAME}"
mkdir -p "$PLUGIN_DIR/.claude-plugin"
mkdir -p "$PLUGIN_DIR/skills/${SKILL_DIR}"
```

### 5a: Create marketplace plugin manifest

This is the **marketplace manifest** (for Claude Code's plugin system). It is separate from the runtime `files/plugin.json`.

Read `files/plugin.json` (if it exists) for version, otherwise default to `1.0.0`.

Write `.claude-plugin/plugin.json`:
```json
{
  "name": "<PLUGIN_NAME>",
  "version": "<VERSION>",
  "description": "<DESCRIPTION from SKILL.md frontmatter>"
}
```

**Important:** This file only needs `name`, `version`, `description`. Runtime fields like `containerEnvVars`, `hooks`, `containerHooks`, `containerMounts`, `channels`, `groups`, `publicEnvVars`, `dependencies` belong in `files/plugin.json` (copied in step 5c), NOT in this marketplace manifest.

### 5b: Copy and transform SKILL.md

Copy SKILL.md to `skills/${SKILL_DIR}/SKILL.md`.

Replace all occurrences of `.claude/skills/${SKILL_DIR}/files/` and `.claude/skills/${SKILL_DIR}/files` with `${CLAUDE_PLUGIN_ROOT}/files/` and `${CLAUDE_PLUGIN_ROOT}/files` respectively.

After the path transformation, check if the SKILL.md already contains a `.marketplace.json` write step. If not, find the first `cp -r ${CLAUDE_PLUGIN_ROOT}/files/` line and inject a marketplace breadcrumb write immediately after it:

```bash
echo '{"marketplace":"nanoclaw-skills","plugin":"<PLUGIN_NAME>"}' > plugins/<dest>/.marketplace.json
```

Replace `<PLUGIN_NAME>` with the actual literal plugin name (e.g., `nanoclaw-weather`) and `<dest>` with the destination path from the `cp -r` line (e.g., `plugins/weather/`, `plugins/channels/discord/`). These must be literal strings, not shell variables. Match the indentation of the surrounding code.

This ensures `/nanoclaw-update` can detect marketplace updates by diffing installed files against the marketplace source.

### 5c: Copy files/ directory

If `.claude/skills/${SKILL_DIR}/files/` exists:
```bash
cp -r ".claude/skills/${SKILL_DIR}/files" "$PLUGIN_DIR/files"
```

This copies the runtime plugin manifest (`files/plugin.json`), container skills, hooks, scripts, MCP configs, `Dockerfile.partial`, and any other template files as-is. These are the actual files that get installed into `plugins/` when a user runs the skill.

## Step 6: Update marketplace.json

Read `/data/nanoclaw-skills/.claude-plugin/marketplace.json`.

Check if a plugin with this name already exists:
- If yes: update the existing entry (bump version if changed)
- If no: add a new entry to the `plugins` array

Ask the user for the category (must be one of):
> channels, productivity, search, media, monitoring, smart-home, utilities

Write the updated marketplace.json.

## Step 7: Update README.md

Add the new skill to the appropriate category table in `/data/nanoclaw-skills/README.md`. Match the format of existing entries.

## Step 8: Create Pull Request

```bash
cd /data/nanoclaw-skills
git add -A
git status
```

Show the user what will be committed and ask for confirmation.

```bash
git commit -m "feat: add ${PLUGIN_NAME} skill"
git push -u origin feat/add-${SHORT_NAME}
```

Create the pull request:
```bash
gh pr create --repo TerrifiedBug/nanoclaw-skills \
  --head feat/add-${SHORT_NAME} \
  --base main \
  --title "feat: add ${PLUGIN_NAME}" \
  --body "Adds the ${SKILL_DIR} skill to the marketplace.

Category: ${CATEGORY}
Version: ${VERSION}

## Checklist
- [ ] Tested locally before publishing
- [ ] No hardcoded secrets
- [ ] SKILL.md uses \${CLAUDE_PLUGIN_ROOT} paths"
```

Show the PR URL to the user.

**Note:** For forkers publishing to their own marketplace fork, the `--repo` flag should point to their fork instead.

## Step 9: Cleanup (Optional)

Ask the user:
> Skill published as PR! Do you want to:
> 1. Keep the local copy in .claude/skills/ (for development)
> 2. Remove it and install from marketplace after PR merges

If they choose option 2, tell them to remove it after the PR is merged:
```bash
rm -rf ".claude/skills/${SKILL_DIR}"
/plugin install ${PLUGIN_NAME}@nanoclaw-skills
```
