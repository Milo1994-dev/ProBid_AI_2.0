import { describe, it, expect, vi, beforeEach } from "vitest";

// All DB / network dependencies of the helpers are mocked so this test runs
// fully offline and only exercises the rendering path.

const userRow = { pdfShowGuaranteeBadges: true as boolean | null };

vi.mock("../db.js", () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => [userRow]),
    })),
  }));
  return { db: { select }, pool: { query: vi.fn() } };
});

vi.mock("../lib/user-helpers.js", () => ({
  getSub: vi.fn(async () => ({ priceId: "price_pro_monthly" })),
  isPaidActive: vi.fn(() => paidStub),
}));

vi.mock("../lib/affiliate-helpers.js", () => ({
  ensureAffiliateCode: vi.fn(async () => "TESTCODE"),
}));

vi.mock("../lib/config.js", () => ({
  APP_URL: "https://example.test",
}));

// Force QR generation to fail so qrCodeBuffer stays null and pdfkit isn't
// asked to embed an image — we only care about the trust-bar text here.
vi.mock("qrcode", () => ({
  default: {
    toBuffer: vi.fn(async () => {
      throw new Error("qr disabled in test");
    }),
  },
}));

let paidStub = true;

import {
  buildEstimatePdfBuffer,
  shouldShowGuaranteeBadges,
} from "../lib/estimate-pdf-helpers.js";

const baseEstimate = {
  id: "11111111-1111-1111-1111-111111111111",
  jobType: "tuckpointing",
  market: "Chicago",
  details: "120 sqft of joints",
  estimateText: "Materials $300\nLabor $400\nTotal $700",
  clientName: "Jane Doe",
  clientEmail: "jane@example.com",
  clientPhone: null,
  createdAt: Date.now(),
};

beforeEach(() => {
  paidStub = true;
  userRow.pdfShowGuaranteeBadges = true;
});

import zlib from "node:zlib";

function pdfText(buf: Buffer): string {
  // pdfkit FlateDecode-compresses content streams by default, so the visible
  // text isn't in the raw bytes. Walk every `stream ... endstream` block,
  // try to inflate it, and concatenate the results so substring matches on
  // rendered text work the same way they would in a PDF viewer.
  const raw = buf.toString("latin1");
  let out = raw;
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const bytes = Buffer.from(m[1], "latin1");
    try {
      const inflated = zlib.inflateSync(bytes).toString("latin1");
      out += "\n" + inflated;
      // pdfkit emits text with kerning as hex-encoded TJ arrays like
      //   [<426163> 20 <6b> 20 <65642062> ...] TJ
      // Decode every hex literal and append the resulting string so
      // substring matches on rendered text succeed.
      let decoded = "";
      for (const hexMatch of inflated.matchAll(/<([0-9a-fA-F]+)>/g)) {
        decoded += Buffer.from(hexMatch[1], "hex").toString("latin1");
      }
      if (decoded) out += "\n" + decoded;
    } catch {
      // Not a flate stream (e.g. already-uncompressed image data) — skip.
    }
  }
  return out;
}

describe("buildEstimatePdfBuffer — guarantee trust bar", () => {
  it("includes the trust bar for a paid owner with the toggle on", async () => {
    const built = await buildEstimatePdfBuffer("user-1", baseEstimate.id, {
      estimate: baseEstimate,
    });
    expect(built).not.toBeNull();
    const text = pdfText(built!.buffer);
    expect(text).toContain("Backed by ProBid's Triple Guarantee");
  });

  it("omits the trust bar when the owner has disabled the toggle", async () => {
    userRow.pdfShowGuaranteeBadges = false;
    const built = await buildEstimatePdfBuffer("user-1", baseEstimate.id, {
      estimate: baseEstimate,
    });
    const text = pdfText(built!.buffer);
    expect(text).not.toContain("Triple Guarantee");
  });

  it("omits the trust bar for a free-tier owner even with the toggle on", async () => {
    paidStub = false;
    const built = await buildEstimatePdfBuffer("user-1", baseEstimate.id, {
      estimate: baseEstimate,
    });
    const text = pdfText(built!.buffer);
    expect(text).not.toContain("Triple Guarantee");
    // Sanity: we still produced a real PDF (rather than failing early) — the
    // bar was suppressed by the paid-tier gate, not by an exception.
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(built!.buffer.length).toBeGreaterThan(500);
  });
});

describe("buildEstimatePdfBuffer — injected-row guards", () => {
  it("returns null when opts.estimate.id does not match the estimateId arg", async () => {
    const built = await buildEstimatePdfBuffer("user-1", "00000000-0000-0000-0000-000000000000", {
      estimate: baseEstimate,
    });
    expect(built).toBeNull();
  });

  it("returns null when opts.estimate.userId belongs to a different user", async () => {
    const built = await buildEstimatePdfBuffer("user-1", baseEstimate.id, {
      estimate: { ...baseEstimate, userId: "user-2" },
    });
    expect(built).toBeNull();
  });
});

describe("shouldShowGuaranteeBadges — gate", () => {
  it("returns false for unpaid owners regardless of the toggle", async () => {
    expect(await shouldShowGuaranteeBadges("user-1", false)).toBe(false);
  });

  it("returns true for paid owners when the toggle is unset (defaults to on)", async () => {
    userRow.pdfShowGuaranteeBadges = null;
    expect(await shouldShowGuaranteeBadges("user-1", true)).toBe(true);
  });

  it("returns false for paid owners who explicitly disabled the toggle", async () => {
    userRow.pdfShowGuaranteeBadges = false;
    expect(await shouldShowGuaranteeBadges("user-1", true)).toBe(false);
  });
});
