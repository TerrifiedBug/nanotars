#!/usr/bin/env bash
# setup/__tests__/platform.test.sh — unit test for setup/lib/platform.sh.
# Mocks `uname` via a temporary shim on PATH; mocks /proc/version by setting
# a sentinel via custom probe (not /proc itself, which we can't write to).
#
# Run with: bash setup/__tests__/platform.test.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$PROJECT_ROOT/setup/lib/platform.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

assert_eq() {
  local name=$1 want=$2 got=$3
  if [ "$want" = "$got" ]; then
    printf '  PASS  %s (got=%s)\n' "$name" "$got"
    PASS=$((PASS+1))
  else
    printf '  FAIL  %s (want=%s got=%s)\n' "$name" "$want" "$got"
    FAIL=$((FAIL+1))
  fi
}

# Build a uname shim that prints whatever we set in $UNAME_S / $UNAME_M.
make_uname_shim() {
  local dir=$1
  mkdir -p "$dir"
  cat > "$dir/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "${UNAME_S:-Linux}" ;;
  -m) echo "${UNAME_M:-x86_64}" ;;
  *)  echo "${UNAME_S:-Linux}" ;;
esac
EOF
  chmod +x "$dir/uname"
}

run_case() {
  # args: <name> <expected_platform> <uname_s> <uname_m> <expected_arch>
  local name=$1 expected_platform=$2 uname_s=$3 uname_m=$4 expected_arch=$5
  local shim_dir="$TMP/$name"
  make_uname_shim "$shim_dir"
  PATH="$shim_dir:$PATH" UNAME_S="$uname_s" UNAME_M="$uname_m" bash -c "
    source '$LIB'
    echo \"PLATFORM=\$PLATFORM\"
    echo \"ARCH=\$ARCH\"
  " > "$TMP/$name.out"

  local got_platform got_arch
  got_platform="$(grep '^PLATFORM=' "$TMP/$name.out" | cut -d= -f2)"
  got_arch="$(grep '^ARCH=' "$TMP/$name.out" | cut -d= -f2)"
  assert_eq "$name PLATFORM" "$expected_platform" "$got_platform"
  assert_eq "$name ARCH" "$expected_arch" "$got_arch"
}

echo "Running platform.test.sh"
echo

run_case "macos_arm64"  "macos"   "Darwin" "arm64"  "arm64"
run_case "macos_x86"    "macos"   "Darwin" "x86_64" "x86_64"
run_case "linux_x86"    "linux"   "Linux"  "x86_64" "x86_64"
run_case "linux_arm64"  "linux"   "Linux"  "aarch64" "arm64"
run_case "freebsd_x86"  "unknown" "FreeBSD" "x86_64" "x86_64"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
