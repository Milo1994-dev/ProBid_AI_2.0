-- Task: Speed up trust-badge click counts on the history page and per-estimate detail page.
-- Adds a denormalized "guarantee_badge_clicks" table populated alongside the existing
-- "guarantee_badge_click" analytics rows. This lets contractor-facing reads aggregate
-- via an indexed SQL GROUP BY instead of scanning the entire analytics table and
-- JSON-parsing every row in Node.
-- Idempotent (IF NOT EXISTS) so re-running the migration is safe on both fresh and
-- already-deployed databases. The backfill is gated on a one-time sentinel check so
-- repeated startups don't re-insert duplicates.

CREATE TABLE IF NOT EXISTS "guarantee_badge_clicks" (
  "id" serial PRIMARY KEY,
  "estimate_id" text NOT NULL,
  "utm_content" text,
  "user_id" text,
  "created_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_guarantee_badge_clicks_estimate" ON "guarantee_badge_clicks" ("estimate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guarantee_badge_clicks_estimate_utm" ON "guarantee_badge_clicks" ("estimate_id", "utm_content");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guarantee_badge_clicks_created" ON "guarantee_badge_clicks" ("created_at");--> statement-breakpoint

-- One-shot backfill from the existing analytics history. Only runs when the
-- target table is empty so subsequent boots (or a re-run after a partial failure
-- followed by manual recovery) don't double-count clicks. The per-row EXCEPTION
-- block keeps a single malformed `analytics.data` value (invalid JSON) from
-- aborting the whole migration — such rows are simply skipped.
DO $$
DECLARE
  r record;
  parsed jsonb;
  eid text;
BEGIN
  IF EXISTS (SELECT 1 FROM "guarantee_badge_clicks" LIMIT 1) THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT "data", "user_id", "created_at"
    FROM "analytics"
    WHERE "event" = 'guarantee_badge_click'
      AND "data" IS NOT NULL
      AND "data" <> ''
  LOOP
    BEGIN
      parsed := r."data"::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
    eid := parsed ->> 'estimate_id';
    IF eid IS NULL THEN
      CONTINUE;
    END IF;
    INSERT INTO "guarantee_badge_clicks" ("estimate_id", "utm_content", "user_id", "created_at")
    VALUES (eid, parsed ->> 'utm_content', r."user_id", r."created_at");
  END LOOP;
END $$;
