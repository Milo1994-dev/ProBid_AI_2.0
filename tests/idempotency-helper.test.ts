import { describe, it, expect, vi } from "vitest";

vi.mock("../server/db.js", () => ({ db: undefined }));

const {
  hashRequestBody,
  readIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  __testing,
} = await import("../server/lib/idempotency.js");

describe("idempotency.readIdempotencyKey", () => {
  it("returns null when no key is present", () => {
    const result = readIdempotencyKey({ headers: {}, body: {} });
    expect(result).toEqual({ key: null, error: null });
  });

  it("reads from the Idempotency-Key header", () => {
    const result = readIdempotencyKey({
      headers: { "idempotency-key": "abc-123" },
      body: {},
    });
    expect(result).toEqual({ key: "abc-123", error: null });
  });

  it("falls back to the idempotencyKey body field", () => {
    const result = readIdempotencyKey({
      headers: {},
      body: { idempotencyKey: "from-body" },
    });
    expect(result).toEqual({ key: "from-body", error: null });
  });

  it("rejects keys longer than the max length", () => {
    const long = "x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
    const result = readIdempotencyKey({ headers: { "idempotency-key": long }, body: {} });
    expect(result.key).toBeNull();
    expect(result.error).toMatch(/255/);
  });

  it("rejects keys with disallowed characters", () => {
    const result = readIdempotencyKey({
      headers: { "idempotency-key": "bad key with spaces" },
      body: {},
    });
    expect(result.key).toBeNull();
    expect(result.error).toMatch(/letters, digits/);
  });

  it("accepts UUID-style keys", () => {
    const result = readIdempotencyKey({
      headers: { "idempotency-key": "7c1b3e0e-4ad6-4f2e-8a0a-2b1d3f5a6c7d" },
      body: {},
    });
    expect(result.key).toBe("7c1b3e0e-4ad6-4f2e-8a0a-2b1d3f5a6c7d");
    expect(result.error).toBeNull();
  });
});

describe("idempotency.hashRequestBody", () => {
  it("produces a stable hash regardless of object key order", () => {
    const a = hashRequestBody({ name: "X", lineItems: [{ description: "Demo", quantity: 1 }] });
    const b = hashRequestBody({ lineItems: [{ quantity: 1, description: "Demo" }], name: "X" });
    expect(a).toBe(b);
  });

  it("produces different hashes for different payloads", () => {
    const a = hashRequestBody({ name: "X", quantity: 1 });
    const b = hashRequestBody({ name: "X", quantity: 2 });
    expect(a).not.toBe(b);
  });

  it("canonicalizes nested arrays in order (order matters for arrays)", () => {
    const a = __testing.canonicalize([1, 2, 3]);
    const b = __testing.canonicalize([3, 2, 1]);
    expect(a).not.toBe(b);
  });
});
