-- Add aggregate_benchmarks table and include_in_public_benchmarks consent flag.
-- Idempotent: uses CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "aggregate_benchmarks" (
  "id" text PRIMARY KEY NOT NULL,
  "benchmark_type" text NOT NULL,
  "trade" text,
  "region" text,
  "sample_size" integer NOT NULL DEFAULT 0,
  "p25" real,
  "p50" real,
  "p75" real,
  "p90" real,
  "mean" real,
  "metadata" text,
  "calculated_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_aggregate_benchmarks_type" ON "aggregate_benchmarks" ("benchmark_type");
CREATE INDEX IF NOT EXISTS "idx_aggregate_benchmarks_trade" ON "aggregate_benchmarks" ("trade");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'procore_connections'
       AND column_name = 'include_in_public_benchmarks'
  ) THEN
    ALTER TABLE "procore_connections"
      ADD COLUMN "include_in_public_benchmarks" integer NOT NULL DEFAULT 0;
  END IF;
END $$;
