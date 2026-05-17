import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPoolQuery, mockGetPoolResetStats, mockGetGrowthHealthSnapshot } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockGetPoolResetStats: vi.fn(),
  mockGetGrowthHealthSnapshot: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  pool: { query: mockPoolQuery },
  getPoolResetStats: mockGetPoolResetStats,
}));

vi.mock("../server/growth-health.js", () => ({
  getGrowthHealthSnapshot: mockGetGrowthHealthSnapshot,
}));

vi.mock("../server/lib/logger.js", () => ({
  log: vi.fn(),
}));

import { buildDailyDigest, renderDigestHtml } from "../server/lib/daily-digest.js";

function makeEmptyDbResponses() {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [{ sent: "0", bounced: "0", complained: "0" }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ delivered: "0", failed: "0" }] })
    .mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockGetPoolResetStats.mockReset();
  mockGetGrowthHealthSnapshot.mockReset();

  mockGetPoolResetStats.mockReturnValue({ count: 0, total: 0, windowMs: 60 * 60 * 1000 });
});

describe("daily-digest: duplicate_deal_races in email", () => {
  it("includes Duplicate Deal Races with YELLOW status when rule is yellow", async () => {
    makeEmptyDbResponses();
    mockGetGrowthHealthSnapshot.mockResolvedValue({
      subsystems: [
        { label: "Duplicate Deal Races", status: "yellow" },
        { label: "DB Pool Health", status: "green" },
      ],
      overallStatus: "yellow",
      generatedAt: Date.now(),
    });

    const payload = await buildDailyDigest();

    const healthSection = payload.sections.find((s) => s.label === "Subsystem health");
    expect(healthSection).toBeDefined();

    const dupeRow = healthSection!.rows.find(([label]) => label === "Duplicate Deal Races");
    expect(dupeRow).toBeDefined();
    expect(dupeRow![1]).toBe("YELLOW");
  });

  it("includes Duplicate Deal Races with RED status when rule is red", async () => {
    makeEmptyDbResponses();
    mockGetGrowthHealthSnapshot.mockResolvedValue({
      subsystems: [
        { label: "Duplicate Deal Races", status: "red" },
      ],
      overallStatus: "red",
      generatedAt: Date.now(),
    });

    const payload = await buildDailyDigest();

    const healthSection = payload.sections.find((s) => s.label === "Subsystem health");
    const dupeRow = healthSection!.rows.find(([label]) => label === "Duplicate Deal Races");
    expect(dupeRow).toBeDefined();
    expect(dupeRow![1]).toBe("RED");
  });

  it("renders Duplicate Deal Races and its non-green status into the HTML email body", async () => {
    makeEmptyDbResponses();
    mockGetGrowthHealthSnapshot.mockResolvedValue({
      subsystems: [
        { label: "Duplicate Deal Races", status: "yellow" },
      ],
      overallStatus: "yellow",
      generatedAt: Date.now(),
    });

    const payload = await buildDailyDigest();
    const html = renderDigestHtml(payload);

    expect(html).toContain("Duplicate Deal Races");
    expect(html).toContain("YELLOW");
  });
});
