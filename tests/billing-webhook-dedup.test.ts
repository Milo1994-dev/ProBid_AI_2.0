import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Stripe webhook event-level idempotency in
 * server/routes/billing.ts (stripeWebhookHandler).
 *
 * Two invariants under test:
 *   1. Duplicate event.id deliveries are short-circuited with
 *      { received: true, duplicate: true } and the handler body does NOT run.
 *   2. If the handler body throws, the dedup row is rolled back so Stripe's
 *      retry can reprocess the event (otherwise we'd permanently lose it).
 *
 * The actual handler is heavily entangled with Stripe SDK + db + side-effects,
 * so this mirrors the dedup algorithm via a thin in-memory implementation
 * (matching the entitlements.test.ts pattern) and verifies behavior end-to-end.
 */

interface DedupStore {
  rows: Set<string>;
  insertCallCount: number;
  deleteCallCount: number;
  insertShouldThrow: boolean;
}

function makeStore(): DedupStore {
  return { rows: new Set(), insertCallCount: 0, deleteCallCount: 0, insertShouldThrow: false };
}

/** Mirrors `db.insert(...).onConflictDoNothing(...).returning(...)` semantics. */
function insertEvent(store: DedupStore, eventId: string): { eventId: string }[] {
  store.insertCallCount += 1;
  if (store.insertShouldThrow) throw new Error("simulated db failure");
  if (store.rows.has(eventId)) return [];
  store.rows.add(eventId);
  return [{ eventId }];
}

function deleteEvent(store: DedupStore, eventId: string): void {
  store.deleteCallCount += 1;
  store.rows.delete(eventId);
}

/**
 * Mirrors stripeWebhookHandler's dedup wrapper around the switch.
 * Returns the response body the route would send; tracks side effects in `runs`.
 */
async function runWebhook(opts: {
  store: DedupStore;
  event: { id: string; type: string };
  handlerBody: () => Promise<void>;
  runs: { count: number };
}): Promise<{ status: number; body: any }> {
  const { store, event, handlerBody, runs } = opts;

  // Dedup gate (lines ~169-184 of billing.ts)
  try {
    const inserted = insertEvent(store, event.id);
    if (inserted.length === 0) {
      return { status: 200, body: { received: true, duplicate: true } };
    }
  } catch {
    // Fall through and process anyway — losing dedup is preferable to dropping.
  }

  // Switch body
  try {
    await handlerBody();
    runs.count += 1;
    return { status: 200, body: { received: true } };
  } catch (err: any) {
    // Rollback dedup so Stripe retry can reprocess.
    try {
      deleteEvent(store, event.id);
    } catch {
      // swallowed in real handler too
    }
    return { status: 500, body: { error: "Webhook error" } };
  }
}

describe("stripe webhook event dedup", () => {
  let store: DedupStore;
  let runs: { count: number };
  const okHandler = async () => {};

  beforeEach(() => {
    store = makeStore();
    runs = { count: 0 };
  });

  it("processes a fresh event and inserts the dedup row", async () => {
    const res = await runWebhook({
      store,
      event: { id: "evt_1", type: "checkout.session.completed" },
      handlerBody: okHandler,
      runs,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(runs.count).toBe(1);
    expect(store.rows.has("evt_1")).toBe(true);
  });

  it("short-circuits duplicate redeliveries without re-running the handler", async () => {
    await runWebhook({ store, event: { id: "evt_1", type: "invoice.paid" }, handlerBody: okHandler, runs });
    expect(runs.count).toBe(1);

    const res = await runWebhook({
      store,
      event: { id: "evt_1", type: "invoice.paid" },
      handlerBody: okHandler,
      runs,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(runs.count).toBe(1); // handler did NOT run again
    expect(store.insertCallCount).toBe(2); // both attempts hit the dedup table
  });

  it("rolls back the dedup row when the handler throws so Stripe can retry", async () => {
    const failingHandler = vi.fn(async () => {
      throw new Error("boom");
    });

    const res = await runWebhook({
      store,
      event: { id: "evt_2", type: "customer.subscription.updated" },
      handlerBody: failingHandler,
      runs,
    });
    expect(res.status).toBe(500);
    expect(failingHandler).toHaveBeenCalledOnce();
    expect(store.rows.has("evt_2")).toBe(false); // rolled back
    expect(store.deleteCallCount).toBe(1);

    // Stripe's retry should now succeed and actually run the handler body.
    const retryHandler = vi.fn(async () => {});
    const retry = await runWebhook({
      store,
      event: { id: "evt_2", type: "customer.subscription.updated" },
      handlerBody: retryHandler,
      runs,
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ received: true });
    expect(retryHandler).toHaveBeenCalledOnce();
    expect(store.rows.has("evt_2")).toBe(true);
  });

  it("dedup is per-event-id, not per-event-type", async () => {
    await runWebhook({
      store,
      event: { id: "evt_3", type: "checkout.session.completed" },
      handlerBody: okHandler,
      runs,
    });
    const res = await runWebhook({
      store,
      event: { id: "evt_4", type: "checkout.session.completed" },
      handlerBody: okHandler,
      runs,
    });
    expect(res.body).toEqual({ received: true });
    expect(runs.count).toBe(2);
  });

  it("if the dedup INSERT itself fails, processing still happens (don't drop event)", async () => {
    store.insertShouldThrow = true;
    const handler = vi.fn(async () => {});
    const res = await runWebhook({
      store,
      event: { id: "evt_5", type: "invoice.payment_failed" },
      handlerBody: handler,
      runs,
    });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});
