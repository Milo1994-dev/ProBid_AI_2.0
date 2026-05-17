import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

const USER_A = "user-aaa-111";
const USER_B = "user-bbb-222";
const FAKE_CSRF = "test-csrf-token";

// In-memory store backing the fake DB. Each entry mimics a saved_line_items row.
const presets: any[] = [];

// Mock drizzle-orm helpers so the route's `where` clauses become inspectable
// JSON-shaped predicates that our fake DB can interpret against `presets`.
vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ op: "eq", field: col?.name ?? col, val }),
  and: (...args: any[]) => ({ op: "and", args }),
  asc: (col: any) => ({ op: "asc", field: col?.name ?? col }),
  desc: (col: any) => ({ op: "desc", field: col?.name ?? col }),
  count: () => ({ op: "count" }),
  isNotNull: (col: any) => ({ op: "isNotNull", field: col?.name ?? col }),
  // The route uses sql`...` only for description LIKE search and ORDER BY
  // direction. We don't attempt to evaluate the SQL fragment — it's an opaque
  // marker that means "no extra row filtering" (the tests don't exercise the
  // ?q= path) or "sort by lastUsedAt DESC NULLS LAST".
  sql: Object.assign(
    (..._args: any[]) => ({ op: "sql" }),
    { raw: (..._args: any[]) => ({ op: "sql" }) },
  ),
}));

// Mock the schema so column references carry the same field names we use in
// the in-memory store. Only the columns the route actually reads matter here.
vi.mock("../shared/schema.js", () => ({
  savedLineItems: {
    id: { name: "id" },
    userId: { name: "userId" },
    description: { name: "description" },
    quantity: { name: "quantity" },
    unitCost: { name: "unitCost" },
    uom: { name: "uom" },
    costType: { name: "costType" },
    tag: { name: "tag" },
    lastUsedAt: { name: "lastUsedAt" },
    createdAt: { name: "createdAt" },
  },
}));

function matchPredicate(row: any, pred: any): boolean {
  if (!pred) return true;
  if (pred.op === "eq") return row[pred.field] === pred.val;
  if (pred.op === "isNotNull")
    return row[pred.field] !== null && row[pred.field] !== undefined;
  if (pred.op === "sql") return true; // opaque SQL fragment — no extra filtering
  if (pred.op === "and") return pred.args.every((a: any) => matchPredicate(row, a));
  return true;
}

function compareByOrders(a: any, b: any, orders: any[]): number {
  for (const order of orders) {
    if (!order || typeof order !== "object") continue;
    if (order.op === "sql") {
      // sql`lastUsedAt DESC NULLS LAST` — emulate that ordering.
      const av = a.lastUsedAt;
      const bv = b.lastUsedAt;
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      if (aNull && bNull) continue;
      if (aNull) return 1;
      if (bNull) return -1;
      if (av !== bv) return bv - av;
      continue;
    }
    const f = order.field;
    if (!f) continue;
    const av = a[f];
    const bv = b[f];
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av ?? "").localeCompare(String(bv ?? ""));
    if (cmp !== 0) return order.op === "desc" ? -cmp : cmp;
  }
  return 0;
}

function makeSelect(columns?: any, distinctOn?: string) {
  const isCount = columns && columns.c && columns.c.op === "count";
  return {
    from: (_table: any) => {
      const buildResult = (filtered: any[]) => {
        if (isCount) {
          const countResult = [{ c: filtered.length }];
          const p: any = Promise.resolve(countResult);
          p.orderBy = () => Promise.resolve(countResult);
          p.limit = () => Promise.resolve(countResult);
          return p;
        }
        let projected = [...filtered];
        if (distinctOn) {
          const seen = new Set<any>();
          projected = projected
            .map((r) => ({ [distinctOn]: r[distinctOn] }))
            .filter((r) => {
              if (seen.has(r[distinctOn])) return false;
              seen.add(r[distinctOn]);
              return true;
            });
        }
        const p: any = Promise.resolve(projected);
        p.orderBy = (...orders: any[]) => {
          const sorted = [...projected].sort((a, b) =>
            compareByOrders(a, b, orders),
          );
          const sortedP: any = Promise.resolve(sorted);
          sortedP.limit = (n: number) => Promise.resolve(sorted.slice(0, n));
          return sortedP;
        };
        p.limit = (n: number) => Promise.resolve(projected.slice(0, n));
        return p;
      };
      return {
        where: (pred: any) => buildResult(presets.filter((r) => matchPredicate(r, pred))),
      };
    },
  };
}

const fakeDb: any = {
  select: (cols?: any) => makeSelect(cols),
  selectDistinct: (cols: any) => {
    // The route only calls selectDistinct({ tag: ... }) — pull the column
    // name from the projection so the same mock can return distinct values.
    const distinctField =
      cols && typeof cols === "object" ? Object.keys(cols)[0] : undefined;
    return makeSelect(undefined, distinctField);
  },
  insert: (_table: any) => ({
    values: (val: any) => {
      presets.push({ ...val });
      return Promise.resolve();
    },
  }),
  update: (_table: any) => ({
    set: (patch: any) => ({
      where: (pred: any) => {
        for (const row of presets) {
          if (matchPredicate(row, pred)) Object.assign(row, patch);
        }
        return Promise.resolve();
      },
    }),
  }),
  delete: (_table: any) => ({
    where: (pred: any) => {
      for (let i = presets.length - 1; i >= 0; i--) {
        if (matchPredicate(presets[i], pred)) presets.splice(i, 1);
      }
      return Promise.resolve();
    },
  }),
};

vi.mock("../server/db.js", () => ({ db: fakeDb }));

const { registerSavedLineItemRoutes } = await import(
  "../server/routes/saved-line-items.js"
);

let server: http.Server;
let baseUrl: string;
let injectSession: { uid?: string; csrfToken?: string } | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (injectSession) req.session = { ...injectSession };
    next();
  });
  registerSavedLineItemRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  injectSession = null;
  presets.length = 0;
});

function asUser(uid: string) {
  injectSession = { uid, csrfToken: FAKE_CSRF };
}

function unauth() {
  injectSession = null;
}

function get(path: string, opts: { auth?: boolean } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { "content-type": "application/json" },
  });
}

function post(body: unknown, opts: { skipCsrf?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.skipCsrf) headers["x-csrf-token"] = FAKE_CSRF;
  return fetch(`${baseUrl}/api/saved-line-items`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function del(id: string, opts: { skipCsrf?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.skipCsrf) headers["x-csrf-token"] = FAKE_CSRF;
  return fetch(`${baseUrl}/api/saved-line-items/${id}`, {
    method: "DELETE",
    headers,
  });
}

function seedPreset(userId: string, overrides: Partial<any> = {}) {
  const id =
    overrides.id ??
    `${userId}-${Math.random().toString(16).slice(2, 10)}-${Math.random()
      .toString(16)
      .slice(2, 6)}-4${Math.random().toString(16).slice(2, 5)}-8${Math.random()
      .toString(16)
      .slice(2, 5)}-${Math.random().toString(16).slice(2, 14)}`;
  const row = {
    id,
    userId,
    description: overrides.description ?? `Preset for ${userId}`,
    quantity: overrides.quantity ?? 1,
    unitCost: overrides.unitCost ?? 100,
    uom: overrides.uom ?? null,
    costType: overrides.costType ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
  };
  presets.push(row);
  return row;
}

const VALID_PAYLOAD = {
  description: "Demolition",
  quantity: 1,
  unitCost: 1500,
  uom: "ea",
  costType: "Labor",
};

// A real-shaped UUID for the :id route param schema (which requires uuid).
const FAKE_UUID = "11111111-1111-4111-8111-111111111111";

describe("Saved line items — auth gating", () => {
  it("GET /api/saved-line-items returns 401 when unauthenticated", async () => {
    unauth();
    const res = await get("/api/saved-line-items");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("POST /api/saved-line-items returns 401 when unauthenticated", async () => {
    unauth();
    const res = await post(VALID_PAYLOAD);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(presets).toHaveLength(0);
  });

  it("DELETE /api/saved-line-items/:id returns 401 when unauthenticated", async () => {
    unauth();
    const res = await del(FAKE_UUID);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe("Saved line items — per-user isolation", () => {
  it("GET only returns presets owned by the calling user", async () => {
    seedPreset(USER_A, { description: "A1" });
    seedPreset(USER_A, { description: "A2" });
    seedPreset(USER_B, { description: "B-secret-cabinets" });
    seedPreset(USER_B, { description: "B-secret-trim" });

    asUser(USER_A);
    const res = await get("/api/saved-line-items");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const descriptions = body.data.presets.map((p: any) => p.description);
    expect(descriptions).toEqual(["A1", "A2"]);
    expect(descriptions.some((d: string) => d.startsWith("B-"))).toBe(false);
  });

  it("DELETE cannot remove a preset owned by another user", async () => {
    const bRow = seedPreset(USER_B, { id: FAKE_UUID, description: "B-private" });
    expect(presets).toHaveLength(1);

    asUser(USER_A);
    const res = await del(bRow.id);
    // The route filters by (id AND userId), so the row simply isn't matched.
    // The endpoint returns success but the row must remain untouched.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // User B's preset is still there.
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({ id: FAKE_UUID, userId: USER_B });

    // And User B can still see it.
    asUser(USER_B);
    const listRes = await get("/api/saved-line-items");
    const listBody = await listRes.json();
    expect(listBody.data.presets).toHaveLength(1);
    expect(listBody.data.presets[0].description).toBe("B-private");
  });

  it("DELETE only removes the row owned by the calling user", async () => {
    const aRow = seedPreset(USER_A, { id: FAKE_UUID, description: "A-mine" });
    seedPreset(USER_B, { description: "B-other" });

    asUser(USER_A);
    const res = await del(aRow.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // A's row is gone, B's row is untouched.
    expect(presets).toHaveLength(1);
    expect(presets[0].userId).toBe(USER_B);
    expect(presets[0].description).toBe("B-other");
  });
});

describe("Saved line items — POST validation", () => {
  beforeEach(() => {
    asUser(USER_A);
  });

  it("creates a preset on a valid payload and scopes it to the caller", async () => {
    const res = await post(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.preset).toMatchObject({
      description: "Demolition",
      quantity: 1,
      unitCost: 1500,
      uom: "ea",
      costType: "Labor",
    });
    expect(presets).toHaveLength(1);
    expect(presets[0].userId).toBe(USER_A);
  });

  it("rejects a missing description", async () => {
    const { description: _omit, ...rest } = VALID_PAYLOAD;
    const res = await post(rest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(presets).toHaveLength(0);
  });

  it("rejects an empty (whitespace-only) description", async () => {
    const res = await post({ ...VALID_PAYLOAD, description: "   " });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/description/i);
  });

  it("rejects a description that exceeds the max length", async () => {
    const tooLong = "x".repeat(501);
    const res = await post({ ...VALID_PAYLOAD, description: tooLong });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("rejects a missing quantity", async () => {
    const { quantity: _omit, ...rest } = VALID_PAYLOAD;
    const res = await post(rest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("rejects a non-positive quantity", async () => {
    const res = await post({ ...VALID_PAYLOAD, quantity: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/quantity/i);
  });

  it("rejects a negative quantity", async () => {
    const res = await post({ ...VALID_PAYLOAD, quantity: -1 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/quantity/i);
  });

  it("rejects a non-finite quantity", async () => {
    const res = await post({ ...VALID_PAYLOAD, quantity: Number.POSITIVE_INFINITY });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("rejects a missing unit cost", async () => {
    const { unitCost: _omit, ...rest } = VALID_PAYLOAD;
    const res = await post(rest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("rejects a negative unit cost", async () => {
    const res = await post({ ...VALID_PAYLOAD, unitCost: -0.01 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/unit cost/i);
  });

  it("accepts a unit cost of 0 (free / placeholder line items)", async () => {
    const res = await post({ ...VALID_PAYLOAD, unitCost: 0 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.preset.unitCost).toBe(0);
  });
});

describe("Saved line items — per-user cap", () => {
  it("enforces the 200-preset cap per user", async () => {
    // Seed exactly 200 presets for User A; one more should be rejected.
    for (let i = 0; i < 200; i++) {
      seedPreset(USER_A, { description: `A-preset-${i}` });
    }
    expect(presets.filter((p) => p.userId === USER_A)).toHaveLength(200);

    asUser(USER_A);
    const res = await post({ ...VALID_PAYLOAD, description: "one too many" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/200/);
    // Nothing was inserted.
    expect(presets.filter((p) => p.userId === USER_A)).toHaveLength(200);
  });

  it("the cap is per-user — User B can still save when User A is at the cap", async () => {
    for (let i = 0; i < 200; i++) {
      seedPreset(USER_A, { description: `A-preset-${i}` });
    }

    asUser(USER_B);
    const res = await post({ ...VALID_PAYLOAD, description: "B fresh preset" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(presets.filter((p) => p.userId === USER_B)).toHaveLength(1);
  });
});
