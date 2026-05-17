import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

const FAKE_USER_ID = "user-test-123";

const fakeTx = {
  insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
};

const fakeDb: any = {
  transaction: vi.fn(async (cb: any) => cb(fakeTx)),
  insert: vi.fn(() => {
    const p: any = Promise.resolve();
    p.values = vi.fn(() => Promise.resolve());
    return p;
  }),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  })),
};

vi.mock("../server/db.js", () => ({ db: fakeDb }));

vi.mock("../server/lib/audit.js", () => ({
  auditSecurityEvent: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../server/lib/analytics.js", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/routes/notifications.js", () => ({
  notifyEstimateReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/lib/email-helpers.js", () => ({
  sendUpsellEmail: vi.fn(),
  scheduleFollowUpEmail: vi.fn(),
}));

vi.mock("../server/lib/automation-engine.js", () => ({
  fireAutomationEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/lib/ai.js", () => ({
  generateAIEstimate: vi.fn().mockResolvedValue("AI text"),
  extractStructuredLineItems: vi.fn().mockResolvedValue([]),
}));

vi.mock("../server/lib/upload.js", () => ({
  upload: { array: () => (_req: any, _res: any, next: any) => next() },
}));

vi.mock("../server/replit_integrations/audio/client.js", () => ({
  speechToText: vi.fn(),
  convertWebmToWav: vi.fn(),
}));

const userHelpersMock = {
  getSub: vi.fn().mockResolvedValue(undefined),
  isPaidActive: vi.fn().mockReturnValue(false),
  getTotalEstimates: vi.fn().mockResolvedValue(0),
  incrementUsage: vi.fn().mockResolvedValue(1),
  enforcePaywall: vi.fn().mockResolvedValue({ ok: true, tier: "free", used: 0 }),
  consumeSingleCredit: vi.fn().mockResolvedValue(true),
  getDailyUsage: vi.fn().mockResolvedValue(0),
  FREE_ESTIMATES_LIFETIME: 2,
};

vi.mock("../server/lib/user-helpers.js", () => userHelpersMock);

const { registerEstimateRoutes } = await import("../server/routes/estimates.js");

let server: http.Server;
let baseUrl: string;
let injectSession: { uid?: string; csrfToken?: string } | null = null;
let sdkInjector: { uid: string; signature: string } | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (sdkInjector) {
      req.session = { uid: sdkInjector.uid };
      req.isSdkAuth = true;
      req.sdkSignature = sdkInjector.signature;
    } else if (injectSession) {
      req.session = { ...injectSession };
    }
    next();
  });
  registerEstimateRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  injectSession = null;
  vi.clearAllMocks();
  userHelpersMock.getSub.mockResolvedValue(undefined);
  userHelpersMock.isPaidActive.mockReturnValue(false);
  userHelpersMock.getTotalEstimates.mockResolvedValue(0);
  userHelpersMock.incrementUsage.mockResolvedValue(1);
  userHelpersMock.enforcePaywall.mockResolvedValue({ ok: true, tier: "free", used: 0 });
  userHelpersMock.consumeSingleCredit.mockResolvedValue(true);
  userHelpersMock.getDailyUsage.mockResolvedValue(0);
});

const FAKE_CSRF = "test-csrf-token";

function send(body: unknown, opts: { skipCsrf?: boolean; csrfHeader?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.skipCsrf) {
    headers["x-csrf-token"] = opts.csrfHeader ?? FAKE_CSRF;
  }
  return fetch(`${baseUrl}/api/estimates/send`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_PAYLOAD = {
  name: "Kitchen Remodel Estimate",
  source: "partner-crm",
  jobType: "Remodel",
  market: "Austin, TX",
  details: "Full gut renovation",
  clientName: "Jane Smith",
  clientEmail: "jane@example.com",
  clientPhone: "555-0100",
  lineItems: [
    { description: "Demolition", quantity: 1, unitCost: 1500, costType: "Labor" },
    { description: "Cabinets", quantity: 12, unitCost: 350, uom: "ea", costType: "Materials" },
  ],
};

describe("POST /api/estimates/send", () => {
  it("creates an estimate, persists line items, and returns computed totals on a valid payload", async () => {
    injectSession = { uid: FAKE_USER_ID, csrfToken: FAKE_CSRF };

    const res = await send(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.estimateId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data.name).toBe(VALID_PAYLOAD.name);
    expect(body.data.source).toBe("partner-crm");
    expect(body.data.lineItems).toHaveLength(2);
    expect(body.data.lineItems[0]).toMatchObject({
      description: "Demolition",
      quantity: 1,
      unitCost: 1500,
      lineTotal: 1500,
      sortOrder: 0,
    });
    expect(body.data.lineItems[1]).toMatchObject({
      description: "Cabinets",
      quantity: 12,
      unitCost: 350,
      lineTotal: 4200,
      sortOrder: 1,
    });
    expect(body.data.totals.subtotal).toBe(5700);
    expect(body.data.totals.total).toBe(5700);
    expect(body.data.totals.itemCount).toBe(2);
    expect(body.data.totals.byCostType).toEqual({ Labor: 1500, Materials: 4200 });

    // Quota gate was consulted; usage increment was called for free-tier user.
    expect(userHelpersMock.enforcePaywall).toHaveBeenCalledWith(FAKE_USER_ID);
    expect(userHelpersMock.incrementUsage).toHaveBeenCalledWith(FAKE_USER_ID);

    // The estimate + line items insert went through the DB transaction.
    expect(fakeDb.transaction).toHaveBeenCalledTimes(1);
    expect(fakeTx.insert).toHaveBeenCalledTimes(2);
  });

  it("returns 403 when a session-authenticated caller omits the CSRF token", async () => {
    injectSession = { uid: FAKE_USER_ID, csrfToken: FAKE_CSRF };

    const res = await send(VALID_PAYLOAD, { skipCsrf: true });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/csrf/i);

    expect(userHelpersMock.enforcePaywall).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
  });

  it("returns 403 when the submitted CSRF header doesn't match the session token", async () => {
    injectSession = { uid: FAKE_USER_ID, csrfToken: FAKE_CSRF };

    const res = await send(VALID_PAYLOAD, { csrfHeader: "wrong-token" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/csrf/i);

    expect(userHelpersMock.enforcePaywall).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
  });

  it("accepts the SDK-auth CSRF token (signature from the dedicated cookie)", async () => {
    // Simulate sdkSessionMiddleware having already populated the session
    // and the SDK-auth flag with a known signature.
    const sdkSig = "deadbeefcafebabe1234";
    injectSession = null;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-csrf-token": sdkSig,
    };
    // Inject a synthetic session+sdk flag mid-pipeline by piggy-backing
    // on the existing session injector below.
    sdkInjector = { uid: FAKE_USER_ID, signature: sdkSig };

    const res = await fetch(`${baseUrl}/api/estimates/send`, {
      method: "POST",
      headers,
      body: JSON.stringify(VALID_PAYLOAD),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    sdkInjector = null;
  });

  it("rejects an SDK-auth caller whose CSRF header doesn't match the cookie signature", async () => {
    sdkInjector = { uid: FAKE_USER_ID, signature: "the-real-signature" };

    const res = await fetch(`${baseUrl}/api/estimates/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "wrong-sig" },
      body: JSON.stringify(VALID_PAYLOAD),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/csrf/i);

    sdkInjector = null;
  });

  it("returns 401 when the caller is unauthenticated (no session, no API key)", async () => {
    injectSession = null;

    const res = await send(VALID_PAYLOAD);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/authentication required/i);

    // Quota and DB layers were never reached.
    expect(userHelpersMock.enforcePaywall).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
  });

  it("returns 402 when a free-tier user is at their estimate quota", async () => {
    injectSession = { uid: FAKE_USER_ID, csrfToken: FAKE_CSRF };
    userHelpersMock.enforcePaywall.mockResolvedValueOnce({
      ok: false,
      reason: "limit_reached",
      used: 2,
    });

    const res = await send(VALID_PAYLOAD);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/free estimate limit reached/i);
    expect(body.upgrade).toBe(true);

    // No estimate was created.
    expect(fakeDb.transaction).not.toHaveBeenCalled();
    expect(userHelpersMock.incrementUsage).not.toHaveBeenCalled();
  });

  describe("returns 400 on invalid payloads", () => {
    beforeEach(() => {
      injectSession = { uid: FAKE_USER_ID, csrfToken: FAKE_CSRF };
    });

    it("rejects a missing `name`", async () => {
      const { name: _omit, ...rest } = VALID_PAYLOAD;
      const res = await send(rest);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      expect(fakeDb.transaction).not.toHaveBeenCalled();
    });

    it("rejects an empty `name`", async () => {
      const res = await send({ ...VALID_PAYLOAD, name: "" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/name/i);
    });

    it("rejects an empty `lineItems` array", async () => {
      const res = await send({ ...VALID_PAYLOAD, lineItems: [] });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/line item/i);
    });

    it("rejects a line item with an empty description", async () => {
      const res = await send({
        ...VALID_PAYLOAD,
        lineItems: [{ description: "", quantity: 1, unitCost: 100 }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/description/i);
    });

    it("rejects a line item with non-positive quantity", async () => {
      const res = await send({
        ...VALID_PAYLOAD,
        lineItems: [{ description: "Demo", quantity: 0, unitCost: 100 }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/quantity/i);
    });

    it("rejects a line item with negative unit cost", async () => {
      const res = await send({
        ...VALID_PAYLOAD,
        lineItems: [{ description: "Demo", quantity: 1, unitCost: -5 }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/unit cost/i);
    });
  });
});
