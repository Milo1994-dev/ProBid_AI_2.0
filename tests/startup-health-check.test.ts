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

import { startHealthMonitor } from "../server/health-monitor.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();

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
  vi.useRealTimers();
});

describe("startHealthMonitor startup check", () => {
  it("calls runHealthChecks immediately on startup without waiting for the first interval", async () => {
    startHealthMonitor();

    // Advance by 0ms to flush any pending timer callbacks, then let promises settle.
    await vi.advanceTimersByTimeAsync(0);

    // pool.query is called inside runHealthChecks (DB check + cron check).
    // If it was called, runHealthChecks ran synchronously at startup.
    expect(mockPoolQuery).toHaveBeenCalled();
  });

  it("also calls runHealthChecks again after the interval elapses", async () => {
    startHealthMonitor();

    // Flush the startup call.
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterStartup = mockPoolQuery.mock.calls.length;
    expect(callsAfterStartup).toBeGreaterThan(0);

    // Advance past the default 5-minute interval.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(mockPoolQuery.mock.calls.length).toBeGreaterThan(callsAfterStartup);
  });

  it("logs startup check error when runHealthChecks rejects during the immediate startup call", async () => {
    // Force runHealthChecks to reject by making console.log throw on its first
    // call (which happens at the summary line inside runHealthChecks).
    const boom = new Error("startup boom");
    const logSpy = vi.spyOn(console, "log").mockImplementationOnce(() => {
      throw boom;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startHealthMonitor();
    // Flush the startup promise and its .catch handler.
    await vi.advanceTimersByTimeAsync(0);

    const calls = [...errorSpy.mock.calls];
    logSpy.mockRestore();
    errorSpy.mockRestore();

    const match = calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0] === "[health-monitor] startup check error:",
    );
    expect(match).toBeDefined();
    expect(String(match![1])).toContain("startup boom");
  });

  it("logs interval error when runHealthChecks rejects inside the setInterval callback", async () => {
    // Allow the startup call to succeed normally, then make console.log throw
    // on the second invocation (the first interval tick).
    let logCallCount = 0;
    const boom = new Error("interval boom");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      logCallCount += 1;
      if (logCallCount === 2) throw boom;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startHealthMonitor();
    // Flush startup call (first console.log — succeeds).
    await vi.advanceTimersByTimeAsync(0);
    // Advance past the default 5-minute interval to trigger the interval callback.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    const calls = [...errorSpy.mock.calls];
    logSpy.mockRestore();
    errorSpy.mockRestore();

    const match = calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0] === "[health-monitor] error:",
    );
    expect(match).toBeDefined();
    expect(String(match![1])).toContain("interval boom");
  });
});
