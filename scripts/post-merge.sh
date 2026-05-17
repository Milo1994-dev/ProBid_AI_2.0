#!/bin/bash
# scripts/post-merge.sh — runs automatically after every task merge.
# Catches regressions that would otherwise only show up when the user
# tries to use the app:
#   1. dependencies install cleanly
#   2. the codebase still type-checks
#   3. the test suite passes
#   4. the server actually boots and the critical routes respond
#
# Any failure exits non-zero so the post-merge log surfaces the issue.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[post-merge] 1/5 .replit config hardening check..."
bash "$ROOT/scripts/check-replit-config.sh"

echo "[post-merge] 2/5 npm install..."
npm install --no-audit --no-fund

# Guards the esbuild@<=0.24.2 -> ^0.25.10 override added in Task #91.
# Cheap (one node + one fs read) and fires the moment a future install or
# drizzle-kit bump lets a vulnerable copy back into the tree.
echo "[post-merge] 2.5/5 esbuild override check..."
node "$ROOT/scripts/check-esbuild-override.mjs"

echo "[post-merge] 3/5 typecheck (tsc --noEmit)..."
npx tsc --noEmit

echo "[post-merge] 4/5 tests (vitest run)..."
npm test --silent

echo "[post-merge] 5/5 boot + smoke check..."
bash "$ROOT/scripts/smoke.sh"

echo "[post-merge] all checks passed."
