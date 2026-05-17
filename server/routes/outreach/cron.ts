import express from "express";
import { db, pool } from "../../db.js";
import { eq, and, count, gte, lte, sql } from "drizzle-orm";
import {
  scrapedLeads,
  leadOutreachQueue,
  leadEmailAuditLog,
  emailDripQueue,
} from "../../../shared/schema.js";
import { asyncHandler } from "../../lib/middleware.js";
import { isAdminRequest } from "../admin/shared.js";
import { log } from "../../lib/logger.js";
import { CANONICAL_URL } from "../../lib/config.js";
import { tradeCity, OUTREACH_TEMPLATES } from "../../lib/outreach-templates.js";
import { getOutreachDailyLimit, setPausedState } from "../../lib/outreach-helpers.js";
import { startJobRun, finishJobRun, JOB_RUN_DUPLICATE } from "../../lib/job-helpers.js";
import { outreachPaused, outreachPauseReason } from "../../lib/outreach-state.js";
import { runLeadScraper } from "../../lead-scraper.js";
import { getResendClient, getOutreachResendClient, sendEmailWithRetry } from "../../resend-client.js";
import { scoreAndStageAllLeads } from "../../lead-engine.js";
import { generateUnsubToken } from "../../lib/email-helpers.js";
import { getDripEmailTemplate } from "../../lib/drip-templates.js";
import { getSub, isPaidActive } from "../../lib/user-helpers.js";

export function registerCronRoutes(app: express.Application) {
// POST /api/cron/scrape-leads — daily lead discovery (secured by ADMIN_KEY)
app.post(
  "/api/cron/scrape-leads",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });

    let scrapeRunId: number | undefined;
    try {
      const started = await startJobRun("scrape-leads");
      if (started === JOB_RUN_DUPLICATE) {
        return res.json({
          success: true,
          data: { skipped: true, reason: "already running" },
        });
      }
      scrapeRunId = started;

      log("info", "Starting lead scrape run", { runId: scrapeRunId });
      const result = await runLeadScraper();
      pool
        .query(
          `INSERT INTO lead_outreach_config (key, value) VALUES ('cron_last_scrape', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [new Date().toISOString()],
        )
        .catch(err => log("warn", "cron_last_scrape config update failed", { error: err?.message }));
      await finishJobRun(scrapeRunId, {
        status: "completed",
        itemsProcessed: result.total,
        successCount: result.added,
        failureCount: result.errors,
      });
      log("info", "Lead scrape complete", {
        total: result.total,
        added: result.added,
        skipped: result.skipped,
        errors: result.errors,
      });
      res.json({ success: true, data: result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (scrapeRunId !== undefined)
        await finishJobRun(scrapeRunId, {
          status: "failed",
          errorSummary: msg,
        });
      log("error", "Lead scrape failed", { error: msg });
      res.status(500).json({ success: false, error: msg });
    }
  }),
);

// POST /api/cron/process-outreach — hourly outreach queue processor
app.post(
  "/api/cron/process-outreach",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });

    let outreachRunId: number | undefined;
    try {
      const started = await startJobRun("process-outreach");
      if (started === JOB_RUN_DUPLICATE) {
        return res.json({
          success: true,
          data: { skipped: true, reason: "already running" },
        });
      }
      outreachRunId = started;

      // Refresh all lead scores and stages before processing so queue priority is current
      try { await scoreAndStageAllLeads(); } catch(e) { log("warn", "scoreAndStageAllLeads error", { error: String(e) }); }

      // Stamp cron_last_outreach NOW so the health monitor knows the cron is alive
      // regardless of whether this run actually sends (paused, limit reached, suppressed, etc.)
      pool
        .query(
          `INSERT INTO lead_outreach_config (key, value) VALUES ('cron_last_outreach', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [new Date().toISOString()],
        )
        .catch(err => log("warn", "cron_last_outreach config update failed", { error: err?.message }));

      // ── No-engagement kill switch ──
      // Protect sender reputation: if we've sent a meaningful sample of emails
      // recently and recorded zero opens, something is wrong (spam folder
      // placement, broken tracking pixel reachability, or webhook misconfig).
      // Auto-pause so we stop bombing into the void; an admin can investigate
      // and resume from the dashboard.
      if (!outreachPaused) {
        try {
          const NO_ENGAGEMENT_WINDOW_DAYS = 14;
          const NO_ENGAGEMENT_MIN_SENDS = 150;
          const windowStartIso = new Date(
            Date.now() - NO_ENGAGEMENT_WINDOW_DAYS * 86400_000,
          ).toISOString();
          const windowStartMs = Date.now() - NO_ENGAGEMENT_WINDOW_DAYS * 86400_000;

          const [sendsRow] = await db
            .select({ c: count() })
            .from(leadEmailAuditLog)
            .where(
              and(
                eq(leadEmailAuditLog.status, "sent"),
                gte(leadEmailAuditLog.sentAt, windowStartIso),
              ),
            );
          const recentSends = Number(sendsRow?.c ?? 0);

          if (recentSends >= NO_ENGAGEMENT_MIN_SENDS) {
            const [opensRow] = await db
              .select({ c: count() })
              .from(scrapedLeads)
              .where(gte(scrapedLeads.openedAt, windowStartMs));
            const recentOpens = Number(opensRow?.c ?? 0);

            if (recentOpens === 0) {
              const reason = `No-engagement kill switch: ${recentSends} emails sent in last ${NO_ENGAGEMENT_WINDOW_DAYS} days with 0 recorded opens. Likely causes: (1) all mail landing in spam, (2) tracking pixel unreachable from inboxes, (3) Resend webhook misconfigured. Investigate before resuming.`;
              await setPausedState(true, reason);
              log("warn", "Outreach auto-paused: no engagement detected", {
                recentSends,
                recentOpens,
                windowDays: NO_ENGAGEMENT_WINDOW_DAYS,
              });
              await finishJobRun(outreachRunId, {
                status: "completed",
                itemsProcessed: 0,
                successCount: 0,
                failureCount: 0,
                errorSummary: "auto-paused: no engagement",
              });
              return res.json({
                success: true,
                data: {
                  paused: true,
                  reason: "no_engagement",
                  recentSends,
                  recentOpens,
                },
              });
            }
          }
        } catch (engagementErr) {
          // Fail open — if the check itself errors, log and continue with the
          // run rather than blocking sends on a diagnostic query.
          log("warn", "No-engagement kill switch check failed", {
            error: String(engagementErr),
          });
        }
      }

      // ── SMS outreach: high-intent only, hard daily cap ──
      // Hybrid outreach: SMS is the precious channel — reserve the daily
      // budget for the leads most likely to convert. Order by score desc so
      // the 40-slot budget always goes to the strongest leads first.
      // The cap is per-day (not per-run) — count today's SMS sends from
      // scrapedLeads.smsSentAt and only fetch the remaining slots.
      const SMS_DAILY_CAP = 40;
      const SMS_HIGH_INTENT_SCORE = 60;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();
      let smsSent = 0;
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
      const twilioFrom = process.env.TWILIO_FROM_PHONE;
      if (twilioSid && twilioAuth && twilioFrom && !outreachPaused) {
        try {
          const smsSentTodayResult = await db
            .select({ c: count() })
            .from(scrapedLeads)
            .where(gte(scrapedLeads.smsSentAt, todayStartMs));
          const smsSentToday = Number(smsSentTodayResult[0]?.c ?? 0);
          const smsRemaining = Math.max(0, SMS_DAILY_CAP - smsSentToday);

          const smsLeads = smsRemaining > 0
            ? await db
                .select()
                .from(scrapedLeads)
                .where(
                  and(
                    eq(scrapedLeads.doNotContact, false),
                    sql`${scrapedLeads.smsSentAt} IS NULL`,
                    sql`${scrapedLeads.phone} IS NOT NULL`,
                    sql`${scrapedLeads.convertedAt} IS NULL`,
                    sql`${scrapedLeads.repliedAt} IS NULL`,
                    gte(scrapedLeads.score, SMS_HIGH_INTENT_SCORE),
                  ),
                )
                .orderBy(sql`${scrapedLeads.score} DESC`)
                .limit(smsRemaining)
            : [];

          if (smsLeads.length > 0) {
            const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
            const twilioCreds = Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64");

            for (const lead of smsLeads) {
              try {
                const firstName = (lead.name ?? "").split(" ")[0] || "there";
                const trade = (lead.businessType ?? "contractor").toLowerCase();
                const smsBody = `Hey ${firstName} — Jesse here. Built ProBid AI, a free estimating tool for ${trade} contractors. Get your first estimate in 30 sec: probidcore.net Reply STOP to opt out.`;
                const form = new URLSearchParams({
                  To: lead.phone!,
                  From: twilioFrom,
                  Body: smsBody,
                });
                const resp = await fetch(twilioUrl, {
                  method: "POST",
                  headers: {
                    Authorization: `Basic ${twilioCreds}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: form.toString(),
                });
                if (resp.ok) {
                  await db
                    .update(scrapedLeads)
                    .set({ smsSentAt: Date.now(), updatedAt: Date.now() })
                    .where(eq(scrapedLeads.id, lead.id));
                  smsSent++;
                  log("info", "Lead SMS sent", { leadId: lead.id, phone: lead.phone?.slice(-4) });
                } else {
                  const errBody = await resp.text().catch(() => "");
                  log("warn", "Lead SMS failed", { leadId: lead.id, status: resp.status, error: errBody.slice(0, 200) });
                  if (resp.status === 429) {
                    log("warn", "Twilio daily limit reached — stopping SMS outreach for this run");
                    break;
                  }
                }
                await new Promise((r) => setTimeout(r, 300));
              } catch (smsErr) {
                log("warn", "Lead SMS error", { leadId: lead.id, error: String(smsErr) });
              }
            }
          }
          log("info", "SMS outreach pass complete", { smsSent, eligible: smsLeads.length });
        } catch (smsQueryErr) {
          log("warn", "SMS outreach query failed", { error: String(smsQueryErr) });
        }
      }

      // ── Website-form outreach pass (Task #141) ──
      // Surface no-email leads that we still want to reach via their website
      // contact form. We do NOT submit forms yet — that's a separate workstream
      // (per-site form parsing + captcha handling). For now we count them so
      // the admin dashboard knows the backlog.
      let websitePending = 0;
      try {
        const websitePendingRes = await db
          .select({ c: count() })
          .from(scrapedLeads)
          .where(
            and(
              eq(scrapedLeads.doNotContact, false),
              eq(scrapedLeads.leadStatus, "no_email_but_contactable"),
              sql`${scrapedLeads.website} IS NOT NULL`,
              sql`${scrapedLeads.website} <> ''`,
              sql`${scrapedLeads.websiteOutreachAt} IS NULL`,
              sql`${scrapedLeads.repliedAt} IS NULL`,
              sql`${scrapedLeads.convertedAt} IS NULL`,
            ),
          );
        websitePending = Number(websitePendingRes[0]?.c ?? 0);
        if (websitePending > 0) {
          log("info", "Website-form outreach backlog", {
            pendingLeads: websitePending,
            note: "form-submission worker not yet implemented — see Task #141 follow-up",
          });
        }
      } catch (webErr) {
        log("warn", "Website-form pending count failed", { error: String(webErr) });
      }

      if (outreachPaused) {
        await finishJobRun(outreachRunId, {
          status: "completed",
          itemsProcessed: smsSent,
          successCount: smsSent,
          failureCount: 0,
          errorSummary: `paused: ${outreachPauseReason}`,
        });
        return res.json({
          success: true,
          data: {
            sent: 0,
            failed: 0,
            skipped: 0,
            smsSent,
            websitePending,
            paused: true,
            reason: outreachPauseReason,
          },
        });
      }

      const nowISO = new Date().toISOString();

      // Hybrid policy: only the initial (day0) email counts against the daily
      // warmup cap. Follow-ups (day3/day7) are unlimited because they touch
      // leads we've already legitimately contacted — no deliverability risk.
      const OUTREACH_DAILY_LIMIT = await getOutreachDailyLimit();
      const FOLLOW_UP_TEMPLATES = ["outreach_day3", "outreach_day7"];

      const sentTodayResult = await db
        .select({ c: count() })
        .from(leadEmailAuditLog)
        .where(
          and(
            eq(leadEmailAuditLog.status, "sent"),
            eq(leadEmailAuditLog.templateId, "outreach_day0"),
            gte(leadEmailAuditLog.sentAt, todayStart.toISOString()),
          ),
        );
      const day0SentToday = Number(sentTodayResult[0]?.c ?? 0);
      const day0Remaining = Math.max(0, OUTREACH_DAILY_LIMIT - day0SentToday);

      if (!process.env.OUTREACH_FROM_EMAIL) {
        log("warn", "Outreach email run skipped: OUTREACH_FROM_EMAIL not set");
        await finishJobRun(outreachRunId!, {
          status: "completed",
          itemsProcessed: smsSent,
          successCount: smsSent,
          failureCount: 0,
          errorSummary: "suppressed: OUTREACH_FROM_EMAIL not configured",
        });
        return res.json({
          success: true,
          data: {
            sent: 0,
            failed: 0,
            skipped: 0,
            smsSent,
            websitePending,
            suppressed: true,
            reason: "OUTREACH_FROM_EMAIL not configured",
          },
        });
      }

      // Follow-ups (day3/day7) drain first, no cap. Day0 fills up to the
      // remaining warmup budget. Both pulls share the standard pending filter.
      const followUps = await db
        .select({ q: leadOutreachQueue, lead: scrapedLeads })
        .from(leadOutreachQueue)
        .innerJoin(scrapedLeads, eq(leadOutreachQueue.leadId, scrapedLeads.id))
        .where(
          and(
            eq(leadOutreachQueue.status, "pending"),
            lte(leadOutreachQueue.scheduledFor, nowISO),
            sql`${leadOutreachQueue.templateId} IN (${sql.join(FOLLOW_UP_TEMPLATES.map((t) => sql`${t}`), sql`, `)})`,
          ),
        );

      const day0Pending = day0Remaining > 0
        ? await db
            .select({ q: leadOutreachQueue, lead: scrapedLeads })
            .from(leadOutreachQueue)
            .innerJoin(scrapedLeads, eq(leadOutreachQueue.leadId, scrapedLeads.id))
            .where(
              and(
                eq(leadOutreachQueue.status, "pending"),
                lte(leadOutreachQueue.scheduledFor, nowISO),
                eq(leadOutreachQueue.templateId, "outreach_day0"),
              ),
            )
            .limit(day0Remaining)
        : [];

      const pending = [...followUps, ...day0Pending];

      let sent = 0;
      let day0Sent = 0;
      let followUpSent = 0;
      let failed = 0;
      let skipped = 0;

      for (const row of pending) {
        const { q, lead } = row;

        if (lead.doNotContact || !lead.email || lead.repliedAt || lead.convertedAt) {
          await db
            .update(leadOutreachQueue)
            .set({ status: "suppressed", sentAt: nowISO })
            .where(eq(leadOutreachQueue.id, q.id));
          skipped++;
          continue;
        }

        const template = OUTREACH_TEMPLATES[q.templateId];
        if (!template) {
          await db
            .update(leadOutreachQueue)
            .set({ status: "failed", sentAt: nowISO })
            .where(eq(leadOutreachQueue.id, q.id));
          failed++;
          continue;
        }

        const openPixelUrl = `${CANONICAL_URL}/api/track/open/${q.openToken}`;
        const ctaUrl = `${CANONICAL_URL}/api/track/click/${q.clickToken}`;
        // Use per-email unsubscribe token from queue row; fall back to per-lead token for legacy rows
        const unsubUrl = `${CANONICAL_URL}/api/unsubscribe/${q.unsubscribeToken ?? lead.unsubscribeToken}`;

        const trade = lead.businessType ?? "";
        const city = tradeCity(lead.location ?? "") || undefined;
        const firstName = lead.name.split(" ")[0];
        const subjectLine = template.subject({ trade, city });
        const htmlBody = template.html({
          name: firstName,
          trade,
          city,
          openPixelUrl,
          ctaUrl,
          unsubUrl,
        });
        const textBody = template.text({
          name: firstName,
          trade,
          city,
          ctaUrl,
          unsubUrl,
        });

        try {
          const { client, fromEmail } = await getOutreachResendClient();
          await sendEmailWithRetry(
            client,
            {
              from: fromEmail,
              to: lead.email,
              subject: subjectLine,
              html: htmlBody,
              text: textBody,
              headers: {
                "List-Unsubscribe": `<${unsubUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            },
            {
              idempotencyKey: `outreach/${q.id}`,
              logContext: { leadId: lead.id, templateId: q.templateId },
            },
          );

          await db
            .update(leadOutreachQueue)
            .set({ status: "sent", sentAt: nowISO })
            .where(eq(leadOutreachQueue.id, q.id));
          await db.insert(leadEmailAuditLog).values({
            leadId: lead.id,
            templateId: q.templateId,
            subject: subjectLine,
            status: "sent",
            sentAt: nowISO,
          });
          sent++;
          if (q.templateId === "outreach_day0") day0Sent++;
          else followUpSent++;
          log("info", "Lead outreach email sent", {
            leadId: lead.id,
            email: lead.email,
            templateId: q.templateId,
          });
        } catch (sendErr) {
          const errMsg =
            sendErr instanceof Error ? sendErr.message : String(sendErr);
          await db
            .update(leadOutreachQueue)
            .set({ status: "failed", sentAt: nowISO })
            .where(eq(leadOutreachQueue.id, q.id));
          await db.insert(leadEmailAuditLog).values({
            leadId: lead.id,
            templateId: q.templateId,
            subject: subjectLine,
            status: "failed",
            sentAt: nowISO,
          });
          failed++;
          log("error", "Lead outreach email failed", {
            leadId: lead.id,
            email: lead.email,
            error: errMsg,
          });

          // Classify the error so we don't lock the engine for days on
          // recoverable issues (e.g. rotated API key). Auth/credential
          // failures: stop *this run* (no point hammering Resend) but do
          // NOT persist paused=true — the next cron run will pick up new
          // credentials automatically. Quota/billing: same treatment, since
          // those are operator-fix-and-resume situations. Everything else:
          // require a much larger sample (20 absolute failures + >50% rate)
          // before persisting a hard pause, so one bad batch can't kill
          // the funnel for days.
          const lowerErr = errMsg.toLowerCase();
          // Auth/credential failures: cover both Resend API responses
          // ("API key is invalid", "invalid_api_key", HTTP 401/403, "unauthorized")
          // AND getResendClient()/getOutreachResendClient() throws
          // ("Resend credentials not available", "OUTREACH_FROM_EMAIL is not set/invalid").
          const isAuthError =
            lowerErr.includes("api key is invalid") ||
            lowerErr.includes("invalid_api_key") ||
            (lowerErr.includes("api key") && lowerErr.includes("invalid")) ||
            lowerErr.includes("unauthorized") ||
            lowerErr.includes("http 401") ||
            lowerErr.includes("http 403") ||
            lowerErr.includes("credentials not available") ||
            lowerErr.includes("outreach_from_email");
          // Quota / rate-limit: bail immediately on clear signals.
          // Resend uses both the human-readable "rate limit" phrase and the
          // machine name "rate_limit_exceeded"; HTTP 429 is the canonical status.
          const isQuotaError =
            lowerErr.includes("quota") ||
            lowerErr.includes("rate_limit_exceeded") ||
            lowerErr.includes("rate limit") ||
            lowerErr.includes("http 429");

          if (isAuthError) {
            log("error", "Outreach run aborted: Resend credentials rejected — rotate RESEND_API_KEY and the next run will resume", {
              error: errMsg,
              failedThisRun: failed,
            });
            break;
          }
          if (isQuotaError) {
            log("error", "Outreach run aborted: Resend quota/rate-limit hit — will retry next run", {
              error: errMsg,
              failedThisRun: failed,
            });
            break;
          }

          const errorRate = failed / (sent + failed);
          if (failed >= 20 && errorRate > 0.5) {
            const reason = `Send-error rate ${Math.round(errorRate * 100)}% (>${50}%) after ${sent + failed} attempts in one run`;
            await setPausedState(true, reason);
            log("warn", "Outreach paused due to sustained high error rate", { reason });
            break;
          }
        }
      }

      await finishJobRun(outreachRunId!, {
        status: "completed",
        itemsProcessed: sent + failed + skipped + smsSent,
        successCount: sent + smsSent,
        failureCount: failed,
      });
      res.json({
        success: true,
        data: {
          sent,
          day0Sent,
          followUpSent,
          followUpsUnlimited: true,
          failed,
          skipped,
          smsSent,
          smsCap: SMS_DAILY_CAP,
          websitePending,
          day0SentToday: day0SentToday + day0Sent,
          day0DailyLimit: OUTREACH_DAILY_LIMIT,
        },
      });
    } catch (outreachErr: unknown) {
      const errMsg =
        outreachErr instanceof Error
          ? outreachErr.message
          : String(outreachErr);
      if (outreachRunId !== undefined)
        await finishJobRun(outreachRunId, {
          status: "failed",
          errorSummary: errMsg,
        });
      log("error", "Outreach cron failed", { error: errMsg });
      res.status(500).json({ success: false, error: errMsg });
    }
  }),
);

// --- Email Drip Cron Endpoint (GET + POST for backward compatibility) ---
const dripEmailCronHandler = asyncHandler(
  async (req: express.Request, res: express.Response) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });

    let dripRunId: number | undefined;
    try {
      const started = await startJobRun("process-drip-emails");
      if (started === JOB_RUN_DUPLICATE) {
        return res.json({
          processed: 0,
          skipped: true,
          reason: "already running",
        });
      }
      dripRunId = started;

      const nowISO = new Date().toISOString();
      const pendingEmails = await db
        .select()
        .from(emailDripQueue)
        .where(
          and(
            eq(emailDripQueue.status, "pending"),
            lte(emailDripQueue.scheduledFor, nowISO),
          ),
        )
        .limit(50);

      if (pendingEmails.length === 0) {
        await finishJobRun(dripRunId, {
          status: "completed",
          itemsProcessed: 0,
          successCount: 0,
          failureCount: 0,
        });
        return res.json({ processed: 0, message: "No pending drip emails" });
      }

      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const dripEmail of pendingEmails) {
        const isOnboarding = dripEmail.templateKey.startsWith("onboarding_");

        if (isOnboarding && dripEmail.userId) {
          const sub = await getSub(dripEmail.userId);
          if (isPaidActive(sub)) {
            await db
              .update(emailDripQueue)
              .set({ status: "skipped", sentAt: nowISO })
              .where(eq(emailDripQueue.id, dripEmail.id));
            skipped++;
            log("info", "Onboarding email skipped (user is paid)", {
              id: dripEmail.id,
              userId: dripEmail.userId,
            });
            continue;
          }
        }

        const template = getDripEmailTemplate(dripEmail.templateKey, dripEmail.email);
        if (!template) {
          await db
            .update(emailDripQueue)
            .set({ status: "failed", sentAt: nowISO })
            .where(eq(emailDripQueue.id, dripEmail.id));
          failed++;
          log("error", "Invalid drip email template", {
            id: dripEmail.id,
            templateKey: dripEmail.templateKey,
          });
          continue;
        }

        const unsubUrl = `${CANONICAL_URL}/api/unsubscribe-drip?email=${encodeURIComponent(dripEmail.email)}&token=${generateUnsubToken(dripEmail.email)}`;
        const htmlWithUnsub = template.html.replace(
          /\{\{UNSUB_URL\}\}/g,
          unsubUrl,
        );

        try {
          const { client, fromEmail } = await getResendClient();
          await sendEmailWithRetry(
            client,
            {
              from: fromEmail,
              to: dripEmail.email,
              subject: template.subject,
              html: htmlWithUnsub,
              headers: {
                "List-Unsubscribe": `<${unsubUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            },
            {
              idempotencyKey: `outreach-drip/${dripEmail.id}`,
              logContext: { dripId: dripEmail.id, templateKey: dripEmail.templateKey },
            },
          );
          await db
            .update(emailDripQueue)
            .set({ status: "sent", sentAt: nowISO })
            .where(eq(emailDripQueue.id, dripEmail.id));
          sent++;
          log("info", "Drip email sent", {
            id: dripEmail.id,
            email: dripEmail.email,
            templateKey: dripEmail.templateKey,
          });
        } catch (sendError) {
          await db
            .update(emailDripQueue)
            .set({ status: "failed", sentAt: nowISO })
            .where(eq(emailDripQueue.id, dripEmail.id));
          failed++;
          log("error", "Failed to send drip email", {
            id: dripEmail.id,
            email: dripEmail.email,
            error: String(sendError),
          });
        }
      }

      await finishJobRun(dripRunId, {
        status: "completed",
        itemsProcessed: pendingEmails.length,
        successCount: sent,
        failureCount: failed,
      });
      res.json({ processed: pendingEmails.length, sent, failed, skipped });
    } catch (dripErr: unknown) {
      const errMsg =
        dripErr instanceof Error ? dripErr.message : String(dripErr);
      if (dripRunId !== undefined)
        await finishJobRun(dripRunId, {
          status: "failed",
          errorSummary: errMsg,
        });
      log("error", "Drip email cron failed", { error: errMsg });
      res.status(500).json({ success: false, error: errMsg });
    }
  },
);
app.get("/api/cron/process-drip-emails", dripEmailCronHandler);
app.post("/api/cron/process-drip-emails", dripEmailCronHandler);
}
