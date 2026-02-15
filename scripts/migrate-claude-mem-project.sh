#!/usr/bin/env bash
# One-time migration: rename claude-mem project nanoclaw-mem → nanoclaw-main
# Run this once after upgrading to the channel plugin architecture.
#
# Usage: ./scripts/migrate-claude-mem-project.sh
#
# The script finds the claude-mem SQLite database and renames the project
# field from the old hardcoded name to the new per-group naming convention.

set -euo pipefail

CLAUDE_MEM_DB="${CLAUDE_MEM_DB:-$HOME/.claude-mem/claude-mem.db}"

if [ ! -f "$CLAUDE_MEM_DB" ]; then
  echo "Claude-mem database not found at: $CLAUDE_MEM_DB"
  echo "Set CLAUDE_MEM_DB env var to the correct path."
  exit 1
fi

OLD_PROJECT="nanoclaw-mem"
NEW_PROJECT="nanoclaw-main"

# Count affected rows
COUNT=$(sqlite3 "$CLAUDE_MEM_DB" "SELECT COUNT(*) FROM observations WHERE project = '$OLD_PROJECT';")

if [ "$COUNT" -eq 0 ]; then
  echo "No observations found with project='$OLD_PROJECT'. Nothing to migrate."
  exit 0
fi

echo "Found $COUNT observations with project='$OLD_PROJECT'"
echo "Migrating to project='$NEW_PROJECT'..."

sqlite3 "$CLAUDE_MEM_DB" "UPDATE observations SET project = '$NEW_PROJECT' WHERE project = '$OLD_PROJECT';"

VERIFY=$(sqlite3 "$CLAUDE_MEM_DB" "SELECT COUNT(*) FROM observations WHERE project = '$NEW_PROJECT';")
echo "Migration complete. $VERIFY observations now have project='$NEW_PROJECT'"
