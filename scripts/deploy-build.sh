#!/usr/bin/env bash
set -euo pipefail

# Schema is now applied at server startup via drizzle-orm's programmatic
# migrate() (see server/db/migrate.ts). This build script only needs to install,
# bundle, and run the legacy db-prepare pre-flight (which handles renamed
# constraints / column-type fixes from the pre-migrate era).

echo "[deploy-build] step 1/3: install dependencies"
npm install

echo "[deploy-build] step 2/3: build server + client bundles"
npm run build:all

echo "[deploy-build] step 3/3: prepare database (legacy pre-flight, idempotent)"
node scripts/db-prepare.mjs

# Best-effort sitemap ping to Google + Bing. Failures are non-fatal — we never
# want a search-engine ping problem to fail a production deploy.
echo "[deploy-build] post: ping search engines with sitemap"
node scripts/ping-sitemap.mjs || true

echo "[deploy-build] done"
