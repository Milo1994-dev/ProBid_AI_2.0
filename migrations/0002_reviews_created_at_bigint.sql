-- Convert reviews.created_at from timestamp → bigint (epoch ms).
--
-- Why this migration exists despite scripts/db-prepare.mjs already doing the
-- same conversion: Replit Deployments runs a platform-level "validate
-- migrations" step BEFORE our build script (and therefore before db-prepare),
-- using drizzle-kit's diff generator. That generator emits a bare
-- `ALTER TABLE "reviews" ALTER COLUMN "created_at" SET DATA TYPE bigint;`
-- with no USING clause, which Postgres rejects ("cannot be cast
-- automatically to type bigint"). Committing this migration with an explicit
-- USING clause so that any drizzle-kit migrate / drizzle-orm migrator path
-- that DOES honor migration files succeeds; the unconditional db-prepare
-- conversion is the belt-and-suspenders backup.
--
-- Idempotent: only runs the cast if the column is still a timestamp variant.
-- Safe with rows present (epoch * 1000 preserves data as ms).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reviews'
       AND column_name = 'created_at'
       AND data_type LIKE 'timestamp%'
  ) THEN
    -- Drop the legacy DEFAULT now() before the cast. Postgres refuses to
    -- auto-cast a timestamp expression default to bigint, so without this
    -- step the ALTER below fails with "default for column ... cannot be
    -- cast automatically to type bigint" on databases where the column
    -- still has its original default. Mirrors scripts/db-prepare.mjs.
    EXECUTE 'ALTER TABLE "reviews" ALTER COLUMN "created_at" DROP DEFAULT';
    EXECUTE 'ALTER TABLE "reviews" ALTER COLUMN "created_at" SET DATA TYPE bigint USING (EXTRACT(EPOCH FROM created_at) * 1000)::bigint';
  END IF;
END $$;
