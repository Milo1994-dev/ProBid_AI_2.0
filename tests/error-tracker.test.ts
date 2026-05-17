import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

vi.mock("../server/db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

vi.mock("../server/lib/logger.js", () => ({
  log: () => {},
}));

function generateFingerprint(message: string, path?: string, statusCode?: number): string {
  const normalized = message.replace(/\d+/g, "N").replace(/['"](.*?)['"]/g, "'X'").trim();
  const key = `${normalized}|${path || ""}|${statusCode || 0}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

describe("error fingerprinting", () => {
  it("produces consistent fingerprints for the same error", () => {
    const fp1 = generateFingerprint("Connection timeout", "/api/test", 500);
    const fp2 = generateFingerprint("Connection timeout", "/api/test", 500);
    expect(fp1).toBe(fp2);
  });

  it("normalizes numeric values in messages", () => {
    const fp1 = generateFingerprint("Failed after 3 retries", "/api/test");
    const fp2 = generateFingerprint("Failed after 7 retries", "/api/test");
    expect(fp1).toBe(fp2);
  });

  it("normalizes quoted strings in messages", () => {
    const fp1 = generateFingerprint("User 'john' not found", "/api/users");
    const fp2 = generateFingerprint("User 'jane' not found", "/api/users");
    expect(fp1).toBe(fp2);
  });

  it("differentiates errors from different paths", () => {
    const fp1 = generateFingerprint("Server error", "/api/a", 500);
    const fp2 = generateFingerprint("Server error", "/api/b", 500);
    expect(fp1).not.toBe(fp2);
  });

  it("differentiates errors with different messages", () => {
    const fp1 = generateFingerprint("Timeout error", "/api/test");
    const fp2 = generateFingerprint("Connection refused", "/api/test");
    expect(fp1).not.toBe(fp2);
  });

  it("returns a 16-character hex string", () => {
    const fp = generateFingerprint("test error");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("trackError module", () => {
  it("can be imported without errors", async () => {
    const mod = await import("../server/lib/error-tracker.js");
    expect(mod.trackError).toBeDefined();
    expect(mod.setupProcessErrorHandlers).toBeDefined();
    expect(typeof mod.trackError).toBe("function");
    expect(typeof mod.setupProcessErrorHandlers).toBe("function");
  });
});
