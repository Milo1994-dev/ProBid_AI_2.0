import cron from "node-cron";
import { db, pool } from "../db.js";
import { eq, and, lte } from "drizzle-orm";
import { emailDripQueue, dunningEvents, users, subscriptions, estimates, procoreConnections } from "../../shared/schema.js";
import { log } from "../lib/logger.js";
import { redactEmail } from "../lib/log-redact.js";
import { APP_URL, hasEnv, hasResendCredentials } from "../lib/config.js";
import { getSub, isPaidActive } from "../lib/user-helpers.js";
import { generateUnsubToken, sendDunningDay3Email, sendDunningDay7Email, sendWonLostFollowUpEmail } from "../lib/email-helpers.js";
import { getDripEmailTemplate, weeklyRecapBody, dormantReengageBody } from "../lib/drip-templates.js";
import { getResendClient, sendEmailWithRetry } from "../resend-client.js";
import { runLeadScraper } from "../lead-scraper.js";
import { startHealthMonitor } from "../health-monitor.js";
import { stripe } from "../lib/stripe-helpers.js";
import { trackEvent } from "../lib/analytics.js";
import { notifyTrialExpiring } from "../routes/notifications.js";
import { processTimedAutomations } from "../lib/automation-engine.js";
import { processWebhookRetries } from "../lib/webhook-delivery.js";
import { sendDailyDigest } from "../lib/daily-digest.js";
import { isSmokeMode } from "../lib/smoke-mode.js";
import { pruneAuditLog } from "../lib/watchtower-audit.js";
import { recordMrrSnapshot } from "../lib/mrr-snapshots.js";
import * as procore from "../procore.js";
import * as shadowEstimator from "../shadow-estimator.js";
import * as metricsEngine from "../metrics-engine.js";

const CANONICAL_URL = "https://probidcore.net";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

export function startScheduler(): void {
  // Defense in depth — server.ts already guards this call, but if any other
  // caller wires up startScheduler() directly we still want SMOKE_MODE to win.
  if (isSmokeMode()) {
    log(
      "warn",
      "scheduler: SMOKE_MODE=1 — refusing to register cron jobs, intervals, the lead-scraper startup catch-up, or the webhook retry sweeper.",
    );
    return;
  }
  if ((globalThis as Record<string, unknown>).__schedulersStarted) {
    log(
      "info",
      "Schedulers already registered — skipping duplicate registration",
    );
    return;
  }
  (globalThis as Record<string, unknown>).__schedulersStarted = true;

  if (!hasEnv("GOOGLE_PLACES_API_KEY")) {
    log("warn", "lead-scraper: disabled — GOOGLE_PLACES_API_KEY not set", {
      action:
        "Add GOOGLE_PLACES_API_KEY via Google Cloud Console → APIs & Services → Credentials",
    });
  }
  cron.schedule(
    "0 8 * * *",
    async () => {
      if (!ADMIN_KEY) return;
      if (!hasEnv("GOOGLE_PLACES_API_KEY")) return;
      try {
        const resp = await fetch(
          `${APP_URL}/api/cron/scrape-leads`,
          { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
        );
        const data = (await resp.json()) as {
          success?: boolean;
          data?: Record<string, unknown>;
        };
        if (data.success) {
          log("info", "Lead scraper cron complete", data.data ?? {});
        } else {
          log("warn", "Lead scraper cron returned failure", { data });
        }
      } catch (err) {
        log("error", "Lead scraper cron error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "Lead scraper cron scheduled (08:00 UTC daily)");

  (async () => {
    if (!ADMIN_KEY) return;
    if (!hasEnv("GOOGLE_PLACES_API_KEY")) return;
    try {
      const configRow = await pool.query<{ value: string }>(
        `SELECT value FROM lead_outreach_config WHERE key = 'cron_last_scrape'`,
      );
      const lastScrape = configRow.rows[0]?.value ?? null;
      const todayUtc = new Date().toISOString().slice(0, 10);
      const lastScrapeDay = lastScrape ? lastScrape.slice(0, 10) : null;

      if (lastScrapeDay === todayUtc) {
        log(
          "info",
          "Lead scraper startup check: already ran today, skipping",
          { lastScrape },
        );
        return;
      }

      log("info", "Lead scraper startup check: running catch-up scrape", {
        lastScrape,
      });
      const result = await runLeadScraper();
      await pool.query(
        `INSERT INTO lead_outreach_config (key, value) VALUES ('cron_last_scrape', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [new Date().toISOString()],
      );
      log("info", "Lead scraper startup catch-up complete", { ...result });
    } catch (err) {
      log("error", "Lead scraper startup catch-up error", {
        error: String(err),
      });
    }
  })();

  cron.schedule(
    "0 * * * *",
    async () => {
      if (!ADMIN_KEY) return;
      try {
        const resp = await fetch(
          `${APP_URL}/api/cron/process-outreach`,
          { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
        );
        const data = (await resp.json()) as {
          success?: boolean;
          data?: Record<string, unknown>;
        };
        if (data.success) {
          const d = data.data ?? {};
          log("info", "Outreach cron complete", d);
        } else {
          log("warn", "Outreach cron returned failure", { data });
        }
      } catch (err) {
        log("error", "Outreach cron error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "Outreach processor cron scheduled (every hour)");

  // Startup catch-up for the outreach processor. On Autoscale, the in-memory
  // hourly cron above only fires when an instance happens to stay alive across
  // the hour boundary — which is rare. Mirroring the scraper's catch-up: every
  // time the server boots, if the last outreach run was more than 60 minutes
  // ago, kick one off so the queue keeps draining even under cold-start churn.
  (async () => {
    if (!ADMIN_KEY) {
      log(
        "warn",
        "Outreach processor startup check: disabled — ADMIN_KEY not set",
      );
      return;
    }
    try {
      const configRow = await pool.query<{ value: string }>(
        `SELECT value FROM lead_outreach_config WHERE key = 'cron_last_outreach'`,
      );
      const lastOutreach = configRow.rows[0]?.value ?? null;
      const lastMs = lastOutreach ? Date.parse(lastOutreach) : 0;
      const ageMinutes = lastMs ? (Date.now() - lastMs) / 60000 : Infinity;

      if (ageMinutes < 60) {
        log(
          "info",
          "Outreach processor startup check: ran recently, skipping",
          { lastOutreach, ageMinutes: Math.round(ageMinutes) },
        );
        return;
      }

      log("info", "Outreach processor startup check: running catch-up", {
        lastOutreach,
        ageMinutes: Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null,
      });
      const resp = await fetch(`${APP_URL}/api/cron/process-outreach`, {
        method: "POST",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      const bodyText = await resp.text();
      if (!resp.ok) {
        log("warn", "Outreach processor startup catch-up: non-2xx response", {
          status: resp.status,
          body: bodyText.slice(0, 500),
        });
        return;
      }
      let data: { success?: boolean; data?: Record<string, unknown> } = {};
      try {
        data = JSON.parse(bodyText);
      } catch {
        log("warn", "Outreach processor startup catch-up: invalid JSON body", {
          status: resp.status,
          body: bodyText.slice(0, 500),
        });
        return;
      }
      if (data.success) {
        log("info", "Outreach processor startup catch-up complete", data.data ?? {});
      } else {
        log("warn", "Outreach processor startup catch-up returned failure", { data });
      }
    } catch (err) {
      log("error", "Outreach processor startup catch-up error", {
        error: String(err),
      });
    }
  })();

  if (!hasResendCredentials()) {
    log("warn", "email-drip: disabled — no Resend credentials found", {
      action:
        "Add RESEND_API_KEY via Resend dashboard or configure the Resend Replit Connector",
    });
  }
  setInterval(
    async () => {
      if (!hasResendCredentials()) return;
      try {
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

        if (pendingEmails.length > 0) {
          log("info", "Processing drip emails", {
            count: pendingEmails.length,
          });

          for (const dripEmail of pendingEmails) {
            try {
              const isConversionDrip =
                dripEmail.templateKey.startsWith("onboarding_") ||
                dripEmail.templateKey.startsWith("single_upgrade_") ||
                dripEmail.templateKey.startsWith("winback_") ||
                dripEmail.templateKey.startsWith("drip_") ||
                dripEmail.templateKey.includes("_upgrade");

              if (isConversionDrip) {
                let lookupUserId = dripEmail.userId;
                if (!lookupUserId) {
                  const userLookup = await db
                    .select({ id: users.id })
                    .from(users)
                    .where(eq(users.email, dripEmail.email))
                    .limit(1);
                  lookupUserId = userLookup[0]?.id ?? null;
                }
                if (lookupUserId) {
                  const sub = await getSub(lookupUserId);
                  if (isPaidActive(sub)) {
                    await db
                      .update(emailDripQueue)
                      .set({ status: "skipped", sentAt: nowISO })
                      .where(eq(emailDripQueue.id, dripEmail.id));
                    log("info", "Conversion drip email skipped (user is paid)", {
                      id: dripEmail.id,
                      userId: lookupUserId,
                      templateKey: dripEmail.templateKey,
                    });
                    continue;
                  }
                }
              }

              const template = getDripEmailTemplate(dripEmail.templateKey, dripEmail.email);
              if (!template) {
                await db
                  .update(emailDripQueue)
                  .set({ status: "failed", sentAt: nowISO })
                  .where(eq(emailDripQueue.id, dripEmail.id));
                log("error", "No template found for drip email", {
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
                  idempotencyKey: `drip/${dripEmail.id}`,
                  logContext: { dripId: dripEmail.id, templateKey: dripEmail.templateKey },
                },
              );
              await db
                .update(emailDripQueue)
                .set({ status: "sent", sentAt: nowISO })
                .where(eq(emailDripQueue.id, dripEmail.id));
              log("info", "Drip email sent", {
                id: dripEmail.id,
                email: redactEmail(dripEmail.email),
                templateKey: dripEmail.templateKey,
              });
            } catch (err) {
              await db
                .update(emailDripQueue)
                .set({ status: "failed", sentAt: nowISO })
                .where(eq(emailDripQueue.id, dripEmail.id));
              log("error", "Drip email send failed", {
                id: dripEmail.id,
                error: String(err),
              });
            }
          }
        }
      } catch (err) {
        log("error", "Drip email processing error", { error: String(err) });
      }
    },
    5 * 60 * 1000,
  );

  log(
    "info",
    "Autonomous email drip processor started (runs every 5 minutes)",
  );

  setInterval(
    async () => {
      try {
        const nowMs = Date.now();
        const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

        const activeEvents = await db
          .select()
          .from(dunningEvents)
          .where(eq(dunningEvents.status, "active"));

        for (const evt of activeEvents) {
          try {
            const sub = await getSub(evt.userId);
            if (sub && (sub.status === "active" || sub.status === "trialing")) {
              await db
                .update(dunningEvents)
                .set({ status: "resolved", resolvedAt: nowMs })
                .where(eq(dunningEvents.id, evt.id));
              log("info", "Dunning event resolved (subscription active)", { userId: evt.userId, eventId: evt.id });
              continue;
            }

            if (sub && (sub.status === "canceled" || sub.status === "unpaid")) {
              await db
                .update(dunningEvents)
                .set({ status: "expired", resolvedAt: nowMs })
                .where(eq(dunningEvents.id, evt.id));
              log("info", "Dunning event expired (subscription terminal)", { userId: evt.userId, eventId: evt.id, subStatus: sub.status });
              continue;
            }

            if (!sub || sub.status !== "past_due") {
              continue;
            }

            const elapsed = nowMs - evt.firstFailedAt;
            let emailType: "day7" | "day3" | null = null;
            if (elapsed >= THREE_DAYS_MS && !evt.day3EmailSentAt) {
              emailType = "day3";
            } else if (elapsed >= SEVEN_DAYS_MS && !evt.day7EmailSentAt) {
              emailType = "day7";
            }

            if (!emailType) continue;

            const userResult = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, evt.userId));
            const userEmail = userResult[0]?.email;
            if (!userEmail) continue;

            const cur = (evt.currency || "usd").toUpperCase();
            const amt = (evt.amountDueCents / 100).toFixed(2);
            const amountFormatted = cur === "USD" ? `$${amt}` : cur === "EUR" ? `€${amt}` : cur === "GBP" ? `£${amt}` : `${amt} ${cur}`;

            let billingPortalUrl = `${CANONICAL_URL}/app/billing`;
            try {
              const portalSession = await stripe.billingPortal.sessions.create({
                customer: evt.stripeCustomerId,
                return_url: `${CANONICAL_URL}/app/billing`,
              });
              billingPortalUrl = portalSession.url;
            } catch { /* use fallback */ }

            const unsubUrl = `${CANONICAL_URL}/app/billing`;

            if (emailType === "day7") {
              await sendDunningDay7Email(userEmail, amountFormatted, billingPortalUrl, unsubUrl);
              await db
                .update(dunningEvents)
                .set({ day7EmailSentAt: nowMs })
                .where(eq(dunningEvents.id, evt.id));
              await trackEvent("dunning_day7_sent", evt.userId, { invoiceId: evt.stripeInvoiceId });
              log("info", "Dunning day-7 email sent", { userId: evt.userId, eventId: evt.id });
            } else {
              await sendDunningDay3Email(userEmail, amountFormatted, billingPortalUrl, unsubUrl);
              await db
                .update(dunningEvents)
                .set({ day3EmailSentAt: nowMs })
                .where(eq(dunningEvents.id, evt.id));
              await trackEvent("dunning_day3_sent", evt.userId, { invoiceId: evt.stripeInvoiceId });
              log("info", "Dunning day-3 email sent", { userId: evt.userId, eventId: evt.id });
            }
          } catch (err) {
            log("error", "Dunning follow-up error for event", { eventId: evt.id, error: String(err) });
          }
        }
      } catch (err) {
        log("error", "Dunning processor error", { error: String(err) });
      }
    },
    10 * 60 * 1000,
  );
  log("info", "Dunning follow-up processor started (runs every 10 minutes)");

  startHealthMonitor();
  log("info", "Health monitor started (runs every 5 minutes by default; override via WATCHTOWER_INTERVAL_MS)");

  cron.schedule(
    "0 7 * * *",
    async () => {
      if (!ADMIN_KEY) return;
      try {
        const resp = await fetch(
          `${APP_URL}/api/cron/daily-report`,
          { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
        );
        const data = (await resp.json()) as { success?: boolean };
        if (data.success) {
          log("info", "Daily report dispatched");
        } else {
          log("warn", "Daily report dispatch returned failure", { data });
        }
      } catch (err) {
        log("error", "Daily report cron error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "Daily report cron scheduled (07:00 UTC)");

  cron.schedule(
    "30 7 * * *",
    async () => {
      try {
        const result = await sendDailyDigest();
        if (result.sent) log("info", "Daily watchtower digest sent");
        else log("info", "Daily watchtower digest skipped", { reason: result.reason });
      } catch (err) {
        log("error", "Daily watchtower digest error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "Daily watchtower digest cron scheduled (07:30 UTC)");

  cron.schedule(
    "0 0 * * *",
    async () => {
      try {
        await recordMrrSnapshot();
      } catch (err) {
        log("error", "MRR snapshot cron error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "MRR snapshot cron scheduled (00:00 UTC daily)");

  // pruneAuditLog() handles its own errors and never throws.
  // AUDIT_RETENTION_DAYS env var controls the window (default: 90 days).
  cron.schedule(
    "0 3 * * *",
    async () => {
      const { deleted } = await pruneAuditLog();
      log("info", "Audit log prune complete", { deleted });
    },
    { timezone: "UTC" },
  );
  log("info", "Audit log prune cron scheduled (03:00 UTC daily); retention window controlled by AUDIT_RETENTION_DAYS env var (default 90 days)");

  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        const nowMs = Date.now();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const tomorrowStart = nowMs + ONE_DAY_MS;
        const tomorrowEnd = nowMs + 2 * ONE_DAY_MS;

        const trialingSubs = await db
          .select({ userId: subscriptions.userId, currentPeriodEnd: subscriptions.currentPeriodEnd })
          .from(subscriptions)
          .where(eq(subscriptions.status, "trialing"));

        let notified = 0;
        for (const sub of trialingSubs) {
          if (sub.currentPeriodEnd && sub.currentPeriodEnd >= tomorrowStart && sub.currentPeriodEnd < tomorrowEnd) {
            await notifyTrialExpiring(sub.userId).catch(err =>
              log("warn", "Trial expiring push notification failed", { userId: sub.userId, error: err?.message }),
            );
            notified++;
          }
        }

        if (notified > 0) {
          log("info", "Trial expiring push notifications sent", { count: notified });
        }
      } catch (err) {
        log("error", "Trial expiring notification cron error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "Trial expiring notification cron scheduled (09:00 UTC daily)");

  setInterval(
    async () => {
      try {
        await processTimedAutomations();
      } catch (err) {
        log("error", "Automation processor error", { error: String(err) });
      }
    },
    10 * 60 * 1000,
  );
  log("info", "Automation processor started (runs every 10 minutes)");

  // Outbound webhook retry sweeper. Runs frequently because the first
  // backoff slot is only 30s, so anything longer would noticeably delay
  // the very first retry and make partners think we dropped the event.
  setInterval(
    async () => {
      try {
        await processWebhookRetries();
      } catch (err) {
        log("error", "Webhook retry processor error", { error: String(err) });
      }
    },
    30 * 1000,
  );
  log("info", "Webhook retry processor started (runs every 30 seconds)");

  cron.schedule(
    "0 10 * * 1",
    async () => {
      if (!hasResendCredentials()) return;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
        let sent = 0;

        for (const u of allUsers) {
          try {
            const unsubCheck = await db
              .select({ id: emailDripQueue.id })
              .from(emailDripQueue)
              .where(
                and(
                  eq(emailDripQueue.email, u.email.toLowerCase()),
                  eq(emailDripQueue.templateKey, "global_unsubscribe"),
                )
              )
              .limit(1);
            if (unsubCheck.length > 0) continue;

            const userEstimates = await db
              .select({ id: estimates.id, createdAt: estimates.createdAt })
              .from(estimates)
              .where(eq(estimates.userId, u.id));

            if (userEstimates.length === 0) continue;

            const recentCount = userEstimates.filter(
              (e) => new Date(e.createdAt).toISOString() >= sevenDaysAgo
            ).length;

            const timeSaved = Math.round(userEstimates.length * 0.75);
            const laborRate = 65;
            const valueSaved = timeSaved * laborRate;
            const formattedValue = valueSaved >= 1000
              ? `$${(valueSaved / 1000).toFixed(0)}K`
              : `$${valueSaved.toFixed(0)}`;

            const html = weeklyRecapBody({
              estimateCount: recentCount,
              timeSavedHours: timeSaved,
              totalValue: formattedValue,
            });

            const unsubUrl = `${CANONICAL_URL}/api/unsubscribe-drip?email=${encodeURIComponent(u.email)}&token=${generateUnsubToken(u.email)}`;
            const htmlWithUnsub = html.replace(/\{\{UNSUB_URL\}\}/g, unsubUrl);

            const { client, fromEmail } = await getResendClient();
            const weekKey = new Date().toISOString().slice(0, 10);
            await sendEmailWithRetry(
              client,
              {
                from: fromEmail,
                to: u.email,
                subject: `Your ProBid AI weekly recap: ${recentCount} estimate${recentCount !== 1 ? "s" : ""} this week`,
                html: htmlWithUnsub,
                headers: {
                  "List-Unsubscribe": `<${unsubUrl}>`,
                  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                },
              },
              {
                idempotencyKey: `weekly-recap/${u.id}/${weekKey}`,
                logContext: { userId: u.id },
              },
            );
            sent++;
          } catch (err) {
            log("warn", "Weekly recap email failed for user", { userId: u.id, error: String(err) });
          }
        }

        if (sent > 0) {
          log("info", "Weekly recap emails sent", { count: sent });
        }
      } catch (err) {
        log("error", "Weekly recap cron error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "Weekly recap email cron scheduled (Mondays 10:00 UTC)");

  cron.schedule(
    "0 14 * * 3",
    async () => {
      if (!hasResendCredentials()) return;
      try {
        const DORMANT_DAYS = 7;
        const cutoff = new Date(Date.now() - DORMANT_DAYS * 24 * 60 * 60 * 1000);
        const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
        let sent = 0;

        for (const u of allUsers) {
          try {
            const unsubCheck = await db
              .select({ id: emailDripQueue.id })
              .from(emailDripQueue)
              .where(
                and(
                  eq(emailDripQueue.email, u.email.toLowerCase()),
                  eq(emailDripQueue.templateKey, "global_unsubscribe"),
                )
              )
              .limit(1);
            if (unsubCheck.length > 0) continue;

            const userEstimates = await db
              .select({ createdAt: estimates.createdAt })
              .from(estimates)
              .where(eq(estimates.userId, u.id));

            if (userEstimates.length === 0) continue;

            const latestEstimate = userEstimates.reduce((latest, e) => {
              const d = new Date(e.createdAt);
              return d > latest ? d : latest;
            }, new Date(0));

            if (latestEstimate >= cutoff) continue;

            const existingReengage = await db
              .select({ id: emailDripQueue.id })
              .from(emailDripQueue)
              .where(
                and(
                  eq(emailDripQueue.email, u.email),
                  eq(emailDripQueue.templateKey, "dormant_reengage"),
                )
              )
              .limit(1);

            const recentlySent = existingReengage.length > 0;
            if (recentlySent) continue;

            const html = dormantReengageBody();
            const unsubUrl = `${CANONICAL_URL}/api/unsubscribe-drip?email=${encodeURIComponent(u.email)}&token=${generateUnsubToken(u.email)}`;
            const htmlWithUnsub = html.replace(/\{\{UNSUB_URL\}\}/g, unsubUrl);

            const { client, fromEmail } = await getResendClient();
            const weekKey = new Date().toISOString().slice(0, 10);
            await sendEmailWithRetry(
              client,
              {
                from: fromEmail,
                to: u.email,
                subject: "We miss you — your next estimate is waiting",
                html: htmlWithUnsub,
                headers: {
                  "List-Unsubscribe": `<${unsubUrl}>`,
                  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                },
              },
              {
                idempotencyKey: `dormant-reengage/${u.id}/${weekKey}`,
                logContext: { userId: u.id },
              },
            );

            await db.insert(emailDripQueue).values({
              email: u.email,
              userId: u.id,
              templateKey: "dormant_reengage",
              scheduledFor: new Date().toISOString(),
              status: "sent",
              sentAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });

            sent++;
          } catch (err) {
            log("warn", "Dormant re-engage email failed for user", { userId: u.id, error: String(err) });
          }
        }

        if (sent > 0) {
          log("info", "Dormant re-engagement emails sent", { count: sent });
        }
      } catch (err) {
        log("error", "Dormant re-engagement cron error", { error: String(err) });
      }
    },
    { timezone: "UTC" },
  );
  log("info", "Dormant re-engagement cron scheduled (Wednesdays 14:00 UTC)");

  const procoreConfigured = !!(process.env.PROCORE_CLIENT_ID && process.env.PROCORE_CLIENT_SECRET);
  if (procoreConfigured) {
    cron.schedule(
      "0 7 * * *",
      async () => {
        try {
          const result = await metricsEngine.updatePublicBenchmarksFromConsenting();
          log("info", "Public benchmarks recomputed", result);
        } catch (err) {
          log("error", "Public benchmarks cron error", { error: String(err) });
        }
      },
      { timezone: "UTC" },
    );
    log("info", "Public benchmarks cron scheduled (07:00 UTC daily)");

    cron.schedule(
      "0 6 * * *",
      async () => {
        try {
          const activeConnections = await db
            .select()
            .from(procoreConnections)
            .where(eq(procoreConnections.status, "active"));

          if (activeConnections.length === 0) return;

          log("info", "Procore auto-sync starting", { connectionCount: activeConnections.length });

          for (const connection of activeConnections) {
            try {
              const syncedCount = await procore.syncClosedProjects(connection.id);
              log("info", "Procore projects synced", { connectionId: connection.id, syncedCount });

              const projects = await procore.getConnectionProjects(connection.id);
              for (const project of projects) {
                try {
                  await procore.syncProjectBudgets(connection.id, project.id);
                  await procore.syncChangeOrders(connection.id, project.id);
                } catch (err) {
                  log("warn", "Procore auto-sync: failed to sync project details", {
                    connectionId: connection.id,
                    projectId: project.id,
                    error: String(err),
                  });
                }
              }

              const shadowResult = await shadowEstimator.runShadowEstimatesForConnection(connection.id);
              if (shadowResult.processed > 0) {
                log("info", "Procore auto-sync: shadow estimates generated", {
                  connectionId: connection.id,
                  processed: shadowResult.processed,
                  errors: shadowResult.errors,
                });
              }

              await metricsEngine.calculateAndSaveAllMetrics(connection.id);
              const metrics = await metricsEngine.getLatestMetrics(connection.id);
              log("info", "Procore auto-sync complete for connection", {
                connectionId: connection.id,
                companyName: connection.companyName,
                syncedProjects: syncedCount,
                shadowEstimatesGenerated: shadowResult.processed,
                accuracyErrorPct: metrics["accuracy_error_pct"]?.value ?? null,
                sampleSize: metrics["accuracy_error_pct"]?.sampleSize ?? null,
              });
            } catch (err) {
              log("error", "Procore auto-sync failed for connection", {
                connectionId: connection.id,
                error: String(err),
              });
            }
          }

          log("info", "Procore auto-sync complete", { connectionsProcessed: activeConnections.length });
        } catch (err) {
          log("error", "Procore auto-sync cron error", { error: String(err) });
        }
      },
      { timezone: "UTC" },
    );
    log("info", "Procore auto-sync cron scheduled (06:00 UTC daily)");
  } else {
    log("info", "Procore auto-sync: disabled — PROCORE_CLIENT_ID or PROCORE_CLIENT_SECRET not set");
  }

  // ─── Won/Lost 14-day follow-up email ────────────────────────────────────────
  // Runs daily at 10:00 UTC. Finds paid subscribers whose most recent estimate
  // was created between 13 and 15 days ago AND who have never marked an estimate
  // as won or lost. Sends a single check-in email per user (at most once,
  // since the estimate creation window advances each day).
  if (hasResendCredentials()) {
    cron.schedule(
      "0 10 * * *",
      async () => {
        try {
          const now = Date.now();
          const dayMs = 24 * 60 * 60 * 1000;
          const windowStart = now - 15 * dayMs; // oldest: created 15d ago
          const windowEnd = now - 13 * dayMs;   // newest: created 13d ago

          // Find users whose LATEST estimate falls in the 13-15d window
          // and who have never marked any estimate as won or lost.
          // Using MAX(created_at) ensures we only email once — when their
          // most recent estimate is exactly in the follow-up window.
          const rows = await pool.query<{
            user_id: string;
            email: string;
            estimate_count: number;
          }>(
            `SELECT e.user_id,
                    u.email,
                    COUNT(e.id)::int AS estimate_count
               FROM estimates e
               JOIN users u ON u.id = e.user_id
              WHERE e.user_id IN (
                SELECT user_id
                  FROM estimates
                 GROUP BY user_id
                HAVING MAX(created_at) BETWEEN $1 AND $2
              )
                AND NOT EXISTS (
                  SELECT 1 FROM estimates e2
                  WHERE e2.user_id = e.user_id
                    AND e2.won_lost_status IS NOT NULL
                )
              GROUP BY e.user_id, u.email`,
            [windowStart, windowEnd],
          );

          const FOLLOWUP_TEMPLATE = "wonlost_followup_14d";
          let sent = 0;
          for (const row of rows.rows) {
            if (!row.email) continue;
            // Send to all contractors who have sent at least one estimate — the
            // won/lost follow-up is part of the product promise for everyone, not
            // gated to paid subscribers. Deduplication prevents re-sends.
            // Deduplication: INSERT with ON CONFLICT DO NOTHING — rowCount=0 means
            // the row already existed so the email was already sent; skip.
            let insertResult: { rowCount: number | null };
            try {
              insertResult = await pool.query(
                `INSERT INTO email_drip_queue (email, user_id, template_key, scheduled_for, status, created_at)
                 VALUES ($1, $2, $3, NOW()::text, 'sent', NOW()::text)
                 ON CONFLICT (email, template_key) DO NOTHING`,
                [row.email, row.user_id, FOLLOWUP_TEMPLATE],
              );
            } catch {
              continue; // skip if dedup insert fails
            }
            if ((insertResult.rowCount ?? 0) === 0) continue; // already sent previously
            await sendWonLostFollowUpEmail(row.email, row.user_id, row.estimate_count);
            sent++;
          }

          log("info", "Won/lost follow-up cron complete", {
            candidates: rows.rowCount ?? 0,
            sent,
          });
        } catch (err) {
          log("error", "Won/lost follow-up cron error", { error: String(err) });
        }
      },
      { timezone: "UTC" },
    );
    log("info", "Won/lost 14-day follow-up cron scheduled (10:00 UTC daily)");
  } else {
    log("info", "Won/lost follow-up cron: disabled — Resend credentials not set");
  }
}
