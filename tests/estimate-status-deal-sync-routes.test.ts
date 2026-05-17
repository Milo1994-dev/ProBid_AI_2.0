import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
type SchemaCol = { __name?: string };

const tables = new Map<unknown, Row[]>();
let serialIds = new Map<unknown, number>();

function getTable(t: unknown): Row[] {
  let list = tables.get(t);
  if (!list) {
    list = [];
    tables.set(t, list);
  }
  return list;
}

function nextSerial(t: unknown): number {
  const cur = (serialIds.get(t) ?? 0) + 1;
  serialIds.set(t, cur);
  return cur;
}

function combinePredicates(parts: Predicate[]): Predicate {
  return (row) => parts.every((p) => p(row));
}

vi.mock("../server/db.js", () => {
  const buildSelect = (cols?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const rows = () => getTable(table);
      const chain = (filter: Predicate | null) => ({
        where: (predicate: Predicate) => {
          const composed = filter ? combinePredicates([filter, predicate]) : predicate;
          return chain(composed);
        },
        orderBy: (..._args: unknown[]) => {
          const filtered = filter ? rows().filter(filter) : [...rows()];
          return Promise.resolve(filtered);
        },
        limit: (n: number) => {
          const filtered = filter ? rows().filter(filter) : [...rows()];
          return Promise.resolve(filtered.slice(0, n));
        },
        then: (resolve: (v: Row[]) => void) => {
          const filtered = filter ? rows().filter(filter) : [...rows()];
          if (cols && typeof cols === "object" && "c" in cols) {
            return resolve([{ c: filtered.length }] as unknown as Row[]);
          }
          if (cols && typeof cols === "object" && "count" in cols) {
            return resolve([{ count: filtered.length }] as unknown as Row[]);
          }
          if (cols && typeof cols === "object" && "max" in cols) {
            const positions = filtered.map((r) => Number(r.position ?? 0));
            return resolve([
              { max: positions.length ? Math.max(...positions) : 0 },
            ] as unknown as Row[]);
          }
          return resolve(filtered);
        },
      });
      return chain(null);
    },
  });

  const db = {
    select: (cols?: Record<string, unknown>) => buildSelect(cols),
    insert: (table: unknown) => ({
      values: (vals: Row | Row[]) => {
        const list = Array.isArray(vals) ? vals : [vals];
        const inserted: Row[] = [];
        for (const v of list) {
          const row: Row = { ...v };
          if (row.id === undefined) row.id = nextSerial(table);
          getTable(table).push(row);
          inserted.push(row);
        }
        return {
          returning: () => Promise.resolve(inserted),
          then: (resolve: (v: undefined) => void) => resolve(undefined),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: (predicate: Predicate) => {
          const list = getTable(table);
          const updated: Row[] = [];
          for (const row of list) {
            if (predicate(row)) {
              Object.assign(row, patch);
              updated.push(row);
            }
          }
          return {
            returning: () => Promise.resolve(updated),
            then: (resolve: (v: undefined) => void) => resolve(undefined),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (predicate: Predicate) => {
        const list = getTable(table);
        for (let i = list.length - 1; i >= 0; i--) {
          if (predicate(list[i])) list.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
  };
  return { db, pool: {} };
});

vi.mock("drizzle-orm", async (orig) => {
  const real = await orig<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (col: SchemaCol, value: unknown) => (row: Row) =>
      row[col?.__name ?? "id"] === value,
    and: (...preds: Predicate[]) => combinePredicates(preds),
    or: (...preds: Predicate[]) => (row: Row) => preds.some((p) => p(row)),
    desc: (col: SchemaCol) => col,
    sql: (..._a: unknown[]) => ({ __sql: true }),
    count: () => "count",
    ilike: () => () => true,
  };
});

vi.mock("../server/lib/automation-engine.js", () => ({
  fireAutomationEvent: vi.fn(async () => undefined),
}));

vi.mock("../server/lib/logger.js", () => ({
  log: () => {},
}));

vi.mock("../server/lib/upload.js", () => ({
  uploadsDir: "/tmp/test-not-used",
  attachmentUpload: {
    single: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  },
  upload: {
    array: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  },
}));

vi.mock("../server/lib/ai.js", () => ({
  generateAIEstimate: vi.fn().mockResolvedValue("AI text"),
  extractStructuredLineItems: vi.fn().mockResolvedValue([]),
}));

vi.mock("../server/lib/analytics.js", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/routes/notifications.js", () => ({
  notifyEstimateReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/lib/email-helpers.js", () => ({
  sendUpsellEmail: vi.fn(),
  scheduleFollowUpEmail: vi.fn(),
}));

vi.mock("../server/replit_integrations/audio/client.js", () => ({
  speechToText: vi.fn(),
  convertWebmToWav: vi.fn(),
}));

vi.mock("../server/lib/api-key-auth.js", () => ({
  requireApiKeyOrSession: () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../server/lib/sdk-session.js", () => ({
  getSdkCsrfToken: vi.fn(() => ""),
}));

vi.mock("../server/lib/user-helpers.js", () => ({
  getSub: vi.fn().mockResolvedValue(undefined),
  isPaidActive: vi.fn().mockReturnValue(false),
  getTotalEstimates: vi.fn().mockResolvedValue(0),
  incrementUsage: vi.fn().mockResolvedValue(1),
  enforcePaywall: vi.fn().mockResolvedValue({ ok: true, tier: "free", used: 0 }),
  consumeSingleCredit: vi.fn().mockResolvedValue(true),
  getDailyUsage: vi.fn().mockResolvedValue(0),
  FREE_ESTIMATES_LIFETIME: 2,
}));

process.env.SESSION_SECRET = "test-session-secret-not-real";

beforeEach(() => {
  tables.clear();
  serialIds = new Map();
});

async function startTestServer(userId: string | null = "user-1") {
  const schema = await import("../shared/schema.js");
  const tag = (table: Record<string, SchemaCol>, names: string[]) => {
    for (const n of names) {
      if (table[n]) table[n].__name = n;
    }
  };
  tag(schema.pipelineStages as unknown as Record<string, SchemaCol>, [
    "id", "userId", "name",
  ]);
  tag(schema.pipelineDeals as unknown as Record<string, SchemaCol>, [
    "id", "userId", "stageId", "estimateId", "leadId",
  ]);
  tag(schema.pipelineActivities as unknown as Record<string, SchemaCol>, [
    "dealId", "userId",
  ]);
  tag(schema.estimates as unknown as Record<string, SchemaCol>, ["id", "userId"]);

  const { registerPipelineRoutes } = await import("../server/routes/pipeline.js");
  const { registerEstimateRoutes } = await import("../server/routes/estimates.js");

  const app = express();
  app.use(express.json());
  // Inject a stub session before route handlers run (or skip when null).
  app.use((req, _res, next) => {
    if (userId) {
      (req as unknown as { session: { uid: string; csrfToken?: string } }).session = {
        uid: userId,
      };
    }
    next();
  });
  registerPipelineRoutes(app);
  registerEstimateRoutes(app);

  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function postJson(baseUrl: string, path: string, body: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function patchJson(baseUrl: string, path: string, body: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function getJson(baseUrl: string, path: string) {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: await r.json() };
}

/**
 * Seed: create the canonical 7 stages, then create a deal in "Lead" linked
 * to a freshly inserted estimate row. Returns the ids/objects we need.
 */
async function seedDealLinkedToEstimate(
  baseUrl: string,
  userId: string,
  opts: { estimateId?: string; estimateStatus?: string } = {},
) {
  const schema = await import("../shared/schema.js");
  const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
  const stages = stagesRes.body.data.stages as Row[];
  const leadStage = stages.find((s) => s.name === "Lead") as Row;

  const create = await postJson(baseUrl, "/api/pipeline/deals", {
    title: "Linked deal",
    stageId: leadStage.id,
    value: 4200,
    clientName: "Linked Client",
  });
  const deal = create.body.data.deal as Row;

  const estimateId = opts.estimateId ?? `est-${(deal.id as string).slice(0, 8)}`;
  getTable(schema.estimates).push({
    id: estimateId,
    userId,
    jobType: "Roofing",
    market: "Local",
    details: null,
    estimateText: "TOTAL ESTIMATE: $4,200",
    name: null,
    source: null,
    clientName: "Linked Client",
    clientEmail: null,
    clientPhone: null,
    status: opts.estimateStatus ?? "sent",
    createdAt: Date.now(),
  });

  // Link the estimate to the deal.
  const dealRow = getTable(schema.pipelineDeals).find((d) => d.id === deal.id) as Row;
  dealRow.estimateId = estimateId;

  return { stages, leadStage, deal, dealRow, estimateId };
}

describe("PATCH /api/estimates/:id/status — task #143", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { baseUrl, close } = await startTestServer(null);
    try {
      const r = await patchJson(baseUrl, "/api/estimates/anything/status", {
        status: "accepted",
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/not authenticated/i);
    } finally {
      await close();
    }
  });

  it("rejects an empty / missing status with 400", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const missing = await patchJson(baseUrl, "/api/estimates/abc/status", {});
      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatch(/status is required/i);

      const blank = await patchJson(baseUrl, "/api/estimates/abc/status", { status: "  " });
      expect(blank.status).toBe(400);
      expect(blank.body.error).toMatch(/status is required/i);
    } finally {
      await close();
    }
  });

  it("rejects an invalid status value with 400", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const bad = await patchJson(baseUrl, "/api/estimates/abc/status", {
        status: "in-progress",
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/sent.*accepted.*rejected/i);
    } finally {
      await close();
    }
  });

  it("returns 404 when the estimate doesn't exist for the caller", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const r = await patchJson(baseUrl, "/api/estimates/missing-id/status", {
        status: "accepted",
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    } finally {
      await close();
    }
  });

  it("flips the estimate to 'accepted' and moves the linked deal to Won", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const schema = await import("../shared/schema.js");
      const { deal, estimateId } = await seedDealLinkedToEstimate(baseUrl, "user-1");

      const r = await patchJson(baseUrl, `/api/estimates/${estimateId}/status`, {
        status: "accepted",
      });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ estimateId, status: "accepted" });

      const est = getTable(schema.estimates).find((e) => e.id === estimateId);
      expect(est?.status).toBe("accepted");

      const dealRow = getTable(schema.pipelineDeals).find((d) => d.id === deal.id) as Row;
      const stages = getTable(schema.pipelineStages);
      const wonStage = stages.find((s) => s.name === "Won") as Row;
      expect(dealRow.stageId).toBe(wonStage.id);
      expect(dealRow.wonAt).toBeTypeOf("number");
      expect(dealRow.lostAt).toBeNull();
      expect(dealRow.probability).toBe(100);
    } finally {
      await close();
    }
  });

  it("flips the estimate to 'rejected' and moves the linked deal to Lost", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const schema = await import("../shared/schema.js");
      const { deal, estimateId } = await seedDealLinkedToEstimate(baseUrl, "user-1");

      const r = await patchJson(baseUrl, `/api/estimates/${estimateId}/status`, {
        status: "REJECTED",
      });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ estimateId, status: "rejected" });

      const dealRow = getTable(schema.pipelineDeals).find((d) => d.id === deal.id) as Row;
      const stages = getTable(schema.pipelineStages);
      const lostStage = stages.find((s) => s.name === "Lost") as Row;
      expect(dealRow.stageId).toBe(lostStage.id);
      expect(dealRow.lostAt).toBeTypeOf("number");
      expect(dealRow.wonAt).toBeNull();
      expect(dealRow.probability).toBe(0);
    } finally {
      await close();
    }
  });

  it("'sent' status updates the estimate but leaves the linked deal alone", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const schema = await import("../shared/schema.js");
      const { deal, leadStage, estimateId } = await seedDealLinkedToEstimate(
        baseUrl,
        "user-1",
        { estimateStatus: "accepted" },
      );

      const r = await patchJson(baseUrl, `/api/estimates/${estimateId}/status`, {
        status: "sent",
      });
      expect(r.status).toBe(200);
      const est = getTable(schema.estimates).find((e) => e.id === estimateId);
      expect(est?.status).toBe("sent");

      // Deal stays where it was (Lead) — only accepted/rejected mirror.
      const dealRow = getTable(schema.pipelineDeals).find((d) => d.id === deal.id) as Row;
      expect(dealRow.stageId).toBe(leadStage.id);
      expect(dealRow.wonAt).toBeFalsy();
      expect(dealRow.lostAt).toBeFalsy();
    } finally {
      await close();
    }
  });

  it("does not affect another user's estimate row with the same id", async () => {
    const { baseUrl, close } = await startTestServer("user-1");
    try {
      const schema = await import("../shared/schema.js");
      const { estimateId } = await seedDealLinkedToEstimate(baseUrl, "user-1");

      // Plant a same-id estimate row owned by a different user.
      getTable(schema.estimates).push({
        id: estimateId,
        userId: "user-2",
        jobType: "Other",
        market: "Other",
        details: null,
        estimateText: "x",
        name: null,
        source: null,
        clientName: "Someone Else",
        clientEmail: null,
        clientPhone: null,
        status: "sent",
        createdAt: Date.now(),
      });

      const r = await patchJson(baseUrl, `/api/estimates/${estimateId}/status`, {
        status: "accepted",
      });
      expect(r.status).toBe(200);

      const rows = getTable(schema.estimates).filter((e) => e.id === estimateId);
      const mine = rows.find((e) => e.userId === "user-1");
      const theirs = rows.find((e) => e.userId === "user-2");
      expect(mine?.status).toBe("accepted");
      expect(theirs?.status).toBe("sent");
    } finally {
      await close();
    }
  });
});

describe("PATCH /api/pipeline/deals/:id Won/Lost mirroring — task #143", () => {
  it("moving the linked deal to Won flips the estimate's status to 'accepted'", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const schema = await import("../shared/schema.js");
      const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
      const stages = stagesRes.body.data.stages as Row[];
      const wonStage = stages.find((s) => s.name === "Won") as Row;
      const { deal, estimateId } = await seedDealLinkedToEstimate(baseUrl, "user-1");

      const r = await patchJson(baseUrl, `/api/pipeline/deals/${deal.id}`, {
        stageId: wonStage.id,
      });
      expect(r.status).toBe(200);
      expect(r.body.data.deal.stageId).toBe(wonStage.id);

      const est = getTable(schema.estimates).find((e) => e.id === estimateId);
      expect(est?.status).toBe("accepted");
    } finally {
      await close();
    }
  });

  it("moving the linked deal to Lost flips the estimate's status to 'rejected'", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const schema = await import("../shared/schema.js");
      const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
      const stages = stagesRes.body.data.stages as Row[];
      const lostStage = stages.find((s) => s.name === "Lost") as Row;
      const { deal, estimateId } = await seedDealLinkedToEstimate(baseUrl, "user-1");

      const r = await patchJson(baseUrl, `/api/pipeline/deals/${deal.id}`, {
        stageId: lostStage.id,
      });
      expect(r.status).toBe(200);
      expect(r.body.data.deal.stageId).toBe(lostStage.id);

      const est = getTable(schema.estimates).find((e) => e.id === estimateId);
      expect(est?.status).toBe("rejected");
    } finally {
      await close();
    }
  });

  it("a deal with NO linked estimate moving to Won/Lost touches no estimate rows", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const schema = await import("../shared/schema.js");

      // Plant an estimate row that is NOT linked to any deal — it must not
      // change when an unrelated deal is won.
      getTable(schema.estimates).push({
        id: "untouched-est",
        userId: "user-1",
        jobType: "Other",
        market: "Other",
        details: null,
        estimateText: "x",
        name: null,
        source: null,
        clientName: "Bystander",
        clientEmail: null,
        clientPhone: null,
        status: "sent",
        createdAt: Date.now(),
      });

      const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
      const stages = stagesRes.body.data.stages as Row[];
      const leadStage = stages.find((s) => s.name === "Lead") as Row;
      const wonStage = stages.find((s) => s.name === "Won") as Row;

      const create = await postJson(baseUrl, "/api/pipeline/deals", {
        title: "Standalone deal",
        stageId: leadStage.id,
        value: 100,
      });
      const deal = create.body.data.deal as Row;
      // Confirm no estimate is linked.
      expect(deal.estimateId).toBeNull();

      const r = await patchJson(baseUrl, `/api/pipeline/deals/${deal.id}`, {
        stageId: wonStage.id,
      });
      expect(r.status).toBe(200);

      const est = getTable(schema.estimates).find((e) => e.id === "untouched-est");
      expect(est?.status).toBe("sent");
    } finally {
      await close();
    }
  });

  it("does not mirror onto another user's estimate that happens to share the same id", async () => {
    const { baseUrl, close } = await startTestServer("user-1");
    try {
      const schema = await import("../shared/schema.js");
      const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
      const stages = stagesRes.body.data.stages as Row[];
      const wonStage = stages.find((s) => s.name === "Won") as Row;

      const { deal, estimateId } = await seedDealLinkedToEstimate(baseUrl, "user-1");

      // Same estimate id under a different user — must NOT be flipped.
      getTable(schema.estimates).push({
        id: estimateId,
        userId: "user-2",
        jobType: "Other",
        market: "Other",
        details: null,
        estimateText: "x",
        name: null,
        source: null,
        clientName: "Other",
        clientEmail: null,
        clientPhone: null,
        status: "sent",
        createdAt: Date.now(),
      });

      const r = await patchJson(baseUrl, `/api/pipeline/deals/${deal.id}`, {
        stageId: wonStage.id,
      });
      expect(r.status).toBe(200);

      const rows = getTable(schema.estimates).filter((e) => e.id === estimateId);
      expect(rows.find((e) => e.userId === "user-1")?.status).toBe("accepted");
      expect(rows.find((e) => e.userId === "user-2")?.status).toBe("sent");
    } finally {
      await close();
    }
  });
});
