import fs from "fs";
import path from "path";
import crypto from "crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, isDatabaseConfigured } from "../db.js";
import { log } from "../lib/logger.js";

const MIGRATIONS_FOLDER = "./migrations";

const BASELINE_SENTINEL_TABLE = "users";

// Only the initial schema snapshot is treated as "already-present" on existing
// databases. Later migrations (0001+) carry real schema changes and MUST run
// normally even when the baseline triggers — otherwise an old DB upgrading
// from the pre-migrate era straight to a multi-migration release would
// silently skip real DDL and drift from the codebase.
const BASELINE_TAG = "0000_initial";

type JournalEntry = { idx: number; tag: string; when: number; breakpoints: boolean; version: string };

function loadJournal(): JournalEntry[] {
  const journalPath = path.join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) return [];
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  return Array.isArray(journal.entries) ? journal.entries : [];
}

function hashMigrationFile(tag: string): string {
  const sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
  return crypto.createHash("sha256").update(sql).digest("hex");
}

export async function runMigrations(): Promise<void> {
  if (!isDatabaseConfigured || !db || !pool) {
    log("info", "[migrate] DATABASE_URL not configured — skipping migrations");
    return;
  }

  const entries = loadJournal();
  if (entries.length === 0) {
    log("info", "[migrate] no migrations on disk — skipping");
    return;
  }

  // Drizzle's runtime migrator uses each entry's `when` as the
  // `created_at` value it inserts into `__drizzle_migrations`, and skips any
  // entry whose `when` is less than the max already present. If a journal
  // entry's `when` is older than the previous entry's (clock skew on the
  // machine that ran `db:generate`, e.g. system clock set to a prior year),
  // drizzle will silently no-op that migration on every fresh DB and on
  // production if it lands on a DB that already has the previous entry —
  // schema changes vanish without a single error log. Fail loudly here
  // instead so the bug is caught at startup, not via the next "column does
  // not exist" outage. We saw this exact pattern bite migrations 0009-0012.
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].when <= entries[i - 1].when) {
      throw new Error(
        `[migrate] journal entry ${entries[i].tag} has when=${entries[i].when} which is not strictly greater than the previous entry ${entries[i - 1].tag} (when=${entries[i - 1].when}). drizzle's migrator would silently skip it. Bump the \`when\` value in migrations/meta/_journal.json to be strictly monotonic (most likely cause: \`db:generate\` ran on a machine with a backwards-set system clock).`,
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const hasMigrations = await client.query(
      `SELECT 1 FROM "drizzle"."__drizzle_migrations" LIMIT 1`,
    );
    const sentinelTable = await client.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
      [BASELINE_SENTINEL_TABLE],
    );

    const baseline =
      hasMigrations.rowCount === 0 && (sentinelTable.rowCount ?? 0) > 0;

    if (baseline) {
      const initial = entries.find((e) => e.tag === BASELINE_TAG);
      if (!initial) {
        // Defensive: someone removed/renamed 0000_initial. Bail rather than
        // silently let migrate() try CREATE TABLE on an existing schema.
        throw new Error(
          `[migrate] baseline aborted: ${BASELINE_TAG} not found in journal — refusing to baseline an existing DB without a known initial snapshot`,
        );
      }
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [hashMigrationFile(initial.tag), initial.when],
      );
      log("info", "[migrate] baseline applied: existing schema marked up-to-date", {
        baselinedTag: initial.tag,
        baselinedWhen: initial.when,
        pendingAfterBaseline: entries.length - 1,
      });
    }
  } finally {
    client.release();
  }

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  log("info", "[migrate] migrations applied (or already up-to-date)");
}
