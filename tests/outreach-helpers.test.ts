import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  getWarmupPhaseForDay,
  verifyResendWebhook,
} from "../server/lib/outreach-helpers.js";

describe("getWarmupPhaseForDay", () => {
  it("returns Phase 1 for day 0", () => {
    const result = getWarmupPhaseForDay(0);
    expect(result.phase.limit).toBe(25);
    expect(result.phase.label).toBe("Phase 1 of 4");
    expect(result.nextPhase).not.toBeNull();
    expect(result.nextPhase!.limit).toBe(50);
    expect(result.daysUntilNext).toBe(14);
  });

  it("returns Phase 1 for day 13", () => {
    const result = getWarmupPhaseForDay(13);
    expect(result.phase.limit).toBe(25);
    expect(result.daysUntilNext).toBe(1);
  });

  it("returns Phase 2 for day 14", () => {
    const result = getWarmupPhaseForDay(14);
    expect(result.phase.limit).toBe(50);
    expect(result.phase.label).toBe("Phase 2 of 4");
  });

  it("returns Phase 2 for day 27", () => {
    const result = getWarmupPhaseForDay(27);
    expect(result.phase.limit).toBe(50);
    expect(result.daysUntilNext).toBe(1);
  });

  it("returns Phase 3 for day 28", () => {
    const result = getWarmupPhaseForDay(28);
    expect(result.phase.limit).toBe(100);
    expect(result.phase.label).toBe("Phase 3 of 4");
  });

  it("returns Phase 3 for day 55", () => {
    const result = getWarmupPhaseForDay(55);
    expect(result.phase.limit).toBe(100);
    expect(result.daysUntilNext).toBe(1);
  });

  it("returns Phase 4 for day 56", () => {
    const result = getWarmupPhaseForDay(56);
    expect(result.phase.limit).toBe(200);
    expect(result.phase.label).toBe("Phase 4 of 4");
    expect(result.nextPhase).toBeNull();
    expect(result.daysUntilNext).toBe(0);
  });

  it("returns Phase 4 for very large day numbers", () => {
    const result = getWarmupPhaseForDay(365);
    expect(result.phase.limit).toBe(200);
    expect(result.phase.label).toBe("Phase 4 of 4");
  });
});

describe("verifyResendWebhook", () => {
  // svix-style secret format: `whsec_<base64>`. Use the raw base64 part for HMAC.
  const RAW_SECRET_B64 = Buffer.from("super-secret-key-for-tests").toString("base64");
  const FULL_SECRET = `whsec_${RAW_SECRET_B64}`;

  let originalSecret: string | undefined;
  let originalDeployment: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.RESEND_WEBHOOK_SECRET;
    originalDeployment = process.env.REPLIT_DEPLOYMENT;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = originalSecret;
    if (originalDeployment === undefined) delete process.env.REPLIT_DEPLOYMENT;
    else process.env.REPLIT_DEPLOYMENT = originalDeployment;
  });

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

  it("accepts a correctly signed payload", () => {
    process.env.RESEND_WEBHOOK_SECRET = FULL_SECRET;
    const body = Buffer.from(
      JSON.stringify({ type: "email.opened", data: { email: { to: ["a@b.c"] } } }),
    );
    const msgId = "msg_test_1";
    const ts = "1700000000";
    const headers = {
      "svix-id": msgId,
      "svix-timestamp": ts,
      "svix-signature": sign(body, msgId, ts, FULL_SECRET),
    };
    expect(verifyResendWebhook(body, headers)).toBe(true);
  });

  it("rejects a tampered body", () => {
    process.env.RESEND_WEBHOOK_SECRET = FULL_SECRET;
    const body = Buffer.from('{"type":"email.opened"}');
    const msgId = "msg_test_2";
    const ts = "1700000000";
    const headers = {
      "svix-id": msgId,
      "svix-timestamp": ts,
      "svix-signature": sign(body, msgId, ts, FULL_SECRET),
    };
    const tampered = Buffer.from('{"type":"email.bounced"}');
    expect(verifyResendWebhook(tampered, headers)).toBe(false);
  });

  it("rejects when required svix headers are missing", () => {
    process.env.RESEND_WEBHOOK_SECRET = FULL_SECRET;
    const body = Buffer.from('{"type":"email.opened"}');
    expect(verifyResendWebhook(body, {})).toBe(false);
  });

  it("rejects in production when secret is unset", () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    process.env.REPLIT_DEPLOYMENT = "1";
    const body = Buffer.from('{"type":"email.opened"}');
    expect(verifyResendWebhook(body, {})).toBe(false);
  });

  it("allows in development when secret is unset", () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.REPLIT_DEPLOYMENT;
    const body = Buffer.from('{"type":"email.opened"}');
    expect(verifyResendWebhook(body, {})).toBe(true);
  });
});
