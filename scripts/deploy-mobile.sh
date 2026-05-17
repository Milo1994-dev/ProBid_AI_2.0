#!/usr/bin/env bash
# ProBid AI — Mobile production build script
#
# What this does:
#   1. Audits mobile/src for any leftover dev URLs (localhost / 127.0.0.1 / http://).
#   2. Verifies EAS CLI is installed and you're authenticated.
#   3. Verifies critical app.json fields are present (bundleIdentifier, package,
#      iOS usage descriptions) so Apple/Google don't reject the build.
#   4. Kicks off production builds for Android (AAB) and iOS via EAS.
#
# What this DOES NOT do:
#   - Modify app.json (bundle ID, version, plugins, permissions — leave those to
#     intentional commits).
#   - Submit to App Store / Play Store. Run `eas submit` manually after you've
#     verified the build in EAS dashboard.
#
# Prerequisites (run on your local machine or CI, not the Replit sandbox):
#   - Node 20+
#   - `npm i -g eas-cli` (or `npx eas-cli`)
#   - `eas login` (or EXPO_TOKEN env var set)
#   - Apple Developer + Google Play credentials configured in EAS (one-time)
#
# Usage:
#   ./scripts/deploy-mobile.sh                 # build both platforms
#   ./scripts/deploy-mobile.sh android         # build android only
#   ./scripts/deploy-mobile.sh ios             # build ios only

set -euo pipefail

PLATFORM="${1:-all}"
MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)/mobile"

if [ ! -d "$MOBILE_DIR" ]; then
  echo "ERROR: mobile/ directory not found at $MOBILE_DIR" >&2
  exit 1
fi

cd "$MOBILE_DIR"

echo "=== ProBid AI Mobile Deployment ==="
echo "Working dir: $MOBILE_DIR"
echo "Platform:    $PLATFORM"
echo

# ---------- 1. Dev-URL audit (warn, don't fail on http:// since some external
# image URLs may legitimately use it). Hard-fail on localhost / 127.0.0.1. ----
echo "=== [1/4] Auditing src/ for dev URLs ==="
if grep -RInE 'localhost|127\.0\.0\.1' src 2>/dev/null; then
  echo "ERROR: localhost / 127.0.0.1 found in src/. Fix before shipping." >&2
  exit 1
fi
if grep -RInE '\bhttp://[a-zA-Z0-9._-]+' src 2>/dev/null; then
  echo "WARNING: plain http:// URLs found in src/. Review the matches above." >&2
fi
echo "Audit OK."
echo

# ---------- 2. EAS CLI + auth check ----------------------------------------
echo "=== [2/4] Checking EAS CLI + auth ==="
if ! command -v eas >/dev/null 2>&1; then
  echo "ERROR: eas-cli not installed. Install with: npm i -g eas-cli" >&2
  exit 1
fi
if ! eas whoami >/dev/null 2>&1; then
  echo "ERROR: Not logged in to EAS. Run \`eas login\` or set EXPO_TOKEN." >&2
  exit 1
fi
echo "EAS user: $(eas whoami)"
echo

# ---------- 3. app.json sanity check (read-only) ---------------------------
echo "=== [3/4] Validating app.json ==="
node -e "
const app = require('./app.json');
const e = app.expo || {};
const missing = [];
if (!e.ios || !e.ios.bundleIdentifier) missing.push('expo.ios.bundleIdentifier');
if (!e.android || !e.android.package) missing.push('expo.android.package');
if (!e.ios || !e.ios.infoPlist || !e.ios.infoPlist.NSCameraUsageDescription) missing.push('expo.ios.infoPlist.NSCameraUsageDescription');
if (!e.extra || !e.extra.apiBaseUrl) missing.push('expo.extra.apiBaseUrl');
if (missing.length) {
  console.error('ERROR: app.json is missing required fields:\n  - ' + missing.join('\n  - '));
  process.exit(1);
}
console.log('app.json OK');
console.log('  name:       ' + e.name);
console.log('  version:    ' + e.version);
console.log('  iOS bundle: ' + e.ios.bundleIdentifier);
console.log('  Android:    ' + e.android.package);
console.log('  API base:   ' + e.extra.apiBaseUrl);
"
echo

# ---------- 4. Build ------------------------------------------------------
echo "=== [4/4] Triggering EAS production build ==="
case "$PLATFORM" in
  android)
    eas build --platform android --profile production --non-interactive
    ;;
  ios)
    eas build --platform ios --profile production --non-interactive
    ;;
  all)
    eas build --platform all --profile production --non-interactive
    ;;
  *)
    echo "ERROR: unknown platform '$PLATFORM' (expected: android | ios | all)" >&2
    exit 1
    ;;
esac

echo
echo "=== DONE ==="
echo "Track build progress at: https://expo.dev/accounts/<your-account>/projects/probid-ai/builds"
echo "When the build is verified, submit manually:"
echo "  eas submit --platform android   # uses mobile/eas.json submit.production.android"
echo "  eas submit --platform ios       # will prompt for Apple credentials if not cached"
