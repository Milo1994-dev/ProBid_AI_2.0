import express from "express";
import { db, pool } from "../../db.js";
import { eq, and, count, gte, sql } from "drizzle-orm";
import {
  scrapedLeads,
  leadOutreachQueue,
  leadEmailAuditLog,
} from "../../../shared/schema.js";
import { asyncHandler } from "../../lib/middleware.js";
import { log } from "../../lib/logger.js";
import { setPausedState, verifyResendWebhook } from "../../lib/outreach-helpers.js";
import { getResendClient, sendEmailWithRetry } from "../../resend-client.js";
import { computeScore, deriveStage } from "../../lead-engine.js";
import { sendAdminSmsAlert } from "../../lib/email-helpers.js";
import { escapeHtml } from "../../lib/utils.js";
import { ADMIN_EMAIL } from "./_shared.js";

export function registerWebhooksRoutes(app: express.Application) {
// POST /api/webhooks/resend — handle Resend bounce / reply events
// Resend sends events as JSON POST to this URL (configured in Resend dashboard)
// Body is parsed by global express.json(); raw bytes are stored on req.rawBody for signature verification.
app.post(
  "/api/webhooks/resend",
  asyncHandler(async (req, res) => {
    const rawBody: Buffer =
      (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body));
    // Verify signature before processing
    if (
      !verifyResendWebhook(
        rawBody,
        req.headers as Record<string, string | undefined>,
      )
    ) {
      log("warn", "Resend webhook signature verification failed — rejected");
      return res
        .status(401)
        .json({ success: false, error: "Invalid webhook signature" });
    }

    const payload = req.body as {
      type?: string;
      data?: {
        email?: { to?: string[]; from?: string; subject?: string };
        bounce?: { type?: string };
      };
    };
    const eventType = payload?.type ?? "";
    const toEmails: string[] = payload?.data?.email?.to ?? [];
    const nowMs = Date.now();

    log("info", "Resend webhook event received", {
      eventType,
      recipientCount: toEmails.length,
    });

    // Stamp last-event timestamp so the health dashboard can show webhook
    // liveness ("Resend last contacted us at ..."). Fire-and-forget; never
    // block the webhook response on this diagnostic.
    pool
      .query(
        `INSERT INTO lead_outreach_config (key, value)
         VALUES ('resend_webhook_last_event', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify({ ts: new Date(nowMs).toISOString(), type: eventType })],
      )
      .catch((err) =>
        log("warn", "resend_webhook_last_event stamp failed", {
          error: err?.message,
        }),
      );

    if (eventType === "email.bounced") {
      const bounceType = payload?.data?.bounce?.type ?? "hard";
      log("warn", "Resend bounce received", { type: bounceType, to: toEmails });

      for (const email of toEmails) {
        const norm = email.trim().toLowerCase();
        const leadRows = await db
          .select({ id: scrapedLeads.id })
          .from(scrapedLeads)
          .where(eq(scrapedLeads.email, norm))
          .limit(1);

        if (bounceType === "hard" && leadRows.length > 0) {
          // Hard bounce — suppress permanently
          await db
            .update(scrapedLeads)
            .set({ doNotContact: true, updatedAt: nowMs })
            .where(eq(scrapedLeads.id, leadRows[0].id));
        }
        if (leadRows.length > 0) {
          await db
            .insert(leadEmailAuditLog)
            .values({
              leadId: leadRows[0].id,
              templateId: "n/a",
              subject: "BOUNCE EVENT",
              status: `bounced_${bounceType}`,
              sentAt: new Date(nowMs).toISOString(),
            })
            .catch(err => log("warn", "bounce audit log insert failed", { error: err?.message }));
        }
      }

      // Count hard bounces in last 24h — pause if bounce rate is high
      const recentBouncesSince = new Date(nowMs - 86400_000).toISOString();
      const hardBouncesResult = await db
        .select({ c: count() })
        .from(leadEmailAuditLog)
        .where(
          and(
            eq(leadEmailAuditLog.status, "bounced_hard"),
            gte(leadEmailAuditLog.sentAt, recentBouncesSince),
          ),
        );
      const recentSentResult = await db
        .select({ c: count() })
        .from(leadEmailAuditLog)
        .where(
          and(
            eq(leadEmailAuditLog.status, "sent"),
            gte(leadEmailAuditLog.sentAt, recentBouncesSince),
          ),
        );
      const hardBounces = Number(hardBouncesResult[0]?.c ?? 0);
      const recentSent = Number(recentSentResult[0]?.c ?? 0);

      if (
        hardBounces >= 3 &&
        recentSent > 0 &&
        hardBounces / recentSent > 0.05
      ) {
        const bounceReason = `Hard bounce rate ${Math.round((hardBounces / recentSent) * 100)}% (${hardBounces}/${recentSent}) in last 24h exceeds 5% threshold`;
        await setPausedState(true, bounceReason);
        log("warn", "Outreach paused due to bounce rate", {
          reason: bounceReason,
        });
      }
    } else if (eventType === "email.complained") {
      // Spam complaint — suppress the address and pause outreach
      for (const email of toEmails) {
        const norm = email.trim().toLowerCase();
        await db
          .update(scrapedLeads)
          .set({ doNotContact: true, updatedAt: nowMs })
          .where(eq(scrapedLeads.email, norm));
        log("warn", "Spam complaint — lead suppressed", { email: norm });
      }
      await setPausedState(
        true,
        `Spam complaint received from: ${toEmails.join(", ")}`,
      );
    } else if (eventType === "email.replied") {
      // Reply from lead — mark repliedAt, update stage/score, suppress pending queue
      for (const email of toEmails) {
        const norm = email.trim().toLowerCase();
        const [replyUpdated] = await db
          .update(scrapedLeads)
          .set({ repliedAt: nowMs, updatedAt: nowMs })
          .where(and(eq(scrapedLeads.email, norm), sql`replied_at IS NULL`))
          .returning();
        if (replyUpdated) {
          const score = computeScore({ ...replyUpdated, contacted: true });
          const stage = deriveStage({ ...replyUpdated, contacted: true });
          await db
            .update(scrapedLeads)
            .set({ score, stage, updatedAt: nowMs })
            .where(eq(scrapedLeads.id, replyUpdated.id));
          await db
            .update(leadOutreachQueue)
            .set({ status: "suppressed", sentAt: new Date(nowMs).toISOString() })
            .where(
              and(
                eq(leadOutreachQueue.leadId, replyUpdated.id),
                eq(leadOutreachQueue.status, "pending"),
              ),
            );
          log("info", "Lead reply received — pending queue suppressed", { email: norm });

          // Send instant SMS alert to admin
          await sendAdminSmsAlert(
            `🔥 Hot Lead Replied: ${replyUpdated.name || norm}${replyUpdated.location ? ` (${replyUpdated.location})` : ""} — reply to ${replyUpdated.email || norm}`
          );

          // Send instant notification email to admin
          if (ADMIN_EMAIL) {
            try {
              const { client: resend, fromEmail } = await getResendClient();
              const leadName = escapeHtml(replyUpdated.name || "Unknown Business");
              const leadEmail = escapeHtml(replyUpdated.email || norm);
              const leadLocation = escapeHtml(replyUpdated.location || "");
              const leadBizType = escapeHtml(replyUpdated.businessType || "");
              const replySubject = encodeURIComponent("Re: Your inquiry about ProBid AI");
              const replyBody = encodeURIComponent(`Hi ${replyUpdated.name || "there"},\n\nThanks for getting back to us! I wanted to personally follow up...\n\nBest,\nProBid AI Team`);
              const mailtoLink = `mailto:${leadEmail}?subject=${replySubject}&body=${replyBody}`;
              const adminUrl = `${process.env.APP_URL || ""}/admin`;
              await sendEmailWithRetry(
                resend,
                {
                  from: fromEmail,
                  to: ADMIN_EMAIL,
                  subject: `🔥 New Lead Reply: ${replyUpdated.name || norm}`,
                  html: `
                  <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0a0e1a;color:#e8f0ff;padding:32px;border-radius:12px">
                    <div style="font-size:22px;font-weight:700;margin-bottom:4px">🔥 Hot Lead Replied</div>
                    <div style="font-size:13px;color:#94a3b8;margin-bottom:24px">Reply while they're warm — this is your best conversion window.</div>
                    <div style="background:rgba(255,255,255,0.05);border-radius:10px;padding:18px 20px;margin-bottom:24px">
                      <div style="font-size:16px;font-weight:700;margin-bottom:6px">${leadName}</div>
                      ${leadBizType ? `<div style="font-size:13px;color:#94a3b8;margin-bottom:2px">${leadBizType}</div>` : ""}
                      ${leadLocation ? `<div style="font-size:13px;color:#94a3b8;margin-bottom:2px">📍 ${leadLocation}</div>` : ""}
                      <div style="font-size:13px;color:#94a3b8;margin-top:4px">✉ ${leadEmail}</div>
                    </div>
                    <a href="${mailtoLink}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;margin-right:10px">✉ Reply Now</a>
                    <a href="${adminUrl}" style="display:inline-block;background:rgba(255,255,255,0.08);color:#e8f0ff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">View All Hot Leads</a>
                    <div style="font-size:11px;color:#94a3b8;margin-top:24px">Sent by ProBid AI lead system</div>
                  </div>`,
                },
                {
                  idempotencyKey: `lead-reply-notify/${replyUpdated.id}`,
                  logContext: { leadId: replyUpdated.id, email: norm },
                },
              );
              log("info", "Admin notified of lead reply", { to: ADMIN_EMAIL, lead: norm });
            } catch (notifyErr) {
              log("warn", "Failed to send admin lead-reply notification", { err: String(notifyErr) });
            }
          }
        }
      }
    } else if (eventType === "email.opened") {
      // Resend reports an open — record on the matching lead (idempotent).
      // We match by recipient email because Resend events don't carry our queue tokens.
      for (const email of toEmails) {
        const norm = email.trim().toLowerCase();
        const [openUpdated] = await db
          .update(scrapedLeads)
          .set({ openedAt: nowMs, updatedAt: nowMs })
          .where(and(eq(scrapedLeads.email, norm), sql`opened_at IS NULL`))
          .returning();
        if (openUpdated) {
          const score = computeScore({ ...openUpdated, contacted: true });
          const stage = deriveStage({ ...openUpdated, contacted: true });
          await db
            .update(scrapedLeads)
            .set({ score, stage, updatedAt: nowMs })
            .where(eq(scrapedLeads.id, openUpdated.id));
          log("info", "Resend open recorded", {
            email: norm,
            leadId: openUpdated.id,
            source: "webhook",
          });
        }
      }
    } else if (eventType === "email.clicked") {
      // Resend reports a link click — record on the matching lead (idempotent).
      for (const email of toEmails) {
        const norm = email.trim().toLowerCase();
        const [clickUpdated] = await db
          .update(scrapedLeads)
          .set({ clickedAt: nowMs, updatedAt: nowMs })
          .where(and(eq(scrapedLeads.email, norm), sql`clicked_at IS NULL`))
          .returning();
        if (clickUpdated) {
          const score = computeScore({ ...clickUpdated, contacted: true });
          const stage = deriveStage({ ...clickUpdated, contacted: true });
          await db
            .update(scrapedLeads)
            .set({ score, stage, updatedAt: nowMs })
            .where(eq(scrapedLeads.id, clickUpdated.id));
          log("info", "Resend click recorded", {
            email: norm,
            leadId: clickUpdated.id,
            source: "webhook",
          });
        }
      }
    } else if (eventType === "email.delivered") {
      // Delivery confirmation — informational only; we don't persist this state today.
      // Logged so we can verify webhook traffic is arriving end-to-end.
    }

    res.json({ success: true });
  }),
);
}
