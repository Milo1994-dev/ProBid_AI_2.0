import { describe, it, expect } from "vitest";
import { stripSslModeFromUrl } from "../server/db.js";

describe("stripSslModeFromUrl", () => {
  it("removes sslmode while preserving other params and credentials", () => {
    const out = stripSslModeFromUrl(
      "postgres://user:pa%40ss@host:5432/db?sslmode=require&application_name=probid",
    );
    expect(out).toBeDefined();
    expect(out!).not.toMatch(/sslmode/);
    expect(out!).toContain("application_name=probid");
    expect(out!).toContain("user:pa%40ss@host:5432");
    expect(out!).toContain("/db");
  });

  it("is a no-op when sslmode is absent", () => {
    const url = "postgres://u:p@h:5432/d?application_name=x";
    expect(stripSslModeFromUrl(url)).toBe(url);
  });

  it("preserves sslmode=disable so local/test DBs can opt out of TLS", () => {
    const url = "postgres://u:p@h:5432/d?sslmode=disable";
    expect(stripSslModeFromUrl(url)).toContain("sslmode=disable");
  });

  it("preserves sslmode=verify-full (already the strict mode)", () => {
    const url = "postgres://u:p@h:5432/d?sslmode=verify-full";
    expect(stripSslModeFromUrl(url)).toContain("sslmode=verify-full");
  });

  it("returns input unchanged when URL is unparseable", () => {
    expect(stripSslModeFromUrl("not a url")).toBe("not a url");
  });

  it("handles undefined", () => {
    expect(stripSslModeFromUrl(undefined)).toBeUndefined();
  });
});
