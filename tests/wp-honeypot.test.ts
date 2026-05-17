import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

/**
 * Smoke test for the WordPress / .env probe blackhole installed at the very
 * top of the Express middleware chain in `server.ts`. We re-create the exact
 * same regex + handler here (the implementation is intentionally tiny) so we
 * can assert behavior without booting the whole app.
 */

const WP_HONEYPOT_PATTERN =
  /^\/(wp-login\.php|wp-admin(\/|$)|wp-content(\/|$)|wp-includes(\/|$)|xmlrpc\.php|\.env|\.git(\/|$)|phpmyadmin(\/|$))/i;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, res, next) => {
    if (!WP_HONEYPOT_PATTERN.test(req.path)) return next();
    res.set("Cache-Control", "public, max-age=86400");
    return res.status(410).end();
  });
  app.get("/", (_req, res) => res.status(200).send("real app"));
  app.get("/api/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/blog/posts/wp-admin-tips", (_req, res) =>
    res.status(200).send("legit"),
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const blocked = [
  "/wp-login.php",
  "/wp-admin/",
  "/wp-admin/index.php",
  "/wp-admin/setup-config.php",
  "/wp-content/uploads/exploit.php",
  "/wp-includes/wlwmanifest.xml",
  "/xmlrpc.php",
  "/.env",
  "/.env.local",
  "/.git/config",
  "/phpmyadmin/index.php",
  // Case-insensitive: bots try mixed case.
  "/WP-LOGIN.PHP",
  "/Wp-Admin/install.php",
];

const passthrough = [
  "/",
  "/api/health",
  // Substring matches must NOT trip the regex when not anchored to the start
  // segment (e.g. a legitimate blog post mentioning the term in its URL).
  "/blog/posts/wp-admin-tips",
];

describe("WP / .env honeypot", () => {
  it.each(blocked)("blocks %s with 410 Gone", async (path) => {
    const r = await fetch(`${baseUrl}${path}`);
    expect(r.status).toBe(410);
    expect(r.headers.get("cache-control")).toContain("max-age=86400");
  });

  it.each(passthrough)("lets %s through to the real app", async (path) => {
    const r = await fetch(`${baseUrl}${path}`);
    expect(r.status).toBe(200);
  });

  it("blocks POST and other verbs, not just GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const r = await fetch(`${baseUrl}/wp-login.php`, { method });
      expect(r.status).toBe(410);
    }
  });
});
