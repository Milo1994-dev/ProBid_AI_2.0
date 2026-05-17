-- Task: Daily MRR snapshots for investor metrics dashboard.
-- Stores one row per day capturing revenue, customer counts, and churn data.
-- Idempotent (IF NOT EXISTS) so it is safe on both new and existing databases.

CREATE TABLE IF NOT EXISTS "mrr_snapshots" (
  "id" serial PRIMARY KEY,
  "day_key" text NOT NULL,
  "mrr" integer NOT NULL,
  "arr" integer NOT NULL,
  "paying_customers" integer NOT NULL,
  "pro_monthly" integer NOT NULL DEFAULT 0,
  "pro_annual" integer NOT NULL DEFAULT 0,
  "biz_monthly" integer NOT NULL DEFAULT 0,
  "biz_annual" integer NOT NULL DEFAULT 0,
  "canceled_last_30" integer NOT NULL DEFAULT 0,
  "created_at" bigint NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_mrr_snapshots_day" ON "mrr_snapshots" ("day_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mrr_snapshots_created" ON "mrr_snapshots" ("created_at");
