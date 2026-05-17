import { describe, it, expect, vi } from "vitest";
import express from "express";
import { validateCsrf } from "../server/lib/middleware.js";

function makeReq(overrides: Partial<express.Request> = {}): express.Request {
  return {
    headers: {},
    body: {},
    session: {},
    ...overrides,
  } as unknown as express.Request;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("validateCsrf mobile bearer-token bypass", () => {
  it("allows the request through when isMobileAuth is true even without a CSRF token", () => {
    const req = makeReq({
      // No session.csrfToken, no x-csrf-token header — would normally 403.
      session: { uid: "user-1" },
    } as any);
    (req as any).isMobileAuth = true;
    const res = makeRes();
    const next = vi.fn();

    validateCsrf(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("rejects cookie-auth requests that are missing a CSRF token", () => {
    const req = makeReq({ session: { uid: "user-1" } } as any);
    const res = makeRes();
    const next = vi.fn();

    validateCsrf(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("rejects cookie-auth requests when the submitted CSRF token doesn't match", () => {
    const req = makeReq({
      session: { uid: "user-1", csrfToken: "expected-token" },
      headers: { "x-csrf-token": "wrong-token" },
    } as any);
    const res = makeRes();
    const next = vi.fn();

    validateCsrf(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("accepts cookie-auth requests with a matching x-csrf-token header", () => {
    const req = makeReq({
      session: { uid: "user-1", csrfToken: "good-token" },
      headers: { "x-csrf-token": "good-token" },
    } as any);
    const res = makeRes();
    const next = vi.fn();

    validateCsrf(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });
});
