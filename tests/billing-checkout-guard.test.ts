import { describe, it, expect } from "vitest";

/**
 * Tests for the "already-subscribed" guard in POST /api/billing/create-checkout-session.
 *
 * The guard prevents creating a parallel Stripe subscription when the user already
 * has one in active|trialing|past_due, redirecting them to the Customer Portal
 * for plan changes / payment recovery instead.
 *
 * This mirrors the route logic in server/routes/billing.ts (around the
 * existingSub[0] check) so we can verify decision branches without spinning up
 * a full Express + Stripe + DB integration test.
 */

type SubStatus = "active" | "trialing" | "past_due" | "canceled" | "unpaid" | "incomplete";

interface GuardResult {
  status: number;
  body:
    | { success: true }
    | {
        success: false;
        error: string;
        code: "already_subscribed" | "subscription_exists";
        portal_url: string;
        next_action: "customer_portal";
      };
}

function checkoutGuard(opts: {
  existingSub: { status: SubStatus; priceId: string } | null;
  requestedPriceId: string;
}): GuardResult {
  const { existingSub, requestedPriceId } = opts;
  if (
    existingSub &&
    (existingSub.status === "active" ||
      existingSub.status === "trialing" ||
      existingSub.status === "past_due")
  ) {
    const portalUrl = "/billing/portal";
    if (existingSub.priceId === requestedPriceId) {
      return {
        status: 409,
        body: {
          success: false,
          error: "You're already subscribed to this plan.",
          code: "already_subscribed",
          portal_url: portalUrl,
          next_action: "customer_portal",
        },
      };
    }
    return {
      status: 409,
      body: {
        success: false,
        error: "You already have an active subscription. Use the Customer Portal to change plans.",
        code: "subscription_exists",
        portal_url: portalUrl,
        next_action: "customer_portal",
      },
    };
  }
  return { status: 200, body: { success: true } };
}

const PRO = "price_pro_monthly_test";
const PRO_ANNUAL = "price_pro_annual_test";
const BIZ = "price_biz_monthly_test";

describe("checkout-session 409 guard", () => {
  describe("blocks creating a parallel subscription", () => {
    it("active + same plan → 409 already_subscribed", () => {
      const r = checkoutGuard({
        existingSub: { status: "active", priceId: PRO },
        requestedPriceId: PRO,
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        success: false,
        code: "already_subscribed",
        portal_url: "/billing/portal",
        next_action: "customer_portal",
      });
    });

    it("trialing + same plan → 409 already_subscribed", () => {
      const r = checkoutGuard({
        existingSub: { status: "trialing", priceId: BIZ },
        requestedPriceId: BIZ,
      });
      expect(r.status).toBe(409);
      expect((r.body as any).code).toBe("already_subscribed");
    });

    it("past_due + same plan → 409 already_subscribed (recovers via portal)", () => {
      const r = checkoutGuard({
        existingSub: { status: "past_due", priceId: PRO },
        requestedPriceId: PRO,
      });
      expect(r.status).toBe(409);
      expect((r.body as any).code).toBe("already_subscribed");
      expect((r.body as any).portal_url).toBe("/billing/portal");
    });

    it("active + different plan → 409 subscription_exists (upgrade via portal)", () => {
      const r = checkoutGuard({
        existingSub: { status: "active", priceId: PRO },
        requestedPriceId: BIZ,
      });
      expect(r.status).toBe(409);
      expect((r.body as any).code).toBe("subscription_exists");
    });

    it("active monthly → annual same tier counts as different plan (Stripe-side change)", () => {
      const r = checkoutGuard({
        existingSub: { status: "active", priceId: PRO },
        requestedPriceId: PRO_ANNUAL,
      });
      expect(r.status).toBe(409);
      expect((r.body as any).code).toBe("subscription_exists");
    });

    it("every 409 response carries portal_url + next_action for client redirect", () => {
      const cases = [
        { sub: { status: "active" as SubStatus, priceId: PRO }, requested: PRO },
        { sub: { status: "active" as SubStatus, priceId: PRO }, requested: BIZ },
        { sub: { status: "trialing" as SubStatus, priceId: BIZ }, requested: BIZ },
        { sub: { status: "past_due" as SubStatus, priceId: PRO }, requested: PRO },
      ];
      for (const c of cases) {
        const r = checkoutGuard({ existingSub: c.sub, requestedPriceId: c.requested });
        expect(r.status).toBe(409);
        expect((r.body as any).portal_url).toBe("/billing/portal");
        expect((r.body as any).next_action).toBe("customer_portal");
      }
    });
  });

  describe("allows checkout creation", () => {
    it("no existing subscription → allow", () => {
      const r = checkoutGuard({ existingSub: null, requestedPriceId: PRO });
      expect(r.status).toBe(200);
    });

    it("canceled subscription → allow re-subscribe", () => {
      const r = checkoutGuard({
        existingSub: { status: "canceled", priceId: PRO },
        requestedPriceId: PRO,
      });
      expect(r.status).toBe(200);
    });

    it("unpaid subscription → allow re-subscribe (Stripe gave up dunning)", () => {
      const r = checkoutGuard({
        existingSub: { status: "unpaid", priceId: PRO },
        requestedPriceId: PRO,
      });
      expect(r.status).toBe(200);
    });

    it("incomplete subscription → allow (initial payment never confirmed)", () => {
      const r = checkoutGuard({
        existingSub: { status: "incomplete", priceId: BIZ },
        requestedPriceId: BIZ,
      });
      expect(r.status).toBe(200);
    });
  });
});
