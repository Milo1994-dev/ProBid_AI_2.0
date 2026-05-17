import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

/**
 * Tests for the three new Watchtower threshold control pairs:
 *   - DB pool reset thresholds  (pool-resets-thresholds)
 *   - Error rate thresholds     (error-rate-thresholds)
 *   - Webhook success thresholds (webhook-success-thresholds)
 *
 * Each section covers:
 *   1. GET returning env defaults when no DB override is stored
 *   2. GET returning DB-stored values when an override exists
 *   3. POST writing valid values and the evaluator picking them up
 *   4. POST validation rejections (yellow >= red, out-of-range rates, etc.)
 *
 * The evaluator tests follow the pattern in tests/watchtower-rules.test.ts.
 * Route-level validation tests spin up a minimal in-process express server
 * (the same approach used by tests/sdk-allowlist-routes.test.ts).
 */

// ── shared mocks ─────────────────────────────────────────────────────────

const {
  mockGetPoolResetStats,
  mockPoolQuery,
  mockGetDuplicateDealRaceStats,
} = vi.hoisted(() => ({
  mockGetPoolResetStats: vi.fn(),
  mockPoolQuery: vi.fn(),
  mockGetDuplicateDealRaceStats: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  pool: { query: mockPoolQuery },
  getPoolResetStats: mockGetPoolResetStats,
  getDuplicateDealRaceStats: mockGetDuplicateDealRaceStats,
}));

vi.mock("../server/lib/outreach-state.js", () => ({
  outreachPaused: false,
  outreachPauseReason: "",
}));

vi.mock("../server/growth-health.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/growth-health.js")>();
  return {
    ...original,
    getGrowthHealthSnapshot: vi.fn().mockResolvedValue({ overall: "green", subsystems: [] }),
    invalidateGrowthHealthCache: vi.fn(),
  };
});

import {
  getDbPoolThresholds,
  setDbPoolThresholds,
  resetDbPoolThresholds,
  getErrorRateThresholds,
  setErrorRateThresholds,
  resetErrorRateThresholds,
  getWebhookSuccessThresholds,
  setWebhookSuccessThresholds,
  resetWebhookSuccessThresholds,
  resetDupeDealRaceThresholds,
} from "../server/lib/watchtower-settings.js";

import {
  evalDbPoolHealth,
  evalErrorRate,
  evalOutboundWebhooks,
} from "../server/growth-health.js";

import { findRule } from "../server/lib/growth-health-rules.js";

const dbPoolRule = findRule("db_pool_health")!;
const errorRateRule = findRule("error_rate")!;
const webhookRule = findRule("outbound_webhooks")!;

beforeEach(() => {
  mockGetPoolResetStats.mockReset();
  mockPoolQuery.mockReset();
  mockGetDuplicateDealRaceStats.mockReset();
});

// ── DB pool reset threshold helpers ─────────────────────────────────────

describe("getDbPoolThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getDbPoolThresholds(30, 60);
    expect(result).toEqual({ yellow: 30, red: 60, source: "env" });
  });

  it("returns env defaults when only one key is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: "watchtower_pool_resets_yellow", value: "10" }],
    });
    const result = await getDbPoolThresholds(30, 60);
    expect(result).toEqual({ yellow: 30, red: 60, source: "env" });
  });

  it("returns DB values when both keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_pool_resets_yellow", value: "15" },
        { key: "watchtower_pool_resets_red", value: "45" },
      ],
    });
    const result = await getDbPoolThresholds(30, 60);
    expect(result).toEqual({ yellow: 15, red: 45, source: "db" });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getDbPoolThresholds(30, 60);
    expect(result.yellow).toBe(30);
    expect(result.red).toBe(60);
    expect(result.source).toBe("env");
  });

  it("sets readError=true when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getDbPoolThresholds(30, 60);
    expect(result.readError).toBe(true);
  });

  it("does not set readError when pool.query succeeds but keys are absent", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getDbPoolThresholds(30, 60);
    expect(result.readError).toBeUndefined();
  });
});

describe("setDbPoolThresholds", () => {
  it("upserts both keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setDbPoolThresholds(10, 50);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    expect(params).toContain("watchtower_pool_resets_yellow");
    expect(params).toContain("watchtower_pool_resets_red");
    expect(params).toContain("10");
    expect(params).toContain("50");
  });
});

// ── Error rate threshold helpers ─────────────────────────────────────────

describe("getErrorRateThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getErrorRateThresholds(20, 50);
    expect(result).toEqual({ yellow: 20, red: 50, source: "env" });
  });

  it("returns DB values when both keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_error_rate_yellow", value: "5" },
        { key: "watchtower_error_rate_red", value: "25" },
      ],
    });
    const result = await getErrorRateThresholds(20, 50);
    expect(result).toEqual({ yellow: 5, red: 25, source: "db" });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getErrorRateThresholds(20, 50);
    expect(result.yellow).toBe(20);
    expect(result.red).toBe(50);
    expect(result.source).toBe("env");
  });

  it("sets readError=true when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getErrorRateThresholds(20, 50);
    expect(result.readError).toBe(true);
  });

  it("does not set readError when pool.query succeeds but keys are absent", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getErrorRateThresholds(20, 50);
    expect(result.readError).toBeUndefined();
  });
});

describe("setErrorRateThresholds", () => {
  it("upserts both keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setErrorRateThresholds(5, 25);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    expect(params).toContain("watchtower_error_rate_yellow");
    expect(params).toContain("watchtower_error_rate_red");
    expect(params).toContain("5");
    expect(params).toContain("25");
  });
});

// ── Webhook success threshold helpers ────────────────────────────────────

describe("getWebhookSuccessThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getWebhookSuccessThresholds(0.95, 0.9, 5);
    expect(result).toEqual({ yellow: 0.95, red: 0.9, minVolume: 5, source: "env" });
  });

  it("returns env defaults when only two of three keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_webhook_success_yellow", value: "0.98" },
        { key: "watchtower_webhook_success_red", value: "0.85" },
      ],
    });
    const result = await getWebhookSuccessThresholds(0.95, 0.9, 5);
    expect(result).toEqual({ yellow: 0.95, red: 0.9, minVolume: 5, source: "env" });
  });

  it("returns DB values when all three keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_webhook_success_yellow", value: "0.98" },
        { key: "watchtower_webhook_success_red", value: "0.85" },
        { key: "watchtower_webhook_success_min_volume", value: "10" },
      ],
    });
    const result = await getWebhookSuccessThresholds(0.95, 0.9, 5);
    expect(result).toEqual({ yellow: 0.98, red: 0.85, minVolume: 10, source: "db" });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getWebhookSuccessThresholds(0.95, 0.9, 5);
    expect(result.yellow).toBe(0.95);
    expect(result.red).toBe(0.9);
    expect(result.minVolume).toBe(5);
    expect(result.source).toBe("env");
  });

  it("sets readError=true when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getWebhookSuccessThresholds(0.95, 0.9, 5);
    expect(result.readError).toBe(true);
  });

  it("does not set readError when pool.query succeeds but keys are absent", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getWebhookSuccessThresholds(0.95, 0.9, 5);
    expect(result.readError).toBeUndefined();
  });
});

describe("setWebhookSuccessThresholds", () => {
  it("upserts all three keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setWebhookSuccessThresholds(0.98, 0.85, 10);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    expect(params).toContain("watchtower_webhook_success_yellow");
    expect(params).toContain("watchtower_webhook_success_red");
    expect(params).toContain("watchtower_webhook_success_min_volume");
    expect(params).toContain("0.98");
    expect(params).toContain("0.85");
    expect(params).toContain("10");
  });
});

// ── Evaluator integration: evaluators pick up DB-overridden thresholds ───

describe("evalDbPoolHealth with DB-overridden thresholds", () => {
  function mockDbPoolThresholds(yellow: number, red: number) {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_pool_resets_yellow", value: String(yellow) },
        { key: "watchtower_pool_resets_red", value: String(red) },
      ],
    });
  }

  it("stays green when resets are below the DB-overridden yellow threshold", async () => {
    const customYellow = 5;
    const customRed = 10;
    mockDbPoolThresholds(customYellow, customRed);
    mockGetPoolResetStats.mockReturnValue({
      count: customYellow - 1,
      total: 100,
      windowMs: 60 * 60 * 1000,
    });
    const r = await evalDbPoolHealth(dbPoolRule);
    expect(r.status).toBe("green");
  });

  it("trips yellow at the DB-overridden yellow threshold", async () => {
    const customYellow = 5;
    const customRed = 10;
    mockDbPoolThresholds(customYellow, customRed);
    mockGetPoolResetStats.mockReturnValue({
      count: customYellow,
      total: 100,
      windowMs: 60 * 60 * 1000,
    });
    const r = await evalDbPoolHealth(dbPoolRule);
    expect(r.status).toBe("yellow");
  });

  it("trips red at the DB-overridden red threshold", async () => {
    const customYellow = 5;
    const customRed = 10;
    mockDbPoolThresholds(customYellow, customRed);
    mockGetPoolResetStats.mockReturnValue({
      count: customRed,
      total: 200,
      windowMs: 60 * 60 * 1000,
    });
    const r = await evalDbPoolHealth(dbPoolRule);
    expect(r.status).toBe("red");
    expect(r.reasons.join(" ")).toMatch(/pool reset/i);
  });

  it("exposes DB thresholds in meta", async () => {
    const customYellow = 5;
    const customRed = 10;
    mockDbPoolThresholds(customYellow, customRed);
    mockGetPoolResetStats.mockReturnValue({ count: 0, total: 0, windowMs: 60 * 60 * 1000 });
    const r = await evalDbPoolHealth(dbPoolRule);
    expect((r.meta as any).thresholds.source).toBe("db");
    expect(Number((r.meta as any).thresholds.yellow)).toBe(customYellow);
    expect(Number((r.meta as any).thresholds.red)).toBe(customRed);
  });
});

describe("evalErrorRate with DB-overridden thresholds", () => {
  function mockErrorRateQuery(distinctCount: number, yellow: number, red: number) {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            c: String(distinctCount),
            latest: distinctCount > 0 ? "some error" : null,
            latest_at: distinctCount > 0 ? String(Date.now()) : null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "watchtower_error_rate_yellow", value: String(yellow) },
          { key: "watchtower_error_rate_red", value: String(red) },
        ],
      });
  }

  it("stays green when fingerprints are below the DB-overridden yellow threshold", async () => {
    const customYellow = 3;
    const customRed = 8;
    mockErrorRateQuery(customYellow - 1, customYellow, customRed);
    const r = await evalErrorRate(errorRateRule);
    expect(r.status).toBe("green");
  });

  it("trips yellow at the DB-overridden yellow threshold", async () => {
    const customYellow = 3;
    const customRed = 8;
    mockErrorRateQuery(customYellow, customYellow, customRed);
    const r = await evalErrorRate(errorRateRule);
    expect(r.status).toBe("yellow");
  });

  it("trips red at the DB-overridden red threshold", async () => {
    const customYellow = 3;
    const customRed = 8;
    mockErrorRateQuery(customRed, customYellow, customRed);
    const r = await evalErrorRate(errorRateRule);
    expect(r.status).toBe("red");
  });
});

describe("evalOutboundWebhooks with DB-overridden thresholds", () => {
  function mockWebhookQuery(delivered: number, failed: number, yellow: number, red: number, minVolume: number) {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ delivered: String(delivered), failed: String(failed) }],
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "watchtower_webhook_success_yellow", value: String(yellow) },
          { key: "watchtower_webhook_success_red", value: String(red) },
          { key: "watchtower_webhook_success_min_volume", value: String(minVolume) },
        ],
      });
  }

  it("stays green when volume is below min volume threshold", async () => {
    mockWebhookQuery(2, 1, 0.95, 0.9, 10);
    const r = await evalOutboundWebhooks(webhookRule);
    expect(r.status).toBe("green");
  });

  it("trips yellow when success rate falls below the DB-overridden yellow threshold", async () => {
    const customYellow = 0.98;
    const customRed = 0.85;
    const minVolume = 5;
    const total = 20;
    const failed = Math.ceil(total * (1 - customYellow + 0.01));
    const delivered = total - failed;
    mockWebhookQuery(delivered, failed, customYellow, customRed, minVolume);
    const r = await evalOutboundWebhooks(webhookRule);
    expect(r.status).toBe("yellow");
  });

  it("trips red when success rate falls below the DB-overridden red threshold", async () => {
    const customYellow = 0.98;
    const customRed = 0.85;
    const minVolume = 5;
    const total = 20;
    const failed = Math.ceil(total * (1 - customRed + 0.01));
    const delivered = total - failed;
    mockWebhookQuery(delivered, failed, customYellow, customRed, minVolume);
    const r = await evalOutboundWebhooks(webhookRule);
    expect(r.status).toBe("red");
  });
});

// ── HTTP route validation ────────────────────────────────────────────────

async function buildServer() {
  process.env.ADMIN_KEY = "test-key-12345";

  const { registerAdminGrowthHealthRoutes } = await import(
    "../server/routes/admin/growth-health.js"
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).session = {};
    next();
  });
  registerAdminGrowthHealthRoutes(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function request(method: string, path: string, body?: object) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "test-key-12345",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function unauthRequest(method: string, path: string) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  return {
    request,
    unauthRequest,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("POST /api/admin/growth-health/pool-resets-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when yellow is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/pool-resets-thresholds",
      { yellow: -1, red: 60 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/yellow/i);
  });

  it("rejects when red is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/pool-resets-thresholds",
      { yellow: 10, red: -5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/red/i);
  });

  it("rejects when yellow >= red", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/pool-resets-thresholds",
      { yellow: 60, red: 30 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/yellow.*less than red/i);
  });

  it("rejects when yellow equals red", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/pool-resets-thresholds",
      { yellow: 30, red: 30 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/pool-resets-thresholds",
      { yellow: 10, red: 50 },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ yellow: 10, red: 50, source: "db" });
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/error-rate-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when yellow is not a number", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/error-rate-thresholds",
      { yellow: "abc", red: 50 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/yellow/i);
  });

  it("rejects when yellow >= red", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/error-rate-thresholds",
      { yellow: 50, red: 20 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/yellow.*less than red/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/error-rate-thresholds",
      { yellow: 5, red: 25 },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ yellow: 5, red: 25, source: "db" });
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/webhook-success-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when yellow is above 1 (not a valid rate)", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/webhook-success-thresholds",
      { yellow: 1.5, red: 0.9, minVolume: 5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/yellow.*rate/i);
  });

  it("rejects when red is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/webhook-success-thresholds",
      { yellow: 0.95, red: -0.1, minVolume: 5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/red.*rate/i);
  });

  it("rejects when red >= yellow (lower success rate = worse, so red must be below yellow)", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/webhook-success-thresholds",
      { yellow: 0.9, red: 0.95, minVolume: 5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/red.*less than yellow/i);
  });

  it("rejects when red equals yellow", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/webhook-success-thresholds",
      { yellow: 0.95, red: 0.95, minVolume: 5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("rejects when minVolume is not an integer", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/webhook-success-thresholds",
      { yellow: 0.95, red: 0.9, minVolume: 2.5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/minVolume/i);
  });

  it("rejects when minVolume is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/webhook-success-thresholds",
      { yellow: 0.95, red: 0.9, minVolume: -1 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/minVolume/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/webhook-success-thresholds",
      { yellow: 0.98, red: 0.85, minVolume: 10 },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ yellow: 0.98, red: 0.85, minVolume: 10, source: "db" });
  });

  afterEach(() => server.close());
});

// ── GET endpoints return env defaults and expose envDefaults field ────────

describe("GET /api/admin/growth-health/pool-resets-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/pool-resets-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
    expect(body.data.yellow).toBe(body.data.envDefaults.yellow);
    expect(body.data.red).toBe(body.data.envDefaults.red);
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_pool_resets_yellow", value: "15" },
        { key: "watchtower_pool_resets_red", value: "45" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/pool-resets-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.yellow).toBe(15);
    expect(body.data.red).toBe(45);
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/error-rate-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/error-rate-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.yellow).toBe(body.data.envDefaults.yellow);
    expect(body.data.red).toBe(body.data.envDefaults.red);
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_error_rate_yellow", value: "5" },
        { key: "watchtower_error_rate_red", value: "25" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/error-rate-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.yellow).toBe(5);
    expect(body.data.red).toBe(25);
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/webhook-success-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/webhook-success-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.yellow).toBe(body.data.envDefaults.yellow);
    expect(body.data.red).toBe(body.data.envDefaults.red);
    expect(body.data.minVolume).toBe(body.data.envDefaults.minVolume);
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_webhook_success_yellow", value: "0.98" },
        { key: "watchtower_webhook_success_red", value: "0.85" },
        { key: "watchtower_webhook_success_min_volume", value: "10" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/webhook-success-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.yellow).toBeCloseTo(0.98);
    expect(body.data.red).toBeCloseTo(0.85);
    expect(body.data.minVolume).toBe(10);
  });

  afterEach(() => server.close());
});

// ── Unit tests: reset helpers ─────────────────────────────────────────────────

describe("resetDupeDealRaceThresholds", () => {
  it("issues a DELETE query for both dupe-deal-race keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetDupeDealRaceThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_dupe_deal_races_yellow");
    expect(keys).toContain("watchtower_dupe_deal_races_red");
  });
});

describe("resetDbPoolThresholds", () => {
  it("issues a DELETE query for both pool-resets keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetDbPoolThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_pool_resets_yellow");
    expect(keys).toContain("watchtower_pool_resets_red");
  });
});

describe("resetErrorRateThresholds", () => {
  it("issues a DELETE query for both error-rate keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetErrorRateThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_error_rate_yellow");
    expect(keys).toContain("watchtower_error_rate_red");
  });
});

describe("resetWebhookSuccessThresholds", () => {
  it("issues a DELETE query for all three webhook-success keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetWebhookSuccessThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_webhook_success_yellow");
    expect(keys).toContain("watchtower_webhook_success_red");
    expect(keys).toContain("watchtower_webhook_success_min_volume");
  });
});

// ── Integration tests: DELETE endpoints ──────────────────────────────────────

describe("DELETE /api/admin/growth-health/dupe-deal-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } when authorized", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/dupe-deal-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("calls the DB delete for both dupe-deal keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/dupe-deal-thresholds");
    expect(mockPoolQuery).toHaveBeenCalled();
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_dupe_deal_races_yellow");
    expect(keys).toContain("watchtower_dupe_deal_races_red");
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/dupe-deal-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/pool-resets-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } when authorized", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/pool-resets-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("calls the DB delete for both pool-resets keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/pool-resets-thresholds");
    expect(mockPoolQuery).toHaveBeenCalled();
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_pool_resets_yellow");
    expect(keys).toContain("watchtower_pool_resets_red");
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/pool-resets-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/error-rate-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } when authorized", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/error-rate-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("calls the DB delete for both error-rate keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/error-rate-thresholds");
    expect(mockPoolQuery).toHaveBeenCalled();
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_error_rate_yellow");
    expect(keys).toContain("watchtower_error_rate_red");
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/error-rate-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/webhook-success-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } when authorized", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/webhook-success-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("calls the DB delete for all three webhook-success keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/webhook-success-thresholds");
    expect(mockPoolQuery).toHaveBeenCalled();
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    expect(keys).toContain("watchtower_webhook_success_yellow");
    expect(keys).toContain("watchtower_webhook_success_red");
    expect(keys).toContain("watchtower_webhook_success_min_volume");
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/webhook-success-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

// ── GET endpoints expose readError=true when DB is unreachable ────────────────

describe("GET /api/admin/growth-health/pool-resets-thresholds exposes readError on DB failure", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("includes readError=true in the response when the DB query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("connection refused"));
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/pool-resets-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.readError).toBe(true);
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/error-rate-thresholds exposes readError on DB failure", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("includes readError=true in the response when the DB query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("timeout"));
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/error-rate-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.readError).toBe(true);
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/webhook-success-thresholds exposes readError on DB failure", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("includes readError=true in the response when the DB query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("gone"));
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/webhook-success-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.readError).toBe(true);
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/dupe-deal-thresholds exposes readError on DB failure", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("includes readError=true in the response when the DB query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("db gone"));
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/dupe-deal-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.readError).toBe(true);
  });

  it("does not include readError when DB succeeds but returns no rows", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/dupe-deal-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.readError).toBeUndefined();
  });

  afterEach(() => server.close());
});
