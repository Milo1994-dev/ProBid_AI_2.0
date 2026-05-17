import express from "express";
import { pool } from "../../db.js";
import { asyncHandler } from "../../lib/middleware.js";
import { isAdminRequest } from "../admin/shared.js";
import { log } from "../../lib/logger.js";
import { APP_URL } from "../../lib/config.js";
import { getResendClient, sendEmailWithRetry } from "../../resend-client.js";
import { escapeHtml } from "../../lib/utils.js";
import { ADMIN_EMAIL, PRICE_PRO, PRICE_BIZ } from "./_shared.js";

export function registerCronDailyReportRoutes(app: express.Application) {
// POST /api/cron/daily-report — compile and send 24h metrics digest
app.post(
  "/api/cron/daily-report",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });

    const since24h = Date.now() - 86400000;
    const since24hISO = new Date(since24h).toISOString();

    // Gather 24h metrics
    const [
      signupsRes,
      paidRes,
      proSubsRes,
      bizSubsRes,
      estimatesRes,
      leadsScrapedRes,
      emailsSentRes,
      unresolvedAlertsRes,
    ] = await Promise.all([
      pool.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM users WHERE created_at >= $1`,
        [since24h],
      ),
      pool.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'active' AND updated_at >= $1`,
        [since24h],
      ),
      pool.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'active' AND price_id = $1`,
        [PRICE_PRO],
      ),
      pool.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'active' AND price_id = $1`,
        [PRICE_BIZ],
      ),
      pool.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM estimates WHERE created_at >= $1`,
        [since24h],
      ),
      pool.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM scraped_leads WHERE created_at >= $1`,
        [since24h],
      ),
      pool.query<{ c: string }>(
        `SELECT COUNT(DISTINCT lead_id) AS c FROM lead_email_audit_log WHERE status = 'sent' AND sent_at >= $1`,
        [since24hISO],
      ),
      pool.query<{
        id: number;
        type: string;
        message: string;
        severity: string;
        created_at: number;
      }>(
        `SELECT id, type, message, severity, created_at FROM system_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`,
      ),
    ]);

    const signups = Number(signupsRes.rows[0]?.c ?? 0);
    const paidConversions = Number(paidRes.rows[0]?.c ?? 0);
    const mrr =
      Number(proSubsRes.rows[0]?.c ?? 0) * 25 +
      Number(bizSubsRes.rows[0]?.c ?? 0) * 55;
    const estimatesGenerated = Number(estimatesRes.rows[0]?.c ?? 0);
    const leadsScraped = Number(leadsScrapedRes.rows[0]?.c ?? 0);
    const emailsSent = Number(emailsSentRes.rows[0]?.c ?? 0);
    const unresolvedAlerts = unresolvedAlertsRes.rows;

    const metricRow = (label: string, value: string | number) =>
      `<tr><td style="padding:10px 16px;color:#94a3b8;border-bottom:1px solid rgba(255,255,255,0.05)">${label}</td>` +
      `<td style="padding:10px 16px;color:#e8f0ff;font-weight:700;text-align:right;border-bottom:1px solid rgba(255,255,255,0.05)">${value}</td></tr>`;

    const alertsHtml =
      unresolvedAlerts.length > 0
        ? `<h3 style="color:#f87171;margin:32px 0 12px">⚠ ${unresolvedAlerts.length} Unresolved System Alert${unresolvedAlerts.length > 1 ? "s" : ""}</h3>` +
          unresolvedAlerts
            .map(
              (a) =>
                `<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px 16px;margin-bottom:8px">` +
                `<div style="color:#f87171;font-weight:600;font-size:13px">[${a.severity.toUpperCase()}] ${escapeHtml(a.type)}</div>` +
                `<div style="color:#94a3b8;font-size:13px;margin-top:4px">${escapeHtml(a.message)}</div>` +
                `</div>`,
            )
            .join("")
        : `<p style="color:#22c55e;margin:16px 0 0">✓ No unresolved system alerts</p>`;

    const reportDate = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#0a0e1a;color:#e8f0ff">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 20px">
<table width="600" cellpadding="0" cellspacing="0" align="center" style="background:#121a2a;border-radius:12px;border:1px solid rgba(79,70,229,0.3);max-width:600px">
<tr><td style="padding:0;border-radius:12px 12px 0 0;overflow:hidden;background:linear-gradient(135deg,#1e1b4b,#1e3a5f)">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:24px 40px">
      <span style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#6366f1);border-radius:10px;padding:7px 16px;font-size:15px;font-weight:800;color:#fff;letter-spacing:-0.3px">ProBid AI</span>
      <span style="margin-left:12px;font-size:12px;font-weight:600;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:1px">Admin Reports</span>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:32px 40px;border-bottom:1px solid rgba(255,255,255,0.08)">
  <h1 style="margin:0;font-size:20px;font-weight:800;color:#e8f0ff">Daily Performance Report</h1>
  <p style="margin:8px 0 0;font-size:13px;color:#94a3b8">${reportDate}</p>
</td></tr>
<tr><td style="padding:32px 40px">
  <h2 style="margin:0 0 16px;font-size:16px;color:#a5b4fc">Last 24 Hours</h2>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.08)">
    ${metricRow("New Signups", signups)}
    ${metricRow("Paid Conversions", paidConversions)}
    ${metricRow("Current MRR (all active subs, not 24h delta)", "$" + mrr.toFixed(0))}
    ${metricRow("Estimates Generated", estimatesGenerated)}
    ${metricRow("Leads Scraped", leadsScraped)}
    ${metricRow("Outreach Emails Sent", emailsSent)}
  </table>
  ${alertsHtml}
</td></tr>
<tr><td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.08)">
  <p style="margin:0;font-size:12px;color:#4b5563">
    <a href="${APP_URL}/admin" style="color:#4f46e5">View Admin Dashboard</a>
  </p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

    if (ADMIN_EMAIL) {
      try {
        const { client, fromEmail } = await getResendClient();
        await sendEmailWithRetry(
          client,
          {
            from: fromEmail,
            to: ADMIN_EMAIL,
            subject: `ProBid AI Daily Report — ${reportDate}`,
            html,
          },
          {
            idempotencyKey: `daily-report/${reportDate}`,
            logContext: { reportDate },
          },
        );
        log("info", "Daily report sent", { to: ADMIN_EMAIL, signups, mrr });
      } catch (err) {
        log("warn", "Daily report email failed", { error: String(err) });
      }
    }

    res.json({
      success: true,
      data: {
        signups,
        paidConversions,
        mrr,
        estimatesGenerated,
        leadsScraped,
        emailsSent,
        unresolvedAlerts: unresolvedAlerts.length,
      },
    });
  }),
);
}
