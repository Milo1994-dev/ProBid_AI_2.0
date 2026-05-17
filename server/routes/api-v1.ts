import express from "express";
import { db } from "../db.js";
import { estimates, leads, usage, users, subscriptions } from "../../shared/schema.js";
import { eq, desc, and, count } from "drizzle-orm";
import { authenticateApiKey, requireScope, apiKeyRateLimiter, hasApiBusinessAccess } from "../lib/api-key-auth.js";
import { auditMiddleware } from "../lib/audit.js";
import { getCached, setCached } from "../lib/cache.js";
import { log } from "../lib/logger.js";
import { incrementPartnerUsage } from "./partner.js";

async function requireBusinessEntitlement(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const userId = (req as any).apiKeyUserId as string;
  try {
    if (!(await hasApiBusinessAccess(userId))) {
      res.status(403).json({
        error: "forbidden",
        message: "Developer API access requires an active Business plan.",
      });
      return;
    }
  } catch (err) {
    log("error", "Business entitlement check failed", { error: String(err), userId });
    res.status(500).json({ error: "internal_error", message: "Authorization check failed" });
    return;
  }
  next();
}

export function registerApiV1Routes(app: express.Express) {
  const v1 = express.Router();

  v1.use(authenticateApiKey);
  v1.use(apiKeyRateLimiter);
  v1.use(requireBusinessEntitlement);

  v1.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const r = req as express.Request & { apiKeyPartnerId?: string; apiKeyId?: string };
    res.on("finish", () => {
      const partnerId = r.apiKeyPartnerId;
      if (!partnerId) return;
      const apiKeyId = r.apiKeyId ? String(r.apiKeyId) : null;
      if (res.statusCode >= 500) {
        void incrementPartnerUsage({ partnerId, apiKeyId, field: "errors" });
      } else if (res.statusCode < 400) {
        void incrementPartnerUsage({ partnerId, apiKeyId, field: "estimatesApi" });
      }
    });
    next();
  });

  v1.get("/", (_req, res) => {
    res.json({
      name: "ProBid AI API",
      version: "1.0.0",
      documentation: "/app/developer",
      endpoints: {
        "GET /api/v1/estimates": "List your estimates",
        "GET /api/v1/estimates/:id": "Get a specific estimate",
        "GET /api/v1/usage": "Get your usage stats",
        "GET /api/v1/leads": "List your leads",
        "GET /api/v1/account": "Get account information",
      },
    });
  });

  v1.get(
    "/estimates",
    requireScope("estimates:read"),
    auditMiddleware("api:estimates:list", "estimates"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "service_unavailable" });

        const userId = (req as any).apiKeyUserId;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;

        const cacheKey = `api:estimates:${userId}:${page}:${limit}`;
        const cached = getCached<any>(cacheKey, "short");
        if (cached) {
          res.json(cached);
          return;
        }

        const [items, [totalRow]] = await Promise.all([
          db
            .select({
              id: estimates.id,
              jobType: estimates.jobType,
              market: estimates.market,
              details: estimates.details,
              clientName: estimates.clientName,
              clientEmail: estimates.clientEmail,
              createdAt: estimates.createdAt,
            })
            .from(estimates)
            .where(eq(estimates.userId, userId))
            .orderBy(desc(estimates.createdAt))
            .limit(limit)
            .offset(offset),
          db
            .select({ total: count() })
            .from(estimates)
            .where(eq(estimates.userId, userId)),
        ]);

        const total = totalRow?.total || 0;
        const result = {
          data: items,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        };

        setCached(cacheKey, result, "short");
        res.json(result);
      } catch (err) {
        log("error", "API v1 estimates list failed", { error: String(err), userId: (req as any).apiKeyUserId });
        res.status(500).json({ error: "internal_error", message: "Failed to fetch estimates" });
      }
    },
  );

  v1.get(
    "/estimates/:id",
    requireScope("estimates:read"),
    auditMiddleware("api:estimates:get", "estimates"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "service_unavailable" });

        const userId = (req as any).apiKeyUserId;
        const [estimate] = await db
          .select()
          .from(estimates)
          .where(and(eq(estimates.id, req.params.id), eq(estimates.userId, userId)))
          .limit(1);

        if (!estimate) {
          res.status(404).json({ error: "not_found", message: "Estimate not found" });
          return;
        }

        res.json({ data: estimate });
      } catch (err) {
        log("error", "API v1 estimate get failed", { error: String(err), id: req.params.id });
        res.status(500).json({ error: "internal_error", message: "Failed to fetch estimate" });
      }
    },
  );

  v1.get(
    "/usage",
    requireScope("usage:read"),
    auditMiddleware("api:usage:get", "usage"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "service_unavailable" });

        const userId = (req as any).apiKeyUserId;
        const today = new Date().toISOString().slice(0, 10);

        const [todayUsage] = await db
          .select()
          .from(usage)
          .where(and(eq(usage.userId, userId), eq(usage.dayKey, today)))
          .limit(1);

        const [sub] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .limit(1);

        res.json({
          data: {
            estimatesToday: todayUsage?.estimatesCount || 0,
            subscription: sub
              ? {
                  status: sub.status,
                  currentPeriodEnd: sub.currentPeriodEnd,
                }
              : null,
          },
        });
      } catch (err) {
        log("error", "API v1 usage get failed", { error: String(err) });
        res.status(500).json({ error: "internal_error", message: "Failed to fetch usage" });
      }
    },
  );

  v1.get(
    "/leads",
    requireScope("leads:read"),
    auditMiddleware("api:leads:list", "leads"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "service_unavailable" });

        const userId = (req as any).apiKeyUserId;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;

        const [items, [totalRow]] = await Promise.all([
          db
            .select({
              id: leads.id,
              name: leads.name,
              email: leads.email,
              phone: leads.phone,
              status: leads.status,
              createdAt: leads.createdAt,
            })
            .from(leads)
            .where(eq(leads.userId, userId))
            .orderBy(desc(leads.createdAt))
            .limit(limit)
            .offset(offset),
          db
            .select({ total: count() })
            .from(leads)
            .where(eq(leads.userId, userId)),
        ]);

        const total = totalRow?.total || 0;
        res.json({
          data: items,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        log("error", "API v1 leads list failed", { error: String(err) });
        res.status(500).json({ error: "internal_error", message: "Failed to fetch leads" });
      }
    },
  );

  v1.get(
    "/account",
    requireScope("usage:read"),
    auditMiddleware("api:account:get", "account"),
    async (req, res) => {
      try {
        if (!db) return res.status(503).json({ error: "service_unavailable" });

        const userId = (req as any).apiKeyUserId;
        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        if (!user) {
          res.status(404).json({ error: "not_found" });
          return;
        }

        res.json({ data: user });
      } catch (err) {
        log("error", "API v1 account get failed", { error: String(err) });
        res.status(500).json({ error: "internal_error", message: "Failed to fetch account" });
      }
    },
  );

  app.use("/api/v1", v1);
}
