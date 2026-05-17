import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import cookieSession from "cookie-session";
import type { AddressInfo } from "net";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test_session_secret_for_sdk_tests";
  const { sdkSessionMiddleware, signSdkSessionToken, SDK_SESSION_COOKIE_NAME } =
    await import("../server/lib/sdk-session.js");

  const app = express();
  app.use(
    cookieSession({
      name: "probid_session",
      secret: process.env.SESSION_SECRET!,
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    }),
  );
  // Mount only on the SDK path — proves the SDK cookie is scoped, not global.
  app.use("/api/sdk-only", sdkSessionMiddleware);

  app.get("/api/sdk-only/whoami", (req, res) => {
    res.json({
      uid: req.session?.uid ?? null,
      email: req.session?.email ?? null,
      isSdkAuth: Boolean((req as any).isSdkAuth),
    });
  });

  app.get("/api/other/whoami", (req, res) => {
    // No sdkSessionMiddleware here — request must NOT be authenticated by
    // the SDK cookie even if the cookie is present.
    res.json({
      uid: req.session?.uid ?? null,
      isSdkAuth: Boolean((req as any).isSdkAuth),
    });
  });

  // Helper for tests to mint a real SDK token from the same secret.
  app.get("/__mint", (req, res) => {
    const userId = String(req.query.uid ?? "user-1");
    const email = String(req.query.email ?? "user@example.com");
    const { token } = signSdkSessionToken(userId, email);
    res.json({ cookieName: SDK_SESSION_COOKIE_NAME, token });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function mint(uid = "user-42", email = "u42@example.com") {
  const r = await fetch(`${baseUrl}/__mint?uid=${uid}&email=${encodeURIComponent(email)}`);
  const body = (await r.json()) as { cookieName: string; token: string };
  return body;
}

describe("sdkSessionMiddleware", () => {
  it("populates req.session.uid from a valid SDK cookie", async () => {
    const { cookieName, token } = await mint("user-42", "u42@example.com");
    const res = await fetch(`${baseUrl}/api/sdk-only/whoami`, {
      headers: { cookie: `${cookieName}=${encodeURIComponent(token)}` },
    });
    const body = await res.json();
    expect(body.uid).toBe("user-42");
    expect(body.email).toBe("u42@example.com");
    expect(body.isSdkAuth).toBe(true);
  });

  it("rejects a tampered SDK cookie (signature mismatch)", async () => {
    const { cookieName, token } = await mint("user-99");
    const tampered = token.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const res = await fetch(`${baseUrl}/api/sdk-only/whoami`, {
      headers: { cookie: `${cookieName}=${encodeURIComponent(tampered)}` },
    });
    const body = await res.json();
    expect(body.uid).toBeNull();
    expect(body.isSdkAuth).toBe(false);
  });

  it("rejects a cookie that uses the wrong shared secret", async () => {
    const { cookieName, token } = await mint("user-7");
    // Simulate an attacker-forged token by hand: same shape, different sig.
    const parts = token.split(":");
    parts[parts.length - 1] = "deadbeef".repeat(8);
    const forged = parts.join(":");
    const res = await fetch(`${baseUrl}/api/sdk-only/whoami`, {
      headers: { cookie: `${cookieName}=${encodeURIComponent(forged)}` },
    });
    const body = await res.json();
    expect(body.uid).toBeNull();
  });

  it("does NOT authenticate any other route — the SDK cookie is scoped", async () => {
    const { cookieName, token } = await mint("user-88");
    const res = await fetch(`${baseUrl}/api/other/whoami`, {
      headers: { cookie: `${cookieName}=${encodeURIComponent(token)}` },
    });
    const body = await res.json();
    // Critical: even though the cookie was sent, only routes that opted into
    // sdkSessionMiddleware should honor it. This is what isolates SDK auth
    // from the rest of the app's session-protected mutations.
    expect(body.uid).toBeNull();
    expect(body.isSdkAuth).toBe(false);
  });

  it("does NOT cause the main probid_session cookie to be re-issued on SDK responses", async () => {
    // The SDK middleware bridges identity into req.session for the duration
    // of the request, but cookie-session must not re-emit a `probid_session`
    // cookie on the response — that would leak SDK identity back into the
    // first-party Lax cookie and slightly blur the isolation model.
    const { cookieName, token } = await mint("user-77", "u77@example.com");
    const res = await fetch(`${baseUrl}/api/sdk-only/whoami`, {
      headers: { cookie: `${cookieName}=${encodeURIComponent(token)}` },
    });
    expect(res.status).toBe(200);
    const setCookies = (res.headers as any).getSetCookie
      ? (res.headers as any).getSetCookie()
      : ((res.headers.get("set-cookie") || "")
          .split(/,(?=[^;]+=)/)
          .map((s: string) => s.trim())
          .filter(Boolean));
    const probidSessionCookies = setCookies.filter((c: string) =>
      /^probid_session\b/i.test(c),
    );
    expect(probidSessionCookies).toEqual([]);
  });

  it("issues cookies with SameSite=None; Secure; HttpOnly", async () => {
    // We don't actually need a server hop here — just sanity-check the
    // header string the helper sets.
    const express2 = await import("express");
    const app = (express2 as any).default();
    const { setSdkSessionCookie } = await import("../server/lib/sdk-session.js");
    app.get("/x", (_req: any, res: any) => {
      setSdkSessionCookie(res, "u", "u@example.com");
      res.json({ ok: true });
    });
    const srv = (await import("http")).createServer(app).listen(0);
    const address = srv.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/x`);
      const cookies = res.headers.get("set-cookie") || "";
      expect(cookies).toMatch(/probid_sdk_session=/);
      expect(cookies).toMatch(/HttpOnly/);
      expect(cookies).toMatch(/Secure/);
      expect(cookies).toMatch(/SameSite=None/);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
