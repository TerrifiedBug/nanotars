---
name: nanoclaw-publish-skill
description: Publish a local skill to the NanoClaw skills marketplace. Restructures a .claude/skills/add-* skill into Claude Code plugin format and pushes to TerrifiedBug/nanoclaw-skills. Triggers on "publish skill", "publish to marketplace", "nanoclaw publish".
---

# Publish Skill to Marketplace

Publishes a local skill (`.claude/skills/add-skill-{name}/` or `.claude/skills/add-channel-{name}/`) to the NanoClaw skills marketplace at `TerrifiedBug/nanoclaw-skills`.

## Step 0: Identify the Skill

If the user provided a skill name, resolve it:
- If they said "weather", look for `.claude/skills/add-skill-weather/`
- If they said "discord", look for `.claude/skills/add-channel-discord/`
- If ambiguous, list matching skills and ask

Verify the skill directory exists and has a `SKILL.md` file.

## Step 1: Validate Local Skill

Check prerequisites:
```bash
[ -f ".claude/skills/${SKILL_DIR}/SKILL.md" ] && echo "SKILL.MD: ok" || echo "SKILL.MD: missing"
[ -d ".claude/skills/${SKILL_DIR}/files" ] && echo "FILES: ok" || echo "FILES: missing (may be ok for skills without templates)"
```

Read the SKILL.md frontmatter to extract `name` and `description`.

## Step 2: Clone or Locate Marketplace Repo

Check if the marketplace repo is already cloned:
```bash
[ -d "/data/nanoclaw-skills/.git" ] && echo "MARKETPLACE: local at /data/nanoclaw-skills" || echo "MARKETPLACE: needs clone"
```

If not found, clone it:
```bash
gh repo clone TerrifiedBug/nanoclaw-skills /data/nanoclaw-skills
```

Pull latest:
```bash
cd /data/nanoclaw-skills && git pull
```

## Step 3: Restructure into Plugin Format

Derive names:
- `SKILL_DIR` = e.g. `add-skill-weather`
- `SHORT_NAME` = strip `add-skill-` or `add-channel-` prefix → e.g. `weather`
- `PLUGIN_NAME` = `nanoclaw-${SHORT_NAME}`

Create the plugin directory:
```bash
PLUGIN_DIR="/data/nanoclaw-skills/plugins/${PLUGIN_NAME}"
mkdir -p "$PLUGIN_DIR/.claude-plugin"
mkdir -p "$PLUGIN_DIR/skills/${SKILL_DIR}"
```

### 3a: Create plugin.json manifest

Read `files/plugin.json` (if it exists) for version, otherwise default to `1.0.0`.

Write `.claude-plugin/plugin.json`:
```json
{
  "name": "<PLUGIN_NAME>",
  "version": "<VERSION>",
  "description": "<DESCRIPTION from SKILL.md frontmatter>"
}
```

### 3b: Copy and transform SKILL.md

Copy SKILL.md to `skills/${SKILL_DIR}/SKILL.md`.

Replace all occurrences of `.claude/skills/${SKILL_DIR}/files/` and `.claude/skills/${SKILL_DIR}/files` with `${CLAUDE_PLUGIN_ROOT}/files/` and `${CLAUDE_PLUGIN_ROOT}/files` respectively.

### 3c: Copy files/ directory

If `.claude/skills/${SKILL_DIR}/files/` exists:
```bash
cp -r ".claude/skills/${SKILL_DIR}/files" "$PLUGIN_DIR/files"
```

## Step 4: Update marketplace.json

Read `/data/nanoclaw-skills/.claude-plugin/marketplace.json`.

Check if a plugin with this name already exists:
- If yes: update the existing entry (bump version if changed)
- If no: add a new entry to the `plugins` array

Ask the user for the category:
> What category should this skill be listed under?
> channels, productivity, search, media, monitoring, smart-home, utilities

Write the updated marketplace.json.

## Step 5: Commit and Push

```bash
cd /data/nanoclaw-skills
git add -A
git status
```

Show the user what will be committed and ask for confirmation.

```bash
git commit -m "feat: add ${PLUGIN_NAME} skill"
git push
```

## Step 6: Cleanup (Optional)

Ask the user:
> Skill published! Do you want to:
> 1. Keep the local copy in .claude/skills/ (for development)
> 2. Remove it and install from marketplace instead

If they choose option 2:
```bash
rm -rf ".claude/skills/${SKILL_DIR}"
```
Then tell them to install from marketplace:
```
/plugin install ${PLUGIN_NAME}@nanoclaw-skills
```
