-- Add tag + last_used_at to saved_line_items so the picker can group by tag and
-- surface the most-recently-used presets. Idempotent (IF NOT EXISTS) so that
-- the platform pre-flight + drizzle-kit push paths don't conflict.
ALTER TABLE "saved_line_items" ADD COLUMN IF NOT EXISTS "tag" text;--> statement-breakpoint
ALTER TABLE "saved_line_items" ADD COLUMN IF NOT EXISTS "last_used_at" bigint;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_line_items_user_last_used" ON "saved_line_items" USING btree ("user_id","last_used_at");
