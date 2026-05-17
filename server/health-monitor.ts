import { pool } from "./db.js";
import { getResendClient, sendEmailWithRetry } from "./resend-client.js";
import { dayKey } from "./lib/utils.js";
import { getGrowthHealthSnapshot, invalidateGrowthHealthCache } from "./growth-health.js";
import type { SubsystemRollup } from "./growth-health.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

const GROWTH_HEALTH_TYPE_PREFIX = "growth_health.";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

/** Lightweight check: can we execute a simple DB query? */
async function checkDatabase(): Promise<CheckResult> {
  try {
    await pool.query("SELECT 1");
    return { name: "database", ok: true, message: "Database responsive" };
  } catch (err) {
    return { name: "database", ok: false, message: `DB error: ${String(err)}` };
  }
}

/** Check that each cron job has run within the expected window.
 *  Timestamps are stored in lead_outreach_config as cron_last_<name> (ISO string).
 *  Max age: scrape=25h, process_outreach=25h (should run once daily).
 */
async function checkCronRecency(): Promise<CheckResult> {
  // In dev/test the container sleeps between sessions, so the in-process
  // node-cron job rarely fires at the top of the hour and produces a permanent
  // false-positive "stale outreach" alert. Only run the check when we're
  // confident this is a production runtime — either NODE_ENV=production OR
  // REPLIT_DEPLOYMENT=1 (the canonical Replit deployment signal already used
  // throughout server/lib/config.ts and email-helpers.ts). Fail-closed: if
  // either signal is set we still run the check, so a missing NODE_ENV in
  // a Replit deployment does not silently disable monitoring.
  const env = (process.env.NODE_ENV || "").toLowerCase();
  const isProduction = env === "production" || process.env.REPLIT_DEPLOYMENT === "1";
  if (!isProduction) {
    return { name: "cron_recency", ok: true, message: `Skipped (non-production runtime, NODE_ENV=${env || "unset"})` };
  }
  try {
    const rows = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM lead_outreach_config WHERE key LIKE 'cron_last_%'`
    );
    if (rows.rows.length === 0) {
      return { name: "cron_recency", ok: true, message: "No cron timestamps recorded yet" };
    }
    const stale: string[] = [];
    const maxAgeMs = 25 * 60 * 60 * 1000;
    for (const row of rows.rows) {
      const ts = Date.parse(row.value);
      if (!isNaN(ts) && Date.now() - ts > maxAgeMs) {
        stale.push(row.key.replace("cron_last_", ""));
      }
    }
    if (stale.length > 0) {
      return { name: "cron_recency", ok: false, message: `Stale cron jobs: ${stale.join(", ")}` };
    }
    return { name: "cron_recency", ok: true, message: "All cron jobs ran recently" };
  } catch (err) {
    return { name: "cron_recency", ok: false, message: `Cron check error: ${String(err)}` };
  }
}

/** Check that Stripe key is present and non-empty (avoids API call to prevent false alarms). */
function checkStripeConfig(): CheckResult {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key || key.length < 10) {
    return { name: "stripe_config", ok: false, message: "STRIPE_SECRET_KEY missing or too short" };
  }
  return { name: "stripe_config", ok: true, message: "Stripe key present" };
}

/** Validate OpenAI key is present (avoids a live API call for basic health check). */
function checkOpenAIConfig(): CheckResult {
  const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!key || key.length < 10) {
    return { name: "openai_config", ok: false, message: "OpenAI key missing or too short" };
  }
  return { name: "openai_config", ok: true, message: "OpenAI key present" };
}

/** Insert a system alert, skipping if an identical unresolved alert exists within the last 4 hours.
 *  Returns true if a new row was inserted (caller should send email), false if suppressed by dedup. */
async function insertSystemAlert(
  type: string,
  message: string,
  severity: string
): Promise<boolean> {
  const dedupWindowMs = 4 * 60 * 60 * 1000; // 4 hours
  const since = Date.now() - dedupWindowMs;
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM system_alerts WHERE type = $1 AND resolved_at IS NULL AND created_at >= $2 LIMIT 1`,
    [type, since]
  );
  if (existing.rows.length > 0) return false; // suppress duplicate within window
  await pool.query(
    `INSERT INTO system_alerts (type, message, severity, created_at) VALUES ($1, $2, $3, $4)`,
    [type, message, severity, Date.now()]
  );
  return true;
}

async function sendAlertEmail(
  type: string,
  subject: string,
  bodyHtml: string,
  variant: string = "alert",
): Promise<void> {
  if (!ADMIN_EMAIL) return;
  try {
    const { client, fromEmail } = await getResendClient();
    // variant must distinguish escalations (yellow vs red) and recoveries
    // so Resend's per-payload idempotency check doesn't 409 on a real flip.
    const bucket = Math.floor(Date.now() / (4 * 60 * 60 * 1000));
    await sendEmailWithRetry(
      client,
      { from: fromEmail, to: ADMIN_EMAIL, subject, html: bodyHtml },
      {
        idempotencyKey: `health-alert/${type}/${variant}/${bucket}`,
        logContext: { alertType: type, variant },
      },
    );
  } catch {
    /* best-effort */
  }
}

/** Run all health checks, insert system alerts, and email on failures. */
export async function runHealthChecks(): Promise<void> {
  const results: CheckResult[] = await Promise.all([
    checkDatabase(),
    checkCronRecency(),
    Promise.resolve(checkStripeConfig()),
    Promise.resolve(checkOpenAIConfig()),
  ]);

  const failures = results.filter((r) => !r.ok);
  for (const f of failures) {
    try {
      const severity = f.name === "database" ? "critical" : "warning";
      const isNew = await insertSystemAlert(f.name, f.message, severity);

      // Only send email alert when a new alert row was inserted (dedup window suppresses repeats)
      if (isNew) {
        const subject = `[ProBid AI] Health alert: ${f.name}`;
        const bodyHtml = `
<div style="font-family:Arial,sans-serif;background:#0a0e1a;color:#e8f0ff;padding:32px">
  <h2 style="color:#f87171;margin:0 0 16px">Health Alert: ${f.name}</h2>
  <p style="color:#94a3b8;margin:0 0 12px">Severity: <strong style="color:${f.name === "database" ? "#ef4444" : "#f59e0b"}">${f.name === "database" ? "CRITICAL" : "WARNING"}</strong></p>
  <p style="color:#e8f0ff;margin:0 0 24px">${f.message}</p>
  <p style="color:#94a3b8;font-size:13px">Detected at ${new Date().toISOString()}</p>
  <p style="color:#94a3b8;font-size:12px">This alert will not repeat for 4 hours while the condition persists.</p>
</div>`;
        await sendAlertEmail(f.name, subject, bodyHtml);
      }
    } catch {
      /* individual failure should not abort other checks */
    }
  }

  const failureSummary = failures.length > 0
    ? ` — ${failures.map((f) => `${f.name}: ${f.message}`).join("; ")}`
    : "";
  console.log(
    `[health-monitor] check complete at ${new Date().toISOString()}: ${results.length} checks, ${failures.length} failure${failures.length === 1 ? "" : "s"}${failureSummary}`
  );

  // Per-subsystem growth-engine evaluation. Each subsystem has its own
  // alert type (`growth_health.<key>`); recoveries resolve open alerts.
  await runGrowthHealthChecks();
}

/** Evaluate all growth-health subsystems and reconcile system_alerts rows.
 *  Exported for direct use in tests; production callers go through runHealthChecks(). */
export async function runGrowthHealthChecks(): Promise<void> {
  let snapshot;
  try {
    invalidateGrowthHealthCache();
    snapshot = await getGrowthHealthSnapshot(true);
  } catch (err) {
    console.error("[health-monitor] growth-health snapshot failed:", String(err));
    return;
  }

  for (const sub of snapshot.subsystems) {
    try {
      await reconcileSubsystemAlert(sub);
    } catch (err) {
      console.error(
        `[health-monitor] reconcile failed for ${sub.key}:`,
        String(err),
      );
    }
  }
}

async function reconcileSubsystemAlert(sub: SubsystemRollup): Promise<void> {
  const type = `${GROWTH_HEALTH_TYPE_PREFIX}${sub.key}`;
  const open = await pool.query<{ id: number; severity: string }>(
    `SELECT id, severity FROM system_alerts WHERE type = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [type],
  );
  const previouslyOpen = open.rows[0];

  if (sub.status === "red" || sub.status === "yellow") {
    const severity = sub.status === "red" ? "critical" : "warning";
    const message = `${sub.label}: ${sub.reasons.join("; ")}`;
    // Open-incident dedupe: if an open alert at the same (or higher) severity
    // already exists, do nothing — one notification per incident until recovery.
    if (previouslyOpen && previouslyOpen.severity === severity) return;
    if (previouslyOpen && previouslyOpen.severity === "critical" && severity === "warning") {
      // Already firing at higher severity; don't downgrade or notify.
      return;
    }
    // Yellow→red escalation: resolve open rows so the new red row is recorded
    // and a fresh notification goes out.
    if (previouslyOpen) {
      await pool.query(
        `UPDATE system_alerts SET resolved_at = $1 WHERE type = $2 AND resolved_at IS NULL`,
        [Date.now(), type],
      );
    }
    await pool.query(
      `INSERT INTO system_alerts (type, message, severity, created_at) VALUES ($1, $2, $3, $4)`,
      [type, message, severity, Date.now()],
    );
    await sendAlertEmail(
      type,
      `[ProBid AI] Growth Engine ${sub.status.toUpperCase()}: ${sub.label}`,
      renderGrowthAlertEmail(sub, severity),
      severity, // distinct idempotency variant per severity
    );
  } else if (sub.status === "green" || sub.status === "paused") {
    if (previouslyOpen) {
      await pool.query(
        `UPDATE system_alerts SET resolved_at = $1 WHERE type = $2 AND resolved_at IS NULL`,
        [Date.now(), type],
      );
      const word = sub.status === "paused" ? "PAUSED" : "RECOVERED";
      await sendAlertEmail(
        type,
        `[ProBid AI] Growth Engine ${word}: ${sub.label}`,
        renderGrowthRecoveryEmail(sub),
        sub.status === "paused" ? "paused" : "recovered",
      );
    }
  }
  // status === "unknown" → never alert (e.g. fresh deploy, no Procore tenants)
}

export function renderGrowthAlertEmail(sub: SubsystemRollup, severity: string): string {
  const color = severity === "critical" ? "#ef4444" : "#f59e0b";
  const lastSuccess = sub.lastSuccessAt
    ? new Date(sub.lastSuccessAt).toISOString()
    : "never";
  const lastFailure = sub.lastFailureAt
    ? new Date(sub.lastFailureAt).toISOString()
    : "—";
  return `
<div style="font-family:Arial,sans-serif;background:#0a0e1a;color:#e8f0ff;padding:32px">
  <h2 style="color:${color};margin:0 0 16px">Growth Engine — ${sub.label}</h2>
  <p style="color:#94a3b8;margin:0 0 12px">Severity: <strong style="color:${color}">${severity.toUpperCase()}</strong></p>
  <ul style="color:#e8f0ff;margin:0 0 16px;padding-left:18px">
    ${sub.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
  </ul>
  <table style="font-size:13px;color:#94a3b8;border-collapse:collapse">
    <tr><td style="padding:2px 12px 2px 0">Last success</td><td>${lastSuccess}</td></tr>
    <tr><td style="padding:2px 12px 2px 0">Last failure</td><td>${lastFailure}</td></tr>
    <tr><td style="padding:2px 12px 2px 0">24h throughput</td><td>${sub.throughput24h}</td></tr>
    <tr><td style="padding:2px 12px 2px 0">24h failures</td><td>${sub.failureCount24h}</td></tr>
    ${sub.latestError ? `<tr><td style="padding:2px 12px 2px 0">Latest error</td><td>${escapeHtml(sub.latestError)}</td></tr>` : ""}
    ${(() => {
      const t = sub.meta?.thresholds as { yellow: string; red: string; label: string; direction: string; currentValue?: string } | undefined;
      if (!t) return "";
      const currentRow = t.currentValue !== undefined
        ? `<tr><td style="padding:2px 12px 2px 0">Current</td><td><strong>${escapeHtml(t.currentValue)} ${escapeHtml(t.label)}</strong></td></tr>`
        : "";
      return `${currentRow}<tr><td style="padding:2px 12px 2px 0">Thresholds</td><td>⚠ ${escapeHtml(t.yellow)} / 🔴 ${escapeHtml(t.red)} ${escapeHtml(t.label)}</td></tr>`;
    })()}
  </table>
  <p style="color:#94a3b8;font-size:12px;margin-top:20px">Runbook: /documents/runbook-growth-health.md · One alert per incident — no re-fire until this is resolved (or escalates to red).</p>
</div>`;
}

export function renderGrowthRecoveryEmail(sub: SubsystemRollup): string {
  const lastSuccess = sub.lastSuccessAt
    ? new Date(sub.lastSuccessAt).toISOString()
    : "—";
  const heading = sub.status === "paused" ? "Paused" : "Recovered";
  return `
<div style="font-family:Arial,sans-serif;background:#0a0e1a;color:#e8f0ff;padding:32px">
  <h2 style="color:#22c55e;margin:0 0 16px">${heading}: ${sub.label}</h2>
  <p style="color:#e8f0ff;margin:0 0 16px">Status is now <strong style="color:#22c55e">${sub.status.toUpperCase()}</strong>.</p>
  <p style="color:#94a3b8;font-size:13px">Last success: ${lastSuccess} · 24h throughput: ${sub.throughput24h}</p>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bootstrap the system_alerts table (called once at startup). */
export async function initSystemAlerts(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_alerts (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      resolved_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_campaigns (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      budget REAL DEFAULT 0,
      spend REAL DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
}

/** Start the health monitor loop. Default 5 min — overridable via
 *  `WATCHTOWER_INTERVAL_MS` so tests / staging can tighten or loosen it.
 *  One immediate check fires at startup so alerts are not delayed by a full
 *  interval after a deploy or restart. */
export function startHealthMonitor(): void {
  const raw = Number(process.env.WATCHTOWER_INTERVAL_MS);
  const INTERVAL_MS = Number.isFinite(raw) && raw >= 30_000 ? raw : 5 * 60 * 1000;

  // Run once immediately so any issues are detected right after startup.
  runHealthChecks().catch((err) => {
    console.error("[health-monitor] startup check error:", String(err));
  });

  setInterval(async () => {
    try {
      await runHealthChecks();
    } catch (err) {
      console.error("[health-monitor] error:", String(err));
    }
  }, INTERVAL_MS);
}
