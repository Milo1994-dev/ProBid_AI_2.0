import { describe, it, expect, vi, beforeEach } from "vitest";

const logSpy = vi.hoisted(() => vi.fn());
const recordDuplicateDealRaceSpy = vi.hoisted(() => vi.fn());

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
  return { db, pool: {}, recordDuplicateDealRace: recordDuplicateDealRaceSpy };
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

const fireAutomationEventMock = vi.fn(async () => undefined);
vi.mock("../server/lib/automation-engine.js", () => ({
  fireAutomationEvent: fireAutomationEventMock,
}));

vi.mock("../server/lib/logger.js", () => ({
  log: logSpy,
}));

beforeEach(() => {
  tables.clear();
  serialIds = new Map();
  fireAutomationEventMock.mockClear();
  logSpy.mockClear();
  recordDuplicateDealRaceSpy.mockClear();
});

async function loadModules() {
  const schema = await import("../shared/schema.js");
  const tag = (table: Record<string, SchemaCol>, names: string[]) => {
    for (const n of names) {
      if (table[n]) table[n].__name = n;
    }
  };
  tag(schema.pipelineStages as unknown as Record<string, SchemaCol>, ["id", "userId", "name"]);
  tag(schema.pipelineDeals as unknown as Record<string, SchemaCol>, [
    "id",
    "userId",
    "stageId",
    "estimateId",
    "leadId",
  ]);
  tag(schema.pipelineActivities as unknown as Record<string, SchemaCol>, ["dealId", "userId"]);
  tag(schema.estimates as unknown as Record<string, SchemaCol>, ["id", "userId"]);
  const sync = await import("../server/lib/pipeline-sync.js");
  return { schema, sync };
}

function dealsFor(schema: Awaited<ReturnType<typeof loadModules>>["schema"], userId: string) {
  return getTable(schema.pipelineDeals).filter((d) => d.userId === userId);
}

function stageNameOf(
  schema: Awaited<ReturnType<typeof loadModules>>["schema"],
  stageId: unknown,
): string | null {
  const s = getTable(schema.pipelineStages).find((row) => row.id === stageId);
  return (s?.name as string) ?? null;
}

describe("pipeline-sync — task #118 auto-populate from leads & estimates", () => {
  it("(a) creating a lead creates exactly one deal in the Lead stage", async () => {
    const { schema, sync } = await loadModules();
    await sync.syncDealForNewLead({
      userId: "user-1",
      leadId: "lead-A",
      source: {
        title: "Roofing job",
        clientName: "Alice",
        clientEmail: "alice@example.com",
        projectType: "Roofing",
      },
    });

    const deals = dealsFor(schema, "user-1");
    expect(deals).toHaveLength(1);
    expect(deals[0].leadId).toBe("lead-A");
    expect(deals[0].estimateId).toBeNull();
    expect(stageNameOf(schema, deals[0].stageId)).toBe("Lead");
    expect(deals[0].clientName).toBe("Alice");
    expect(deals[0].clientEmail).toBe("alice@example.com");
  });

  it("(b) estimate-from-lead reuses the existing deal and moves it to Estimate Sent (no duplicate)", async () => {
    const { schema, sync } = await loadModules();
    await sync.syncDealForNewLead({
      userId: "user-1",
      leadId: "lead-A",
      source: { clientName: "Alice", projectType: "Roofing" },
    });
    expect(dealsFor(schema, "user-1")).toHaveLength(1);

    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-1",
      leadId: "lead-A",
      source: {
        title: "Roofing replacement",
        clientName: "Alice",
        projectType: "Roofing",
        value: 8500,
      },
    });

    const deals = dealsFor(schema, "user-1");
    expect(deals).toHaveLength(1);
    expect(deals[0].leadId).toBe("lead-A");
    expect(deals[0].estimateId).toBe("est-1");
    expect(deals[0].value).toBe(8500);
    expect(stageNameOf(schema, deals[0].stageId)).toBe("Estimate Sent");

    const stageEvents = fireAutomationEventMock.mock.calls.filter(
      (c) => c[1] === "deal_stage_changed",
    );
    expect(stageEvents.length).toBeGreaterThanOrEqual(1);
    const last = stageEvents[stageEvents.length - 1];
    expect((last[2] as { toStage: string }).toStage).toBe("Estimate Sent");
  });

  it("(c) standalone estimate (no prior lead-deal) creates one deal in Estimate Sent", async () => {
    const { schema, sync } = await loadModules();
    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-2",
      leadId: null,
      source: {
        title: "Concrete pour",
        clientName: "Bob",
        projectType: "Concrete",
        value: 4200,
      },
    });

    const deals = dealsFor(schema, "user-1");
    expect(deals).toHaveLength(1);
    expect(deals[0].estimateId).toBe("est-2");
    expect(stageNameOf(schema, deals[0].stageId)).toBe("Estimate Sent");
    expect(deals[0].value).toBe(4200);
  });

  it("(d) marking the estimate accepted moves the linked deal to Won and fires deal_won", async () => {
    const { schema, sync } = await loadModules();
    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-3",
      leadId: null,
      source: { title: "Painting", clientName: "Carol", value: 1200 },
    });
    fireAutomationEventMock.mockClear();

    await sync.syncDealStageFromEstimateStatus({
      userId: "user-1",
      estimateId: "est-3",
      status: "accepted",
    });

    const deals = dealsFor(schema, "user-1");
    expect(deals).toHaveLength(1);
    expect(stageNameOf(schema, deals[0].stageId)).toBe("Won");
    expect(deals[0].wonAt).toBeTypeOf("number");
    expect(deals[0].probability).toBe(100);

    const triggers = fireAutomationEventMock.mock.calls.map((c) => c[1]);
    expect(triggers).toContain("deal_stage_changed");
    expect(triggers).toContain("deal_won");
    expect(triggers).not.toContain("deal_lost");
  });

  it("(e) marking the deal Lost flips the estimate's status to rejected", async () => {
    const { schema, sync } = await loadModules();
    // Seed an estimate row directly (no real /api/estimates here).
    getTable(schema.estimates).push({
      id: "est-4",
      userId: "user-1",
      jobType: "Demo",
      market: "N/A",
      details: null,
      estimateText: "...",
      name: null,
      source: null,
      clientName: "Dave",
      clientEmail: null,
      clientPhone: null,
      status: "sent",
      createdAt: Date.now(),
    });
    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-4",
      leadId: null,
      source: { title: "Demo job", clientName: "Dave", value: 999 },
    });

    await sync.syncEstimateStatusFromDealStage({
      userId: "user-1",
      estimateId: "est-4",
      isWon: false,
      isLost: true,
    });

    const est = getTable(schema.estimates).find((e) => e.id === "est-4");
    expect(est?.status).toBe("rejected");
  });

  it("reversing Won -> Lost (or back) clears the opposite terminal timestamp so analytics don't double-count", async () => {
    const { schema, sync } = await loadModules();
    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-flip",
      leadId: null,
      source: { title: "Flip", clientName: "Flip", value: 100 },
    });

    // First mark accepted -> Won
    await sync.syncDealStageFromEstimateStatus({
      userId: "user-1",
      estimateId: "est-flip",
      status: "accepted",
    });
    let deal = dealsFor(schema, "user-1")[0];
    expect(deal.wonAt).toBeTypeOf("number");
    expect(deal.lostAt).toBeNull();

    // Then reverse to rejected -> Lost
    await sync.syncDealStageFromEstimateStatus({
      userId: "user-1",
      estimateId: "est-flip",
      status: "rejected",
    });
    deal = dealsFor(schema, "user-1")[0];
    expect(deal.lostAt).toBeTypeOf("number");
    expect(deal.wonAt).toBeNull();
  });

  it("(e2) deal Won flips the estimate's status to accepted", async () => {
    const { schema, sync } = await loadModules();
    getTable(schema.estimates).push({
      id: "est-5",
      userId: "user-1",
      jobType: "Demo",
      market: "N/A",
      details: null,
      estimateText: "...",
      name: null,
      source: null,
      clientName: "Eve",
      clientEmail: null,
      clientPhone: null,
      status: "sent",
      createdAt: Date.now(),
    });
    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-5",
      leadId: null,
      source: { title: "Demo", clientName: "Eve", value: 100 },
    });

    await sync.syncEstimateStatusFromDealStage({
      userId: "user-1",
      estimateId: "est-5",
      isWon: true,
      isLost: false,
    });

    const est = getTable(schema.estimates).find((e) => e.id === "est-5");
    expect(est?.status).toBe("accepted");
  });

  it("(f) per-user scoped: user A's lead never creates a deal for user B", async () => {
    const { schema, sync } = await loadModules();

    await sync.syncDealForNewLead({
      userId: "user-A",
      leadId: "lead-shared-id",
      source: { clientName: "ClientA" },
    });
    await sync.syncDealForNewLead({
      userId: "user-B",
      leadId: "lead-shared-id",
      source: { clientName: "ClientB" },
    });

    expect(dealsFor(schema, "user-A")).toHaveLength(1);
    expect(dealsFor(schema, "user-B")).toHaveLength(1);
    expect(dealsFor(schema, "user-A")[0].clientName).toBe("ClientA");
    expect(dealsFor(schema, "user-B")[0].clientName).toBe("ClientB");

    // Stages are scoped per user too.
    const stagesA = getTable(schema.pipelineStages).filter((s) => s.userId === "user-A");
    const stagesB = getTable(schema.pipelineStages).filter((s) => s.userId === "user-B");
    expect(stagesA.length).toBe(7);
    expect(stagesB.length).toBe(7);
    expect(stagesA[0].id).not.toBe(stagesB[0].id);

    // syncing user-A's lead status to Won must NOT touch user-B's row.
    getTable(schema.estimates).push({
      id: "shared-est",
      userId: "user-A",
      jobType: "x",
      market: "N/A",
      details: null,
      estimateText: "x",
      name: null,
      source: null,
      clientName: null,
      clientEmail: null,
      clientPhone: null,
      status: "sent",
      createdAt: Date.now(),
    });
    getTable(schema.estimates).push({
      id: "shared-est",
      userId: "user-B",
      jobType: "x",
      market: "N/A",
      details: null,
      estimateText: "x",
      name: null,
      source: null,
      clientName: null,
      clientEmail: null,
      clientPhone: null,
      status: "sent",
      createdAt: Date.now(),
    });
    await sync.syncEstimateStatusFromDealStage({
      userId: "user-A",
      estimateId: "shared-est",
      isWon: true,
      isLost: false,
    });
    const ests = getTable(schema.estimates).filter((e) => e.id === "shared-est");
    const a = ests.find((e) => e.userId === "user-A");
    const b = ests.find((e) => e.userId === "user-B");
    expect(a?.status).toBe("accepted");
    expect(b?.status).toBe("sent");
  });

  it("convert-to-estimate flow: pre-existing deal with NO leadId is found by estimateId and moved to Estimate Sent (no duplicate)", async () => {
    const { schema, sync } = await loadModules();

    // Seed canonical stages so we can put the deal directly into "Lead".
    await sync.syncDealForNewLead({
      userId: "user-1",
      leadId: "warm-up",
      source: { clientName: "warmup" },
    });
    // Forget that lead-deal — it's just here to seed the stages table.
    const stages = getTable(schema.pipelineStages).filter((s) => s.userId === "user-1");
    const leadStage = stages.find((s) => s.name === "Lead")!;

    // Create an orphan deal manually (e.g. user typed it into the board with
    // no associated lead or estimate).
    getTable(schema.pipelineDeals).push({
      id: "deal-orphan",
      userId: "user-1",
      stageId: leadStage.id,
      title: "Orphan deal",
      value: 1500,
      clientName: "Frank",
      clientEmail: null,
      clientPhone: null,
      description: null,
      projectAddress: null,
      projectType: null,
      priority: "medium",
      nextAction: null,
      expectedStartDate: null,
      followUpDate: null,
      estimateId: null,
      leadId: null,
      probability: 50,
      expectedCloseDate: null,
      wonAt: null,
      lostAt: null,
      lostReason: null,
      position: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Mimic what convert-to-estimate does: link the estimate first, then run
    // the auto-sync helper.
    const orphan = getTable(schema.pipelineDeals).find((d) => d.id === "deal-orphan")!;
    orphan.estimateId = "est-conv";

    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-conv",
      leadId: null,
      source: { title: "Orphan deal", clientName: "Frank", value: 1500 },
    });

    const dealsForUser = dealsFor(schema, "user-1").filter((d) => d.id === "deal-orphan");
    expect(dealsForUser).toHaveLength(1);
    expect(dealsForUser[0].estimateId).toBe("est-conv");
    expect(stageNameOf(schema, dealsForUser[0].stageId)).toBe("Estimate Sent");

    // No new deal row was created for the same estimate.
    const allWithEst = getTable(schema.pipelineDeals).filter(
      (d) => d.estimateId === "est-conv",
    );
    expect(allWithEst).toHaveLength(1);
  });

  it("parseEstimateTotalValue extracts the high end of an AI-text total range", async () => {
    const { sync } = await loadModules();
    const txt = `Disclaimer: starting point.\n\nLABOR: $2,000\nMATERIALS: $1,500\nSubtotal: $3,500\nTOTAL ESTIMATE: $5,000 - $8,500\n`;
    expect(sync.parseEstimateTotalValue(txt)).toBe(8500);
    expect(sync.parseEstimateTotalValue(null)).toBeNull();
    expect(sync.parseEstimateTotalValue("no money here")).toBeNull();
    expect(sync.parseEstimateTotalValue("Total: $1,250.50")).toBe(1250.5);
  });

  it("idempotent: repeated calls for the same estimate do not duplicate the deal", async () => {
    const { schema, sync } = await loadModules();
    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-dup",
      leadId: null,
      source: { title: "Dup", value: 500 },
    });
    await sync.syncDealForNewEstimate({
      userId: "user-1",
      estimateId: "est-dup",
      leadId: null,
      source: { title: "Dup", value: 500 },
    });
    expect(dealsFor(schema, "user-1")).toHaveLength(1);
  });

  it("(task #142) concurrent estimate insert: simulated 23505 from the race recovers and updates the winner", async () => {
    const { schema, sync } = await loadModules();
    const dbMod = await import("../server/db.js");
    const realInsert = dbMod.db.insert.bind(dbMod.db);

    // Seed canonical stages for this user via a throwaway lead.
    await sync.syncDealForNewLead({
      userId: "user-1",
      leadId: "warm-up",
      source: { clientName: "warmup" },
    });
    const winnerId = "winner-deal-1";

    // Patch insert: the FIRST insert into pipelineDeals for est-race-1 simulates
    // the race window — a competing process inserted the winning row between
    // our findDealByEstimateId() and our insert, so we (the loser) get 23505.
    let raceFired = false;
    (dbMod.db as unknown as { insert: typeof realInsert }).insert = ((
      table: unknown,
    ) => {
      const orig = realInsert(table as never);
      if (table === schema.pipelineDeals && !raceFired) {
        return {
          values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
            const list = Array.isArray(vals) ? vals : [vals];
            const targetsRace = list.some((v) => v.estimateId === "est-race-1");
            if (targetsRace) {
              raceFired = true;
              const stages = getTable(schema.pipelineStages).filter(
                (s) => s.userId === "user-1",
              );
              const estStage = stages.find((s) => s.name === "Estimate Sent")!;
              getTable(schema.pipelineDeals).push({
                id: winnerId,
                userId: "user-1",
                stageId: estStage.id,
                title: "Winner",
                value: 0,
                clientName: null,
                clientEmail: null,
                clientPhone: null,
                description: null,
                projectAddress: null,
                projectType: null,
                priority: "medium",
                nextAction: null,
                expectedStartDate: null,
                followUpDate: null,
                estimateId: "est-race-1",
                leadId: null,
                probability: 50,
                expectedCloseDate: null,
                wonAt: null,
                lostAt: null,
                lostReason: null,
                position: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              const err = new Error(
                'duplicate key value violates unique constraint "idx_pipeline_deals_user_estimate_uq"',
              ) as Error & { code: string };
              err.code = "23505";
              return {
                returning: () => Promise.reject(err),
                then: (_resolve: unknown, reject: (e: unknown) => void) => reject(err),
              };
            }
            return orig.values(vals);
          },
        };
      }
      return orig;
    }) as typeof realInsert;

    try {
      await sync.syncDealForNewEstimate({
        userId: "user-1",
        estimateId: "est-race-1",
        leadId: null,
        source: { title: "Loser tried", clientName: "Race", value: 1234 },
      });
    } finally {
      (dbMod.db as unknown as { insert: typeof realInsert }).insert = realInsert;
    }

    // Exactly one deal row for the racing estimate — the winner — and it picked
    // up the value the loser was trying to write (existing-row update branch).
    const racing = getTable(schema.pipelineDeals).filter(
      (d) => d.estimateId === "est-race-1",
    );
    expect(racing).toHaveLength(1);
    expect(racing[0].id).toBe(winnerId);
    expect(racing[0].value).toBe(1234);
    expect(stageNameOf(schema, racing[0].stageId)).toBe("Estimate Sent");
    expect(raceFired).toBe(true);
  });

  it("(task #142) concurrent lead insert: simulated 23505 recovers and reuses the winner", async () => {
    const { schema, sync } = await loadModules();
    const dbMod = await import("../server/db.js");
    const realInsert = dbMod.db.insert.bind(dbMod.db);

    await sync.syncDealForNewLead({
      userId: "user-1",
      leadId: "warm-up",
      source: { clientName: "warmup" },
    });
    const winnerId = "winner-deal-lead";

    let raceFired = false;
    (dbMod.db as unknown as { insert: typeof realInsert }).insert = ((
      table: unknown,
    ) => {
      const orig = realInsert(table as never);
      if (table === schema.pipelineDeals && !raceFired) {
        return {
          values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
            const list = Array.isArray(vals) ? vals : [vals];
            const targetsRace = list.some((v) => v.leadId === "lead-race-1");
            if (targetsRace) {
              raceFired = true;
              const stages = getTable(schema.pipelineStages).filter(
                (s) => s.userId === "user-1",
              );
              const leadStage = stages.find((s) => s.name === "Lead")!;
              getTable(schema.pipelineDeals).push({
                id: winnerId,
                userId: "user-1",
                stageId: leadStage.id,
                title: "Winner Lead",
                value: 0,
                clientName: null,
                clientEmail: null,
                clientPhone: null,
                description: null,
                projectAddress: null,
                projectType: null,
                priority: "medium",
                nextAction: null,
                expectedStartDate: null,
                followUpDate: null,
                estimateId: null,
                leadId: "lead-race-1",
                probability: 50,
                expectedCloseDate: null,
                wonAt: null,
                lostAt: null,
                lostReason: null,
                position: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              const err = new Error("duplicate key") as Error & { code: string };
              err.code = "23505";
              return {
                returning: () => Promise.reject(err),
                then: (_resolve: unknown, reject: (e: unknown) => void) => reject(err),
              };
            }
            return orig.values(vals);
          },
        };
      }
      return orig;
    }) as typeof realInsert;

    try {
      await sync.syncDealForNewLead({
        userId: "user-1",
        leadId: "lead-race-1",
        source: { clientName: "Loser", projectType: "Roofing" },
      });
    } finally {
      (dbMod.db as unknown as { insert: typeof realInsert }).insert = realInsert;
    }

    const racing = getTable(schema.pipelineDeals).filter(
      (d) => d.leadId === "lead-race-1",
    );
    expect(racing).toHaveLength(1);
    expect(racing[0].id).toBe(winnerId);
    expect(raceFired).toBe(true);
  });

  it("(task #186) 23505 race logs an info line and increments the duplicate-deal counter", async () => {
    const { schema, sync } = await loadModules();
    const dbMod = await import("../server/db.js");
    const realInsert = dbMod.db.insert.bind(dbMod.db);

    await sync.syncDealForNewLead({
      userId: "user-1",
      leadId: "warm-up",
      source: { clientName: "warmup" },
    });

    const winnerId = "winner-deal-metric";
    let raceFired = false;

    (dbMod.db as unknown as { insert: typeof realInsert }).insert = ((
      table: unknown,
    ) => {
      const orig = realInsert(table as never);
      if (table === schema.pipelineDeals && !raceFired) {
        return {
          values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
            const list = Array.isArray(vals) ? vals : [vals];
            const targetsRace = list.some((v) => v.estimateId === "est-metric-race");
            if (targetsRace) {
              raceFired = true;
              const stages = getTable(schema.pipelineStages).filter(
                (s) => s.userId === "user-1",
              );
              const estStage = stages.find((s) => s.name === "Estimate Sent")!;
              getTable(schema.pipelineDeals).push({
                id: winnerId,
                userId: "user-1",
                stageId: estStage.id,
                title: "Winner Metric",
                value: 0,
                clientName: null,
                clientEmail: null,
                clientPhone: null,
                description: null,
                projectAddress: null,
                projectType: null,
                priority: "medium",
                nextAction: null,
                expectedStartDate: null,
                followUpDate: null,
                estimateId: "est-metric-race",
                leadId: null,
                probability: 50,
                expectedCloseDate: null,
                wonAt: null,
                lostAt: null,
                lostReason: null,
                position: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              const err = new Error(
                'duplicate key value violates unique constraint "idx_pipeline_deals_user_estimate_uq"',
              ) as Error & { code: string };
              err.code = "23505";
              return {
                returning: () => Promise.reject(err),
                then: (_resolve: unknown, reject: (e: unknown) => void) => reject(err),
              };
            }
            return orig.values(vals);
          },
        };
      }
      return orig;
    }) as typeof realInsert;

    try {
      await sync.syncDealForNewEstimate({
        userId: "user-1",
        estimateId: "est-metric-race",
        leadId: null,
        source: { title: "Metric test", clientName: "Tester", value: 777 },
      });
    } finally {
      (dbMod.db as unknown as { insert: typeof realInsert }).insert = realInsert;
    }

    // Counter must have been incremented exactly once.
    expect(recordDuplicateDealRaceSpy).toHaveBeenCalledTimes(1);

    // Info log must have fired with the right level and key fields.
    const raceLogs = logSpy.mock.calls.filter(
      (c) => c[0] === "info" && typeof c[1] === "string" && c[1].includes("23505"),
    );
    expect(raceLogs.length).toBe(1);
    const logMeta = raceLogs[0][2] as Record<string, unknown>;
    expect(logMeta.userId).toBe("user-1");
    expect(logMeta.estimateId).toBe("est-metric-race");
  });
});
