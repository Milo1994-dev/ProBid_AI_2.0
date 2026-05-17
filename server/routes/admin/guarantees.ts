/**
 * Admin Guarantee Claims Routes
 *
 * GET    /api/admin/guarantees/claims         — list all claims with filter/pagination
 * GET    /api/admin/guarantees/claims/:id     — single claim detail
 * POST   /api/admin/guarantees/claims/:id/approve  — approve a pending claim
 * POST   /api/admin/guarantees/claims/:id/deny     — deny a pending claim
 * GET    /api/admin/guarantees/dashboard      — A/B experiment + claim metrics
 */

import express from "express";
import { asyncHandler } from "../../lib/middleware.js";
import { pool } from "../../db.js";
import { log } from "../../lib/logger.js";
import { now } from "../../lib/utils.js";
import { isAdminRequest } from "./shared.js";
import { stripe, getStripeCustomerIdOrNull } from "../../lib/stripe-helpers.js";
import { sendGuaranteeClaimEmail } from "../../lib/email-helpers.js";
import { logClaimEvent } from "../guarantee.js";

export function registerAdminGuaranteeRoutes(app: express.Application): void {
  /**
   * GET /api/admin/guarantees/claims
   * List claims with optional filters: status, guarantee_type, page.
   */
  app.get(
    "/api/admin/guarantees/claims",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Forbidden" });

      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
      const pageSize = 50;
      const offset = (page - 1) * pageSize;
      const status = String(req.query.status || "").trim() || null;
      const type = String(req.query.type || "").trim() || null;

      const whereParts: string[] = [];
      const params: any[] = [];
      let pIdx = 1;

      if (status) { whereParts.push(`gc.status = $${pIdx++}`); params.push(status); }
      if (type) { whereParts.push(`gc.guarantee_type = $${pIdx++}`); params.push(type); }

      const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

      const countResult = await pool.query(
        `SELECT COUNT(*) AS c FROM guarantee_claims gc ${where}`,
        params,
      );
      const total = parseInt(countResult.rows[0]?.c || "0", 10);

      const claimsResult = await pool.query(
        `SELECT gc.*, u.email AS user_email, u.created_at AS user_created_at
         FROM guarantee_claims gc
         JOIN users u ON gc.user_id = u.id
         ${where}
         ORDER BY gc.requested_at DESC
         LIMIT $${pIdx++} OFFSET $${pIdx}`,
        [...params, pageSize, offset],
      );

      res.json({
        success: true,
        data: {
          claims: claimsResult.rows,
          total,
          page,
          pages: Math.max(1, Math.ceil(total / pageSize)),
        },
      });
    }),
  );

  /**
   * GET /api/admin/guarantees/claims/:id
   * Single claim detail with full audit trail.
   */
  app.get(
    "/api/admin/guarantees/claims/:id",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Forbidden" });

      const result = await pool.query(
        `SELECT gc.*, u.email AS user_email, u.created_at AS user_created_at
         FROM guarantee_claims gc
         JOIN users u ON gc.user_id = u.id
         WHERE gc.id = $1`,
        [req.params.id],
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Claim not found." });
      }

      const claim = result.rows[0];

      // Fetch context + full audit trail in parallel
      const [otherClaims, estimateCount, claimEvents] = await Promise.all([
        pool.query(
          `SELECT id, guarantee_type, status, requested_at FROM guarantee_claims
           WHERE user_id = $1 AND id != $2 ORDER BY requested_at DESC`,
          [claim.user_id, req.params.id],
        ),
        pool.query(
          `SELECT COUNT(*) AS c FROM estimates WHERE user_id = $1`,
          [claim.user_id],
        ),
        pool.query(
          `SELECT id, from_status, to_status, actor, note, metadata, created_at
           FROM guarantee_claim_events
           WHERE claim_id = $1
           ORDER BY created_at ASC`,
          [req.params.id],
        ),
      ]);

      res.json({
        success: true,
        data: {
          claim,
          auditTrail: claimEvents.rows,
          context: {
            otherClaims: otherClaims.rows,
            estimateCount: parseInt(estimateCount.rows[0]?.c || "0", 10),
          },
        },
      });
    }),
  );

  /**
   * POST /api/admin/guarantees/claims/:id/approve
   * Admin override — approve a pending/denied claim. Issues refund or credit.
   */
  app.post(
    "/api/admin/guarantees/claims/:id/approve",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Forbidden" });

      const { note } = req.body as { note?: string };
      const claimId = req.params.id;

      const claimResult = await pool.query(
        `SELECT gc.*, u.email AS user_email FROM guarantee_claims gc
         JOIN users u ON gc.user_id = u.id
         WHERE gc.id = $1`,
        [claimId],
      );
      if (claimResult.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Claim not found." });
      }

      const claim = claimResult.rows[0];
      if (claim.status === "approved") {
        return res.status(409).json({ success: false, error: "Claim is already approved." });
      }

      const nowMs = now();
      let stripeRefundId: string | null = null;
      let accountCreditCents = 0;
      let resolution = note || "Manually approved by admin.";

      // Issue the appropriate resolution
      if (claim.guarantee_type === "money_back") {
        const customerId = await getStripeCustomerIdOrNull(claim.user_id);
        if (customerId) {
          try {
            const charges = await stripe.charges.list({ customer: customerId, limit: 1 });
            const charge = charges.data[0];
            if (charge && charge.amount > 0 && !charge.refunded) {
              const refund = await stripe.refunds.create({ charge: charge.id, reason: "requested_by_customer" });
              stripeRefundId = refund.id;
              accountCreditCents = charge.amount; // actual refund amount for dashboard SUM
              resolution = `Stripe refund issued: ${refund.id} ($${(charge.amount / 100).toFixed(2)}). ${note || ""}`.trim();
            } else {
              // No refundable charge — use actual first payment amount for full credit
              const paymentRow = await pool.query(
                `SELECT amount_cents FROM purchases WHERE user_id = $1 AND type NOT IN ('single_estimate') ORDER BY created_at ASC LIMIT 1`,
                [claim.user_id],
              );
              accountCreditCents = paymentRow.rows[0]?.amount_cents ?? 2500;
              resolution = `Account credit of $${(accountCreditCents / 100).toFixed(2)} issued (no eligible charge). ${note || ""}`.trim();
            }
          } catch (err: any) {
            log("warn", "Admin: Stripe refund failed, issuing credit", { claimId, error: err?.message });
            const paymentRow2 = await pool.query(
              `SELECT amount_cents FROM purchases WHERE user_id = $1 AND type NOT IN ('single_estimate') ORDER BY created_at ASC LIMIT 1`,
              [claim.user_id],
            ).catch(() => ({ rows: [] as any[] }));
            accountCreditCents = paymentRow2.rows[0]?.amount_cents ?? 2500;
            resolution = `Account credit of $${(accountCreditCents / 100).toFixed(2)} issued (Stripe unavailable). ${note || ""}`.trim();
          }
        } else {
          // No Stripe customer — use actual first payment amount for full credit
          const paymentRow3 = await pool.query(
            `SELECT amount_cents FROM purchases WHERE user_id = $1 AND type NOT IN ('single_estimate') ORDER BY created_at ASC LIMIT 1`,
            [claim.user_id],
          ).catch(() => ({ rows: [] as any[] }));
          accountCreditCents = paymentRow3.rows[0]?.amount_cents ?? 2500;
          resolution = `Account credit of $${(accountCreditCents / 100).toFixed(2)} issued. ${note || ""}`.trim();
        }
      } else {
        // speed + win_jobs: Stripe balance credit, then DB-only fallback
        const customerId = await getStripeCustomerIdOrNull(claim.user_id);
        if (customerId) {
          try {
            await stripe.customers.createBalanceTransaction(customerId, {
              amount: -2500,
              currency: "usd",
              description: `ProBid ${claim.guarantee_type === "speed" ? "60-Second Speed" : "Win-Jobs"} Guarantee credit (admin)`,
            });
            accountCreditCents = 2500;
            resolution = `A $25 credit has been applied to your Stripe account and will be deducted from your next invoice. ${note || ""}`.trim();
          } catch (err: any) {
            log("warn", "Admin: Stripe balance credit failed, recording in DB only", { claimId, error: err?.message });
            accountCreditCents = 2500;
            resolution = `Account credit of $25 issued (Stripe balance update pending). ${note || ""}`.trim();
          }
        } else {
          accountCreditCents = 2500;
          resolution = `Account credit of $25 recorded. ${note || ""}`.trim();
        }
        // Apply Stripe balance credit for money_back fallback path (when accountCreditCents was set without balance tx)
      }

      // For money_back fallback path: when we set accountCreditCents as balance credit (no Stripe refund), apply it
      if (claim.guarantee_type === "money_back" && accountCreditCents > 0 && !stripeRefundId) {
        const customerId = await getStripeCustomerIdOrNull(claim.user_id);
        if (customerId) {
          try {
            await stripe.customers.createBalanceTransaction(customerId, {
              amount: -accountCreditCents,
              currency: "usd",
              description: "ProBid 30-Day Money-Back Guarantee credit (admin)",
            });
          } catch (err: any) {
            log("warn", "Admin: money_back Stripe balance credit failed", { claimId, error: err?.message });
          }
        }
      }

      await pool.query(
        `UPDATE guarantee_claims
         SET status = 'approved',
             eligibility_verdict = 'eligible',
             resolution = $1,
             stripe_refund_id = $2,
             account_credit_cents = $3,
             admin_override_by = 'admin',
             admin_override_note = $4,
             admin_override_at = $5,
             resolved_at = $5
         WHERE id = $6`,
        [resolution, stripeRefundId, accountCreditCents, note || null, nowMs, claimId],
      );

      logClaimEvent({
        claimId,
        userId: claim.user_id,
        fromStatus: claim.status,
        toStatus: "approved",
        actor: "admin",
        note: note ?? "Admin override approval",
        metadata: { stripeRefundId, accountCreditCents },
      });

      if (claim.user_email) {
        sendGuaranteeClaimEmail(claim.user_email, claim.guarantee_type, "approved", resolution).catch(
          err => log("warn", "Failed to send approval email", { error: err?.message }),
        );
      }

      log("info", "Admin approved guarantee claim", { claimId, type: claim.guarantee_type, userId: claim.user_id });
      res.json({ success: true, data: { resolution, stripeRefundId, accountCreditCents } });
    }),
  );

  /**
   * POST /api/admin/guarantees/claims/:id/deny
   * Admin override — deny a pending claim.
   */
  app.post(
    "/api/admin/guarantees/claims/:id/deny",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Forbidden" });

      const { note } = req.body as { note?: string };
      if (!note) {
        return res.status(400).json({ success: false, error: "A denial reason (note) is required." });
      }
      const claimId = req.params.id;

      const claimResult = await pool.query(
        `SELECT gc.*, u.email AS user_email FROM guarantee_claims gc
         JOIN users u ON gc.user_id = u.id
         WHERE gc.id = $1`,
        [claimId],
      );
      if (claimResult.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Claim not found." });
      }

      const claim = claimResult.rows[0];
      if (claim.status === "denied") {
        return res.status(409).json({ success: false, error: "Claim is already denied." });
      }

      const nowMs = now();
      await pool.query(
        `UPDATE guarantee_claims
         SET status = 'denied',
             resolution = $1,
             admin_override_by = 'admin',
             admin_override_note = $1,
             admin_override_at = $2,
             resolved_at = $2
         WHERE id = $3`,
        [note, nowMs, claimId],
      );

      logClaimEvent({
        claimId,
        userId: claim.user_id,
        fromStatus: claim.status,
        toStatus: "denied",
        actor: "admin",
        note,
      });

      if (claim.user_email) {
        sendGuaranteeClaimEmail(claim.user_email, claim.guarantee_type, "denied", note).catch(
          err => log("warn", "Failed to send denial email", { error: err?.message }),
        );
      }

      log("info", "Admin denied guarantee claim", { claimId, type: claim.guarantee_type, userId: claim.user_id, note });
      res.json({ success: true, data: { status: "denied" } });
    }),
  );

  /**
   * GET /api/admin/guarantees/dashboard
   * A/B experiment results + claim metrics for internal reporting.
   */
  app.get(
    "/api/admin/guarantees/dashboard",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Forbidden" });

      const [claimStats, abStats, recentClaims, claimRateByVariantResult] = await Promise.all([
        // Claim breakdown by type + status
        pool.query(`
          SELECT guarantee_type,
                 status,
                 COUNT(*) AS count,
                 COALESCE(SUM(account_credit_cents), 0) AS total_credit_cents
          FROM guarantee_claims
          GROUP BY guarantee_type, status
          ORDER BY guarantee_type, status
        `),
        // A/B experiment stats for the pricing page guarantee test
        pool.query(`
          SELECT experiment_key,
                 variant,
                 COUNT(*) AS assigned,
                 SUM(CASE WHEN converted THEN 1 ELSE 0 END) AS conversions,
                 SUM(CASE WHEN paid_converted THEN 1 ELSE 0 END) AS paid_conversions
          FROM ab_experiment_assignments
          WHERE experiment_key = 'pricing_guarantee_stack'
          GROUP BY experiment_key, variant
        `),
        // 10 most recent claims
        pool.query(`
          SELECT gc.id, gc.guarantee_type, gc.status, gc.eligibility_verdict,
                 gc.resolution, gc.account_credit_cents, gc.stripe_refund_id,
                 gc.suspicious_flags, gc.requested_at,
                 u.email AS user_email
          FROM guarantee_claims gc
          JOIN users u ON gc.user_id = u.id
          ORDER BY gc.requested_at DESC
          LIMIT 10
        `),
        // Claim count + approved credit cost per A/B variant
        pool.query(`
          SELECT a.variant,
                 COUNT(gc.id) AS claim_count,
                 COALESCE(SUM(CASE WHEN gc.status = 'approved' THEN gc.account_credit_cents ELSE 0 END), 0) AS approved_credit_cents
          FROM ab_experiment_assignments a
          LEFT JOIN guarantee_claims gc ON gc.user_id = a.user_id
          WHERE a.experiment_key = 'pricing_guarantee_stack'
          GROUP BY a.variant
        `),
      ]);

      // Aggregate refund totals
      const refundTotal = await pool.query(`
        SELECT COALESCE(SUM(account_credit_cents), 0) AS total_credits
        FROM guarantee_claims
        WHERE status = 'approved'
      `);

      const stripeRefundTotal = await pool.query(`
        SELECT COUNT(*) AS count FROM guarantee_claims WHERE stripe_refund_id IS NOT NULL
      `);

      // Build per-variant claim-rate lookup from the new query
      const claimRateMap: Record<string, { claimCount: number; approvedCreditCents: number }> = {};
      for (const r of claimRateByVariantResult.rows) {
        claimRateMap[r.variant] = {
          claimCount: parseInt(String(r.claim_count || "0"), 10),
          approvedCreditCents: parseInt(String(r.approved_credit_cents || "0"), 10),
        };
      }

      // Build richer A/B stats: include conversion rates, claim rate, and cost-per-user
      const abRows = abStats.rows.map((r: Record<string, unknown>) => {
        const assigned = parseInt(String(r.assigned || "0"), 10);
        const conversions = parseInt(String(r.conversions || "0"), 10);
        const paidConversions = parseInt(String(r.paid_conversions || "0"), 10);
        const variantKey = String(r.variant || "");
        const claimData = claimRateMap[variantKey] ?? { claimCount: 0, approvedCreditCents: 0 };
        return {
          ...r,
          assigned,
          conversions,
          paidConversions,
          conversionRate: assigned > 0 ? (conversions / assigned) : 0,
          paidConversionRate: assigned > 0 ? (paidConversions / assigned) : 0,
          claimCount: claimData.claimCount,
          claimRate: assigned > 0 ? (claimData.claimCount / assigned) : 0,
          costPerUserCents: assigned > 0 ? Math.round(claimData.approvedCreditCents / assigned) : 0,
        };
      });

      const totalNetImpactCents = parseInt(refundTotal.rows[0]?.total_credits || "0", 10);
      const stripeRefundCount = parseInt(stripeRefundTotal.rows[0]?.count || "0", 10);

      // Sum refund-only rows (where stripe_refund_id is not null) for separate reporting
      const stripeRefundAmountResult = await pool.query(`
        SELECT COALESCE(SUM(account_credit_cents), 0) AS total_stripe_refund_cents
        FROM guarantee_claims
        WHERE status = 'approved' AND stripe_refund_id IS NOT NULL
      `);
      const totalStripeRefundCents = parseInt(stripeRefundAmountResult.rows[0]?.total_stripe_refund_cents || "0", 10);
      const totalBalanceCreditCents = totalNetImpactCents - totalStripeRefundCents;

      res.json({
        success: true,
        data: {
          claimStats: claimStats.rows,
          abStats: abRows,
          recentClaims: recentClaims.rows,
          totals: {
            netFinancialImpactCents: totalNetImpactCents,
            netFinancialImpactDollars: (totalNetImpactCents / 100).toFixed(2),
            stripeRefundCents: totalStripeRefundCents,
            stripeRefundDollars: (totalStripeRefundCents / 100).toFixed(2),
            balanceCreditCents: totalBalanceCreditCents,
            balanceCreditDollars: (totalBalanceCreditCents / 100).toFixed(2),
            stripeRefundCount,
          },
        },
      });
    }),
  );
}
