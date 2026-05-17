import express from "express";
import { db } from "../../db.js";
import { eq, and, sql } from "drizzle-orm";
import {
  scrapedLeads,
  leadOutreachQueue,
  emailDripQueue,
} from "../../../shared/schema.js";
import { asyncHandler } from "../../lib/middleware.js";
import { log } from "../../lib/logger.js";
import { APP_URL } from "../../lib/config.js";
import { TRACKING_PIXEL } from "../../lib/outreach-templates.js";
import { computeScore, deriveStage } from "../../lead-engine.js";
import { generateUnsubToken } from "../../lib/email-helpers.js";

export function registerTrackingRoutes(app: express.Application) {
// GET /api/track/open/:token — tracking pixel (1×1 GIF), records openedAt
app.get(
  "/api/track/open/:token",
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const nowMs = Date.now();

    const rows = await db
      .select({ leadId: leadOutreachQueue.leadId })
      .from(leadOutreachQueue)
      .where(eq(leadOutreachQueue.openToken, token))
      .limit(1);

    if (rows.length > 0) {
      const { leadId } = rows[0];
      const [updated] = await db
        .update(scrapedLeads)
        .set({ openedAt: nowMs, updatedAt: nowMs })
        .where(and(eq(scrapedLeads.id, leadId), sql`opened_at IS NULL`))
        .returning();
      if (updated) {
        const score = computeScore({ ...updated, contacted: true });
        const stage = deriveStage({ ...updated, contacted: true });
        await db
          .update(scrapedLeads)
          .set({ score, stage, updatedAt: nowMs })
          .where(eq(scrapedLeads.id, leadId));
        log("info", "Outreach pixel open recorded", {
          leadId,
          source: "pixel",
        });
      }
    } else {
      log("info", "Outreach open pixel hit with unknown token", {
        token: token.slice(0, 8),
      });
    }

    res.set({
      "Content-Type": "image/gif",
      "Content-Length": TRACKING_PIXEL.length,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(TRACKING_PIXEL);
  }),
);

// GET /api/track/click/:token — tracked CTA redirect, records clickedAt
app.get(
  "/api/track/click/:token",
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const nowMs = Date.now();

    const rows = await db
      .select({ leadId: leadOutreachQueue.leadId })
      .from(leadOutreachQueue)
      .where(eq(leadOutreachQueue.clickToken, token))
      .limit(1);

    if (rows.length > 0) {
      const { leadId } = rows[0];
      const [clickUpdated] = await db
        .update(scrapedLeads)
        .set({ clickedAt: nowMs, updatedAt: nowMs })
        .where(and(eq(scrapedLeads.id, leadId), sql`clicked_at IS NULL`))
        .returning();
      if (clickUpdated) {
        const score = computeScore({ ...clickUpdated, contacted: true });
        const stage = deriveStage({ ...clickUpdated, contacted: true });
        await db
          .update(scrapedLeads)
          .set({ score, stage, updatedAt: nowMs })
          .where(eq(scrapedLeads.id, leadId));
        log("info", "Outreach link click recorded", {
          leadId,
          source: "redirect",
        });
      }
    } else {
      log("info", "Outreach click endpoint hit with unknown token", {
        token: token.slice(0, 8),
      });
    }

    res.redirect(302, `${APP_URL}/signup`);
  }),
);

// GET /api/unsubscribe/:token — one-click opt-out (token is per-queue-item)
app.get(
  "/api/unsubscribe/:token",
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const nowMs = Date.now();

    // Check per-email queue token first (primary path)
    const queueRows = await db
      .select({ leadId: leadOutreachQueue.leadId })
      .from(leadOutreachQueue)
      .where(eq(leadOutreachQueue.unsubscribeToken, token))
      .limit(1);

    const applyUnsub = async (leadId: string) => {
      const [unsubUpdated] = await db
        .update(scrapedLeads)
        .set({ doNotContact: true, stage: "do_not_contact", updatedAt: nowMs })
        .where(eq(scrapedLeads.id, leadId))
        .returning();
      if (unsubUpdated) {
        const score = computeScore({ ...unsubUpdated, contacted: true });
        await db
          .update(scrapedLeads)
          .set({ score, updatedAt: nowMs })
          .where(eq(scrapedLeads.id, leadId));
      }
      await db
        .update(leadOutreachQueue)
        .set({ status: "suppressed", sentAt: new Date(nowMs).toISOString() })
        .where(
          and(
            eq(leadOutreachQueue.leadId, leadId),
            eq(leadOutreachQueue.status, "pending"),
          ),
        );
    };

    if (queueRows.length > 0) {
      await applyUnsub(queueRows[0].leadId);
    } else {
      // Fallback: check per-lead token for older records
      const leadRows = await db
        .select({ id: scrapedLeads.id })
        .from(scrapedLeads)
        .where(eq(scrapedLeads.unsubscribeToken, token))
        .limit(1);

      if (leadRows.length > 0) {
        await applyUnsub(leadRows[0].id);
      }
    }

    res.type("html").send(`
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
<style>body{font-family:Arial,sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border-radius:12px;padding:40px;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h2{color:#111827;margin:0 0 12px}p{color:#6b7280;margin:0}</style></head>
<body><div class="box"><h2>You've been unsubscribed</h2>
<p>You will not receive any further emails from ProBid AI. If this was a mistake, contact us at support@probidcore.net.</p>
</div></body></html>`);
  }),
);

// --- Onboarding Unsubscribe Endpoint ---
app.get(
  "/api/unsubscribe-drip",
  asyncHandler(async (req, res) => {
    const { email, token } = req.query as { email?: string; token?: string };
    if (!email || !token) {
      return res.status(400).send("Invalid unsubscribe link.");
    }
    const expected = generateUnsubToken(email.toLowerCase());
    if (token !== expected) {
      return res.status(400).send("Invalid or expired unsubscribe link.");
    }
    await db
      .update(emailDripQueue)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(emailDripQueue.email, email.toLowerCase()),
          eq(emailDripQueue.status, "pending"),
        ),
      );
    await db.insert(emailDripQueue).values({
      email: email.toLowerCase(),
      templateKey: "global_unsubscribe",
      scheduledFor: new Date().toISOString(),
      status: "cancelled",
      createdAt: new Date().toISOString(),
    }).onConflictDoNothing();
    log("info", "All drip emails cancelled via unsubscribe + global flag set", { email });
    res.send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title><style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}div{background:#fff;padding:40px;border-radius:10px;text-align:center;max-width:400px;}</style></head><body><div><h2 style="color:#22c55e;">You've been unsubscribed</h2><p style="color:#666;">You won't receive any more marketing emails from ProBid AI. Your account remains active.</p><a href="${APP_URL}/app" style="color:#22c55e;">Return to dashboard</a></div></body></html>`,
    );
  }),
);
}
