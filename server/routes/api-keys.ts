import express from "express";
import crypto from "crypto";
import { db, pool } from "../db.js";
import { apiKeys } from "../../shared/schema.js";
import { eq, and, isNull, desc } from "drizzle-orm";
import { requireAuthJson, asyncHandler, validateCsrf } from "../lib/middleware.js";
import { generateApiKey, hasApiBusinessAccess } from "../lib/api-key-auth.js";
import { recordAudit } from "../lib/audit.js";
import { z } from "zod";

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional().default(["estimates:read"]),
  rateLimit: z.number().min(10).max(1000).optional().default(100),
  expiresInDays: z.number().min(1).max(365).optional(),
});

const AVAILABLE_SCOPES = [
  "estimates:read",
  "estimates:write",
  "leads:read",
  "usage:read",
];

export function registerApiKeyRoutes(app: express.Express) {
  app.get(
    "/api/developer/keys",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;

      if (!(await hasApiBusinessAccess(userId))) {
        return res.status(403).json({ error: "Developer API access requires a Business plan." });
      }
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
        .where(eq(apiKeys.userId, userId))
        .orderBy(desc(apiKeys.createdAt));

      res.json({ success: true, keys, availableScopes: AVAILABLE_SCOPES });
    }),
  );

  app.post(
    "/api/developer/keys",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;

      // Security: enforce Business-tier entitlement before accepting any input.
      // hasApiBusinessAccess calls getEffectiveSub + isBusinessTier (team-helpers)
      // which resolves team-inherited subscriptions, so members of a Business team
      // are also permitted.
      if (!(await hasApiBusinessAccess(userId))) {
        return res.status(403).json({ error: "Developer API access requires a Business plan." });
      }

      const parsed = createApiKeySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const { name, scopes, rateLimit: limit, expiresInDays } = parsed.data;

      const existingKeys = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));

      if (existingKeys.length >= 5) {
        return res.status(400).json({ error: "Maximum of 5 active API keys allowed" });
      }

      const invalidScopes = scopes.filter((s) => !AVAILABLE_SCOPES.includes(s));
      if (invalidScopes.length > 0) {
        return res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(", ")}` });
      }

      const { key, prefix, hash } = generateApiKey();
      const id = crypto.randomUUID();

      let partnerIdForKey: string | null = null;
      if (pool) {
        const pRes = await pool.query<{ id: string }>(
          `SELECT id FROM partners WHERE primary_user_id = $1 AND status = 'active' LIMIT 1`,
          [userId],
        );
        if (pRes.rows.length > 0) partnerIdForKey = pRes.rows[0].id;
      }

      await db.insert(apiKeys).values({
        id,
        userId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes: scopes.join(","),
        rateLimit: limit,
        expiresAt: expiresInDays ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000 : undefined,
        createdAt: Date.now(),
        ...(partnerIdForKey ? { partnerId: partnerIdForKey } : {}),
      });

      await recordAudit({
        action: "api_key:create",
        userId,
        resource: "api_key",
        resourceId: id,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ name, scopes }),
      });

      res.status(201).json({
        success: true,
        key,
        id,
        name,
        scopes,
        message: "Store this key securely — it will not be shown again.",
      });
    }),
  );

  app.delete(
    "/api/developer/keys/:id",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;
      const keyId = req.params.id;

      const [existing] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
        .limit(1);

      if (!existing) {
        return res.status(404).json({ error: "API key not found" });
      }

      if (existing.revokedAt) {
        return res.status(400).json({ error: "API key already revoked" });
      }

      await db
        .update(apiKeys)
        .set({ revokedAt: Date.now() })
        .where(eq(apiKeys.id, keyId));

      await recordAudit({
        action: "api_key:revoke",
        userId,
        resource: "api_key",
        resourceId: keyId,
        ipAddress: req.ip || req.socket.remoteAddress,
      });

      res.json({ success: true, message: "API key revoked" });
    }),
  );
}
