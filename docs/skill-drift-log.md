# Skill Drift Log

Manual record of when each skill doc was last verified accurate against the live plugin interface. Updated whenever the CI drift hint fires and a maintainer confirms the skill is still current (or after they update it to match).

## Watched files (drift signal)

Changes in any of these files may invalidate the skills below:

- `src/plugin-loader.ts`
- `src/plugin-types.ts`
- `src/container-mounts.ts`
- `src/permissions/create-skill-plugin.ts`

## Last verified

| Skill | Last verified | Commit |
|---|---|---|
| `.claude/skills/create-skill-plugin/SKILL.md` | 2026-04-27 | slice-6 (HEAD) |
| `.claude/skills/nanotars-publish-skill/SKILL.md` | 2026-04-27 | slice-6 (HEAD) |
| `container/skills/create-skill-plugin/SKILL.md` | 2026-04-27 | slice-6 (HEAD) |
| `groups/global/CLAUDE.md` (Creating Skills/Plugins section) | 2026-04-27 | slice-6 (HEAD) |
| `CLAUDE.md` (Plugin Boundary section) | 2026-04-27 | slice-6 (HEAD) |
