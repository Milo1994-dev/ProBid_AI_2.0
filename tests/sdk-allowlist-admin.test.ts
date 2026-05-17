import { describe, it, expect, beforeEach } from "vitest";

/**
 * These tests cover the new pieces added for the admin-managed
 * SDK allowlist:
 *   - `parseAllowlistEntry` validation (used by both env parsing and
 *     the admin POST handler).
 *   - The DB-loader hook + cache-bump path on the cors module so that
 *     active DB rows participate in `isAllowedOrigin` and a successful
 *     admin add/revoke takes effect on the next request.
 *
 * The full admin HTTP flow (audit-log writes, soft-revoke, resurrect)
 * touches the real DB and is exercised end-to-end in dev; these tests
 * stay in-process and use a fake loader so they run with no DB.
 */

async function freshCors() {
  const mod = await import("../server/lib/cors.js");
  mod._resetCorsCacheForTests();
  return mod;
}

describe("parseAllowlistEntry", () => {
  it("accepts and normalizes an exact origin", async () => {
    const { parseAllowlistEntry } = await freshCors();
    const r = parseAllowlistEntry("https://Partner.Example.com/path?x=1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("exact");
      expect(r.normalized).toBe("https://partner.example.com");
    }
  });

  it("accepts a strict subdomain wildcard", async () => {
    const { parseAllowlistEntry } = await freshCors();
    const r = parseAllowlistEntry("*.partner.com");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("wildcard");
      expect(r.normalized).toBe("*.partner.com");
    }
  });

  it("rejects bare wildcard", async () => {
    const { parseAllowlistEntry } = await freshCors();
    expect(parseAllowlistEntry("*").ok).toBe(false);
  });

  it("rejects too-broad wildcards (no real dot boundary)", async () => {
    const { parseAllowlistEntry } = await freshCors();
    expect(parseAllowlistEntry("*.com").ok).toBe(false);
    expect(parseAllowlistEntry("*.").ok).toBe(false);
  });

  it("rejects non-http(s) schemes", async () => {
    const { parseAllowlistEntry } = await freshCors();
    expect(parseAllowlistEntry("ftp://partner.example.com").ok).toBe(false);
  });

  it("rejects non-URL strings", async () => {
    const { parseAllowlistEntry } = await freshCors();
    expect(parseAllowlistEntry("not a url").ok).toBe(false);
    expect(parseAllowlistEntry("").ok).toBe(false);
  });

  it("rejects non-string input", async () => {
    const { parseAllowlistEntry } = await freshCors();
    expect(parseAllowlistEntry(undefined as unknown as string).ok).toBe(false);
    expect(parseAllowlistEntry(123 as unknown as string).ok).toBe(false);
  });
});

describe("DB-backed allowlist integration with isAllowedOrigin", () => {
  beforeEach(() => {
    // Clear env so each test starts from a known state.
    delete process.env.SDK_ALLOWED_ORIGINS;
  });

  it("merges DB-loaded origins with env entries (after the async refresh)", async () => {
    process.env.SDK_ALLOWED_ORIGINS = "https://env-partner.com";
    const { isAllowedOrigin, setSdkAllowlistDbLoader, _resetCorsCacheForTests } =
      await import("../server/lib/cors.js");
    _resetCorsCacheForTests();

    setSdkAllowlistDbLoader(async () => [
      { origin: "https://db-partner.com" },
      { origin: "*.tenant.app" },
    ]);

    // First call returns env-only synchronously and kicks off the
    // background DB load.
    expect(isAllowedOrigin("https://env-partner.com")).toBe(true);
    expect(isAllowedOrigin("https://db-partner.com")).toBe(false);

    // Wait a microtask cycle so the background promise resolves.
    await new Promise((r) => setTimeout(r, 10));

    expect(isAllowedOrigin("https://db-partner.com")).toBe(true);
    expect(isAllowedOrigin("https://app.tenant.app")).toBe(true);
    expect(isAllowedOrigin("https://env-partner.com")).toBe(true);
    expect(isAllowedOrigin("https://random.com")).toBe(false);

    setSdkAllowlistDbLoader(null);
  });

  it("bumpSdkAllowlistCache forces a re-read so newly added origins take effect", async () => {
    const {
      isAllowedOrigin,
      setSdkAllowlistDbLoader,
      bumpSdkAllowlistCache,
      _resetCorsCacheForTests,
    } = await import("../server/lib/cors.js");
    _resetCorsCacheForTests();

    let loaderRows: Array<{ origin: string }> = [];
    let loaderCallCount = 0;
    setSdkAllowlistDbLoader(async () => {
      loaderCallCount += 1;
      return loaderRows;
    });

    // Prime the cache with empty.
    isAllowedOrigin("https://probe.com");
    await new Promise((r) => setTimeout(r, 10));
    expect(loaderCallCount).toBeGreaterThanOrEqual(1);
    expect(isAllowedOrigin("https://newly-added.com")).toBe(false);

    // Simulate an admin POST: add a row, then bump the cache.
    loaderRows = [{ origin: "https://newly-added.com" }];
    bumpSdkAllowlistCache();

    // Synchronous fall-back is env-only (empty here) but the bump
    // triggers a fresh DB load.
    isAllowedOrigin("https://newly-added.com");
    await new Promise((r) => setTimeout(r, 10));

    expect(isAllowedOrigin("https://newly-added.com")).toBe(true);

    setSdkAllowlistDbLoader(null);
  });

  it("ignores invalid DB rows without breaking valid ones", async () => {
    const {
      isAllowedOrigin,
      setSdkAllowlistDbLoader,
      _resetCorsCacheForTests,
    } = await import("../server/lib/cors.js");
    _resetCorsCacheForTests();

    setSdkAllowlistDbLoader(async () => [
      { origin: "*.com" }, // too broad — must be ignored
      { origin: "" }, // empty — must be ignored
      { origin: "https://good-partner.com" },
    ]);

    isAllowedOrigin("https://probe.com");
    await new Promise((r) => setTimeout(r, 10));

    expect(isAllowedOrigin("https://good-partner.com")).toBe(true);
    expect(isAllowedOrigin("https://anything.com")).toBe(false);

    setSdkAllowlistDbLoader(null);
  });

  it("discards a stale in-flight refresh that finishes after a bump", async () => {
    const {
      isAllowedOrigin,
      setSdkAllowlistDbLoader,
      bumpSdkAllowlistCache,
      _resetCorsCacheForTests,
    } = await import("../server/lib/cors.js");
    _resetCorsCacheForTests();

    // Loader is gated by an external promise so we can interleave a
    // bump between the load starting and the load finishing.
    let releaseFirstLoad: (() => void) | null = null;
    let secondLoadCalled = false;

    setSdkAllowlistDbLoader(async () => {
      if (!releaseFirstLoad) {
        return await new Promise<Array<{ origin: string }>>((resolve) => {
          releaseFirstLoad = () =>
            // Stale data — what was true at the moment this load started.
            resolve([{ origin: "https://stale-data.com" }]);
        });
      }
      secondLoadCalled = true;
      // Fresh data after the bump.
      return [{ origin: "https://fresh-data.com" }];
    });

    // Kicks off the (gated) first refresh.
    isAllowedOrigin("https://probe.com");

    // Wait a tick so the loader has actually been called and is parked.
    await new Promise((r) => setTimeout(r, 10));

    // Admin mutation lands; bump invalidates the cache (and increments
    // the generation so the in-flight load won't be committed).
    bumpSdkAllowlistCache();

    // Now release the stale load. Its result must NOT be cached.
    releaseFirstLoad?.();
    await new Promise((r) => setTimeout(r, 10));

    // Stale data must not have been adopted.
    expect(isAllowedOrigin("https://stale-data.com")).toBe(false);

    // Trigger a fresh load; this one returns the post-bump data.
    isAllowedOrigin("https://probe.com");
    await new Promise((r) => setTimeout(r, 10));

    expect(secondLoadCalled).toBe(true);
    expect(isAllowedOrigin("https://fresh-data.com")).toBe(true);
    expect(isAllowedOrigin("https://stale-data.com")).toBe(false);

    setSdkAllowlistDbLoader(null);
  });

  it("falls back to env-only if the DB loader throws", async () => {
    process.env.SDK_ALLOWED_ORIGINS = "https://env-partner.com";
    const {
      isAllowedOrigin,
      setSdkAllowlistDbLoader,
      _resetCorsCacheForTests,
    } = await import("../server/lib/cors.js");
    _resetCorsCacheForTests();

    setSdkAllowlistDbLoader(async () => {
      throw new Error("db down");
    });

    isAllowedOrigin("https://env-partner.com");
    await new Promise((r) => setTimeout(r, 10));

    expect(isAllowedOrigin("https://env-partner.com")).toBe(true);
    expect(isAllowedOrigin("https://something-else.com")).toBe(false);

    setSdkAllowlistDbLoader(null);
  });
});
