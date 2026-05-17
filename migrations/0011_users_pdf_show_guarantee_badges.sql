-- Task: Show guarantee badges on the estimate PDF.
-- Adds a per-user toggle that controls whether the "Backed by ProBid's Triple Guarantee"
-- trust bar is rendered in exported estimate PDFs. Defaults to TRUE so existing Pro/Business
-- users see the trust bar without any action; the PDF route still gates display by paid tier.
-- Idempotent so re-running the migration is safe.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pdf_show_guarantee_badges" boolean DEFAULT true;
