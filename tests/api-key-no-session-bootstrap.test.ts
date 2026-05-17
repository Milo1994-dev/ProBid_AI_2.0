import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import express from "express";
import cookieSession from "cookie-session";
import crypto from "crypto";
import type { AddressInfo } from "net";

/**
 * Regression test for the privilege-escalation hazard fixed in task #83.
 *
 * `requireApiKeyOrSession` exposes the API key owner via `req.session.uid` so
 * that downstream handlers (which historically read identity from the session)
 * still work for Bearer-key callers. To prevent that bridging from leaking a
 * web session back to the partner — which would let a key with one scope
 * (`estimates:write`) replay the resulting cookie against any other
 * session-protected endpoint and bypass scope isolation — the property is
 * defined as non-enumerable so cookie-session's "is the session populated?"
 * check skips it during serialization.
 *
 * The unit tests in `tests/estimates-send-auth.test.ts` cover the middleware
 * in isolation with a synthetic `req`/`res`. They cannot detect a regression
 * where the property becomes enumerable again, because they never run
 * cookie-session. This test does: it mounts the real middleware behind real
 * `cookie-session` middleware and asserts on actual `Set-Cookie` headers.
 */

const FAKE_USER_ID = "user-no-bootstrap";
const FAKE_KEY_ID = "key-no-bootstrap";
const KEY_SECRET = `pbk_${"b".repeat(64)}`;
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

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test_session_secret_for_apikey_bootstrap";
  const { requireApiKeyOrSession } = await import(
    "../server/lib/api-key-auth.js"
  );

  const app = express();
  app.use(express.json());

  // Mirrors the production `cookieSession({ name: "probid_session", ... })`
  // wiring in `server.ts` so any future change in cookie-session behavior is
  // observed against the real module, not a stub.
  app.use(
    cookieSession({
      name: "probid_session",
      secret: process.env.SESSION_SECRET!,
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    }),
  );

  app.post(
    "/api/estimates/send",
    requireApiKeyOrSession("estimates:write"),
    (req, res) => {
      // Stand-in for the real handler — we only care that the middleware
      // authorized the request and that the response cycle completes through
      // cookie-session's serialization step.
      res.json({
        success: true,
        uid: req.session?.uid ?? null,
        isApiKeyAuth: Boolean((req as any).isApiKeyAuth),
      });
    },
  );

  // Session-only endpoint that mirrors how the rest of the app gates routes:
  // identity is read from `req.session.uid`. If a partner could replay a
  // cookie minted on `/api/estimates/send`, this endpoint would 200.
  app.get("/api/me", (req, res) => {
    const uid = req.session?.uid;
    if (!uid) {
      return res.status(401).json({ success: false, error: "unauthenticated" });
    }
    return res.json({ success: true, uid });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  mockApiKeyRow = {
    id: FAKE_KEY_ID,
    userId: FAKE_USER_ID,
    name: "Partner CRM",
    keyHash: KEY_HASH,
    keyPrefix: "pbk",
    scopes: "estimates:write",
    rateLimit: 100,
    lastUsedAt: null,
    requestCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: Date.now(),
  };
});

function getSetCookies(res: Response): string[] {
  const anyHeaders = res.headers as any;
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const raw = res.headers.get("set-cookie") ?? "";
  if (!raw) return [];
  // Best-effort split for Node fetch implementations that fold multiple
  // Set-Cookie headers into one comma-joined string.
  return raw
    .split(/,(?=[^;]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setCookiesToCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

describe("API key callers must not bootstrap a probid_session cookie", () => {
  it("returns 2xx and emits no probid_session Set-Cookie", async () => {
    const res = await fetch(`${baseUrl}/api/estimates/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const body = (await res.json()) as {
      success: boolean;
      uid: string | null;
      isApiKeyAuth: boolean;
    };
    // The middleware did promote ownership for downstream handlers...
    expect(body.success).toBe(true);
    expect(body.isApiKeyAuth).toBe(true);
    expect(body.uid).toBe(FAKE_USER_ID);

    // ...but cookie-session must NOT have serialized that promotion back to
    // the wire. If a future refactor makes `req.session.uid` an own-enumerable
    // property again, cookie-session will emit `probid_session=...` here and
    // this assertion will fail.
    const setCookies = getSetCookies(res);
    const probidSessionCookies = setCookies.filter((c) =>
      /^probid_session(?:\.sig)?\b/i.test(c),
    );
    expect(probidSessionCookies).toEqual([]);
  });

  it("any cookie returned from the API-key call still cannot authenticate /api/me", async () => {
    const sendRes = await fetch(`${baseUrl}/api/estimates/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(sendRes.status).toBeLessThan(300);

    const setCookies = getSetCookies(sendRes);
    const cookieHeader = setCookiesToCookieHeader(setCookies);

    const meRes = await fetch(`${baseUrl}/api/me`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });

    // Whether or not anything was set in `Set-Cookie`, replaying it against
    // a session-only endpoint must NOT authenticate the partner. This is the
    // privilege-escalation guarantee the fix is protecting.
    expect(meRes.status).toBe(401);
    const meBody = (await meRes.json()) as { success: boolean };
    expect(meBody.success).toBe(false);
  });

  it("a session-only endpoint stays 401 with no cookie at all (sanity check)", async () => {
    // Confirms the test fixture itself isn't accidentally permissive — if
    // `/api/me` returned 200 with no cookie, the previous assertion would
    // be meaningless.
    const meRes = await fetch(`${baseUrl}/api/me`);
    expect(meRes.status).toBe(401);
  });
});
