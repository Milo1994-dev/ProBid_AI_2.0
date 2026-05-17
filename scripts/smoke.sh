#!/bin/bash
# scripts/smoke.sh — boot the server on an isolated port, hit the
# critical "must work" endpoints, and shut it down.  Designed to be
# run from `scripts/post-merge.sh` and from `npm run smoke`.
#
# Smoke contract (see `replit.md` → "Post-merge smoke check"):
#   GET  /api/health                     -> 200, JSON, status field present
#   GET  /api/csrf                       -> 200, JSON with csrfToken
#   POST /api/estimates/send (no auth)   -> 401, JSON {success:false,...}
#
# These three together prove: system routes load, auth routes load,
# the api-key-auth middleware loads, and the DB connection works.
# Adding a new must-work route?  Add it here AND to replit.md.

set -euo pipefail

PORT="${SMOKE_PORT:-5099}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t smoke-server.XXXXXX.log)"
BODY="$(mktemp -t smoke-body.XXXXXX)"
SERVER_PID=""

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[smoke] stopping server (pid $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    # give it a couple seconds to shut down cleanly
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG" "$BODY"
}
trap cleanup EXIT INT TERM

echo "[smoke] booting server on port ${PORT}..."
# SMOKE_MODE=1 tells server.ts + scheduler.ts to skip:
#   - all cron / interval registrations
#   - the lead-scraper startup catch-up scrape
#   - the outbound webhook retry sweeper
# so the smoke run never touches Stripe, Resend, OpenAI, Twilio, Procore,
# Google Places, or partner webhook URLs.  Set SMOKE_DATABASE_URL to point
# the smoke server at an isolated DB; otherwise it inherits the ambient
# DATABASE_URL (the same one the dev / prod server uses).
#
# Using `export` (not an inline `VAR=val cmd` prefix) because the optional
# SMOKE_DATABASE_URL needs a conditional path that bash can't express as
# an inline prefix without word-splitting the value.
export PORT="$PORT"
export NODE_ENV="${NODE_ENV:-production}"
export SMOKE_MODE=1
if [ -n "${SMOKE_DATABASE_URL:-}" ]; then
  export SMOKE_DATABASE_URL
  echo "[smoke] SMOKE_DATABASE_URL override active — server.ts will swap DATABASE_URL before db.ts loads."
fi
npm run start >"$LOG" 2>&1 &
SERVER_PID=$!

# Wait up to 90s for /api/health to respond.  The server triggers
# `npm run build:client` synchronously at startup if `client/dist`
# is missing (e.g. on a fresh post-merge install with dist/ gitignored),
# which can add ~30s to first boot.
READY=0
for i in $(seq 1 180); do
  if curl -sf -o /dev/null "$BASE/api/health"; then
    READY=1
    echo "[smoke] server up after $((i / 2))s"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[smoke] FAIL: server process died during boot."
    echo "[smoke] last 60 log lines:"
    tail -60 "$LOG"
    exit 1
  fi
  sleep 0.5
done

if [ "$READY" -ne 1 ]; then
  echo "[smoke] FAIL: /api/health did not respond within 90s."
  echo "[smoke] last 60 log lines:"
  tail -60 "$LOG"
  exit 1
fi

# ---- run the smoke checks ----
fail=0

check() {
  local label="$1"; shift
  local expect_code="$1"; shift
  local method="$1"; shift
  local path="$1"; shift
  local body="${1:-}"

  local args=(-s -o "$BODY" -w "%{http_code}" -X "$method")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  local code
  code=$(curl "${args[@]}" "${BASE}${path}" || echo "000")

  if [ "$code" = "$expect_code" ]; then
    echo "[smoke]  PASS  ${label}  (${method} ${path} -> ${code})"
  else
    echo "[smoke]  FAIL  ${label}  (${method} ${path} -> ${code}, expected ${expect_code})"
    echo "[smoke]        body: $(head -c 300 "$BODY")"
    fail=1
  fi
}

check "system: /api/health responds 200"           "200" "GET"  "/api/health"
check "auth:   /api/csrf responds 200"             "200" "GET"  "/api/csrf"
check "auth:   POST /api/estimates/send no-auth"   "401" "POST" "/api/estimates/send" "{}"

# Validate JSON shape on the auth-required check — this is the regression
# that Task #78 introduced: server crashed before responding when the
# api-key-auth middleware had missing exports.
if ! grep -q '"success":false' "$BODY" 2>/dev/null; then
  echo "[smoke]  FAIL  POST /api/estimates/send did not return {success:false,...} JSON"
  echo "[smoke]        body: $(head -c 300 "$BODY")"
  fail=1
fi

# /integrate.js is the public partner SDK served from client/dist.
# Status alone is not enough: when client/dist/integrate.js is missing,
# the SPA catch-all returns index.html (200, text/html) and the partner
# embed silently breaks.  We verify both that the route returns 200 AND
# that the body is actually the SDK (signature: ProBidCore comment header).
INTEGRATE_BODY="$(mktemp -t smoke-integrate.XXXXXX)"
INTEGRATE_HEADERS="$(mktemp -t smoke-integrate-h.XXXXXX)"
INTEGRATE_CODE="$(curl -s -o "$INTEGRATE_BODY" -D "$INTEGRATE_HEADERS" -w "%{http_code}" "${BASE}/integrate.js")"
if [ "$INTEGRATE_CODE" != "200" ]; then
  echo "[smoke]  FAIL  GET /integrate.js  (-> ${INTEGRATE_CODE}, expected 200)"
  fail=1
elif grep -qiE '^content-type:[[:space:]]*text/html' "$INTEGRATE_HEADERS"; then
  echo "[smoke]  FAIL  GET /integrate.js returned text/html (SPA fallback) — client/dist/integrate.js missing?"
  echo "[smoke]        body: $(head -c 200 "$INTEGRATE_BODY")"
  fail=1
elif ! grep -q "ProBidCore" "$INTEGRATE_BODY" 2>/dev/null; then
  echo "[smoke]  FAIL  GET /integrate.js body is missing ProBidCore signature"
  echo "[smoke]        body: $(head -c 200 "$INTEGRATE_BODY")"
  fail=1
else
  echo "[smoke]  PASS  partner: GET /integrate.js  (200, JS SDK signature present)"
fi
rm -f "$INTEGRATE_BODY" "$INTEGRATE_HEADERS"

if [ "$fail" -ne 0 ]; then
  echo "[smoke] one or more smoke checks failed.  recent server logs:"
  tail -40 "$LOG"
  exit 1
fi

echo "[smoke] all checks passed."
