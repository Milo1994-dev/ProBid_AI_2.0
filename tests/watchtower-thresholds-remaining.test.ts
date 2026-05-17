import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

/**
 * Tests for the remaining Watchtower threshold endpoints not covered by
 * watchtower-thresholds.test.ts:
 *   - dupe-deal-thresholds        (GET + POST; DELETE already covered)
 *   - lead-scraper-thresholds     (GET, POST, DELETE)
 *   - outreach-processor-thresholds (GET, POST, DELETE)
 *   - deliverability-thresholds   (GET, POST, DELETE)
 *   - stripe-webhook-thresholds   (GET, POST, DELETE)
 *   - procore-sync-thresholds     (GET, POST, DELETE)
 *   - cron-scheduler-thresholds   (GET, POST, DELETE)
 */

const { mockPoolQuery } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  pool: { query: mockPoolQuery },
  getPoolResetStats: vi.fn(),
  getDuplicateDealRaceStats: vi.fn(),
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
  getDupeDealRaceThresholds,
  setDupeDealRaceThresholds,
  getLeadScraperThresholds,
  setLeadScraperThresholds,
  resetLeadScraperThresholds,
  getOutreachProcessorThresholds,
  setOutreachProcessorThresholds,
  resetOutreachProcessorThresholds,
  getOutreachDeliverabilityThresholds,
  setOutreachDeliverabilityThresholds,
  resetOutreachDeliverabilityThresholds,
  getStripeWebhookThresholds,
  setStripeWebhookThresholds,
  resetStripeWebhookThresholds,
  getProcoreSyncThresholds,
  setProcoreSyncThresholds,
  resetProcoreSyncThresholds,
  getCronSchedulerThresholds,
  setCronSchedulerThresholds,
  resetCronSchedulerThresholds,
} from "../server/lib/watchtower-settings.js";

beforeEach(() => {
  mockPoolQuery.mockReset();
});

// ── Duplicate Deal Race helpers ───────────────────────────────────────────────

describe("getDupeDealRaceThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getDupeDealRaceThresholds(5, 20);
    expect(result).toEqual({ yellow: 5, red: 20, source: "env" });
  });

  it("returns env defaults when only one key is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: "watchtower_dupe_deal_races_yellow", value: "3" }],
    });
    const result = await getDupeDealRaceThresholds(5, 20);
    expect(result).toEqual({ yellow: 5, red: 20, source: "env" });
  });

  it("returns DB values when both keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_dupe_deal_races_yellow", value: "3" },
        { key: "watchtower_dupe_deal_races_red", value: "15" },
      ],
    });
    const result = await getDupeDealRaceThresholds(5, 20);
    expect(result).toEqual({ yellow: 3, red: 15, source: "db" });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getDupeDealRaceThresholds(5, 20);
    expect(result.yellow).toBe(5);
    expect(result.red).toBe(20);
    expect(result.source).toBe("env");
    expect(result.readError).toBe(true);
  });
});

describe("setDupeDealRaceThresholds", () => {
  it("upserts both keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setDupeDealRaceThresholds(3, 15);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    expect(params).toContain("watchtower_dupe_deal_races_yellow");
    expect(params).toContain("watchtower_dupe_deal_races_red");
    expect(params).toContain("3");
    expect(params).toContain("15");
  });
});

// ── Lead Scraper helpers ──────────────────────────────────────────────────────

const LS_ENV = {
  staleYellow: 26 * 60,
  staleRed: 48 * 60,
  failRateYellow: 0.5,
  failRateRed: 0.9,
  zeroOutputRunsRed: 3,
};
const LS_KEYS = [
  "watchtower_lead_scraper_stale_yellow",
  "watchtower_lead_scraper_stale_red",
  "watchtower_lead_scraper_fail_rate_yellow",
  "watchtower_lead_scraper_fail_rate_red",
  "watchtower_lead_scraper_zero_output_runs_red",
];

describe("getLeadScraperThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getLeadScraperThresholds(LS_ENV);
    expect(result).toEqual({ ...LS_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_lead_scraper_stale_yellow", value: "100" },
        { key: "watchtower_lead_scraper_stale_red", value: "200" },
        { key: "watchtower_lead_scraper_fail_rate_yellow", value: "0.3" },
        { key: "watchtower_lead_scraper_fail_rate_red", value: "0.7" },
        { key: "watchtower_lead_scraper_zero_output_runs_red", value: "5" },
      ],
    });
    const result = await getLeadScraperThresholds(LS_ENV);
    expect(result).toMatchObject({
      staleYellow: 100,
      staleRed: 200,
      failRateYellow: 0.3,
      failRateRed: 0.7,
      zeroOutputRunsRed: 5,
      source: "db",
    });
  });

  it("falls back to env when only some keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: "watchtower_lead_scraper_stale_yellow", value: "100" }],
    });
    const result = await getLeadScraperThresholds(LS_ENV);
    expect(result.source).toBe("env");
  });
});

describe("setLeadScraperThresholds", () => {
  it("upserts all five keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setLeadScraperThresholds({ staleYellow: 100, staleRed: 200, failRateYellow: 0.3, failRateRed: 0.7, zeroOutputRunsRed: 5 });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of LS_KEYS) expect(params).toContain(key);
  });
});

describe("resetLeadScraperThresholds", () => {
  it("issues a DELETE query for all lead-scraper keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetLeadScraperThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of LS_KEYS) expect(keys).toContain(key);
  });
});

// ── Outreach Processor helpers ────────────────────────────────────────────────

const OP_ENV = { staleYellow: 90, staleRed: 240, zeroSendYellow: 4, zeroSendRed: 8 };
const OP_KEYS = [
  "watchtower_outreach_processor_stale_yellow",
  "watchtower_outreach_processor_stale_red",
  "watchtower_outreach_processor_zero_send_yellow",
  "watchtower_outreach_processor_zero_send_red",
];

describe("getOutreachProcessorThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getOutreachProcessorThresholds(OP_ENV);
    expect(result).toEqual({ ...OP_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_outreach_processor_stale_yellow", value: "60" },
        { key: "watchtower_outreach_processor_stale_red", value: "180" },
        { key: "watchtower_outreach_processor_zero_send_yellow", value: "2" },
        { key: "watchtower_outreach_processor_zero_send_red", value: "6" },
      ],
    });
    const result = await getOutreachProcessorThresholds(OP_ENV);
    expect(result).toMatchObject({ staleYellow: 60, staleRed: 180, zeroSendYellow: 2, zeroSendRed: 6, source: "db" });
  });
});

describe("setOutreachProcessorThresholds", () => {
  it("upserts all four keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setOutreachProcessorThresholds({ staleYellow: 60, staleRed: 180, zeroSendYellow: 2, zeroSendRed: 6 });
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of OP_KEYS) expect(params).toContain(key);
  });
});

describe("resetOutreachProcessorThresholds", () => {
  it("issues a DELETE query for all outreach-processor keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetOutreachProcessorThresholds();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of OP_KEYS) expect(keys).toContain(key);
  });
});

// ── Outreach Deliverability helpers ──────────────────────────────────────────

const OD_ENV = { staleYellow: 36 * 60, staleRed: 72 * 60, failRateYellow: 0.05, failRateRed: 0.1 };
const OD_KEYS = [
  "watchtower_outreach_deliverability_stale_yellow",
  "watchtower_outreach_deliverability_stale_red",
  "watchtower_outreach_deliverability_fail_rate_yellow",
  "watchtower_outreach_deliverability_fail_rate_red",
];

describe("getOutreachDeliverabilityThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getOutreachDeliverabilityThresholds(OD_ENV);
    expect(result).toEqual({ ...OD_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_outreach_deliverability_stale_yellow", value: "1000" },
        { key: "watchtower_outreach_deliverability_stale_red", value: "2000" },
        { key: "watchtower_outreach_deliverability_fail_rate_yellow", value: "0.03" },
        { key: "watchtower_outreach_deliverability_fail_rate_red", value: "0.08" },
      ],
    });
    const result = await getOutreachDeliverabilityThresholds(OD_ENV);
    expect(result).toMatchObject({ staleYellow: 1000, staleRed: 2000, failRateYellow: 0.03, failRateRed: 0.08, source: "db" });
  });
});

describe("setOutreachDeliverabilityThresholds", () => {
  it("upserts all four keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setOutreachDeliverabilityThresholds({ staleYellow: 1000, staleRed: 2000, failRateYellow: 0.03, failRateRed: 0.08 });
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of OD_KEYS) expect(params).toContain(key);
  });
});

describe("resetOutreachDeliverabilityThresholds", () => {
  it("issues a DELETE query for all deliverability keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetOutreachDeliverabilityThresholds();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of OD_KEYS) expect(keys).toContain(key);
  });
});

// ── Stripe Webhook helpers ────────────────────────────────────────────────────

const SW_ENV = { failRateYellow: 0.2, failRateRed: 0.5, sigFailsRed: 1 };
const SW_KEYS = [
  "watchtower_stripe_webhook_fail_rate_yellow",
  "watchtower_stripe_webhook_fail_rate_red",
  "watchtower_stripe_webhook_sig_fails_red",
];

describe("getStripeWebhookThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getStripeWebhookThresholds(SW_ENV);
    expect(result).toEqual({ ...SW_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_stripe_webhook_fail_rate_yellow", value: "0.1" },
        { key: "watchtower_stripe_webhook_fail_rate_red", value: "0.3" },
        { key: "watchtower_stripe_webhook_sig_fails_red", value: "2" },
      ],
    });
    const result = await getStripeWebhookThresholds(SW_ENV);
    expect(result).toMatchObject({ failRateYellow: 0.1, failRateRed: 0.3, sigFailsRed: 2, source: "db" });
  });
});

describe("setStripeWebhookThresholds", () => {
  it("upserts all three keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setStripeWebhookThresholds({ failRateYellow: 0.1, failRateRed: 0.3, sigFailsRed: 2 });
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of SW_KEYS) expect(params).toContain(key);
  });
});

describe("resetStripeWebhookThresholds", () => {
  it("issues a DELETE query for all stripe-webhook keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetStripeWebhookThresholds();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of SW_KEYS) expect(keys).toContain(key);
  });
});

// ── Procore Sync helpers ──────────────────────────────────────────────────────

const PS_ENV = { staleYellow: 26 * 60, staleRed: 72 * 60, connStaleYellow: 26 * 60, connStaleRed: 36 * 60 };
const PS_KEYS = [
  "watchtower_procore_sync_stale_yellow",
  "watchtower_procore_sync_stale_red",
  "watchtower_procore_sync_conn_stale_yellow",
  "watchtower_procore_sync_conn_stale_red",
];

describe("getProcoreSyncThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getProcoreSyncThresholds(PS_ENV);
    expect(result).toEqual({ ...PS_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_procore_sync_stale_yellow", value: "500" },
        { key: "watchtower_procore_sync_stale_red", value: "1000" },
        { key: "watchtower_procore_sync_conn_stale_yellow", value: "400" },
        { key: "watchtower_procore_sync_conn_stale_red", value: "800" },
      ],
    });
    const result = await getProcoreSyncThresholds(PS_ENV);
    expect(result).toMatchObject({ staleYellow: 500, staleRed: 1000, connStaleYellow: 400, connStaleRed: 800, source: "db" });
  });
});

describe("setProcoreSyncThresholds", () => {
  it("upserts all four keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setProcoreSyncThresholds({ staleYellow: 500, staleRed: 1000, connStaleYellow: 400, connStaleRed: 800 });
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of PS_KEYS) expect(params).toContain(key);
  });
});

describe("resetProcoreSyncThresholds", () => {
  it("issues a DELETE query for all procore-sync keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetProcoreSyncThresholds();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of PS_KEYS) expect(keys).toContain(key);
  });
});

// ── Cron Scheduler helpers ────────────────────────────────────────────────────

const CS_ENV = { staleYellow: 90, staleRed: 240 };
const CS_KEYS = [
  "watchtower_cron_scheduler_stale_yellow",
  "watchtower_cron_scheduler_stale_red",
];

describe("getCronSchedulerThresholds", () => {
  it("returns env defaults when no DB rows exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getCronSchedulerThresholds(CS_ENV);
    expect(result).toEqual({ ...CS_ENV, source: "env" });
  });

  it("returns DB values when both keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_cron_scheduler_stale_yellow", value: "60" },
        { key: "watchtower_cron_scheduler_stale_red", value: "180" },
      ],
    });
    const result = await getCronSchedulerThresholds(CS_ENV);
    expect(result).toEqual({ staleYellow: 60, staleRed: 180, source: "db" });
  });
});

describe("setCronSchedulerThresholds", () => {
  it("upserts both keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setCronSchedulerThresholds({ staleYellow: 60, staleRed: 180 });
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of CS_KEYS) expect(params).toContain(key);
  });
});

describe("resetCronSchedulerThresholds", () => {
  it("issues a DELETE query for both cron-scheduler keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetCronSchedulerThresholds();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of CS_KEYS) expect(keys).toContain(key);
  });
});

// ── HTTP route tests ──────────────────────────────────────────────────────────

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

// ── dupe-deal-thresholds GET ──────────────────────────────────────────────────

describe("GET /api/admin/growth-health/dupe-deal-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/dupe-deal-thresholds");
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
        { key: "watchtower_dupe_deal_races_yellow", value: "3" },
        { key: "watchtower_dupe_deal_races_red", value: "15" },
      ],
    });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/dupe-deal-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.yellow).toBe(3);
    expect(body.data.red).toBe(15);
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status, body } = await server.unauthRequest("GET", "/api/admin/growth-health/dupe-deal-thresholds");
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

// ── dupe-deal-thresholds POST ─────────────────────────────────────────────────

describe("POST /api/admin/growth-health/dupe-deal-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when yellow is negative", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/dupe-deal-thresholds", { yellow: -1, red: 20 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/yellow/i);
  });

  it("rejects when red is negative", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/dupe-deal-thresholds", { yellow: 5, red: -1 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/red/i);
  });

  it("rejects when yellow >= red", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/dupe-deal-thresholds", { yellow: 20, red: 5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/yellow.*less than red/i);
  });

  it("rejects when yellow equals red", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/dupe-deal-thresholds", { yellow: 10, red: 10 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("rejects when yellow is not a number", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/dupe-deal-thresholds", { yellow: "bad", red: 20 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/dupe-deal-thresholds", { yellow: 3, red: 15 },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ yellow: 3, red: 15, source: "db" });
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("POST", "/api/admin/growth-health/dupe-deal-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// ── lead-scraper-thresholds ───────────────────────────────────────────────────

describe("GET /api/admin/growth-health/lead-scraper-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_lead_scraper_stale_yellow", value: "100" },
        { key: "watchtower_lead_scraper_stale_red", value: "200" },
        { key: "watchtower_lead_scraper_fail_rate_yellow", value: "0.3" },
        { key: "watchtower_lead_scraper_fail_rate_red", value: "0.7" },
        { key: "watchtower_lead_scraper_zero_output_runs_red", value: "5" },
      ],
    });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(100);
    expect(body.data.staleRed).toBe(200);
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/lead-scraper-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  const validBody = {
    staleYellow: 100, staleRed: 200, failRateYellow: 0.3, failRateRed: 0.7, zeroOutputRunsRed: 5,
  };

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/lead-scraper-thresholds",
      { ...validBody, staleYellow: 200, staleRed: 100 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when failRateYellow is out of range (>1)", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/lead-scraper-thresholds",
      { ...validBody, failRateYellow: 1.5 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow/i);
  });

  it("rejects when failRateYellow >= failRateRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/lead-scraper-thresholds",
      { ...validBody, failRateYellow: 0.8, failRateRed: 0.5 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow.*less than failRateRed/i);
  });

  it("rejects when zeroOutputRunsRed is not a positive integer", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/lead-scraper-thresholds",
      { ...validBody, zeroOutputRunsRed: 1.5 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/zeroOutputRunsRed/i);
  });

  it("rejects when staleYellow is negative", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/lead-scraper-thresholds",
      { ...validBody, staleYellow: -10 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/lead-scraper-thresholds", validBody,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(100);
    expect(body.data.zeroOutputRunsRed).toBe(5);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/lead-scraper-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } when authorized", async () => {
    const { status, body } = await server.request("DELETE", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("issues a DELETE query for all lead-scraper keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(mockPoolQuery).toHaveBeenCalled();
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    for (const key of LS_KEYS) expect(keys).toContain(key);
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("DELETE", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// ── outreach-processor-thresholds ────────────────────────────────────────────

describe("GET /api/admin/growth-health/outreach-processor-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/outreach-processor-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_outreach_processor_stale_yellow", value: "60" },
        { key: "watchtower_outreach_processor_stale_red", value: "180" },
        { key: "watchtower_outreach_processor_zero_send_yellow", value: "2" },
        { key: "watchtower_outreach_processor_zero_send_red", value: "6" },
      ],
    });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/outreach-processor-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(60);
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/outreach-processor-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  const validBody = { staleYellow: 60, staleRed: 180, zeroSendYellow: 2, zeroSendRed: 6 };

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/outreach-processor-thresholds",
      { ...validBody, staleYellow: 200, staleRed: 100 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when zeroSendYellow >= zeroSendRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/outreach-processor-thresholds",
      { ...validBody, zeroSendYellow: 8, zeroSendRed: 4 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/zeroSendYellow.*less than zeroSendRed/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/outreach-processor-thresholds", validBody,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(60);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/outreach-processor-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } and deletes all outreach-processor keys", async () => {
    const { status, body } = await server.request("DELETE", "/api/admin/growth-health/outreach-processor-thresholds");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("DELETE", "/api/admin/growth-health/outreach-processor-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// ── deliverability-thresholds ─────────────────────────────────────────────────

describe("GET /api/admin/growth-health/deliverability-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/deliverability-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_outreach_deliverability_stale_yellow", value: "1000" },
        { key: "watchtower_outreach_deliverability_stale_red", value: "2000" },
        { key: "watchtower_outreach_deliverability_fail_rate_yellow", value: "0.03" },
        { key: "watchtower_outreach_deliverability_fail_rate_red", value: "0.08" },
      ],
    });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/deliverability-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(1000);
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/deliverability-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  const validBody = { staleYellow: 1000, staleRed: 2000, failRateYellow: 0.03, failRateRed: 0.08 };

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/deliverability-thresholds",
      { ...validBody, staleYellow: 2000, staleRed: 1000 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when failRateYellow is out of range (>1)", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/deliverability-thresholds",
      { ...validBody, failRateYellow: 1.2 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow/i);
  });

  it("rejects when failRateYellow >= failRateRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/deliverability-thresholds",
      { ...validBody, failRateYellow: 0.2, failRateRed: 0.1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow.*less than failRateRed/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/deliverability-thresholds", validBody,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("db");
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/deliverability-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } and deletes all deliverability keys", async () => {
    const { status, body } = await server.request("DELETE", "/api/admin/growth-health/deliverability-thresholds");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("DELETE", "/api/admin/growth-health/deliverability-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// ── stripe-webhook-thresholds ─────────────────────────────────────────────────

describe("GET /api/admin/growth-health/stripe-webhook-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_stripe_webhook_fail_rate_yellow", value: "0.1" },
        { key: "watchtower_stripe_webhook_fail_rate_red", value: "0.3" },
        { key: "watchtower_stripe_webhook_sig_fails_red", value: "2" },
      ],
    });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.failRateYellow).toBeCloseTo(0.1);
    expect(body.data.sigFailsRed).toBe(2);
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/stripe-webhook-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  const validBody = { failRateYellow: 0.1, failRateRed: 0.3, sigFailsRed: 2 };

  it("rejects when failRateYellow is out of range (>1)", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...validBody, failRateYellow: 1.5 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow/i);
  });

  it("rejects when failRateRed is negative", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...validBody, failRateRed: -0.1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateRed/i);
  });

  it("rejects when failRateYellow >= failRateRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...validBody, failRateYellow: 0.5, failRateRed: 0.2 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow.*less than failRateRed/i);
  });

  it("rejects when sigFailsRed is not a positive integer", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...validBody, sigFailsRed: 1.5 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/sigFailsRed/i);
  });

  it("rejects when sigFailsRed is 0", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...validBody, sigFailsRed: 0 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/sigFailsRed/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/stripe-webhook-thresholds", validBody,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("db");
    expect(body.data.sigFailsRed).toBe(2);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/stripe-webhook-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } and deletes all stripe-webhook keys", async () => {
    const { status, body } = await server.request("DELETE", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("issues a DELETE query for all stripe-webhook keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/stripe-webhook-thresholds");
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    for (const key of SW_KEYS) expect(keys).toContain(key);
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("DELETE", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// ── procore-sync-thresholds ───────────────────────────────────────────────────

describe("GET /api/admin/growth-health/procore-sync-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/procore-sync-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_procore_sync_stale_yellow", value: "500" },
        { key: "watchtower_procore_sync_stale_red", value: "1000" },
        { key: "watchtower_procore_sync_conn_stale_yellow", value: "400" },
        { key: "watchtower_procore_sync_conn_stale_red", value: "800" },
      ],
    });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/procore-sync-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(500);
    expect(body.data.connStaleRed).toBe(800);
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/procore-sync-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  const validBody = { staleYellow: 500, staleRed: 1000, connStaleYellow: 400, connStaleRed: 800 };

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/procore-sync-thresholds",
      { ...validBody, staleYellow: 1000, staleRed: 500 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when connStaleYellow >= connStaleRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/procore-sync-thresholds",
      { ...validBody, connStaleYellow: 900, connStaleRed: 400 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/connStaleYellow.*less than connStaleRed/i);
  });

  it("rejects when staleYellow is negative", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/procore-sync-thresholds",
      { ...validBody, staleYellow: -1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/procore-sync-thresholds", validBody,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("db");
    expect(body.data.connStaleYellow).toBe(400);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/procore-sync-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } and deletes all procore-sync keys", async () => {
    const { status, body } = await server.request("DELETE", "/api/admin/growth-health/procore-sync-thresholds");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("issues a DELETE query for all procore-sync keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/procore-sync-thresholds");
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    for (const key of PS_KEYS) expect(keys).toContain(key);
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("DELETE", "/api/admin/growth-health/procore-sync-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// ── cron-scheduler-thresholds ─────────────────────────────────────────────────

describe("GET /api/admin/growth-health/cron-scheduler-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_cron_scheduler_stale_yellow", value: "60" },
        { key: "watchtower_cron_scheduler_stale_red", value: "180" },
      ],
    });
    const { status, body } = await server.request("GET", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(60);
    expect(body.data.staleRed).toBe(180);
  });

  afterEach(() => server.close());
});

describe("POST /api/admin/growth-health/cron-scheduler-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: 180, staleRed: 60 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when staleYellow equals staleRed", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: 90, staleRed: 90 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("rejects when staleYellow is negative", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: -5, staleRed: 90 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("rejects when staleRed is negative", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: 60, staleRed: -1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleRed/i);
  });

  it("rejects when values are not numbers", async () => {
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: "abc", staleRed: 180 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("accepts valid values and returns them with source=db", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "POST", "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: 60, staleRed: 180 },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ staleYellow: 60, staleRed: 180, source: "db" });
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("POST", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/cron-scheduler-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns { success: true } when authorized", async () => {
    const { status, body } = await server.request("DELETE", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("issues a DELETE query for both cron-scheduler keys", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(mockPoolQuery).toHaveBeenCalled();
    const deleteCalls = mockPoolQuery.mock.calls.filter(([sql]: [string]) =>
      /DELETE FROM lead_outreach_config/i.test(sql),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
    const [, params] = deleteCalls[0] as [string, unknown[]];
    const keys = params[0] as string[];
    for (const key of CS_KEYS) expect(keys).toContain(key);
  });

  it("returns 401 when no admin key is provided", async () => {
    const { status } = await server.unauthRequest("DELETE", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// ── Source-transition tests: POST → DELETE → GET resets source to "env" ───────
//
// These tests verify the full lifecycle:
//   1. POST a valid override → source becomes "db"
//   2. DELETE the override   → DB rows are removed
//   3. GET after DELETE      → source reverts to "env"
//
// Each DB interaction uses a sequenced mock so no live Postgres is needed.

describe("dupe-deal-thresholds: POST then DELETE resets source to env", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("GET returns source=db after POST, then source=env after DELETE", async () => {
    mockPoolQuery.mockReset();
    // Call 1 – upsert (POST)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("POST", "/api/admin/growth-health/dupe-deal-thresholds", { yellow: 3, red: 15 });

    // Call 2 – SELECT (GET, returns stored rows → source=db)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_dupe_deal_races_yellow", value: "3" },
        { key: "watchtower_dupe_deal_races_red", value: "15" },
      ],
    });
    const afterPost = await server.request("GET", "/api/admin/growth-health/dupe-deal-thresholds");
    expect(afterPost.body.data.source).toBe("db");

    // Call 3 – DELETE (removes rows)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/dupe-deal-thresholds");

    // Call 4 – SELECT (GET, returns no rows → source=env)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const afterDelete = await server.request("GET", "/api/admin/growth-health/dupe-deal-thresholds");
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.data.source).toBe("env");
    expect(afterDelete.body.data.yellow).toBe(afterDelete.body.data.envDefaults.yellow);
  });

  afterEach(() => server.close());
});

describe("cron-scheduler-thresholds: POST then DELETE resets source to env", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("GET returns source=db after POST, then source=env after DELETE", async () => {
    mockPoolQuery.mockReset();
    // Call 1 – upsert (POST)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("POST", "/api/admin/growth-health/cron-scheduler-thresholds", { staleYellow: 60, staleRed: 180 });

    // Call 2 – SELECT (GET, returns stored rows → source=db)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_cron_scheduler_stale_yellow", value: "60" },
        { key: "watchtower_cron_scheduler_stale_red", value: "180" },
      ],
    });
    const afterPost = await server.request("GET", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(afterPost.body.data.source).toBe("db");
    expect(afterPost.body.data.staleYellow).toBe(60);

    // Call 3 – DELETE (removes rows)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/cron-scheduler-thresholds");

    // Call 4 – SELECT (GET, returns no rows → source=env)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const afterDelete = await server.request("GET", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.data.source).toBe("env");
    expect(afterDelete.body.data.staleYellow).toBe(afterDelete.body.data.envDefaults.staleYellow);
  });

  afterEach(() => server.close());
});

describe("stripe-webhook-thresholds: POST then DELETE resets source to env", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("GET returns source=db after POST, then source=env after DELETE", async () => {
    mockPoolQuery.mockReset();
    // Call 1 – upsert (POST)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("POST", "/api/admin/growth-health/stripe-webhook-thresholds", {
      failRateYellow: 0.1, failRateRed: 0.3, sigFailsRed: 2,
    });

    // Call 2 – SELECT (GET, returns stored rows → source=db)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_stripe_webhook_fail_rate_yellow", value: "0.1" },
        { key: "watchtower_stripe_webhook_fail_rate_red", value: "0.3" },
        { key: "watchtower_stripe_webhook_sig_fails_red", value: "2" },
      ],
    });
    const afterPost = await server.request("GET", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(afterPost.body.data.source).toBe("db");

    // Call 3 – DELETE (removes rows)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/stripe-webhook-thresholds");

    // Call 4 – SELECT (GET, returns no rows → source=env)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const afterDelete = await server.request("GET", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.data.source).toBe("env");
    expect(afterDelete.body.data.failRateYellow).toBe(afterDelete.body.data.envDefaults.failRateYellow);
  });

  afterEach(() => server.close());
});

describe("lead-scraper-thresholds: POST then DELETE resets source to env", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("GET returns source=db after POST, then source=env after DELETE", async () => {
    mockPoolQuery.mockReset();
    const validBody = { staleYellow: 100, staleRed: 200, failRateYellow: 0.3, failRateRed: 0.7, zeroOutputRunsRed: 5 };

    // Call 1 – upsert (POST)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("POST", "/api/admin/growth-health/lead-scraper-thresholds", validBody);

    // Call 2 – SELECT (GET, returns stored rows → source=db)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: "watchtower_lead_scraper_stale_yellow", value: "100" },
        { key: "watchtower_lead_scraper_stale_red", value: "200" },
        { key: "watchtower_lead_scraper_fail_rate_yellow", value: "0.3" },
        { key: "watchtower_lead_scraper_fail_rate_red", value: "0.7" },
        { key: "watchtower_lead_scraper_zero_output_runs_red", value: "5" },
      ],
    });
    const afterPost = await server.request("GET", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(afterPost.body.data.source).toBe("db");
    expect(afterPost.body.data.staleYellow).toBe(100);

    // Call 3 – DELETE (removes rows)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await server.request("DELETE", "/api/admin/growth-health/lead-scraper-thresholds");

    // Call 4 – SELECT (GET, returns no rows → source=env)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const afterDelete = await server.request("GET", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.data.source).toBe("env");
    expect(afterDelete.body.data.staleYellow).toBe(afterDelete.body.data.envDefaults.staleYellow);
  });

  afterEach(() => server.close());
});
