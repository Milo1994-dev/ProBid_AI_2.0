import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";

/**
 * Regression test for task #132.
 *
 * Admin auth must reject `?key=ADMIN_KEY` query strings (logged by proxies,
 * saved in browser history, leaked via Referer). Only `x-admin-key` /
 * `x-cron-key` headers and a verified `req.session.adminSession` cookie may
 * authorize an admin caller.
 */

const ADMIN_KEY = "test-admin-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let isAdminRequest: (req: express.Request) => boolean;
let generateAdminSessionToken: () => string;

beforeAll(async () => {
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.SESSION_SECRET = "test-session-secret-for-admin-no-query-key";
  ({ isAdminRequest } = await import("../server/routes/admin/shared.js"));
  ({ generateAdminSessionToken } = await import("../server/lib/middleware.js"));
});

function makeReq(opts: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  session?: Record<string, unknown> | null;
}): express.Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    query: opts.query ?? {},
    headers,
    session: opts.session === null ? undefined : (opts.session ?? {}),
  } as unknown as express.Request;
}

describe("isAdminRequest rejects URL query string and accepts header / session", () => {
  it("rejects ?key=ADMIN_KEY in query string (matches the secret)", () => {
    const req = makeReq({ query: { key: ADMIN_KEY } });
    expect(isAdminRequest(req)).toBe(false);
  });

  it("rejects ?key=ADMIN_KEY even with empty session object", () => {
    const req = makeReq({ query: { key: ADMIN_KEY }, session: {} });
    expect(isAdminRequest(req)).toBe(false);
  });

  it("rejects ?key=ADMIN_KEY even when no session is present at all", () => {
    const req = makeReq({ query: { key: ADMIN_KEY }, session: null });
    expect(isAdminRequest(req)).toBe(false);
  });

  it("accepts x-admin-key header with the correct secret", () => {
    const req = makeReq({ headers: { "x-admin-key": ADMIN_KEY } });
    expect(isAdminRequest(req)).toBe(true);
  });

  it("accepts x-cron-key header with the correct secret", () => {
    const req = makeReq({ headers: { "x-cron-key": ADMIN_KEY } });
    expect(isAdminRequest(req)).toBe(true);
  });

  it("rejects x-admin-key header with a wrong secret", () => {
    const req = makeReq({ headers: { "x-admin-key": "not-the-key" } });
    expect(isAdminRequest(req)).toBe(false);
  });

  it("accepts a valid req.session.adminSession token", () => {
    const token = generateAdminSessionToken();
    const req = makeReq({ session: { adminSession: token } });
    expect(isAdminRequest(req)).toBe(true);
  });

  it("rejects a forged adminSession value", () => {
    const req = makeReq({ session: { adminSession: "not-a-real-hmac-token" } });
    expect(isAdminRequest(req)).toBe(false);
  });

  it("rejects request with no auth surfaces of any kind", () => {
    const req = makeReq({});
    expect(isAdminRequest(req)).toBe(false);
  });

  it("rejects ?key=ADMIN_KEY even when paired with a valid header", () => {
    const req = makeReq({
      query: { key: ADMIN_KEY },
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(isAdminRequest(req)).toBe(false);
  });

  it("rejects ?key=ADMIN_KEY even when paired with a valid session token", () => {
    const req = makeReq({
      query: { key: ADMIN_KEY },
      session: { adminSession: generateAdminSessionToken() },
    });
    expect(isAdminRequest(req)).toBe(false);
  });

  it("rejects ?key=anything (even empty string) regardless of other auth", () => {
    expect(isAdminRequest(makeReq({
      query: { key: "" },
      headers: { "x-admin-key": ADMIN_KEY },
    }))).toBe(false);
    expect(isAdminRequest(makeReq({
      query: { key: "wrong" },
      headers: { "x-admin-key": ADMIN_KEY },
    }))).toBe(false);
  });
});

// HTTP-level guarantee: a real admin route mounted behind isAdminRequest must
// return 401 for `?key=ADMIN_KEY` and 200 for `x-admin-key: ADMIN_KEY`.
describe("HTTP: GET /api/admin/* with ?key= is rejected", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    const { isAdminRequest: isAdmin } = await import("../server/routes/admin/shared.js");
    const app = express();
    app.get("/api/admin/test", (req, res) => {
      if (!isAdmin(req)) return res.status(401).json({ ok: false });
      return res.status(200).json({ ok: true });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("?key=ADMIN_KEY returns 401", async () => {
    const r = await fetch(`${baseUrl}/api/admin/test?key=${encodeURIComponent(ADMIN_KEY)}`);
    expect(r.status).toBe(401);
  });

  it("?key=ADMIN_KEY plus other params still returns 401", async () => {
    const r = await fetch(`${baseUrl}/api/admin/test?key=${encodeURIComponent(ADMIN_KEY)}&foo=1`);
    expect(r.status).toBe(401);
  });

  it("x-admin-key header with the correct secret returns 200", async () => {
    const r = await fetch(`${baseUrl}/api/admin/test`, {
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(r.status).toBe(200);
  });

  it("no auth at all returns 401", async () => {
    const r = await fetch(`${baseUrl}/api/admin/test`);
    expect(r.status).toBe(401);
  });

  it("?key=ADMIN_KEY + valid x-admin-key header still returns 401", async () => {
    const r = await fetch(`${baseUrl}/api/admin/test?key=${encodeURIComponent(ADMIN_KEY)}`, {
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(r.status).toBe(401);
  });
});

// HTTP-level guarantee: page-level admin auth must NEVER propagate `?key=`
// into Location headers, login form HTML, or post-login redirects.
describe("HTTP: requireAdminAuthPage strips ?key= from URLs", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;
    const { requireAdminAuthPage, stripAdminKeyParam } = await import(
      "../server/lib/middleware.js"
    );
    expect(typeof requireAdminAuthPage).toBe("function");
    expect(typeof stripAdminKeyParam).toBe("function");

    const app = express();
    app.use((req, _res, next) => {
      // Allow tests to inject a session via x-test-session header.
      const sessionHeader = req.headers["x-test-session"];
      (req as any).session = sessionHeader
        ? { adminSession: String(sessionHeader) }
        : {};
      next();
    });
    app.get("/admin/anything", requireAdminAuthPage, (_req, res) => {
      res.status(200).send("ok");
    });
    app.get("/admin/login", (req, res) => {
      const nextParam = String(req.query.next ?? "");
      res
        .status(200)
        .send(`<form><input name="next" value="${nextParam}" /></form>`);
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /admin/anything?key=ADMIN_KEY 303-redirects to the same path WITHOUT key", async () => {
    const r = await fetch(`${baseUrl}/admin/anything?key=${encodeURIComponent(ADMIN_KEY)}`, {
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    const loc = r.headers.get("location") || "";
    expect(loc).toBe("/admin/anything");
    expect(loc).not.toContain("key=");
    expect(loc).not.toContain(ADMIN_KEY);
  });

  it("GET /admin/anything?foo=1&key=ADMIN_KEY preserves other params and drops key", async () => {
    const r = await fetch(
      `${baseUrl}/admin/anything?foo=1&key=${encodeURIComponent(ADMIN_KEY)}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(303);
    const loc = r.headers.get("location") || "";
    expect(loc).toBe("/admin/anything?foo=1");
    expect(loc).not.toContain(ADMIN_KEY);
  });

  it("unauthenticated /admin/anything (no key) redirects to /admin/login with clean next", async () => {
    const r = await fetch(`${baseUrl}/admin/anything?foo=1`, { redirect: "manual" });
    expect([302, 303]).toContain(r.status);
    const loc = r.headers.get("location") || "";
    expect(loc.startsWith("/admin/login")).toBe(true);
    expect(loc).toContain("next=");
    expect(loc).not.toContain("key=");
    expect(loc).not.toContain(ADMIN_KEY);
  });

  it("if a request still smuggles ?key=, the eventual login page next does not contain it either", async () => {
    // Follow the 303 redirect to the same path without key, then the second
    // hop redirects to /admin/login because there's no session.
    const r1 = await fetch(`${baseUrl}/admin/anything?key=${encodeURIComponent(ADMIN_KEY)}`, {
      redirect: "manual",
    });
    expect(r1.status).toBe(303);
    const r2 = await fetch(`${baseUrl}${r1.headers.get("location")}`, { redirect: "manual" });
    const loc2 = r2.headers.get("location") || "";
    expect(loc2.startsWith("/admin/login")).toBe(true);
    expect(loc2).not.toContain(ADMIN_KEY);
  });

  it("authenticated session + ?key= still 303-redirects to clean URL (does NOT serve page)", async () => {
    const sessionToken = generateAdminSessionToken();
    const r = await fetch(`${baseUrl}/admin/anything?key=${encodeURIComponent(ADMIN_KEY)}`, {
      headers: { "x-test-session": sessionToken },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    const loc = r.headers.get("location") || "";
    expect(loc).toBe("/admin/anything");
    expect(loc).not.toContain(ADMIN_KEY);
  });

  it("valid x-admin-key header + ?key= still 303-redirects to clean URL", async () => {
    const r = await fetch(`${baseUrl}/admin/anything?key=${encodeURIComponent(ADMIN_KEY)}`, {
      headers: { "x-admin-key": ADMIN_KEY },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    const loc = r.headers.get("location") || "";
    expect(loc).toBe("/admin/anything");
    expect(loc).not.toContain(ADMIN_KEY);
  });

  it("authenticated session WITHOUT ?key= serves the page (200)", async () => {
    const sessionToken = generateAdminSessionToken();
    const r = await fetch(`${baseUrl}/admin/anything`, {
      headers: { "x-test-session": sessionToken },
      redirect: "manual",
    });
    expect(r.status).toBe(200);
  });

  it("stripAdminKeyParam helper", async () => {
    const { stripAdminKeyParam } = await import("../server/lib/middleware.js");
    expect(stripAdminKeyParam("/admin?key=abc")).toBe("/admin");
    expect(stripAdminKeyParam("/admin/ads?foo=1&key=abc")).toBe("/admin/ads?foo=1");
    expect(stripAdminKeyParam("/admin/ads?key=abc&foo=1")).toBe("/admin/ads?foo=1");
    expect(stripAdminKeyParam("/admin")).toBe("/admin");
    expect(stripAdminKeyParam("/admin?foo=1")).toBe("/admin?foo=1");
    expect(stripAdminKeyParam("")).toBe("");
  });
});
