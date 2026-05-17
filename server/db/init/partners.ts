import { pool } from "../../db.js";
import { log } from "../../lib/logger.js";

export async function initPartnersSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        primary_user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'active',
        rate_limit_override INTEGER,
        notes TEXT,
        created_at BIGINT NOT NULL,
        created_by TEXT,
        updated_at BIGINT NOT NULL
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_partners_user ON partners(primary_user_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status)`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS partner_usage (
        id SERIAL PRIMARY KEY,
        partner_id TEXT NOT NULL REFERENCES partners(id),
        api_key_id TEXT,
        day_key TEXT NOT NULL,
        estimates_sdk INTEGER NOT NULL DEFAULT 0,
        estimates_api INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        rate_limit_hits INTEGER NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_partner_usage_partner ON partner_usage(partner_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_partner_usage_day ON partner_usage(day_key)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_usage_partner_key_day ON partner_usage(partner_id, COALESCE(api_key_id, ''), day_key)`,
    );

    await client.query(
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS partner_id TEXT`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_api_keys_partner ON api_keys(partner_id)`,
    );

    await client.query(
      `ALTER TABLE sdk_allowed_origins ADD COLUMN IF NOT EXISTS partner_id TEXT`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_sdk_allowed_origins_partner ON sdk_allowed_origins(partner_id)`,
    );

    await client.query(
      `DROP INDEX IF EXISTS idx_sdk_allowed_origins_origin`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_sdk_allowed_origins_origin_partner ON sdk_allowed_origins(origin, COALESCE(partner_id, ''))`,
    );

    await client.query(
      `INSERT INTO partners (id, company_name, primary_user_id, status, created_at, updated_at)
       SELECT
         gen_random_uuid()::text,
         COALESCE(NULLIF(u.email, ''), u.id),
         u.id,
         'active',
         (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
         (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM api_keys ak
         WHERE ak.user_id = u.id AND ak.revoked_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM partners p WHERE p.primary_user_id = u.id
       )`,
    );

    await client.query(
      `UPDATE api_keys ak
       SET partner_id = p.id
       FROM partners p
       WHERE p.primary_user_id = ak.user_id
         AND ak.revoked_at IS NULL
         AND ak.partner_id IS NULL`,
    );

    log("info", "[partners] Partner schema initialized");
  } catch (err) {
    log("error", "[partners] Failed to initialize partner schema", { error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}
