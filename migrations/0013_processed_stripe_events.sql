CREATE TABLE IF NOT EXISTS "processed_stripe_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "received_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_processed_stripe_events_received_at"
  ON "processed_stripe_events" ("received_at");
