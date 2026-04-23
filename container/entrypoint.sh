#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

cat > /tmp/input.json

# Source the per-group env file if it was mounted. The host-spawn path uses
# its own `bash -c` wrapper that does the same; this branch only runs if
# the entrypoint override is removed in the future.
if [ -r /workspace/env-dir/env ]; then
  set -a
  . /workspace/env-dir/env
  set +a
fi

exec bun run /app/src/index.ts < /tmp/input.json
