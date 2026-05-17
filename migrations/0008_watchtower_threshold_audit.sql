-- Task #234: Audit log for Watchtower threshold changes.
-- Every POST (set) and DELETE (reset) to a threshold endpoint writes a row
-- here so admins can see who changed what and when.
-- Idempotent (IF NOT EXISTS) so the drizzle baseline + normal migrate path
-- are both safe.

CREATE TABLE IF NOT EXISTS "watchtower_threshold_audit" (
  "id" serial PRIMARY KEY,
  "subsystem" text NOT NULL,
  "action" text NOT NULL,
  "endpoint" text NOT NULL,
  "changed_by" text,
  "old_value" text,
  "new_value" text,
  "created_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_wt_audit_subsystem" ON "watchtower_threshold_audit" ("subsystem");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wt_audit_created" ON "watchtower_threshold_audit" ("created_at");
