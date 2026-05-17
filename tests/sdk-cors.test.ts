import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.SDK_ALLOWED_ORIGINS =
    "https://partner.example.com, https://app.contractorsoft.io ,*.dispatch-pro.com";
  const { sdkCorsMiddleware, _resetCorsCacheForTests } = await import(
    "../server/lib/cors.js"
  );
  _resetCorsCacheForTests();

  const app = express();
  app.use("/api/csrf", sdkCorsMiddleware);
  app.use("/api/estimates/send", sdkCorsMiddleware);
  app.get("/api/csrf", (_req, res) =>
    res.json({ success: true, data: { token: "tok" } }),
  );
  app.post("/api/estimates/send", (_req, res) =>
    res.json({ success: true, data: { ok: true } }),
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  delete process.env.SDK_ALLOWED_ORIGINS;
  const { _resetCorsCacheForTests } = await import("../server/lib/cors.js");
  _resetCorsCacheForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("SDK CORS allowlist", () => {
  it("reflects an allowlisted origin and credentials flag on a GET", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`, {
      headers: { origin: "https://partner.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://partner.example.com",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect((res.headers.get("vary") || "").toLowerCase()).toContain("origin");
  });

  it("allows a wildcard subdomain match", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`, {
      headers: { origin: "https://acme.dispatch-pro.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://acme.dispatch-pro.com",
    );
  });

  it("does NOT echo the origin for a non-allowlisted caller", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`, {
      headers: { origin: "https://evil.example.org" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // Vary: Origin must still be present so caches don't poison this entry
    // for the next, possibly allowlisted, caller.
    expect((res.headers.get("vary") || "").toLowerCase()).toContain("origin");
  });

  it("never echoes a literal '*' even if a request would match nothing", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`, {
      headers: { origin: "https://anyone.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("answers OPTIONS preflight from an allowlisted origin with 204 + headers", async () => {
    const res = await fetch(`${baseUrl}/api/estimates/send`, {
      method: "OPTIONS",
      headers: {
        origin: "https://partner.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-csrf-token",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://partner.example.com",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const allowedHeaders = res.headers.get("access-control-allow-headers") || "";
    expect(allowedHeaders.toLowerCase()).toContain("x-csrf-token");
    expect(allowedHeaders.toLowerCase()).toContain("authorization");
    const allowedMethods = res.headers.get("access-control-allow-methods") || "";
    expect(allowedMethods.toUpperCase()).toContain("POST");
    expect(allowedMethods.toUpperCase()).toContain("OPTIONS");
  });

  it("rejects OPTIONS preflight from a non-allowlisted origin with 403", async () => {
    const res = await fetch(`${baseUrl}/api/estimates/send`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example.org",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does NOT match a look-alike host that lacks the subdomain boundary", async () => {
    // `*.dispatch-pro.com` must match `acme.dispatch-pro.com` but NOT
    // `evildispatch-pro.com` — the dot boundary is mandatory.
    const res = await fetch(`${baseUrl}/api/csrf`, {
      headers: { origin: "https://evildispatch-pro.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does NOT match the apex domain under a wildcard rule", async () => {
    // Per the documented "subdomain-only" rule, `*.dispatch-pro.com` does
    // NOT permit the bare apex `https://dispatch-pro.com`. Operators who
    // want the apex too must list it explicitly.
    const res = await fetch(`${baseUrl}/api/csrf`, {
      headers: { origin: "https://dispatch-pro.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a no-Origin OPTIONS request with 204 (curl, server-to-server)", async () => {
    const res = await fetch(`${baseUrl}/api/estimates/send`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

describe("isAllowedOrigin helper", () => {
  it("rejects a bare '*' entry in SDK_ALLOWED_ORIGINS", async () => {
    const prev = process.env.SDK_ALLOWED_ORIGINS;
    process.env.SDK_ALLOWED_ORIGINS = "*";
    const { isAllowedOrigin, _resetCorsCacheForTests } = await import(
      "../server/lib/cors.js"
    );
    _resetCorsCacheForTests();
    expect(isAllowedOrigin("https://anyone.com")).toBe(false);

    process.env.SDK_ALLOWED_ORIGINS = prev;
    _resetCorsCacheForTests();
  });

  it("ignores malformed entries gracefully", async () => {
    const prev = process.env.SDK_ALLOWED_ORIGINS;
    process.env.SDK_ALLOWED_ORIGINS = "not-a-url, https://good.example.com";
    const { isAllowedOrigin, _resetCorsCacheForTests } = await import(
      "../server/lib/cors.js"
    );
    _resetCorsCacheForTests();
    expect(isAllowedOrigin("https://good.example.com")).toBe(true);
    expect(isAllowedOrigin("not-a-url")).toBe(false);

    process.env.SDK_ALLOWED_ORIGINS = prev;
    _resetCorsCacheForTests();
  });

  it("treats HTTP and HTTPS as distinct origins", async () => {
    const prev = process.env.SDK_ALLOWED_ORIGINS;
    process.env.SDK_ALLOWED_ORIGINS = "https://partner.example.com";
    const { isAllowedOrigin, _resetCorsCacheForTests } = await import(
      "../server/lib/cors.js"
    );
    _resetCorsCacheForTests();
    expect(isAllowedOrigin("https://partner.example.com")).toBe(true);
    expect(isAllowedOrigin("http://partner.example.com")).toBe(false);

    process.env.SDK_ALLOWED_ORIGINS = prev;
    _resetCorsCacheForTests();
  });

  it("enforces a subdomain dot boundary on wildcard entries", async () => {
    const prev = process.env.SDK_ALLOWED_ORIGINS;
    process.env.SDK_ALLOWED_ORIGINS = "*.dispatch-pro.com";
    const { isAllowedOrigin, _resetCorsCacheForTests } = await import(
      "../server/lib/cors.js"
    );
    _resetCorsCacheForTests();
    expect(isAllowedOrigin("https://acme.dispatch-pro.com")).toBe(true);
    expect(isAllowedOrigin("https://deep.nested.dispatch-pro.com")).toBe(true);
    // Look-alike: no dot boundary → must be rejected.
    expect(isAllowedOrigin("https://evildispatch-pro.com")).toBe(false);
    // Apex domain is NOT covered by the wildcard rule.
    expect(isAllowedOrigin("https://dispatch-pro.com")).toBe(false);
    // Trailing-character look-alike.
    expect(isAllowedOrigin("https://dispatch-pro.computer")).toBe(false);

    process.env.SDK_ALLOWED_ORIGINS = prev;
    _resetCorsCacheForTests();
  });

  it("ignores wildcard entries without a usable root domain", async () => {
    const prev = process.env.SDK_ALLOWED_ORIGINS;
    process.env.SDK_ALLOWED_ORIGINS = "*.com,*.,*";
    const { isAllowedOrigin, _resetCorsCacheForTests } = await import(
      "../server/lib/cors.js"
    );
    _resetCorsCacheForTests();
    // `*.com` would otherwise match every `.com` host — ignored.
    expect(isAllowedOrigin("https://anyone.com")).toBe(false);
    expect(isAllowedOrigin("https://attacker.com")).toBe(false);

    process.env.SDK_ALLOWED_ORIGINS = prev;
    _resetCorsCacheForTests();
  });
});
