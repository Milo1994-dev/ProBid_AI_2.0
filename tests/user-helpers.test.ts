import { describe, it, expect } from "vitest";
import { isPaidActive } from "../server/lib/user-helpers.js";

describe("isPaidActive", () => {
  it("returns false for undefined subscription", () => {
    expect(isPaidActive(undefined)).toBe(false);
  });

  it("returns false for null subscription", () => {
    expect(isPaidActive(null)).toBe(false);
  });

  it("returns true for active subscription", () => {
    expect(isPaidActive({ status: "active" })).toBe(true);
  });

  it("returns true for trialing subscription", () => {
    expect(isPaidActive({ status: "trialing" })).toBe(true);
  });

  it("returns false for canceled subscription", () => {
    expect(isPaidActive({ status: "canceled" })).toBe(false);
  });

  it("returns true for past_due subscription (Stripe dunning grace period)", () => {
    // past_due means Stripe's renewal charge failed and smart-retry is in
    // progress. We keep service active during that window — cutting off
    // immediately would punish customers with temporarily-failed cards
    // (expired card, bank fraud hold) while Stripe is still retrying.
    // See server/lib/user-helpers.ts isPaidActive() for rationale.
    expect(isPaidActive({ status: "past_due" })).toBe(true);
  });

  it("returns false for incomplete subscription", () => {
    expect(isPaidActive({ status: "incomplete" })).toBe(false);
  });
});
