import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import type { AddressInfo } from "net";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
type SchemaCol = { __name?: string };

const tables = new Map<unknown, Row[]>();
let serialIds = new Map<unknown, number>();

const TEST_UPLOADS_DIR = path.join(os.tmpdir(), "probid-pipeline-test-uploads");

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
            return resolve([{ c: filtered.length }]);
          }
          if (cols && typeof cols === "object" && "count" in cols) {
            return resolve([{ count: filtered.length }]);
          }
          if (cols && typeof cols === "object" && "max" in cols) {
            const positions = filtered.map((r) => Number(r.position ?? 0));
            return resolve([{ max: positions.length ? Math.max(...positions) : 0 }]);
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
    desc: (col: SchemaCol) => col,
    sql: (..._a: unknown[]) => ({ __sql: true }),
    count: () => "count",
  };
});

vi.mock("../server/lib/automation-engine.js", () => ({
  fireAutomationEvent: vi.fn(async () => undefined),
}));

vi.mock("../server/lib/logger.js", () => ({
  log: () => {},
}));

vi.mock("../server/lib/upload.js", () => ({
  uploadsDir: TEST_UPLOADS_DIR,
  attachmentUpload: {
    single: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const sourcePath = req.headers["x-test-source-path"];
      if (typeof sourcePath === "string" && sourcePath.length > 0) {
        const originalName = (req.headers["x-test-file-name"] as string) || "file.pdf";
        const mimetype = (req.headers["x-test-file-type"] as string) || "application/pdf";
        const size = Number(req.headers["x-test-file-size"] ?? 0);
        (req as unknown as { file: Record<string, unknown> }).file = {
          path: sourcePath,
          originalname: originalName,
          mimetype,
          size,
        };
      }
      next();
    },
  },
  upload: {
    array: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  },
}));

process.env.SESSION_SECRET = "test-session-secret-not-real";

beforeEach(() => {
  tables.clear();
  serialIds = new Map();
  fs.rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_UPLOADS_DIR, { recursive: true });
});

async function startTestServer(userId = "user-1") {
  const schema = await import("../shared/schema.js");
  const tag = (table: Record<string, SchemaCol>, names: string[]) => {
    for (const n of names) {
      if (table[n]) table[n].__name = n;
    }
  };
  tag(schema.pipelineStages as unknown as Record<string, SchemaCol>, ["id", "userId", "name"]);
  tag(schema.pipelineDeals as unknown as Record<string, SchemaCol>, ["id", "userId", "stageId"]);
  tag(schema.pipelineActivities as unknown as Record<string, SchemaCol>, ["dealId", "userId"]);
  tag(schema.pipelineDealAttachments as unknown as Record<string, SchemaCol>, [
    "id", "dealId", "userId",
  ]);
  tag(schema.estimates as unknown as Record<string, SchemaCol>, ["id", "userId"]);

  const { registerPipelineRoutes } = await import("../server/routes/pipeline.js");
  const app = express();
  app.use(express.json());
  // Inject a stub session before the route handlers run.
  app.use((req, _res, next) => {
    (req as unknown as { session: { uid: string } }).session = { uid: userId };
    next();
  });
  registerPipelineRoutes(app);
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

async function seedStagesAndDeal(baseUrl: string, dealOverrides: Row = {}) {
  const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
  const stages = stagesRes.body.data.stages as Row[];
  const leadStage = stages.find((s) => s.name === "Lead") as Row;
  const create = await postJson(baseUrl, "/api/pipeline/deals", {
    title: "Sample deal",
    stageId: leadStage.id,
    value: 5000,
    clientName: "Jane",
    clientEmail: "jane@example.com",
    clientPhone: "555",
    projectAddress: "123 Main",
    projectType: "Roofing",
    priority: "high",
    ...dealOverrides,
  });
  return { stages, leadStage, deal: create.body.data.deal as Row };
}

describe("pipeline routes — task #108", () => {
  it("POST rejects any present-but-invalid priority with 400 (matches PATCH); defaults to medium only when key is omitted", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
      expect(stagesRes.status).toBe(200);
      expect(stagesRes.body.data.stages).toHaveLength(7);
      const leadStage = (stagesRes.body.data.stages as Row[]).find(
        (s) => s.name === "Lead",
      ) as Row;

      const invalidValues: unknown[] = ["extreme", "", null, "URGENT"];
      for (const priority of invalidValues) {
        const bad = await postJson(baseUrl, "/api/pipeline/deals", {
          title: `Bad priority: ${JSON.stringify(priority)}`,
          stageId: leadStage.id,
          priority,
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/low.*medium.*high/i);
      }

      const followUpMs = Date.now() + 86_400_000;
      const ok = await postJson(baseUrl, "/api/pipeline/deals", {
        title: "Default priority deal",
        stageId: leadStage.id,
        value: 1234,
        followUpDate: followUpMs,
        expectedStartDate: followUpMs + 1000,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data.deal.priority).toBe("medium");
      expect(ok.body.data.deal.followUpDate).toBe(followUpMs);
      expect(ok.body.data.deal.expectedStartDate).toBe(followUpMs + 1000);

      for (const p of ["low", "MEDIUM", "high"]) {
        const r = await postJson(baseUrl, "/api/pipeline/deals", {
          title: `Valid priority ${p}`,
          stageId: leadStage.id,
          priority: p,
        });
        expect(r.status).toBe(200);
        expect(r.body.data.deal.priority).toBe(p.toLowerCase());
      }
    } finally {
      await close();
    }
  });

  it("PATCH rejects an invalid priority with 400 and accepts a valid one", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const { deal } = await seedStagesAndDeal(baseUrl);

      const bad = await patchJson(
        baseUrl,
        `/api/pipeline/deals/${deal.id}`,
        { priority: "urgent" },
      );
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/low.*medium.*high/i);

      const good = await patchJson(
        baseUrl,
        `/api/pipeline/deals/${deal.id}`,
        { priority: "low" },
      );
      expect(good.status).toBe(200);
      expect(good.body.data.deal.priority).toBe("low");
    } finally {
      await close();
    }
  });

  it("PATCH normalizes followUpDate: epoch ms passes through, null clears, garbage becomes null", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const { deal } = await seedStagesAndDeal(baseUrl, {
        followUpDate: Date.now(),
      });

      const setMs = Date.now() + 7 * 86_400_000;
      const r1 = await patchJson(baseUrl, `/api/pipeline/deals/${deal.id}`, {
        followUpDate: setMs,
      });
      expect(r1.body.data.deal.followUpDate).toBe(setMs);

      const r2 = await patchJson(baseUrl, `/api/pipeline/deals/${deal.id}`, {
        followUpDate: null,
      });
      expect(r2.body.data.deal.followUpDate).toBeNull();

      const r3 = await patchJson(baseUrl, `/api/pipeline/deals/${deal.id}`, {
        followUpDate: "not-a-date",
      });
      expect(r3.body.data.deal.followUpDate).toBeNull();
    } finally {
      await close();
    }
  });

  it("convert-to-estimate creates an estimate row, links estimateId on the deal, and logs an activity", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const { deal } = await seedStagesAndDeal(baseUrl, {
        description: "Two chimneys",
        nextAction: "Confirm scope",
      });

      const convert = await postJson(
        baseUrl,
        `/api/pipeline/deals/${deal.id}/convert-to-estimate`,
        {},
      );
      expect(convert.status).toBe(200);
      const estimateId = convert.body.data.estimateId;
      expect(typeof estimateId).toBe("string");
      expect(estimateId.length).toBeGreaterThan(0);

      const schema = await import("../shared/schema.js");
      const estimateRows = getTable(schema.estimates);
      expect(estimateRows).toHaveLength(1);
      const est = estimateRows[0];
      expect(est.id).toBe(estimateId);
      expect(est.userId).toBe("user-1");
      expect(est.clientName).toBe("Jane");
      expect(est.clientEmail).toBe("jane@example.com");
      expect(est.clientPhone).toBe("555");
      expect(est.jobType).toBe("Roofing");
      expect(est.market).toBe("123 Main");
      expect(est.estimateText).toBe("");
      expect(typeof est.createdAt).toBe("number");
      expect(String(est.details)).toContain("Two chimneys");
      expect(String(est.details)).toContain("Next action: Confirm scope");
      expect(String(est.details)).toContain("Estimated value: $5000");

      const dealRows = getTable(schema.pipelineDeals);
      expect(dealRows[0].estimateId).toBe(estimateId);

      const acts = getTable(schema.pipelineActivities).filter(
        (a) => a.dealId === deal.id && a.type === "converted_to_estimate",
      );
      expect(acts).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("analytics returns followUpToday and followUpOverdue based on follow-up dates of active deals", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const stagesRes = await getJson(baseUrl, "/api/pipeline/stages");
      const stages = stagesRes.body.data.stages as Row[];
      const leadStage = stages.find((s) => s.name === "Lead") as Row;
      const wonStage = stages.find((s) => s.name === "Won") as Row;
      const lostStage = stages.find((s) => s.name === "Lost") as Row;

      const todayNoon = (() => {
        const d = new Date();
        d.setHours(12, 0, 0, 0);
        return d.getTime();
      })();
      const yesterdayNoon = todayNoon - 86_400_000;
      const tomorrowNoon = todayNoon + 86_400_000;

      const due1 = await postJson(baseUrl, "/api/pipeline/deals", {
        title: "Due today A",
        stageId: leadStage.id,
        followUpDate: todayNoon,
      });
      const dueWillWin = await postJson(baseUrl, "/api/pipeline/deals", {
        title: "Due today B (will win)",
        stageId: leadStage.id,
        followUpDate: todayNoon,
      });
      const overdueWillLose = await postJson(baseUrl, "/api/pipeline/deals", {
        title: "Overdue (will lose)",
        stageId: leadStage.id,
        followUpDate: yesterdayNoon,
      });
      await postJson(baseUrl, "/api/pipeline/deals", {
        title: "Overdue active",
        stageId: leadStage.id,
        followUpDate: yesterdayNoon,
      });
      await postJson(baseUrl, "/api/pipeline/deals", {
        title: "Future",
        stageId: leadStage.id,
        followUpDate: tomorrowNoon,
      });

      await patchJson(baseUrl, `/api/pipeline/deals/${dueWillWin.body.data.deal.id}`, {
        stageId: wonStage.id,
      });
      await patchJson(
        baseUrl,
        `/api/pipeline/deals/${overdueWillLose.body.data.deal.id}`,
        { stageId: lostStage.id },
      );
      expect(due1.body.data.deal.id).toBeTruthy();

      const a = await getJson(baseUrl, "/api/pipeline/analytics");
      expect(a.status).toBe(200);
      expect(a.body.data.followUpToday).toBe(1);
      expect(a.body.data.followUpOverdue).toBe(1);
    } finally {
      await close();
    }
  });

  it("attachments: upload moves the file into uploadsDir, list returns it, delete removes file + row + writes activity", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const { deal } = await seedStagesAndDeal(baseUrl);

      const listEmpty = await getJson(
        baseUrl,
        `/api/pipeline/deals/${deal.id}/attachments`,
      );
      expect(listEmpty.status).toBe(200);
      expect(listEmpty.body.data.attachments).toEqual([]);

      const sourcePath = path.join(
        os.tmpdir(),
        `probid-pipeline-test-src-${crypto.randomUUID()}`,
      );
      const fileContents = "hello pdf";
      fs.writeFileSync(sourcePath, fileContents);

      const upload = await fetch(
        `${baseUrl}/api/pipeline/deals/${deal.id}/attachments`,
        {
          method: "POST",
          headers: {
            "x-test-source-path": sourcePath,
            "x-test-file-name": "scope.pdf",
            "x-test-file-type": "application/pdf",
            "x-test-file-size": String(fileContents.length),
          },
        },
      );
      expect(upload.status).toBe(200);
      const uploadBody = await upload.json();
      const attachmentId = uploadBody.data.attachment.id as string;
      expect(attachmentId).toBeTruthy();
      expect(uploadBody.data.attachment.fileName).toBe("scope.pdf");
      expect(uploadBody.data.attachment.fileType).toBe("application/pdf");
      expect(uploadBody.data.attachment.sizeBytes).toBe(fileContents.length);
      expect(uploadBody.data.attachment.fileUrl).toBe(
        `/api/pipeline/attachments/${attachmentId}/download`,
      );

      expect(fs.existsSync(sourcePath)).toBe(false);
      const finalPath = path.join(TEST_UPLOADS_DIR, attachmentId);
      expect(fs.existsSync(finalPath)).toBe(true);
      expect(fs.readFileSync(finalPath, "utf8")).toBe(fileContents);

      const schema = await import("../shared/schema.js");
      const acts = getTable(schema.pipelineActivities).filter(
        (a) => a.dealId === deal.id && a.type === "attachment_added",
      );
      expect(acts).toHaveLength(1);

      const list = await getJson(
        baseUrl,
        `/api/pipeline/deals/${deal.id}/attachments`,
      );
      expect(list.status).toBe(200);
      expect(list.body.data.attachments).toHaveLength(1);
      expect(list.body.data.attachments[0].id).toBe(attachmentId);

      const noFile = await fetch(
        `${baseUrl}/api/pipeline/deals/${deal.id}/attachments`,
        { method: "POST" },
      );
      expect(noFile.status).toBe(400);
      expect((await noFile.json()).error).toMatch(/no file/i);

      const del = await fetch(
        `${baseUrl}/api/pipeline/attachments/${attachmentId}`,
        { method: "DELETE" },
      );
      expect(del.status).toBe(200);
      expect(getTable(schema.pipelineDealAttachments)).toHaveLength(0);
      expect(fs.existsSync(finalPath)).toBe(false);
      const removedActs = getTable(schema.pipelineActivities).filter(
        (a) => a.dealId === deal.id && a.type === "attachment_removed",
      );
      expect(removedActs).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("reset-canonical refuses while deals exist; succeeds and seeds 7 stages when empty", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const { deal } = await seedStagesAndDeal(baseUrl);

      const refused = await postJson(
        baseUrl,
        "/api/pipeline/stages/reset-canonical",
        {},
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/deals exist/i);

      const del = await fetch(`${baseUrl}/api/pipeline/deals/${deal.id}`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);

      const ok = await postJson(
        baseUrl,
        "/api/pipeline/stages/reset-canonical",
        {},
      );
      expect(ok.status).toBe(200);
      expect(ok.body.data.stages).toHaveLength(7);
      const names = (ok.body.data.stages as Row[]).map((s) => s.name);
      expect(names).toEqual([
        "Lead",
        "Contacted",
        "Site Visit Scheduled",
        "Estimate Sent",
        "Negotiation",
        "Won",
        "Lost",
      ]);
    } finally {
      await close();
    }
  });
});
