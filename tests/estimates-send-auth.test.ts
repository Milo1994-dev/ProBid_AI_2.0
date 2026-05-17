import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const FAKE_USER_ID = "user-abc-123";
const FAKE_KEY_ID = "key-1";
const KEY_SECRET = `pbk_${"a".repeat(64)}`;
const KEY_HASH = crypto.createHash("sha256").update(KEY_SECRET).digest("hex");

let mockApiKeyRow: any = null;

vi.mock("../server/db.js", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockApiKeyRow ? [mockApiKeyRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };
  return { db };
});

vi.mock("../server/lib/audit.js", () => ({
  auditSecurityEvent: vi.fn(),
  recordAudit: vi.fn(),
}));

import { requireApiKeyOrSession } from "../server/lib/api-key-auth.js";

function makeReq(overrides: any = {}): any {
  return {
    headers: {},
    session: undefined,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = { statusCode: 200, headersSent: false, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.on = () => res;
  res.end = () => res;
  return res;
}

describe("/api/estimates/send hybrid auth — integration via requireApiKeyOrSession", () => {
  beforeEach(() => {
    mockApiKeyRow = null;
  });

  it("authorizes a valid API key with estimates:write and attributes the request to the key owner", async () => {
    mockApiKeyRow = {
      id: FAKE_KEY_ID,
      userId: FAKE_USER_ID,
      name: "Partner CRM",
      keyHash: KEY_HASH,
      keyPrefix: "pbk",
      scopes: "estimates:write,estimates:read",
      rateLimit: 100,
      lastUsedAt: null,
      requestCount: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: Date.now(),
    };

    const middleware = requireApiKeyOrSession("estimates:write");
    const req = makeReq({
      headers: { authorization: `Bearer ${KEY_SECRET}` },
    });
    const res = makeRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    await middleware(req, res, next);
    // Allow the rate limiter (which calls next asynchronously via its own queue) to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(res.headersSent).toBe(false);
    expect(nextCalled).toBe(true);
    expect(req.session.uid).toBe(FAKE_USER_ID);
    expect((req as any).apiKeyUserId).toBe(FAKE_USER_ID);
    expect((req as any).apiKeyId).toBe(FAKE_KEY_ID);
    expect((req as any).isApiKeyAuth).toBe(true);
  });

  it("returns 403 when the API key is missing the estimates:write scope", async () => {
    mockApiKeyRow = {
      id: FAKE_KEY_ID,
      userId: FAKE_USER_ID,
      name: "Read-only Key",
      keyHash: KEY_HASH,
      keyPrefix: "pbk",
      scopes: "estimates:read,leads:read",
      rateLimit: 100,
      lastUsedAt: null,
      requestCount: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: Date.now(),
    };

    const middleware = requireApiKeyOrSession("estimates:write");
    const req = makeReq({
      headers: { authorization: `Bearer ${KEY_SECRET}` },
    });
    const res = makeRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    await middleware(req, res, next);

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("estimates:write");
    // Importantly, ownership is NOT promoted to the session when scope check fails.
    expect(req.session?.uid).toBeUndefined();
  });

  it("rejects revoked keys before checking scopes", async () => {
    mockApiKeyRow = null; // revoked rows are filtered out by isNull(revokedAt) in the query

    const middleware = requireApiKeyOrSession("estimates:write");
    const req = makeReq({
      headers: { authorization: `Bearer ${KEY_SECRET}` },
    });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/invalid or revoked/i);
  });
});
