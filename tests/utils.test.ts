import { describe, it, expect } from "vitest";
import { AppError, dayKey, escapeHtml, mustEnv, now } from "../server/lib/utils.js";

describe("dayKey", () => {
  it("returns YYYY-MM-DD format", () => {
    const key = dayKey(new Date("2026-01-15T12:30:00Z").getTime());
    expect(key).toBe("2026-01-15");
  });

  it("pads single-digit month and day", () => {
    const key = dayKey(new Date("2026-03-05T00:00:00Z").getTime());
    expect(key).toBe("2026-03-05");
  });

  it("returns today when called without args", () => {
    const key = dayKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("now", () => {
  it("returns a number close to Date.now()", () => {
    const before = Date.now();
    const result = now();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes quotes", () => {
    expect(escapeHtml('"hello\'')).toBe("&quot;hello&#39;");
  });

  it("returns safe strings unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });
});

describe("AppError", () => {
  it("creates an error with default 500 status", () => {
    const err = new AppError("test error");
    expect(err.message).toBe("test error");
    expect(err.statusCode).toBe(500);
    expect(err.isOperational).toBe(true);
  });

  it("creates an error with custom status", () => {
    const err = new AppError("not found", 404);
    expect(err.statusCode).toBe(404);
  });

  it("is an instance of Error", () => {
    const err = new AppError("test");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("mustEnv", () => {
  it("returns the env var value when set", () => {
    process.env.TEST_MUST_ENV = "hello";
    expect(mustEnv("TEST_MUST_ENV")).toBe("hello");
    delete process.env.TEST_MUST_ENV;
  });

  it("throws when env var is not set", () => {
    expect(() => mustEnv("DEFINITELY_NOT_SET_XYZZY")).toThrow(
      "Missing required env var: DEFINITELY_NOT_SET_XYZZY"
    );
  });
});
