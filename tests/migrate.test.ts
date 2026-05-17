import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import pg from "pg";

// --------------------------------------------------------------------------
// Migration baseline + idempotency spec.
//
// `server/db/migrate.ts` is the single thing standing between every future
// deploy and a "table already exists" / data-destroying disaster. The custom
// baseline insert + the choice to skip baseline on a truly empty DB have
// zero coverage from the rest of the suite — this file exercises all three
// branches against a real (throwaway) Postgres database.
//
// Each test:
//   1. CREATE DATABASE migrate_test_<rand> on the local Postgres.
//   2. Point process.env.DATABASE_URL at it and `vi.resetModules()` so the
//      pool/db singletons in `server/db.ts` are rebuilt against the throwaway DB.
//   3. Dynamically import `runMigrations` and exercise the scenario.
//   4. End the pool, terminate stragglers, DROP DATABASE.
//
// CI / environment requirement: DATABASE_URL must point at a Postgres role
// that can connect to the default `postgres` admin DB AND has CREATE
// DATABASE + pg_terminate_backend privileges (i.e. a local/dev Postgres or
// a dedicated test instance — NOT a least-privileged production role). The
// post-merge environment in this repo provides a local Postgres (see
// scripts/post-merge.sh and scripts/smoke.sh), which satisfies this.
// --------------------------------------------------------------------------

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

function adminUrl(): string {
  if (!ORIGINAL_DB_URL) throw new Error("DATABASE_URL must be set to run migrate.test.ts");
  const u = new URL(ORIGINAL_DB_URL);
  u.pathname = "/postgres";
  return u.toString();
}

function dbUrlFor(name: string): string {
  const u = new URL(ORIGINAL_DB_URL!);
  u.pathname = "/" + name;
  return u.toString();
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let testDbName: string;

beforeEach(async () => {
  testDbName = `migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await withAdmin(async (c) => {
    await c.query(`CREATE DATABASE "${testDbName}"`);
  });
  process.env.DATABASE_URL = dbUrlFor(testDbName);
  vi.resetModules();
});

afterEach(async () => {
  // Close the test's pool so we can drop the DB without "is being accessed
  // by other users" errors. Pool may not have been imported if a test
  // failed early, hence the try/catch.
  try {
    const dbMod = await import("../server/db.js");
    if (dbMod.pool) await dbMod.pool.end();
  } catch {
    /* ignore */
  }
  process.env.DATABASE_URL = ORIGINAL_DB_URL;
  await withAdmin(async (c) => {
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await c.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
  });
  vi.resetModules();
});

async function seedExistingSchema(): Promise<void> {
  // Replay the 0000_initial snapshot directly so the test DB looks like a
  // pre-migrate-era production database (tables present, no
  // drizzle.__drizzle_migrations).
  const sqlText = fs.readFileSync("migrations/0000_initial.sql", "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.query(trimmed);
    }
  } finally {
    await client.end();
  }
}

async function tableExists(client: pg.PoolClient | pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function migrationsTableExists(client: pg.PoolClient | pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations' LIMIT 1`,
  );
  return (r.rowCount ?? 0) > 0;
}

async function migrationRows(client: pg.PoolClient | pg.Client): Promise<Array<{ hash: string; created_at: string }>> {
  const r = await client.query(
    `SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id`,
  );
  return r.rows as Array<{ hash: string; created_at: string }>;
}

describe("runMigrations() — baseline + idempotency", () => {
  it("baselines an existing DB (app tables present, no __drizzle_migrations) and applies later migrations without re-running 0000_initial", async () => {
    await seedExistingSchema();

    // Insert a sentinel row into one of the existing tables. If runMigrations
    // wrongly re-applied 0000_initial (which would CREATE TABLE on an
    // existing relation), Postgres would either error out or — worse, in a
    // hypothetical DROP+CREATE refactor — silently lose this row. Surviving
    // the migration proves no DDL touched it.
    const seed = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await seed.connect();
    try {
      await seed.query(
        `INSERT INTO users (id, created_at) VALUES ('sentinel-user', 1700000000000)`,
      );
    } finally {
      await seed.end();
    }

    const { runMigrations } = await import("../server/db/migrate.js");
    await runMigrations();

    const { pool } = await import("../server/db.js");
    expect(pool).not.toBeNull();
    const client = await pool!.connect();
    try {
      // baseline + drizzle's migrate() together should leave one row per
      // on-disk journal entry (currently 3: 0000_initial baselined + 0001
      // and 0002 applied normally).
      const journal = JSON.parse(fs.readFileSync("migrations/meta/_journal.json", "utf8"));
      const expectedRows = journal.entries.length;
      const rows = await migrationRows(client);
      expect(rows.length).toBe(expectedRows);

      // The first row is the baseline insert and must hash to the on-disk
      // 0000_initial.sql — that's the contract that lets drizzle's migrate()
      // skip re-running the initial snapshot.
      const initialSql = fs.readFileSync("migrations/0000_initial.sql", "utf8");
      const expectedHash = (await import("crypto"))
        .createHash("sha256")
        .update(initialSql)
        .digest("hex");
      expect(rows[0].hash).toBe(expectedHash);

      // Sentinel row survived → no CREATE TABLE was re-run on `users`.
      const sentinel = await client.query(`SELECT id FROM users WHERE id = 'sentinel-user'`);
      expect(sentinel.rowCount).toBe(1);

      // 0001 added `estimates.status` — verify it actually ran on top of the
      // baselined schema (this is the regression that `MIGRATIONS_BASELINE_TAG
      // = 0000_initial` exists to prevent: baselining the WHOLE journal would
      // skip this column).
      const statusCol = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='estimates' AND column_name='status'`,
      );
      expect(statusCol.rowCount).toBe(1);
    } finally {
      client.release();
    }
  });

  it("is a no-op on a second invocation against an already-migrated DB", async () => {
    await seedExistingSchema();

    const { runMigrations } = await import("../server/db/migrate.js");
    await runMigrations();

    const { pool } = await import("../server/db.js");
    const c1 = await pool!.connect();
    let beforeRows: Array<{ hash: string; created_at: string }>;
    try {
      beforeRows = await migrationRows(c1);
    } finally {
      c1.release();
    }
    expect(beforeRows.length).toBeGreaterThan(0);

    // Second invocation must not throw and must not insert any new rows.
    await expect(runMigrations()).resolves.toBeUndefined();

    const c2 = await pool!.connect();
    try {
      const afterRows = await migrationRows(c2);
      expect(afterRows.length).toBe(beforeRows.length);
      expect(afterRows.map((r) => r.hash)).toEqual(beforeRows.map((r) => r.hash));
    } finally {
      c2.release();
    }
  });

  it("skips baseline on a truly empty DB and applies all migrations from scratch", async () => {
    // No seedExistingSchema() — the test DB is completely empty.
    const { runMigrations } = await import("../server/db/migrate.js");
    await runMigrations();

    const { pool } = await import("../server/db.js");
    const client = await pool!.connect();
    try {
      // The migrations themselves must have created the schema — proves
      // baseline was correctly skipped (a wrong baseline would mark
      // 0000_initial as already-applied and `users` would never exist).
      expect(await tableExists(client, "users")).toBe(true);
      expect(await tableExists(client, "estimates")).toBe(true);
      expect(await migrationsTableExists(client)).toBe(true);

      const journal = JSON.parse(fs.readFileSync("migrations/meta/_journal.json", "utf8"));
      const rows = await migrationRows(client);
      expect(rows.length).toBe(journal.entries.length);

      // 0001's column is also present (proves migrate() ran the full chain,
      // not just 0000_initial).
      const statusCol = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='estimates' AND column_name='status'`,
      );
      expect(statusCol.rowCount).toBe(1);
    } finally {
      client.release();
    }
  });
});
