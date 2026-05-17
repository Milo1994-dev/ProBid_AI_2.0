import express from "express";
import crypto from "crypto";
import { asyncHandler, requireAdminAuthPage } from "../../lib/middleware.js";
import { isAdminRequest } from "./shared.js";
import { getGrowthHealthSnapshot } from "../../growth-health.js";
import { GROWTH_HEALTH_RULES } from "../../lib/growth-health-rules.js";
import { getPoolResetStats, getDuplicateDealRaceStats, pool } from "../../db.js";
import { buildDailyDigest, sendDailyDigest } from "../../lib/daily-digest.js";
import { verifyResendWebhook } from "../../lib/outreach-helpers.js";
import { outreachPaused, outreachPauseReason } from "../../lib/outreach-state.js";
import { escapeHtml } from "../../lib/utils.js";

function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function statusColors(status: string): { bg: string; fg: string; dot: string } {
  switch (status) {
    case "green":
      return { bg: "rgba(34,197,94,0.12)", fg: "#22c55e", dot: "#22c55e" };
    case "yellow":
      return { bg: "rgba(245,158,11,0.12)", fg: "#f59e0b", dot: "#f59e0b" };
    case "red":
      return { bg: "rgba(239,68,68,0.12)", fg: "#f87171", dot: "#ef4444" };
    case "paused":
      return { bg: "rgba(148,163,184,0.12)", fg: "#94a3b8", dot: "#94a3b8" };
    default:
      return { bg: "rgba(148,163,184,0.12)", fg: "#94a3b8", dot: "#94a3b8" };
  }
}

export function registerAdminHealthRoutes(app: express.Application): void {
  app.get(
    "/api/admin/health",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const force = req.query.refresh === "1";
      const [snapshot, alertsRes] = await Promise.all([
        getGrowthHealthSnapshot(force),
        pool.query<{
          id: number;
          type: string;
          message: string;
          severity: string;
          created_at: string;
        }>(
          `SELECT id, type, message, severity, created_at::text
             FROM system_alerts
            WHERE resolved_at IS NULL
            ORDER BY created_at DESC LIMIT 100`,
        ),
      ]);
      const bootedAt = Date.now() - Math.round(process.uptime() * 1000);
      res.json({
        success: true,
        data: {
          generatedAt: snapshot.generatedAt,
          overall: snapshot.overall,
          subsystems: snapshot.subsystems,
          rules: GROWTH_HEALTH_RULES,
          pool: getPoolResetStats(60 * 60 * 1000),
          duplicateDealRaces: getDuplicateDealRaceStats(60 * 60 * 1000),
          activeAlerts: alertsRes.rows.map((r) => ({
            id: r.id,
            type: r.type,
            severity: r.severity,
            message: r.message,
            createdAt: Number(r.created_at),
          })),
          process: {
            bootedAt,
            uptimeMs: Date.now() - bootedAt,
            nodeVersion: process.version,
          },
        },
      });
    }),
  );

  app.get(
    "/api/admin/health/digest-preview",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const payload = await buildDailyDigest();
      res.json({ success: true, data: payload });
    }),
  );

  app.post(
    "/api/admin/health/digest-send",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const result = await sendDailyDigest();
      res.json({ success: result.sent, data: result });
    }),
  );

  // In-process Resend webhook self-test. Synthesizes a payload signed with the
  // current RESEND_WEBHOOK_SECRET and runs it through verifyResendWebhook so we
  // can confirm the verification path works without touching the public
  // endpoint or the Resend dashboard. Reports the verdict plus the last
  // verified event timestamp (so operators can also see whether Resend is
  // actually reaching the public webhook).
  //
  // The secret itself is never returned — only a sha256 fingerprint so the
  // operator can confirm it matches what they pasted into Resend.
  app.post(
    "/api/admin/health/webhook-selftest",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });

      const secret = process.env.RESEND_WEBHOOK_SECRET || "";
      const secretFingerprint = secret
        ? crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12)
        : null;

      const payload = JSON.stringify({
        type: "selftest",
        data: { email: { to: ["selftest@probidcore.net"] } },
      });
      const rawBody = Buffer.from(payload);
      const msgId = `selftest_${Date.now()}`;
      const ts = String(Math.floor(Date.now() / 1000));

      let signedHeaders: Record<string, string> = {};
      if (secret) {
        const secretBytes = Buffer.from(
          secret.startsWith("whsec_") ? secret.slice(6) : secret,
          "base64",
        );
        const sig = crypto
          .createHmac("sha256", secretBytes)
          .update(`${msgId}.${ts}.${payload}`)
          .digest("base64");
        signedHeaders = {
          "svix-id": msgId,
          "svix-timestamp": ts,
          "svix-signature": `v1,${sig}`,
        };
      }

      const verifyOk = verifyResendWebhook(rawBody, signedHeaders);

      const lastEventRes = await pool
        .query<{ value: string }>(
          `SELECT value FROM lead_outreach_config WHERE key = 'resend_webhook_last_event'`,
        )
        .catch(() => ({ rows: [] as { value: string }[] }));
      let lastEvent: { ts: string; type: string } | null = null;
      try {
        if (lastEventRes.rows[0]?.value)
          lastEvent = JSON.parse(lastEventRes.rows[0].value);
      } catch {
        /* ignore */
      }

      res.json({
        success: verifyOk,
        data: {
          verdict: verifyOk ? "ok" : "failed",
          message: !secret
            ? "RESEND_WEBHOOK_SECRET is not set. Webhook verification will reject every request in production."
            : verifyOk
              ? "Signature path is wired correctly. If Resend events still aren't arriving, the failure is upstream (Resend dashboard config or DNS), not signature verification."
              : "Signature verification failed even with our own signed payload. This means verifyResendWebhook has a bug or RESEND_WEBHOOK_SECRET is malformed.",
          secretConfigured: Boolean(secret),
          secretFingerprintSha256First12: secretFingerprint,
          secretLooksWhsecPrefixed: secret.startsWith("whsec_"),
          lastVerifiedEventFromResend: lastEvent,
          checklistIfNoEventsArriving: [
            "1. Resend dashboard → Webhooks → endpoint URL is https://probidcore.net/api/webhooks/resend",
            "2. Domain coverage includes outreach.probidcore.net (the sending subdomain)",
            "3. Signing secret in Resend matches RESEND_WEBHOOK_SECRET (compare fingerprint above)",
            "4. Send a test event from Resend, then GET /api/admin/health and watch the Resend Webhook card flip to live",
          ],
        },
      });
    }),
  );

  // HTML traffic-light dashboard rendering the existing growth-health snapshot.
  // Operators have a single page to see: overall status, every subsystem with
  // status/reasons/last-success, active alerts (with one-click resolve), cron
  // freshness, Resend webhook liveness, and outreach pause state.
  app.get(
    "/admin/health",
    requireAdminAuthPage,
    asyncHandler(async (req, res) => {
      const force = req.query.refresh === "1";
      const [snapshot, alertsRes, configRes] = await Promise.all([
        getGrowthHealthSnapshot(force),
        pool.query<{
          id: number;
          type: string;
          message: string;
          severity: string;
          created_at: string;
        }>(
          `SELECT id, type, message, severity, created_at::text
             FROM system_alerts
            WHERE resolved_at IS NULL
            ORDER BY created_at DESC LIMIT 100`,
        ),
        pool.query<{ key: string; value: string }>(
          `SELECT key, value FROM lead_outreach_config
            WHERE key IN ('resend_webhook_last_event', 'cron_last_scrape', 'cron_last_outreach')`,
        ),
      ]);

      const cfg: Record<string, string> = {};
      for (const r of configRes.rows) cfg[r.key] = r.value;

      let webhookLast: { ts: string; type: string } | null = null;
      try {
        if (cfg.resend_webhook_last_event)
          webhookLast = JSON.parse(cfg.resend_webhook_last_event);
      } catch {
        /* ignore parse error */
      }
      const webhookLastMs = webhookLast ? Date.parse(webhookLast.ts) : 0;
      const webhookStale =
        !webhookLastMs || Date.now() - webhookLastMs > 24 * 60 * 60 * 1000;

      const scrapeLastMs = cfg.cron_last_scrape ? Date.parse(cfg.cron_last_scrape) : 0;
      const outreachLastMs = cfg.cron_last_outreach ? Date.parse(cfg.cron_last_outreach) : 0;

      const overallColors = statusColors(snapshot.overall);
      const subsystemCards = snapshot.subsystems
        .map((s) => {
          const c = statusColors(s.status);
          const reasonsHtml = s.reasons
            .map(
              (r) =>
                `<li style="font-size:12px;color:#cbd5e1;margin:2px 0">${escapeHtml(r)}</li>`,
            )
            .join("");
          const errHtml = s.latestError
            ? `<div style="font-size:11px;color:#f87171;margin-top:8px;font-family:monospace;background:rgba(0,0,0,0.25);padding:6px 8px;border-radius:4px;word-break:break-word">${escapeHtml(s.latestError.slice(0, 280))}</div>`
            : "";
          return `<div style="background:${c.bg};border:1px solid ${c.fg}33;border-radius:10px;padding:14px 16px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="width:10px;height:10px;border-radius:50%;background:${c.dot};box-shadow:0 0 8px ${c.dot}80"></span>
              <span style="font-weight:700;color:#e8f0ff;font-size:14px">${escapeHtml(s.label)}</span>
              <span style="margin-left:auto;font-size:11px;color:${c.fg};text-transform:uppercase;letter-spacing:.5px;font-weight:700">${escapeHtml(s.status)}</span>
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${escapeHtml(s.description)}</div>
            <div style="display:flex;gap:14px;font-size:11px;color:#94a3b8;margin-bottom:8px;flex-wrap:wrap">
              <span>✓ last ok: <strong style="color:#cbd5e1">${escapeHtml(fmtAgo(s.lastSuccessAt))}</strong></span>
              ${s.lastFailureAt ? `<span>✗ last fail: <strong style="color:#cbd5e1">${escapeHtml(fmtAgo(s.lastFailureAt))}</strong></span>` : ""}
              <span>24h: <strong style="color:#cbd5e1">${s.throughput24h}</strong> ok / <strong style="color:${s.failureCount24h > 0 ? "#f87171" : "#cbd5e1"}">${s.failureCount24h}</strong> fail</span>
            </div>
            ${reasonsHtml ? `<ul style="margin:0;padding-left:18px">${reasonsHtml}</ul>` : ""}
            ${errHtml}
            ${s.drilldownPath ? `<div style="margin-top:8px"><a href="${escapeHtml(s.drilldownPath)}" style="font-size:11px;color:#60a5fa;text-decoration:none">View details →</a></div>` : ""}
          </div>`;
        })
        .join("");

      const alertsHtml =
        alertsRes.rows.length === 0
          ? `<div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:8px;padding:14px 16px;color:#22c55e;font-size:13px">✓ No unresolved system alerts.</div>`
          : alertsRes.rows
              .map((a) => {
                const sevColor = a.severity === "critical" ? "#ef4444" : "#f59e0b";
                const ts = new Date(Number(a.created_at)).toLocaleString();
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
              .join("");

      const webhookCardColor = webhookStale ? statusColors("red") : statusColors("green");
      const webhookCard = `<div style="background:${webhookCardColor.bg};border:1px solid ${webhookCardColor.fg}33;border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="width:10px;height:10px;border-radius:50%;background:${webhookCardColor.dot};box-shadow:0 0 8px ${webhookCardColor.dot}80"></span>
          <span style="font-weight:700;color:#e8f0ff;font-size:14px">Resend Webhook</span>
          <span style="margin-left:auto;font-size:11px;color:${webhookCardColor.fg};text-transform:uppercase;letter-spacing:.5px;font-weight:700">${webhookStale ? "stale" : "live"}</span>
        </div>
        <div style="font-size:12px;color:#94a3b8">
          Last verified event: <strong style="color:#cbd5e1">${escapeHtml(webhookLast ? `${webhookLast.type} — ${fmtAgo(webhookLastMs)}` : "never received")}</strong>
        </div>
        ${
          webhookStale
            ? `<div style="font-size:11px;color:#f87171;margin-top:8px;line-height:1.5">
                If this stays "never" or "stale", check the Resend dashboard → Webhooks:
                <ol style="margin:6px 0 0;padding-left:20px">
                  <li>Endpoint URL: <code>https://probidcore.net/api/webhooks/resend</code></li>
                  <li>Domain coverage includes <code>outreach.probidcore.net</code> (not just the main domain)</li>
                  <li>Signing secret matches the <code>RESEND_WEBHOOK_SECRET</code> env value</li>
                  <li>Send a test event from Resend, then refresh — the server logs will tell you which of the three failure modes hit</li>
                </ol>
              </div>`
            : ""
        }
      </div>`;

      const selftestCard = `<div style="background:rgba(15,23,42,0.5);border:1px solid rgba(148,163,184,0.2);border-radius:10px;padding:14px 16px">
        <div style="font-weight:700;color:#e8f0ff;font-size:14px;margin-bottom:6px">Webhook Signature Self-Test</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:10px">Synthesizes a signed payload in-process and runs it through verifyResendWebhook to prove the secret is wired. Does not hit Resend or the public endpoint.</div>
        <button type="button" onclick="runSelftest()" style="background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.3);color:#60a5fa;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Run self-test</button>
        <pre id="selftest-result" style="margin:10px 0 0;font-size:11px;color:#cbd5e1;background:rgba(0,0,0,0.25);padding:8px;border-radius:4px;display:none;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto"></pre>
      </div>`;

      const cronCard = `<div style="background:rgba(15,23,42,0.5);border:1px solid rgba(148,163,184,0.2);border-radius:10px;padding:14px 16px">
        <div style="font-weight:700;color:#e8f0ff;font-size:14px;margin-bottom:8px">Cron Heartbeats</div>
        <div style="font-size:12px;color:#94a3b8;display:grid;gap:6px">
          <div>Lead scraper: <strong style="color:#cbd5e1">${escapeHtml(fmtAgo(scrapeLastMs))}</strong></div>
          <div>Outreach processor: <strong style="color:#cbd5e1">${escapeHtml(fmtAgo(outreachLastMs))}</strong></div>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <form method="POST" action="/api/cron/scrape-leads" style="display:inline">
            <button type="submit" style="background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.3);color:#60a5fa;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Run Scrape Now</button>
          </form>
          <form method="POST" action="/api/cron/process-outreach" style="display:inline">
            <button type="submit" style="background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.3);color:#60a5fa;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Process Outreach Now</button>
          </form>
        </div>
      </div>`;

      const pauseBanner = outreachPaused
        ? `<div style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:14px">
            <div style="font-size:20px">⏸</div>
            <div style="flex:1">
              <div style="font-weight:700;color:#f87171;font-size:14px;margin-bottom:2px">Outreach is paused</div>
              <div style="font-size:12px;color:#cbd5e1">${escapeHtml(outreachPauseReason)}</div>
            </div>
            <form method="POST" action="/api/admin/outreach-resume" style="margin:0">
              <button type="submit" style="background:#22c55e;color:#000;border:0;border-radius:6px;padding:8px 16px;font-size:13px;cursor:pointer;font-weight:700">Resume Outreach</button>
            </form>
          </div>`
        : "";

      res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ProBid AI — System Health</title>
<meta http-equiv="refresh" content="60" />
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e1a;color:#e8f0ff}
  .wrap{max-width:1200px;margin:0 auto;padding:24px}
  h1{margin:0 0 4px;font-size:22px}
  h2{margin:28px 0 12px;font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
  a{color:#60a5fa}
  code{background:rgba(148,163,184,0.15);padding:1px 5px;border-radius:3px;font-size:12px}
</style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px">
      <div>
        <h1>System Health</h1>
        <div style="font-size:12px;color:#94a3b8">Generated ${escapeHtml(new Date(snapshot.generatedAt).toLocaleString())} · auto-refresh 60s · uptime ${escapeHtml(fmtAgo(Date.now() - Math.round(process.uptime() * 1000)))}</div>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
        <span style="width:14px;height:14px;border-radius:50%;background:${overallColors.dot};box-shadow:0 0 10px ${overallColors.dot}80"></span>
        <span style="font-size:14px;font-weight:700;color:${overallColors.fg};text-transform:uppercase;letter-spacing:1px">${escapeHtml(snapshot.overall)}</span>
        <a href="/admin/health?refresh=1" style="margin-left:14px;font-size:12px;color:#60a5fa;text-decoration:none;border:1px solid rgba(96,165,250,0.3);padding:6px 12px;border-radius:6px">↻ Force refresh</a>
        <a href="/admin" style="font-size:12px;color:#94a3b8;text-decoration:none;border:1px solid rgba(148,163,184,0.3);padding:6px 12px;border-radius:6px">← Back to /admin</a>
      </div>
    </div>

    ${pauseBanner}

    <h2>Active Alerts (${alertsRes.rows.length})</h2>
    ${alertsHtml}

    <h2>Subsystems</h2>
    <div class="grid">${subsystemCards}</div>

    <h2>Webhook & Cron Liveness</h2>
    <div class="grid">${webhookCard}${cronCard}${selftestCard}</div>

    <div style="margin-top:32px;font-size:11px;color:#64748b">
      Raw JSON: <a href="/api/admin/health">/api/admin/health</a> ·
      Daily digest preview: <a href="/api/admin/health/digest-preview">/api/admin/health/digest-preview</a>
    </div>
  </div>
  <script>
    async function runSelftest() {
      var out = document.getElementById('selftest-result');
      out.style.display = 'block';
      out.textContent = 'Running...';
      try {
        var r = await fetch('/api/admin/health/webhook-selftest', {
          method: 'POST',
          credentials: 'same-origin',
        });
        var j = await r.json();
        out.textContent = JSON.stringify(j, null, 2);
        out.style.color = j.success ? '#22c55e' : '#f87171';
      } catch (e) {
        out.textContent = 'Self-test request failed: ' + (e && e.message ? e.message : String(e));
        out.style.color = '#f87171';
      }
    }
  </script>
</body>
</html>`);
    }),
  );
}
