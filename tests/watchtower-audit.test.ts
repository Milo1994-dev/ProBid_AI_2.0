import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

/**
 * Tests for watchtower-audit.ts:
 *   - recordThresholdAudit inserts a row and re-throws on failure
 *   - getThresholdAuditLog supports offset, since, until filtering
 *   - threshold-audit-log HTTP endpoint returns correct total + paginates
 *   - Audit rows are written when thresholds are changed via HTTP routes
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

import { recordThresholdAudit, withGuaranteedAudit, getThresholdAuditLog, pruneAuditLog, getAuditRetentionDays } from "../server/lib/watchtower-audit.js";

beforeEach(() => {
  mockPoolQuery.mockReset();
});

// ── recordThresholdAudit unit tests ──────────────────────────────────────────

describe("recordThresholdAudit", () => {
  function makeReq(headers: Record<string, string> = {}) {
    return { headers } as unknown as import("express").Request;
  }

  it("inserts a row with correct subsystem, action, and endpoint", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await recordThresholdAudit(
      makeReq({ "x-admin-key": "secret" }),
      "dupe-deal",
      "set",
      "/api/admin/growth-health/dupe-deal-thresholds",
      { yellow: 5, red: 20, source: "env" },
      { yellow: 3, red: 15 },
    );
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO watchtower_threshold_audit/i);
    expect(params[0]).toBe("dupe-deal");
    expect(params[1]).toBe("set");
    expect(params[2]).toBe("/api/admin/growth-health/dupe-deal-thresholds");
  });

  it("sets changedBy=admin when x-admin-key header is present", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await recordThresholdAudit(
      makeReq({ "x-admin-key": "secret" }),
      "dupe-deal",
      "set",
      "/api/admin/growth-health/dupe-deal-thresholds",
      null,
      { yellow: 3, red: 15 },
    );
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe("admin");
  });

  it("sets changedBy from x-user-id when no admin key header", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await recordThresholdAudit(
      makeReq({ "x-user-id": "user-42" }),
      "dupe-deal",
      "reset",
      "/api/admin/growth-health/dupe-deal-thresholds",
      { yellow: 3, red: 15, source: "db" },
      null,
    );
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe("user-42");
  });

  it("serialises oldValue and newValue as JSON strings", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const old = { yellow: 5, red: 20, source: "env" };
    const next = { yellow: 3, red: 15 };
    await recordThresholdAudit(
      makeReq({ "x-admin-key": "secret" }),
      "dupe-deal",
      "set",
      "/api/admin/growth-health/dupe-deal-thresholds",
      old,
      next,
    );
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe(JSON.stringify(old));
    expect(params[5]).toBe(JSON.stringify(next));
  });

  it("stores null for newValue on a reset action", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await recordThresholdAudit(
      makeReq({ "x-admin-key": "secret" }),
      "dupe-deal",
      "reset",
      "/api/admin/growth-health/dupe-deal-thresholds",
      { yellow: 3, red: 15, source: "db" },
      null,
    );
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[5]).toBeNull();
  });

  it("re-throws when pool.query fails", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB write failed"));
    await expect(
      recordThresholdAudit(
        makeReq({ "x-admin-key": "secret" }),
        "dupe-deal",
        "set",
        "/api/admin/growth-health/dupe-deal-thresholds",
        null,
        { yellow: 3, red: 15 },
      ),
    ).rejects.toThrow("DB write failed");
  });
});

// ── withGuaranteedAudit unit tests ───────────────────────────────────────────

describe("withGuaranteedAudit", () => {
  function makeReq(headers: Record<string, string> = {}) {
    return { headers } as unknown as import("express").Request;
  }

  const baseArgs = {
    subsystem: "dupe-deal",
    action: "set" as const,
    endpoint: "/api/admin/growth-health/dupe-deal-thresholds",
    oldValue: { yellow: 5, red: 20, source: "env" },
    newValue: { yellow: 3, red: 15 },
  };

  it("runs the mutation and writes an audit row on success", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const mutation = vi.fn().mockResolvedValueOnce(undefined);

    await withGuaranteedAudit({ req: makeReq({ "x-admin-key": "s" }), ...baseArgs }, mutation);

    expect(mutation).toHaveBeenCalledOnce();
    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[0]).toBe("dupe-deal");
    expect(params[1]).toBe("set");
  });

  it("still writes an audit row when the mutation throws", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const mutation = vi.fn().mockRejectedValueOnce(new Error("upsert failed"));

    await expect(
      withGuaranteedAudit({ req: makeReq({ "x-admin-key": "s" }), ...baseArgs }, mutation),
    ).rejects.toThrow("upsert failed");

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
  });

  it("includes _auditError in the recorded newValue when the mutation fails", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const mutation = vi.fn().mockRejectedValueOnce(new Error("upsert failed"));

    await expect(
      withGuaranteedAudit({ req: makeReq({ "x-admin-key": "s" }), ...baseArgs }, mutation),
    ).rejects.toThrow();

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    const recordedNewValue = JSON.parse(params[5] as string) as Record<string, unknown>;
    expect(recordedNewValue._auditError).toContain("upsert failed");
  });

  it("re-throws the original mutation error even when audit write also fails", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("audit DB down"));
    const mutation = vi.fn().mockRejectedValueOnce(new Error("upsert failed"));

    await expect(
      withGuaranteedAudit({ req: makeReq({ "x-admin-key": "s" }), ...baseArgs }, mutation),
    ).rejects.toThrow("upsert failed");
  });

  it("returns the mutation result on success", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const mutation = vi.fn().mockResolvedValueOnce("returned-value");

    const result = await withGuaranteedAudit(
      { req: makeReq({ "x-admin-key": "s" }), ...baseArgs },
      mutation,
    );
    expect(result).toBe("returned-value");
  });

  it("records null as newValue for a reset action on success", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const mutation = vi.fn().mockResolvedValueOnce(undefined);

    await withGuaranteedAudit(
      { req: makeReq({ "x-admin-key": "s" }), ...baseArgs, action: "reset", newValue: null },
      mutation,
    );

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[5]).toBeNull();
  });
});

// ── getThresholdAuditLog unit tests ───────────────────────────────────────────

function makeAuditRow(overrides: Partial<{
  id: number;
  subsystem: string;
  action: string;
  endpoint: string;
  changed_by: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    subsystem: "dupe-deal",
    action: "set",
    endpoint: "/api/admin/growth-health/dupe-deal-thresholds",
    changed_by: "admin",
    old_value: JSON.stringify({ yellow: 5 }),
    new_value: JSON.stringify({ yellow: 3 }),
    created_at: "1700000000000",
    ...overrides,
  };
}

describe("getThresholdAuditLog", () => {
  it("returns entries and total with no filters", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rows: [makeAuditRow({ id: 1 }), makeAuditRow({ id: 2 })] });

    const { entries, total } = await getThresholdAuditLog({});
    expect(total).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(1);
  });

  it("maps row fields to camelCase entry shape", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({
        rows: [
          makeAuditRow({
            changed_by: "admin",
            old_value: JSON.stringify({ yellow: 5 }),
            new_value: JSON.stringify({ yellow: 3 }),
            created_at: "1700000000000",
          }),
        ],
      });

    const { entries } = await getThresholdAuditLog({});
    const e = entries[0];
    expect(e.changedBy).toBe("admin");
    expect(e.oldValue).toEqual({ yellow: 5 });
    expect(e.newValue).toEqual({ yellow: 3 });
    expect(e.createdAt).toBe(1700000000000);
  });

  it("passes subsystem as a WHERE condition in both COUNT and SELECT queries", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rows: [makeAuditRow()] });

    await getThresholdAuditLog({ subsystem: "error-rate" });

    const [countSql, countParams] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(countSql).toMatch(/WHERE/i);
    expect(countParams).toContain("error-rate");

    const [selectSql, selectParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(selectSql).toMatch(/WHERE/i);
    expect(selectParams).toContain("error-rate");
  });

  it("includes since in WHERE conditions when provided", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getThresholdAuditLog({ since: 1699000000000 });

    const [, countParams] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(countParams).toContain(1699000000000);
  });

  it("includes until in WHERE conditions when provided", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getThresholdAuditLog({ until: 1701000000000 });

    const [, countParams] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(countParams).toContain(1701000000000);
  });

  it("passes offset to the SELECT query", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "5" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getThresholdAuditLog({ offset: 3, limit: 10 });

    const [selectSql, selectParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(selectSql).toMatch(/OFFSET/i);
    expect(selectParams).toContain(3);
    expect(selectParams).toContain(10);
  });

  it("returns total from COUNT even when SELECT returns fewer rows (offset scenario)", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "5" }] })
      .mockResolvedValueOnce({ rows: [makeAuditRow()] });

    const { total, entries } = await getThresholdAuditLog({ offset: 4, limit: 10 });
    expect(total).toBe(5);
    expect(entries).toHaveLength(1);
  });

  it("returns total=0 and empty entries when no rows exist", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    const { total, entries } = await getThresholdAuditLog({});
    expect(total).toBe(0);
    expect(entries).toHaveLength(0);
  });
});

// ── HTTP route tests ──────────────────────────────────────────────────────────

async function buildServer() {
  process.env.ADMIN_KEY = "test-admin-key";

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
        "x-admin-key": "test-admin-key",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function rawRequest(method: string, path: string, body?: object) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "test-admin-key",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status };
  }

  async function noAuthRequest(method: string, path: string) {
    const res = await fetch(`${base}${path}`, { method });
    return { status: res.status, body: (await res.json()) as any };
  }

  return {
    request,
    rawRequest,
    noAuthRequest,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("GET /api/admin/growth-health/threshold-audit-log", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockReset();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns success with entries and total", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rows: [makeAuditRow()] });

    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/threshold-audit-log",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.total).toBe(1);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it("passes offset query param through and reflects it in the response", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "10" }] })
      .mockResolvedValueOnce({ rows: [] });

    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/threshold-audit-log?offset=5",
    );
    expect(status).toBe(200);
    expect(body.offset).toBe(5);
    expect(body.total).toBe(10);
    expect(body.data).toHaveLength(0);
  });

  it("passes since and until to the query and reflects them in filtering", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "3" }] })
      .mockResolvedValueOnce({ rows: [makeAuditRow({ id: 7 })] });

    const since = 1699000000000;
    const until = 1701000000000;
    const { status, body } = await server.request(
      "GET",
      `/api/admin/growth-health/threshold-audit-log?since=${since}&until=${until}`,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.total).toBe(3);

    const [, countParams] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(countParams).toContain(since);
    expect(countParams).toContain(until);
  });

  it("returns 400 when since > until", async () => {
    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/threshold-audit-log?since=1701000000000&until=1699000000000",
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("total in response reflects applied filters (not unfiltered count)", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rows: [makeAuditRow({ id: 10 }), makeAuditRow({ id: 11 })] });

    const { body } = await server.request(
      "GET",
      "/api/admin/growth-health/threshold-audit-log?subsystem=dupe-deal",
    );
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
  });
});

describe("GET /api/admin/growth-health/audit-log-meta", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockReset();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns success with totalRows and retentionDays", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: "42" }] });

    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/audit-log-meta",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.totalRows).toBe(42);
    expect(typeof body.data.retentionDays).toBe("number");
    expect(body.data.retentionDays).toBeGreaterThan(0);
  });

  it("returns lastPrunedAt as null when no prune has run this session", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const { body } = await server.request(
      "GET",
      "/api/admin/growth-health/audit-log-meta",
    );
    expect(body.success).toBe(true);
    expect(body.data.lastPrunedAt).toBeNull();
  });

  it("returns 401 when admin key is missing", async () => {
    const { status, body } = await server.noAuthRequest("GET", "/api/admin/growth-health/audit-log-meta");
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  it("returns totalRows 0 and success when DB query fails", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("db error"));

    const { status, body } = await server.request(
      "GET",
      "/api/admin/growth-health/audit-log-meta",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.totalRows).toBe(0);
  });
});

describe("Audit row written when threshold is set", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockReset();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("inserts an audit row after setting dupe-deal thresholds", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: "watchtower_dupe_deal_races_yellow", value: "5" },
          { key: "watchtower_dupe_deal_races_red", value: "20" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { status, body } = await server.request(
      "POST",
      "/api/admin/growth-health/dupe-deal-thresholds",
      { yellow: 3, red: 15 },
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, insertParams] = insertCall as [string, unknown[]];
    expect(insertParams[0]).toBe("dupe-deal");
    expect(insertParams[1]).toBe("set");
  });

  it("inserts an audit row after resetting dupe-deal thresholds", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: "watchtower_dupe_deal_races_yellow", value: "3" },
          { key: "watchtower_dupe_deal_races_red", value: "15" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { status, body } = await server.request(
      "DELETE",
      "/api/admin/growth-health/dupe-deal-thresholds",
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, insertParams] = insertCall as [string, unknown[]];
    expect(insertParams[0]).toBe("dupe-deal");
    expect(insertParams[1]).toBe("reset");
    expect(insertParams[5]).toBeNull();
  });

  it("inserts an audit row after setting error-rate thresholds", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: "watchtower_error_rate_yellow", value: "20" },
          { key: "watchtower_error_rate_red", value: "50" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { status } = await server.request(
      "POST",
      "/api/admin/growth-health/error-rate-thresholds",
      { yellow: 10, red: 30 },
    );
    expect(status).toBe(200);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, insertParams] = insertCall as [string, unknown[]];
    expect(insertParams[0]).toBe("error-rate");
    expect(insertParams[1]).toBe("set");
  });

  it("still writes an audit row even when the threshold upsert fails mid-operation", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: "watchtower_dupe_deal_races_yellow", value: "5" },
          { key: "watchtower_dupe_deal_races_red", value: "20" },
        ],
      })
      .mockRejectedValueOnce(new Error("upsert crashed"))
      .mockResolvedValueOnce({ rows: [] });

    const { status } = await server.rawRequest(
      "POST",
      "/api/admin/growth-health/dupe-deal-thresholds",
      { yellow: 3, red: 15 },
    );
    expect(status).toBe(500);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, insertParams] = insertCall as [string, unknown[]];
    expect(insertParams[0]).toBe("dupe-deal");
    expect(insertParams[1]).toBe("set");
    const recordedNewValue = JSON.parse(insertParams[5] as string) as Record<string, unknown>;
    expect(recordedNewValue._auditError).toContain("upsert crashed");
  });
});

// ── reset-all audit tests ─────────────────────────────────────────────────────

describe("POST /api/admin/growth-health/reset-all writes audit rows for every subsystem", () => {
  const EXPECTED_SUBSYSTEMS = [
    "dupe-deal",
    "pool-resets",
    "error-rate",
    "webhook-success",
    "lead-scraper",
    "outreach-processor",
    "deliverability",
    "stripe-webhook",
    "procore-sync",
    "cron-scheduler",
  ];

  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    mockPoolQuery.mockReset();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns 200 and inserts one audit row per subsystem with action=reset", async () => {
    // 10 SELECT queries (one per subsystem getter) + 1 DELETE (resetAllThresholds) + 10 INSERT (audit rows)
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const { status, body } = await server.request("POST", "/api/admin/growth-health/reset-all");
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const insertCalls = mockPoolQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );
    expect(insertCalls).toHaveLength(EXPECTED_SUBSYSTEMS.length);

    const auditedSubsystems = insertCalls.map(([, params]: [string, unknown[]]) => params[0] as string);
    for (const subsystem of EXPECTED_SUBSYSTEMS) {
      expect(auditedSubsystems).toContain(subsystem);
    }
  });

  it("records action=reset and null newValue for every subsystem", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await server.request("POST", "/api/admin/growth-health/reset-all");

    const insertCalls = mockPoolQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );

    for (const [, params] of insertCalls as [string, unknown[]][]) {
      expect(params[1]).toBe("reset");
      expect(params[5]).toBeNull();
    }
  });

  it("records old values read before the reset in each audit entry", async () => {
    // Return DB-stored values for dupe-deal (first SELECT), everything else empty
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { key: "watchtower_dupe_deal_races_yellow", value: "3" },
          { key: "watchtower_dupe_deal_races_red", value: "15" },
        ],
      })
      .mockResolvedValue({ rows: [] });

    await server.request("POST", "/api/admin/growth-health/reset-all");

    const insertCalls = mockPoolQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && /INSERT INTO watchtower_threshold_audit/i.test(sql),
    );

    const dupeDealAudit = insertCalls.find(([, params]: [string, unknown[]]) => params[0] === "dupe-deal");
    expect(dupeDealAudit).toBeDefined();
    const [, dupeDealParams] = dupeDealAudit as [string, unknown[]];
    const oldValue = JSON.parse(dupeDealParams[4] as string) as Record<string, unknown>;
    expect(oldValue.yellow).toBe(3);
    expect(oldValue.red).toBe(15);
    expect(oldValue.source).toBe("db");
  });

  it("still writes audit rows even when some audit inserts fail", async () => {
    // 10 selects succeed, 1 delete succeeds, first 5 inserts fail, last 5 succeed
    mockPoolQuery.mockReset();
    let callCount = 0;
    mockPoolQuery.mockImplementation(() => {
      callCount++;
      if (callCount <= 11) return Promise.resolve({ rows: [] });
      // alternate fail/succeed for the 10 audit inserts
      if (callCount <= 16) return Promise.reject(new Error("audit DB error"));
      return Promise.resolve({ rows: [] });
    });

    const { status } = await server.rawRequest("POST", "/api/admin/growth-health/reset-all");
    expect(status).toBe(200);
  });
});

// ── pruneAuditLog unit tests ───────────────────────────────────────────────────

describe("getAuditRetentionDays", () => {
  const originalEnv = process.env.AUDIT_RETENTION_DAYS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AUDIT_RETENTION_DAYS;
    } else {
      process.env.AUDIT_RETENTION_DAYS = originalEnv;
    }
  });

  it("returns 90 when AUDIT_RETENTION_DAYS is not set", () => {
    delete process.env.AUDIT_RETENTION_DAYS;
    expect(getAuditRetentionDays()).toBe(90);
  });

  it("returns the parsed value when AUDIT_RETENTION_DAYS is a valid positive integer", () => {
    process.env.AUDIT_RETENTION_DAYS = "30";
    expect(getAuditRetentionDays()).toBe(30);
  });

  it("falls back to 90 when AUDIT_RETENTION_DAYS is zero", () => {
    process.env.AUDIT_RETENTION_DAYS = "0";
    expect(getAuditRetentionDays()).toBe(90);
  });

  it("falls back to 90 when AUDIT_RETENTION_DAYS is negative", () => {
    process.env.AUDIT_RETENTION_DAYS = "-5";
    expect(getAuditRetentionDays()).toBe(90);
  });

  it("falls back to 90 when AUDIT_RETENTION_DAYS is not a number", () => {
    process.env.AUDIT_RETENTION_DAYS = "banana";
    expect(getAuditRetentionDays()).toBe(90);
  });
});

describe("pruneAuditLog", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    delete process.env.AUDIT_RETENTION_DAYS;
  });

  afterEach(() => {
    delete process.env.AUDIT_RETENTION_DAYS;
  });

  it("issues a DELETE with a cutoff that keeps rows within the retention window", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 3 });
    const before = Date.now();
    await pruneAuditLog();
    const after = Date.now();

    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM watchtower_threshold_audit/i);
    expect(sql).toMatch(/WHERE created_at < \$1/i);

    const cutoff = params[0] as number;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - ninetyDaysMs);
    expect(cutoff).toBeLessThanOrEqual(after - ninetyDaysMs);
  });

  it("returns the number of deleted rows reported by the DB", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 7 });
    const { deleted } = await pruneAuditLog();
    expect(deleted).toBe(7);
  });

  it("uses AUDIT_RETENTION_DAYS env var when set", async () => {
    process.env.AUDIT_RETENTION_DAYS = "30";
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });
    const before = Date.now();
    await pruneAuditLog();
    const after = Date.now();

    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    const cutoff = params[0] as number;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - thirtyDaysMs);
    expect(cutoff).toBeLessThanOrEqual(after - thirtyDaysMs);
  });

  it("does NOT delete rows that are within the retention window", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });
    const recentRowCreatedAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await pruneAuditLog();

    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    const cutoff = params[0] as number;
    expect(recentRowCreatedAt).toBeGreaterThan(cutoff);
  });

  it("confirms that rows older than the retention window would be deleted", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });
    const oldRowCreatedAt = Date.now() - 91 * 24 * 60 * 60 * 1000;
    await pruneAuditLog();

    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    const cutoff = params[0] as number;
    expect(oldRowCreatedAt).toBeLessThan(cutoff);
  });

  it("returns deleted=0 and does not throw when pool.query fails", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("DB connection lost"));
    const { deleted } = await pruneAuditLog();
    expect(deleted).toBe(0);
  });

  it("returns deleted=0 when rowCount is null", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: null });
    const { deleted } = await pruneAuditLog();
    expect(deleted).toBe(0);
  });
});
