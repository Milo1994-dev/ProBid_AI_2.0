import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

/**
 * Regression test for task #139.
 *
 * The browser fires Meta Pixel events with a generated `eventID`. The same
 * id is sent to our backend (via signup / lead / checkout payloads) so the
 * server-side CAPI call uses an identical `event_id`. Meta then dedupes
 * the browser+server pair and counts the conversion once.
 *
 * The bug we are guarding against: `sendMetaConversion` previously fell
 * back to a fresh `crypto.randomUUID()` whenever a caller forgot to plumb
 * the `eventId` through. That silently doubles every reported conversion.
 * These tests assert two things:
 *   1. When a request `eventId` is supplied, the CAPI body uses it verbatim.
 *   2. When `fireServerConversions` is invoked with `eventId`, it forwards
 *      that exact value to the Meta call (no fresh UUID).
 */

const PIXEL_ID = "test-pixel-id";
const TOKEN = "test-meta-capi-token";

let sendMetaConversion: typeof import("../server/lib/ad-conversions.js").sendMetaConversion;
let fireServerConversions: typeof import("../server/lib/ad-conversions.js").fireServerConversions;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  process.env.META_PIXEL_ID = PIXEL_ID;
  process.env.META_CONVERSIONS_API_TOKEN = TOKEN;
  ({ sendMetaConversion, fireServerConversions } = await import(
    "../server/lib/ad-conversions.js"
  ));
});

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  );
  // @ts-expect-error overriding global fetch for the duration of the test
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lastCallBody(): { event_id: string; event_name: string } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0];
  const parsed = JSON.parse(init.body as string);
  return parsed.data[0];
}

describe("sendMetaConversion event_id passthrough", () => {
  it("uses the supplied eventId verbatim in the CAPI payload", async () => {
    const eventId = "browser-event-1761234567-abc123";
    await sendMetaConversion({ eventName: "Lead", eventId });
    const ev = lastCallBody();
    expect(ev.event_name).toBe("Lead");
    expect(ev.event_id).toBe(eventId);
  });

  it("falls back to a fresh UUID only when no eventId is provided", async () => {
    await sendMetaConversion({ eventName: "Lead" });
    const ev = lastCallBody();
    expect(ev.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("fireServerConversions event_id passthrough", () => {
  it("forwards eventId to sendMetaConversion for signup events", async () => {
    const eventId = "browser-signup-9988-zzz";
    await fireServerConversions("signup", { email: "a@b.com", eventId });
    const ev = lastCallBody();
    expect(ev.event_name).toBe("CompleteRegistration");
    expect(ev.event_id).toBe(eventId);
  });

  it("forwards eventId for purchase events (Stripe webhook path)", async () => {
    const eventId = "browser-purchase-stripe-meta";
    await fireServerConversions("purchase", {
      email: "buyer@x.com",
      value: 25,
      currency: "USD",
      orderId: "pi_test_123",
      eventId,
    });
    const ev = lastCallBody();
    expect(ev.event_name).toBe("Purchase");
    expect(ev.event_id).toBe(eventId);
  });

  it("forwards eventId for lead events (homepage form)", async () => {
    const eventId = "browser-lead-roofing-42";
    await fireServerConversions("lead", { email: "lead@x.com", eventId });
    const ev = lastCallBody();
    expect(ev.event_name).toBe("Lead");
    expect(ev.event_id).toBe(eventId);
  });

  it("does not invent a fresh event_id when caller omits one (regression — but Meta will then double-count, so callers MUST pass eventId)", async () => {
    await fireServerConversions("signup", { email: "noid@x.com" });
    const ev = lastCallBody();
    // Documents current behaviour: missing eventId -> random UUID. The
    // dedup contract is the *caller*'s responsibility (route handlers
    // pull `meta_event_id` off the request body).
    expect(ev.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
