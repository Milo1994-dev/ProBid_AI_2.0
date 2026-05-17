import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../server/db.js", () => ({ db: null }));
vi.mock("../server/lib/audit.js", () => ({
  auditSecurityEvent: vi.fn(),
  recordAudit: vi.fn(),
}));

import {
  generateApiKey,
  isApiKeyFormat,
  requireApiKeyOrSession,
} from "../server/lib/api-key-auth.js";

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
  const res: any = {
    statusCode: 200,
    headersSent: false,
    body: undefined as any,
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

describe("generateApiKey", () => {
  it("generates a key with the pbk_ prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toBe("pbk");
    expect(key.startsWith("pbk_")).toBe(true);
    expect(key.length).toBeGreaterThan(40);
  });

  it("produces a unique secret per call", () => {
    const a = generateApiKey().key;
    const b = generateApiKey().key;
    expect(a).not.toBe(b);
  });
});

describe("isApiKeyFormat", () => {
  it("accepts the new pbk_ prefix", () => {
    expect(isApiKeyFormat("pbk_abc")).toBe(true);
  });

  it("accepts the legacy pb_live_ prefix", () => {
    expect(isApiKeyFormat("pb_live_abc")).toBe(true);
  });

  it("rejects unrelated bearer tokens", () => {
    expect(isApiKeyFormat("mobile:1:a:2:sig")).toBe(false);
    expect(isApiKeyFormat("xoxb-slack")).toBe(false);
  });
});

describe("requireApiKeyOrSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through when a session is already established", async () => {
    const middleware = requireApiKeyOrSession("estimates:write");
    const req = makeReq({ session: { uid: "user-123" } });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headersSent).toBe(false);
  });

  it("returns 401 when neither session nor Authorization header is present", async () => {
    const middleware = requireApiKeyOrSession("estimates:write");
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 when Bearer token is not an API key format", async () => {
    const middleware = requireApiKeyOrSession("estimates:write");
    const req = makeReq({
      headers: { authorization: "Bearer mobile:1:a@b.com:9999999999999:sig" },
    });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("returns 503 when the database is not configured (key path attempted)", async () => {
    // With db mocked to null, authenticateApiKey short-circuits with 503.
    const middleware = requireApiKeyOrSession("estimates:write");
    const req = makeReq({
      headers: { authorization: "Bearer pbk_deadbeef" },
    });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });
});
