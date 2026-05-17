import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetPoolResetStats, mockPoolQuery, mockGetDuplicateDealRaceStats } = vi.hoisted(() => ({
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

import {
  evalDbPoolHealth,
  evalErrorRate,
  evalOutboundWebhooks,
  evalDuplicateDealRaces,
} from "../server/growth-health.js";
import { findRule } from "../server/lib/growth-health-rules.js";

const dbPoolRule = findRule("db_pool_health")!;
const errorRateRule = findRule("error_rate")!;
const webhookRule = findRule("outbound_webhooks")!;
const dupeDealRacesRule = findRule("duplicate_deal_races")!;

beforeEach(() => {
  mockGetPoolResetStats.mockReset();
  mockPoolQuery.mockReset();
  mockGetDuplicateDealRaceStats.mockReset();
});

describe("evalDbPoolHealth", () => {
  it("stays green when reset count is below the yellow threshold", async () => {
    mockGetPoolResetStats.mockReturnValue({
      count: Math.max(0, dbPoolRule.poolResetsPerHour!.yellow - 1),
      total: 100,
      windowMs: 60 * 60 * 1000,
    });
    const r = await evalDbPoolHealth(dbPoolRule);
    expect(r.status).toBe("green");
  });

  it("trips red when reset count meets the red threshold", async () => {
    mockGetPoolResetStats.mockReturnValue({
      count: dbPoolRule.poolResetsPerHour!.red,
      total: 200,
      windowMs: 60 * 60 * 1000,
    });
    const r = await evalDbPoolHealth(dbPoolRule);
    expect(r.status).toBe("red");
    expect(r.reasons.join(" ")).toMatch(/pool reset/i);
  });
});

describe("evalErrorRate", () => {
  it("stays green when no recent error fingerprints", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ c: "0", latest: null, latest_at: null }],
    });
    const r = await evalErrorRate(errorRateRule);
    expect(r.status).toBe("green");
    expect(r.throughput24h).toBe(0);
  });

  it("trips red when distinct fingerprints meet the red threshold", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          c: String(errorRateRule.errorFingerprintsLastHour!.red),
          latest: "boom",
          latest_at: String(Date.now()),
        },
      ],
    });
    const r = await evalErrorRate(errorRateRule);
    expect(r.status).toBe("red");
    expect(r.latestError).toBe("boom");
  });
});

describe("evalOutboundWebhooks", () => {
  it("stays green when success rate is well above yellow", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ delivered: "100", failed: "0" }],
    });
    const r = await evalOutboundWebhooks(webhookRule);
    expect(r.status).toBe("green");
    expect(r.failureCount24h).toBe(0);
  });

  it("trips red when success rate falls below the red threshold (above min volume)", async () => {
    const minVol = webhookRule.webhookSuccessRate1h!.minVolume;
    const total = Math.max(minVol, 20);
    const failed = Math.ceil(total * (1 - webhookRule.webhookSuccessRate1h!.red + 0.01));
    const delivered = total - failed;
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ delivered: String(delivered), failed: String(failed) }],
    });
    const r = await evalOutboundWebhooks(webhookRule);
    expect(r.status).toBe("red");
    expect(r.failureCount24h).toBe(failed);
  });
});

describe("evalDuplicateDealRaces", () => {
  const yellow = dupeDealRacesRule.duplicateDealRacesPerHour!.yellow;
  const red = dupeDealRacesRule.duplicateDealRacesPerHour!.red;

  function mockRaces(count: number) {
    mockGetDuplicateDealRaceStats.mockReturnValue({
      count,
      total: count,
      windowMs: 60 * 60 * 1000,
    });
  }

  it("stays green with 0 races", async () => {
    mockRaces(0);
    const r = await evalDuplicateDealRaces(dupeDealRacesRule);
    expect(r.status).toBe("green");
    expect(r.reasons.join(" ")).toMatch(/0 duplicate-deal races/);
  });

  it("trips yellow at the yellow threshold (5 races)", async () => {
    mockRaces(yellow);
    const r = await evalDuplicateDealRaces(dupeDealRacesRule);
    expect(r.status).toBe("yellow");
    expect(r.reasons.join(" ")).toMatch(/yellow threshold/i);
  });

  it("trips red at the red threshold (20 races)", async () => {
    mockRaces(red);
    const r = await evalDuplicateDealRaces(dupeDealRacesRule);
    expect(r.status).toBe("red");
    expect(r.reasons.join(" ")).toMatch(/red threshold/i);
  });

  it("stays red above the red threshold (21 races)", async () => {
    mockRaces(red + 1);
    const r = await evalDuplicateDealRaces(dupeDealRacesRule);
    expect(r.status).toBe("red");
    expect(r.reasons.join(" ")).toMatch(/red threshold/i);
  });
});
