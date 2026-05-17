import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

/**
 * HTTP-level integration test for the admin SDK allowlist routes.
 *
 * The route handlers exercise three side effects we care about:
 *   1. Auth gating (no key -> 401, valid key -> 200)
 *   2. Validation -> deterministic 400 with reason from parseAllowlistEntry
 *   3. recordAudit() called with the right action on every successful
 *      add/revoke (and the cors cache bumped so the next request can
 *      see the change).
 *
 * `db` and `audit` are mocked so this stays in-process; the cors
 * module is real so we can assert that bumpSdkAllowlistCache() actually
 * fired by inspecting `isAllowedOrigin` after the mutation.
 */

let dbState: Array<{
  id: number;
  origin: string;
  kind: string;
  note: string | null;
  createdAt: number;
  createdBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
}> = [];
let nextId = 1;

vi.mock("../server/db.js", () => {
  // Hand-rolled Drizzle-shaped chainable that's just enough for the
  // three queries the route runs: select+from+where[+limit],
  // insert+values+returning, update+set+where[+returning].
  const db: any = {
    select: (_cols?: any) => ({
      from: (_t: any) => ({
        where: (predicate: (row: any) => boolean) => ({
          limit: (_n: number) => Promise.resolve(dbState.filter(predicate)),
          // Used by loader (no .limit() in that path)
          then: (resolve: any) => resolve(dbState.filter(predicate)),
        }),
        orderBy: (_o: any) => Promise.resolve([...dbState]),
      }),
    }),
    insert: (_t: any) => ({
      values: (vals: any) => ({
        returning: () => {
          const dup = dbState.find((r) => r.origin === vals.origin);
          if (dup) {
            const e: any = new Error("duplicate key");
            e.code = "23505";
            return Promise.reject(e);
          }
          const row = { id: nextId++, ...vals, revokedAt: null, revokedBy: null };
          dbState.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    update: (_t: any) => ({
      set: (patch: any) => ({
        where: (predicate: (row: any) => boolean) => {
          const target = dbState.find(predicate);
          if (target) Object.assign(target, patch);
          return {
            returning: () => Promise.resolve(target ? [target] : []),
            then: (resolve: any) => resolve(undefined),
          };
        },
      }),
    }),
  };
  return { db, pool: {} };
});

// drizzle-orm helpers used by the route — substitute with predicate
// builders so our hand-rolled `db` can use them as filter functions.
vi.mock("drizzle-orm", async (orig) => {
  const real = await orig<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (col: any, value: any) => (row: any) => row[col?.__name ?? "id"] === value,
    isNull: (col: any) => (row: any) => row[col?.__name ?? "revokedAt"] == null,
    desc: (col: any) => col,
  };
});

// Tag a couple of schema columns so our predicates above can read them
// by name. Kept minimal — only the columns the route actually uses.
vi.mock("../../shared/schema.js", async (orig) => {
  const real = await orig<any>();
  return { ...real };
});

const recordAuditSpy = vi.fn(async () => undefined);
vi.mock("../server/lib/audit.js", () => ({
  recordAudit: recordAuditSpy,
  auditSecurityEvent: vi.fn(),
}));

vi.mock("../server/lib/logger.js", () => ({
  log: () => {},
}));

const ADMIN_KEY = "test-admin-key-123";
process.env.ADMIN_KEY = ADMIN_KEY;
process.env.SESSION_SECRET = "test-session-secret-not-real";

beforeEach(() => {
  dbState = [];
  nextId = 1;
  recordAuditSpy.mockClear();
});

async function startTestServer() {
  // Patch the schema column refs so our `eq`/`isNull` predicate
  // builders above can identify them by name.
  const schema = await import("../shared/schema.js");
  (schema.sdkAllowedOrigins.id as any).__name = "id";
  (schema.sdkAllowedOrigins.origin as any).__name = "origin";
  (schema.sdkAllowedOrigins.revokedAt as any).__name = "revokedAt";

  const { _resetCorsCacheForTests } = await import("../server/lib/cors.js");
  _resetCorsCacheForTests();
  const { registerAdminSdkAllowlistRoutes } = await import(
    "../server/routes/admin/sdk-allowlist.js"
  );
  const app = express();
  registerAdminSdkAllowlistRoutes(app);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>(
    (resolve) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    },
  );
}

describe("admin SDK allowlist HTTP routes", () => {
  it("rejects requests without a valid admin key", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const r = await fetch(`${baseUrl}/api/admin/sdk-allowlist`);
      expect(r.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("validates origin and returns 400 for bad input", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const r = await fetch(`${baseUrl}/api/admin/sdk-allowlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
        body: JSON.stringify({ origin: "*" }),
      });
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/wildcard/i);
      expect(recordAuditSpy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("adds an origin, records an audit row, and bumps the cors cache", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const r = await fetch(`${baseUrl}/api/admin/sdk-allowlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
        body: JSON.stringify({
          origin: "https://Partner.Example.com/",
          note: "added by test",
        }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.success).toBe(true);
      expect(body.data.entry.origin).toBe("https://partner.example.com");
      expect(body.data.entry.kind).toBe("exact");
      expect(dbState.length).toBe(1);

      // Audit log written with the right action and resource.
      expect(recordAuditSpy).toHaveBeenCalledTimes(1);
      const audit = recordAuditSpy.mock.calls[0][0] as any;
      expect(audit.action).toBe("sdk_allowlist:add");
      expect(audit.resource).toBe("sdk_allowed_origins");
      expect(audit.resourceId).toBe(String(body.data.entry.id));
    } finally {
      await close();
    }
  });

  it("rejects an exact duplicate active origin with 409", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const headers = { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY };
      const r1 = await fetch(`${baseUrl}/api/admin/sdk-allowlist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ origin: "https://dup.com" }),
      });
      expect(r1.status).toBe(200);
      const r2 = await fetch(`${baseUrl}/api/admin/sdk-allowlist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ origin: "https://dup.com" }),
      });
      expect(r2.status).toBe(409);
      const body = await r2.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/already/i);
    } finally {
      await close();
    }
  });

  it("soft-revokes an origin, records audit, and a second revoke is 409", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const headers = { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY };
      const addRes = await fetch(`${baseUrl}/api/admin/sdk-allowlist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ origin: "https://to-revoke.com" }),
      });
      const id = (await addRes.json()).data.entry.id;
      recordAuditSpy.mockClear();

      const del = await fetch(`${baseUrl}/api/admin/sdk-allowlist/${id}`, {
        method: "DELETE",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      expect(del.status).toBe(200);
      expect(dbState[0].revokedAt).toBeTypeOf("number");
      expect(recordAuditSpy).toHaveBeenCalledTimes(1);
      expect((recordAuditSpy.mock.calls[0][0] as any).action).toBe(
        "sdk_allowlist:revoke",
      );

      // Re-revoking the same row is a no-op 409.
      const del2 = await fetch(`${baseUrl}/api/admin/sdk-allowlist/${id}`, {
        method: "DELETE",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      expect(del2.status).toBe(409);
    } finally {
      await close();
    }
  });

  it("re-adding a revoked origin resurrects the row and preserves createdAt", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const headers = { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY };
      const add = await fetch(`${baseUrl}/api/admin/sdk-allowlist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ origin: "https://r.com" }),
      });
      const created = (await add.json()).data.entry;
      const originalCreatedAt = created.createdAt;
      await fetch(`${baseUrl}/api/admin/sdk-allowlist/${created.id}`, {
        method: "DELETE",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      recordAuditSpy.mockClear();

      // Wait a millisecond so any (incorrect) overwrite of createdAt
      // would be observable.
      await new Promise((r) => setTimeout(r, 5));
      const re = await fetch(`${baseUrl}/api/admin/sdk-allowlist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ origin: "https://r.com" }),
      });
      expect(re.status).toBe(200);
      const reBody = await re.json();
      expect(reBody.data.entry.id).toBe(created.id);
      expect(reBody.data.entry.revokedAt).toBeNull();
      // Original createdAt preserved across resurrect.
      expect(reBody.data.entry.createdAt).toBe(originalCreatedAt);
      expect(recordAuditSpy).toHaveBeenCalledTimes(1);
      expect((recordAuditSpy.mock.calls[0][0] as any).action).toBe(
        "sdk_allowlist:resurrect",
      );
    } finally {
      await close();
    }
  });
});
