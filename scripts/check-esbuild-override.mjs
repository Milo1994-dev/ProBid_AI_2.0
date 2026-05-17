#!/usr/bin/env node
// Verifies the esbuild@<=0.24.2 -> ^0.25.10 override in package.json is still
// keeping vulnerable copies of esbuild out of the dependency tree. Walks
// package-lock.json's packages map and fails loudly if any esbuild < MIN is
// found. Wired into scripts/post-merge.sh so a regression (drizzle-kit bump,
// override edit, etc.) blocks the merge instead of waiting for the next
// `npm audit` review.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MIN = "0.25.10";

const here = dirname(fileURLToPath(import.meta.url));
const lockPath = resolve(here, "..", "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const offenders = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (!meta || typeof meta.version !== "string") continue;
  const isEsbuild = path === "node_modules/esbuild" || path.endsWith("/node_modules/esbuild");
  if (!isEsbuild) continue;
  if (cmpSemver(meta.version, MIN) < 0) offenders.push([path, meta.version]);
}

if (offenders.length > 0) {
  console.error(
    `regression: found ${offenders.length} esbuild copy/copies older than ${MIN} in package-lock.json:`,
  );
  for (const [p, v] of offenders) console.error(`  ${p}  -> ${v}`);
  console.error(
    "the version-key override (esbuild@<=0.24.2 -> ^0.25.10) in package.json may have stopped working.",
  );
  console.error("see replit.md > Dependency Security Posture for context.");
  process.exit(1);
}

console.log(`[check-esbuild-override] ok — all esbuild copies >= ${MIN}`);
