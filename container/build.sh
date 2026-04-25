#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

# Auto-detect container runtime (Docker preferred, Apple Container fallback)
if docker info >/dev/null 2>&1; then
  CLI="docker"
elif container system status >/dev/null 2>&1; then
  CLI="container"
else
  echo "Error: No container runtime found."
  echo "Install Docker (https://docs.docker.com/get-docker/)"
  echo "or Apple Container (https://github.com/apple/container/releases)."
  exit 1
fi

# Collect plugin Dockerfile.partial files (validate each path resolves inside PROJECT_DIR)
PARTIALS=()
for f in plugins/*/Dockerfile.partial plugins/*/*/Dockerfile.partial; do
  [ -f "$f" ] || continue
  # Resolve the real path (follows symlinks) and ensure it stays under PROJECT_DIR.
  REAL="$(readlink -f "$f")"
  case "$REAL" in
    "$PROJECT_DIR"/*) PARTIALS+=("$f") ;;
    *) echo "Error: Dockerfile.partial '$f' escapes project root (resolves to '$REAL')"; exit 1 ;;
  esac
done

DOCKERFILE="container/Dockerfile"

if [ ${#PARTIALS[@]} -gt 0 ]; then
  echo "Found ${#PARTIALS[@]} plugin Dockerfile.partial file(s):"
  for f in "${PARTIALS[@]}"; do echo "  - $f"; done

  # Generate combined Dockerfile
  COMBINED=$(mktemp /tmp/Dockerfile.combined.XXXXXX)
  trap "rm -f $COMBINED" EXIT

  # Split base Dockerfile at "USER node" line
  BEFORE_USER=$(sed '/^USER node/,$d' "$DOCKERFILE")
  FROM_USER=$(sed -n '/^USER node/,$p' "$DOCKERFILE")

  echo "$BEFORE_USER" > "$COMBINED"
  echo "" >> "$COMBINED"

  # Append each plugin partial
  for f in "${PARTIALS[@]}"; do
    PLUGIN_NAME=$(echo "$f" | sed 's|plugins/||; s|/Dockerfile.partial||')
    echo "# --- Plugin: $PLUGIN_NAME ---" >> "$COMBINED"
    cat "$f" >> "$COMBINED"
    echo "" >> "$COMBINED"
  done

  echo "$FROM_USER" >> "$COMBINED"

  DOCKERFILE="$COMBINED"
  echo ""
fi

echo "Building NanoClaw agent container image..."
echo "Runtime: ${CLI}"
echo "Image: ${IMAGE_NAME}:${TAG}"

$CLI build -f "$DOCKERFILE" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | $CLI run -i ${IMAGE_NAME}:${TAG}"
