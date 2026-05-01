#!/usr/bin/env bash
# nanotars.sh — legacy compatibility shim.
# Prefer the installed `nanotars` wrapper or `node dist/cli/nanotars.js`.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$PROJECT_ROOT/dist/cli/nanotars.js"

if [ ! -f "$CLI" ]; then
  echo "nanotars.sh: $CLI missing — run 'npm run build' first." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
exec node "$CLI" "$@"
