#!/usr/bin/env bash
# scripts/sync-container-skills-from-v2.sh
#
# Maintainer tool. Diffs (or applies) container/skills/<name>/ updates from
# upstream qwibitai/nanoclaw v2 against the current nanotars checkout. Useful
# for keeping bundled v2-derived skills (welcome, self-customize, agent-browser)
# current with upstream improvements.
#
# Not for end users — this is a contributor / fork-maintainer workflow tool.
#
# Usage:
#   bash scripts/sync-container-skills-from-v2.sh             # diff (default)
#   bash scripts/sync-container-skills-from-v2.sh --apply     # rsync new content
#   bash scripts/sync-container-skills-from-v2.sh --skill X   # only this skill
#
# Honours:
#   V2_REPO    upstream URL (default https://github.com/qwibitai/nanoclaw.git)
#   V2_BRANCH  upstream branch (default main)
#   V2_PATH    skip the clone, use a local checkout (e.g. V2_PATH=/data/nanoclaw-v2)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V2_REPO="${V2_REPO:-https://github.com/qwibitai/nanoclaw.git}"
V2_BRANCH="${V2_BRANCH:-main}"
V2_PATH_ARG="${V2_PATH:-}"

MODE=diff
ONLY_SKILL=
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE=apply; shift ;;
    --diff)  MODE=diff;  shift ;;
    --skill) ONLY_SKILL="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,21p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [ -n "$V2_PATH_ARG" ]; then
  V2_DIR="$V2_PATH_ARG"
  echo "[sync] using local v2 checkout: $V2_DIR"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "[sync] cloning $V2_REPO#$V2_BRANCH into $TMP/v2"
  git clone --branch "$V2_BRANCH" --depth 1 "$V2_REPO" "$TMP/v2" >/dev/null 2>&1
  V2_DIR="$TMP/v2"
fi

if [ ! -d "$V2_DIR/container/skills" ]; then
  echo "[sync] $V2_DIR/container/skills not found — wrong path or branch?" >&2
  exit 1
fi

cd "$REPO_ROOT"

EXIT_CODE=0
for v2_skill_dir in "$V2_DIR"/container/skills/*/; do
  name="$(basename "$v2_skill_dir")"
  if [ -n "$ONLY_SKILL" ] && [ "$name" != "$ONLY_SKILL" ]; then
    continue
  fi

  local_dir="container/skills/$name"

  if [ ! -d "$local_dir" ]; then
    echo "[sync] $name: not bundled in nanotars (skipping; use --apply --skill $name to add)"
    if [ "$MODE" = "apply" ] && [ "$ONLY_SKILL" = "$name" ]; then
      mkdir -p "$local_dir"
      rsync -a "$v2_skill_dir" "$local_dir/"
      echo "[sync] $name: copied"
    fi
    continue
  fi

  if [ "$MODE" = "diff" ]; then
    echo
    echo "=== $name ==="
    if diff -ruN "$local_dir" "$v2_skill_dir" >/dev/null 2>&1; then
      echo "  (no changes)"
    else
      diff -ruN "$local_dir" "$v2_skill_dir" || true
      EXIT_CODE=1
    fi
  else
    rsync -a --delete "$v2_skill_dir" "$local_dir/"
    echo "[sync] $name: applied"
  fi
done

if [ "$MODE" = "diff" ] && [ "$EXIT_CODE" = "1" ]; then
  echo
  echo "[sync] differences found — re-run with --apply to merge in (review carefully;"
  echo "       v1-specific adaptations may need to be re-applied to the new content)."
fi

exit "$EXIT_CODE"
