#!/usr/bin/env bash
# Compatibility wrapper. The setup probe now lives in the TS CLI.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$PROJECT_ROOT/dist/cli/nanotars.js" ] && command -v node >/dev/null 2>&1; then
  exec node "$PROJECT_ROOT/dist/cli/nanotars.js" service probe
fi

echo "node:                 missing or TS CLI not built"
exit 1
