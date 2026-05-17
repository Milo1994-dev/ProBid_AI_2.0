import { describe, it, expect } from "vitest";
import { redactEmail, redactPhone, scrubEmailsInText } from "../server/lib/log-redact.js";

describe("redactEmail", () => {
  it("returns null for null/empty", () => {
    expect(redactEmail(null)).toBeNull();
    expect(redactEmail(undefined)).toBeNull();
    expect(redactEmail("")).toBeNull();
  });

  it("masks both the local part and the domain host, keeping only TLD", () => {
    expect(redactEmail("john.doe@example.com")).toBe("j***@***.com");
  });

  it("does not leak any part of the local part beyond the first character", () => {
    const out = redactEmail("alice@example.com");
    expect(out).not.toContain("alice");
    expect(out).toBe("a***@***.com");
  });

  it("does not leak the domain host", () => {
    const out = redactEmail("john@acmeplumbing.com");
    expect(out).not.toContain("acmeplumbing");
    expect(out).toBe("j***@***.com");
  });

  it("returns *** when the input has no @", () => {
    expect(redactEmail("not-an-email")).toBe("***");
  });

  it("returns *** when the local part is empty", () => {
    expect(redactEmail("@example.com")).toBe("***");
  });

  it("handles subdomains — keeps only the final TLD segment", () => {
    expect(redactEmail("bob@mail.contractor.co.uk")).toBe("b***@***.uk");
  });
});

describe("redactPhone", () => {
  it("returns null for null/empty", () => {
    expect(redactPhone(null)).toBeNull();
    expect(redactPhone(undefined)).toBeNull();
    expect(redactPhone("")).toBeNull();
  });

  it("keeps only the last 4 digits", () => {
    expect(redactPhone("+1 (555) 123-4567")).toBe("***4567");
    expect(redactPhone("5551234567")).toBe("***4567");
  });

  it("returns *** when 4 or fewer digits are present", () => {
    expect(redactPhone("123")).toBe("***");
    expect(redactPhone("1234")).toBe("***");
  });
});

describe("scrubEmailsInText", () => {
  it("returns empty string for null/undefined", () => {
    expect(scrubEmailsInText(null)).toBe("");
    expect(scrubEmailsInText(undefined)).toBe("");
  });

  it("redacts a Postgres unique-constraint detail string", () => {
    const pgErr = "error: duplicate key value violates unique constraint \"scraped_leads_email_unique\" Detail: Key (email)=(jane.doe@contractor.io) already exists.";
    const out = scrubEmailsInText(pgErr);
    expect(out).not.toContain("jane.doe");
    expect(out).not.toContain("contractor.io");
    expect(out).toContain("j***@***.io");
  });

  it("redacts every email in a multi-email string", () => {
    const out = scrubEmailsInText("foo a@b.com bar c@d.com baz");
    expect(out).toBe("foo a***@***.com bar c***@***.com baz");
  });

  it("returns the string unchanged when no emails are present", () => {
    expect(scrubEmailsInText("connection terminated unexpectedly")).toBe("connection terminated unexpectedly");
  });
});
