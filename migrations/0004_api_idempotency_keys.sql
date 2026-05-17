-- Idempotency replay-cache for the /api/estimates/send endpoint.
-- Scoped per (api_key_id, idempotency_key) so partners can use any UUID
-- they like without coordinating with each other.
CREATE TABLE IF NOT EXISTS "api_idempotency_keys" (
        "id" serial PRIMARY KEY NOT NULL,
        "api_key_id" text NOT NULL,
        "idempotency_key" text NOT NULL,
        "request_hash" text NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "response_status" integer,
        "response_body" text,
        "estimate_id" text,
        "created_at" bigint NOT NULL,
        "expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_idempotency_keys_api_key_id_key_uq"
  ON "api_idempotency_keys" ("api_key_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_idempotency_keys_expires_at"
  ON "api_idempotency_keys" ("expires_at");
