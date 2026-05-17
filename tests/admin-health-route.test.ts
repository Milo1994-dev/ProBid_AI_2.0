import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { vi } from "vitest";

/**
 * Smoke test for the operational visibility surface:
 *   - GET  /api/admin/health             — JSON snapshot shape
 *   - POST /api/admin/health/webhook-selftest — in-process Resend signature self-test
 *   - GET  /admin/health                 — HTML dashboard 200 + admin-key stripping
 *
 * The route handler depends on getGrowthHealthSnapshot, pool, and a couple of
 * helpers — they're stubbed so the test stays hermetic.
 */

const ADMIN_KEY = "test-admin-key-for-health-route-aaaaaaaaaaaaaaaaaaaa";
const RAW_SECRET_B64 = Buffer.from("super-secret-key-for-selftest").toString("base64");
const FULL_SECRET = `whsec_${RAW_SECRET_B64}`;

const stubSnapshot = {
  generatedAt: 1_700_000_000_000,
  overall: "green" as const,
  subsystems: [
    {
      key: "outreach_processor",
      label: "Outreach Processor",
      description: "Sends queued outreach emails",
      status: "green" as const,
      reasons: ["healthy"],
      lastSuccessAt: Date.now() - 60_000,
      lastFailureAt: null,
      throughput24h: 10,
      failureCount24h: 0,
      failureRate24h: 0,
      latestError: null,
    },
  ],
};

vi.mock("../server/growth-health.js", () => ({
  getGrowthHealthSnapshot: async () => stubSnapshot,
}));

vi.mock("../server/db.js", () => ({
  pool: {
    query: async (sql: string) => {
      if (sql.includes("FROM system_alerts")) return { rows: [] };
      if (sql.includes("resend_webhook_last_event")) {
        return {
          rows: [
            {
              key: "resend_webhook_last_event",
              value: JSON.stringify({
                ts: new Date().toISOString(),
                type: "email.delivered",
              }),
            },
          ],
        };
      }
      return { rows: [] };
    },
  },
  getPoolResetStats: () => ({ count: 0 }),
  getDuplicateDealRaceStats: () => ({ count: 0 }),
}));

vi.mock("../server/lib/daily-digest.js", () => ({
  buildDailyDigest: async () => ({}),
  sendDailyDigest: async () => ({ sent: true }),
}));

vi.mock("../server/lib/outreach-state.js", () => ({
  outreachPaused: false,
  outreachPauseReason: "",
}));

vi.mock("../server/lib/logger.js", () => ({
  log: () => {},
}));

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.SESSION_SECRET = "test-session-secret-for-health-route-test";
  process.env.RESEND_WEBHOOK_SECRET = FULL_SECRET;

  const { registerAdminHealthRoutes } = await import("../server/routes/admin/health.js");

  const app = express();
  app.use(express.json());
  // Synthesize an empty session object so requireAdminAuthPage can inspect it.
  app.use((req, _res, next) => {
    (req as any).session = {};
    next();
  });
  registerAdminHealthRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /api/admin/health (JSON snapshot)", () => {
  it("requires admin auth", async () => {
    const r = await fetch(`${baseUrl}/api/admin/health`);
    expect(r.status).toBe(401);
  });

  it("returns the snapshot shape with x-admin-key", async () => {
    const r = await fetch(`${baseUrl}/api/admin/health`, {
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { success: boolean; data: any };
    expect(j.success).toBe(true);
    expect(j.data).toMatchObject({
      overall: "green",
      subsystems: expect.any(Array),
      rules: expect.any(Array),
      activeAlerts: expect.any(Array),
      process: expect.objectContaining({
        nodeVersion: expect.any(String),
        uptimeMs: expect.any(Number),
      }),
    });
    expect(j.data.subsystems[0]).toMatchObject({
      key: "outreach_processor",
      status: "green",
    });
  });
});

describe("POST /api/admin/health/webhook-selftest", () => {
  it("requires admin auth", async () => {
    const r = await fetch(`${baseUrl}/api/admin/health/webhook-selftest`, {
      method: "POST",
    });
    expect(r.status).toBe(401);
  });

  it("returns verdict=ok when RESEND_WEBHOOK_SECRET is set correctly", async () => {
    const r = await fetch(`${baseUrl}/api/admin/health/webhook-selftest`, {
      method: "POST",
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { success: boolean; data: any };
    expect(j.success).toBe(true);
    expect(j.data.verdict).toBe("ok");
    expect(j.data.secretConfigured).toBe(true);
    expect(j.data.secretLooksWhsecPrefixed).toBe(true);
    // Fingerprint must be a short hex string, NOT the secret itself.
    expect(j.data.secretFingerprintSha256First12).toMatch(/^[0-9a-f]{12}$/);
    expect(j.data.checklistIfNoEventsArriving).toBeInstanceOf(Array);
    // Critically: the raw secret must never appear in the response.
    const body = JSON.stringify(j);
    expect(body).not.toContain(RAW_SECRET_B64);
    expect(body).not.toContain(FULL_SECRET);
  });

  it("returns verdict=failed and helpful message when secret is missing", async () => {
    const prev = process.env.RESEND_WEBHOOK_SECRET;
    const prevDeploy = process.env.REPLIT_DEPLOYMENT;
    delete process.env.RESEND_WEBHOOK_SECRET;
    // Force the production "reject when no secret" branch.
    process.env.REPLIT_DEPLOYMENT = "1";
    try {
      const r = await fetch(`${baseUrl}/api/admin/health/webhook-selftest`, {
        method: "POST",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { success: boolean; data: any };
      expect(j.success).toBe(false);
      expect(j.data.verdict).toBe("failed");
      expect(j.data.secretConfigured).toBe(false);
      expect(j.data.secretFingerprintSha256First12).toBeNull();
      expect(j.data.message).toMatch(/RESEND_WEBHOOK_SECRET is not set/);
    } finally {
      if (prev !== undefined) process.env.RESEND_WEBHOOK_SECRET = prev;
      if (prevDeploy === undefined) delete process.env.REPLIT_DEPLOYMENT;
      else process.env.REPLIT_DEPLOYMENT = prevDeploy;
    }
  });
});

describe("GET /admin/health (HTML dashboard)", () => {
  it("strips ?key= from URL via 303 redirect (admin-key-not-in-url guarantee)", async () => {
    const r = await fetch(
      `${baseUrl}/admin/health?key=${encodeURIComponent(ADMIN_KEY)}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(303);
    const loc = r.headers.get("location") || "";
    expect(loc).toBe("/admin/health");
    expect(loc).not.toContain(ADMIN_KEY);
  });

  it("redirects unauthenticated browsers to /admin/login", async () => {
    const r = await fetch(`${baseUrl}/admin/health`, { redirect: "manual" });
    expect([302, 303]).toContain(r.status);
    expect(r.headers.get("location") || "").toMatch(/^\/admin\/login/);
  });

  it("returns HTML 200 with x-admin-key header", async () => {
    const r = await fetch(`${baseUrl}/admin/health`, {
      headers: { "x-admin-key": ADMIN_KEY },
      redirect: "manual",
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("System Health");
    expect(html).toContain("Outreach Processor"); // from stub snapshot
    expect(html).toContain("Resend Webhook");
    expect(html).toContain("Webhook Signature Self-Test");
    // The HTML must not leak the secret anywhere (sanity guard).
    expect(html).not.toContain(RAW_SECRET_B64);
    expect(html).not.toContain(FULL_SECRET);
  });
});
