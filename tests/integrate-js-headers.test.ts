import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const { publicScriptCorsMiddleware } = await import("../server/lib/cors.js");
  const app = express();

  app.use("/integrate.js", publicScriptCorsMiddleware);
  app.get("/integrate.js", (_req, res) => {
    res.sendFile(
      path.resolve(process.cwd(), "client/public/integrate.js"),
    );
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("/integrate.js public script delivery", () => {
  it("serves the script with cross-origin headers so any partner page can <script src> it", async () => {
    const res = await fetch(`${baseUrl}/integrate.js`, {
      headers: { origin: "https://random-partner.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const body = await res.text();
    expect(body).toContain("ProBidCore");
    expect(body).toContain("sendEstimate");
  });

  it("uses permissive script CORS even with no Origin header (curl, server-side fetch)", async () => {
    const res = await fetch(`${baseUrl}/integrate.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
