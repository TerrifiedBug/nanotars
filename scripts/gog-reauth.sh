#!/usr/bin/env bash
# Re-authenticate gog CLI on a headless server.
# Usage: ./scripts/gog-reauth.sh [email] [--services calendar,gmail]
#        ./scripts/gog-reauth.sh --check     # check which accounts need reauth
#        ./scripts/gog-reauth.sh --all       # reauth all expired accounts
#
# Discovers all GOG accounts across group .env files, tests each one,
# and re-authenticates expired tokens via expect (headless OAuth flow).

set -euo pipefail
cd "$(dirname "$0")/.."

# --- Account Discovery ---

# Find all unique GOG accounts and their keyring passwords
discover_accounts() {
  declare -gA ACCOUNTS      # email -> env file
  declare -gA ACCOUNT_KEYS  # email -> keyring password

  for f in groups/*/.env .env; do
    [ -f "$f" ] || continue
    local acct=$(grep "^GOG_ACCOUNT=" "$f" 2>/dev/null | head -1 | cut -d'=' -f2 || true)
    [ -z "$acct" ] && continue
    ACCOUNTS["$acct"]="$f"
    # Find keyring password: same file first, then any file
    local kp=$(grep "^GOG_KEYRING_PASSWORD=" "$f" 2>/dev/null | head -1 | cut -d'=' -f2 || true)
    if [ -z "$kp" ]; then
      for kf in groups/*/.env .env; do
        kp=$(grep "^GOG_KEYRING_PASSWORD=" "$kf" 2>/dev/null | head -1 | cut -d'=' -f2 || true)
        [ -n "$kp" ] && break
      done
    fi
    ACCOUNT_KEYS["$acct"]="$kp"
  done
}

# Test if an account's OAuth token is valid
check_account() {
  local email="$1"
  local kp="${ACCOUNT_KEYS[$email]}"
  GOG_KEYRING_PASSWORD="$kp" gog calendar calendars --account "$email" >/dev/null 2>&1
}

# --- Health Check Mode ---

if [ "${1:-}" = "--check" ]; then
  discover_accounts
  if [ ${#ACCOUNTS[@]} -eq 0 ]; then
    echo "No GOG accounts configured."
    exit 0
  fi
  echo "Checking ${#ACCOUNTS[@]} Google account(s)..."
  echo ""
  expired=0
  for acct in "${!ACCOUNTS[@]}"; do
    if check_account "$acct"; then
      echo "  ✓ $acct (${ACCOUNTS[$acct]})"
    else
      echo "  ✗ $acct (${ACCOUNTS[$acct]}) — token expired"
      expired=$((expired+1))
    fi
  done
  echo ""
  if [ $expired -eq 0 ]; then
    echo "All accounts healthy."
  else
    echo "$expired account(s) need re-authentication."
    echo "Run: $0 --all    (reauth all expired)"
    echo "  or: $0 <email>  (reauth specific account)"
  fi
  exit $expired
fi

# --- Reauth Functions ---

# Determine services to request
get_services() {
  local svc="${2:-}"
  if [ -z "$svc" ]; then
    if [ -d plugins/gmail ]; then
      echo "calendar,gmail"
    else
      echo "calendar"
    fi
  else
    echo "$svc"
  fi
}

# Run the OAuth flow for a single account
reauth_account() {
  local email="$1"
  local services="$2"
  local kp="${ACCOUNT_KEYS[$email]}"

  export GOG_KEYRING_PASSWORD="$kp"
  echo "Re-authenticating: $email (services: $services)"
  echo ""

  # Temp files
  local state_file=$(mktemp)
  local redirect_file=$(mktemp)
  rm -f "$redirect_file"

  # Write expect script
  local expect_script=$(mktemp)
  cat > "$expect_script" << 'EXPECT_EOF'
#!/usr/bin/expect -f
set timeout 300
set email [lindex $argv 0]
set services [lindex $argv 1]
set state_file [lindex $argv 2]
set redirect_file [lindex $argv 3]

spawn gog auth add $email --manual --services=$services --force-consent

expect -re {state=([^\s&]+)}
set state $expect_out(1,string)

set f [open $state_file w]
puts $f $state
close $f

expect "Paste redirect URL"

set waited 0
while {![file exists $redirect_file]} {
    sleep 1
    incr waited
    if {$waited > 300} {
        puts "\nTimeout waiting for redirect URL"
        exit 1
    }
}
after 200

set rf [open $redirect_file r]
set url [gets $rf]
close $rf

send "$url\r"
expect eof

lassign [wait] pid spawnid os_error value
exit $value
EXPECT_EOF
  chmod +x "$expect_script"

  # Run expect in background
  "$expect_script" "$email" "$services" "$state_file" "$redirect_file" &
  local expect_pid=$!

  # Wait for state file
  for i in $(seq 1 15); do
    [ -s "$state_file" ] && break
    sleep 1
  done

  if [ ! -s "$state_file" ]; then
    echo "ERROR: Failed to capture OAuth state"
    kill $expect_pid 2>/dev/null
    rm -f "$state_file" "$expect_script"
    return 1
  fi

  local state=$(cat "$state_file")
  echo "========================================="
  echo "Open this URL in your browser:"
  echo ""
  echo "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=882631139668-t9h46svk6kr56jgj3sm2eo4s51ufdq3v.apps.googleusercontent.com&include_granted_scopes=true&prompt=consent&redirect_uri=http%3A%2F%2Flocalhost%3A1&response_type=code&scope=email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+openid&state=$state"
  echo ""
  echo "After authorizing, paste the redirect URL below:"
  echo "========================================="
  echo ""
  read -r redirect_url

  echo "$redirect_url" > "$redirect_file"

  wait $expect_pid
  local result=$?

  rm -f "$state_file" "$redirect_file" "$expect_script"

  if [ $result -ne 0 ]; then
    echo ""
    echo "ERROR: Authentication failed for $email (exit code $result)"
    return 1
  fi

  echo ""
  echo "✓ $email authenticated successfully"
  return 0
}

# --- Main ---

discover_accounts

if [ ${#ACCOUNTS[@]} -eq 0 ]; then
  echo "ERROR: No GOG_ACCOUNT found in any groups/*/.env or .env"
  echo "Usage: $0 <email> [services]"
  exit 1
fi

SERVICES=$(get_services "$@")

# --all mode: check each account and reauth expired ones
if [ "${1:-}" = "--all" ]; then
  echo "Checking all accounts..."
  expired_accounts=()
  for acct in "${!ACCOUNTS[@]}"; do
    if check_account "$acct"; then
      echo "  ✓ $acct — OK, skipping"
    else
      echo "  ✗ $acct — expired, will reauth"
      expired_accounts+=("$acct")
    fi
  done

  if [ ${#expired_accounts[@]} -eq 0 ]; then
    echo ""
    echo "All accounts healthy. Nothing to do."
    exit 0
  fi

  echo ""
  echo "${#expired_accounts[@]} account(s) to re-authenticate."
  echo ""

  for acct in "${expired_accounts[@]}"; do
    reauth_account "$acct" "$SERVICES" || true
    echo ""
  done

  # Sync and verify
  echo "Syncing credentials to container mount..."
  mkdir -p data/gogcli
  cp -r ~/.config/gogcli/* data/gogcli/
  chown -R 1000:1000 data/gogcli/

  echo ""
  echo "Final verification:"
  for acct in "${expired_accounts[@]}"; do
    if check_account "$acct"; then
      echo "  ✓ $acct"
    else
      echo "  ✗ $acct — still failing"
    fi
  done
  exit 0
fi

# Single account mode
EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
  if [ ${#ACCOUNTS[@]} -eq 1 ]; then
    EMAIL="${!ACCOUNTS[@]}"
  else
    # Check which are expired
    echo "Checking accounts..."
    expired_accounts=()
    for acct in "${!ACCOUNTS[@]}"; do
      if check_account "$acct"; then
        echo "  ✓ $acct — OK"
      else
        echo "  ✗ $acct — expired"
        expired_accounts+=("$acct")
      fi
    done
    echo ""

    if [ ${#expired_accounts[@]} -eq 0 ]; then
      echo "All accounts healthy. Nothing to do."
      exit 0
    elif [ ${#expired_accounts[@]} -eq 1 ]; then
      EMAIL="${expired_accounts[0]}"
      echo "Re-authenticating the one expired account..."
    else
      echo "Multiple expired accounts. Choose one:"
      i=1
      for acct in "${expired_accounts[@]}"; do
        echo "  $i) $acct (${ACCOUNTS[$acct]})"
        i=$((i+1))
      done
      echo "  a) All expired accounts"
      echo ""
      read -rp "Choice: " choice
      if [ "$choice" = "a" ] || [ "$choice" = "A" ]; then
        for acct in "${expired_accounts[@]}"; do
          reauth_account "$acct" "$SERVICES" || true
          echo ""
        done
        echo "Syncing credentials to container mount..."
        mkdir -p data/gogcli
        cp -r ~/.config/gogcli/* data/gogcli/
        chown -R 1000:1000 data/gogcli/
        echo "Done."
        exit 0
      fi
      i=1
      for acct in "${expired_accounts[@]}"; do
        [ "$i" -eq "$choice" ] && EMAIL="$acct" && break
        i=$((i+1))
      done
    fi
  fi
fi

# Validate email
if [ -z "$EMAIL" ]; then
  echo "ERROR: No account selected"
  exit 1
fi
if [ -z "${ACCOUNTS[$EMAIL]+x}" ]; then
  # Email via argument — try to find it
  for f in groups/*/.env .env; do
    if grep -q "^GOG_ACCOUNT=$EMAIL" "$f" 2>/dev/null; then
      ACCOUNTS["$EMAIL"]="$f"
      local kp=$(grep "^GOG_KEYRING_PASSWORD=" "$f" 2>/dev/null | head -1 | cut -d'=' -f2 || true)
      ACCOUNT_KEYS["$EMAIL"]="$kp"
      break
    fi
  done
  if [ -z "${ACCOUNTS[$EMAIL]+x}" ]; then
    echo "ERROR: Account '$EMAIL' not found in any .env file"
    exit 1
  fi
fi

reauth_account "$EMAIL" "$SERVICES"

echo ""
echo "Syncing credentials to container mount..."
mkdir -p data/gogcli
cp -r ~/.config/gogcli/* data/gogcli/
chown -R 1000:1000 data/gogcli/
echo "Done."

echo ""
echo "Verifying..."
GOG_KEYRING_PASSWORD="${ACCOUNT_KEYS[$EMAIL]}" gog calendar calendars --account "$EMAIL" 2>&1
