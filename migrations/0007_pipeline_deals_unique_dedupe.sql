-- Task #142: prevent duplicate pipeline_deals rows for the same source.
-- Two concurrent saves of the same lead/estimate could each pass the
-- application-level "find then insert" check and create twin deals. Add
-- partial unique indexes so the DB rejects the second insert; the app catches
-- the 23505 and re-fetches the winner.
-- Idempotent (IF NOT EXISTS) so the platform pre-flight + drizzle-kit push
-- paths don't conflict.

-- 1. Dedupe any existing duplicates so the unique indexes can be created.
--    Keep the oldest row per group (smallest created_at, id as tiebreak).
--    Re-point pipeline_activities + pipeline_deal_attachments at the kept row
--    before deleting losers so we don't lose history or orphan FKs. Also
--    promote any business linkage (estimate_id during the lead-dedupe pass,
--    lead_id during the estimate-dedupe pass) from loser → keeper so we
--    don't silently drop the link when the older row happens to have a NULL.
WITH ranked_lead AS (
  SELECT id, user_id, lead_id, estimate_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, lead_id ORDER BY created_at ASC, id ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY user_id, lead_id ORDER BY created_at ASC, id ASC) AS keeper_id
    FROM pipeline_deals
   WHERE lead_id IS NOT NULL
),
losers_lead_with_est AS (
  -- Pick one loser per keeper that has a non-null estimate_id to promote.
  -- If multiple losers carry an estimate_id, take the oldest one.
  SELECT DISTINCT ON (keeper_id) keeper_id, estimate_id
    FROM ranked_lead
   WHERE rn > 1 AND estimate_id IS NOT NULL
   ORDER BY keeper_id, rn ASC
)
UPDATE pipeline_deals k
   SET estimate_id = l.estimate_id
  FROM losers_lead_with_est l
 WHERE k.id = l.keeper_id
   AND k.estimate_id IS NULL;--> statement-breakpoint

WITH ranked_lead AS (
  SELECT id, user_id, lead_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, lead_id ORDER BY created_at ASC, id ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY user_id, lead_id ORDER BY created_at ASC, id ASC) AS keeper_id
    FROM pipeline_deals
   WHERE lead_id IS NOT NULL
),
losers_lead AS (
  SELECT id, keeper_id FROM ranked_lead WHERE rn > 1
)
UPDATE pipeline_activities a
   SET deal_id = l.keeper_id
  FROM losers_lead l
 WHERE a.deal_id = l.id;--> statement-breakpoint

WITH ranked_lead AS (
  SELECT id, user_id, lead_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, lead_id ORDER BY created_at ASC, id ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY user_id, lead_id ORDER BY created_at ASC, id ASC) AS keeper_id
    FROM pipeline_deals
   WHERE lead_id IS NOT NULL
),
losers_lead AS (
  SELECT id, keeper_id FROM ranked_lead WHERE rn > 1
)
UPDATE pipeline_deal_attachments t
   SET deal_id = l.keeper_id
  FROM losers_lead l
 WHERE t.deal_id = l.id;--> statement-breakpoint

WITH ranked_lead AS (
  SELECT id, user_id, lead_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, lead_id ORDER BY created_at ASC, id ASC) AS rn
    FROM pipeline_deals
   WHERE lead_id IS NOT NULL
)
DELETE FROM pipeline_deals
 WHERE id IN (SELECT id FROM ranked_lead WHERE rn > 1);--> statement-breakpoint

WITH ranked_est AS (
  SELECT id, user_id, estimate_id, lead_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, estimate_id ORDER BY created_at ASC, id ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY user_id, estimate_id ORDER BY created_at ASC, id ASC) AS keeper_id
    FROM pipeline_deals
   WHERE estimate_id IS NOT NULL
),
losers_est_with_lead AS (
  SELECT DISTINCT ON (keeper_id) keeper_id, lead_id
    FROM ranked_est
   WHERE rn > 1 AND lead_id IS NOT NULL
   ORDER BY keeper_id, rn ASC
)
UPDATE pipeline_deals k
   SET lead_id = l.lead_id
  FROM losers_est_with_lead l
 WHERE k.id = l.keeper_id
   AND k.lead_id IS NULL;--> statement-breakpoint

WITH ranked_est AS (
  SELECT id, user_id, estimate_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, estimate_id ORDER BY created_at ASC, id ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY user_id, estimate_id ORDER BY created_at ASC, id ASC) AS keeper_id
    FROM pipeline_deals
   WHERE estimate_id IS NOT NULL
),
losers_est AS (
  SELECT id, keeper_id FROM ranked_est WHERE rn > 1
)
UPDATE pipeline_activities a
   SET deal_id = l.keeper_id
  FROM losers_est l
 WHERE a.deal_id = l.id;--> statement-breakpoint

WITH ranked_est AS (
  SELECT id, user_id, estimate_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, estimate_id ORDER BY created_at ASC, id ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY user_id, estimate_id ORDER BY created_at ASC, id ASC) AS keeper_id
    FROM pipeline_deals
   WHERE estimate_id IS NOT NULL
),
losers_est AS (
  SELECT id, keeper_id FROM ranked_est WHERE rn > 1
)
UPDATE pipeline_deal_attachments t
   SET deal_id = l.keeper_id
  FROM losers_est l
 WHERE t.deal_id = l.id;--> statement-breakpoint

WITH ranked_est AS (
  SELECT id, user_id, estimate_id,
         ROW_NUMBER() OVER (PARTITION BY user_id, estimate_id ORDER BY created_at ASC, id ASC) AS rn
    FROM pipeline_deals
   WHERE estimate_id IS NOT NULL
)
DELETE FROM pipeline_deals
 WHERE id IN (SELECT id FROM ranked_est WHERE rn > 1);--> statement-breakpoint

-- 2. Partial unique indexes: enforce one deal per (user, lead) and one per
--    (user, estimate). Partial so rows with NULL lead_id or NULL estimate_id
--    are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pipeline_deals_user_lead_uq"
  ON "pipeline_deals" ("user_id", "lead_id")
  WHERE "lead_id" IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_pipeline_deals_user_estimate_uq"
  ON "pipeline_deals" ("user_id", "estimate_id")
  WHERE "estimate_id" IS NOT NULL;
