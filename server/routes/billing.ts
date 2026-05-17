import crypto from "crypto";
import express from "express";
import Stripe from "stripe";
import { db } from "../db.js";
import { eq, and, sql } from "drizzle-orm";
import {
  subscriptions,
  referrals,
  purchases,
  users,
  stripeCustomers,
  affiliateEarnings,
  dunningEvents,
  processedStripeEvents,
} from "../../shared/schema.js";
import { asyncHandler, requireAdminAuth } from "../lib/middleware.js";
import { notifyFailedPayment } from "./notifications.js";
import { log } from "../lib/logger.js";
import { trackError } from "../lib/error-tracker.js";
import { now } from "../lib/utils.js";
import { getSub, isPaidActive } from "../lib/user-helpers.js";
import { getEffectiveSub, isBusinessTier } from "../lib/team-helpers.js";
import { trackEvent } from "../lib/analytics.js";
import { fireServerConversions } from "../lib/ad-conversions.js";
import {
  sendUpgradeConfirmationEmail,
  sendAdminSmsAlert,
  sendDunningImmediateEmail,
  enqueueWinbackSequence,
  enqueueSingleUpgradeSequence,
  sendTrialEndingSoonEmail,
} from "../lib/email-helpers.js";
import { stripe, upsertStripeCustomer, getStripeCustomerIdOrNull, createStripeCustomer } from "../lib/stripe-helpers.js";
import { createAffiliateEarning } from "../lib/affiliate-helpers.js";
import { pool } from "../db.js";

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

// Sanitize a `meta_event_id` value coming from a request body. We forward
// it verbatim into Stripe Checkout `metadata` (Stripe caps values at 500
// chars; Meta CAPI's `event_id` field is opaque). Reject non-strings,
// trim, and bound length so a malformed client can never blow up the
// Stripe call. Returns undefined when the input is missing or invalid.
function sanitizeMetaEventId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  return trimmed;
}

// ── Lifetime cap helpers ─────────────────────────────────────────────────────

const LIFETIME_CAP_KEY = "lifetime:cap";
const DEFAULT_LIFETIME_CAP = 100;
const LIFETIME_PRICE_CENTS = 19900;

async function getLifetimeCap(): Promise<number> {
  try {
    const r = await pool.query(`SELECT value FROM lead_outreach_config WHERE key = $1`, [LIFETIME_CAP_KEY]);
    if (r.rows[0]?.value != null) {
      const n = Number(r.rows[0].value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* fall through */ }
  return DEFAULT_LIFETIME_CAP;
}

async function setLifetimeCap(cap: number): Promise<void> {
  await pool.query(
    `INSERT INTO lead_outreach_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [LIFETIME_CAP_KEY, String(cap)],
  );
}

let lifetimeStatusCache: { data: LifetimeStatus; expiresAt: number } | null = null;

export interface LifetimeStatus {
  purchased: number;
  cap: number;
  remaining: number;
  soldOut: boolean;
  totalRevenueCents: number;
}

export async function getLifetimeStatus(forceRefresh = false): Promise<LifetimeStatus> {
  const now = Date.now();
  if (!forceRefresh && lifetimeStatusCache && lifetimeStatusCache.expiresAt > now) {
    return lifetimeStatusCache.data;
  }
  const [countResult, cap] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount_cents), 0)::int AS revenue FROM purchases WHERE type = 'lifetime'`),
    getLifetimeCap(),
  ]);
  const purchased = Number(countResult.rows[0]?.cnt ?? 0);
  const totalRevenueCents = Number(countResult.rows[0]?.revenue ?? 0);
  const remaining = Math.max(0, cap - purchased);
  const data: LifetimeStatus = { purchased, cap, remaining, soldOut: purchased >= cap, totalRevenueCents };
  lifetimeStatusCache = { data, expiresAt: now + 30_000 };
  return data;
}

function invalidateLifetimeCache() {
  lifetimeStatusCache = null;
}

// Simple in-memory rate limiter for public lifetime-status endpoint
const lifetimeStatusRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const LIFETIME_STATUS_RATE_LIMIT = 30;
const LIFETIME_STATUS_WINDOW_MS = 60_000;

function isLifetimeStatusRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = lifetimeStatusRateLimitMap.get(ip);
  if (!entry || entry.resetAt <= now) {
    lifetimeStatusRateLimitMap.set(ip, { count: 1, resetAt: now + LIFETIME_STATUS_WINDOW_MS });
    return false;
  }
  entry.count++;
  if (entry.count > LIFETIME_STATUS_RATE_LIMIT) return true;
  return false;
}

function formatCurrencyAmount(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  const upper = (currency || "usd").toUpperCase();
  if (upper === "USD") return `$${amount}`;
  if (upper === "EUR") return `€${amount}`;
  if (upper === "GBP") return `£${amount}`;
  return `${amount} ${upper}`;
}

const PRICE_BIZ = process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? "";
const PRICE_PRO = process.env.STRIPE_PRICE_PRO_MONTHLY ?? "";
const PRICE_BIZ_ANNUAL = process.env.STRIPE_PRICE_BUSINESS_ANNUAL ?? "";
const PRICE_PRO_ANNUAL = process.env.STRIPE_PRICE_PRO_ANNUAL ?? "";

const APP_URL =
  process.env.REPLIT_DEPLOYMENT === "1"
    ? "https://probidcore.net"
    : process.env.APP_URL || "http://localhost:5000";

export async function stripeWebhookHandler(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  let event: Stripe.Event;
  try {
    const sig = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    const msg = err?.message || String(err);
    log("error", "Webhook signature verification failed", { error: msg });
    await trackError({
      message: `Webhook signature verification failed: ${msg}`,
      path: "/api/stripe/webhook",
      method: "POST",
      statusCode: 400,
      level: "error",
    });
    res.status(400).send("Webhook Error");
    return;
  }

  // Event-level idempotency. Stripe will retry on any non-2xx response and
  // occasionally re-deliver after transient network errors, so we insert the
  // event id first and skip the handler entirely on conflict. This protects
  // every event_type path (duplicate `purchases` rows, duplicate emails,
  // duplicate ad-conversion fires, duplicate affiliate-earning attempts).
  try {
    const inserted = await db
      .insert(processedStripeEvents)
      .values({ eventId: event.id, eventType: event.type, receivedAt: now() })
      .onConflictDoNothing({ target: processedStripeEvents.eventId })
      .returning({ eventId: processedStripeEvents.eventId });
    if (inserted.length === 0) {
      log("info", "Skipping duplicate Stripe webhook event", { eventId: event.id, type: event.type });
      res.json({ received: true, duplicate: true });
      return;
    }
  } catch (err: any) {
    log("error", "Failed to record Stripe event for dedup", { eventId: event.id, error: err?.message });
    // Fall through and process anyway — losing dedup is preferable to
    // dropping the event, and Stripe will retry if we 500 here.
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const uid = String((session.metadata as any)?.user_id || "").trim();
        const purchaseType = (session.metadata as any)?.purchase_type;
        const customer = String(session.customer || "").trim();
        // Browser-supplied event_id stashed at checkout-creation time. The
        // browser's `checkout_success` Pixel event uses the same value (read
        // from the success_url query param), so Meta dedupes the two sides.
        const metaEventId = sanitizeMetaEventId((session.metadata as any)?.meta_event_id);
        if (!uid || !customer) {
          log("warn", "checkout.session.completed: missing user_id or customer in metadata", { uid, customer, sessionId: session.id });
          break;
        }
        {
          await upsertStripeCustomer(uid, customer);
          if (
            session.mode === "subscription" ||
            (purchaseType && purchaseType !== "lifetime" && purchaseType !== "single_estimate")
          ) {
            sendAdminSmsAlert(`New subscription: ${purchaseType || "subscription"} — user ${uid}`).catch(err => log("warn", "sendAdminSmsAlert failed for new subscription", { error: err?.message }));
          }
          if (purchaseType === "lifetime") {
            await db.insert(purchases).values({
              id: crypto.randomUUID(),
              userId: uid,
              type: "lifetime",
              stripePaymentIntentId: session.payment_intent as string,
              amountCents: LIFETIME_PRICE_CENTS,
              createdAt: now(),
            });
            invalidateLifetimeCache();
            const postPurchaseStatus = await getLifetimeStatus(true);
            if (postPurchaseStatus.purchased > postPurchaseStatus.cap) {
              sendAdminSmsAlert(
                `Lifetime cap overshot: now at ${postPurchaseStatus.purchased} of ${postPurchaseStatus.cap} — close the entry point immediately`
              ).catch(err => log("warn", "sendAdminSmsAlert failed for lifetime cap overshoot", { error: err?.message }));
            }
            await trackEvent("lifetime_purchased", uid);
            const ltUserResult = await db.select({ email: users.email }).from(users).where(eq(users.id, uid));
            const ltEmail = ltUserResult[0]?.email;
            fireServerConversions("purchase", { email: ltEmail, value: 199, currency: "USD", orderId: session.payment_intent as string, eventId: metaEventId }).catch(() => {});
          } else if (purchaseType === "single_estimate") {
            await db.insert(purchases).values({
              id: crypto.randomUUID(),
              userId: uid,
              type: "single_estimate",
              stripePaymentIntentId: session.payment_intent as string,
              amountCents: 700,
              creditsRemaining: 1,
              createdAt: now(),
            });
            await trackEvent("single_estimate_purchased", uid);
            const seEmail = (await db.select({ email: users.email }).from(users).where(eq(users.id, uid)))[0]?.email;
            fireServerConversions("purchase", { email: seEmail, value: 7, currency: "USD", orderId: session.payment_intent as string, eventId: metaEventId }).catch(() => {});
            const singleUserResult = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, uid));
            const singleUserEmail = singleUserResult[0]?.email;
            if (singleUserEmail) {
              enqueueSingleUpgradeSequence(singleUserEmail, uid).catch(err =>
                log("warn", "Failed to enqueue single upgrade sequence", { error: err?.message })
              );
            }
          } else {
            const upgradeUserResult = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, uid));
            const upgradeUser = upgradeUserResult[0];
            if (upgradeUser?.email) {
              sendUpgradeConfirmationEmail(upgradeUser.email).catch(err => log("warn", "sendUpgradeConfirmationEmail failed", { error: err?.message }));
            }
            await trackEvent("subscription_activated", uid, { purchaseType });
            const subValue = purchaseType === "business" ? 55 : 25;
            fireServerConversions("purchase", { email: upgradeUser?.email, value: subValue, currency: "USD", orderId: session.payment_intent as string, eventId: metaEventId }).catch(() => {});
            // A/B experiment: record paid conversion server-side after confirmed payment
            const abVisitorId = (session.metadata as any)?.ab_visitor_id;
            if (abVisitorId) {
              pool.query(
                `UPDATE ab_experiment_assignments
                 SET converted = true, paid_converted = true, user_id = COALESCE(user_id, $1)
                 WHERE visitor_id = $2 AND experiment_key = 'pricing_guarantee_stack'`,
                [uid, abVisitorId],
              ).catch((err: Error) => log("warn", "AB paid_converted update failed", { error: err.message }));
            }
            const userResult = await db
              .select({ referredByUserId: users.referredByUserId })
              .from(users)
              .where(eq(users.id, uid));
            const user = userResult[0];
            if (user?.referredByUserId) {
              await db
                .update(referrals)
                .set({ status: "subscribed" })
                .where(
                  and(
                    eq(referrals.referrerUserId, user.referredByUserId),
                    eq(referrals.referredUserId, uid),
                  ),
                );
              await trackEvent("referral_subscribed", uid, { affiliateUserId: user.referredByUserId });
            }
          }
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceId = invoice.id;
        const customerId = String(invoice.customer || "");
        const amountPaidCents = invoice.amount_paid || 0;
        if (!customerId || amountPaidCents <= 0) break;

        const rowResult = await db
          .select({ userId: stripeCustomers.userId })
          .from(stripeCustomers)
          .where(eq(stripeCustomers.stripeCustomerId, customerId));
        const row = rowResult[0];

        if (row?.userId) {
          const userId = row.userId as string;
          const userResult = await db
            .select({ referredByUserId: users.referredByUserId })
            .from(users)
            .where(eq(users.id, userId));
          const user = userResult[0];
          if (user?.referredByUserId) {
            const affiliateUserId = user.referredByUserId as string;
            const existingEarningResult = await db
              .select({ id: affiliateEarnings.id })
              .from(affiliateEarnings)
              .where(eq(affiliateEarnings.stripeInvoiceId, invoiceId));
            if (existingEarningResult.length > 0) {
              log("info", "Duplicate invoice - skipping commission", { invoiceId });
              break;
            }
            const affiliateResult = await db
              .select({ commissionRate: users.commissionRate })
              .from(users)
              .where(eq(users.id, affiliateUserId));
            const affiliate = affiliateResult[0];
            const commissionRate = affiliate?.commissionRate ?? 0.2;
            const commissionCents = Math.round(amountPaidCents * commissionRate);
            const earningId = await createAffiliateEarning(affiliateUserId, userId, invoiceId, commissionCents);
            if (earningId) {
              await trackEvent("affiliate_commission_created", affiliateUserId, {
                referredUserId: userId,
                invoiceId,
                amountCents: commissionCents,
                commissionRate,
              });
              log("info", "Created affiliate earning", { commissionCents, affiliateUserId, userId });
            }
          }
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = String(sub.customer);
        const rowResult = await db
          .select({ userId: stripeCustomers.userId })
          .from(stripeCustomers)
          .where(eq(stripeCustomers.stripeCustomerId, customerId));
        const row = rowResult[0];
        if (row?.userId) {
          const userId = row.userId as string;
          const status = sub.status;
          const priceId = sub.items.data?.[0]?.price?.id || null;
          const periodEnd = sub.current_period_end ? sub.current_period_end * 1000 : null;
          const trialEnd = sub.trial_end ? sub.trial_end * 1000 : null;

          // Read previous status and upsert atomically inside a transaction
          // protected by a per-user advisory lock. The lock serializes
          // concurrent webhook deliveries for the same user even when no
          // subscriptions row exists yet (a row-level FOR UPDATE lock can't
          // protect a row that hasn't been inserted). processedStripeEvents
          // only dedups the same event.id, not different events for the
          // same subscription, so this is required to prevent duplicate
          // trial lifecycle events under concurrency.
          const priorStatus = await db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stripe-sub:${userId}`}, 0))`,
            );
            const priorRows = await tx
              .select({ status: subscriptions.status })
              .from(subscriptions)
              .where(eq(subscriptions.userId, userId))
              .limit(1);
            const prev = priorRows[0]?.status ?? null;
            await tx
              .insert(subscriptions)
              .values({ userId, status, priceId, currentPeriodEnd: periodEnd, updatedAt: now() })
              .onConflictDoUpdate({
                target: subscriptions.userId,
                set: { status, priceId, currentPeriodEnd: periodEnd, updatedAt: now() },
              });
            return prev;
          });
          await trackEvent("subscription_updated", userId, { status, priceId });

          // Trial lifecycle events (distinct from generic subscription_updated)
          if (status === "trialing" && priorStatus !== "trialing") {
            await trackEvent("trial_started", userId, { priceId, trialEnd }).catch(() => {});
          }
          // Conversion: trial → paid. The common path is trialing → active.
          // We also count past_due → active when the trial ended very
          // recently (failed first charge then recovered via dunning), but
          // NOT generic past_due → active months later, which would inflate
          // the conversion metric with normal renewal recoveries.
          const TRIAL_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
          const trialEndedRecently =
            trialEnd != null && Date.now() - trialEnd < TRIAL_RECOVERY_WINDOW_MS && Date.now() >= trialEnd;
          if (
            status === "active" &&
            (priorStatus === "trialing" || (priorStatus === "past_due" && trialEndedRecently))
          ) {
            await trackEvent("trial_converted", userId, { priceId, fromStatus: priorStatus }).catch(() => {});
          }
          if (status === "canceled" && priorStatus === "trialing") {
            await trackEvent("trial_cancelled", userId, { priceId }).catch(() => {});
          }

          if (status === "active") {
            import("../lib/automation-engine.js").then(m =>
              m.fireAutomationEvent(userId, "subscription_upgraded", { status, priceId })
            ).catch(() => {});
          }
        }
        break;
      }

      case "customer.subscription.trial_will_end": {
        // Stripe fires this ~3 days before the trial ends. Send a reminder
        // email so the user knows their card is about to be charged and can
        // cancel cleanly if they don't want to continue.
        const sub = event.data.object as Stripe.Subscription;
        const customerId = String(sub.customer);
        const rowResult = await db
          .select({ userId: stripeCustomers.userId })
          .from(stripeCustomers)
          .where(eq(stripeCustomers.stripeCustomerId, customerId));
        const row = rowResult[0];
        if (row?.userId) {
          const userId = row.userId as string;
          const trialEnd = sub.trial_end ? sub.trial_end * 1000 : null;
          await trackEvent("trial_will_end", userId, { trialEnd }).catch(() => {});
          const userRow = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId));
          const userEmail = userRow[0]?.email;
          if (userEmail) {
            await sendTrialEndingSoonEmail(userEmail, trialEnd).catch(err =>
              log("warn", "Failed to send trial-ending email", { error: err?.message })
            );
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = String(sub.customer);
        const rowResult = await db
          .select({ userId: stripeCustomers.userId })
          .from(stripeCustomers)
          .where(eq(stripeCustomers.stripeCustomerId, customerId));
        const row = rowResult[0];
        if (row?.userId) {
          const userId = row.userId as string;
          const status = sub.status;
          const priceId = sub.items.data?.[0]?.price?.id || null;
          const periodEnd = sub.current_period_end ? sub.current_period_end * 1000 : null;
          // Atomic prior-status read + upsert (see created/updated handler
          // above for rationale). We need the prior status here too so we
          // can emit a trial_cancelled event when a trial is cancelled
          // outright via subscription.deleted (vs. transitioning through
          // status='canceled' on subscription.updated).
          const priorStatus = await db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stripe-sub:${userId}`}, 0))`,
            );
            const priorRows = await tx
              .select({ status: subscriptions.status })
              .from(subscriptions)
              .where(eq(subscriptions.userId, userId))
              .limit(1);
            const prev = priorRows[0]?.status ?? null;
            await tx
              .insert(subscriptions)
              .values({ userId, status, priceId, currentPeriodEnd: periodEnd, updatedAt: now() })
              .onConflictDoUpdate({
                target: subscriptions.userId,
                set: { status, priceId, currentPeriodEnd: periodEnd, updatedAt: now() },
              });
            return prev;
          });
          if (priorStatus === "trialing") {
            await trackEvent("trial_cancelled", userId, { priceId, via: "subscription.deleted" }).catch(() => {});
          }
          const userResult = await db
            .select({ referredByUserId: users.referredByUserId })
            .from(users)
            .where(eq(users.id, userId));
          const user = userResult[0];
          if (user?.referredByUserId) {
            await db
              .update(referrals)
              .set({ status: "cancelled" })
              .where(
                and(
                  eq(referrals.referrerUserId, user.referredByUserId),
                  eq(referrals.referredUserId, userId),
                ),
              );
            await trackEvent("referral_cancelled", userId, { affiliateUserId: user.referredByUserId });
          }
          await trackEvent("subscription_updated", userId, { status, priceId });
          import("../lib/automation-engine.js").then(m =>
            m.fireAutomationEvent(userId, "subscription_cancelled", { status, priceId })
          ).catch(() => {});
          const cancelledUserResult = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId));
          const cancelledUserEmail = cancelledUserResult[0]?.email;
          if (cancelledUserEmail) {
            enqueueWinbackSequence(cancelledUserEmail, userId).catch(err =>
              log("warn", "Failed to enqueue win-back sequence", { error: err?.message })
            );
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = String(invoice.customer || "");
        const invoiceId = invoice.id;
        const amountDueCents = invoice.amount_due || 0;
        const currency = invoice.currency || "usd";
        if (!customerId || !invoiceId) break;

        const rowResult = await db
          .select({ userId: stripeCustomers.userId })
          .from(stripeCustomers)
          .where(eq(stripeCustomers.stripeCustomerId, customerId));
        const row = rowResult[0];
        if (!row?.userId) {
          log("warn", "invoice.payment_failed: no user for customer", { customerId });
          break;
        }

        const userId = row.userId as string;
        const userResult = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, userId));
        const userEmail = userResult[0]?.email;
        if (!userEmail) {
          log("warn", "invoice.payment_failed: no email for user", { userId });
          break;
        }

        const nowMs = now();
        const insertResult = await db
          .insert(dunningEvents)
          .values({
            userId,
            stripeCustomerId: customerId,
            stripeInvoiceId: invoiceId,
            amountDueCents,
            currency,
            firstFailedAt: nowMs,
            status: "active",
          })
          .onConflictDoNothing()
          .returning({ id: dunningEvents.id });

        let eventId: number;
        let isRetry = false;

        if (insertResult.length === 0) {
          const existing = await db
            .select({ id: dunningEvents.id, immediateEmailSentAt: dunningEvents.immediateEmailSentAt })
            .from(dunningEvents)
            .where(eq(dunningEvents.stripeInvoiceId, invoiceId));
          if (existing[0] && !existing[0].immediateEmailSentAt) {
            eventId = existing[0].id;
            isRetry = true;
            log("info", "Retrying immediate dunning email for existing event", { invoiceId });
          } else {
            log("info", "Dunning event already exists for invoice, skipping", { invoiceId });
            break;
          }
        } else {
          eventId = insertResult[0].id;
        }

        const amountFormatted = formatCurrencyAmount(amountDueCents, currency);
        const nextRetryTimestamp = "next_payment_attempt" in invoice
          ? (invoice as Stripe.Invoice & { next_payment_attempt?: number | null }).next_payment_attempt
          : null;
        const nextRetryDate = nextRetryTimestamp
          ? new Date(nextRetryTimestamp * 1000).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })
          : null;

        let billingPortalUrl = `${APP_URL}/app/billing`;
        try {
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${APP_URL}/app/billing`,
          });
          billingPortalUrl = portalSession.url;
        } catch {
          log("warn", "Could not create billing portal session for dunning email", { customerId });
        }

        const CANONICAL_URL = "https://probidcore.net";
        const unsubUrl = `${CANONICAL_URL}/app/billing`;

        try {
          await sendDunningImmediateEmail(userEmail, amountFormatted, nextRetryDate, billingPortalUrl, unsubUrl);
          await db
            .update(dunningEvents)
            .set({ immediateEmailSentAt: now() })
            .where(eq(dunningEvents.id, eventId));
          log("info", "Dunning immediate email sent successfully", { userId, invoiceId, isRetry });
        } catch {
          log("warn", "Immediate dunning email failed, will retry on next webhook delivery", { userId, invoiceId });
        }

        sendAdminSmsAlert(`Payment failed: user ${userId}, amount ${amountFormatted}`).catch(err => log("warn", "sendAdminSmsAlert failed for payment failure", { error: err?.message }));
        notifyFailedPayment(userId).catch(err => log("warn", "Push notification for failed_payment failed", { error: err?.message }));
        await trackEvent("payment_failed", userId, { invoiceId, amountDueCents, currency });

        log("info", "Dunning event processed", { userId, invoiceId, amountDueCents, isRetry });
        break;
      }
    }
    res.json({ received: true });
  } catch (err: any) {
    log("error", "Webhook error", { error: err?.message || err, eventId: event.id, type: event.type });
    // Roll back the dedup row so Stripe's retry can reprocess this event.
    // Without this we'd permanently drop the event after the first failure.
    try {
      await db.delete(processedStripeEvents).where(eq(processedStripeEvents.eventId, event.id));
    } catch (delErr: any) {
      log("error", "Failed to roll back dedup row after webhook error", {
        eventId: event.id,
        error: delErr?.message,
      });
    }
    res.status(500).json({ error: "Webhook error" });
  }
}

export function registerBillingRoutes(app: express.Application): void {
  // GET /api/billing/prices — live Stripe prices for monthly + annual on each tier
  app.get(
    "/api/billing/prices",
    asyncHandler(async (_req, res) => {
      const ids: Record<string, string> = {
        proMonthly: PRICE_PRO,
        proAnnual: PRICE_PRO_ANNUAL,
        businessMonthly: PRICE_BIZ,
        businessAnnual: PRICE_BIZ_ANNUAL,
      };
      const out: Record<string, { amount: number | null; currency: string | null; interval: string | null }> = {};
      for (const [key, id] of Object.entries(ids)) {
        if (!id) {
          out[key] = { amount: null, currency: null, interval: null };
          continue;
        }
        try {
          const p = await stripe.prices.retrieve(id);
          out[key] = {
            amount: p.unit_amount ?? null,
            currency: p.currency ?? null,
            interval: p.recurring?.interval ?? null,
          };
        } catch (err) {
          log("warn", "Failed to fetch Stripe price", { id, error: String(err) });
          out[key] = { amount: null, currency: null, interval: null };
        }
      }
      res.json({ success: true, data: out });
    })
  );

  // GET /api/billing/status — subscription plan & status
  app.get(
    "/api/billing/status",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const lifetimeResult = await db
        .select()
        .from(purchases)
        .where(and(eq(purchases.userId, uid), eq(purchases.type, "lifetime")));
      if (lifetimeResult.length > 0) {
        return res.json({
          success: true,
          data: { plan: "lifetime", status: "active", interval: "monthly" },
        });
      }

      const effectiveSub = await getEffectiveSub(uid);

      if (!effectiveSub) {
        const sub = await getSub(uid);
        if (!sub) return res.json({ success: true, data: { plan: "free", status: "free" } });
        return res.json({
          success: true,
          data: { plan: "free", status: sub.status, priceId: sub.priceId, interval: "monthly" },
        });
      }

      let plan = "free";
      if (effectiveSub.priceId === PRICE_BIZ || effectiveSub.priceId === PRICE_BIZ_ANNUAL) plan = "business";
      else plan = "pro";

      const sub = await getSub(uid);
      const annualPriceIds = [PRICE_PRO_ANNUAL, PRICE_BIZ_ANNUAL].filter(Boolean);
      const interval = annualPriceIds.includes(effectiveSub.priceId ?? "") ? "annual" : "monthly";

      res.json({
        success: true,
        data: {
          plan,
          status: effectiveSub.status,
          currentPeriodEnd: sub?.currentPeriodEnd
            ? Math.floor(new Date(sub.currentPeriodEnd).getTime() / 1000)
            : null,
          priceId: effectiveSub.priceId,
          interval,
        },
      });
    }),
  );

  app.get(
    "/api/entitlements",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const [effectiveSub, lifetimeResult] = await Promise.all([
        getEffectiveSub(uid),
        db.select().from(purchases).where(and(eq(purchases.userId, uid), eq(purchases.type, "lifetime"))),
      ]);

      const isLifetime = lifetimeResult.length > 0;
      const isActiveSub = !!(effectiveSub && (effectiveSub.status === "active" || effectiveSub.status === "trialing" || effectiveSub.status === "past_due"));
      const isBusiness = isLifetime || (isActiveSub && isBusinessTier(effectiveSub!.priceId));
      const isPaid = isActiveSub || isLifetime;

      let plan: "free" | "pro" | "business" | "lifetime" = "free";
      if (isLifetime) plan = "lifetime";
      else if (isBusiness) plan = "business";
      else if (isActiveSub) plan = "pro";

      res.json({
        success: true,
        data: {
          plan,
          procore: isBusiness,
          teams: isBusiness,
          unlimited_estimates: isPaid,
          api_access: isBusiness,
          custom_branding: isBusiness,
          analytics_dashboard: isBusiness,
          priority_support: isBusiness,
        },
      });
    }),
  );

  // POST /api/billing/create-checkout-session — returns Stripe checkout URL
  app.post(
    "/api/billing/create-checkout-session",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const plan = req.body?.plan === "business" ? "business" : "pro";
      const interval = req.body?.interval === "annual" ? "annual" : "monthly";
      const metaEventId = sanitizeMetaEventId(req.body?.meta_event_id);
      const visitorId = typeof req.body?.visitor_id === "string" && req.body.visitor_id.length <= 128
        ? req.body.visitor_id
        : undefined;

      let priceId: string;
      if (interval === "annual") {
        const annualId = plan === "business" ? PRICE_BIZ_ANNUAL : PRICE_PRO_ANNUAL;
        if (!annualId) {
          return res.status(400).json({ success: false, error: "Annual plan is not available yet. Please try monthly." });
        }
        priceId = annualId;
      } else {
        priceId = plan === "business" ? PRICE_BIZ : PRICE_PRO;
      }

      const email = req.session!.email!;
      let customerId = await getStripeCustomerIdOrNull(uid);
      if (!customerId) {
        customerId = await createStripeCustomer(email);
        await upsertStripeCustomer(uid, customerId);
      }

      const existingSub = await db.select().from(subscriptions).where(eq(subscriptions.userId, uid)).limit(1);
      const hasHadSubscription = existingSub.length > 0;

      // Block double-subscribing. If they already have a live sub, send them to the
      // Customer Portal to change plans rather than creating a parallel subscription.
      const current = existingSub[0];
      if (current && (current.status === "active" || current.status === "trialing" || current.status === "past_due")) {
        const portalUrl = "/billing/portal";
        if (current.priceId === priceId) {
          return res.status(409).json({
            success: false,
            error: "You're already subscribed to this plan.",
            code: "already_subscribed",
            portal_url: portalUrl,
            next_action: "customer_portal",
          });
        }
        return res.status(409).json({
          success: false,
          error: "You already have an active subscription. Use the Customer Portal to change plans.",
          code: "subscription_exists",
          portal_url: portalUrl,
          next_action: "customer_portal",
        });
      }

      const successQs = metaEventId
        ? `success=1&plan=${plan}&meta_event_id=${encodeURIComponent(metaEventId)}`
        : `success=1&plan=${plan}`;
      const sessionConfig: any = {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: `${APP_URL}/app/billing?${successQs}`,
        cancel_url: `${APP_URL}/app/billing`,
        metadata: {
          user_id: uid,
          purchase_type: "subscription",
          plan,
          interval,
          ...(metaEventId ? { meta_event_id: metaEventId } : {}),
          ...(visitorId ? { ab_visitor_id: visitorId } : {}),
        },
      };

      if (!hasHadSubscription) {
        sessionConfig.subscription_data = { trial_period_days: 7 };
        sessionConfig.payment_method_collection = "if_required";
      }

      const session = await stripe.checkout.sessions.create(sessionConfig);

      await trackEvent("checkout_started", uid, { plan, interval }).catch(err => log("warn", "trackEvent checkout_started failed", { error: err?.message }));
      res.json({ success: true, data: { url: session.url! } });
    }),
  );

  const PRICE_SINGLE = process.env.STRIPE_PRICE_SINGLE_ESTIMATE || "";

  app.post(
    "/api/billing/single-estimate-checkout",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const email = req.session!.email!;
      let customerId = await getStripeCustomerIdOrNull(uid);
      if (!customerId) {
        customerId = await createStripeCustomer(email);
        await upsertStripeCustomer(uid, customerId);
      }

      const metaEventId = sanitizeMetaEventId(req.body?.meta_event_id);
      const successQs = metaEventId
        ? `purchased=single&meta_event_id=${encodeURIComponent(metaEventId)}`
        : `purchased=single`;
      const sessionConfig: any = {
        mode: "payment" as const,
        customer: customerId,
        success_url: `${APP_URL}/app/estimate/new?${successQs}`,
        cancel_url: `${APP_URL}/app/estimate/new`,
        metadata: metaEventId
          ? { user_id: uid, purchase_type: "single_estimate", meta_event_id: metaEventId }
          : { user_id: uid, purchase_type: "single_estimate" },
      };

      if (PRICE_SINGLE) {
        sessionConfig.line_items = [{ price: PRICE_SINGLE, quantity: 1 }];
      } else {
        sessionConfig.line_items = [{
          price_data: {
            currency: "usd",
            product_data: { name: "Single Estimate - ProBid AI" },
            unit_amount: 700,
          },
          quantity: 1,
        }];
      }

      const session = await stripe.checkout.sessions.create(sessionConfig);
      await trackEvent("single_estimate_checkout_started", uid).catch(() => {});
      res.json({ success: true, data: { url: session.url! } });
    }),
  );

  // GET /api/billing/lifetime-status — public, rate-limited
  app.get(
    "/api/billing/lifetime-status",
    asyncHandler(async (req, res) => {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
      if (isLifetimeStatusRateLimited(ip)) {
        return res.status(429).json({ success: false, error: "Rate limit exceeded. Try again in a minute." });
      }
      const status = await getLifetimeStatus();
      res.json({
        success: true,
        data: { remaining: status.remaining, cap: status.cap, soldOut: status.soldOut, purchased: status.purchased },
      });
    }),
  );

  // GET /api/admin/lifetime-cap — admin only
  app.get(
    "/api/admin/lifetime-cap",
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const status = await getLifetimeStatus();
      res.json({
        success: true,
        data: {
          purchased: status.purchased,
          cap: status.cap,
          remaining: status.remaining,
          soldOut: status.soldOut,
          totalRevenueCents: status.totalRevenueCents,
          totalRevenueDollars: status.totalRevenueCents / 100,
          arrOpportunityCostDollars: status.purchased * 300,
        },
      });
    }),
  );

  // PUT /api/admin/lifetime-cap — admin only, update the cap
  app.put(
    "/api/admin/lifetime-cap",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const { cap } = req.body as { cap?: unknown };
      if (cap === undefined || cap === null) {
        return res.status(400).json({ success: false, error: "cap is required" });
      }
      const n = Number(cap);
      if (!Number.isFinite(n) || n < 1 || n > 10000 || !Number.isInteger(n)) {
        return res.status(400).json({ success: false, error: "cap must be a whole number between 1 and 10000" });
      }
      await setLifetimeCap(n);
      invalidateLifetimeCache();
      const status = await getLifetimeStatus(true);
      res.json({
        success: true,
        data: {
          cap: status.cap,
          purchased: status.purchased,
          remaining: status.remaining,
          soldOut: status.soldOut,
        },
      });
    }),
  );
}
