import express from "express";
import crypto from "crypto";
import { db, pool } from "../db.js";
import { partners, apiKeys, sdkAllowedOrigins, partnerUsage } from "../../shared/schema.js";
import { eq, and, isNull, desc, sum, gte } from "drizzle-orm";
import { requireAuthJson, asyncHandler, validateCsrf } from "../lib/middleware.js";
import { generateApiKey } from "../lib/api-key-auth.js";
import { parseAllowlistEntry, isParsedEntrySuccess, bumpSdkAllowlistCache } from "../lib/cors.js";
import { recordAudit } from "../lib/audit.js";
import { log } from "../lib/logger.js";
import { z } from "zod";

async function getPartnerForUser(userId: string) {
  if (!db) return null;
  const [partner] = await db
    .select()
    .from(partners)
    .where(eq(partners.primaryUserId, userId))
    .limit(1);
  return partner || null;
}

export async function incrementPartnerUsage(opts: {
  partnerId: string;
  apiKeyId: string | null;
  field: "estimatesSdk" | "estimatesApi" | "errors" | "rateLimitHits";
}): Promise<void> {
  if (!pool) return;
  const dk = new Date().toISOString().slice(0, 10);
  const { partnerId, apiKeyId, field } = opts;
  const colMap = {
    estimatesSdk: "estimates_sdk",
    estimatesApi: "estimates_api",
    errors: "errors",
    rateLimitHits: "rate_limit_hits",
  } as const;
  const col = colMap[field];
  const now = Date.now();
  try {
    await pool.query(
      `INSERT INTO partner_usage (partner_id, api_key_id, day_key, ${col}, updated_at)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (partner_id, COALESCE(api_key_id, ''), day_key)
       DO UPDATE SET ${col} = partner_usage.${col} + 1, updated_at = $4`,
      [partnerId, apiKeyId, dk, now],
    );
  } catch (err) {
    log("warn", "incrementPartnerUsage failed (non-critical)", { error: String(err) });
  }
}

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional().default(["estimates:read", "estimates:write"]),
  rateLimit: z.number().min(10).max(10000).optional().default(100),
  expiresInDays: z.number().min(1).max(365).optional(),
});

const PARTNER_SCOPES = [
  "estimates:read",
  "estimates:write",
  "leads:read",
  "usage:read",
];

const MAX_PARTNER_KEYS = 10;

export function registerPartnerRoutes(app: express.Express) {
  app.get(
    "/api/partner/me",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(404).json({ error: "No partner account linked to this user" });
      res.json({ success: true, partner });
    }),
  );

  app.get(
    "/api/partner/keys",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });
      if (partner.status === "suspended") return res.status(403).json({ error: "Partner account suspended" });

      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          scopes: apiKeys.scopes,
          rateLimit: apiKeys.rateLimit,
          lastUsedAt: apiKeys.lastUsedAt,
          requestCount: apiKeys.requestCount,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.partnerId, partner.id))
        .orderBy(desc(apiKeys.createdAt));

      res.json({ success: true, keys, availableScopes: PARTNER_SCOPES });
    }),
  );

  app.post(
    "/api/partner/keys",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });
      if (partner.status === "suspended") return res.status(403).json({ error: "Partner account suspended" });

      const parsed = createKeySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });

      const { name, scopes, rateLimit, expiresInDays } = parsed.data;
      const effectiveLimit = partner.rateLimitOverride ?? rateLimit;

      const invalidScopes = scopes.filter((s) => !PARTNER_SCOPES.includes(s));
      if (invalidScopes.length > 0) return res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(", ")}` });

      const existing = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.partnerId, partner.id), isNull(apiKeys.revokedAt)));
      if (existing.length >= MAX_PARTNER_KEYS) return res.status(400).json({ error: `Maximum of ${MAX_PARTNER_KEYS} active API keys allowed` });

      const { key, prefix, hash } = generateApiKey();
      const id = crypto.randomUUID();

      await db.insert(apiKeys).values({
        id,
        userId,
        partnerId: partner.id,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes: scopes.join(","),
        rateLimit: effectiveLimit,
        expiresAt: expiresInDays ? Date.now() + expiresInDays * 86400000 : undefined,
        createdAt: Date.now(),
      });

      await recordAudit({
        action: "partner_key:create",
        userId,
        resource: "api_key",
        resourceId: id,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ partnerId: partner.id, name, scopes }),
      });

      res.status(201).json({ success: true, key, id, name, scopes, message: "Store this key securely — it will not be shown again." });
    }),
  );

  app.delete(
    "/api/partner/keys/:id",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });

      const keyId = req.params.id;
      const [existing] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.partnerId, partner.id)))
        .limit(1);

      if (!existing) return res.status(404).json({ error: "API key not found" });
      if (existing.revokedAt) return res.status(400).json({ error: "API key already revoked" });

      await db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, keyId));

      await recordAudit({
        action: "partner_key:revoke",
        userId,
        resource: "api_key",
        resourceId: keyId,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ partnerId: partner.id }),
      });

      res.json({ success: true, message: "API key revoked" });
    }),
  );

  app.post(
    "/api/partner/keys/:id/rotate",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });

      const keyId = req.params.id;
      const [existing] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.partnerId, partner.id)))
        .limit(1);

      if (!existing) return res.status(404).json({ error: "API key not found" });
      if (existing.revokedAt) return res.status(400).json({ error: "Cannot rotate a revoked key" });

      await db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, keyId));

      const { key, prefix, hash } = generateApiKey();
      const newId = crypto.randomUUID();
      await db.insert(apiKeys).values({
        id: newId,
        userId,
        partnerId: partner.id,
        name: existing.name + " (rotated)",
        keyHash: hash,
        keyPrefix: prefix,
        scopes: existing.scopes,
        rateLimit: existing.rateLimit,
        createdAt: Date.now(),
      });

      await recordAudit({
        action: "partner_key:rotate",
        userId,
        resource: "api_key",
        resourceId: keyId,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ partnerId: partner.id, newKeyId: newId }),
      });

      res.json({ success: true, key, id: newId, message: "New key created. Old key is now revoked. Store this key securely — it will not be shown again." });
    }),
  );

  app.get(
    "/api/partner/origins",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });

      const origins = await db
        .select()
        .from(sdkAllowedOrigins)
        .where(eq(sdkAllowedOrigins.partnerId, partner.id))
        .orderBy(desc(sdkAllowedOrigins.createdAt));

      res.json({ success: true, origins });
    }),
  );

  app.post(
    "/api/partner/origins",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });
      if (partner.status === "suspended") return res.status(403).json({ error: "Partner account suspended" });

      const { origin: rawOrigin, note: rawNote } = (req.body ?? {}) as { origin?: unknown; note?: unknown };
      const parsedEntry = parseAllowlistEntry(rawOrigin);
      if (!isParsedEntrySuccess(parsedEntry)) return res.status(400).json({ error: parsedEntry.reason });

      const note = typeof rawNote === "string" && rawNote.trim() ? rawNote.trim().slice(0, 500) : null;

      const [existing] = await db
        .select()
        .from(sdkAllowedOrigins)
        .where(and(eq(sdkAllowedOrigins.origin, parsedEntry.normalized), eq(sdkAllowedOrigins.partnerId, partner.id)))
        .limit(1);

      if (existing) {
        if (!existing.revokedAt) return res.status(409).json({ error: "Origin already on your allowlist", data: { id: existing.id } });
        const [updated] = await db
          .update(sdkAllowedOrigins)
          .set({ revokedAt: null, revokedBy: null, note: note ?? existing.note })
          .where(eq(sdkAllowedOrigins.id, existing.id))
          .returning();
        bumpSdkAllowlistCache();
        return res.json({ success: true, data: { entry: updated } });
      }

      const [inserted] = await db
        .insert(sdkAllowedOrigins)
        .values({
          origin: parsedEntry.normalized,
          kind: parsedEntry.kind,
          partnerId: partner.id,
          note,
          createdAt: Date.now(),
          createdBy: userId,
        })
        .returning();

      bumpSdkAllowlistCache();

      await recordAudit({
        action: "partner_origin:add",
        userId,
        resource: "sdk_allowed_origins",
        resourceId: String(inserted.id),
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ partnerId: partner.id, origin: parsedEntry.normalized }),
      });

      res.status(201).json({ success: true, data: { entry: inserted } });
    }),
  );

  app.delete(
    "/api/partner/origins/:id",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });

      const [existing] = await db
        .select()
        .from(sdkAllowedOrigins)
        .where(and(eq(sdkAllowedOrigins.id, id), eq(sdkAllowedOrigins.partnerId, partner.id)))
        .limit(1);

      if (!existing) return res.status(404).json({ error: "Origin not found" });
      if (existing.revokedAt) return res.status(409).json({ error: "Origin already revoked" });

      await db.update(sdkAllowedOrigins).set({ revokedAt: Date.now(), revokedBy: userId }).where(eq(sdkAllowedOrigins.id, id));
      bumpSdkAllowlistCache();

      await recordAudit({
        action: "partner_origin:revoke",
        userId,
        resource: "sdk_allowed_origins",
        resourceId: String(id),
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ partnerId: partner.id, origin: existing.origin }),
      });

      res.json({ success: true });
    }),
  );

  app.get(
    "/api/partner/usage",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });
      const userId = (req as any).session.uid;
      const partner = await getPartnerForUser(userId);
      if (!partner) return res.status(403).json({ error: "Not a partner account" });

      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + "-01";

      const [todayRow] = await db
        .select({
          estimatesSdk: sum(partnerUsage.estimatesSdk),
          estimatesApi: sum(partnerUsage.estimatesApi),
          errors: sum(partnerUsage.errors),
          rateLimitHits: sum(partnerUsage.rateLimitHits),
        })
        .from(partnerUsage)
        .where(and(eq(partnerUsage.partnerId, partner.id), eq(partnerUsage.dayKey, today)));

      const [monthRow] = await db
        .select({
          estimatesSdk: sum(partnerUsage.estimatesSdk),
          estimatesApi: sum(partnerUsage.estimatesApi),
          errors: sum(partnerUsage.errors),
          rateLimitHits: sum(partnerUsage.rateLimitHits),
        })
        .from(partnerUsage)
        .where(and(eq(partnerUsage.partnerId, partner.id), gte(partnerUsage.dayKey, monthStart)));

      const recentDays = await db
        .select({
          dayKey: partnerUsage.dayKey,
          apiKeyId: partnerUsage.apiKeyId,
          estimatesSdk: partnerUsage.estimatesSdk,
          estimatesApi: partnerUsage.estimatesApi,
          errors: partnerUsage.errors,
          rateLimitHits: partnerUsage.rateLimitHits,
        })
        .from(partnerUsage)
        .where(eq(partnerUsage.partnerId, partner.id))
        .orderBy(desc(partnerUsage.dayKey))
        .limit(30);

      const keyUsage = await db
        .select({
          apiKeyId: partnerUsage.apiKeyId,
          estimatesApi: sum(partnerUsage.estimatesApi),
          errors: sum(partnerUsage.errors),
        })
        .from(partnerUsage)
        .where(and(eq(partnerUsage.partnerId, partner.id), gte(partnerUsage.dayKey, monthStart)))
        .groupBy(partnerUsage.apiKeyId);

      res.json({
        success: true,
        data: {
          today: {
            estimatesSdk: Number(todayRow?.estimatesSdk || 0),
            estimatesApi: Number(todayRow?.estimatesApi || 0),
            errors: Number(todayRow?.errors || 0),
            rateLimitHits: Number(todayRow?.rateLimitHits || 0),
          },
          thisMonth: {
            estimatesSdk: Number(monthRow?.estimatesSdk || 0),
            estimatesApi: Number(monthRow?.estimatesApi || 0),
            errors: Number(monthRow?.errors || 0),
            rateLimitHits: Number(monthRow?.rateLimitHits || 0),
          },
          recentDays,
          keyUsage,
        },
      });
    }),
  );
}
