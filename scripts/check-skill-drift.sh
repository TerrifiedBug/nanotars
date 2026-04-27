#!/usr/bin/env bash
# Soft CI hint: when plugin-interface files change, prompt the author to
# review the skill docs that document them. Non-blocking — emits a warning
# only. Author acknowledges by amending the commit with `skills-reviewed:
# yes` or by updating the relevant SKILL.
#
# Usage:
#   scripts/check-skill-drift.sh <base-ref>
# Default base-ref: origin/main

set -euo pipefail

BASE_REF="${1:-origin/main}"

# Files whose changes may invalidate the SKILL docs.
WATCHED_FILES=(
  "src/plugin-loader.ts"
  "src/plugin-types.ts"
  "src/container-mounts.ts"
  "src/permissions/create-skill-plugin.ts"
)

# Skill docs that document the plugin interface.
SKILL_DOCS=(
  ".claude/skills/create-skill-plugin/SKILL.md"
  ".claude/skills/nanotars-publish-skill/SKILL.md"
  "container/skills/create-skill-plugin/SKILL.md"
  "groups/global/CLAUDE.md"
  "CLAUDE.md"
)

# Files changed in the diff against base-ref.
CHANGED_FILES=$(git diff --name-only "$BASE_REF"...HEAD || git diff --name-only HEAD)

# Did any watched file change?
WATCHED_CHANGED=()
for f in "${WATCHED_FILES[@]}"; do
  if echo "$CHANGED_FILES" | grep -qx "$f"; then
    WATCHED_CHANGED+=("$f")
  fi
done

# Did any skill doc change?
SKILLS_CHANGED=0
for f in "${SKILL_DOCS[@]}"; do
  if echo "$CHANGED_FILES" | grep -qx "$f"; then
    SKILLS_CHANGED=1
    break
  fi
done

# If watched files changed but skills did not, emit warning.
if [ ${#WATCHED_CHANGED[@]} -gt 0 ] && [ "$SKILLS_CHANGED" -eq 0 ]; then
  # Allow opt-out via commit message.
  if git log "$BASE_REF"..HEAD --format="%B" | grep -q "skills-reviewed: yes"; then
    echo "⚠️  Plugin interface files changed; skill docs untouched, but commit asserts 'skills-reviewed: yes'."
    exit 0
  fi
  echo "⚠️  Plugin interface files changed but skill docs were not updated:"
  for f in "${WATCHED_CHANGED[@]}"; do
    echo "  - $f modified"
  done
  echo ""
  echo "Please review:"
  for f in "${SKILL_DOCS[@]}"; do
    echo "  - $f"
  done
  echo ""
  echo "If no update is needed, add 'skills-reviewed: yes' to your commit message."
  exit 1
fi

echo "OK: no skill drift detected."
exit 0
