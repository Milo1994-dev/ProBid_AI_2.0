# Migration 0007 Verification Report
**Task #187 — Verify duplicate-cleanup migration on a real production snapshot before deploy**
**Date:** April 30, 2026
**Migration:** `migrations/0007_pipeline_deals_unique_dedupe.sql`

---

## Summary

**Blast radius: ZERO. Safe to deploy.**

The migration has already been applied in production. Both partial unique indexes exist and are confirmed valid. No duplicate rows were found in either partition.

---

## Production Database Analysis

| Metric | Value |
|--------|-------|
| Total `pipeline_deals` rows | 0 |
| Total `pipeline_activities` rows | 0 |
| Total `pipeline_deal_attachments` rows | 0 |

### Duplicate groups by `(user_id, lead_id)`

| Metric | Value |
|--------|-------|
| Duplicate groups found | 0 |
| Total loser rows (to delete) | 0 |
| Max losers in a single group | 0 |
| Activities to re-point | 0 |
| Attachments to re-point | 0 |

### Duplicate groups by `(user_id, estimate_id)`

| Metric | Value |
|--------|-------|
| Duplicate groups found | 0 |
| Total loser rows (to delete) | 0 |
| Max losers in a single group | 0 |
| Activities to re-point | 0 |
| Attachments to re-point | 0 |

**No group exceeds the 50-loser threshold. No pause required.**

---

## Partial Unique Index Status (Production)

Both indexes were created successfully and confirmed present:

| Index Name | Definition | Size |
|-----------|-----------|------|
| `idx_pipeline_deals_user_lead_uq` | `CREATE UNIQUE INDEX … ON pipeline_deals (user_id, lead_id) WHERE lead_id IS NOT NULL` | 8192 bytes |
| `idx_pipeline_deals_user_estimate_uq` | `CREATE UNIQUE INDEX … ON pipeline_deals (user_id, estimate_id) WHERE estimate_id IS NOT NULL` | 8192 bytes |

Both are `IF NOT EXISTS` partial unique indexes covering only non-NULL values. Index creation raised no errors.

---

## Timing (Dev DB — Empty Table Baseline)

Migration logic was executed via `EXPLAIN ANALYZE` on the development database (also empty) to confirm query plans and measure baseline timing:

| Step | Execution Time |
|------|---------------|
| Promote `estimate_id` from lead losers | ~0.13 ms |
| Re-point `pipeline_activities` (lead losers) | ~0.12 ms |
| Re-point `pipeline_deal_attachments` (lead losers) | ~0.12 ms |
| Delete lead loser rows | ~0.1 ms (estimated) |
| Promote `lead_id` from estimate losers | ~0.1 ms (estimated) |
| Re-point activities (estimate losers) | ~0.1 ms (estimated) |
| Re-point attachments (estimate losers) | ~0.1 ms (estimated) |
| Delete estimate loser rows | ~0.1 ms (estimated) |
| Create both unique indexes (`IF NOT EXISTS`, already exist) | negligible |

**Total estimated runtime on current prod data: < 5ms** (no rows to process).

Note: On a populated table, runtime scales with the number of deals. With zero rows in production at time of snapshot, all window functions and CTEs complete in under 0.2ms per step.

---

## Conclusion

- The `pipeline_deals` table is empty in production at snapshot time (no real pipeline activity yet).
- Zero duplicate groups exist across both partition keys `(user_id, lead_id)` and `(user_id, estimate_id)`.
- Both partial unique indexes were created successfully and are present in the production database.
- The migration's `IF NOT EXISTS` guard on the index creation means re-running is safe and idempotent.
- **No >50 loser groups detected — production deploy is safe to proceed without hold.**

---

## Methodology

Queries were executed against the production read-replica using `executeSql({ environment: "production" })`.
Dev database was also analyzed for index presence and `EXPLAIN ANALYZE` timing baselines.
All production queries were read-only (SELECT, EXPLAIN ANALYZE, pg_indexes / pg_tables inspection).
