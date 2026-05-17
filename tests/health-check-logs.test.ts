import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { runHealthChecks, runGrowthHealthChecks } from "../server/health-monitor.js";

beforeEach(() => {
  vi.clearAllMocks();

  mockGetResendClient.mockResolvedValue({
    client: { emails: { send: vi.fn() } },
    fromEmail: "noreply@example.com",
  });
  mockSendEmailWithRetry.mockResolvedValue(undefined);

  mockPoolQuery.mockResolvedValue({ rows: [] });

  mockGetGrowthHealthSnapshot.mockResolvedValue({
    generatedAt: Date.now(),
    overall: "green",
    subsystems: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runGrowthHealthChecks error logs", () => {
  it("logs console.error with snapshot-failed message when getGrowthHealthSnapshot rejects", async () => {
    const snapshotError = new Error("DB connection lost");
    mockGetGrowthHealthSnapshot.mockRejectedValueOnce(snapshotError);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runGrowthHealthChecks();

    const calls = [...errorSpy.mock.calls];
    errorSpy.mockRestore();

    const match = calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("[health-monitor] growth-health snapshot failed:"),
    );
    expect(match).toBeDefined();
    expect(match![0]).toBe("[health-monitor] growth-health snapshot failed:");
    expect(match![1]).toContain("DB connection lost");
  });

  it("logs console.error with reconcile-failed message when pool.query throws during reconcile", async () => {
    mockGetGrowthHealthSnapshot.mockResolvedValueOnce({
      generatedAt: Date.now(),
      overall: "red",
      subsystems: [
        {
          key: "outreach",
          label: "Outreach",
          status: "red",
          reasons: ["No runs in 24h"],
          throughput24h: 0,
          failureCount24h: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          latestError: null,
        },
      ],
    });

    mockPoolQuery.mockRejectedValueOnce(new Error("query timeout"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runGrowthHealthChecks();

    const calls = [...errorSpy.mock.calls];
    errorSpy.mockRestore();

    const match = calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("[health-monitor] reconcile failed for outreach:"),
    );
    expect(match).toBeDefined();
    expect(match![0]).toBe("[health-monitor] reconcile failed for outreach:");
    expect(match![1]).toContain("query timeout");
  });
});

describe("runHealthChecks summary log", () => {
  it("emits a log line reporting the total check count and zero failures when all checks pass", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_1234567890abcdef");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "sk-openai-1234567890abcdef");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runHealthChecks();

    const calls = [...logSpy.mock.calls];
    logSpy.mockRestore();

    const summaryCall = calls.find((args) =>
      typeof args[0] === "string" && args[0].includes("[health-monitor] check complete")
    );
    expect(summaryCall).toBeDefined();

    const line: string = summaryCall![0];
    expect(line).toMatch(/\[health-monitor\] check complete at .+: 4 checks, 0 failures$/);
  });

  it("includes failure names and messages in the log line when a check fails", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runHealthChecks();

    const calls = [...logSpy.mock.calls];
    logSpy.mockRestore();

    const summaryCall = calls.find((args) =>
      typeof args[0] === "string" && args[0].includes("[health-monitor] check complete")
    );
    expect(summaryCall).toBeDefined();

    const line: string = summaryCall![0];

    expect(line).toMatch(/\[health-monitor\] check complete at .+: 4 checks, [1-9]\d* failures/);
    expect(line).toContain("stripe_config");
    expect(line).toContain("openai_config");
    expect(line).toContain("STRIPE_SECRET_KEY missing or too short");
    expect(line).toContain("OpenAI key missing or too short");
  });
});
