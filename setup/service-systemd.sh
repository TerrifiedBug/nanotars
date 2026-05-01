#!/usr/bin/env bash
# Compatibility wrapper. Service generation now lives in the TS CLI.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$PROJECT_ROOT/dist/cli/nanotars.js" service install
