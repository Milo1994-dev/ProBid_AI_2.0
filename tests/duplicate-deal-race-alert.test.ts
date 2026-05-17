import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPoolQuery,
  mockGetGrowthHealthSnapshot,
  mockInvalidateGrowthHealthCache,
  mockSendEmailWithRetry,
  mockGetResendClient,
} = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockGetGrowthHealthSnapshot: vi.fn(),
  mockInvalidateGrowthHealthCache: vi.fn(),
  mockSendEmailWithRetry: vi.fn(),
  mockGetResendClient: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  pool: { query: mockPoolQuery },
}));

vi.mock("../server/growth-health.js", () => ({
  getGrowthHealthSnapshot: mockGetGrowthHealthSnapshot,
  invalidateGrowthHealthCache: mockInvalidateGrowthHealthCache,
}));

vi.mock("../server/resend-client.js", () => ({
  getResendClient: mockGetResendClient,
  sendEmailWithRetry: mockSendEmailWithRetry,
}));

import { runGrowthHealthChecks } from "../server/health-monitor.js";

const BASE_SUB = {
  key: "duplicate_deal_races",
  label: "Duplicate Deal Races",
  reasons: [],
  lastSuccessAt: Date.now(),
  lastFailureAt: null,
  throughput24h: 0,
  failureCount24h: 0,
  latestError: null,
  meta: {},
};

function makeSnapshot(status: "green" | "yellow" | "red") {
  return {
    generatedAt: Date.now(),
    overall: status,
    subsystems: [
      {
        ...BASE_SUB,
        status,
        reasons:
          status === "green"
            ? ["0 duplicate-deal races in last hour (within thresholds)"]
            : [`${status} threshold breached`],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetResendClient.mockResolvedValue({
    client: { emails: { send: vi.fn() } },
    fromEmail: "noreply@example.com",
  });
  mockSendEmailWithRetry.mockResolvedValue(undefined);
});

describe("duplicate_deal_races real-time alert", () => {
  it("inserts a critical system_alerts row when duplicate_deal_races goes red", async () => {
    mockGetGrowthHealthSnapshot.mockResolvedValue(makeSnapshot("red"));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runGrowthHealthChecks();

    const insertCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("INSERT INTO system_alerts"),
    );
    expect(insertCall, "expected an INSERT into system_alerts").toBeTruthy();
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe("growth_health.duplicate_deal_races");
    expect(params[1]).toMatch(/Duplicate Deal Races/);
    expect(params[2]).toBe("critical");
  });

  it("inserts a warning system_alerts row when duplicate_deal_races goes yellow", async () => {
    mockGetGrowthHealthSnapshot.mockResolvedValue(makeSnapshot("yellow"));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runGrowthHealthChecks();

    const insertCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("INSERT INTO system_alerts"),
    );
    expect(insertCall, "expected an INSERT into system_alerts").toBeTruthy();
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe("growth_health.duplicate_deal_races");
    expect(params[2]).toBe("warning");
  });

  it("does not insert a duplicate alert if one is already open at the same severity", async () => {
    mockGetGrowthHealthSnapshot.mockResolvedValue(makeSnapshot("red"));
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 1, severity: "critical" }],
    });

    await runGrowthHealthChecks();

    const insertCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("INSERT INTO system_alerts"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("resolves the open alert and triggers recovery when duplicate_deal_races goes green", async () => {
    mockGetGrowthHealthSnapshot.mockResolvedValue(makeSnapshot("green"));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, severity: "critical" }] })
      .mockResolvedValueOnce({ rows: [] });

    await runGrowthHealthChecks();

    const updateCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("UPDATE system_alerts SET resolved_at"),
    );
    expect(updateCall, "expected an UPDATE to resolve the alert").toBeTruthy();
    const updateParams = updateCall![1] as unknown[];
    expect(updateParams[1]).toBe("growth_health.duplicate_deal_races");
  });

  it("fires no alert and skips INSERT when status stays green with no existing alert", async () => {
    mockGetGrowthHealthSnapshot.mockResolvedValue(makeSnapshot("green"));
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runGrowthHealthChecks();

    const insertCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("INSERT INTO system_alerts"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("escalates from yellow to red by resolving the warning and inserting a critical row", async () => {
    mockGetGrowthHealthSnapshot.mockResolvedValue(makeSnapshot("red"));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 2, severity: "warning" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runGrowthHealthChecks();

    const updateCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("UPDATE system_alerts SET resolved_at"),
    );
    expect(updateCall, "yellow alert should be resolved on escalation").toBeTruthy();

    const insertCall = mockPoolQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("INSERT INTO system_alerts"),
    );
    expect(insertCall, "critical alert should be inserted on escalation").toBeTruthy();
    const insertParams = insertCall![1] as unknown[];
    expect(insertParams[2]).toBe("critical");
  });
});
