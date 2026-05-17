import { pool } from "../../db.js";

/**
 * Bootstrap the sdk_allowed_origins table on startup.
 *
 * Schema kept in sync with `sdkAllowedOrigins` in `shared/schema.ts`.
 * `db:push` would also produce this, but the project bootstraps
 * runtime-required tables here so a fresh deploy boots without
 * a separate migration step (matches the pattern used in
 * server/db/init/outreach-state.ts).
 */
export async function initSdkAllowlistTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdk_allowed_origins (
      id SERIAL PRIMARY KEY,
      origin TEXT NOT NULL,
      kind TEXT NOT NULL,
      note TEXT,
      created_at BIGINT NOT NULL,
      created_by TEXT,
      revoked_at BIGINT,
      revoked_by TEXT
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sdk_allowed_origins_origin ON sdk_allowed_origins(origin)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sdk_allowed_origins_revoked ON sdk_allowed_origins(revoked_at)`,
  );
}
