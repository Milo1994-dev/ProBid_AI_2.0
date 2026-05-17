import express from "express";
import crypto from "crypto";
import { db, pool } from "../../db.js";
import { partners, apiKeys, sdkAllowedOrigins, partnerUsage, users } from "../../../shared/schema.js";
import { eq, desc } from "drizzle-orm";
import { requireAdminAuth, asyncHandler } from "../../lib/middleware.js";
import { recordAudit } from "../../lib/audit.js";
import { log } from "../../lib/logger.js";
import { z } from "zod";

function getAdminId(req: express.Request): string {
  return req.session?.uid || req.session?.userId || "admin-key";
}

const createPartnerSchema = z.object({
  userId: z.string().min(1),
  companyName: z.string().min(1).max(200),
  rateLimitOverride: z.number().min(1).max(10000).optional(),
  notes: z.string().max(2000).optional(),
});

const updatePartnerSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  companyName: z.string().min(1).max(200).optional(),
  rateLimitOverride: z.number().min(10).max(100000).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export function registerAdminPartnerRoutes(app: express.Application): void {
  app.get(
    "/api/admin/partners",
    requireAdminAuth,
    asyncHandler(async (_req: express.Request, res: express.Response) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const partnerRows = await db
        .select({
          id: partners.id,
          companyName: partners.companyName,
          primaryUserId: partners.primaryUserId,
          status: partners.status,
          rateLimitOverride: partners.rateLimitOverride,
          notes: partners.notes,
          createdAt: partners.createdAt,
          updatedAt: partners.updatedAt,
        })
        .from(partners)
        .orderBy(desc(partners.createdAt));

      const monthStart = new Date().toISOString().slice(0, 7) + "-01";

      type UsageAgg = { partnerId: string; sdk: number; api: number; errors: number };
      const usageRaw = await pool.query<{ partner_id: string; sdk: string; api: string; errors: string }>(
        `SELECT partner_id,
                COALESCE(SUM(estimates_sdk), 0)::text AS sdk,
                COALESCE(SUM(estimates_api), 0)::text AS api,
                COALESCE(SUM(errors), 0)::text AS errors
         FROM partner_usage
         WHERE day_key >= $1
         GROUP BY partner_id`,
        [monthStart],
      );
      const usageMap = new Map<string, UsageAgg>(
        usageRaw.rows.map((r) => [r.partner_id, {
          partnerId: r.partner_id,
          sdk: Number(r.sdk),
          api: Number(r.api),
          errors: Number(r.errors),
        }]),
      );

      const keyCountRaw = await pool.query<{ partner_id: string; total: string }>(
        `SELECT partner_id, COUNT(*)::text AS total FROM api_keys WHERE partner_id IS NOT NULL GROUP BY partner_id`,
      );
      const keyCountMap = new Map<string, number>(
        keyCountRaw.rows.map((r) => [r.partner_id, Number(r.total)]),
      );

      const userIds = partnerRows.map((p) => p.primaryUserId);
      let userEmails: Map<string, string> = new Map();
      if (userIds.length > 0) {
        const userRows = await pool.query<{ id: string; email: string }>(
          `SELECT id, email FROM users WHERE id = ANY($1)`,
          [userIds],
        );
        userEmails = new Map(userRows.rows.map((u) => [u.id, u.email]));
      }

      const enriched = partnerRows.map((p) => ({
        ...p,
        primaryEmail: userEmails.get(p.primaryUserId) ?? null,
        thisMonth: usageMap.has(p.id) ? {
          estimatesSdk: usageMap.get(p.id)!.sdk,
          estimatesApi: usageMap.get(p.id)!.api,
          errors: usageMap.get(p.id)!.errors,
        } : { estimatesSdk: 0, estimatesApi: 0, errors: 0 },
        keyCount: keyCountMap.get(p.id) ?? 0,
      }));

      res.json({ success: true, data: { partners: enriched } });
    }),
  );

  app.post(
    "/api/admin/partners",
    requireAdminAuth,
    express.json(),
    asyncHandler(async (req: express.Request, res: express.Response) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const parsed = createPartnerSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });

      const { userId, companyName, rateLimitOverride, notes } = parsed.data;
      const adminId = getAdminId(req);

      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return res.status(404).json({ error: "User not found" });

      const [existing] = await db.select({ id: partners.id }).from(partners).where(eq(partners.primaryUserId, userId)).limit(1);
      if (existing) return res.status(409).json({ error: "User is already a partner", data: { partnerId: existing.id } });

      const id = crypto.randomUUID();
      const now = Date.now();

      const [partner] = await db.insert(partners).values({
        id,
        companyName,
        primaryUserId: userId,
        status: "active",
        rateLimitOverride: rateLimitOverride ?? null,
        notes: notes ?? null,
        createdAt: now,
        createdBy: adminId,
        updatedAt: now,
      }).returning();

      const backfillResult = await pool.query(
        `UPDATE api_keys SET partner_id = $1 WHERE user_id = $2 AND partner_id IS NULL AND revoked_at IS NULL`,
        [id, userId],
      );
      const backfilledKeys = backfillResult.rowCount ?? 0;
      if (backfilledKeys > 0) {
        log("info", "Backfilled existing API keys to new partner", { partnerId: id, userId, count: backfilledKeys });
      }

      await recordAudit({
        action: "admin:partner:create",
        userId: adminId,
        resource: "partner",
        resourceId: id,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ companyName, userId }),
      });

      log("info", "Partner created", { partnerId: id, companyName, userId, adminId });
      res.status(201).json({ success: true, data: { partner } });
    }),
  );

  app.get(
    "/api/admin/partners/:id",
    requireAdminAuth,
    asyncHandler(async (req: express.Request, res: express.Response) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const [partner] = await db.select().from(partners).where(eq(partners.id, req.params.id)).limit(1);
      if (!partner) return res.status(404).json({ error: "Partner not found" });

      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          scopes: apiKeys.scopes,
          rateLimit: apiKeys.rateLimit,
          requestCount: apiKeys.requestCount,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.partnerId, partner.id))
        .orderBy(desc(apiKeys.createdAt));

      const origins = await db
        .select()
        .from(sdkAllowedOrigins)
        .where(eq(sdkAllowedOrigins.partnerId, partner.id))
        .orderBy(desc(sdkAllowedOrigins.createdAt));

      const recentUsage = await db
        .select()
        .from(partnerUsage)
        .where(eq(partnerUsage.partnerId, partner.id))
        .orderBy(desc(partnerUsage.dayKey))
        .limit(30);

      const [userRow] = await pool.query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1 LIMIT 1`,
        [partner.primaryUserId],
      ).then((r) => r.rows);

      res.json({
        success: true,
        data: {
          partner: { ...partner, primaryEmail: userRow?.email || null },
          keys,
          origins,
          recentUsage,
        },
      });
    }),
  );

  app.patch(
    "/api/admin/partners/:id",
    requireAdminAuth,
    express.json(),
    asyncHandler(async (req: express.Request, res: express.Response) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const [existing] = await db.select().from(partners).where(eq(partners.id, req.params.id)).limit(1);
      if (!existing) return res.status(404).json({ error: "Partner not found" });

      const parsed = updatePartnerSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });

      const adminId = getAdminId(req);
      const updates: Partial<typeof partners.$inferInsert> = { updatedAt: Date.now() };
      if (parsed.data.status !== undefined) updates.status = parsed.data.status;
      if (parsed.data.companyName !== undefined) updates.companyName = parsed.data.companyName;
      if (parsed.data.rateLimitOverride !== undefined) updates.rateLimitOverride = parsed.data.rateLimitOverride;
      if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

      const [updated] = await db.update(partners).set(updates).where(eq(partners.id, req.params.id)).returning();

      await recordAudit({
        action: "admin:partner:update",
        userId: adminId,
        resource: "partner",
        resourceId: req.params.id,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ changes: parsed.data }),
      });

      log("info", "Partner updated", { partnerId: req.params.id, changes: parsed.data, adminId });
      res.json({ success: true, data: { partner: updated } });
    }),
  );
}
