import pg from "pg";

const { Client } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[db-prepare] DATABASE_URL not set; skipping");
  process.exit(0);
}

const client = new Client({ connectionString: url });

try {
  await client.connect();

  // Strategy: keep the local DB in lock-step with prod's *legacy* state so
  // drizzle-kit pre-flight (which runs against prod before our build script
  // even gets a chance) sees zero diff. We:
  //   1) Recreate the empty `messages` table if missing (matches prod).
  //   2) Rename any `<table>_<col>_unique` constraints back to the Postgres
  //      default `<table>_<col>_key` naming that prod uses.

  // ---- 1) Ensure legacy `messages` table exists ----
  const legacyExists = await client.query(
    "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='messages'"
  );
  if (legacyExists.rowCount === 0) {
    await client.query(`
      CREATE TABLE public.messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    console.log("[db-prepare] created legacy 'messages' table to match prod");
  } else {
    console.log("[db-prepare] 'messages' table already present — ok");
  }

  // ---- 1b) Convert reviews.created_at from timestamp -> bigint (epoch ms) ----
  // Prod was originally seeded with reviews.created_at as `timestamp without
  // time zone`, but shared/schema.ts declares it as `bigint("created_at",
  // { mode: "number" })`. Drizzle's `db:push` cannot auto-cast timestamp to
  // bigint, so the deploy fails. Convert the column in-place; with or without
  // existing rows this preserves data (EXTRACT(EPOCH ...) * 1000 → ms).
  const reviewsTypeRow = await client.query(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='reviews'
        AND column_name='created_at'`
  );
  const reviewsType = reviewsTypeRow.rows[0]?.data_type;
  if (reviewsType && reviewsType.startsWith("timestamp")) {
    await client.query("BEGIN");
    try {
      await client.query(
        `ALTER TABLE public.reviews ALTER COLUMN created_at DROP DEFAULT`
      );
      await client.query(
        `ALTER TABLE public.reviews
           ALTER COLUMN created_at TYPE bigint
           USING (EXTRACT(EPOCH FROM created_at) * 1000)::bigint`
      );
      await client.query("COMMIT");
    } catch (convErr) {
      await client.query("ROLLBACK");
      throw convErr;
    }
    console.log(
      `[db-prepare] converted reviews.created_at from ${reviewsType} → bigint (epoch ms)`
    );
  } else if (reviewsType === "bigint") {
    const defaultRow = await client.query(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='reviews'
          AND column_name='created_at'`
    );
    const colDefault = defaultRow.rows[0]?.column_default;
    if (colDefault !== null && colDefault !== undefined) {
      await client.query(
        `ALTER TABLE public.reviews ALTER COLUMN created_at DROP DEFAULT`
      );
      console.log(
        `[db-prepare] dropped leftover default on reviews.created_at (was: ${colDefault})`
      );
    }
    console.log("[db-prepare] reviews.created_at already bigint — skipping");
  } else if (reviewsType) {
    console.warn(
      `[db-prepare] reviews.created_at unexpected type ${reviewsType} — leaving alone`
    );
  }

  // ---- 2) Normalize unique constraint names to legacy `_key` suffix ----
  const renames = [
    ["api_keys", "api_keys_key_hash_unique", "api_keys_key_hash_key"],
    ["lead_outreach_queue", "lead_outreach_queue_click_token_unique", "lead_outreach_queue_click_token_key"],
    ["lead_outreach_queue", "lead_outreach_queue_open_token_unique", "lead_outreach_queue_open_token_key"],
    ["lead_outreach_queue", "lead_outreach_queue_unsubscribe_token_unique", "lead_outreach_queue_unsubscribe_token_key"],
    ["scraped_leads", "scraped_leads_unsubscribe_token_unique", "scraped_leads_unsubscribe_token_key"],
  ];

  // Scope constraint lookups to (schema=public, specific table, type=unique)
  // so we never accidentally rename/drop an unrelated constraint that happens
  // to share a name in a different table.
  const findConstraint = async (table, name) =>
    client.query(
      `SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = $1
          AND c.conname = $2
          AND c.contype = 'u'`,
      [table, name]
    );

  for (const [table, oldName, newName] of renames) {
    const oldExists = await findConstraint(table, oldName);
    const newExists = await findConstraint(table, newName);

    if (newExists.rowCount > 0 && oldExists.rowCount === 0) {
      console.log(`[db-prepare] ${newName} already in place — skipping`);
      continue;
    }
    if (newExists.rowCount > 0 && oldExists.rowCount > 0) {
      // Both names exist (duplicate constraint). Drop the old one.
      await client.query(`ALTER TABLE public.${table} DROP CONSTRAINT ${oldName}`);
      console.log(`[db-prepare] dropped redundant ${oldName} (${newName} already exists)`);
      continue;
    }
    if (oldExists.rowCount === 0) {
      console.log(`[db-prepare] neither ${oldName} nor ${newName} present on ${table} — skipping`);
      continue;
    }
    await client.query(
      `ALTER TABLE public.${table} RENAME CONSTRAINT ${oldName} TO ${newName}`
    );
    console.log(`[db-prepare] renamed ${oldName} → ${newName}`);
  }
} catch (err) {
  console.error("[db-prepare] failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
