-- Outbound webhooks for partner integrations.
-- See shared/schema.ts (`webhooks`, `webhook_deliveries`) for the source of truth.
-- This migration is idempotent so it is safe to re-apply against environments
-- that may have been bootstrapped via `drizzle-kit push` before the journal
-- caught up.

CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "events" text NOT NULL DEFAULT 'estimate.created',
  "description" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_status" text,
  "last_status_code" integer,
  "last_error" text,
  "last_delivered_at" bigint,
  "failure_count" integer NOT NULL DEFAULT 0,
  "success_count" integer NOT NULL DEFAULT 0,
  "revoked_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_webhooks_user" ON "webhooks" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_webhooks_enabled" ON "webhooks" ("enabled");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" text PRIMARY KEY,
  "webhook_id" text NOT NULL REFERENCES "webhooks"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "event" text NOT NULL,
  "payload" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "response_status" integer,
  "response_body" text,
  "error" text,
  "next_attempt_at" bigint,
  "last_attempt_at" bigint,
  "delivered_at" bigint,
  "created_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook" ON "webhook_deliveries" ("webhook_id");
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_user" ON "webhook_deliveries" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_status" ON "webhook_deliveries" ("status");
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_next" ON "webhook_deliveries" ("next_attempt_at");
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_created" ON "webhook_deliveries" ("created_at");
