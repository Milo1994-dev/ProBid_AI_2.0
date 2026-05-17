import express from "express";
import crypto from "crypto";
import { db } from "../db.js";
import { webhooks, webhookDeliveries } from "../../shared/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuthJson, asyncHandler, validateCsrf } from "../lib/middleware.js";
import { recordAudit } from "../lib/audit.js";
import { now } from "../lib/utils.js";
import { z } from "zod";
import {
  WEBHOOK_EVENTS,
  generateWebhookSecret,
  attemptDelivery,
  signPayload,
  validateWebhookUrl,
  DELIVERY_STATUS,
  type WebhookEvent,
} from "../lib/webhook-delivery.js";

const eventEnum = z.enum(WEBHOOK_EVENTS as readonly [string, ...string[]]);

// URL syntax check only — the SSRF / private-IP / scheme guard runs in
// `validateWebhookUrl` so it can be applied identically to both create
// and update.
const urlField = z.string().min(1).url().max(2048);

const createWebhookSchema = z.object({
  url: urlField,
  events: z.array(eventEnum).min(1, "Subscribe to at least one event"),
  description: z.string().max(200).optional(),
});

const updateWebhookSchema = z.object({
  url: urlField.optional(),
  events: z.array(eventEnum).min(1).optional(),
  description: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

const MAX_WEBHOOKS_PER_USER = 5;

export function registerWebhookRoutes(app: express.Express) {
  // GET /api/developer/webhooks — list this user's webhook subscriptions.
  app.get(
    "/api/developer/webhooks",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;
      const rows = await db
        .select({
          id: webhooks.id,
          url: webhooks.url,
          events: webhooks.events,
          description: webhooks.description,
          enabled: webhooks.enabled,
          lastStatus: webhooks.lastStatus,
          lastStatusCode: webhooks.lastStatusCode,
          lastError: webhooks.lastError,
          lastDeliveredAt: webhooks.lastDeliveredAt,
          successCount: webhooks.successCount,
          failureCount: webhooks.failureCount,
          revokedAt: webhooks.revokedAt,
          createdAt: webhooks.createdAt,
          updatedAt: webhooks.updatedAt,
        })
        .from(webhooks)
        .where(eq(webhooks.userId, userId))
        .orderBy(desc(webhooks.createdAt));

      res.json({
        success: true,
        webhooks: rows.map((w) => ({
          ...w,
          events: (w.events || "").split(",").filter(Boolean),
        })),
        availableEvents: WEBHOOK_EVENTS,
      });
    }),
  );

  // POST /api/developer/webhooks — register a new endpoint. Returns the
  // signing secret exactly once; it is hashed nowhere (HMAC needs the raw
  // bytes) but we never re-emit it after creation.
  app.post(
    "/api/developer/webhooks",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const parsed = createWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid input",
          details: parsed.error.flatten(),
        });
      }

      // Run the deeper URL guard (scheme, credentials, private/loopback
      // resolution) before we count quotas or write anything.
      const urlCheck = await validateWebhookUrl(parsed.data.url);
      if (urlCheck.ok !== true) {
        return res.status(400).json({ success: false, error: urlCheck.error });
      }

      const userId = (req as any).session.uid;
      const existing = await db
        .select({ id: webhooks.id })
        .from(webhooks)
        .where(and(eq(webhooks.userId, userId), eq(webhooks.enabled, true)));
      if (existing.length >= MAX_WEBHOOKS_PER_USER) {
        return res.status(400).json({
          success: false,
          error: `Maximum of ${MAX_WEBHOOKS_PER_USER} active webhooks allowed`,
        });
      }

      const id = crypto.randomUUID();
      const secret = generateWebhookSecret();
      const ts = now();

      await db.insert(webhooks).values({
        id,
        userId,
        url: parsed.data.url,
        secret,
        events: parsed.data.events.join(","),
        description: parsed.data.description ?? null,
        enabled: true,
        createdAt: ts,
        updatedAt: ts,
      });

      await recordAudit({
        action: "webhook:create",
        userId,
        resource: "webhook",
        resourceId: id,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify({ url: parsed.data.url, events: parsed.data.events }),
      });

      res.status(201).json({
        success: true,
        webhook: {
          id,
          url: parsed.data.url,
          events: parsed.data.events,
          description: parsed.data.description ?? null,
          enabled: true,
        },
        secret,
        message:
          "Store this signing secret securely — it is required to verify the X-ProBid-Signature header and will not be shown again.",
      });
    }),
  );

  // PATCH /api/developer/webhooks/:id — update url / events / description / enabled.
  app.patch(
    "/api/developer/webhooks/:id",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;
      const id = req.params.id;
      const [existing] = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
        .limit(1);
      if (!existing) return res.status(404).json({ success: false, error: "Webhook not found" });
      if (existing.revokedAt) {
        return res.status(400).json({ success: false, error: "Cannot edit a revoked webhook" });
      }

      const parsed = updateWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid input",
        });
      }

      // PATCH must use the same SSRF guard as create — otherwise a partner
      // could create a public-https webhook and then PATCH it to point at
      // localhost or a metadata service.
      if (parsed.data.url !== undefined) {
        const urlCheck = await validateWebhookUrl(parsed.data.url);
        if (urlCheck.ok !== true) {
          return res.status(400).json({ success: false, error: urlCheck.error });
        }
      }

      const updates: Record<string, unknown> = { updatedAt: now() };
      if (parsed.data.url !== undefined) updates.url = parsed.data.url;
      if (parsed.data.events !== undefined) updates.events = parsed.data.events.join(",");
      if (parsed.data.description !== undefined) updates.description = parsed.data.description;
      if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;

      await db.update(webhooks).set(updates).where(eq(webhooks.id, id));

      await recordAudit({
        action: "webhook:update",
        userId,
        resource: "webhook",
        resourceId: id,
        ipAddress: req.ip || req.socket.remoteAddress,
        details: JSON.stringify(parsed.data),
      });

      res.json({ success: true });
    }),
  );

  // DELETE /api/developer/webhooks/:id — soft-revoke. We keep the row so
  // the deliveries audit trail stays intact and so we can show partners
  // what was revoked & when.
  app.delete(
    "/api/developer/webhooks/:id",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;
      const id = req.params.id;
      const [existing] = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
        .limit(1);
      if (!existing) return res.status(404).json({ success: false, error: "Webhook not found" });
      if (existing.revokedAt) {
        return res.status(400).json({ success: false, error: "Webhook already revoked" });
      }

      const ts = now();
      await db
        .update(webhooks)
        .set({ revokedAt: ts, enabled: false, updatedAt: ts })
        .where(eq(webhooks.id, id));

      await recordAudit({
        action: "webhook:revoke",
        userId,
        resource: "webhook",
        resourceId: id,
        ipAddress: req.ip || req.socket.remoteAddress,
      });

      res.json({ success: true });
    }),
  );

  // POST /api/developer/webhooks/:id/test — fire a test event so partners
  // can verify their endpoint without waiting for a real estimate to land.
  app.post(
    "/api/developer/webhooks/:id/test",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;
      const id = req.params.id;
      const [webhook] = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
        .limit(1);
      if (!webhook) return res.status(404).json({ success: false, error: "Webhook not found" });
      if (webhook.revokedAt || !webhook.enabled) {
        return res.status(400).json({ success: false, error: "Webhook is not active" });
      }

      const event: WebhookEvent = "estimate.created";
      const ts = now();
      const deliveryId = crypto.randomUUID();
      const payload = JSON.stringify({
        id: deliveryId,
        event,
        createdAt: ts,
        test: true,
        data: {
          estimateId: "test_" + crypto.randomBytes(6).toString("hex"),
          jobType: "Test Job",
          market: "Test Market",
        },
      });

      await db.insert(webhookDeliveries).values({
        id: deliveryId,
        webhookId: webhook.id,
        userId,
        event,
        payload,
        status: DELIVERY_STATUS.RETRYING,
        attempts: 0,
        nextAttemptAt: ts,
        createdAt: ts,
      });

      const result = await attemptDelivery(deliveryId, webhook, payload);
      res.json({
        success: true,
        delivered: result.ok,
        responseStatus: result.status ?? null,
        deliveryId,
      });
    }),
  );

  // GET /api/developer/webhooks/:id/deliveries — last 50 attempts for the UI.
  app.get(
    "/api/developer/webhooks/:id/deliveries",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database not configured" });

      const userId = (req as any).session.uid;
      const id = req.params.id;
      const [webhook] = await db
        .select({ id: webhooks.id })
        .from(webhooks)
        .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
        .limit(1);
      if (!webhook) return res.status(404).json({ success: false, error: "Webhook not found" });

      const rows = await db
        .select({
          id: webhookDeliveries.id,
          event: webhookDeliveries.event,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          responseStatus: webhookDeliveries.responseStatus,
          error: webhookDeliveries.error,
          nextAttemptAt: webhookDeliveries.nextAttemptAt,
          lastAttemptAt: webhookDeliveries.lastAttemptAt,
          deliveredAt: webhookDeliveries.deliveredAt,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, id))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(50);

      res.json({ success: true, deliveries: rows });
    }),
  );
}

// Re-exported so tests / docs can import the helpers without reaching into the lib.
export { signPayload, generateWebhookSecret };
