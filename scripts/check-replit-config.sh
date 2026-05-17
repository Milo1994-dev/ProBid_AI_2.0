#!/bin/bash
# scripts/check-replit-config.sh — guards against accidental secret leaks
# in tracked configuration files. Added as part of Task #109 ("Replit
# config hardening") to prevent the class of incident that required
# rotating four production keys.
#
# What it enforces:
#   1. `.replit` userenv contains ONLY allowlisted public keys.
#      Allowlist (case-sensitive): APP_URL, PORT, STRIPE_PRICE_PRO_MONTHLY,
#      STRIPE_PRICE_PRO_ANNUAL, STRIPE_PRICE_BUSINESS_MONTHLY,
#      STRIPE_PRICE_BUSINESS_ANNUAL.
#      Anything else (e.g. STRIPE_WEBHOOK_SECRET, RESEND_API_KEY,
#      GOOGLE_PLACES_API_KEY, ADMIN_KEY, SESSION_SECRET) belongs in the
#      Replit Secrets pane, never in this tracked file.
#   2. `.replit` does NOT contain any value matching well-known third-party
#      secret prefixes (whsec_, re_, sk_live_, sk_test_, sk_proj_,
#      AIza, ghp_, github_pat_, xoxb-, xoxp-, glpat-).
#   3. The deployment build command (`scripts/deploy-build.sh`) actually
#      builds the React client (`npm run build:all` or equivalent).
#
# Run from repo root:  bash scripts/check-replit-config.sh
# Wired into:          scripts/post-merge.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPLIT_FILE=".replit"
DEPLOY_SCRIPT="scripts/deploy-build.sh"
fail=0

if [ ! -f "$REPLIT_FILE" ]; then
  echo "[check-replit-config] FAIL: $REPLIT_FILE not found"
  exit 1
fi

# 1. Allowlist check — only these keys may appear in any [userenv.*] section
ALLOWED='^(APP_URL|PORT|STRIPE_PRICE_PRO_MONTHLY|STRIPE_PRICE_PRO_ANNUAL|STRIPE_PRICE_BUSINESS_MONTHLY|STRIPE_PRICE_BUSINESS_ANNUAL)$'

unexpected_keys="$(awk '
  /^\[userenv(\.[a-z]+)?\]/ { in_userenv = 1; next }
  /^\[/                     { in_userenv = 0 }
  in_userenv && /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
    # extract the key (everything before the first =)
    n = index($0, "="); if (n == 0) next
    key = substr($0, 1, n - 1)
    sub(/[[:space:]]+$/, "", key)
    sub(/^[[:space:]]+/, "", key)
    print key
  }
' "$REPLIT_FILE" | grep -Ev "$ALLOWED" || true)"

if [ -n "$unexpected_keys" ]; then
  echo "[check-replit-config] FAIL: $REPLIT_FILE contains non-allowlisted keys in [userenv.*]:"
  echo "$unexpected_keys" | sed 's/^/  - /'
  echo "  These belong in Replit Secrets (lock icon → Secrets), not in the tracked .replit file."
  echo "  If a value already leaked into this file, rotate it at the provider AND remove it from .replit."
  fail=1
fi

# 2. Known third-party secret prefixes anywhere in .replit
SECRET_PREFIX_RE='whsec_[A-Za-z0-9]|re_[A-Za-z0-9]|sk_live_[A-Za-z0-9]|sk_test_[A-Za-z0-9]|sk_proj_[A-Za-z0-9]|AIza[0-9A-Za-z_-]|ghp_[A-Za-z0-9]|github_pat_[A-Za-z0-9]|xox[bp]-[A-Za-z0-9]|glpat-[A-Za-z0-9]'
if grep -nE "$SECRET_PREFIX_RE" "$REPLIT_FILE" >/dev/null 2>&1; then
  echo "[check-replit-config] FAIL: $REPLIT_FILE contains values matching known secret prefixes:"
  grep -nE "$SECRET_PREFIX_RE" "$REPLIT_FILE" | sed 's/^/  /'
  echo "  Rotate the matching key at the provider immediately, move the new value to Replit Secrets, and delete it from .replit."
  fail=1
fi

# 3. Deploy build script must build the client, not just the server
if [ ! -f "$DEPLOY_SCRIPT" ]; then
  echo "[check-replit-config] FAIL: $DEPLOY_SCRIPT not found"
  fail=1
elif ! grep -qE 'npm run (build:all|build:client)' "$DEPLOY_SCRIPT"; then
  echo "[check-replit-config] FAIL: $DEPLOY_SCRIPT does not invoke 'npm run build:all' or 'npm run build:client'."
  echo "  Without this, deployments ship a stale React bundle. Restore the client build step."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "[check-replit-config] OK — .replit allowlist clean, no secret-prefix leaks, deploy build includes client."
