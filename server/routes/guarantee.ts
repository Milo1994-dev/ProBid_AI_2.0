/**
 * Contractor-facing Guarantee Routes
 *
 * GET  /api/guarantees/eligibility   — returns all three guarantee eligibility statuses
 * POST /api/guarantees/claim         — submit a guarantee claim
 * GET  /api/guarantees/claims        — list user's own claims
 *
 * A/B experiment tracking:
 * POST /api/ab/assign                — assign visitor to a pricing-page variant
 * POST /api/ab/convert               — record a signup or paid conversion
 */

import express from "express";
import crypto from "crypto";
import { asyncHandler, requireAuthJson } from "../lib/middleware.js";
import { pool } from "../db.js";
import { now } from "../lib/utils.js";
import { log } from "../lib/logger.js";
import {
  evaluateEligibility,
  resolveClaimRouting,
  GUARANTEE_INFO,
  GuaranteeType,
} from "../lib/guarantee-rules.js";
import { stripe, getStripeCustomerIdOrNull } from "../lib/stripe-helpers.js";
import { sendGuaranteeClaimEmail } from "../lib/email-helpers.js";
import { getUser } from "../lib/user-helpers.js";
import { z } from "zod";

const claimSchema = z.object({
  type: z.enum(["speed", "win_jobs", "money_back"]),
});

const abAssignSchema = z.object({
  visitorId: z.string().min(1).max(128),
  experimentKey: z.string().min(1).max(100),
});

const abConvertSchema = z.object({
  visitorId: z.string().min(1).max(128),
  experimentKey: z.string().min(1).max(100),
  paid: z.boolean().optional().default(false),
});

export function registerGuaranteeRoutes(app: express.Application): void {
  /**
   * GET /api/guarantees/eligibility
   * Returns eligibility for all three guarantee types for the logged-in user.
   */
  app.get(
    "/api/guarantees/eligibility",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const [speedResult, winJobsResult, moneyBackResult] = await Promise.all([
        evaluateEligibility(uid, "speed"),
        evaluateEligibility(uid, "win_jobs"),
        evaluateEligibility(uid, "money_back"),
      ]);

      res.json({
        success: true,
        data: {
          speed: { ...speedResult, info: GUARANTEE_INFO.speed },
          win_jobs: { ...winJobsResult, info: GUARANTEE_INFO.win_jobs },
          money_back: { ...moneyBackResult, info: GUARANTEE_INFO.money_back },
        },
      });
    }),
  );

  /**
   * GET /api/guarantees/claims
   * List the current user's guarantee claims.
   */
  app.get(
    "/api/guarantees/claims",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const result = await pool.query(
        `SELECT id, guarantee_type, status, eligibility_verdict, eligibility_reasons,
                resolution, account_credit_cents, stripe_refund_id, suspicious_flags,
                requested_at, resolved_at, created_at
         FROM guarantee_claims
         WHERE user_id = $1
         ORDER BY requested_at DESC`,
        [uid],
      );
      res.json({ success: true, data: { claims: result.rows } });
    }),
  );

  /**
   * POST /api/guarantees/claim
   * Submit a guarantee claim. The rules engine evaluates eligibility and
   * auto-approves, auto-denies, or routes to admin review.
   */
  app.post(
    "/api/guarantees/claim",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const parseResult = claimSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues[0].message });
      }
      const { type } = parseResult.data as { type: GuaranteeType };

      // Evaluate eligibility (also checks alreadyClaimed)
      const eligibility = await evaluateEligibility(uid, type);

      if (eligibility.alreadyClaimed) {
        return res.status(409).json({
          success: false,
          error: "You have already submitted a claim for this guarantee.",
        });
      }

      const claimId = crypto.randomUUID();
      const nowMs = now();
      const routing = resolveClaimRouting(eligibility);

      let status: string;
      let resolution: string | null = null;
      let stripeRefundId: string | null = null;
      let accountCreditCents = 0;

      // ── Determine initial status without any Stripe side-effects ──────────
      if (routing === "auto_deny") {
        status = "denied";
        resolution = eligibility.reasons.join(" ");
      } else if (routing === "admin_review") {
        status = "pending";
        resolution = "Under review due to account flags.";
      } else {
        // auto_approve: write claim as "pending" first (holds DB seat), then pay out
        status = "pending";
        resolution = "Processing refund/credit...";
      }

      const ipAddress = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "");
      const userAgent = String(req.headers["user-agent"] || "");

      // ── INSERT claim FIRST — unique (user_id, guarantee_type) constraint ──
      // This is the idempotency gate. Concurrent requests will fail here
      // before any Stripe call is made, preventing duplicate payouts.
      try {
        await pool.query(
          `INSERT INTO guarantee_claims
           (id, user_id, guarantee_type, status, eligibility_verdict, eligibility_reasons,
            resolution, stripe_refund_id, account_credit_cents, suspicious_flags,
            ip_address, user_agent, requested_at, resolved_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13)`,
          [
            claimId,
            uid,
            type,
            status,
            eligibility.eligible ? "eligible" : "ineligible",
            eligibility.reasons.join(" | "),
            resolution,
            null,           // stripe_refund_id not yet known
            0,              // account_credit_cents not yet known
            eligibility.suspicious.length > 0 ? eligibility.suspicious.join(" | ") : null,
            ipAddress,
            userAgent,
            nowMs,
            routing === "auto_deny" ? nowMs : null,
          ],
        );
      } catch (err: any) {
        if (err.code === "23505") {
          return res.status(409).json({
            success: false,
            error: "You have already submitted a claim for this guarantee.",
          });
        }
        throw err;
      }

      // ── Execute payout AFTER claim row is committed ────────────────────────
      // Now that the DB row is persisted, execute the Stripe side-effect.
      // If the payout fails, the claim stays in 'pending' for admin resolution.
      if (routing === "auto_approve") {
        try {
          const creditResult = await issueGuaranteeResolution(uid, type);
          stripeRefundId = creditResult.stripeRefundId;
          accountCreditCents = creditResult.accountCreditCents;
          resolution = creditResult.resolution;
          status = "approved";
        } catch (payoutErr: any) {
          log("error", "Payout failed after claim insert — staying pending for admin", {
            claimId, userId: uid, type, error: payoutErr?.message,
          });
          // Leave status as 'pending' — admin can review and manually approve
          resolution = "Auto-approval attempted but payout failed. Admin review required.";
        }

        // Update claim with final status + payout details
        await pool.query(
          `UPDATE guarantee_claims
           SET status = $1, resolution = $2, stripe_refund_id = $3,
               account_credit_cents = $4, resolved_at = $5
           WHERE id = $6`,
          [status, resolution, stripeRefundId, accountCreditCents, status === "approved" ? nowMs : null, claimId],
        );
      }

      // Write immutable audit events — one per state transition.
      // For auto_approve: null→pending (insert) then pending→approved/failed (payout).
      // For auto_deny/admin_review: null→final is a single transition.
      if (routing === "auto_approve") {
        // First transition: null → pending (DB row inserted)
        logClaimEvent({
          claimId,
          userId: uid,
          fromStatus: null,
          toStatus: "pending",
          actor: "system",
          note: `Routing: auto_approve. Claim inserted; payout initiated. ${eligibility.reasons.join("; ")}`,
          metadata: { routing, type, eligible: eligibility.eligible },
        });
        // Second transition: pending → approved OR pending → pending (payout failed)
        logClaimEvent({
          claimId,
          userId: uid,
          fromStatus: "pending",
          toStatus: status,
          actor: "system",
          note: status === "approved"
            ? `Auto-approved. ${resolution}`
            : "Payout failed — claim held pending for admin review.",
          metadata: { stripeRefundId, accountCreditCents },
        });
      } else {
        // auto_deny: null → denied; admin_review: null → pending — single transition.
        logClaimEvent({
          claimId,
          userId: uid,
          fromStatus: null,
          toStatus: status,
          actor: "system",
          note: `Routing: ${routing}. ${eligibility.reasons.join("; ")}`,
          metadata: { routing, type, eligible: eligibility.eligible },
        });
      }

      // Send confirmation email
      const user = await getUser(uid);
      if (user?.email) {
        sendGuaranteeClaimEmail(user.email, type, status, resolution || "").catch(
          err => log("warn", "Failed to send guarantee claim email", { error: err?.message }),
        );
      }

      log("info", "Guarantee claim submitted", {
        claimId, userId: uid, type, routing, status,
      });

      res.json({
        success: true,
        data: {
          claimId,
          status,
          routing,
          resolution,
          eligible: eligibility.eligible,
          reasons: eligibility.reasons,
          accountCreditCents,
          stripeRefundId,
        },
      });
    }),
  );

  // ─── A/B Experiment endpoints ──────────────────────────────────────────────

  /**
   * POST /api/ab/assign
   * Deterministically assign (or retrieve existing assignment) for a visitor.
   * The variant is determined 50/50 by hashing the visitorId so the same
   * visitor always sees the same variant without needing a DB round-trip first.
   */
  app.post(
    "/api/ab/assign",
    asyncHandler(async (req, res) => {
      const parseResult = abAssignSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: "Invalid request." });
      }
      const { visitorId, experimentKey } = parseResult.data;

      // Experiment runs for 30 days from launch (2026-05-08 UTC).
      // After that window all new visitors receive "control" so the experiment
      // gracefully closes without polluting results with post-window traffic.
      const EXPERIMENT_START_MS = 1746662400000; // 2026-05-08 00:00:00 UTC
      const EXPERIMENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
      const experimentActive = Date.now() < EXPERIMENT_START_MS + EXPERIMENT_WINDOW_MS;

      const uid = req.session?.uid || null;
      const nowMs = now();

      // Always read existing DB assignment first — returning visitors must get their
      // stored variant even after the experiment window closes.  Computing only from
      // the hash would force post-window returning visitors into "control" regardless
      // of their original assignment, corrupting late-stage conversion attribution.
      let variant: string;
      const existingRow = await pool.query(
        `SELECT variant FROM ab_experiment_assignments WHERE visitor_id = $1 AND experiment_key = $2 LIMIT 1`,
        [visitorId, experimentKey],
      );
      if (existingRow.rows.length > 0) {
        // Honour the stored assignment — stable across the entire experiment lifetime.
        variant = existingRow.rows[0].variant as string;
      } else {
        // New visitor: deterministic 50/50 hash split; force "control" when window is closed.
        const hashByte = crypto.createHash("md5").update(`${experimentKey}:${visitorId}`).digest()[0];
        variant = experimentActive && hashByte >= 128 ? "guarantee_stack" : "control";
        try {
          await pool.query(
            `INSERT INTO ab_experiment_assignments (experiment_key, visitor_id, variant, user_id, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (visitor_id, experiment_key) DO NOTHING`,
            [experimentKey, visitorId, variant, uid, nowMs],
          );
        } catch {
          // Non-fatal — variant is still correct from the hash
        }
      }

      res.json({ success: true, data: { variant, visitorId, experimentKey } });
    }),
  );

  /**
   * POST /api/ab/convert
   * Record a signup or paid conversion for a visitor's experiment assignment.
   */
  app.post(
    "/api/ab/convert",
    asyncHandler(async (req, res) => {
      const parseResult = abConvertSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: "Invalid request." });
      }
      const { visitorId, experimentKey } = parseResult.data;
      // paid_converted is set exclusively by the Stripe webhook after confirmed payment.
      // The public endpoint only records signup/signup-intent conversions (converted=true).
      const uid = req.session?.uid || null;

      await pool.query(
        `UPDATE ab_experiment_assignments
         SET converted = true,
             user_id = COALESCE(user_id, $1)
         WHERE visitor_id = $2 AND experiment_key = $3`,
        [uid, visitorId, experimentKey],
      );

      res.json({ success: true, data: null });
    }),
  );
}

/**
 * Issues the appropriate resolution for an auto-approved claim.
 * - money_back: full Stripe charge refund, falling back to Stripe customer balance credit
 * - speed/win_jobs: $25 Stripe customer balance credit (applied to next invoice)
 */
async function issueGuaranteeResolution(
  userId: string,
  type: GuaranteeType,
): Promise<{ stripeRefundId: string | null; accountCreditCents: number; resolution: string }> {
  const CREDIT_CENTS = 2500; // $25 = one Pro month

  const customerId = await getStripeCustomerIdOrNull(userId);

  if (type === "money_back") {
    if (customerId) {
      try {
        const charges = await stripe.charges.list({ customer: customerId, limit: 5 });
        const refundable = charges.data.find(c => !c.refunded && c.amount > 0);
        if (refundable) {
          const refund = await stripe.refunds.create({
            charge: refundable.id,
            reason: "requested_by_customer",
          });
          return {
            stripeRefundId: refund.id,
            // Store the refund amount so dashboard SUM(account_credit_cents) captures all financial impact
            accountCreditCents: refundable.amount,
            resolution: `Full refund of $${(refundable.amount / 100).toFixed(2)} issued via Stripe (refund ID: ${refund.id}). Funds typically appear within 5–10 business days.`,
          };
        }
      } catch (err: any) {
        log("warn", "Stripe charge refund failed, falling back to balance credit", { error: err?.message });
      }
      // Fallback: Stripe customer balance credit for the actual first payment amount
      try {
        const paymentRow = await pool.query(
          `SELECT amount_cents FROM purchases WHERE user_id = $1 AND type NOT IN ('single_estimate') ORDER BY created_at ASC LIMIT 1`,
          [userId],
        );
        const creditCents: number = paymentRow.rows[0]?.amount_cents ?? CREDIT_CENTS;
        await stripe.customers.createBalanceTransaction(customerId, {
          amount: -creditCents,
          currency: "usd",
          description: "ProBid 30-Day Money-Back Guarantee credit",
        });
        return {
          stripeRefundId: null,
          accountCreditCents: creditCents,
          resolution: `A $${(creditCents / 100).toFixed(2)} account credit has been applied to your Stripe account and will be deducted automatically from your next invoice.`,
        };
      } catch (err: any) {
        log("warn", "Stripe balance credit also failed", { error: err?.message });
      }
    }
    // No Stripe customer — cannot auto-issue payout; throw so claim stays pending
    throw new Error(`No Stripe customer for user ${userId} — cannot auto-issue money_back payout`);
  }

  // speed + win_jobs: apply $25 Stripe customer balance credit for next invoice
  if (customerId) {
    try {
      await stripe.customers.createBalanceTransaction(customerId, {
        amount: -CREDIT_CENTS,
        currency: "usd",
        description: `ProBid ${type === "speed" ? "60-Second Speed" : "Win-Jobs"} Guarantee credit`,
      });
      return {
        stripeRefundId: null,
        accountCreditCents: CREDIT_CENTS,
        resolution: `A $${(CREDIT_CENTS / 100).toFixed(2)} credit has been applied to your Stripe account and will be deducted automatically from your next invoice.`,
      };
    } catch (err: any) {
      log("warn", "Stripe balance credit failed for speed/win_jobs guarantee", { error: err?.message });
    }
  }

  // No Stripe customer (or Stripe call failed) — cannot auto-issue payout
  throw new Error(`Unable to apply Stripe credit for user ${userId} type=${type} — no customer or Stripe error`);
}

/**
 * Appends an immutable audit event for a claim state transition.
 */
export async function logClaimEvent(opts: {
  claimId: string;
  userId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO guarantee_claim_events (claim_id, user_id, from_status, to_status, actor, note, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opts.claimId,
        opts.userId,
        opts.fromStatus,
        opts.toStatus,
        opts.actor,
        opts.note ?? null,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
        Date.now(),
      ],
    );
  } catch (err: any) {
    log("warn", "Failed to log claim event", { claimId: opts.claimId, error: err?.message });
  }
}
