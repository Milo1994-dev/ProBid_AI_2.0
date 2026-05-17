import { pool } from "../../db.js";
import { log } from "../../lib/logger.js";

export async function migrateReviewsTable(): Promise<void> {
  try {
    const colCheck = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'reviews' AND column_name = 'user_id'
    `);
    if (colCheck.rows.length === 0) return;
    const currentType = colCheck.rows[0].data_type;
    if (currentType === 'text') return;

    log("info", "Migrating reviews table: fixing column types");
    const rowCount = await pool.query("SELECT COUNT(*) as c FROM reviews");
    const rows = parseInt(rowCount.rows[0].c, 10);
    if (rows > 0) {
      log("warn", "Reviews table has data, skipping destructive migration", { rows });
      return;
    }
    await pool.query("DROP TABLE IF EXISTS reviews CASCADE");
    await pool.query(`
      CREATE TABLE reviews (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        user_name TEXT,
        user_trade TEXT,
        rating INTEGER NOT NULL,
        comment TEXT,
        approved BOOLEAN DEFAULT false,
        hidden BOOLEAN DEFAULT false,
        created_at BIGINT NOT NULL
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_reviews_approved ON reviews(approved)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at)");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user_unique ON reviews(user_id)");
    log("info", "Reviews table migrated successfully");
  } catch (e) {
    log("warn", "Reviews table migration failed (non-fatal)", { error: String(e) });
  }
}
