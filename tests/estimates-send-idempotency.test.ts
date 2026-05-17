import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

const FAKE_USER_ID = "user-test-456";
const FAKE_API_KEY_ID = "apikey-789";

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

const idemMock = {
  IDEMPOTENCY_TTL_MS: 24 * 60 * 60 * 1000,
  IDEMPOTENCY_KEY_MAX_LENGTH: 255,
  readIdempotencyKey: vi.fn(),
  hashRequestBody: vi.fn(),
  claimIdempotencyKey: vi.fn(),
  finalizeIdempotencyKey: vi.fn().mockResolvedValue(undefined),
  releaseIdempotencyKey: vi.fn().mockResolvedValue(undefined),
  maybeReapExpiredIdempotencyKeys: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../server/lib/idempotency.js", () => idemMock);

const { registerEstimateRoutes } = await import("../server/routes/estimates.js");

let server: http.Server;
let baseUrl: string;
let injectAuth: { uid?: string; isApiKeyAuth?: boolean; apiKeyId?: string; csrfToken?: string } | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (injectAuth) {
      req.session = { uid: injectAuth.uid, csrfToken: injectAuth.csrfToken };
      if (injectAuth.isApiKeyAuth) {
        req.isApiKeyAuth = true;
        req.apiKeyId = injectAuth.apiKeyId;
        req.authUserId = injectAuth.uid;
      }
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
  injectAuth = null;
  vi.clearAllMocks();
  userHelpersMock.getSub.mockResolvedValue(undefined);
  userHelpersMock.isPaidActive.mockReturnValue(false);
  userHelpersMock.getTotalEstimates.mockResolvedValue(0);
  userHelpersMock.incrementUsage.mockResolvedValue(1);
  userHelpersMock.enforcePaywall.mockResolvedValue({ ok: true, tier: "free", used: 0 });
  userHelpersMock.consumeSingleCredit.mockResolvedValue(true);
  userHelpersMock.getDailyUsage.mockResolvedValue(0);
  idemMock.readIdempotencyKey.mockReturnValue({ key: null, error: null });
  idemMock.hashRequestBody.mockReturnValue("hash-1");
  idemMock.claimIdempotencyKey.mockResolvedValue({ kind: "fresh" });
  idemMock.finalizeIdempotencyKey.mockResolvedValue(undefined);
  idemMock.releaseIdempotencyKey.mockResolvedValue(undefined);
  idemMock.maybeReapExpiredIdempotencyKeys.mockResolvedValue(undefined);
});

const VALID_PAYLOAD = {
  name: "Idempotent Estimate",
  jobType: "Remodel",
  market: "Austin, TX",
  lineItems: [
    { description: "Demolition", quantity: 1, unitCost: 1500, costType: "Labor" },
  ],
};

function sendApiKey(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/estimates/send`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/estimates/send — idempotency", () => {
  it("scopes idempotency to API-key callers (no claim attempt for cookie auth)", async () => {
    injectAuth = { uid: FAKE_USER_ID, csrfToken: "csrf-1" };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "abc-123", error: null });

    const res = await sendApiKey(VALID_PAYLOAD, {
      "x-csrf-token": "csrf-1",
      "idempotency-key": "abc-123",
    });
    expect(res.status).toBe(200);
    expect(idemMock.claimIdempotencyKey).not.toHaveBeenCalled();
    expect(idemMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
  });

  it("does not claim a slot when API-key caller omits Idempotency-Key", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: null, error: null });

    const res = await sendApiKey(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    expect(idemMock.claimIdempotencyKey).not.toHaveBeenCalled();
  });

  it("returns 400 when Idempotency-Key fails validation", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: null, error: "Idempotency-Key is too long" });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "x".repeat(300) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/idempotency/i);
    expect(idemMock.claimIdempotencyKey).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
    expect(userHelpersMock.enforcePaywall).not.toHaveBeenCalled();
  });

  it("processes a fresh API-key request, finalizes the cache, and never releases", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "key-fresh", error: null });
    idemMock.claimIdempotencyKey.mockResolvedValue({ kind: "fresh" });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "key-fresh" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(idemMock.claimIdempotencyKey).toHaveBeenCalledWith({
      apiKeyId: FAKE_API_KEY_ID,
      idempotencyKey: "key-fresh",
      requestHash: "hash-1",
      now: expect.any(Number),
    });
    expect(idemMock.finalizeIdempotencyKey).toHaveBeenCalledTimes(1);
    const finalizeArg = idemMock.finalizeIdempotencyKey.mock.calls[0][0];
    expect(finalizeArg.apiKeyId).toBe(FAKE_API_KEY_ID);
    expect(finalizeArg.idempotencyKey).toBe("key-fresh");
    expect(finalizeArg.responseStatus).toBe(200);
    expect(finalizeArg.responseBody.success).toBe(true);
    expect(finalizeArg.estimateId).toMatch(/^[0-9a-f-]{36}$/);
    expect(idemMock.releaseIdempotencyKey).not.toHaveBeenCalled();
  });

  it("replays a cached response without consuming credits or hitting the DB", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "key-replay", error: null });
    const cached = { success: true, data: { estimateId: "cached-id", replayed: true } };
    idemMock.claimIdempotencyKey.mockResolvedValue({ kind: "replay", status: 200, body: cached });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "key-replay" });
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    const body = await res.json();
    expect(body).toEqual(cached);

    expect(userHelpersMock.enforcePaywall).not.toHaveBeenCalled();
    expect(userHelpersMock.incrementUsage).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
    expect(idemMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
  });

  it("returns 422 when the same key is reused with a different payload", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "key-mismatch", error: null });
    idemMock.claimIdempotencyKey.mockResolvedValue({ kind: "mismatch" });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "key-mismatch" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/different request body/i);

    expect(userHelpersMock.enforcePaywall).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
    expect(idemMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
  });

  it("returns 409 when an in-flight request is still being processed", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "key-flight", error: null });
    idemMock.claimIdempotencyKey.mockResolvedValue({ kind: "in_flight" });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "key-flight" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/still being processed/i);
    expect(fakeDb.transaction).not.toHaveBeenCalled();
  });

  it("releases the claim when the paywall blocks the request", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "key-paywall", error: null });
    idemMock.claimIdempotencyKey.mockResolvedValue({ kind: "fresh" });
    userHelpersMock.enforcePaywall.mockResolvedValueOnce({
      ok: false,
      reason: "limit_reached",
      used: 2,
    });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "key-paywall" });
    expect(res.status).toBe(402);

    expect(idemMock.releaseIdempotencyKey).toHaveBeenCalledWith({
      apiKeyId: FAKE_API_KEY_ID,
      idempotencyKey: "key-paywall",
    });
    expect(idemMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
  });

  it("returns 503 when the idempotency store is unavailable (fail-closed)", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "key-503", error: null });
    idemMock.claimIdempotencyKey.mockResolvedValue({
      kind: "error",
      message: "Idempotency store unavailable",
    });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "key-503" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/temporarily unavailable/i);

    // No estimate was created and no credit consumed.
    expect(userHelpersMock.enforcePaywall).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
    expect(idemMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
    expect(idemMock.releaseIdempotencyKey).not.toHaveBeenCalled();
  });

  it("releases the claim when the estimate insert blows up", async () => {
    injectAuth = { uid: FAKE_USER_ID, isApiKeyAuth: true, apiKeyId: FAKE_API_KEY_ID };
    idemMock.readIdempotencyKey.mockReturnValue({ key: "key-boom", error: null });
    idemMock.claimIdempotencyKey.mockResolvedValue({ kind: "fresh" });
    fakeDb.transaction.mockImplementationOnce(async () => {
      throw new Error("db boom");
    });

    const res = await sendApiKey(VALID_PAYLOAD, { "idempotency-key": "key-boom" });
    expect(res.status).toBe(500);

    expect(idemMock.releaseIdempotencyKey).toHaveBeenCalledWith({
      apiKeyId: FAKE_API_KEY_ID,
      idempotencyKey: "key-boom",
    });
    expect(idemMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
  });
});
