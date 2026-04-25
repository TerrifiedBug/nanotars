#!/bin/bash
# Test: build.sh's partial-collection rejects partials that resolve outside the project root.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set up a tmp playground project with an evil symlinked partial
TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT
mkdir -p "$TMP/plugins/evil"
ln -sf /etc/passwd "$TMP/plugins/evil/Dockerfile.partial"
mkdir -p "$TMP/container"
cp "$PROJECT_DIR/container/build.sh" "$TMP/container/build.sh"
cp "$PROJECT_DIR/container/Dockerfile" "$TMP/container/Dockerfile"

# Run build.sh from the playground. It should fail when trying to validate the partial path.
cd "$TMP"
output="$(bash container/build.sh 2>&1 || true)"

# We expect the guard to reject the partial with an error message about escaping project root.
# The error should appear before any docker build attempt.
if echo "$output" | grep -qi "escapes project root\|outside project\|invalid partial path"; then
  echo "PASS: build.sh rejected the path-escaping partial"
  exit 0
else
  # Check if /etc/passwd content leaked into the output (sign of the vulnerability)
  if echo "$output" | grep -q "root:x:0:0:root"; then
    echo "FAIL: build.sh accepted a partial that resolves to /etc/passwd"
    echo "Output snippet (first 30 lines):"
    echo "$output" | head -30
    exit 1
  else
    echo "UNKNOWN: build.sh did not obviously accept or reject the partial"
    echo "Output:"
    echo "$output"
    exit 1
  fi
fi
