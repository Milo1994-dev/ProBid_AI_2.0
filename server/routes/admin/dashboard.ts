import express from "express";
import { db, pool, checkDatabaseConnection } from "../../db.js";
import { sql, eq, and, or, desc, count, sum, lt, gte, asc, inArray, between, like } from "drizzle-orm";
import {
  users, leads, estimates, subscriptions, purchases,
  affiliateEarnings, affiliateClicks, referrals,
  analytics, jobRuns, emailDripQueue, seoPages,
  usage, scrapedLeads, leadOutreachQueue, leadEmailAuditLog,
  homepageLeads, launchTasks, errorLogs,
} from "../../../shared/schema.js";
import { asyncHandler, requireAdminAuth, requireAdminAuthPage } from "../../lib/middleware.js";
import { log } from "../../lib/logger.js";
import { trackEvent } from "../../lib/analytics.js";
import { now, escapeHtml, dayKey } from "../../lib/utils.js";
import {
  PRICE_PRO, PRICE_BIZ, PRICE_PRO_ANNUAL, PRICE_BIZ_ANNUAL,
  isAdminRequest, SEO_SERVICES, SEO_STATES, generateSeoContent, hasEnv, hasResendCredentials,
} from "./shared.js";
import { getGooglePlacesApiStatus } from "../../lead-scraper.js";
import { outreachPaused, outreachPauseReason } from "../../lib/outreach-state.js";

const APP_URL =
  process.env.REPLIT_DEPLOYMENT === "1"
    ? "https://probidcore.net"
    : process.env.APP_URL || "http://localhost:5000";

export function registerAdminDashboardRoutes(app: express.Application) {
// --- Admin Dashboard ---
app.get(
  "/admin",
  requireAdminAuthPage,
  asyncHandler(async (req, res) => {
    const statusFilter = req.query.status as string | undefined;

    // Stats
    const totalUsersResult = await db.select({ c: count() }).from(users);
    const totalUsers = totalUsersResult[0]?.c || 0;

    const activeSubscribersResult = await db
      .select({ c: count() })
      .from(subscriptions)
      .where(eq(subscriptions.status, "active"));
    const activeSubscribers = activeSubscribersResult[0]?.c || 0;

    const totalEstimatesResult = await db
      .select({ c: count() })
      .from(estimates);
    const totalEstimates = totalEstimatesResult[0]?.c || 0;

    const totalLeadsResult = await db.select({ c: count() }).from(leads);
    const totalLeadsCnt = totalLeadsResult[0]?.c || 0;

    // Today's stats
    const today = dayKey();
    const signupsTodayResult = await db
      .select({ c: count() })
      .from(users)
      .where(gte(users.createdAt, Date.now() - 86400000));
    const signupsToday = signupsTodayResult[0]?.c || 0;

    const estimatesTodayResult = await db
      .select({ c: sum(usage.estimatesCount) })
      .from(usage)
      .where(eq(usage.dayKey, today));
    const estimatesToday = estimatesTodayResult[0]?.c || 0;

    // Revenue calculation (Pro monthly=$25, Pro annual=$20/mo equiv, Business monthly=$55, Business annual=$79/mo equiv)
    const [proMonthlyRes, bizMonthlyRes] = await Promise.all([
      db
        .select({ c: count() })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, "active"),
            eq(subscriptions.priceId, PRICE_PRO),
          ),
        ),
      db
        .select({ c: count() })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, "active"),
            eq(subscriptions.priceId, PRICE_BIZ),
          ),
        ),
    ]);
    const [proAnnualRes, bizAnnualRes] = await Promise.all([
      PRICE_PRO_ANNUAL
        ? db
            .select({ c: count() })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.status, "active"),
                eq(subscriptions.priceId, PRICE_PRO_ANNUAL),
              ),
            )
        : Promise.resolve([{ c: "0" }]),
      PRICE_BIZ_ANNUAL
        ? db
            .select({ c: count() })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.status, "active"),
                eq(subscriptions.priceId, PRICE_BIZ_ANNUAL),
              ),
            )
        : Promise.resolve([{ c: "0" }]),
    ]);
    const proMonthly = Number(proMonthlyRes[0]?.c || 0);
    const bizMonthly = Number(bizMonthlyRes[0]?.c || 0);
    const proAnnual = Number(proAnnualRes[0]?.c || 0);
    const bizAnnual = Number(bizAnnualRes[0]?.c || 0);
    const proSubs = proMonthly + proAnnual;
    const bizSubs = bizMonthly + bizAnnual;
    const mrr =
      proMonthly * 25 + proAnnual * 20 + bizMonthly * 55 + bizAnnual * 79;

    // Affiliate Stats
    const totalAffiliateClicksResult = await db
      .select({ c: count() })
      .from(affiliateClicks);
    const totalAffiliateClicks = totalAffiliateClicksResult[0]?.c || 0;

    const referralsSignedUpResult = await db
      .select({ c: count() })
      .from(referrals)
      .where(eq(referrals.status, "signed_up"));
    const referralsSignedUp = referralsSignedUpResult[0]?.c || 0;

    const referralsSubscribedResult = await db
      .select({ c: count() })
      .from(referrals)
      .where(eq(referrals.status, "subscribed"));
    const referralsSubscribed = referralsSubscribedResult[0]?.c || 0;

    const referralsCancelledResult = await db
      .select({ c: count() })
      .from(referrals)
      .where(eq(referrals.status, "cancelled"));
    const referralsCancelled = referralsCancelledResult[0]?.c || 0;

    const pendingEarningsResult = await db
      .select({ c: sum(affiliateEarnings.amountCents) })
      .from(affiliateEarnings)
      .where(eq(affiliateEarnings.status, "pending"));
    const pendingEarningsCents = pendingEarningsResult[0]?.c || 0;

    const paidEarningsResult = await db
      .select({ c: sum(affiliateEarnings.amountCents) })
      .from(affiliateEarnings)
      .where(eq(affiliateEarnings.status, "paid"));
    const paidEarningsCents = paidEarningsResult[0]?.c || 0;

    // Lead outreach funnel stats (all-time + today)
    const leadFunnelStart = new Date();
    leadFunnelStart.setHours(0, 0, 0, 0);
    const leadFunnelStartMs = leadFunnelStart.getTime();
    const leadFunnelStartISO = leadFunnelStart.toISOString();

    const scrapedLeadsTotalResult = await db
      .select({ c: count() })
      .from(scrapedLeads);
    const scrapedLeadsTotal = Number(scrapedLeadsTotalResult[0]?.c || 0);

    const scrapedLeadsTodayResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(gte(scrapedLeads.createdAt, leadFunnelStartMs));
    const scrapedLeadsToday = Number(scrapedLeadsTodayResult[0]?.c || 0);

    // Use audit log (immutable) for emailed counts — distinct leads that received at least one email
    const emailedLeadsRaw = await pool.query<{ c: string }>(
      `SELECT COUNT(DISTINCT lead_id) AS c FROM lead_email_audit_log WHERE status = 'sent'`,
    );
    const emailedLeads = Number(emailedLeadsRaw.rows[0]?.c || 0);

    const emailedLeadsTodayRaw = await pool.query<{ c: string }>(
      `SELECT COUNT(DISTINCT lead_id) AS c FROM lead_email_audit_log WHERE status = 'sent' AND sent_at >= $1`,
      [leadFunnelStartISO],
    );
    const emailedLeadsToday = Number(emailedLeadsTodayRaw.rows[0]?.c || 0);

    const openedLeadsResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(sql`opened_at IS NOT NULL`);
    const openedLeads = Number(openedLeadsResult[0]?.c || 0);

    const openedLeadsTodayResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(
        and(
          sql`opened_at IS NOT NULL`,
          gte(scrapedLeads.openedAt, leadFunnelStartMs),
        ),
      );
    const openedLeadsToday = Number(openedLeadsTodayResult[0]?.c || 0);

    const clickedLeadsResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(sql`clicked_at IS NOT NULL`);
    const clickedLeads = Number(clickedLeadsResult[0]?.c || 0);

    const clickedLeadsTodayResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(
        and(
          sql`clicked_at IS NOT NULL`,
          gte(scrapedLeads.clickedAt, leadFunnelStartMs),
        ),
      );
    const clickedLeadsToday = Number(clickedLeadsTodayResult[0]?.c || 0);

    const repliedLeadsResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(sql`replied_at IS NOT NULL`);
    const repliedLeads = Number(repliedLeadsResult[0]?.c || 0);

    const repliedLeadsTodayResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(
        and(
          sql`replied_at IS NOT NULL`,
          gte(scrapedLeads.repliedAt, leadFunnelStartMs),
        ),
      );
    const repliedLeadsToday = Number(repliedLeadsTodayResult[0]?.c || 0);

    // Recent replied leads for the Hot Leads panel
    const recentRepliedLeads = await db
      .select({
        id: scrapedLeads.id,
        name: scrapedLeads.name,
        email: scrapedLeads.email,
        phone: scrapedLeads.phone,
        businessType: scrapedLeads.businessType,
        location: scrapedLeads.location,
        repliedAt: scrapedLeads.repliedAt,
        score: scrapedLeads.score,
      })
      .from(scrapedLeads)
      .where(sql`replied_at IS NOT NULL`)
      .orderBy(desc(scrapedLeads.repliedAt))
      .limit(10);

    const convertedLeadsResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(sql`converted_at IS NOT NULL`);
    const convertedLeads = Number(convertedLeadsResult[0]?.c || 0);

    const convertedLeadsTodayResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(
        and(
          sql`converted_at IS NOT NULL`,
          gte(scrapedLeads.convertedAt, leadFunnelStartMs),
        ),
      );
    const convertedLeadsToday = Number(convertedLeadsTodayResult[0]?.c || 0);

    const dncLeadsResult = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(eq(scrapedLeads.doNotContact, true));
    const dncLeads = Number(dncLeadsResult[0]?.c || 0);

    // System alerts (unresolved)
    const sysAlertsRaw = await pool
      .query<{
        id: number;
        type: string;
        message: string;
        severity: string;
        created_at: number;
      }>(`SELECT id, type, message, severity, created_at FROM system_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`)
      .catch(() => ({
        rows: [] as {
          id: number;
          type: string;
          message: string;
          severity: string;
          created_at: number;
        }[],
      }));
    const unresolvedSystemAlerts = sysAlertsRaw.rows;

    // Unacknowledged outreach pause alerts
    const pauseAlertsRaw = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM lead_outreach_config WHERE key LIKE 'alert_%' ORDER BY key DESC LIMIT 10`,
    );
    const unackAlerts: Array<{ key: string; reason: string; ts: string }> = [];
    for (const row of pauseAlertsRaw.rows) {
      try {
        const a = JSON.parse(row.value) as {
          reason?: string;
          ts?: string;
          acknowledged?: boolean;
        };
        if (!a.acknowledged)
          unackAlerts.push({
            key: row.key,
            reason: a.reason ?? "",
            ts: a.ts ?? "",
          });
      } catch {
        /* skip malformed */
      }
    }

    // Recent users with affiliate info - use raw SQL for complex join
    const recentUsersRaw = await pool.query(`
    SELECT u.id, u.email, u.created_at, u.affiliate_code, u.referred_by_user_id, u.commission_rate,
           s.status as sub_status, s.price_id,
           r.email as referrer_email
    FROM users u
    LEFT JOIN subscriptions s ON u.id = s.user_id
    LEFT JOIN users r ON u.referred_by_user_id = r.id
    ORDER BY u.created_at DESC LIMIT 30
  `);
    const recentUsers = recentUsersRaw.rows as any[];

    // Referrals with filtering - use raw SQL for complex join
    let referralsQueryParams: any[] = [];
    let referralsQuery = `
    SELECT ref.id, ref.created_at, ref.status,
           ru.email as referrer_email, ru.id as referrer_id,
           rd.email as referred_email, rd.id as referred_id
    FROM referrals ref
    JOIN users ru ON ref.referrer_user_id = ru.id
    JOIN users rd ON ref.referred_user_id = rd.id
  `;
    if (
      statusFilter &&
      ["signed_up", "subscribed", "cancelled"].includes(statusFilter)
    ) {
      referralsQuery += ` WHERE ref.status = $1`;
      referralsQueryParams.push(statusFilter);
    }
    referralsQuery += ` ORDER BY ref.created_at DESC LIMIT 50`;
    const referralsRaw = await pool.query(referralsQuery, referralsQueryParams);
    const referralsList = referralsRaw.rows as any[];

    // Earnings - use raw SQL for complex join
    const earningsRaw = await pool.query(`
    SELECT e.id, e.created_at, e.amount_cents, e.status, e.stripe_invoice_id,
           a.email as affiliate_email, a.id as affiliate_id,
           r.email as referred_email, r.id as referred_id
    FROM affiliate_earnings e
    JOIN users a ON e.affiliate_user_id = a.id
    JOIN users r ON e.referred_user_id = r.id
    ORDER BY e.created_at DESC LIMIT 50
  `);
    const earningsList = earningsRaw.rows as any[];

    // Recent analytics events
    const recentEvents = await db
      .select({
        event: analytics.event,
        userId: analytics.userId,
        data: analytics.data,
        createdAt: analytics.createdAt,
      })
      .from(analytics)
      .orderBy(desc(analytics.createdAt))
      .limit(30);

    // Conversion funnel (last 7 days)
    const weekAgo = Date.now() - 7 * 86400000;
    const signupsWeekResult = await db
      .select({ c: count() })
      .from(users)
      .where(gte(users.createdAt, weekAgo));
    const signupsWeek = signupsWeekResult[0]?.c || 0;

    const estimatesWeekResult = await db
      .select({ c: count() })
      .from(estimates)
      .where(gte(estimates.createdAt, weekAgo));
    const estimatesWeek = estimatesWeekResult[0]?.c || 0;

    const conversionsWeekResult = await db
      .select({ c: count() })
      .from(subscriptions)
      .where(
        and(
          gte(subscriptions.updatedAt, weekAgo),
          eq(subscriptions.status, "active"),
        ),
      );
    const conversionsWeek = conversionsWeekResult[0]?.c || 0;

    // Marketing Analytics - Signups by source (UTM tracking)
    const signupEventsResult = await db
      .select({
        data: analytics.data,
        userId: analytics.userId,
        createdAt: analytics.createdAt,
      })
      .from(analytics)
      .where(eq(analytics.event, "signup"));

    // Parse UTM data and aggregate by source
    const sourceStats: Record<
      string,
      { signups: number; conversions: number; campaigns: Set<string> }
    > = {};
    const campaignStats: Record<
      string,
      { signups: number; conversions: number; source: string }
    > = {};

    for (const event of signupEventsResult) {
      if (!event.data) continue;
      try {
        const data = JSON.parse(event.data);
        const source = data.utm_source || "direct";
        const campaign = data.utm_campaign || "";

        if (!sourceStats[source]) {
          sourceStats[source] = {
            signups: 0,
            conversions: 0,
            campaigns: new Set(),
          };
        }
        sourceStats[source].signups++;
        if (campaign) sourceStats[source].campaigns.add(campaign);

        // Track campaign stats
        if (campaign) {
          if (!campaignStats[campaign]) {
            campaignStats[campaign] = { signups: 0, conversions: 0, source };
          }
          campaignStats[campaign].signups++;
        }

        // Check if this user converted to paid
        if (event.userId) {
          const userSubResult = await db
            .select({ status: subscriptions.status })
            .from(subscriptions)
            .where(eq(subscriptions.userId, event.userId));
          if (userSubResult[0]?.status === "active") {
            sourceStats[source].conversions++;
            if (campaign && campaignStats[campaign]) {
              campaignStats[campaign].conversions++;
            }
          }
        }
      } catch (e) {
        // Skip malformed JSON
      }
    }

    // PDF guarantee badge clickthroughs (last 30 days). Tracked when a
    // homeowner taps a trust-bar badge inside a PDF estimate and lands on
    // /guarantees with utm_source=pdf_estimate. Aggregated by guarantee
    // (utm_content) so we can see which promise drives the most viral
    // traffic.
    const guaranteeWindowStart = Date.now() - 30 * 86400000;
    const guaranteeClickRows = await db
      .select({ data: analytics.data })
      .from(analytics)
      .where(
        and(
          eq(analytics.event, "guarantee_badge_click"),
          gte(analytics.createdAt, guaranteeWindowStart),
        ),
      );
    const guaranteeClickStats: Record<string, number> = {
      speed: 0,
      "win-jobs": 0,
      "money-back": 0,
      unknown: 0,
    };
    const guaranteeClickEstimates = new Set<string>();
    for (const row of guaranteeClickRows) {
      if (!row.data) continue;
      try {
        const parsed = JSON.parse(row.data);
        const content =
          typeof parsed.utm_content === "string" &&
          guaranteeClickStats[parsed.utm_content] !== undefined
            ? parsed.utm_content
            : "unknown";
        guaranteeClickStats[content]++;
        if (typeof parsed.estimate_id === "string" && parsed.estimate_id) {
          guaranteeClickEstimates.add(parsed.estimate_id);
        }
      } catch {
        guaranteeClickStats.unknown++;
      }
    }
    const guaranteeClickTotal = guaranteeClickRows.length;

    // Sort sources by signups
    const sortedSources = Object.entries(sourceStats).sort(
      (a, b) => b[1].signups - a[1].signups,
    );

    // Sort campaigns by signups and take top 10
    const sortedCampaigns = Object.entries(campaignStats)
      .sort((a, b) => b[1].signups - a[1].signups)
      .slice(0, 10);

    const usersHtml = recentUsers
      .map((u: any) => {
        const date = new Date(u.created_at).toLocaleDateString();
        const plan =
          u.price_id === PRICE_BIZ
            ? "Business"
            : u.price_id === PRICE_PRO
              ? "Pro"
              : u.price_id === PRICE_BIZ_ANNUAL
                ? "Business — yearly"
                : u.price_id === PRICE_PRO_ANNUAL
                  ? "Pro — yearly"
                  : "Free";
        const statusBadge =
          u.sub_status === "active"
            ? `<span class="badge badge-green">Active</span>`
            : `<span class="badge badge-gray">-</span>`;
        const affiliateCode = u.affiliate_code || "-";
        const referredBy = u.referrer_email
          ? escapeHtml(u.referrer_email)
          : "-";
        const commissionRate = u.commission_rate
          ? `${(u.commission_rate * 100).toFixed(0)}%`
          : "20%";
        return `<tr>
      <td>${escapeHtml(u.email)}</td>
      <td>${plan}</td>
      <td>${statusBadge}</td>
      <td><code>${escapeHtml(affiliateCode)}</code></td>
      <td>${referredBy}</td>
      <td>${commissionRate}</td>
      <td>${date}</td>
      <td>
        <form method="POST" action="/admin/set-plan" style="display:inline">
          <input type="hidden" name="user_id" value="${u.id}">
          <select name="plan" onchange="this.form.submit()" class="plan-select">
            <option value="">Set Plan</option>
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="business">Business</option>
          </select>
        </form>
      </td>
    </tr>`;
      })
      .join("");

    const referralsHtml = referralsList
      .map((r: any) => {
        const date = r.created_at
          ? new Date(r.created_at).toLocaleDateString()
          : "-";
        const statusClass =
          r.status === "subscribed"
            ? "badge-green"
            : r.status === "cancelled"
              ? "badge-red"
              : "badge-yellow";
        return `<tr>
      <td>${date}</td>
      <td>${escapeHtml(r.referrer_email || "-")}</td>
      <td>${escapeHtml(r.referred_email || "-")}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(r.status)}</span></td>
    </tr>`;
      })
      .join("");

    const earningsHtml = earningsList
      .map((e: any) => {
        const date = e.created_at
          ? new Date(e.created_at).toLocaleDateString()
          : "-";
        const amount = `$${(e.amount_cents / 100).toFixed(2)}`;
        const statusClass =
          e.status === "paid" ? "badge-green" : "badge-yellow";
        return `<tr>
      <td>${date}</td>
      <td>${escapeHtml(e.affiliate_email || "-")}</td>
      <td>${escapeHtml(e.referred_email || "-")}</td>
      <td class="amount">${amount}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(e.status)}</span></td>
      <td><code>${e.stripe_invoice_id ? escapeHtml(e.stripe_invoice_id.slice(0, 20)) + "..." : "-"}</code></td>
    </tr>`;
      })
      .join("");

    const eventsHtml = recentEvents
      .map((e: any) => {
        const date = new Date(e.createdAt).toLocaleString();
        return `<tr><td>${escapeHtml(e.event)}</td><td>${e.userId ? escapeHtml(e.userId.slice(0, 8)) + "..." : "-"}</td><td>${date}</td></tr>`;
      })
      .join("");

    // Marketing metrics HTML
    const sourcesHtml = sortedSources
      .map(([source, stats]) => {
        const convRate =
          stats.signups > 0
            ? Math.round((stats.conversions / stats.signups) * 100)
            : 0;
        const campaigns = stats.campaigns.size;
        return `<tr>
      <td><code>${escapeHtml(source)}</code></td>
      <td class="amount">${stats.signups}</td>
      <td class="amount">${stats.conversions}</td>
      <td><span class="badge ${convRate >= 10 ? "badge-green" : convRate >= 5 ? "badge-yellow" : "badge-gray"}">${convRate}%</span></td>
      <td>${campaigns}</td>
    </tr>`;
      })
      .join("");

    const campaignsHtml = sortedCampaigns
      .map(([campaign, stats]) => {
        const convRate =
          stats.signups > 0
            ? Math.round((stats.conversions / stats.signups) * 100)
            : 0;
        return `<tr>
      <td><code>${escapeHtml(campaign)}</code></td>
      <td><code>${escapeHtml(stats.source)}</code></td>
      <td class="amount">${stats.signups}</td>
      <td class="amount">${stats.conversions}</td>
      <td><span class="badge ${convRate >= 10 ? "badge-green" : convRate >= 5 ? "badge-yellow" : "badge-gray"}">${convRate}%</span></td>
    </tr>`;
      })
      .join("");

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ProBid AI Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4f46e5;
      --primary-light: #6366f1;
      --accent: #22c55e;
      --accent-dark: #16a34a;
      --bg-dark: #0a0e1a;
      --bg-card: rgba(18, 26, 42, 0.6);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
      --glass-bg: rgba(255, 255, 255, 0.05);
      --glass-border: rgba(255, 255, 255, 0.1);
      --yellow: #eab308;
      --red: #ef4444;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg-dark);color:var(--text-primary);padding:24px;line-height:1.5}
    .container{max-width:1400px;margin:0 auto}
    h1{font-size:32px;margin-bottom:8px;font-weight:800;background:linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .subtitle{color:var(--text-muted);margin-bottom:32px}
    h2{font-size:18px;margin:32px 0 16px;color:var(--text-primary);font-weight:700;display:flex;align-items:center;gap:8px}
    h2::before{content:'';width:4px;height:20px;background:linear-gradient(180deg,var(--primary),var(--accent));border-radius:2px}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
    .stat{background:var(--bg-card);backdrop-filter:blur(10px);border:1px solid var(--border-color);border-radius:16px;padding:24px;text-align:center;transition:all 0.3s ease}
    .stat:hover{border-color:var(--border-light);transform:translateY(-2px)}
    .stat-value{font-size:36px;font-weight:800;color:var(--text-primary)}
    .stat-label{font-size:13px;color:var(--text-muted);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px}
    .stat.highlight .stat-value{color:var(--accent)}
    .stat.revenue .stat-value{color:var(--yellow)}
    .stat.pending .stat-value{color:var(--yellow)}
    .stat.paid .stat-value{color:var(--accent)}
    .stat.clicks .stat-value{color:var(--primary-light)}
    .glass-card{background:var(--bg-card);backdrop-filter:blur(10px);border:1px solid var(--border-color);border-radius:16px;padding:24px;margin-bottom:24px}
    table{width:100%;border-collapse:collapse;background:var(--bg-card);backdrop-filter:blur(10px);border:1px solid var(--border-color);border-radius:16px;overflow:hidden}
    th,td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--border-color)}
    th{background:rgba(0,0,0,0.3);font-weight:600;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:rgba(99,102,241,0.05)}
    td.amount{font-weight:600;color:var(--accent);font-family:'SF Mono',Monaco,monospace}
    code{background:rgba(0,0,0,0.3);padding:2px 8px;border-radius:4px;font-size:12px;color:var(--primary-light)}
    .badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase}
    .badge-green{background:rgba(34,197,94,0.15);color:#22c55e}
    .badge-yellow{background:rgba(234,179,8,0.15);color:#eab308}
    .badge-red{background:rgba(239,68,68,0.15);color:#ef4444}
    .badge-gray{background:rgba(148,163,184,0.15);color:#94a3b8}
    .funnel{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
    .funnel-step{background:var(--bg-card);backdrop-filter:blur(10px);border:1px solid var(--border-color);border-radius:16px;padding:20px;text-align:center}
    .funnel-value{font-size:32px;font-weight:800;color:var(--text-primary)}
    .funnel-label{font-size:12px;color:var(--text-muted);margin-top:4px;text-transform:uppercase}
    .funnel-rate{font-size:12px;color:var(--accent);margin-top:8px;font-weight:600}
    .actions{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:32px}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;border:none;cursor:pointer;transition:all 0.3s ease}
    .btn-primary{background:linear-gradient(135deg,var(--primary),var(--primary-light));color:white}
    .btn-primary:hover{transform:translateY(-2px);box-shadow:0 4px 20px rgba(79,70,229,0.4)}
    .btn-success{background:linear-gradient(135deg,var(--accent),var(--accent-dark));color:white}
    .btn-success:hover{transform:translateY(-2px);box-shadow:0 4px 20px rgba(34,197,94,0.4)}
    .btn-outline{background:transparent;border:1px solid var(--border-color);color:var(--text-primary)}
    .btn-outline:hover{border-color:var(--border-light);background:var(--glass-bg)}
    .filter-bar{display:flex;gap:8px;margin-bottom:16px}
    .filter-link{padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;color:var(--text-muted);background:var(--glass-bg);border:1px solid var(--border-color);transition:all 0.2s}
    .filter-link:hover,.filter-link.active{color:var(--text-primary);border-color:var(--primary);background:rgba(79,70,229,0.1)}
    .plan-select{background:rgba(0,0,0,0.3);border:1px solid var(--border-color);border-radius:6px;padding:6px 10px;color:var(--text-primary);font-size:12px;cursor:pointer}
    .plan-select:hover{border-color:var(--border-light)}
    .section-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
    @media(max-width:1200px){.section-grid{grid-template-columns:1fr}}
    .table-wrapper{overflow-x:auto}
    .totals-row{display:flex;justify-content:flex-end;gap:24px;padding:16px;background:rgba(0,0,0,0.2);border-radius:0 0 16px 16px;margin-top:-1px}
    .total-item{display:flex;align-items:center;gap:8px}
    .total-label{color:var(--text-muted);font-size:13px}
    .total-value{font-weight:700;font-size:16px}
    .total-value.pending{color:var(--yellow)}
    .total-value.paid{color:var(--accent)}
  </style>
</head>
<body>
<div class="container">
  <h1>ProBid AI Admin Dashboard</h1>
  <p class="subtitle">Manage users, affiliates, and earnings</p>

  <h2>Quick Actions</h2>
  <div class="actions">
    <a href="/admin/ads" class="btn btn-primary" style="background:linear-gradient(135deg,#4f46e5,#6366f1)">
      📊 Ad Campaigns
    </a>
    <a href="/admin/reviews" class="btn btn-outline" style="color:#facc15;border-color:#facc15">
      ⭐ Reviews
    </a>
    <a href="/leaderboard" class="btn btn-outline" target="_blank" style="color:#22c55e;border-color:#22c55e">
      🏆 Referral Leaderboard
    </a>
    <a href="/admin/payouts.csv" class="btn btn-outline">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      Export Pending Payouts CSV
    </a>
    <form method="POST" action="/admin/mark-paid" style="display:inline" onsubmit="return confirm('Mark all pending earnings as paid?')">
      <button type="submit" class="btn btn-success">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        Mark All Pending as Paid
      </button>
    </form>
    <form method="POST" action="/admin/seed-seo" style="display:inline">
      <button type="submit" class="btn btn-primary">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        Seed SEO Pages
      </button>
    </form>
  </div>

  <h2>Overview Stats</h2>
  <div class="stats">
    <div class="stat"><div class="stat-value">${totalUsers}</div><div class="stat-label">Total Users</div></div>
    <div class="stat highlight"><div class="stat-value">${activeSubscribers}</div><div class="stat-label">Paid Subscribers</div></div>
    <div class="stat revenue"><div class="stat-value">$${mrr}</div><div class="stat-label">Monthly Revenue</div></div>
    <div class="stat"><div class="stat-value">${totalEstimates}</div><div class="stat-label">Estimates</div></div>
    <div class="stat"><div class="stat-value">${totalLeadsCnt}</div><div class="stat-label">Leads</div></div>
  </div>

  <h2>Affiliate Stats</h2>
  <div class="stats">
    <div class="stat clicks"><div class="stat-value">${totalAffiliateClicks}</div><div class="stat-label">Affiliate Clicks</div></div>
    <div class="stat"><div class="stat-value">${referralsSignedUp}</div><div class="stat-label">Signed Up</div></div>
    <div class="stat highlight"><div class="stat-value">${referralsSubscribed}</div><div class="stat-label">Subscribed</div></div>
    <div class="stat"><div class="stat-value">${referralsCancelled}</div><div class="stat-label">Cancelled</div></div>
    <div class="stat pending"><div class="stat-value">$${(pendingEarningsCents / 100).toFixed(2)}</div><div class="stat-label">Pending Earnings</div></div>
    <div class="stat paid"><div class="stat-value">$${(paidEarningsCents / 100).toFixed(2)}</div><div class="stat-label">Paid Earnings</div></div>
  </div>

  <div style="margin:24px 0 12px;padding:14px 18px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.25);border-radius:10px;display:flex;align-items:center;gap:14px">
    <div style="font-size:20px">🩺</div>
    <div style="flex:1">
      <div style="font-weight:700;font-size:14px;color:#e8f0ff;margin-bottom:2px">System Health Dashboard</div>
      <div style="font-size:12px;color:#94a3b8">Traffic-light view of every subsystem, cron heartbeats, webhook liveness, and active alerts — all in one place.</div>
    </div>
    <a href="/admin/health" style="background:#60a5fa;color:#000;font-weight:700;font-size:13px;padding:8px 16px;border-radius:6px;text-decoration:none">Open →</a>
  </div>

  <h2>Lead Outreach Funnel <span style="font-size:13px;color:#94a3b8;font-weight:400">(all-time / today)</span></h2>
  <div class="stats">
    <div class="stat"><div class="stat-value">${scrapedLeadsTotal}</div><div class="stat-value" style="font-size:14px;color:#94a3b8">+${scrapedLeadsToday}</div><div class="stat-label">Scraped</div></div>
    <div class="stat"><div class="stat-value">${emailedLeads}</div><div class="stat-value" style="font-size:14px;color:#94a3b8">+${emailedLeadsToday}</div><div class="stat-label">Emailed</div></div>
    <div class="stat clicks"><div class="stat-value">${openedLeads}</div><div class="stat-value" style="font-size:14px;color:#94a3b8">+${openedLeadsToday}</div><div class="stat-label">Opened</div></div>
    <div class="stat highlight"><div class="stat-value">${clickedLeads}</div><div class="stat-value" style="font-size:14px;color:#94a3b8">+${clickedLeadsToday}</div><div class="stat-label">Clicked CTA</div></div>
    <div class="stat"><div class="stat-value">${repliedLeads}</div><div class="stat-value" style="font-size:14px;color:#94a3b8">+${repliedLeadsToday}</div><div class="stat-label">Replied</div></div>
    <div class="stat paid"><div class="stat-value">${convertedLeads}</div><div class="stat-value" style="font-size:14px;color:#94a3b8">+${convertedLeadsToday}</div><div class="stat-label">Converted</div></div>
    <div class="stat pending"><div class="stat-value">${dncLeads}</div><div class="stat-label">Unsubscribed</div></div>
  </div>
  <div style="margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap">
    <form method="POST" action="/api/cron/scrape-leads" style="display:inline">
      <button type="submit" class="btn btn-outline" style="font-size:13px;padding:8px 16px">Run Lead Scrape</button>
    </form>
    <form method="POST" action="/api/cron/process-outreach" style="display:inline">
      <button type="submit" class="btn btn-outline" style="font-size:13px;padding:8px 16px">Process Outreach Queue</button>
    </form>
    ${
      outreachPaused
        ? `
      <span style="background:rgba(239,68,68,0.15);color:#f87171;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600">
        ⚠ Outreach paused: ${escapeHtml(outreachPauseReason)}
      </span>
      <form method="POST" action="/api/admin/outreach-resume" style="display:inline">
        <button type="submit" class="btn btn-outline" style="font-size:13px;padding:8px 16px;color:#22c55e;border-color:#22c55e">Resume Outreach</button>
      </form>
    `
        : ""
    }
  </div>
  ${
    unresolvedSystemAlerts.length > 0
      ? `
  <div style="margin-bottom:20px">
    <h3 style="margin:0 0 10px;font-size:15px;color:#ef4444;font-weight:600">🚨 ${unresolvedSystemAlerts.length} System Alert${unresolvedSystemAlerts.length > 1 ? "s" : ""}</h3>
    ${unresolvedSystemAlerts
      .map((a) => {
        const sevColor = a.severity === "critical" ? "#ef4444" : "#f59e0b";
        const ts = new Date(a.created_at).toLocaleString();
        return `<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:12px 16px;margin-bottom:8px;display:flex;gap:12px;align-items:flex-start">
        <div style="flex:1">
          <div style="font-size:12px;color:${sevColor};font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${escapeHtml(a.severity)} — ${escapeHtml(a.type)}</div>
          <div style="font-size:13px;color:#e8f0ff">${escapeHtml(a.message)}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:4px">${escapeHtml(ts)}</div>
        </div>
        <form method="POST" action="/api/admin/system-alerts/${a.id}/resolve" style="flex-shrink:0">
          <button type="submit" style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:#22c55e;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;font-weight:600">Resolve</button>
        </form>
      </div>`;
      })
      .join("")}
  </div>`
      : ""
  }

  ${
    unackAlerts.length > 0
      ? `
  <div style="margin-bottom:20px">
    <h3 style="margin:0 0 10px;font-size:15px;color:#f87171;font-weight:600">⚠ ${unackAlerts.length} Unacknowledged Pause Alert${unackAlerts.length > 1 ? "s" : ""}</h3>
    ${unackAlerts
      .map(
        (a) => `
      <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px 16px;margin-bottom:8px;display:flex;gap:12px;align-items:flex-start">
        <div style="flex:1">
          <div style="font-size:13px;color:#f87171;font-weight:600">${escapeHtml(a.reason)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:4px">${escapeHtml(a.ts)}</div>
        </div>
        <form method="POST" action="/api/admin/outreach-alerts/${escapeHtml(a.key)}/acknowledge" style="flex-shrink:0">
          <button type="submit" style="background:none;border:1px solid #94a3b8;color:#94a3b8;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer">Dismiss</button>
        </form>
      </div>
    `,
      )
      .join("")}
  </div>`
      : ""
  }

  ${
    recentRepliedLeads.length > 0
      ? `
  <div style="margin-bottom:28px">
    <h2 style="margin:0 0 12px;display:flex;align-items:center;gap:10px">
      🔥 Hot Leads — Replied
      <span style="font-size:13px;color:#94a3b8;font-weight:400">(respond while they're warm)</span>
    </h2>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${recentRepliedLeads.map((lead) => {
        const ago = lead.repliedAt
          ? (() => {
              const diff = Date.now() - lead.repliedAt;
              if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
              if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
              return `${Math.floor(diff / 86400000)}d ago`;
            })()
          : "Unknown";
        const subject = encodeURIComponent(`Re: Your inquiry about ProBid AI`);
        const body = encodeURIComponent(`Hi ${escapeHtml(lead.name || "there")},\n\nThanks for getting back to us! I wanted to personally follow up...\n\nBest,\nProBid AI Team`);
        const mailtoLink = `mailto:${escapeHtml(lead.email || "")}?subject=${subject}&body=${body}`;
        return `
        <div style="background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.25);border-radius:10px;padding:14px 18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <div style="font-size:14px;font-weight:700;color:#e8f0ff;margin-bottom:2px">${escapeHtml(lead.name || "Unknown Business")}</div>
            <div style="font-size:12px;color:#94a3b8">${escapeHtml(lead.businessType || "")}${lead.businessType && lead.location ? " · " : ""}${escapeHtml(lead.location || "")}</div>
          </div>
          <div style="font-size:12px;color:#4ade80;font-weight:600;white-space:nowrap">${escapeHtml(ago)}</div>
          <div style="display:flex;gap:8px;flex-shrink:0">
            ${lead.email ? `<a href="${mailtoLink}" style="background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);color:#22c55e;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:700;text-decoration:none;white-space:nowrap">✉ Reply Now</a>` : ""}
            ${lead.phone ? `<a href="tel:${escapeHtml(lead.phone)}" style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.4);color:#818cf8;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:700;text-decoration:none;white-space:nowrap">📞 Call</a>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>`
      : ""
  }

  <h2>Today's Activity</h2>
  <div class="stats">
    <div class="stat"><div class="stat-value">${signupsToday}</div><div class="stat-label">New Signups (24h)</div></div>
    <div class="stat"><div class="stat-value">${estimatesToday || 0}</div><div class="stat-label">Estimates Today</div></div>
    <div class="stat"><div class="stat-value">${proSubs}</div><div class="stat-label">Pro Plans</div></div>
    <div class="stat"><div class="stat-value">${bizSubs}</div><div class="stat-label">Business Plans</div></div>
  </div>

  <h2>7-Day Conversion Funnel</h2>
  <div class="funnel">
    <div class="funnel-step">
      <div class="funnel-value">${signupsWeek}</div>
      <div class="funnel-label">Signups</div>
    </div>
    <div class="funnel-step">
      <div class="funnel-value">${estimatesWeek}</div>
      <div class="funnel-label">Estimates</div>
      <div class="funnel-rate">${signupsWeek ? Math.round((estimatesWeek / signupsWeek) * 100) : 0}% activation</div>
    </div>
    <div class="funnel-step">
      <div class="funnel-value">${conversionsWeek}</div>
      <div class="funnel-label">Paid Conversions</div>
      <div class="funnel-rate">${signupsWeek ? Math.round((conversionsWeek / signupsWeek) * 100) : 0}% conversion</div>
    </div>
  </div>

  <h2>PDF Guarantee Badge Clicks <span style="font-size:13px;color:#94a3b8;font-weight:400">(last 30 days)</span></h2>
  <div class="funnel">
    <div class="funnel-step">
      <div class="funnel-value">${guaranteeClickTotal}</div>
      <div class="funnel-label">Total Clicks</div>
      <div class="funnel-rate">${guaranteeClickEstimates.size} estimates drove clicks</div>
    </div>
    <div class="funnel-step">
      <div class="funnel-value">${guaranteeClickStats.speed}</div>
      <div class="funnel-label">60-Second Speed</div>
    </div>
    <div class="funnel-step">
      <div class="funnel-value">${guaranteeClickStats["win-jobs"]}</div>
      <div class="funnel-label">Win-Jobs</div>
    </div>
    <div class="funnel-step">
      <div class="funnel-value">${guaranteeClickStats["money-back"]}</div>
      <div class="funnel-label">30-Day Money-Back</div>
    </div>
  </div>

  <h2>Marketing Analytics</h2>
  <div class="section-grid">
    <div>
      <h3 style="font-size:16px;margin-bottom:12px;color:var(--text-muted)">Signups by Source</h3>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Source</th><th>Signups</th><th>Conversions</th><th>Conv Rate</th><th>Campaigns</th></tr></thead>
          <tbody>${sourcesHtml || "<tr><td colspan='5'>No UTM data yet. Share links with utm_source parameter to track.</td></tr>"}</tbody>
        </table>
      </div>
    </div>
    <div>
      <h3 style="font-size:16px;margin-bottom:12px;color:var(--text-muted)">Top Campaigns</h3>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Campaign</th><th>Source</th><th>Signups</th><th>Conversions</th><th>Conv Rate</th></tr></thead>
          <tbody>${campaignsHtml || "<tr><td colspan='5'>No campaign data yet. Use utm_campaign parameter to track.</td></tr>"}</tbody>
        </table>
      </div>
    </div>
  </div>

  <h2>Users (with Affiliate Info)</h2>
  <div class="table-wrapper">
    <table>
      <thead><tr><th>Email</th><th>Plan</th><th>Status</th><th>Affiliate Code</th><th>Referred By</th><th>Commission</th><th>Joined</th><th>Actions</th></tr></thead>
      <tbody>${usersHtml || "<tr><td colspan='8'>No users yet</td></tr>"}</tbody>
    </table>
  </div>

  <div class="section-grid">
    <div>
      <h2>Referrals</h2>
      <div class="filter-bar">
        <a href="/admin" class="filter-link ${!statusFilter ? "active" : ""}">All</a>
        <a href="/admin?status=signed_up" class="filter-link ${statusFilter === "signed_up" ? "active" : ""}">Signed Up</a>
        <a href="/admin?status=subscribed" class="filter-link ${statusFilter === "subscribed" ? "active" : ""}">Subscribed</a>
        <a href="/admin?status=cancelled" class="filter-link ${statusFilter === "cancelled" ? "active" : ""}">Cancelled</a>
      </div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Date</th><th>Referrer</th><th>Referred</th><th>Status</th></tr></thead>
          <tbody>${referralsHtml || "<tr><td colspan='4'>No referrals yet</td></tr>"}</tbody>
        </table>
      </div>
    </div>

    <div>
      <h2>Affiliate Earnings</h2>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Date</th><th>Affiliate</th><th>Referred User</th><th>Amount</th><th>Status</th><th>Invoice</th></tr></thead>
          <tbody>${earningsHtml || "<tr><td colspan='6'>No earnings yet</td></tr>"}</tbody>
        </table>
        <div class="totals-row">
          <div class="total-item">
            <span class="total-label">Pending:</span>
            <span class="total-value pending">$${(pendingEarningsCents / 100).toFixed(2)}</span>
          </div>
          <div class="total-item">
            <span class="total-label">Paid:</span>
            <span class="total-value paid">$${(paidEarningsCents / 100).toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <h2>Recent Events</h2>
  <table>
    <thead><tr><th>Event</th><th>User</th><th>Time</th></tr></thead>
    <tbody>${eventsHtml || "<tr><td colspan='3'>No events yet</td></tr>"}</tbody>
  </table>

  <h2>Scraped Lead Management</h2>
  <div id="leadBuckets" class="stats" style="margin-bottom:16px">
    <div class="stat highlight"><div id="hotCount" class="stat-value">-</div><div class="stat-label">Hot (70+)</div></div>
    <div class="stat pending"><div id="warmCount" class="stat-value">-</div><div class="stat-label">Warm (40-69)</div></div>
    <div class="stat"><div id="coldCount" class="stat-value">-</div><div class="stat-label">Cold (&lt;40)</div></div>
  </div>
  <div class="glass-card" style="padding:0;overflow:hidden">
    <div style="padding:16px 20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--border-color)">
      <select id="stageFilter" onchange="loadLeads(1)" style="background:rgba(0,0,0,0.3);border:1px solid var(--border-color);border-radius:6px;padding:7px 12px;color:var(--text-primary);font-size:13px;cursor:pointer">
        <option value="all">All Stages</option>
        <option value="new">New</option>
        <option value="contacted">Contacted</option>
        <option value="opened">Opened</option>
        <option value="clicked">Clicked</option>
        <option value="replied">Replied</option>
        <option value="interested">Interested</option>
        <option value="subscribed">Subscribed</option>
        <option value="do_not_contact">Do Not Contact</option>
      </select>
      <select id="sortFilter" onchange="loadLeads(1)" style="background:rgba(0,0,0,0.3);border:1px solid var(--border-color);border-radius:6px;padding:7px 12px;color:var(--text-primary);font-size:13px;cursor:pointer">
        <option value="score">Sort: Score</option>
        <option value="createdAt">Sort: Newest</option>
      </select>
      <span id="leadsCount" style="color:var(--text-muted);font-size:13px"></span>
      <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
        <label style="font-size:13px;color:var(--text-muted)">Daily limit:</label>
        <input id="dailyLimitInput" type="number" min="1" max="10000" style="width:70px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);border-radius:6px;padding:6px 10px;color:var(--text-primary);font-size:13px" placeholder="25">
        <button onclick="setDailyLimit()" class="btn btn-outline" style="font-size:12px;padding:6px 14px">Save</button>
      </div>
    </div>
    <div id="warmupPhaseBar" style="display:none;padding:6px 20px 2px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(245,158,11,0.06)">
      <span style="font-size:12px;color:#f59e0b">⚡ Warm-up: </span><span id="warmupPhaseText" style="font-size:12px;color:var(--text-muted)"></span>
    </div>
    <div id="trackingHealthBar" style="display:none;padding:6px 20px 2px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(16,185,129,0.05)">
      <span style="font-size:12px;color:#10b981">📬 Tracking: </span><span id="trackingHealthText" style="font-size:12px;color:var(--text-muted)"></span>
    </div>
    <div class="table-wrapper">
      <table id="leadsTable">
        <thead><tr><th>Name / Email</th><th>Trade</th><th>City</th><th>Stage</th><th>Score</th><th>Last Touch</th><th>Next Contact</th><th>Actions</th></tr></thead>
        <tbody id="leadsTbody"><tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:32px">Loading...</td></tr></tbody>
      </table>
    </div>
    <div id="leadsPagination" style="padding:12px 20px;display:flex;gap:8px;justify-content:flex-end"></div>
  </div>

  <script>
  (function(){
    let currentPage = 1;

    function stageBadge(s){
      const map = {new:'badge-gray',contacted:'badge-gray',opened:'badge-yellow',clicked:'',replied:'badge-green',interested:'badge-yellow',subscribed:'badge-green',do_not_contact:'badge-red'};
      const cls = map[s] || 'badge-gray';
      return '<span class="badge ' + cls + '">' + (s||'new').replace(/_/g,' ') + '</span>';
    }

    function fmtTs(ms){ return ms ? new Date(ms).toLocaleDateString() : '-'; }
    function fmtIso(iso){ return iso ? new Date(iso).toLocaleDateString() : '-'; }

    function lastTouch(l){
      const cands = [l.replied_at||l.repliedAt, l.clicked_at||l.clickedAt, l.opened_at||l.openedAt].filter(Boolean);
      const ts = cands.length ? Math.max(...cands) : null;
      return ts ? new Date(ts).toLocaleDateString() : (l.created_at||l.createdAt ? new Date(l.created_at||l.createdAt).toLocaleDateString() : '-');
    }

    async function loadLeads(page){
      currentPage = page || 1;
      const stage = document.getElementById('stageFilter').value;
      const sort = document.getElementById('sortFilter').value;
      const tbody = document.getElementById('leadsTbody');
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px">Loading...</td></tr>';
      try {
        const r = await fetch('/api/admin/leads?page=' + currentPage + '&limit=25&stage=' + stage + '&sort=' + sort);
        const j = await r.json();
        if(!j.success){ tbody.innerHTML = '<tr><td colspan="8">Error loading leads</td></tr>'; return; }
        const {leads, total} = j.data;
        document.getElementById('leadsCount').textContent = total + ' leads';
        if(!leads.length){ tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px">No leads found</td></tr>'; renderPager(0,25); return; }
        tbody.innerHTML = leads.map(l => {
          const name = (l.name||'').replace(/</g,'&lt;').replace(/'/g,'&#39;');
          const email = (l.email||'').replace(/</g,'&lt;');
          const trade = (l.business_type||l.businessType||'').replace(/</g,'&lt;');
          const city = (l.location||'').split(' ')[0] || '-';
          const st = l.stage || 'new';
          const score = l.score ?? 0;
          const dnc = l.do_not_contact || l.doNotContact;
          const subscribed = st === 'subscribed';
          const btn = (label, cls, fn) => '<button onclick="' + fn + '(\'' + l.id + '\')" style="background:rgba(' + cls + ',0.1);border:1px solid rgba(' + cls + ',0.3);color:rgb(' + cls + ');border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer">' + label + '</button>';
          const actions = [];
          if(dnc) actions.push(btn('Resume','34,197,94','resumeLead'));
          else actions.push(btn('Pause','239,68,68','pauseLead'));
          if(!subscribed) actions.push(btn('Interested','234,179,8','markInterested'));
          if(!subscribed) actions.push(btn('Subscribed','34,197,94','markSubscribed'));
          return '<tr><td><div style="font-weight:600;font-size:13px">' + name + '</div><div style="color:var(--text-muted);font-size:11px">' + email + '</div></td><td>' + trade + '</td><td style="font-size:12px">' + city + '</td><td>' + stageBadge(st) + '</td><td><span style="font-weight:700;color:' + (score>=70?'#22c55e':score>=40?'#eab308':'#94a3b8') + '">' + score + '</span></td><td style="font-size:12px;color:var(--text-muted)">' + lastTouch(l) + '</td><td style="font-size:12px;color:var(--text-muted)">' + fmtIso(l.nextContact) + '</td><td style="white-space:nowrap">' + actions.join(' ') + '</td></tr>';
        }).join('');
        renderPager(total, 25);
      } catch(e){ tbody.innerHTML = '<tr><td colspan="8">Error: ' + e.message + '</td></tr>'; }
    }

    async function loadBuckets(){
      try {
        const r = await fetch('/api/admin/leads/buckets');
        const j = await r.json();
        if(j.success){
          document.getElementById('hotCount').textContent = j.data.hot ?? 0;
          document.getElementById('warmCount').textContent = j.data.warm ?? 0;
          document.getElementById('coldCount').textContent = j.data.cold ?? 0;
        }
      } catch(e) {}
    }

    function renderPager(total, perPage){
      const pages = Math.ceil(total / perPage);
      const p = document.getElementById('leadsPagination');
      if(pages <= 1){ p.innerHTML = ''; return; }
      let html = '';
      for(let i=1;i<=Math.min(pages,20);i++){
        html += '<button onclick="loadLeads(' + i + ')" style="padding:6px 12px;border-radius:6px;border:1px solid var(--border-color);background:' + (i===currentPage?'rgba(79,70,229,0.2)':'rgba(0,0,0,0.2)') + ';color:' + (i===currentPage?'#818cf8':'var(--text-muted)') + ';font-size:12px;cursor:pointer">' + i + '</button>';
      }
      p.innerHTML = html;
    }

    async function pauseLead(id){ await fetch('/api/admin/leads/' + id + '/pause', {method:'POST'}); loadLeads(currentPage); }
    async function resumeLead(id){ await fetch('/api/admin/leads/' + id + '/resume', {method:'POST'}); loadLeads(currentPage); }
    async function markInterested(id){ await fetch('/api/admin/leads/' + id + '/mark-interested', {method:'POST'}); loadLeads(currentPage); }
    async function markSubscribed(id){ await fetch('/api/admin/leads/' + id + '/mark-subscribed', {method:'POST'}); loadLeads(currentPage); }
    async function setDailyLimit(){
      const v = Number(document.getElementById('dailyLimitInput').value);
      if(!v || v < 1){ alert('Enter a valid limit (1-10000)'); return; }
      const r = await fetch('/api/admin/leads/set-daily-limit', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:v})});
      const j = await r.json();
      if(j.success) alert('Daily limit updated to ' + j.data.daily_limit);
      else alert('Error: ' + j.error);
    }

    window.loadLeads = loadLeads;
    window.pauseLead = pauseLead;
    window.resumeLead = resumeLead;
    window.markInterested = markInterested;
    window.markSubscribed = markSubscribed;
    window.setDailyLimit = setDailyLimit;

    async function loadDailyLimit(){
      try {
        const r = await fetch('/api/admin/leads/daily-limit');
        const j = await r.json();
        if(!j.success) return;
        document.getElementById('dailyLimitInput').value = j.data.daily_limit;
        const w = j.data.warmup;
        const bar = document.getElementById('warmupPhaseBar');
        const txt = document.getElementById('warmupPhaseText');
        if(bar && txt && w) {
          const nextPart = w.days_until_next !== null
            ? ' — bumps to ' + w.next_bump_limit + '/day in ' + w.days_until_next + ' day' + (w.days_until_next !== 1 ? 's' : '')
            : ' — max reached';
          txt.textContent = w.phase_label + ' · ' + w.scheduled_limit + '/day scheduled' + nextPart;
          bar.style.display = '';
        }
        const t = j.data.tracking;
        const tbar = document.getElementById('trackingHealthBar');
        const ttxt = document.getElementById('trackingHealthText');
        if(tbar && ttxt && t) {
          const openPct = t.sent > 0 ? Math.round(t.opened / t.sent * 100) : 0;
          const clickPct = t.sent > 0 ? Math.round(t.clicked / t.sent * 100) : 0;
          const tokenPct = t.token_total > 0 ? Math.round(t.token_coverage / t.token_total * 100) : 100;
          const tokenNote = t.token_total > 0 ? ' · tokens ' + tokenPct + '%' : '';
          ttxt.textContent = t.sent + ' emails sent · ' + t.opened + ' opened (' + openPct + '%) · ' + t.clicked + ' clicked (' + clickPct + '%)' + tokenNote;
          tbar.style.display = '';
        }
      } catch(e) { /* non-critical, leave placeholder */ }
    }

    loadLeads(1);
    loadBuckets();
    loadDailyLimit();
  })();
  </script>

</div>
</body>
</html>
  `);
  }),
);

// Admin: Export pending payouts as CSV
app.get(
  "/admin/payouts.csv",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).send("Unauthorized");

    const pendingEarningsRaw = await pool.query(`
    SELECT e.id, e.created_at, e.amount_cents, e.stripe_invoice_id,
           a.email as affiliate_email, a.id as affiliate_id,
           r.email as referred_email
    FROM affiliate_earnings e
    JOIN users a ON e.affiliate_user_id = a.id
    JOIN users r ON e.referred_user_id = r.id
    WHERE e.status = 'pending'
    ORDER BY e.created_at DESC
  `);
    const pendingEarningsList = pendingEarningsRaw.rows as any[];

    const csvRows = [
      "ID,Date,Affiliate Email,Affiliate ID,Referred Email,Amount USD,Invoice ID",
    ];

    for (const e of pendingEarningsList) {
      const date = e.created_at || "";
      const amount = (e.amount_cents / 100).toFixed(2);
      csvRows.push(
        `${e.id},"${date}","${e.affiliate_email}","${e.affiliate_id}","${e.referred_email}",${amount},"${e.stripe_invoice_id || ""}"`,
      );
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=pending_payouts.csv",
    );
    res.send(csvRows.join("\n"));
  }),
);

// Admin: Mark all pending as paid
app.post(
  "/admin/mark-paid",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).send("Unauthorized");

    await db
      .update(affiliateEarnings)
      .set({ status: "paid" })
      .where(eq(affiliateEarnings.status, "pending"));
    await trackEvent("admin_mark_all_paid", undefined, { action: "mark_paid" });

    res.redirect(`/admin`);
  }),
);

// Admin: Set user plan manually
app.post(
  "/admin/set-plan",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).send("Unauthorized");

    const { user_id, plan } = req.body;
    if (!user_id || !plan) {
      return res.redirect(`/admin`);
    }

    const userResult = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, user_id));
    if (userResult.length === 0) {
      return res.redirect(`/admin`);
    }

    if (plan === "free") {
      await db.delete(subscriptions).where(eq(subscriptions.userId, user_id));
      await trackEvent("admin_set_plan", user_id, { plan: "free" });
    } else {
      const priceId = plan === "business" ? PRICE_BIZ : PRICE_PRO;
      const existingResult = await db
        .select({ userId: subscriptions.userId })
        .from(subscriptions)
        .where(eq(subscriptions.userId, user_id));

      if (existingResult.length > 0) {
        await db
          .update(subscriptions)
          .set({
            status: "active",
            priceId: priceId,
            updatedAt: now(),
          })
          .where(eq(subscriptions.userId, user_id));
      } else {
        await db.insert(subscriptions).values({
          userId: user_id,
          status: "active",
          priceId: priceId,
          updatedAt: now(),
        });
      }
      await trackEvent("admin_set_plan", user_id, { plan, priceId });
    }

    res.redirect(`/admin`);
  }),
);

// Admin: Seed SEO pages
app.post(
  "/admin/seed-seo",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).send("Unauthorized");

    const createdAt = new Date().toISOString();

    let seededCount = 0;
    for (const service of SEO_SERVICES) {
      for (const state of SEO_STATES) {
        const slug = `estimate-${service.slug}-cost-${state.slug}`;
        const title = `${service.name} Cost in ${state.name} (${new Date().getFullYear()} Pricing Guide + Free Estimate)`;
        const content = generateSeoContent(service.name, state.name);

        await db
          .insert(seoPages)
          .values({
            slug: slug,
            title: title,
            content: content,
            createdAt: createdAt,
          })
          .onConflictDoNothing();
        seededCount++;
      }
    }

    await trackEvent("admin_seed_seo", undefined, {
      pagesCreated: seededCount,
    });
    res.redirect(`/admin`);
  }),
);

app.get(
  "/admin/api",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).send("Unauthorized");

    const usersList = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(100);

    const subsList = await db
      .select()
      .from(subscriptions)
      .orderBy(desc(subscriptions.updatedAt))
      .limit(100);

    const analyticsList = await db
      .select()
      .from(analytics)
      .orderBy(desc(analytics.createdAt))
      .limit(200);

    res.json({ users: usersList, subs: subsList, analytics: analyticsList });
  }),
);

// ============================================================
// LAUNCH COMMAND CENTER
// ============================================================

app.get(
  "/admin/launch",
  requireAdminAuthPage,
  asyncHandler(async (req, res) => {
    const currentDate = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Launch Command Center | ProBid AI Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      line-height: 1.6;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    .header {
      text-align: center;
      margin-bottom: 48px;
    }

    .header h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, #f7931a, #ffc107);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }

    .header .subtitle {
      color: #888;
      font-size: 1rem;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 24px;
    }

    .card {
      background: #1a1a2e;
      border-radius: 16px;
      padding: 24px;
      border: 1px solid #2a2a4a;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid #2a2a4a;
    }

    .card-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
    }

    .card-icon.orange { background: rgba(247, 147, 26, 0.2); }
    .card-icon.green { background: rgba(34, 197, 94, 0.2); }
    .card-icon.blue { background: rgba(59, 130, 246, 0.2); }

    .card-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: #fff;
    }

    .mrr-display {
      text-align: center;
      padding: 24px 0;
    }

    .mrr-amount {
      font-size: 3.5rem;
      font-weight: 800;
      color: #f7931a;
    }

    .mrr-goal {
      color: #888;
      font-size: 0.9rem;
      margin-top: 4px;
    }

    .progress-bar {
      background: #2a2a4a;
      border-radius: 8px;
      height: 12px;
      overflow: hidden;
      margin: 16px 0;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #f7931a, #ffc107);
      border-radius: 8px;
      transition: width 0.5s ease;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-top: 20px;
    }

    .stat-item {
      background: rgba(255, 255, 255, 0.03);
      padding: 12px;
      border-radius: 8px;
      text-align: center;
    }

    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #fff;
    }

    .stat-label {
      font-size: 0.75rem;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .revenue-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #2a2a4a;
      font-size: 0.9rem;
    }

    .revenue-row:last-child { border-bottom: none; }

    .revenue-label { color: #888; }
    .revenue-value { color: #22c55e; font-weight: 600; }

    .task-list {
      list-style: none;
    }

    .task-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .task-item:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .task-checkbox {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      border: 2px solid #444;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s;
    }

    .task-item.done .task-checkbox {
      background: #22c55e;
      border-color: #22c55e;
    }

    .task-item.done .task-checkbox::after {
      content: '✓';
      color: #fff;
      font-size: 14px;
      font-weight: bold;
    }

    .task-item.done .task-text {
      text-decoration: line-through;
      color: #666;
    }

    .task-text {
      flex: 1;
      font-size: 0.95rem;
    }

    .task-progress {
      margin-bottom: 16px;
      font-size: 0.85rem;
      color: #888;
    }

    .add-task-form {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .add-task-input {
      flex: 1;
      padding: 10px 14px;
      background: #0a0a0a;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #fff;
      font-size: 0.9rem;
    }

    .add-task-input:focus {
      outline: none;
      border-color: #f7931a;
    }

    .add-task-btn {
      padding: 10px 20px;
      background: #f7931a;
      color: #000;
      border: none;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }

    .add-task-btn:hover {
      background: #ffc107;
    }

    .email-templates {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }

    .email-btn {
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      text-transform: capitalize;
    }

    .email-btn:hover {
      background: rgba(247, 147, 26, 0.1);
      border-color: #f7931a;
    }

    .email-btn.selected {
      background: rgba(247, 147, 26, 0.2);
      border-color: #f7931a;
      color: #f7931a;
    }

    .email-form {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .email-input {
      flex: 1;
      padding: 12px 14px;
      background: #0a0a0a;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #fff;
      font-size: 0.9rem;
    }

    .email-input:focus {
      outline: none;
      border-color: #f7931a;
    }

    .send-btn {
      padding: 12px 24px;
      background: #3b82f6;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }

    .send-btn:hover {
      background: #2563eb;
    }

    .send-btn:disabled {
      background: #444;
      cursor: not-allowed;
    }

    .feedback {
      margin-top: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 0.9rem;
      display: none;
    }

    .feedback.success {
      display: block;
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }

    .feedback.error {
      display: block;
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .loading {
      text-align: center;
      padding: 40px;
      color: #888;
    }

    .spinner {
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 3px solid #2a2a4a;
      border-top-color: #f7931a;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
      
      .header h1 {
        font-size: 1.8rem;
      }

      .mrr-amount {
        font-size: 2.5rem;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>🚀 Launch Command Center</h1>
      <p class="subtitle">${currentDate}</p>
      <a href="/admin/marketing-hub" style="display: inline-block; margin-top: 16px; padding: 10px 20px; background: rgba(59, 130, 246, 0.2); border: 1px solid #3b82f6; color: #3b82f6; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 0.9rem;">📢 Marketing Hub</a>
    </header>

    <div class="grid">
      <!-- MRR Dashboard Card -->
      <div class="card">
        <div class="card-header">
          <div class="card-icon orange">💰</div>
          <h2 class="card-title">MRR Dashboard</h2>
        </div>
        <div id="mrr-content">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>

      <!-- Launch Checklist Card -->
      <div class="card">
        <div class="card-header">
          <div class="card-icon green">✅</div>
          <h2 class="card-title">Launch Checklist</h2>
        </div>
        <div id="tasks-content">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>

      <!-- Email Marketing Card -->
      <div class="card" style="grid-column: span 2;">
        <div class="card-header">
          <div class="card-icon blue">📧</div>
          <h2 class="card-title">Email Marketing</h2>
        </div>
        <div id="email-content">
          <p style="color: #888; margin-bottom: 12px;">Select a template to send:</p>
          <div class="email-templates">
            <button class="email-btn" data-template="welcome">Welcome</button>
            <button class="email-btn" data-template="social_proof">Social Proof</button>
            <button class="email-btn" data-template="feature_tease">Feature Tease</button>
            <button class="email-btn" data-template="urgency">Urgency</button>
            <button class="email-btn" data-template="referral">Referral</button>
          </div>
          <div class="email-form">
            <input type="email" class="email-input" id="email-address" placeholder="Enter email address...">
            <button class="send-btn" id="send-email-btn" disabled>Send Email</button>
          </div>
          <div class="feedback" id="email-feedback"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let selectedTemplate = null;

    // Fetch MRR Data
    async function fetchMRR() {
      try {
        const res = await fetch('/api/admin/mrr', { credentials: 'same-origin' });
        const data = await res.json();
        
        const progressPercent = Math.min(data.mrrProgress, 100);
        
        document.getElementById('mrr-content').innerHTML = \`
          <div class="mrr-display">
            <div class="mrr-amount">$\${data.mrr}</div>
            <div class="mrr-goal">of $\${data.mrrGoal} MRR goal</div>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: \${progressPercent}%"></div>
          </div>
          <div class="stats-grid">
            <div class="stat-item">
              <div class="stat-value">\${data.tierBreakdown.free}</div>
              <div class="stat-label">Free</div>
            </div>
            <div class="stat-item">
              <div class="stat-value">\${data.tierBreakdown.pro}</div>
              <div class="stat-label">Pro</div>
            </div>
            <div class="stat-item">
              <div class="stat-value">\${data.tierBreakdown.business}</div>
              <div class="stat-label">Business</div>
            </div>
          </div>
          <div style="margin-top: 20px;">
            <div class="revenue-row">
              <span class="revenue-label">Total Users</span>
              <span class="revenue-value">\${data.totalUsers}</span>
            </div>
            <div class="revenue-row">
              <span class="revenue-label">Active Subscribers</span>
              <span class="revenue-value">\${data.totalActiveSubscribers}</span>
            </div>
            <div class="revenue-row">
              <span class="revenue-label">Lifetime Purchases</span>
              <span class="revenue-value">$\${data.oneTimeRevenue.lifetime}</span>
            </div>
            <div class="revenue-row">
              <span class="revenue-label">Single Estimate Sales</span>
              <span class="revenue-value">$\${data.oneTimeRevenue.singleEstimate}</span>
            </div>
          </div>
        \`;
      } catch (err) {
        document.getElementById('mrr-content').innerHTML = '<p style="color: #ef4444;">Failed to load MRR data</p>';
      }
    }

    // Fetch Tasks
    async function fetchTasks() {
      try {
        const res = await fetch('/api/admin/launch-tasks', { credentials: 'same-origin' });
        const data = await res.json();
        
        const tasks = data.tasks || [];
        const doneCount = tasks.filter(t => t.done).length;
        const totalCount = tasks.length;
        const progressPercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
        
        let tasksHtml = \`
          <div class="task-progress">\${doneCount}/\${totalCount} tasks complete</div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: \${progressPercent}%; background: linear-gradient(90deg, #22c55e, #16a34a);"></div>
          </div>
          <ul class="task-list">
        \`;
        
        for (const task of tasks) {
          const doneClass = task.done ? 'done' : '';
          tasksHtml += \`
            <li class="task-item \${doneClass}" data-id="\${task.id}" onclick="toggleTask(\${task.id})">
              <div class="task-checkbox"></div>
              <span class="task-text">\${escapeHtml(task.task)}</span>
            </li>
          \`;
        }
        
        tasksHtml += \`
          </ul>
          <form class="add-task-form" onsubmit="addTask(event)">
            <input type="text" class="add-task-input" id="new-task-input" placeholder="Add new task...">
            <button type="submit" class="add-task-btn">Add</button>
          </form>
        \`;
        
        document.getElementById('tasks-content').innerHTML = tasksHtml;
      } catch (err) {
        document.getElementById('tasks-content').innerHTML = '<p style="color: #ef4444;">Failed to load tasks</p>';
      }
    }

    // Toggle Task
    async function toggleTask(id) {
      try {
        await fetch(\`/api/admin/launch-tasks/\${id}\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin'
        });
        fetchTasks();
      } catch (err) {
        console.error('Failed to toggle task:', err);
      }
    }

    // Add Task
    async function addTask(e) {
      e.preventDefault();
      const input = document.getElementById('new-task-input');
      const task = input.value.trim();
      if (!task) return;
      
      try {
        await fetch('/api/admin/launch-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ task })
        });
        input.value = '';
        fetchTasks();
      } catch (err) {
        console.error('Failed to add task:', err);
      }
    }

    // Email Template Selection
    document.querySelectorAll('.email-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.email-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedTemplate = btn.dataset.template;
        document.getElementById('send-email-btn').disabled = !document.getElementById('email-address').value;
      });
    });

    document.getElementById('email-address').addEventListener('input', (e) => {
      document.getElementById('send-email-btn').disabled = !e.target.value || !selectedTemplate;
    });

    // Send Email
    document.getElementById('send-email-btn').addEventListener('click', async () => {
      const email = document.getElementById('email-address').value.trim();
      const feedback = document.getElementById('email-feedback');
      
      if (!email || !selectedTemplate) return;
      
      const btn = document.getElementById('send-email-btn');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      
      try {
        const res = await fetch('/api/admin/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email, templateKey: selectedTemplate })
        });
        
        const data = await res.json();
        
        if (data.success) {
          feedback.className = 'feedback success';
          feedback.textContent = \`✓ Email "\${selectedTemplate}" sent to \${email}\`;
          document.getElementById('email-address').value = '';
        } else {
          feedback.className = 'feedback error';
          feedback.textContent = \`✕ Failed: \${data.error || 'Unknown error'}\`;
        }
      } catch (err) {
        feedback.className = 'feedback error';
        feedback.textContent = '✕ Network error. Please try again.';
      }
      
      btn.disabled = false;
      btn.textContent = 'Send Email';
      
      setTimeout(() => {
        feedback.className = 'feedback';
      }, 5000);
    });

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Initialize
    fetchMRR();
    fetchTasks();
  </script>
</body>
</html>
  `);
  }),
);

// ============================================================
// MARKETING HUB
// ============================================================

app.get(
  "/admin/marketing-hub",
  requireAdminAuthPage,
  asyncHandler(async (req, res) => {
    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Marketing Hub | ProBid AI Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      line-height: 1.6;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    .header {
      text-align: center;
      margin-bottom: 48px;
    }

    .header h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }

    .header .subtitle {
      color: #888;
      font-size: 1rem;
    }

    .back-link {
      display: inline-block;
      margin-top: 16px;
      padding: 10px 20px;
      background: rgba(247, 147, 26, 0.2);
      border: 1px solid #f7931a;
      color: #f7931a;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9rem;
    }

    .back-link:hover {
      background: rgba(247, 147, 26, 0.3);
    }

    .section {
      background: #1a1a2e;
      border-radius: 16px;
      padding: 24px;
      border: 1px solid #2a2a4a;
      margin-bottom: 24px;
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid #2a2a4a;
    }

    .section-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
    }

    .section-icon.red { background: rgba(239, 68, 68, 0.2); }
    .section-icon.blue { background: rgba(59, 130, 246, 0.2); }
    .section-icon.purple { background: rgba(139, 92, 246, 0.2); }

    .section-title {
      font-size: 1.3rem;
      font-weight: 700;
      color: #fff;
    }

    .template-card {
      background: rgba(255, 255, 255, 0.02);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      border: 1px solid #2a2a4a;
      position: relative;
    }

    .template-card:last-child {
      margin-bottom: 0;
    }

    .template-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .template-title {
      font-size: 1rem;
      font-weight: 600;
      color: #22c55e;
    }

    .template-platform {
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: 20px;
      background: rgba(139, 92, 246, 0.2);
      color: #8b5cf6;
      font-weight: 600;
    }

    .template-content {
      font-size: 0.9rem;
      line-height: 1.7;
      color: #c0c0c0;
      white-space: pre-wrap;
      background: #0a0a0a;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #2a2a4a;
      margin-bottom: 12px;
    }

    .copy-btn {
      padding: 8px 16px;
      background: #3b82f6;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .copy-btn:hover {
      background: #2563eb;
    }

    .copy-btn.copied {
      background: #22c55e;
    }

    .script-section {
      margin-bottom: 16px;
    }

    .script-label {
      font-size: 0.8rem;
      font-weight: 700;
      color: #f7931a;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    .script-text {
      font-size: 0.95rem;
      line-height: 1.8;
      color: #e0e0e0;
    }

    .template-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 16px;
    }

    @media (max-width: 768px) {
      .header h1 {
        font-size: 1.8rem;
      }

      .template-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>📢 Marketing Hub</h1>
      <p class="subtitle">Demo scripts, email templates, and social media posts for ProBid AI</p>
      <a href="/admin/launch" class="back-link">🚀 Back to Launch Command Center</a>
    </header>

    <!-- Demo Video Script Section -->
    <div class="section">
      <div class="section-header">
        <div class="section-icon red">🎬</div>
        <h2 class="section-title">60-Second Demo Video Script</h2>
      </div>
      
      <div class="template-card">
        <div class="template-header">
          <span class="template-title">Complete Video Script</span>
          <span class="template-platform">60 Seconds</span>
        </div>
        <div class="template-content" id="video-script">
<strong>[HOOK - 0:00-0:05]</strong>
"Stop spending hours on estimates that should take minutes."

<strong>[PROBLEM - 0:05-0:15]</strong>
"Every contractor knows the pain. You spend 2-3 hours building an estimate, only to lose the job to someone who got there faster. Manual estimates are killing your business."

<strong>[SOLUTION - 0:15-0:25]</strong>
"That's why we built ProBid AI. Our AI analyzes job photos and descriptions to generate accurate, professional estimates in seconds - not hours."

<strong>[DEMO - 0:25-0:45]</strong>
"Watch how easy it is. Just snap a photo of the job site, describe what needs to be done, and ProBid AI delivers a complete estimate in 60 seconds. Line items, labor costs, materials - all calculated using real market data for your area."

<strong>[RESULTS - 0:45-0:52]</strong>
"ProBid AI cuts a 1-3 hour estimate down to about a minute, so you can respond to homeowners faster than the competition."

<strong>[CTA - 0:52-0:60]</strong>
"Try it free today at probidcore.net. Your first two estimates are on us. ProBid AI - Win more bids, save more time."</div>
        <button class="copy-btn" onclick="copyTemplate('video-script', this)">Copy Script</button>
      </div>
    </div>

    <!-- Email Templates Section -->
    <div class="section">
      <div class="section-header">
        <div class="section-icon blue">📧</div>
        <h2 class="section-title">Email Templates for Contractor Outreach</h2>
      </div>
      
      <div class="template-card">
        <div class="template-header">
          <span class="template-title">1. Cold Outreach to Contractors</span>
          <span class="template-platform">Email</span>
        </div>
        <div class="template-content" id="email-cold">Subject: Cut your estimate time from hours to 60 seconds

Hi [Name],

I noticed you're running [Company Name] in [City] - nice work on those recent projects.

Quick question: How much time do you spend on estimates each week?

For a lot of contractors it's nights and weekends — time that should be billable, gone to paperwork.

We built ProBid AI specifically to solve this. Upload a photo, describe the job, get a professional estimate in 60 seconds. Real market pricing for your area, ready to send to clients.

Try a single estimate for $7, or start a 7-day free trial of Pro.

Try it at: probidcore.net

Best,
[Your Name]

P.S. - The contractor who replies first usually wins the job. ProBid AI is built so that contractor can be you.</div>
        <button class="copy-btn" onclick="copyTemplate('email-cold', this)">Copy Template</button>
      </div>

      <div class="template-card">
        <div class="template-header">
          <span class="template-title">2. Follow-up After No Response</span>
          <span class="template-platform">Email</span>
        </div>
        <div class="template-content" id="email-followup">Subject: Quick follow-up (+ a case study)

Hi [Name],

I reached out last week about ProBid AI - the tool that generates construction estimates in 60 seconds.

Quick context: ProBid AI was built by a working masonry contractor in Illinois (Jesse Kirchner — Kirchner Masonry, Galena, IL) for exactly this problem. Snap a job-site photo, get a full estimate in about a minute, send the PDF before you've left the driveway.

If you're curious, you can try a single estimate for $7 or start a 7-day free trial of Pro at probidcore.net. No charge during the trial.

Worth 60 seconds of your time?

Best,
[Your Name]</div>
        <button class="copy-btn" onclick="copyTemplate('email-followup', this)">Copy Template</button>
      </div>

      <div class="template-card">
        <div class="template-header">
          <span class="template-title">3. Partner/Supplier Referral Ask</span>
          <span class="template-platform">Email</span>
        </div>
        <div class="template-content" id="email-partner">Subject: Partnership opportunity - help your contractor customers

Hi [Name],

I run ProBid AI, a tool that helps contractors generate professional estimates in 60 seconds using AI.

I'm reaching out because your customers at [Supplier/Partner Name] are exactly who we built this for - busy contractors who need to bid jobs faster.

Would you be open to:
- Sharing ProBid with contractors who buy from you?
- We offer a 20% affiliate commission on any paid signups

It's a genuine value-add for your customers (cuts a 1–3 hour estimate down to about a minute), and creates a new revenue stream for you.

Happy to set up a quick demo if you'd like to see it in action.

Best,
[Your Name]
probidcore.net</div>
        <button class="copy-btn" onclick="copyTemplate('email-partner', this)">Copy Template</button>
      </div>

      <div class="template-card">
        <div class="template-header">
          <span class="template-title">4. Local Contractor Association Email</span>
          <span class="template-platform">Email</span>
        </div>
        <div class="template-content" id="email-association">Subject: Free tool demo for [Association Name] members

Hi [Contact Name],

I'd love to offer a free demo of ProBid AI to [Association Name] members.

ProBid AI is an estimation tool built specifically for contractors. It uses AI to generate professional estimates in 60 seconds - just upload a job photo and describe the work.

Why your members would care:
- Cuts a typical 1-3 hour estimate down to about a minute
- Uses real market pricing for [State/Region]
- Professional PDF exports ready for clients
- 7-day free trial of Pro, or $7 single estimate to try it

Would you be interested in sharing this with your members, or having me present at an upcoming meeting?

I'm happy to offer extended free trials for association members.

Best,
[Your Name]
Founder, ProBid AI
probidcore.net</div>
        <button class="copy-btn" onclick="copyTemplate('email-association', this)">Copy Template</button>
      </div>

      <div class="template-card">
        <div class="template-header">
          <span class="template-title">5. LinkedIn Connection Message</span>
          <span class="template-platform">LinkedIn</span>
        </div>
        <div class="template-content" id="email-linkedin">Hi [Name], saw you're running a [trade] business in [City]. I built a tool that generates construction estimates in 60 seconds using AI - figured it might save you some time. Happy to share a free trial if you're interested. - [Your Name]</div>
        <button class="copy-btn" onclick="copyTemplate('email-linkedin', this)">Copy Template</button>
      </div>
    </div>

    <!-- Social Media Templates Section -->
    <div class="section">
      <div class="section-header">
        <div class="section-icon purple">📱</div>
        <h2 class="section-title">Social Media Post Templates</h2>
      </div>

      <div class="template-grid">
        <!-- Facebook Posts -->
        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Facebook Post #1</span>
            <span class="template-platform">Facebook</span>
          </div>
          <div class="template-content" id="fb-1">Contractors: How many hours do you spend on estimates each week?

I used to spend 2-3 hours per estimate. Now I do it in 60 seconds.

ProBid AI uses artificial intelligence to analyze job details and generate accurate estimates instantly. Upload a photo, describe the work, get a professional estimate.

Try it free: probidcore.net

#Contractors #ConstructionBusiness #ContractorLife #Estimating #AI</div>
          <button class="copy-btn" onclick="copyTemplate('fb-1', this)">Copy Post</button>
        </div>

        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Facebook Post #2</span>
            <span class="template-platform">Facebook</span>
          </div>
          <div class="template-content" id="fb-2">The contractor who responds first usually wins the job.

That's why I started using ProBid AI. I can send professional estimates to clients within minutes of seeing the job site.

No more spending hours on spreadsheets. No more losing bids because someone else was faster.

Free to try at probidcore.net

#ContractorTips #WinMoreBids #ConstructionTech #SmallBusiness</div>
          <button class="copy-btn" onclick="copyTemplate('fb-2', this)">Copy Post</button>
        </div>

        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Facebook Post #3</span>
            <span class="template-platform">Facebook</span>
          </div>
          <div class="template-content" id="fb-3">Real talk: I used to hate doing estimates.

Hours of measuring, calculating, looking up prices, formatting... just to maybe win the job.

Now I use ProBid AI. Snap a pic, describe the work, and I have a professional estimate in 60 seconds.

Game changer for my business.

Check it out: probidcore.net (7-day free trial or $7 single estimate)

#ContractorLife #Construction #WorkSmarter</div>
          <button class="copy-btn" onclick="copyTemplate('fb-3', this)">Copy Post</button>
        </div>

        <!-- Twitter/X Posts -->
        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Twitter/X Post #1</span>
            <span class="template-platform">Twitter/X</span>
          </div>
          <div class="template-content" id="tw-1">Contractors: You're losing your evenings to estimates.

What if you could do them in 60 seconds — straight from a job-site photo?

ProBid AI uses AI to generate accurate construction estimates instantly.

Photo + description = professional estimate.

Try free: probidcore.net

#Construction #AI #Contractors</div>
          <button class="copy-btn" onclick="copyTemplate('tw-1', this)">Copy Post</button>
        </div>

        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Twitter/X Post #2</span>
            <span class="template-platform">Twitter/X</span>
          </div>
          <div class="template-content" id="tw-2">The fastest contractor wins.

Not the cheapest. Not the best. The fastest.

ProBid AI lets you send professional estimates in 60 seconds.

Win more bids by responding first.

probidcore.net

#ContractorLife #SmallBusiness</div>
          <button class="copy-btn" onclick="copyTemplate('tw-2', this)">Copy Post</button>
        </div>

        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Twitter/X Post #3</span>
            <span class="template-platform">Twitter/X</span>
          </div>
          <div class="template-content" id="tw-3">Built an AI that generates construction estimates in 60 seconds.

Upload photo → Describe job → Get estimate

Uses real market data for your area.

Free trial at probidcore.net

Contractors, would love your feedback.</div>
          <button class="copy-btn" onclick="copyTemplate('tw-3', this)">Copy Post</button>
        </div>

        <!-- LinkedIn Posts -->
        <div class="template-card">
          <div class="template-header">
            <span class="template-title">LinkedIn Post #1</span>
            <span class="template-platform">LinkedIn</span>
          </div>
          <div class="template-content" id="li-1">I built ProBid AI as a working masonry contractor who was sick of losing his evenings to estimates.

The #1 pain point? Estimates.

Not the work itself - contractors love the work. It's the hours spent on paperwork, calculations, and formatting that kills productivity.

So we built an AI that generates professional construction estimates in 60 seconds:

1. Upload a photo of the job site
2. Describe what needs to be done
3. Get an accurate estimate with real market pricing

ProBid AI cuts a 1-3 hour estimate down to about a minute, so contractors can respond to homeowners faster.

If you're a contractor (or know one), try it free at probidcore.net.

Would love to hear your thoughts on how AI is changing the trades.

#Construction #AI #SmallBusiness #Contractors #Entrepreneurship</div>
          <button class="copy-btn" onclick="copyTemplate('li-1', this)">Copy Post</button>
        </div>

        <div class="template-card">
          <div class="template-header">
            <span class="template-title">LinkedIn Post #2</span>
            <span class="template-platform">LinkedIn</span>
          </div>
          <div class="template-content" id="li-2">The construction industry is behind on technology. But that's changing.

I've been building ProBid AI - an estimation tool that uses artificial intelligence to help contractors bid jobs faster.

Here's what I've learned:

→ The contractor who responds first usually wins the job
→ Estimating eats nights and weekends — the work that should be billable is the easy part
→ Speed and presentation matter more than being the cheapest

ProBid AI solves this by generating accurate estimates in 60 seconds. No more spreadsheet marathons.

We're offering free trials at probidcore.net.

If you work with contractors or in construction tech, I'd love to connect.

#ConstructionTech #AI #Startups #SmallBusiness</div>
          <button class="copy-btn" onclick="copyTemplate('li-2', this)">Copy Post</button>
        </div>

        <!-- Reddit Posts -->
        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Reddit Post #1</span>
            <span class="template-platform">r/Contractors</span>
          </div>
          <div class="template-content" id="reddit-1">Title: Looking for feedback on an AI estimation tool I built

Hey everyone,

I'm a developer who's been working with contractors on a tool called ProBid AI. It uses AI to generate estimates based on job photos and descriptions.

The idea is simple: upload a photo, describe what needs to be done, and get an estimate in about 60 seconds. It pulls in market pricing for materials and labor based on your zip code.

I'm not here to spam - genuinely looking for feedback from people who do this work every day.

- What would make an estimation tool actually useful for you?
- What do current tools get wrong?
- Would you use something like this, or is manual estimation just part of the craft?

$7 to try a single estimate at probidcore.net if you want to kick the tires (or 7-day Pro trial).

Appreciate any honest feedback.</div>
          <button class="copy-btn" onclick="copyTemplate('reddit-1', this)">Copy Post</button>
        </div>

        <div class="template-card">
          <div class="template-header">
            <span class="template-title">Reddit Post #2</span>
            <span class="template-platform">r/Contractors</span>
          </div>
          <div class="template-content" id="reddit-2">Title: How do you handle quick estimate requests?

[Customize this with your own real experience before posting.]

When a customer asks for a "ballpark" on a job while you're still on another site, the usual answer is "I'll get back to you in a day or two." Lately I've been trying ProBid AI — upload a photo, describe the job, and it generates an estimate in about a minute.

It's not a substitute for your judgment, but it's faster than doing it manually and the PDF looks clean enough to send.

Anyone else using AI tools for estimates? What's working for you?

(Site is probidcore.net if anyone wants to try it — $7 single estimate or 7-day Pro trial)</div>
          <button class="copy-btn" onclick="copyTemplate('reddit-2', this)">Copy Post</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    function copyTemplate(elementId, button) {
      const element = document.getElementById(elementId);
      const text = element.innerText;
      
      navigator.clipboard.writeText(text).then(() => {
        const originalText = button.textContent;
        button.textContent = 'Copied!';
        button.classList.add('copied');
        
        setTimeout(() => {
          button.textContent = originalText;
          button.classList.remove('copied');
        }, 2000);
      }).catch(err => {
        console.error('Failed to copy:', err);
        button.textContent = 'Failed';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 2000);
      });
    }
  </script>
</body>
</html>
  `);
  }),
);

// ============================================================
// LAUNCH TASKS API
// ============================================================

app.get(
  "/api/admin/launch-tasks",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const tasks = await db
      .select()
      .from(launchTasks)
      .orderBy(asc(launchTasks.id));
    res.json({ tasks });
  }),
);

app.post(
  "/api/admin/launch-tasks",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const { task, category } = req.body;
    if (!task || typeof task !== "string") {
      return res.status(400).json({ error: "Task is required" });
    }

    const result = await db
      .insert(launchTasks)
      .values({
        task,
        category: category || null,
      })
      .returning();

    res.json({ task: result[0] });
  }),
);

app.patch(
  "/api/admin/launch-tasks/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const existing = await db
      .select()
      .from(launchTasks)
      .where(eq(launchTasks.id, id));
    if (existing.length === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    const currentDone = existing[0].done ?? false;
    const newDone = !currentDone;

    const result = await db
      .update(launchTasks)
      .set({
        done: newDone,
        completedAt: newDone ? new Date() : null,
      })
      .where(eq(launchTasks.id, id))
      .returning();

    res.json({ task: result[0] });
  }),
);

app.delete(
  "/api/admin/launch-tasks/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const existing = await db
      .select()
      .from(launchTasks)
      .where(eq(launchTasks.id, id));
    if (existing.length === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    await db.delete(launchTasks).where(eq(launchTasks.id, id));
    res.json({ success: true });
  }),
);

// ============================================================
// MRR CALCULATOR API
// ============================================================

app.get(
  "/api/admin/mrr",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const MRR_GOAL = 500;

    // Get total users count
    const totalUsersResult = await db.select({ count: count() }).from(users);
    const totalUsers = totalUsersResult[0]?.count || 0;

    // Get active subscriptions with their price IDs
    const activeSubsResult = await db
      .select({
        priceId: subscriptions.priceId,
      })
      .from(subscriptions)
      .where(
        or(
          eq(subscriptions.status, "active"),
          eq(subscriptions.status, "trialing"),
        ),
      );

    // Count by tier and interval for accurate MRR
    let proMonthlyCount = 0,
      proAnnualCount = 0;
    let bizMonthlyCount = 0,
      bizAnnualCount = 0;

    for (const sub of activeSubsResult) {
      if (sub.priceId === PRICE_PRO) proMonthlyCount++;
      else if (sub.priceId === PRICE_PRO_ANNUAL) proAnnualCount++;
      else if (sub.priceId === PRICE_BIZ) bizMonthlyCount++;
      else if (sub.priceId === PRICE_BIZ_ANNUAL) bizAnnualCount++;
    }

    const proCount = proMonthlyCount + proAnnualCount;
    const businessCount = bizMonthlyCount + bizAnnualCount;
    const totalActiveSubscribers = proCount + businessCount;
    const freeCount = totalUsers - totalActiveSubscribers;

    // Calculate MRR using monthly-equivalent rates for annual plans
    const mrr =
      proMonthlyCount * 25 +
      proAnnualCount * 20 +
      bizMonthlyCount * 55 +
      bizAnnualCount * 79;
    const mrrProgress = MRR_GOAL > 0 ? Math.round((mrr / MRR_GOAL) * 100) : 0;

    // Get one-time purchase revenue
    const lifetimeRevenueResult = await db
      .select({
        total: sum(purchases.amountCents),
      })
      .from(purchases)
      .where(eq(purchases.type, "lifetime"));

    const singleEstimateRevenueResult = await db
      .select({
        total: sum(purchases.amountCents),
      })
      .from(purchases)
      .where(eq(purchases.type, "single_estimate"));

    // Convert cents to dollars
    const lifetimeRevenue = Math.round(
      (Number(lifetimeRevenueResult[0]?.total) || 0) / 100,
    );
    const singleEstimateRevenue = Math.round(
      (Number(singleEstimateRevenueResult[0]?.total) || 0) / 100,
    );

    res.json({
      mrr,
      mrrGoal: MRR_GOAL,
      mrrProgress,
      tierBreakdown: {
        free: freeCount,
        pro: proCount,
        business: businessCount,
      },
      totalActiveSubscribers,
      oneTimeRevenue: {
        lifetime: lifetimeRevenue,
        singleEstimate: singleEstimateRevenue,
      },
      totalUsers,
    });
  }),
);

// --- /api/admin/funnel — aggregated conversion funnel ---
app.get(
  "/api/admin/funnel",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const now30dAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const todayStart = new Date().setHours(0, 0, 0, 0);

    type FunnelStep = {
      name: string;
      events: string[];
      todayCount: number;
      totalCount: number;
    };

    async function countEvents(
      eventNames: string[],
      since: number,
    ): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(analytics)
        .where(
          and(
            inArray(analytics.event, eventNames),
            gte(analytics.createdAt, since),
          ),
        );
      return rows[0]?.n ?? 0;
    }

    const stepDefs: { name: string; events: string[] }[] = [
      { name: "Homepage Visit", events: ["homepage_view", "homepage_visit"] },
      { name: "Pricing View", events: ["pricing_view", "pricing_visit"] },
      { name: "Signup Page Visit", events: ["signup_page_visit"] },
      { name: "Signed Up", events: ["signup"] },
      { name: "Estimate Generated", events: ["estimate_generated"] },
      { name: "Checkout Started", events: ["checkout_started"] },
      { name: "Subscription Activated", events: ["subscription_activated"] },
    ];

    const steps: FunnelStep[] = await Promise.all(
      stepDefs.map(async (s) => ({
        name: s.name,
        events: s.events,
        todayCount: await countEvents(s.events, todayStart),
        totalCount: await countEvents(s.events, now30dAgo),
      })),
    );

    function convRate(from: number, to: number): string {
      if (!from) return "0.0%";
      return ((to / from) * 100).toFixed(1) + "%";
    }

    const rates: Record<string, string> = {};
    for (let i = 1; i < steps.length; i++) {
      const key = `${steps[i - 1].name} → ${steps[i].name}`;
      rates[key] = convRate(steps[i - 1].totalCount, steps[i].totalCount);
    }

    // PDF downloads (separate conversion metric)
    const pdfDownloads30d = await countEvents(
      ["pdf_download", "pdf_downloaded"],
      now30dAgo,
    );
    const pdfDownloadsToday = await countEvents(
      ["pdf_download", "pdf_downloaded"],
      todayStart,
    );

    res.json({
      period: "last_30_days",
      steps: steps.map((s) => ({
        name: s.name,
        today_count: s.todayCount,
        total_count: s.totalCount,
      })),
      rates,
      pdfDownloads: { today: pdfDownloadsToday, total30d: pdfDownloads30d },
    });
  }),
);

// --- /api/admin/revenue — subscriber breakdown, MRR, ARR, recent signups ---
app.get(
  "/api/admin/revenue",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const totalUsersResult = await db.select({ count: count() }).from(users);
    const totalUsers = totalUsersResult[0]?.count ?? 0;

    const activeSubsResult = await db
      .select({
        priceId: subscriptions.priceId,
        userId: subscriptions.userId,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .where(
        or(
          eq(subscriptions.status, "active"),
          eq(subscriptions.status, "trialing"),
        ),
      );

    let proMonthlyCount = 0,
      proAnnualCount = 0;
    let bizMonthlyCount = 0,
      bizAnnualCount = 0;
    for (const sub of activeSubsResult) {
      if (sub.priceId === PRICE_PRO) proMonthlyCount++;
      else if (sub.priceId === PRICE_PRO_ANNUAL) proAnnualCount++;
      else if (sub.priceId === PRICE_BIZ) bizMonthlyCount++;
      else if (sub.priceId === PRICE_BIZ_ANNUAL) bizAnnualCount++;
    }
    const proCount = proMonthlyCount + proAnnualCount;
    const businessCount = bizMonthlyCount + bizAnnualCount;
    const freeCount = totalUsers - proCount - businessCount;
    const mrr =
      proMonthlyCount * 25 +
      proAnnualCount * 20 +
      bizMonthlyCount * 55 +
      bizAnnualCount * 79;
    const arr = mrr * 12;

    const lifetimeRev = await db
      .select({ total: sum(purchases.amountCents) })
      .from(purchases)
      .where(eq(purchases.type, "lifetime"));
    const singleRev = await db
      .select({ total: sum(purchases.amountCents) })
      .from(purchases)
      .where(eq(purchases.type, "single_estimate"));
    const lifetimeRevenueDollars = Math.round(
      (Number(lifetimeRev[0]?.total) || 0) / 100,
    );
    const singleRevenueDollars = Math.round(
      (Number(singleRev[0]?.total) || 0) / 100,
    );

    // Recent 10 signups with subscription status
    const recentUsers = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(10);

    const recentWithPlan = await Promise.all(
      recentUsers.map(async (u) => {
        const sub = await db
          .select({
            status: subscriptions.status,
            priceId: subscriptions.priceId,
          })
          .from(subscriptions)
          .where(eq(subscriptions.userId, u.id))
          .orderBy(desc(subscriptions.updatedAt))
          .limit(1);
        let plan = "free";
        let subStatus = "—";
        if (sub[0]) {
          plan =
            sub[0].priceId === PRICE_PRO || sub[0].priceId === PRICE_PRO_ANNUAL
              ? "pro"
              : sub[0].priceId === PRICE_BIZ ||
                  sub[0].priceId === PRICE_BIZ_ANNUAL
                ? "business"
                : "free";
          subStatus = sub[0].status;
        }
        return {
          id: u.id,
          email: u.email,
          createdAt: u.createdAt,
          plan,
          subStatus,
        };
      }),
    );

    res.json({
      subscribers: {
        free: freeCount < 0 ? 0 : freeCount,
        pro: proCount,
        business: businessCount,
        total: totalUsers,
      },
      mrr,
      arr,
      oneTimeRevenue: {
        lifetime: lifetimeRevenueDollars,
        singleEstimate: singleRevenueDollars,
      },
      recentSignups: recentWithPlan,
    });
  }),
);

// --- /api/admin/system-status — comprehensive operational status ---
app.get(
  "/api/admin/system-status",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const todayStartMs = new Date().setHours(0, 0, 0, 0);
    const todayISO = new Date(todayStartMs).toISOString();

    // DB health
    let dbStatus = "disconnected";
    try {
      const isConnected = await checkDatabaseConnection();
      dbStatus = isConnected ? "connected" : "disconnected";
    } catch {
      dbStatus = "disconnected";
    }

    // Last run for each cron job
    async function getLastJobRun(jobName: string) {
      const rows = await db
        .select()
        .from(jobRuns)
        .where(eq(jobRuns.jobName, jobName))
        .orderBy(desc(jobRuns.startedAt))
        .limit(1);
      return rows[0] || null;
    }
    const [lastScraper, lastOutreach, lastDrip] = await Promise.all([
      getLastJobRun("scrape-leads"),
      getLastJobRun("process-outreach"),
      getLastJobRun("process-drip-emails"),
    ]);

    // Today's counts
    const [
      signupsTodayRes,
      estimatesTodayRes,
      emailsSentTodayRes,
      emailsFailedTodayRes,
    ] = await Promise.all([
      db
        .select({ c: count() })
        .from(users)
        .where(gte(users.createdAt, todayStartMs)),
      db
        .select({ c: count() })
        .from(estimates)
        .where(gte(estimates.createdAt, todayStartMs)),
      db
        .select({ c: count() })
        .from(leadEmailAuditLog)
        .where(
          and(
            eq(leadEmailAuditLog.status, "sent"),
            gte(leadEmailAuditLog.sentAt, todayISO),
          ),
        ),
      db
        .select({ c: count() })
        .from(leadEmailAuditLog)
        .where(
          and(
            eq(leadEmailAuditLog.status, "failed"),
            gte(leadEmailAuditLog.sentAt, todayISO),
          ),
        ),
    ]);

    const signupsToday = Number(signupsTodayRes[0]?.c || 0);
    const estimatesToday = Number(estimatesTodayRes[0]?.c || 0);
    const emailsSentToday = Number(emailsSentTodayRes[0]?.c || 0);
    const emailsFailedToday = Number(emailsFailedTodayRes[0]?.c || 0);

    // Leads scraped today
    const leadsScrapedTodayRes = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(gte(scrapedLeads.createdAt, todayStartMs));
    const leadsScrapedToday = Number(leadsScrapedTodayRes[0]?.c || 0);

    // Multi-channel lead breakdown (Task #141 — surface that we no longer
    // drop leads when email is missing). leadsContacted = lead has been
    // reached via SMS or has a sent email-audit row.
    const [
      leadsTotalRes,
      leadsWithPhoneRes,
      leadsWithEmailRes,
      leadsNoEmailContactableRes,
      leadsWebsitePendingRes,
      leadsContactedRes,
    ] = await Promise.all([
      db.select({ c: count() }).from(scrapedLeads),
      db
        .select({ c: count() })
        .from(scrapedLeads)
        .where(sql`${scrapedLeads.phone} IS NOT NULL AND ${scrapedLeads.phone} <> ''`),
      db
        .select({ c: count() })
        .from(scrapedLeads)
        .where(sql`${scrapedLeads.email} IS NOT NULL AND ${scrapedLeads.email} <> ''`),
      db
        .select({ c: count() })
        .from(scrapedLeads)
        .where(eq(scrapedLeads.leadStatus, "no_email_but_contactable")),
      db
        .select({ c: count() })
        .from(scrapedLeads)
        .where(
          and(
            eq(scrapedLeads.leadStatus, "no_email_but_contactable"),
            sql`${scrapedLeads.website} IS NOT NULL AND ${scrapedLeads.website} <> ''`,
            sql`${scrapedLeads.websiteOutreachAt} IS NULL`,
          ),
        ),
      db
        .select({ c: count() })
        .from(scrapedLeads)
        .where(
          or(
            sql`${scrapedLeads.smsSentAt} IS NOT NULL`,
            sql`EXISTS (SELECT 1 FROM lead_email_audit_log l WHERE l.lead_id = ${scrapedLeads.id} AND l.status = 'sent')`,
          ),
        ),
    ]);
    const leadsTotal = Number(leadsTotalRes[0]?.c || 0);
    const leadsWithPhone = Number(leadsWithPhoneRes[0]?.c || 0);
    const leadsWithEmail = Number(leadsWithEmailRes[0]?.c || 0);
    const leadsNoEmailButContactable = Number(leadsNoEmailContactableRes[0]?.c || 0);
    const leadsWebsiteOutreachPending = Number(leadsWebsitePendingRes[0]?.c || 0);
    const leadsContacted = Number(leadsContactedRes[0]?.c || 0);

    // Total outreach queue pending
    const outreachQueueRes = await db
      .select({ c: count() })
      .from(leadOutreachQueue)
      .where(eq(leadOutreachQueue.status, "pending"));
    const outreachQueuePending = Number(outreachQueueRes[0]?.c || 0);

    // Drip emails pending
    const dripPendingRes = await db
      .select({ c: count() })
      .from(emailDripQueue)
      .where(eq(emailDripQueue.status, "pending"));
    const dripEmailsPending = Number(dripPendingRes[0]?.c || 0);

    // Homepage leads total
    const homepageLeadsTotalRes = await db
      .select({ c: count() })
      .from(homepageLeads);
    const homepageLeadsTotal = Number(homepageLeadsTotalRes[0]?.c || 0);

    // Revenue (reuse MRR logic)
    const activeSubsResult = await db
      .select({ priceId: subscriptions.priceId })
      .from(subscriptions)
      .where(
        or(
          eq(subscriptions.status, "active"),
          eq(subscriptions.status, "trialing"),
        ),
      );
    let proMonthlyCount = 0,
      proAnnualCount = 0;
    let bizMonthlyCount = 0,
      bizAnnualCount = 0;
    for (const s of activeSubsResult) {
      if (s.priceId === PRICE_PRO) proMonthlyCount++;
      else if (s.priceId === PRICE_PRO_ANNUAL) proAnnualCount++;
      else if (s.priceId === PRICE_BIZ) bizMonthlyCount++;
      else if (s.priceId === PRICE_BIZ_ANNUAL) bizAnnualCount++;
    }
    const proCount = proMonthlyCount + proAnnualCount;
    const businessCount = bizMonthlyCount + bizAnnualCount;
    const mrr =
      proMonthlyCount * 25 +
      proAnnualCount * 20 +
      bizMonthlyCount * 55 +
      bizAnnualCount * 79;
    const totalUsersRes = await db.select({ c: count() }).from(users);
    const totalUsers = Number(totalUsersRes[0]?.c || 0);

    // Recent job runs (last 20)
    const recentRuns = await db
      .select()
      .from(jobRuns)
      .orderBy(desc(jobRuns.startedAt))
      .limit(20);

    // Subsystem degraded flags
    const googlePlacesApiStatus = getGooglePlacesApiStatus();
    const scraperStatus = (() => {
      if (!hasEnv("GOOGLE_PLACES_API_KEY"))
        return { status: "degraded", detail: "Missing GOOGLE_PLACES_API_KEY" };
      if (googlePlacesApiStatus.ok === true)
        return { status: "ok", detail: "Google Places API working" };
      if (googlePlacesApiStatus.ok === false)
        return {
          status: "degraded",
          detail: `REQUEST_DENIED — ${googlePlacesApiStatus.error_message ?? "billing not enabled"}`,
        };
      return {
        status: "ok",
        detail:
          "Google Places key present (untested this session — run scraper to confirm)",
      };
    })();

    const subsystems = {
      database: {
        status: dbStatus === "connected" ? "ok" : "error",
        detail: dbStatus,
      },
      scraper: {
        ...scraperStatus,
        google_places: {
          ok: googlePlacesApiStatus.ok,
          error_message: googlePlacesApiStatus.error_message,
          checkedAt: googlePlacesApiStatus.checkedAt
            ? new Date(googlePlacesApiStatus.checkedAt).toISOString()
            : null,
        },
        lastRun: lastScraper
          ? {
              startedAt: lastScraper.startedAt,
              status: lastScraper.status,
              items: lastScraper.itemsProcessed,
              successCount: lastScraper.successCount,
              failureCount: lastScraper.failureCount,
            }
          : null,
      },
      outreach: {
        status: outreachPaused ? "paused" : "ok",
        detail: outreachPaused ? `Paused: ${outreachPauseReason}` : "Active",
        lastRun: lastOutreach
          ? {
              startedAt: lastOutreach.startedAt,
              status: lastOutreach.status,
              items: lastOutreach.itemsProcessed,
              successCount: lastOutreach.successCount,
              failureCount: lastOutreach.failureCount,
            }
          : null,
      },
      emailDrip: {
        status: hasResendCredentials() ? "ok" : "degraded",
        detail: hasResendCredentials()
          ? "Resend credentials available"
          : "Missing RESEND_API_KEY or Resend connector",
        lastRun: lastDrip
          ? {
              startedAt: lastDrip.startedAt,
              status: lastDrip.status,
              items: lastDrip.itemsProcessed,
              successCount: lastDrip.successCount,
              failureCount: lastDrip.failureCount,
            }
          : null,
      },
      sms: {
        status:
          hasEnv("TWILIO_ACCOUNT_SID") && hasEnv("TWILIO_AUTH_TOKEN")
            ? "ok"
            : "degraded",
        detail:
          hasEnv("TWILIO_ACCOUNT_SID") && hasEnv("TWILIO_AUTH_TOKEN")
            ? "Twilio configured"
            : "Missing Twilio credentials",
      },
      billing: {
        status: "ok",
        detail: `${proCount} Pro, ${businessCount} Business active`,
      },
    };

    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || "development",
      database: dbStatus,
      subsystems,
      metrics: {
        today: {
          signups: signupsToday,
          estimates: estimatesToday,
          emailsSent: emailsSentToday,
          emailsFailed: emailsFailedToday,
          leadsScraped: leadsScrapedToday,
        },
        totals: {
          users: totalUsers,
          subscribers: proCount + businessCount,
          outreachQueuePending,
          dripEmailsPending,
          homepageLeadsTotal,
          // Multi-channel lead metrics (Task #141)
          leadsTotal,
          leadsWithPhone,
          leadsWithEmail,
          leadsNoEmailButContactable,
          leadsWebsiteOutreachPending,
          leadsContacted,
        },
        revenue: {
          mrr,
          arr: mrr * 12,
          proSubscribers: proCount,
          businessSubscribers: businessCount,
        },
      },
      recentJobRuns: recentRuns,
    });
  }),
);

// --- /api/admin/test-google-places — live diagnostic for the Google Places API key ---
app.get(
  "/api/admin/test-google-places",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.json({
        ok: false,
        status: "NO_KEY",
        error_message: "GOOGLE_PLACES_API_KEY secret is not set.",
        results_count: 0,
      });
    }

    let rawStatus = "UNKNOWN";
    let rawErrorMessage: string | null = null;
    let resultsCount = 0;
    let rawResponse: unknown = null;

    try {
      const url = new URL(
        "https://maps.googleapis.com/maps/api/place/textsearch/json",
      );
      url.searchParams.set("query", "roofing contractor in Chicago");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("type", "establishment");

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as {
        status?: string;
        error_message?: string;
        results?: unknown[];
      };
      rawStatus = data.status ?? "UNKNOWN";
      rawErrorMessage = data.error_message ?? null;
      resultsCount = data.results?.length ?? 0;
      rawResponse = {
        status: data.status,
        error_message: data.error_message,
        results_count: resultsCount,
      };
    } catch (err: unknown) {
      rawStatus = "FETCH_ERROR";
      rawErrorMessage = err instanceof Error ? err.message : String(err);
    }

    const ok = rawStatus === "OK" || rawStatus === "ZERO_RESULTS";

    log(ok ? "info" : "warn", "google-places-diagnostic", {
      status: rawStatus,
      error_message: rawErrorMessage,
      results_count: resultsCount,
      action: ok
        ? "Google Places API is working"
        : "Check billing at https://console.cloud.google.com/project/_/billing/enable",
    });

    return res.json({
      ok,
      status: rawStatus,
      error_message: rawErrorMessage,
      results_count: resultsCount,
      raw: rawResponse,
      hint: ok
        ? "Google Places API is working correctly."
        : rawStatus === "REQUEST_DENIED"
          ? "Billing not enabled or Places API not activated on this key. Visit: https://console.cloud.google.com/project/_/billing/enable and enable the Places API at https://console.cloud.google.com/apis/library/places-backend.googleapis.com"
          : `Unexpected status: ${rawStatus}. Check the error_message field for details.`,
    });
  }),
);

// --- /api/admin/job-runs — paginated job run history ---
app.get(
  "/api/admin/job-runs",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 200);
    const jobName = req.query.job as string | undefined;
    const baseQuery = db
      .select()
      .from(jobRuns)
      .orderBy(desc(jobRuns.startedAt))
      .limit(limit);
    const rows = jobName
      ? await db
          .select()
          .from(jobRuns)
          .where(eq(jobRuns.jobName, jobName))
          .orderBy(desc(jobRuns.startedAt))
          .limit(limit)
      : await baseQuery;
    res.json({ success: true, data: rows });
  }),
);

// --- /api/admin/errors — error monitoring dashboard ---
app.get(
  "/api/admin/errors",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 200);
    const showResolved = req.query.resolved === "true";

    const errors = await db
      .select()
      .from(errorLogs)
      .where(showResolved ? undefined : eq(errorLogs.resolved, false))
      .orderBy(desc(errorLogs.lastSeenAt))
      .limit(limit);

    const [totalResult] = await db
      .select({ c: count() })
      .from(errorLogs)
      .where(eq(errorLogs.resolved, false));
    const unresolvedCount = totalResult?.c || 0;

    const last24h = Date.now() - 86400000;
    const [recentResult] = await db
      .select({ c: count() })
      .from(errorLogs)
      .where(and(eq(errorLogs.resolved, false), gte(errorLogs.lastSeenAt, last24h)));
    const recentCount = recentResult?.c || 0;

    const [fatalResult] = await db
      .select({ c: count() })
      .from(errorLogs)
      .where(and(eq(errorLogs.resolved, false), eq(errorLogs.level, "fatal")));
    const fatalCount = fatalResult?.c || 0;

    res.json({
      success: true,
      data: {
        errors,
        summary: {
          unresolved: unresolvedCount,
          last24h: recentCount,
          fatal: fatalCount,
        },
      },
    });
  }),
);

app.post(
  "/api/admin/errors/:id/resolve",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.update(errorLogs).set({ resolved: true }).where(eq(errorLogs.id, id));
    res.json({ success: true });
  }),
);

app.post(
  "/api/admin/errors/resolve-all",
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    await db.update(errorLogs).set({ resolved: true }).where(eq(errorLogs.resolved, false));
    res.json({ success: true });
  }),
);

// --- /api/admin/deliverability — outreach email deliverability metrics ---
app.get(
  "/api/admin/deliverability",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const days = Math.min(parseInt(String(req.query.days || "30"), 10), 90);
    const since = Date.now() - days * 86400000;

    const sinceStr = new Date(since).toISOString();

    const [totalSent] = await db
      .select({ c: count() })
      .from(leadEmailAuditLog)
      .where(and(eq(leadEmailAuditLog.status, "sent"), gte(leadEmailAuditLog.sentAt, sinceStr)));

    // Bounce statuses are written as `bounced_hard` / `bounced_soft` / `bounced_undetermined`
    // by the Resend webhook handler. Match the family with LIKE so the dashboard tile is correct.
    const [totalBounced] = await db
      .select({ c: count() })
      .from(leadEmailAuditLog)
      .where(and(like(leadEmailAuditLog.status, "bounced%"), gte(leadEmailAuditLog.sentAt, sinceStr)));

    const [totalFailed] = await db
      .select({ c: count() })
      .from(leadEmailAuditLog)
      .where(and(eq(leadEmailAuditLog.status, "failed"), gte(leadEmailAuditLog.sentAt, sinceStr)));

    const [totalAll] = await db
      .select({ c: count() })
      .from(leadEmailAuditLog)
      .where(gte(leadEmailAuditLog.sentAt, sinceStr));

    const sent = totalSent?.c || 0;
    const bounced = totalBounced?.c || 0;
    const failed = totalFailed?.c || 0;
    const total = totalAll?.c || 0;

    const bounceRate = total > 0 ? ((bounced / total) * 100).toFixed(2) : "0.00";
    const failRate = total > 0 ? ((failed / total) * 100).toFixed(2) : "0.00";
    const successRate = total > 0 ? ((sent / total) * 100).toFixed(2) : "0.00";

    const dailyBreakdown = await db
      .select({
        day: sql<string>`LEFT(${leadEmailAuditLog.sentAt}, 10)`,
        status: leadEmailAuditLog.status,
        c: count(),
      })
      .from(leadEmailAuditLog)
      .where(gte(leadEmailAuditLog.sentAt, sinceStr))
      .groupBy(
        sql`LEFT(${leadEmailAuditLog.sentAt}, 10)`,
        leadEmailAuditLog.status,
      )
      .orderBy(sql`LEFT(${leadEmailAuditLog.sentAt}, 10)`);

    const [queuePending] = await db
      .select({ c: count() })
      .from(leadOutreachQueue)
      .where(eq(leadOutreachQueue.status, "pending"));

    const [doNotContact] = await db
      .select({ c: count() })
      .from(scrapedLeads)
      .where(eq(scrapedLeads.doNotContact, true));

    res.json({
      success: true,
      data: {
        period: `${days} days`,
        totals: { sent, bounced, failed, total },
        rates: {
          bounce: `${bounceRate}%`,
          failure: `${failRate}%`,
          success: `${successRate}%`,
        },
        outreachPaused,
        outreachPauseReason: outreachPaused ? outreachPauseReason : null,
        queuePending: queuePending?.c || 0,
        doNotContactCount: doNotContact?.c || 0,
        dailyBreakdown,
      },
    });
  }),
);


}
