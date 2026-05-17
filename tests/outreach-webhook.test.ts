import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "http";
import crypto from "crypto";
import type { AddressInfo } from "net";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
type SchemaCol = { __name?: string };

const tables = new Map<unknown, Row[]>();

function getTable(t: unknown): Row[] {
  let list = tables.get(t);
  if (!list) {
    list = [];
    tables.set(t, list);
  }
  return list;
}

vi.mock("../server/db.js", () => {
  const buildSelect = (cols?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const rows = () => getTable(table);
      const chain = (filter: Predicate | null) => ({
        where: (predicate: Predicate) => {
          const composed: Predicate = filter
            ? (row) => filter(row) && predicate(row)
            : predicate;
          return chain(composed);
        },
        limit: (n: number) => {
          const filtered = filter ? rows().filter(filter) : [...rows()];
          return Promise.resolve(filtered.slice(0, n));
        },
        then: (resolve: (v: Row[]) => void) => {
          const filtered = filter ? rows().filter(filter) : [...rows()];
          if (cols && typeof cols === "object" && "c" in cols) {
            return resolve([{ c: filtered.length } as Row]);
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
          getTable(table).push(row);
          inserted.push(row);
        }
        return {
          returning: () => Promise.resolve(inserted),
          then: (resolve: (v: undefined) => void) => resolve(undefined),
          catch: () => Promise.resolve(),
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
  };
  return { db, pool: { query: () => Promise.resolve({ rows: [] }) } };
});

vi.mock("drizzle-orm", async (orig) => {
  const real = await orig<typeof import("drizzle-orm")>();

  // Map a snake_case column name like "opened_at" to its camelCase property.
  const snakeToCamel = (s: string) =>
    s.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());

  return {
    ...real,
    eq: (col: SchemaCol, value: unknown) => (row: Row) =>
      row[col?.__name ?? "id"] === value,
    and: (...preds: Predicate[]) => (row: Row) => preds.every((p) => p(row)),
    // Tagged-template support for the small `IS NULL` predicates the webhook uses.
    sql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join("?").trim().toLowerCase();
      const m = text.match(/^(\w+)\s+is\s+null$/);
      if (m) {
        const camel = snakeToCamel(m[1]);
        return ((row: Row) => row[camel] == null) as unknown as Predicate;
      }
      return ((_row: Row) => true) as unknown as Predicate;
    },
    count: () => ({ c: 0 }),
    gte: () => () => true,
  };
});

vi.mock("../server/lib/logger.js", () => ({
  log: () => {},
}));

const RAW_SECRET_B64 = Buffer.from("super-secret-key-for-webhook-tests").toString(
  "base64",
);
const FULL_SECRET = `whsec_${RAW_SECRET_B64}`;

let originalSecret: string | undefined;
let originalDeployment: string | undefined;

beforeEach(() => {
  tables.clear();
  originalSecret = process.env.RESEND_WEBHOOK_SECRET;
  originalDeployment = process.env.REPLIT_DEPLOYMENT;
  process.env.RESEND_WEBHOOK_SECRET = FULL_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = originalSecret;
  if (originalDeployment === undefined) delete process.env.REPLIT_DEPLOYMENT;
  else process.env.REPLIT_DEPLOYMENT = originalDeployment;
});

async function startTestServer() {
  const schema = await import("../shared/schema.js");

  // Tag the columns the mocked drizzle helpers reference by name.
  const tag = (table: Record<string, SchemaCol>, names: string[]) => {
    for (const n of names) {
      if (table[n]) table[n].__name = n;
    }
  };
  tag(schema.scrapedLeads as unknown as Record<string, SchemaCol>, [
    "id",
    "email",
    "openedAt",
    "clickedAt",
    "repliedAt",
  ]);

  const { registerWebhooksRoutes } = await import(
    "../server/routes/outreach/webhooks.js"
  );

  const app = express();
  // Mirror the production body parser so the webhook handler sees a real
  // `req.rawBody` for signature verification.
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  registerWebhooksRoutes(app);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    schema: typeof schema;
  }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        schema,
      });
    });
  });
}

function sign(body: Buffer, msgId: string, ts: string, secret: string): string {
  const secretBytes = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice(6) : secret,
    "base64",
  );
  const sig = crypto
    .createHmac("sha256", secretBytes)
    .update(`${msgId}.${ts}.${body.toString("utf-8")}`)
    .digest("base64");
  return `v1,${sig}`;
}

async function postSignedEvent(
  baseUrl: string,
  payload: unknown,
  msgId: string,
): Promise<{ status: number; body: unknown }> {
  const body = Buffer.from(JSON.stringify(payload));
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await fetch(`${baseUrl}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": msgId,
      "svix-timestamp": ts,
      "svix-signature": sign(body, msgId, ts, FULL_SECRET),
    },
    body,
  });
  return { status: r.status, body: await r.json() };
}

function seedLead(
  schema: typeof import("../shared/schema.js"),
  overrides: Row = {},
): Row {
  const now = Date.now();
  const lead: Row = {
    id: "lead-1",
    name: "Acme Roofing",
    email: "owner@acme.example",
    phone: null,
    businessType: "roofing",
    location: null,
    website: null,
    source: "google_places",
    stage: "contacted",
    score: 0,
    doNotContact: false,
    unsubscribeToken: null,
    openedAt: null,
    clickedAt: null,
    repliedAt: null,
    convertedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  getTable(schema.scrapedLeads).push(lead);
  return lead;
}

describe("Resend webhook — open/click idempotency (task #87)", () => {
  it("records opened_at on the first email.opened event and leaves it unchanged on a duplicate", async () => {
    const { baseUrl, close, schema } = await startTestServer();
    try {
      const lead = seedLead(schema);

      const payload = {
        type: "email.opened",
        data: { email: { to: [lead.email as string] } },
      };

      const first = await postSignedEvent(baseUrl, payload, "msg_open_1");
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ success: true });

      const stored = getTable(schema.scrapedLeads)[0];
      expect(typeof stored.openedAt).toBe("number");
      expect(stored.openedAt).toBeGreaterThan(0);
      // Engagement signals were recomputed when the open landed.
      expect(stored.stage).toBe("opened");

      const firstOpenedAt = stored.openedAt as number;

      // Wait a tick so any (incorrect) re-write would land on a later ms.
      await new Promise((r) => setTimeout(r, 5));

      const second = await postSignedEvent(baseUrl, payload, "msg_open_2");
      expect(second.status).toBe(200);

      const after = getTable(schema.scrapedLeads)[0];
      // Idempotency guard: opened_at must not be overwritten on duplicate delivery.
      expect(after.openedAt).toBe(firstOpenedAt);
    } finally {
      await close();
    }
  });

  it("records clicked_at on the first email.clicked event and leaves it unchanged on a duplicate", async () => {
    const { baseUrl, close, schema } = await startTestServer();
    try {
      const lead = seedLead(schema);

      const payload = {
        type: "email.clicked",
        data: { email: { to: [lead.email as string] } },
      };

      const first = await postSignedEvent(baseUrl, payload, "msg_click_1");
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ success: true });

      const stored = getTable(schema.scrapedLeads)[0];
      expect(typeof stored.clickedAt).toBe("number");
      expect(stored.clickedAt).toBeGreaterThan(0);
      expect(stored.stage).toBe("clicked");

      const firstClickedAt = stored.clickedAt as number;

      await new Promise((r) => setTimeout(r, 5));

      const second = await postSignedEvent(baseUrl, payload, "msg_click_2");
      expect(second.status).toBe(200);

      const after = getTable(schema.scrapedLeads)[0];
      expect(after.clickedAt).toBe(firstClickedAt);
    } finally {
      await close();
    }
  });

  it("rejects an unsigned (or wrongly-signed) payload with 401 and does not mutate the lead", async () => {
    const { baseUrl, close, schema } = await startTestServer();
    try {
      const lead = seedLead(schema);
      const payload = {
        type: "email.opened",
        data: { email: { to: [lead.email as string] } },
      };
      const r = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(r.status).toBe(401);
      const stored = getTable(schema.scrapedLeads)[0];
      expect(stored.openedAt).toBeNull();
    } finally {
      await close();
    }
  });
});
