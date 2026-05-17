import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({
  pool: { query: vi.fn() },
  getPoolResetStats: vi.fn(),
  getDuplicateDealRaceStats: vi.fn(),
}));

vi.mock("../resend-client.js", () => ({
  getResendClient: vi.fn(),
  sendEmailWithRetry: vi.fn(),
}));

vi.mock("../lib/utils.js", () => ({
  dayKey: vi.fn(),
}));

vi.mock("../growth-health.js", () => ({
  getGrowthHealthSnapshot: vi.fn().mockResolvedValue({ overall: "green", subsystems: [] }),
  invalidateGrowthHealthCache: vi.fn(),
}));

import {
  renderGrowthAlertEmail,
  renderGrowthRecoveryEmail,
} from "../health-monitor.js";

import type { SubsystemRollup } from "../growth-health.js";

function makeSubsystem(overrides: Partial<SubsystemRollup> = {}): SubsystemRollup {
  return {
    key: "test_subsystem",
    label: "Test Subsystem",
    description: "A test subsystem",
    status: "red",
    reasons: ["Something went wrong"],
    lastSuccessAt: null,
    lastFailureAt: null,
    throughput24h: 0,
    failureCount24h: 0,
    failureRate24h: null,
    latestError: null,
    ...overrides,
  };
}

describe("renderGrowthAlertEmail — threshold row", () => {
  it("includes the threshold row when meta.thresholds is populated", () => {
    const sub = makeSubsystem({
      meta: {
        thresholds: {
          yellow: "10",
          red: "25",
          label: "resets/hr",
          direction: "above",
        },
      },
    });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain("Thresholds");
    expect(html).toContain("10");
    expect(html).toContain("25");
    expect(html).toContain("resets/hr");
  });

  it("omits the threshold row when meta is missing", () => {
    const sub = makeSubsystem({ meta: undefined });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).not.toContain("Thresholds");
  });

  it("omits the threshold row when meta exists but has no thresholds key", () => {
    const sub = makeSubsystem({ meta: { someOtherKey: 42 } });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).not.toContain("Thresholds");
  });

  it("HTML-escapes special characters in threshold label", () => {
    const sub = makeSubsystem({
      meta: {
        thresholds: {
          yellow: "5",
          red: "10",
          label: '<script>alert("xss")</script>',
          direction: "above",
        },
      },
    });
    const html = renderGrowthAlertEmail(sub, "critical");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;xss&quot;");
  });

  it("HTML-escapes special characters in threshold yellow and red values", () => {
    const sub = makeSubsystem({
      meta: {
        thresholds: {
          yellow: "5 & 10",
          red: "20 > 15",
          label: "events",
          direction: "above",
        },
      },
    });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain("5 &amp; 10");
    expect(html).toContain("20 &gt; 15");
  });

  it("renders the Current row when meta.thresholds.currentValue is set", () => {
    const sub = makeSubsystem({
      meta: {
        thresholds: {
          yellow: "10",
          red: "25",
          label: "resets/hr",
          direction: "ceil",
          currentValue: "17",
        },
      },
    });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain("Current");
    expect(html).toContain("17");
    expect(html).toContain("resets/hr");
    expect(html).toContain("Thresholds");
    expect(html).toMatchSnapshot();
  });

  it("omits the Current row but still renders Thresholds when currentValue is undefined", () => {
    const sub = makeSubsystem({
      meta: {
        thresholds: {
          yellow: "10",
          red: "25",
          label: "resets/hr",
          direction: "ceil",
        },
      },
    });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).not.toContain("Current");
    expect(html).toContain("Thresholds");
    expect(html).toContain("10");
    expect(html).toContain("25");
    expect(html).toContain("resets/hr");
    expect(html).toMatchSnapshot();
  });
});

describe("renderGrowthAlertEmail — general content", () => {
  it("uses red color for critical severity", () => {
    const sub = makeSubsystem();
    const html = renderGrowthAlertEmail(sub, "critical");
    expect(html).toContain("#ef4444");
    expect(html).toContain("CRITICAL");
  });

  it("uses amber color for warning severity", () => {
    const sub = makeSubsystem();
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain("#f59e0b");
    expect(html).toContain("WARNING");
  });

  it("renders the subsystem label in the heading", () => {
    const sub = makeSubsystem({ label: "Lead Scraper" });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain("Lead Scraper");
  });

  it("renders each reason as a list item, HTML-escaped", () => {
    const sub = makeSubsystem({
      reasons: ["Error rate > 50%", "<b>High failures</b>"],
    });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain("Error rate &gt; 50%");
    expect(html).toContain("&lt;b&gt;High failures&lt;/b&gt;");
    expect(html).not.toContain("<b>High failures</b>");
  });

  it("shows 'never' for lastSuccessAt when null", () => {
    const sub = makeSubsystem({ lastSuccessAt: null });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain("never");
  });

  it("shows ISO timestamp for lastSuccessAt when set", () => {
    const ts = 1_700_000_000_000;
    const sub = makeSubsystem({ lastSuccessAt: ts });
    const html = renderGrowthAlertEmail(sub, "warning");
    expect(html).toContain(new Date(ts).toISOString());
  });

  it("HTML-escapes latestError content", () => {
    const sub = makeSubsystem({
      latestError: '<img src=x onerror="alert(1)">',
    });
    const html = renderGrowthAlertEmail(sub, "critical");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("renderGrowthRecoveryEmail", () => {
  it("shows 'Recovered' heading for green status", () => {
    const sub = makeSubsystem({ status: "green" });
    const html = renderGrowthRecoveryEmail(sub);
    expect(html).toContain("Recovered");
    expect(html).toContain("GREEN");
  });

  it("shows 'Paused' heading for paused status", () => {
    const sub = makeSubsystem({ status: "paused" });
    const html = renderGrowthRecoveryEmail(sub);
    expect(html).toContain("Paused");
    expect(html).toContain("PAUSED");
  });

  it("renders the subsystem label", () => {
    const sub = makeSubsystem({ status: "green", label: "Outreach Processor" });
    const html = renderGrowthRecoveryEmail(sub);
    expect(html).toContain("Outreach Processor");
  });

  it("shows '—' for lastSuccessAt when null", () => {
    const sub = makeSubsystem({ status: "green", lastSuccessAt: null });
    const html = renderGrowthRecoveryEmail(sub);
    expect(html).toContain("—");
  });

  it("shows ISO timestamp for lastSuccessAt when set", () => {
    const ts = 1_700_000_000_000;
    const sub = makeSubsystem({ status: "green", lastSuccessAt: ts });
    const html = renderGrowthRecoveryEmail(sub);
    expect(html).toContain(new Date(ts).toISOString());
  });

  it("includes 24h throughput in the output", () => {
    const sub = makeSubsystem({ status: "green", throughput24h: 42 });
    const html = renderGrowthRecoveryEmail(sub);
    expect(html).toContain("42");
  });
});
