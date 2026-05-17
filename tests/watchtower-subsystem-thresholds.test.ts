import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

/**
 * Tests for the 6 new Watchtower subsystem threshold control pairs:
 *   - Lead Scraper           (lead-scraper-thresholds)
 *   - Outreach Processor     (outreach-processor-thresholds)
 *   - Outreach Deliverability (deliverability-thresholds)
 *   - Stripe Webhooks        (stripe-webhook-thresholds)
 *   - Procore Sync           (procore-sync-thresholds)
 *   - Cron Scheduler         (cron-scheduler-thresholds)
 *
 * Each section covers:
 *   1. Persistence helpers: GET returns env defaults / DB values
 *   2. Persistence helpers: SET writes the correct keys
 *   3. POST route validation rejections (bad values, yellow >= red, etc.)
 *   4. POST route accepts valid values and returns source: "db"
 *   5. GET route returns env defaults (source: "env") and DB overrides (source: "db")
 *   6. Integration: after POST the subsequent GET reflects the saved values
 *   7. Evaluator integration: evaluators use DB-overridden thresholds when computing health
 */

// ── shared mocks ──────────────────────────────────────────────────────────

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

import {
  evalLeadScraper,
  evalOutreachProcessor,
  evalOutreachDeliverability,
  evalStripeWebhooks,
  evalProcoreSync,
  evalCronScheduler,
} from "../server/growth-health.js";

import { findRule } from "../server/lib/growth-health-rules.js";

beforeEach(() => {
  mockPoolQuery.mockReset();
});

// ══════════════════════════════════════════════════════════════════════════
// ── Lead Scraper persistence helpers ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

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

  it("returns env defaults when only some keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: LS_KEYS[0], value: "100" },
        { key: LS_KEYS[1], value: "200" },
      ],
    });
    const result = await getLeadScraperThresholds(LS_ENV);
    expect(result).toEqual({ ...LS_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: LS_KEYS[0], value: "100" },
        { key: LS_KEYS[1], value: "200" },
        { key: LS_KEYS[2], value: "0.3" },
        { key: LS_KEYS[3], value: "0.8" },
        { key: LS_KEYS[4], value: "5" },
      ],
    });
    const result = await getLeadScraperThresholds(LS_ENV);
    expect(result).toEqual({
      staleYellow: 100,
      staleRed: 200,
      failRateYellow: 0.3,
      failRateRed: 0.8,
      zeroOutputRunsRed: 5,
      source: "db",
    });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getLeadScraperThresholds(LS_ENV);
    expect(result).toMatchObject({ ...LS_ENV, source: "env" });
    expect(result.readError).toBe(true);
  });
});

describe("setLeadScraperThresholds", () => {
  it("upserts all 5 keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setLeadScraperThresholds({
      staleYellow: 100,
      staleRed: 200,
      failRateYellow: 0.3,
      failRateRed: 0.8,
      zeroOutputRunsRed: 5,
    });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of LS_KEYS) {
      expect(params).toContain(key);
    }
    expect(params).toContain("100");
    expect(params).toContain("200");
    expect(params).toContain("0.3");
    expect(params).toContain("0.8");
    expect(params).toContain("5");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── Outreach Processor persistence helpers ────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const OP_ENV = {
  staleYellow: 90,
  staleRed: 240,
  zeroSendYellow: 4,
  zeroSendRed: 8,
};

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

  it("returns env defaults when only some keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: OP_KEYS[0], value: "50" }],
    });
    const result = await getOutreachProcessorThresholds(OP_ENV);
    expect(result).toEqual({ ...OP_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: OP_KEYS[0], value: "60" },
        { key: OP_KEYS[1], value: "180" },
        { key: OP_KEYS[2], value: "2" },
        { key: OP_KEYS[3], value: "6" },
      ],
    });
    const result = await getOutreachProcessorThresholds(OP_ENV);
    expect(result).toEqual({
      staleYellow: 60,
      staleRed: 180,
      zeroSendYellow: 2,
      zeroSendRed: 6,
      source: "db",
    });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getOutreachProcessorThresholds(OP_ENV);
    expect(result).toMatchObject({ ...OP_ENV, source: "env" });
    expect(result.readError).toBe(true);
  });
});

describe("setOutreachProcessorThresholds", () => {
  it("upserts all 4 keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setOutreachProcessorThresholds({
      staleYellow: 60,
      staleRed: 180,
      zeroSendYellow: 2,
      zeroSendRed: 6,
    });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of OP_KEYS) {
      expect(params).toContain(key);
    }
    expect(params).toContain("60");
    expect(params).toContain("180");
    expect(params).toContain("2");
    expect(params).toContain("6");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── Outreach Deliverability persistence helpers ───────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const OD_ENV = {
  staleYellow: 36 * 60,
  staleRed: 72 * 60,
  failRateYellow: 0.05,
  failRateRed: 0.1,
};

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

  it("returns env defaults when only some keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: OD_KEYS[0], value: "1000" }],
    });
    const result = await getOutreachDeliverabilityThresholds(OD_ENV);
    expect(result).toEqual({ ...OD_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: OD_KEYS[0], value: "1200" },
        { key: OD_KEYS[1], value: "2400" },
        { key: OD_KEYS[2], value: "0.03" },
        { key: OD_KEYS[3], value: "0.07" },
      ],
    });
    const result = await getOutreachDeliverabilityThresholds(OD_ENV);
    expect(result).toEqual({
      staleYellow: 1200,
      staleRed: 2400,
      failRateYellow: 0.03,
      failRateRed: 0.07,
      source: "db",
    });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getOutreachDeliverabilityThresholds(OD_ENV);
    expect(result).toMatchObject({ ...OD_ENV, source: "env" });
    expect(result.readError).toBe(true);
  });
});

describe("setOutreachDeliverabilityThresholds", () => {
  it("upserts all 4 keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setOutreachDeliverabilityThresholds({
      staleYellow: 1200,
      staleRed: 2400,
      failRateYellow: 0.03,
      failRateRed: 0.07,
    });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of OD_KEYS) {
      expect(params).toContain(key);
    }
    expect(params).toContain("1200");
    expect(params).toContain("2400");
    expect(params).toContain("0.03");
    expect(params).toContain("0.07");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── Stripe Webhook persistence helpers ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const SW_ENV = {
  failRateYellow: 0.2,
  failRateRed: 0.5,
  sigFailsRed: 1,
};

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

  it("returns env defaults when only some keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: SW_KEYS[0], value: "0.1" }],
    });
    const result = await getStripeWebhookThresholds(SW_ENV);
    expect(result).toEqual({ ...SW_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: SW_KEYS[0], value: "0.15" },
        { key: SW_KEYS[1], value: "0.4" },
        { key: SW_KEYS[2], value: "2" },
      ],
    });
    const result = await getStripeWebhookThresholds(SW_ENV);
    expect(result).toEqual({
      failRateYellow: 0.15,
      failRateRed: 0.4,
      sigFailsRed: 2,
      source: "db",
    });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getStripeWebhookThresholds(SW_ENV);
    expect(result).toMatchObject({ ...SW_ENV, source: "env" });
    expect(result.readError).toBe(true);
  });
});

describe("setStripeWebhookThresholds", () => {
  it("upserts all 3 keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setStripeWebhookThresholds({ failRateYellow: 0.15, failRateRed: 0.4, sigFailsRed: 2 });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of SW_KEYS) {
      expect(params).toContain(key);
    }
    expect(params).toContain("0.15");
    expect(params).toContain("0.4");
    expect(params).toContain("2");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── Procore Sync persistence helpers ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const PS_ENV = {
  staleYellow: 26 * 60,
  staleRed: 72 * 60,
  connStaleYellow: 26 * 60,
  connStaleRed: 36 * 60,
};

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

  it("returns env defaults when only some keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: PS_KEYS[0], value: "500" }],
    });
    const result = await getProcoreSyncThresholds(PS_ENV);
    expect(result).toEqual({ ...PS_ENV, source: "env" });
  });

  it("returns DB values when all keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: PS_KEYS[0], value: "500" },
        { key: PS_KEYS[1], value: "1000" },
        { key: PS_KEYS[2], value: "400" },
        { key: PS_KEYS[3], value: "600" },
      ],
    });
    const result = await getProcoreSyncThresholds(PS_ENV);
    expect(result).toEqual({
      staleYellow: 500,
      staleRed: 1000,
      connStaleYellow: 400,
      connStaleRed: 600,
      source: "db",
    });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getProcoreSyncThresholds(PS_ENV);
    expect(result).toMatchObject({ ...PS_ENV, source: "env" });
    expect(result.readError).toBe(true);
  });
});

describe("setProcoreSyncThresholds", () => {
  it("upserts all 4 keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setProcoreSyncThresholds({
      staleYellow: 500,
      staleRed: 1000,
      connStaleYellow: 400,
      connStaleRed: 600,
    });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    for (const key of PS_KEYS) {
      expect(params).toContain(key);
    }
    expect(params).toContain("500");
    expect(params).toContain("1000");
    expect(params).toContain("400");
    expect(params).toContain("600");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── Cron Scheduler persistence helpers ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const CS_ENV = {
  staleYellow: 90,
  staleRed: 240,
};

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

  it("returns env defaults when only one key is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ key: CS_KEYS[0], value: "60" }],
    });
    const result = await getCronSchedulerThresholds(CS_ENV);
    expect(result).toEqual({ ...CS_ENV, source: "env" });
  });

  it("returns DB values when both keys are stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: CS_KEYS[0], value: "60" },
        { key: CS_KEYS[1], value: "180" },
      ],
    });
    const result = await getCronSchedulerThresholds(CS_ENV);
    expect(result).toEqual({ staleYellow: 60, staleRed: 180, source: "db" });
  });

  it("falls back to env defaults when pool.query throws", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB down"));
    const result = await getCronSchedulerThresholds(CS_ENV);
    expect(result).toMatchObject({ ...CS_ENV, source: "env" });
    expect(result.readError).toBe(true);
  });
});

describe("setCronSchedulerThresholds", () => {
  it("upserts both keys into lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await setCronSchedulerThresholds({ staleYellow: 60, staleRed: 180 });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
    expect(params).toContain(CS_KEYS[0]);
    expect(params).toContain(CS_KEYS[1]);
    expect(params).toContain("60");
    expect(params).toContain("180");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── HTTP route helpers ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════
// ── Lead Scraper route tests ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const LS_VALID = {
  staleYellow: 100,
  staleRed: 200,
  failRateYellow: 0.3,
  failRateRed: 0.8,
  zeroOutputRunsRed: 5,
};

describe("POST /api/admin/growth-health/lead-scraper-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when staleYellow is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
      { ...LS_VALID, staleYellow: -1 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
      { ...LS_VALID, staleYellow: 300, staleRed: 200 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when failRateYellow is outside 0..1", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
      { ...LS_VALID, failRateYellow: 1.5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/failRateYellow/i);
  });

  it("rejects when failRateYellow >= failRateRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
      { ...LS_VALID, failRateYellow: 0.9, failRateRed: 0.5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/failRateYellow.*less than failRateRed/i);
  });

  it("rejects when zeroOutputRunsRed is not a positive integer", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
      { ...LS_VALID, zeroOutputRunsRed: 0 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/zeroOutputRunsRed/i);
  });

  it("rejects when zeroOutputRunsRed is a non-integer", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
      { ...LS_VALID, zeroOutputRunsRed: 2.5 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/zeroOutputRunsRed/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
      LS_VALID,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ ...LS_VALID, source: "db" });
  });

  it("requires admin auth", async () => {
    const { status, body } = await server.unauthRequest(
      "POST",
      "/api/admin/growth-health/lead-scraper-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/lead-scraper-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/lead-scraper-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
    expect(body.data.staleYellow).toBe(body.data.envDefaults.staleYellow);
    expect(body.data.staleRed).toBe(body.data.envDefaults.staleRed);
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: LS_KEYS[0], value: "100" },
        { key: LS_KEYS[1], value: "200" },
        { key: LS_KEYS[2], value: "0.3" },
        { key: LS_KEYS[3], value: "0.8" },
        { key: LS_KEYS[4], value: "5" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/lead-scraper-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(100);
    expect(body.data.staleRed).toBe(200);
    expect(body.data.failRateYellow).toBe(0.3);
    expect(body.data.failRateRed).toBe(0.8);
    expect(body.data.zeroOutputRunsRed).toBe(5);
  });

  it("requires admin auth", async () => {
    const { status } = await server.unauthRequest(
      "GET",
      "/api/admin/growth-health/lead-scraper-thresholds",
    );
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

// Integration: POST then GET reflects saved values
describe("lead-scraper-thresholds POST→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    // POST: SELECT old value, INSERT upsert, INSERT audit; then GET reads back
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // POST SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT upsert
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT audit
      .mockResolvedValueOnce({             // GET reads back
        rows: [
          { key: LS_KEYS[0], value: "100" },
          { key: LS_KEYS[1], value: "200" },
          { key: LS_KEYS[2], value: "0.3" },
          { key: LS_KEYS[3], value: "0.8" },
          { key: LS_KEYS[4], value: "5" },
        ],
      });
    server = await buildServer();
  });

  it("GET returns source=db after POST saves values", async () => {
    await server.request("POST", "/api/admin/growth-health/lead-scraper-thresholds", LS_VALID);
    const { body } = await server.request("GET", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(100);
    expect(body.data.failRateRed).toBe(0.8);
    expect(body.data.zeroOutputRunsRed).toBe(5);
  });

  afterEach(() => server.close());
});

// ══════════════════════════════════════════════════════════════════════════
// ── Outreach Processor route tests ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const OP_VALID = { staleYellow: 60, staleRed: 180, zeroSendYellow: 2, zeroSendRed: 6 };

describe("POST /api/admin/growth-health/outreach-processor-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when staleYellow is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/outreach-processor-thresholds",
      { ...OP_VALID, staleYellow: -10 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/outreach-processor-thresholds",
      { ...OP_VALID, staleYellow: 300, staleRed: 100 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when zeroSendYellow >= zeroSendRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/outreach-processor-thresholds",
      { ...OP_VALID, zeroSendYellow: 8, zeroSendRed: 4 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/zeroSendYellow.*less than zeroSendRed/i);
  });

  it("rejects when zeroSendRed is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/outreach-processor-thresholds",
      { ...OP_VALID, zeroSendRed: -1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/zeroSendRed/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/outreach-processor-thresholds",
      OP_VALID,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ ...OP_VALID, source: "db" });
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/outreach-processor-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/outreach-processor-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: OP_KEYS[0], value: "60" },
        { key: OP_KEYS[1], value: "180" },
        { key: OP_KEYS[2], value: "2" },
        { key: OP_KEYS[3], value: "6" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/outreach-processor-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(60);
    expect(body.data.zeroSendRed).toBe(6);
  });

  afterEach(() => server.close());
});

describe("outreach-processor-thresholds POST→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // POST SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT upsert
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT audit
      .mockResolvedValueOnce({             // GET reads back
        rows: [
          { key: OP_KEYS[0], value: "60" },
          { key: OP_KEYS[1], value: "180" },
          { key: OP_KEYS[2], value: "2" },
          { key: OP_KEYS[3], value: "6" },
        ],
      });
    server = await buildServer();
  });

  it("GET returns source=db after POST saves values", async () => {
    await server.request("POST", "/api/admin/growth-health/outreach-processor-thresholds", OP_VALID);
    const { body } = await server.request("GET", "/api/admin/growth-health/outreach-processor-thresholds");
    expect(body.data.source).toBe("db");
    expect(body.data.zeroSendYellow).toBe(2);
  });

  afterEach(() => server.close());
});

// ══════════════════════════════════════════════════════════════════════════
// ── Outreach Deliverability route tests ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const OD_VALID = { staleYellow: 1200, staleRed: 2400, failRateYellow: 0.03, failRateRed: 0.07 };

describe("POST /api/admin/growth-health/deliverability-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/deliverability-thresholds",
      { ...OD_VALID, staleYellow: 3000, staleRed: 2000 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when failRateYellow >= failRateRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/deliverability-thresholds",
      { ...OD_VALID, failRateYellow: 0.15, failRateRed: 0.05 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow.*less than failRateRed/i);
  });

  it("rejects when failRateRed is outside 0..1", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/deliverability-thresholds",
      { ...OD_VALID, failRateRed: 1.2 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateRed/i);
  });

  it("rejects when staleYellow is not a number", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/deliverability-thresholds",
      { ...OD_VALID, staleYellow: "abc" },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/deliverability-thresholds",
      OD_VALID,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ ...OD_VALID, source: "db" });
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/deliverability-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/deliverability-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
    expect(body.data.staleYellow).toBe(body.data.envDefaults.staleYellow);
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: OD_KEYS[0], value: "1200" },
        { key: OD_KEYS[1], value: "2400" },
        { key: OD_KEYS[2], value: "0.03" },
        { key: OD_KEYS[3], value: "0.07" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/deliverability-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.failRateYellow).toBe(0.03);
    expect(body.data.failRateRed).toBe(0.07);
  });

  afterEach(() => server.close());
});

describe("deliverability-thresholds POST→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // POST SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT upsert
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT audit
      .mockResolvedValueOnce({             // GET reads back
        rows: [
          { key: OD_KEYS[0], value: "1200" },
          { key: OD_KEYS[1], value: "2400" },
          { key: OD_KEYS[2], value: "0.03" },
          { key: OD_KEYS[3], value: "0.07" },
        ],
      });
    server = await buildServer();
  });

  it("GET returns source=db after POST saves values", async () => {
    await server.request("POST", "/api/admin/growth-health/deliverability-thresholds", OD_VALID);
    const { body } = await server.request("GET", "/api/admin/growth-health/deliverability-thresholds");
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(1200);
    expect(body.data.failRateRed).toBe(0.07);
  });

  afterEach(() => server.close());
});

// ══════════════════════════════════════════════════════════════════════════
// ── Stripe Webhook route tests ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const SW_VALID = { failRateYellow: 0.15, failRateRed: 0.4, sigFailsRed: 2 };

describe("POST /api/admin/growth-health/stripe-webhook-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when failRateYellow is outside 0..1", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...SW_VALID, failRateYellow: 1.1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow/i);
  });

  it("rejects when failRateRed is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...SW_VALID, failRateRed: -0.1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateRed/i);
  });

  it("rejects when failRateYellow >= failRateRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...SW_VALID, failRateYellow: 0.6, failRateRed: 0.3 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/failRateYellow.*less than failRateRed/i);
  });

  it("rejects when sigFailsRed is zero (not a positive integer)", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...SW_VALID, sigFailsRed: 0 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/sigFailsRed/i);
  });

  it("rejects when sigFailsRed is a non-integer", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/stripe-webhook-thresholds",
      { ...SW_VALID, sigFailsRed: 1.5 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/sigFailsRed/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/stripe-webhook-thresholds",
      SW_VALID,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ ...SW_VALID, source: "db" });
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/stripe-webhook-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/stripe-webhook-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
    expect(body.data.failRateYellow).toBe(body.data.envDefaults.failRateYellow);
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: SW_KEYS[0], value: "0.15" },
        { key: SW_KEYS[1], value: "0.4" },
        { key: SW_KEYS[2], value: "2" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/stripe-webhook-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.failRateYellow).toBe(0.15);
    expect(body.data.sigFailsRed).toBe(2);
  });

  afterEach(() => server.close());
});

describe("stripe-webhook-thresholds POST→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // POST SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT upsert
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT audit
      .mockResolvedValueOnce({             // GET reads back
        rows: [
          { key: SW_KEYS[0], value: "0.15" },
          { key: SW_KEYS[1], value: "0.4" },
          { key: SW_KEYS[2], value: "2" },
        ],
      });
    server = await buildServer();
  });

  it("GET returns source=db after POST saves values", async () => {
    await server.request("POST", "/api/admin/growth-health/stripe-webhook-thresholds", SW_VALID);
    const { body } = await server.request("GET", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(body.data.source).toBe("db");
    expect(body.data.sigFailsRed).toBe(2);
  });

  afterEach(() => server.close());
});

// ══════════════════════════════════════════════════════════════════════════
// ── Procore Sync route tests ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const PS_VALID = { staleYellow: 500, staleRed: 1000, connStaleYellow: 400, connStaleRed: 600 };

describe("POST /api/admin/growth-health/procore-sync-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/procore-sync-thresholds",
      { ...PS_VALID, staleYellow: 2000, staleRed: 1000 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when staleRed is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/procore-sync-thresholds",
      { ...PS_VALID, staleRed: -5 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleRed/i);
  });

  it("rejects when connStaleYellow >= connStaleRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/procore-sync-thresholds",
      { ...PS_VALID, connStaleYellow: 700, connStaleRed: 500 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/connStaleYellow.*less than connStaleRed/i);
  });

  it("rejects when connStaleRed is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/procore-sync-thresholds",
      { ...PS_VALID, connStaleRed: -1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/connStaleRed/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/procore-sync-thresholds",
      PS_VALID,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ ...PS_VALID, source: "db" });
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/procore-sync-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/procore-sync-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: PS_KEYS[0], value: "500" },
        { key: PS_KEYS[1], value: "1000" },
        { key: PS_KEYS[2], value: "400" },
        { key: PS_KEYS[3], value: "600" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/procore-sync-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(500);
    expect(body.data.connStaleRed).toBe(600);
  });

  afterEach(() => server.close());
});

describe("procore-sync-thresholds POST→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // POST SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT upsert
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT audit
      .mockResolvedValueOnce({             // GET reads back
        rows: [
          { key: PS_KEYS[0], value: "500" },
          { key: PS_KEYS[1], value: "1000" },
          { key: PS_KEYS[2], value: "400" },
          { key: PS_KEYS[3], value: "600" },
        ],
      });
    server = await buildServer();
  });

  it("GET returns source=db after POST saves values", async () => {
    await server.request("POST", "/api/admin/growth-health/procore-sync-thresholds", PS_VALID);
    const { body } = await server.request("GET", "/api/admin/growth-health/procore-sync-thresholds");
    expect(body.data.source).toBe("db");
    expect(body.data.connStaleYellow).toBe(400);
  });

  afterEach(() => server.close());
});

// ══════════════════════════════════════════════════════════════════════════
// ── Cron Scheduler route tests ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const CS_VALID = { staleYellow: 60, staleRed: 180 };

describe("POST /api/admin/growth-health/cron-scheduler-thresholds validation", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("rejects when staleYellow is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: -5, staleRed: 180 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("rejects when staleRed is negative", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: 60, staleRed: -1 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleRed/i);
  });

  it("rejects when staleYellow >= staleRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: 200, staleRed: 100 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow.*less than staleRed/i);
  });

  it("rejects when staleYellow equals staleRed", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: 120, staleRed: 120 },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("rejects when staleYellow is not a number", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/cron-scheduler-thresholds",
      { staleYellow: "bad", staleRed: 180 },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/staleYellow/i);
  });

  it("accepts valid values and returns them with source=db", async () => {
    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/cron-scheduler-thresholds",
      CS_VALID,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ ...CS_VALID, source: "db" });
  });

  it("requires admin auth", async () => {
    const { status } = await server.unauthRequest(
      "POST",
      "/api/admin/growth-health/cron-scheduler-thresholds",
    );
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

describe("GET /api/admin/growth-health/cron-scheduler-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns env defaults and source=env when no DB override", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/cron-scheduler-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.source).toBe("env");
    expect(body.data.envDefaults).toBeDefined();
    expect(body.data.staleYellow).toBe(body.data.envDefaults.staleYellow);
    expect(body.data.staleRed).toBe(body.data.envDefaults.staleRed);
  });

  it("returns DB values and source=db when override is stored", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { key: CS_KEYS[0], value: "60" },
        { key: CS_KEYS[1], value: "180" },
      ],
    });
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/cron-scheduler-thresholds",
    );
    expect(status).toBe(200);
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(60);
    expect(body.data.staleRed).toBe(180);
  });

  it("requires admin auth", async () => {
    const { status } = await server.unauthRequest(
      "GET",
      "/api/admin/growth-health/cron-scheduler-thresholds",
    );
    expect(status).toBe(401);
  });

  afterEach(() => server.close());
});

describe("cron-scheduler-thresholds POST→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // POST SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT upsert
      .mockResolvedValueOnce({ rows: [] }) // POST INSERT audit
      .mockResolvedValueOnce({             // GET reads back
        rows: [
          { key: CS_KEYS[0], value: "60" },
          { key: CS_KEYS[1], value: "180" },
        ],
      });
    server = await buildServer();
  });

  it("GET returns source=db after POST saves values (simulates evaluator using DB values after restart)", async () => {
    await server.request("POST", "/api/admin/growth-health/cron-scheduler-thresholds", CS_VALID);
    const { body } = await server.request("GET", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(body.data.source).toBe("db");
    expect(body.data.staleYellow).toBe(60);
    expect(body.data.staleRed).toBe(180);
  });

  afterEach(() => server.close());
});

// ══════════════════════════════════════════════════════════════════════════
// ── Evaluator integration: evaluators consume DB-overridden thresholds ────
//
// Each test sets up tight DB thresholds (e.g. staleRed=2 min), provides
// business data that breaches those thresholds, and asserts both:
//   - The evaluator returns the expected health status (proving the
//     DB-overridden value drove the decision, not the env default).
//   - meta.thresholdSource === "db" (proving the evaluator read from DB).
//
// This is the evaluator-level equivalent of the existing tests in
// tests/watchtower-thresholds.test.ts (lines 233-383).
// ══════════════════════════════════════════════════════════════════════════

describe("evalCronScheduler with DB-overridden thresholds", () => {
  const cronRule = findRule("cron_scheduler")!;

  it("trips red at the DB-overridden staleRed threshold", async () => {
    const dbStaleYellow = 1;
    const dbStaleRed = 2;
    const heartbeatTs = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 min ago

    mockPoolQuery
      // call 1: getCronSchedulerThresholds
      .mockResolvedValueOnce({
        rows: [
          { key: CS_KEYS[0], value: String(dbStaleYellow) },
          { key: CS_KEYS[1], value: String(dbStaleRed) },
        ],
      })
      // call 2: SELECT key, value FROM lead_outreach_config WHERE key LIKE 'cron_last_%'
      .mockResolvedValueOnce({
        rows: [{ key: "cron_last_foo", value: heartbeatTs }],
      });

    const result = await evalCronScheduler(cronRule);

    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
    expect(result.reasons.join(" ")).toMatch(/threshold.*2 min/i);
  });

  it("stays green when last heartbeat is within the DB-overridden yellow threshold", async () => {
    const dbStaleYellow = 10;
    const dbStaleRed = 20;
    const heartbeatTs = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: CS_KEYS[0], value: String(dbStaleYellow) },
          { key: CS_KEYS[1], value: String(dbStaleRed) },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ key: "cron_last_foo", value: heartbeatTs }],
      });

    const result = await evalCronScheduler(cronRule);

    expect(result.status).toBe("green");
    expect((result.meta as any).thresholdSource).toBe("db");
  });

  it("exposes thresholdSource=db even when no heartbeat exists", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: CS_KEYS[0], value: "90" },
          { key: CS_KEYS[1], value: "240" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // no cron_last_* keys

    const result = await evalCronScheduler(cronRule);

    expect(result.status).toBe("unknown");
    expect((result.meta as any).thresholdSource).toBe("db");
  });
});

describe("evalProcoreSync with DB-overridden thresholds", () => {
  const procoreRule = findRule("procore_sync")!;

  it("trips red when an active connection exceeds the DB-overridden connStaleRed threshold", async () => {
    const dbStaleYellow = 1000;
    const dbStaleRed = 2000;
    const dbConnStaleYellow = 1;
    const dbConnStaleRed = 2;
    const syncTs = String(Date.now() - 3 * 60 * 1000); // 3 min ago as Unix ms

    mockPoolQuery
      // call 1: getProcoreSyncThresholds
      .mockResolvedValueOnce({
        rows: [
          { key: PS_KEYS[0], value: String(dbStaleYellow) },
          { key: PS_KEYS[1], value: String(dbStaleRed) },
          { key: PS_KEYS[2], value: String(dbConnStaleYellow) },
          { key: PS_KEYS[3], value: String(dbConnStaleRed) },
        ],
      })
      // call 2: SELECT ... FROM procore_connections
      .mockResolvedValueOnce({
        rows: [
          {
            id: "1",
            company_name: "Acme Corp",
            last_sync_at: syncTs,
            created_at: null,
            status: "active",
          },
        ],
      });

    const result = await evalProcoreSync(procoreRule);

    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
    expect(result.reasons.join(" ")).toMatch(/stale.*2 min/i);
  });

  it("stays green when all connections are within the DB-overridden connStaleYellow threshold", async () => {
    const recentSyncTs = String(Date.now() - 30 * 1000); // 30 sec ago

    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: PS_KEYS[0], value: "1000" },
          { key: PS_KEYS[1], value: "2000" },
          { key: PS_KEYS[2], value: "10" },
          { key: PS_KEYS[3], value: "20" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "1",
            company_name: "Fresh Co",
            last_sync_at: recentSyncTs,
            created_at: null,
            status: "active",
          },
        ],
      });

    const result = await evalProcoreSync(procoreRule);

    expect(result.status).toBe("green");
    expect((result.meta as any).thresholdSource).toBe("db");
  });
});

describe("evalLeadScraper with DB-overridden thresholds", () => {
  const scraperRule = findRule("lead_scraper")!;

  it("trips red at the DB-overridden staleRed threshold", async () => {
    const dbStaleRed = 2; // 2 min — tighter than env default (48h)
    const lastSuccessTs = String(Date.now() - 3 * 60 * 1000); // 3 min ago

    mockPoolQuery
      // call 1: getLeadScraperThresholds
      .mockResolvedValueOnce({
        rows: [
          { key: LS_KEYS[0], value: "1" },
          { key: LS_KEYS[1], value: String(dbStaleRed) },
          { key: LS_KEYS[2], value: "0.3" },
          { key: LS_KEYS[3], value: "0.8" },
          { key: LS_KEYS[4], value: "3" },
        ],
      })
      // calls 2-4: evalJobRun — agg, lastSuccess, lastFailure (parallel)
      .mockResolvedValueOnce({
        rows: [{ runs: "1", ok_runs: "1", fail_runs: "0", items: "5" }],
      })
      .mockResolvedValueOnce({
        rows: [{ started_at: lastSuccessTs, success_count: 5, items_processed: 5 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      // call 5: zero output check (returns no rows → won't trigger zero-output red)
      .mockResolvedValueOnce({ rows: [] });

    const result = await evalLeadScraper(scraperRule);

    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
    expect(result.reasons.join(" ")).toMatch(/threshold.*2 min/i);
  });

  it("trips red at the DB-overridden failRateRed threshold", async () => {
    const recentTs = String(Date.now() - 30 * 1000); // 30 sec ago — not stale

    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: LS_KEYS[0], value: "1000" }, // staleYellow very high
          { key: LS_KEYS[1], value: "2000" }, // staleRed very high
          { key: LS_KEYS[2], value: "0.01" }, // failRateYellow=1%
          { key: LS_KEYS[3], value: "0.02" }, // failRateRed=2%
          { key: LS_KEYS[4], value: "5" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ runs: "10", ok_runs: "8", fail_runs: "2", items: "100" }], // failRate=20%
      })
      .mockResolvedValueOnce({
        rows: [{ started_at: recentTs, success_count: 10, items_processed: 10 }],
      })
      .mockResolvedValueOnce({
        rows: [{ started_at: recentTs, error_summary: "timeout" }],
      })
      // zero output check — returns recent runs with non-zero success_count
      .mockResolvedValueOnce({
        rows: [
          { success_count: 10 },
          { success_count: 8 },
          { success_count: 6 },
          { success_count: 7 },
          { success_count: 9 },
        ],
      });

    const result = await evalLeadScraper(scraperRule);

    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
    expect(result.reasons.join(" ")).toMatch(/failure rate.*2%/i);
  });
});

describe("evalOutreachProcessor with DB-overridden thresholds", () => {
  const processorRule = findRule("outreach_processor")!;

  it("trips red at the DB-overridden staleRed threshold", async () => {
    const dbStaleRed = 2;
    const lastSuccessTs = String(Date.now() - 3 * 60 * 1000);

    // Use a default fallback to absorb any extra pool.query calls during
    // business hours (the zeroSend check may fire if tests run in business hours).
    mockPoolQuery.mockResolvedValue({ rows: [{ red_c: "1", yel_c: "1" }] });
    mockPoolQuery
      // call 1: getOutreachProcessorThresholds
      .mockResolvedValueOnce({
        rows: [
          { key: OP_KEYS[0], value: "1" },
          { key: OP_KEYS[1], value: String(dbStaleRed) },
          { key: OP_KEYS[2], value: "4" },
          { key: OP_KEYS[3], value: "8" },
        ],
      })
      // calls 2-4: evalJobRun
      .mockResolvedValueOnce({
        rows: [{ runs: "1", ok_runs: "1", fail_runs: "0", items: "0" }],
      })
      .mockResolvedValueOnce({
        rows: [{ started_at: lastSuccessTs, success_count: 0, items_processed: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await evalOutreachProcessor(processorRule);

    // Status is at least red from staleness, may have extra zero-send reasons too
    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
  });

  it("stays green when last run is within DB-overridden thresholds", async () => {
    const recentTs = String(Date.now() - 30 * 1000);

    mockPoolQuery.mockResolvedValue({ rows: [{ red_c: "5", yel_c: "5" }] });
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: OP_KEYS[0], value: "60" },
          { key: OP_KEYS[1], value: "180" },
          { key: OP_KEYS[2], value: "4" },
          { key: OP_KEYS[3], value: "8" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ runs: "1", ok_runs: "1", fail_runs: "0", items: "10" }],
      })
      .mockResolvedValueOnce({
        rows: [{ started_at: recentTs, success_count: 10, items_processed: 10 }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await evalOutreachProcessor(processorRule);

    expect(result.status).toBe("green");
    expect((result.meta as any).thresholdSource).toBe("db");
  });
});

describe("evalOutreachDeliverability with DB-overridden thresholds", () => {
  const delivRule = findRule("outreach_deliverability")!;

  it("trips red at the DB-overridden failRateRed threshold", async () => {
    const recentIso = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago

    mockPoolQuery
      // call 1: getOutreachDeliverabilityThresholds
      .mockResolvedValueOnce({
        rows: [
          { key: OD_KEYS[0], value: "10000" }, // stale thresholds very high
          { key: OD_KEYS[1], value: "20000" },
          { key: OD_KEYS[2], value: "0.01" }, // failRateYellow=1%
          { key: OD_KEYS[3], value: "0.02" }, // failRateRed=2%
        ],
      })
      // call 2: aggRes — 2 bounced out of 100 total = 2% failure rate
      .mockResolvedValueOnce({
        rows: [{ sent: "98", bounced: "2", complained: "0" }],
      })
      // call 3: lastSentRes
      .mockResolvedValueOnce({
        rows: [{ sent_at: recentIso }],
      })
      // call 4: lastBounceRes
      .mockResolvedValueOnce({
        rows: [{ sent_at: recentIso, status: "bounced_hard", subject: "Test Email" }],
      });

    const result = await evalOutreachDeliverability(delivRule);

    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
    expect(result.reasons.join(" ")).toMatch(/failure rate.*2%/i);
  });

  it("trips yellow when failure rate breaches only DB-overridden yellow threshold", async () => {
    const recentIso = new Date(Date.now() - 60 * 1000).toISOString();

    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: OD_KEYS[0], value: "10000" },
          { key: OD_KEYS[1], value: "20000" },
          { key: OD_KEYS[2], value: "0.01" }, // failRateYellow=1%
          { key: OD_KEYS[3], value: "0.05" }, // failRateRed=5%
        ],
      })
      // 2 bounced out of 102 total → ~1.96% → >= yellow=1% but < red=5%
      .mockResolvedValueOnce({
        rows: [{ sent: "100", bounced: "2", complained: "0" }],
      })
      .mockResolvedValueOnce({ rows: [{ sent_at: recentIso }] })
      .mockResolvedValueOnce({
        rows: [{ sent_at: recentIso, status: "bounced_soft", subject: null }],
      });

    const result = await evalOutreachDeliverability(delivRule);

    expect(result.status).toBe("yellow");
    expect((result.meta as any).thresholdSource).toBe("db");
  });
});

describe("evalStripeWebhooks with DB-overridden thresholds", () => {
  const stripeRule = findRule("stripe_webhooks")!;

  it("trips red at the DB-overridden failRateRed threshold", async () => {
    const nowMs = Date.now();
    const nowStr = String(nowMs);

    mockPoolQuery
      // call 1: getStripeWebhookThresholds
      .mockResolvedValueOnce({
        rows: [
          { key: SW_KEYS[0], value: "0.01" }, // failRateYellow=1%
          { key: SW_KEYS[1], value: "0.02" }, // failRateRed=2%
          { key: SW_KEYS[2], value: "100" }, // sigFailsRed=100 (won't trigger)
        ],
      })
      // call 2: errAggRes — 2 errors
      .mockResolvedValueOnce({
        rows: [{ c: "2", latest: "stripe processing error", latest_at: nowStr }],
      })
      // call 3: sigRes — 98 subscriptions (positive volume)
      .mockResolvedValueOnce({
        rows: [{ subs: "98", purchases: "0", latest: nowStr }],
      })
      // call 4: sigErr (signatureFailuresLastHourRed=100 so it fires but returns 0)
      .mockResolvedValueOnce({
        rows: [{ c: "0" }],
      });

    const result = await evalStripeWebhooks(stripeRule);

    // errCount=2, throughput=98, totalEvents=100, failureRate=0.02 >= failRateRed=0.02 → red
    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
    expect(result.reasons.join(" ")).toMatch(/failure rate.*2%/i);
  });

  it("trips red immediately when signature failures exceed the DB-overridden sigFailsRed threshold", async () => {
    const nowMs = Date.now();

    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: SW_KEYS[0], value: "0.5" }, // failRateYellow=50% (very high — won't trigger)
          { key: SW_KEYS[1], value: "0.9" }, // failRateRed=90%
          { key: SW_KEYS[2], value: "1" },   // sigFailsRed=1 (tight)
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ c: "0", latest: null, latest_at: null }], // no errors
      })
      .mockResolvedValueOnce({
        rows: [{ subs: "50", purchases: "0", latest: String(nowMs) }],
      })
      .mockResolvedValueOnce({
        rows: [{ c: "2" }], // 2 sig failures in last hour >= sigFailsRed=1
      });

    const result = await evalStripeWebhooks(stripeRule);

    expect(result.status).toBe("red");
    expect((result.meta as any).thresholdSource).toBe("db");
    expect(result.reasons.join(" ")).toMatch(/signature failure/i);
  });

  it("stays green when volume is high but failure rate is below DB-overridden yellow threshold", async () => {
    const nowMs = Date.now();

    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: SW_KEYS[0], value: "0.1" },
          { key: SW_KEYS[1], value: "0.2" },
          { key: SW_KEYS[2], value: "5" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ c: "1", latest: "minor error", latest_at: String(nowMs) }], // 1 error
      })
      .mockResolvedValueOnce({
        rows: [{ subs: "999", purchases: "0", latest: String(nowMs) }], // 999 good events
      })
      .mockResolvedValueOnce({
        rows: [{ c: "0" }], // no sig failures
      });

    const result = await evalStripeWebhooks(stripeRule);

    // failureRate = 1/1000 = 0.001 < yellow=0.1 → green
    expect(result.status).toBe("green");
    expect((result.meta as any).thresholdSource).toBe("db");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── Reset helper unit tests ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

describe("resetLeadScraperThresholds", () => {
  it("deletes all lead-scraper keys from lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetLeadScraperThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of LS_KEYS) {
      expect(keys).toContain(key);
    }
  });
});

describe("resetOutreachProcessorThresholds", () => {
  it("deletes all outreach-processor keys from lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetOutreachProcessorThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of OP_KEYS) {
      expect(keys).toContain(key);
    }
  });
});

describe("resetOutreachDeliverabilityThresholds", () => {
  it("deletes all deliverability keys from lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetOutreachDeliverabilityThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of OD_KEYS) {
      expect(keys).toContain(key);
    }
  });
});

describe("resetStripeWebhookThresholds", () => {
  it("deletes all stripe-webhook keys from lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetStripeWebhookThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of SW_KEYS) {
      expect(keys).toContain(key);
    }
  });
});

describe("resetProcoreSyncThresholds", () => {
  it("deletes all procore-sync keys from lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetProcoreSyncThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of PS_KEYS) {
      expect(keys).toContain(key);
    }
  });
});

describe("resetCronSchedulerThresholds", () => {
  it("deletes all cron-scheduler keys from lead_outreach_config", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await resetCronSchedulerThresholds();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM lead_outreach_config/i);
    const keys = params[0] as string[];
    for (const key of CS_KEYS) {
      expect(keys).toContain(key);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ── DELETE route tests ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

describe("DELETE /api/admin/growth-health/lead-scraper-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns success:true", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/lead-scraper-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("requires admin auth", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/lead-scraper-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/outreach-processor-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns success:true", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/outreach-processor-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("requires admin auth", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/outreach-processor-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/deliverability-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns success:true", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/deliverability-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("requires admin auth", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/deliverability-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/stripe-webhook-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns success:true", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/stripe-webhook-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("requires admin auth", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/stripe-webhook-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/procore-sync-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns success:true", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/procore-sync-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("requires admin auth", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/procore-sync-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

describe("DELETE /api/admin/growth-health/cron-scheduler-thresholds", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    server = await buildServer();
  });

  it("returns success:true", async () => {
    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/cron-scheduler-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("requires admin auth", async () => {
    const { status, body } = await server.unauthRequest(
      "DELETE",
      "/api/admin/growth-health/cron-scheduler-thresholds",
    );
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  afterEach(() => server.close());
});

// ══════════════════════════════════════════════════════════════════════════
// ── DELETE→GET round-trip tests ───────────────────────────────────────────
// Each test proves:
//   1. DELETE calls pool.query with DELETE SQL and the correct key set.
//   2. Subsequent GET finds no DB rows (keys are gone) and returns source:"env".
// Mock sequencing: call 1 = DELETE SQL, call 2 = SELECT SQL for GET.
// ══════════════════════════════════════════════════════════════════════════

describe("lead-scraper-thresholds DELETE→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // call 1: SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // call 2: DELETE SQL (keys removed)
      .mockResolvedValueOnce({ rows: [] }) // call 3: INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // call 4: SELECT SQL → no rows → source:"env"
    server = await buildServer();
  });

  it("issues DELETE SQL then GET returns source=env", async () => {
    const del = await server.request("DELETE", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(del.body.success).toBe(true);

    const [deleteSql, deleteParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(/DELETE FROM lead_outreach_config/i);
    const deletedKeys = deleteParams[0] as string[];
    for (const key of LS_KEYS) {
      expect(deletedKeys).toContain(key);
    }

    const { body } = await server.request("GET", "/api/admin/growth-health/lead-scraper-thresholds");
    expect(body.data.source).toBe("env");
    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
  });

  afterEach(() => server.close());
});

describe("outreach-processor-thresholds DELETE→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // call 1: SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // call 2: DELETE SQL
      .mockResolvedValueOnce({ rows: [] }) // call 3: INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // call 4: SELECT SQL → source:"env"
    server = await buildServer();
  });

  it("issues DELETE SQL then GET returns source=env", async () => {
    const del = await server.request("DELETE", "/api/admin/growth-health/outreach-processor-thresholds");
    expect(del.body.success).toBe(true);

    const [deleteSql, deleteParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(/DELETE FROM lead_outreach_config/i);
    const deletedKeys = deleteParams[0] as string[];
    for (const key of OP_KEYS) {
      expect(deletedKeys).toContain(key);
    }

    const { body } = await server.request("GET", "/api/admin/growth-health/outreach-processor-thresholds");
    expect(body.data.source).toBe("env");
    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
  });

  afterEach(() => server.close());
});

describe("deliverability-thresholds DELETE→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // call 1: SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // call 2: DELETE SQL
      .mockResolvedValueOnce({ rows: [] }) // call 3: INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // call 4: SELECT SQL → source:"env"
    server = await buildServer();
  });

  it("issues DELETE SQL then GET returns source=env", async () => {
    const del = await server.request("DELETE", "/api/admin/growth-health/deliverability-thresholds");
    expect(del.body.success).toBe(true);

    const [deleteSql, deleteParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(/DELETE FROM lead_outreach_config/i);
    const deletedKeys = deleteParams[0] as string[];
    for (const key of OD_KEYS) {
      expect(deletedKeys).toContain(key);
    }

    const { body } = await server.request("GET", "/api/admin/growth-health/deliverability-thresholds");
    expect(body.data.source).toBe("env");
    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
  });

  afterEach(() => server.close());
});

describe("stripe-webhook-thresholds DELETE→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // call 1: SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // call 2: DELETE SQL
      .mockResolvedValueOnce({ rows: [] }) // call 3: INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // call 4: SELECT SQL → source:"env"
    server = await buildServer();
  });

  it("issues DELETE SQL then GET returns source=env", async () => {
    const del = await server.request("DELETE", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(del.body.success).toBe(true);

    const [deleteSql, deleteParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(/DELETE FROM lead_outreach_config/i);
    const deletedKeys = deleteParams[0] as string[];
    for (const key of SW_KEYS) {
      expect(deletedKeys).toContain(key);
    }

    const { body } = await server.request("GET", "/api/admin/growth-health/stripe-webhook-thresholds");
    expect(body.data.source).toBe("env");
    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
  });

  afterEach(() => server.close());
});

describe("procore-sync-thresholds DELETE→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // call 1: SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // call 2: DELETE SQL
      .mockResolvedValueOnce({ rows: [] }) // call 3: INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // call 4: SELECT SQL → source:"env"
    server = await buildServer();
  });

  it("issues DELETE SQL then GET returns source=env", async () => {
    const del = await server.request("DELETE", "/api/admin/growth-health/procore-sync-thresholds");
    expect(del.body.success).toBe(true);

    const [deleteSql, deleteParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(/DELETE FROM lead_outreach_config/i);
    const deletedKeys = deleteParams[0] as string[];
    for (const key of PS_KEYS) {
      expect(deletedKeys).toContain(key);
    }

    const { body } = await server.request("GET", "/api/admin/growth-health/procore-sync-thresholds");
    expect(body.data.source).toBe("env");
    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
  });

  afterEach(() => server.close());
});

describe("cron-scheduler-thresholds DELETE→GET round-trip", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // call 1: SELECT old value
      .mockResolvedValueOnce({ rows: [] }) // call 2: DELETE SQL
      .mockResolvedValueOnce({ rows: [] }) // call 3: INSERT audit
      .mockResolvedValueOnce({ rows: [] }); // call 4: SELECT SQL → source:"env"
    server = await buildServer();
  });

  it("issues DELETE SQL then GET returns source=env", async () => {
    const del = await server.request("DELETE", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(del.body.success).toBe(true);

    const [deleteSql, deleteParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(/DELETE FROM lead_outreach_config/i);
    const deletedKeys = deleteParams[0] as string[];
    for (const key of CS_KEYS) {
      expect(deletedKeys).toContain(key);
    }

    const { body } = await server.request("GET", "/api/admin/growth-health/cron-scheduler-thresholds");
    expect(body.data.source).toBe("env");
    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
  });

  afterEach(() => server.close());
});
