-- Task: Guarantee stack infrastructure — Win-Jobs, Speed, 30-Day Money-Back guarantees.
-- Adds timing columns to estimates (for Speed Guarantee evaluation), a won/lost status
-- field (for Win-Jobs Guarantee evaluation), and the guarantee_claims table that
-- records every claim attempt with full eligibility audit trail.
-- All DDL is idempotent (IF NOT EXISTS / DO NOTHING) so it is safe on both new
-- and existing databases.

-- 1. Estimate generation timing + won/lost tracking
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "generation_started_at" bigint;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "generation_completed_at" bigint;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "won_lost_status" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "won_lost_updated_at" bigint;--> statement-breakpoint

-- 2. Guarantee claims table
CREATE TABLE IF NOT EXISTS "guarantee_claims" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "guarantee_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "eligibility_verdict" text NOT NULL DEFAULT 'pending',
  "eligibility_reasons" text,
  "resolution" text,
  "stripe_refund_id" text,
  "account_credit_cents" integer DEFAULT 0,
  "admin_override_by" text,
  "admin_override_note" text,
  "admin_override_at" bigint,
  "suspicious_flags" text,
  "ip_address" text,
  "user_agent" text,
  "requested_at" bigint NOT NULL,
  "resolved_at" bigint,
  "created_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_guarantee_claims_user" ON "guarantee_claims" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guarantee_claims_type" ON "guarantee_claims" ("guarantee_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guarantee_claims_status" ON "guarantee_claims" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guarantee_claims_requested" ON "guarantee_claims" ("requested_at");--> statement-breakpoint
-- One claim per guarantee type per user (lifetime) — enforced at the application
-- layer but this unique index provides a safety net.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_guarantee_claims_user_type" ON "guarantee_claims" ("user_id", "guarantee_type");--> statement-breakpoint

-- 3. A/B experiment assignments for pricing-page guarantee stack test
CREATE TABLE IF NOT EXISTS "ab_experiment_assignments" (
  "id" serial PRIMARY KEY,
  "experiment_key" text NOT NULL,
  "visitor_id" text NOT NULL,
  "variant" text NOT NULL,
  "user_id" text,
  "converted" boolean DEFAULT false,
  "paid_converted" boolean DEFAULT false,
  "created_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ab_assignments_experiment" ON "ab_experiment_assignments" ("experiment_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ab_assignments_visitor" ON "ab_experiment_assignments" ("visitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ab_assignments_visitor_exp" ON "ab_experiment_assignments" ("visitor_id", "experiment_key");--> statement-breakpoint

-- 4. Immutable audit log for every guarantee claim state change (append-only)
CREATE TABLE IF NOT EXISTS "guarantee_claim_events" (
  "id" serial PRIMARY KEY,
  "claim_id" text NOT NULL,
  "user_id" text NOT NULL,
  "from_status" text,
  "to_status" text NOT NULL,
  "actor" text NOT NULL,
  "note" text,
  "metadata" text,
  "created_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_guarantee_claim_events_claim" ON "guarantee_claim_events" ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guarantee_claim_events_created" ON "guarantee_claim_events" ("created_at");
