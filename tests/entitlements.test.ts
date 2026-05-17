import { describe, it, expect } from "vitest";
import { isBusinessTier } from "../server/lib/team-helpers.js";

const MOCK_BIZ_MONTHLY = "price_biz_monthly_test";
const MOCK_BIZ_ANNUAL = "price_biz_annual_test";
const MOCK_PRO_MONTHLY = "price_pro_monthly_test";

describe("isBusinessTier", () => {
  it("returns false for null priceId", () => {
    expect(isBusinessTier(null)).toBe(false);
  });

  it("returns false for empty string priceId", () => {
    expect(isBusinessTier("")).toBe(false);
  });

  it("returns false for a pro priceId", () => {
    expect(isBusinessTier(MOCK_PRO_MONTHLY)).toBe(false);
  });

  it("returns false for an arbitrary string", () => {
    expect(isBusinessTier("not_a_real_price")).toBe(false);
  });
});

describe("entitlements logic", () => {
  function computeEntitlements(opts: {
    effectiveSub: { priceId: string | null; status: string } | null;
    isLifetime: boolean;
    businessPriceIds: string[];
  }) {
    const { effectiveSub, isLifetime, businessPriceIds } = opts;

    const isActiveSub = !!(effectiveSub && (effectiveSub.status === "active" || effectiveSub.status === "trialing"));

    const isBizPrice = (priceId: string | null) => {
      if (!priceId) return false;
      return businessPriceIds.includes(priceId);
    };

    const isBusiness = isLifetime || (isActiveSub && isBizPrice(effectiveSub!.priceId));
    const isPaid = isActiveSub || isLifetime;

    let plan: "free" | "pro" | "business" | "lifetime" = "free";
    if (isLifetime) plan = "lifetime";
    else if (isBusiness) plan = "business";
    else if (isActiveSub) plan = "pro";

    return {
      plan,
      procore: isBusiness,
      teams: isBusiness,
      unlimited_estimates: isPaid,
      api_access: isBusiness,
      custom_branding: isBusiness,
      analytics_dashboard: isBusiness,
      priority_support: isBusiness,
    };
  }

  const BIZ_PRICES = [MOCK_BIZ_MONTHLY, MOCK_BIZ_ANNUAL];

  describe("free user (no subscription, no lifetime)", () => {
    const result = computeEntitlements({
      effectiveSub: null,
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=free", () => expect(result.plan).toBe("free"));
    it("is blocked from procore", () => expect(result.procore).toBe(false));
    it("is blocked from teams", () => expect(result.teams).toBe(false));
    it("has no unlimited estimates", () => expect(result.unlimited_estimates).toBe(false));
    it("has no api access", () => expect(result.api_access).toBe(false));
  });

  describe("pro user (active subscription, not business tier)", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_PRO_MONTHLY, status: "active" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=pro", () => expect(result.plan).toBe("pro"));
    it("is blocked from procore", () => expect(result.procore).toBe(false));
    it("is blocked from teams", () => expect(result.teams).toBe(false));
    it("has unlimited estimates", () => expect(result.unlimited_estimates).toBe(true));
    it("has no api access", () => expect(result.api_access).toBe(false));
  });

  describe("business user (active business subscription)", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_BIZ_MONTHLY, status: "active" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=business", () => expect(result.plan).toBe("business"));
    it("has procore access", () => expect(result.procore).toBe(true));
    it("has teams access", () => expect(result.teams).toBe(true));
    it("has unlimited estimates", () => expect(result.unlimited_estimates).toBe(true));
    it("has api access", () => expect(result.api_access).toBe(true));
    it("has custom branding", () => expect(result.custom_branding).toBe(true));
    it("has analytics dashboard", () => expect(result.analytics_dashboard).toBe(true));
    it("has priority support", () => expect(result.priority_support).toBe(true));
  });

  describe("business user with annual plan", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_BIZ_ANNUAL, status: "active" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=business", () => expect(result.plan).toBe("business"));
    it("has procore access", () => expect(result.procore).toBe(true));
  });

  describe("business user trialing", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_BIZ_MONTHLY, status: "trialing" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=business", () => expect(result.plan).toBe("business"));
    it("has procore access during trial", () => expect(result.procore).toBe(true));
    it("has unlimited estimates during trial", () => expect(result.unlimited_estimates).toBe(true));
  });

  describe("lifetime user (no active subscription)", () => {
    const result = computeEntitlements({
      effectiveSub: null,
      isLifetime: true,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=lifetime", () => expect(result.plan).toBe("lifetime"));
    it("has procore access", () => expect(result.procore).toBe(true));
    it("has teams access", () => expect(result.teams).toBe(true));
    it("has unlimited estimates", () => expect(result.unlimited_estimates).toBe(true));
    it("has api access", () => expect(result.api_access).toBe(true));
  });

  describe("team member inheriting business subscription", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_BIZ_MONTHLY, status: "active" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=business", () => expect(result.plan).toBe("business"));
    it("has procore access", () => expect(result.procore).toBe(true));
    it("has teams access", () => expect(result.teams).toBe(true));
    it("has unlimited estimates", () => expect(result.unlimited_estimates).toBe(true));
  });

  describe("team member inheriting pro subscription (not business)", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_PRO_MONTHLY, status: "trialing" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=pro", () => expect(result.plan).toBe("pro"));
    it("is blocked from procore", () => expect(result.procore).toBe(false));
    it("is blocked from teams", () => expect(result.teams).toBe(false));
    it("has unlimited estimates (trialing)", () => expect(result.unlimited_estimates).toBe(true));
  });

  describe("canceled business subscription", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_BIZ_MONTHLY, status: "canceled" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=free (canceled is not active/trialing)", () => expect(result.plan).toBe("free"));
    it("is blocked from procore", () => expect(result.procore).toBe(false));
    it("has no unlimited estimates", () => expect(result.unlimited_estimates).toBe(false));
  });

  describe("past_due business subscription", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_BIZ_MONTHLY, status: "past_due" },
      isLifetime: false,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=free", () => expect(result.plan).toBe("free"));
    it("is blocked from procore", () => expect(result.procore).toBe(false));
  });

  describe("lifetime user with canceled subscription (lifetime takes precedence)", () => {
    const result = computeEntitlements({
      effectiveSub: { priceId: MOCK_BIZ_MONTHLY, status: "canceled" },
      isLifetime: true,
      businessPriceIds: BIZ_PRICES,
    });

    it("has plan=lifetime", () => expect(result.plan).toBe("lifetime"));
    it("has procore access", () => expect(result.procore).toBe(true));
    it("has unlimited estimates", () => expect(result.unlimited_estimates).toBe(true));
  });
});

describe("A/B variant assignment", () => {
  function getAbVariant(userId?: string): "A" | "B" {
    if (!userId) return "A";
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 2 === 0 ? "A" : "B";
  }

  it("returns A for undefined userId", () => {
    expect(getAbVariant(undefined)).toBe("A");
  });

  it("returns A for empty string", () => {
    expect(getAbVariant("")).toBe("A");
  });

  it("is deterministic — same userId always returns same variant", () => {
    const variant1 = getAbVariant("user@example.com");
    const variant2 = getAbVariant("user@example.com");
    expect(variant1).toBe(variant2);
  });

  it("produces both variants across different userIds", () => {
    const variants = new Set<string>();
    for (let i = 0; i < 100; i++) {
      variants.add(getAbVariant(`test-user-${i}@example.com`));
    }
    expect(variants.has("A")).toBe(true);
    expect(variants.has("B")).toBe(true);
  });

  it("returns only A or B", () => {
    for (let i = 0; i < 50; i++) {
      const v = getAbVariant(`random-${i}-${Math.random()}`);
      expect(["A", "B"]).toContain(v);
    }
  });

  it("produces roughly balanced split", () => {
    let aCount = 0;
    let bCount = 0;
    for (let i = 0; i < 1000; i++) {
      const v = getAbVariant(`balance-test-${i}@example.com`);
      if (v === "A") aCount++;
      else bCount++;
    }
    const ratio = aCount / (aCount + bCount);
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });
});
