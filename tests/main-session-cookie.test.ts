import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Regression test: the primary first-party session cookie MUST stay
 * `SameSite=Lax`. Cross-origin SDK callers go through a separate, dedicated
 * cookie (see `server/lib/sdk-session.ts`); the main app session must NOT
 * be made cross-site by accident, since most session-protected mutating
 * routes do not individually validate a CSRF token.
 *
 * If anyone ever flips the main session cookie's `sameSite` to `"none"`
 * again without a corresponding global CSRF refactor, this test fails
 * loudly.
 */
describe("primary session cookie posture", () => {
  it("server.ts configures the probid_session cookie with SameSite=Lax", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");

    // Find the cookieSession({...}) block that defines `name: "probid_session"`.
    const match = source.match(
      /cookieSession\(\s*\{[^}]*name:\s*["']probid_session["'][^}]*\}\s*\)/s,
    );
    expect(match, "could not find probid_session cookieSession block").toBeTruthy();
    const block = match![0];

    expect(block).toMatch(/sameSite:\s*["']lax["']/);
    expect(block).not.toMatch(/sameSite:\s*["']none["']/);
    expect(block).toMatch(/httpOnly:\s*true/);
    expect(block).toMatch(/secure:\s*true/);
  });
});
