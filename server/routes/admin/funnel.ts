import express from "express";
import { pool } from "../../db.js";
import { asyncHandler, requireAdminAuthPage } from "../../lib/middleware.js";
import { isAdminRequest } from "./shared.js";

const DAY_MS = 86_400_000;

type Row = Record<string, string | number | null>;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const r = await pool.query(sql, params);
  return r.rows as Row[];
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(numerator: number, denominator: number): string {
  if (!denominator) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

async function loadFunnel(windowDays: number) {
  const now = Date.now();
  const cutoff = now - windowDays * DAY_MS;

  const [
    signupRows,
    activatedRows,
    paidRows,
    estimateRows,
    subRows,
    daily,
    outreachRows,
    homepageLeadRows,
    trialRows,
  ] = await Promise.all([
    q(`SELECT COUNT(*)::int AS c FROM users WHERE created_at >= $1`, [cutoff]),
    q(
      `SELECT COUNT(DISTINCT u.id)::int AS c
         FROM users u
         JOIN estimates e ON e.user_id = u.id
        WHERE u.created_at >= $1`,
      [cutoff],
    ),
    q(
      `SELECT COUNT(DISTINCT u.id)::int AS c
         FROM users u
         JOIN subscriptions s ON s.user_id = u.id
         JOIN estimates e ON e.user_id = u.id
        WHERE u.created_at >= $1
          AND s.status IN ('active','trialing')`,
      [cutoff],
    ),
    q(`SELECT COUNT(*)::int AS c FROM estimates WHERE created_at >= $1`, [cutoff]),
    q(
      `SELECT
         COUNT(*) FILTER (WHERE status='active')::int   AS active,
         COUNT(*) FILTER (WHERE status='trialing')::int AS trialing,
         COUNT(*) FILTER (WHERE status='canceled')::int AS canceled,
         COUNT(*) FILTER (WHERE status='past_due')::int AS past_due,
         COUNT(*)::int                                  AS total
         FROM subscriptions`,
    ),
    q(
      `WITH days AS (
         SELECT generate_series(0, $1::int - 1) AS d
       )
       SELECT
         d AS days_ago,
         (
           SELECT COUNT(*)::int FROM users u
            WHERE u.created_at >= ($2::bigint - (d + 1) * $3::bigint)
              AND u.created_at <  ($2::bigint - d * $3::bigint)
         ) AS signups,
         (
           SELECT COUNT(*)::int FROM estimates e
            WHERE e.created_at >= ($2::bigint - (d + 1) * $3::bigint)
              AND e.created_at <  ($2::bigint - d * $3::bigint)
         ) AS estimates
       FROM days
       ORDER BY days_ago ASC`,
      [windowDays, now, DAY_MS],
    ),
    q(
      `SELECT
         COUNT(*) FILTER (WHERE status='pending')::int     AS pending,
         COUNT(*) FILTER (WHERE status='sent')::int        AS sent,
         COUNT(*) FILTER (WHERE status='replied')::int     AS replied,
         COUNT(*) FILTER (WHERE status='bounced')::int     AS bounced,
         COUNT(*) FILTER (WHERE status='unsubscribed')::int AS unsubscribed,
         COUNT(*)::int                                     AS total
         FROM lead_outreach_queue`,
    ).catch(() => [{ pending: 0, sent: 0, replied: 0, bounced: 0, unsubscribed: 0, total: 0 } as Row]),
    q(
      `SELECT COUNT(*)::int AS c FROM homepage_leads WHERE created_at >= $1`,
      [cutoff],
    ).catch(() => [{ c: 0 } as Row]),
    // Trial lifecycle counts (within window) — emitted by the Stripe webhook
    // as distinct analytics events: trial_started / trial_converted /
    // trial_cancelled. trial_will_end is a reminder send, not a conversion
    // step, so we don't surface it as a funnel stage.
    q(
      `SELECT
         COUNT(*) FILTER (WHERE event = 'trial_started')::int   AS started,
         COUNT(*) FILTER (WHERE event = 'trial_converted')::int AS converted,
         COUNT(*) FILTER (WHERE event = 'trial_cancelled')::int AS cancelled,
         COUNT(*) FILTER (WHERE event = 'trial_will_end')::int  AS will_end
         FROM analytics
        WHERE created_at >= $1
          AND event IN ('trial_started','trial_converted','trial_cancelled','trial_will_end')`,
      [cutoff],
    ).catch(() => [{ started: 0, converted: 0, cancelled: 0, will_end: 0 } as Row]),
  ]);

  return {
    signups: num(signupRows[0]?.c),
    activated: num(activatedRows[0]?.c),
    paid: num(paidRows[0]?.c),
    estimates: num(estimateRows[0]?.c),
    subs: {
      active: num(subRows[0]?.active),
      trialing: num(subRows[0]?.trialing),
      canceled: num(subRows[0]?.canceled),
      past_due: num(subRows[0]?.past_due),
      total: num(subRows[0]?.total),
    },
    daily: daily.map((r) => ({
      daysAgo: num(r.days_ago),
      signups: num(r.signups),
      estimates: num(r.estimates),
    })),
    outreach: {
      pending: num(outreachRows[0]?.pending),
      sent: num(outreachRows[0]?.sent),
      replied: num(outreachRows[0]?.replied),
      bounced: num(outreachRows[0]?.bounced),
      unsubscribed: num(outreachRows[0]?.unsubscribed),
      total: num(outreachRows[0]?.total),
    },
    homepageLeads: num(homepageLeadRows[0]?.c),
    trial: {
      started: num(trialRows[0]?.started),
      converted: num(trialRows[0]?.converted),
      cancelled: num(trialRows[0]?.cancelled),
      willEnd: num(trialRows[0]?.will_end),
    },
  };
}

function renderHtml(
  windowDays: number,
  data: Awaited<ReturnType<typeof loadFunnel>>,
): string {
  const { signups, activated, paid, estimates, subs, daily, outreach, homepageLeads, trial } = data;
  // Use resolved trials (converted + cancelled) as the denominator instead
  // of trials started in the same window. A trial started today won't
  // resolve for 7 days, so dividing by trial.started produces misleading
  // rates (and can exceed 100% in short windows when a trial started
  // before the window converts inside it).
  const resolvedTrials = trial.converted + trial.cancelled;
  const trialConversionRate = pct(trial.converted, resolvedTrials);
  const trialCancelRate = pct(trial.cancelled, resolvedTrials);
  const activationRate = pct(activated, signups);
  const paidRate = pct(paid, signups);
  const activatedToPaid = pct(paid, activated);

  const maxBar = Math.max(1, ...daily.map((d) => Math.max(d.signups, d.estimates)));
  const sparkSignups = daily
    .slice()
    .reverse()
    .map((d) => {
      const h = Math.round((d.signups / maxBar) * 60);
      return `<div class="spark" style="height:${Math.max(h, d.signups > 0 ? 4 : 1)}px;background:${d.signups > 0 ? "#22c55e" : "#1f2937"};" title="${d.signups} signup(s) ${d.daysAgo}d ago"></div>`;
    })
    .join("");
  const sparkEstimates = daily
    .slice()
    .reverse()
    .map((d) => {
      const h = Math.round((d.estimates / maxBar) * 60);
      return `<div class="spark" style="height:${Math.max(h, d.estimates > 0 ? 4 : 1)}px;background:${d.estimates > 0 ? "#6366f1" : "#1f2937"};" title="${d.estimates} estimate(s) ${d.daysAgo}d ago"></div>`;
    })
    .join("");

  const winLink = (d: number) => `/admin/funnel?window=${d}`;
  const isWin = (d: number) => (windowDays === d ? "active" : "");

  const interpretation =
    signups < 20
      ? `<strong>Sample is too small to draw conversion conclusions.</strong> Funnel rates below are directional only — wait for at least 20–50 signups in the window before optimizing copy or pricing.`
      : signups < 100
        ? `Sample is small but usable. Watch for trends, not absolute rates.`
        : `Sample size is healthy. Conversion rates are meaningful — investigate any stage that drops more than 50% week-over-week.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Funnel — ProBid AI Admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; background:#0a0e1a; color:#e8f0ff; padding:24px; line-height:1.5; }
  h1 { font-size:22px; margin:0 0 4px; font-weight:800; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:0.08em; color:#94a3b8; margin:32px 0 12px; font-weight:700; }
  .sub { color:#94a3b8; font-size:13px; margin:0 0 24px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  .pill { padding:6px 12px; border-radius:999px; background:#121a2a; color:#94a3b8; font-size:13px; text-decoration:none; border:1px solid #1f2937; }
  .pill.active { background:#22c55e; color:#0a0e1a; border-color:#22c55e; font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .card { background:#121a2a; border:1px solid #1f2937; border-radius:12px; padding:18px; }
  .card .label { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#94a3b8; margin-bottom:8px; font-weight:600; }
  .card .value { font-size:28px; font-weight:800; color:#e8f0ff; }
  .card .meta { font-size:12px; color:#64748b; margin-top:4px; }
  .funnel { display:flex; flex-direction:column; gap:8px; max-width:640px; }
  .funnel .stage { background:#121a2a; border:1px solid #1f2937; border-radius:10px; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .funnel .stage-label { font-weight:600; }
  .funnel .stage-num { font-variant-numeric:tabular-nums; }
  .funnel .stage-bar { flex:1; height:8px; background:#1f2937; border-radius:999px; overflow:hidden; max-width:280px; }
  .funnel .stage-bar-fill { height:100%; background:linear-gradient(90deg,#22c55e,#6366f1); }
  .funnel .drop { font-size:11px; color:#ef4444; padding-left:16px; font-style:italic; }
  .spark-row { display:flex; align-items:flex-end; gap:2px; height:64px; padding:8px 0; }
  .spark { flex:1; min-width:4px; border-radius:2px 2px 0 0; }
  .spark-legend { display:flex; gap:16px; font-size:12px; color:#94a3b8; margin-top:4px; }
  .spark-dot { display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:middle; margin-right:6px; }
  .interp { background:#1e293b; border-left:3px solid #f59e0b; padding:12px 16px; border-radius:6px; font-size:13px; margin:16px 0 24px; color:#cbd5e1; }
  .interp strong { color:#fbbf24; }
  table { width:100%; border-collapse:collapse; background:#121a2a; border-radius:12px; overflow:hidden; }
  table th, table td { padding:10px 14px; text-align:left; font-size:13px; border-bottom:1px solid #1f2937; }
  table th { background:#0f172a; color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.06em; }
  a { color:#22c55e; }
  .nav { margin-bottom:24px; font-size:13px; }
  .nav a { color:#94a3b8; margin-right:14px; text-decoration:none; }
  .nav a:hover { color:#e8f0ff; }
</style>
</head>
<body>
  <div class="nav">
    <a href="/admin">← Admin home</a>
  </div>

  <h1>Conversion Funnel</h1>
  <p class="sub">Live signup → activation → paid conversion. Refresh anytime.</p>

  <div class="row">
    <a class="pill ${isWin(7)}" href="${winLink(7)}">Last 7 days</a>
    <a class="pill ${isWin(30)}" href="${winLink(30)}">Last 30 days</a>
    <a class="pill ${isWin(90)}" href="${winLink(90)}">Last 90 days</a>
    <a class="pill ${isWin(365)}" href="${winLink(365)}">Last 365 days</a>
  </div>

  <div class="interp">${interpretation}</div>

  <h2>Headline</h2>
  <div class="grid">
    <div class="card"><div class="label">Signups (window)</div><div class="value">${fmtInt(signups)}</div></div>
    <div class="card"><div class="label">Activated</div><div class="value">${fmtInt(activated)}</div><div class="meta">${activationRate} of signups made ≥1 estimate</div></div>
    <div class="card"><div class="label">Paid (active or trialing)</div><div class="value">${fmtInt(paid)}</div><div class="meta">${paidRate} of signups → ${activatedToPaid} of activated</div></div>
    <div class="card"><div class="label">Estimates created</div><div class="value">${fmtInt(estimates)}</div></div>
  </div>

  <h2>Funnel (window: last ${windowDays} days)</h2>
  <div class="funnel">
    <div class="stage">
      <span class="stage-label">1. Signup</span>
      <div class="stage-bar"><div class="stage-bar-fill" style="width:100%"></div></div>
      <span class="stage-num">${fmtInt(signups)}</span>
    </div>
    <div class="stage">
      <span class="stage-label">2. Created first estimate</span>
      <div class="stage-bar"><div class="stage-bar-fill" style="width:${signups ? Math.round((activated / signups) * 100) : 0}%"></div></div>
      <span class="stage-num">${fmtInt(activated)} <span style="color:#94a3b8;font-weight:400;font-size:12px;">(${activationRate})</span></span>
    </div>
    <div class="stage">
      <span class="stage-label">3. Active or trialing subscription</span>
      <div class="stage-bar"><div class="stage-bar-fill" style="width:${signups ? Math.round((paid / signups) * 100) : 0}%"></div></div>
      <span class="stage-num">${fmtInt(paid)} <span style="color:#94a3b8;font-weight:400;font-size:12px;">(${paidRate})</span></span>
    </div>
  </div>

  <h2>Daily activity (last ${windowDays} days, oldest → newest)</h2>
  <div class="card">
    <div class="spark-row">${sparkSignups}</div>
    <div class="spark-row">${sparkEstimates}</div>
    <div class="spark-legend">
      <span><span class="spark-dot" style="background:#22c55e"></span>Signups per day</span>
      <span><span class="spark-dot" style="background:#6366f1"></span>Estimates per day</span>
    </div>
  </div>

  <h2>Trial conversion (last ${windowDays} days)</h2>
  <div class="grid">
    <div class="card"><div class="label">Trials started</div><div class="value">${fmtInt(trial.started)}</div><div class="meta">7-day free trials kicked off</div></div>
    <div class="card"><div class="label">Trials converted</div><div class="value">${fmtInt(trial.converted)}</div><div class="meta">${trialConversionRate} of resolved trials became paid</div></div>
    <div class="card"><div class="label">Trials cancelled</div><div class="value">${fmtInt(trial.cancelled)}</div><div class="meta">${trialCancelRate} of resolved trials cancelled</div></div>
    <div class="card"><div class="label">Trial-end reminders sent</div><div class="value">${fmtInt(trial.willEnd)}</div><div class="meta">Stripe trial_will_end webhook (~3 days before charge)</div></div>
  </div>

  <h2>Subscription state (all-time snapshot)</h2>
  <table>
    <thead><tr><th>Status</th><th>Count</th></tr></thead>
    <tbody>
      <tr><td>Active</td><td>${fmtInt(subs.active)}</td></tr>
      <tr><td>Trialing</td><td>${fmtInt(subs.trialing)}</td></tr>
      <tr><td>Past due</td><td>${fmtInt(subs.past_due)}</td></tr>
      <tr><td>Canceled</td><td>${fmtInt(subs.canceled)}</td></tr>
      <tr><td><strong>Total ever subscribed</strong></td><td><strong>${fmtInt(subs.total)}</strong></td></tr>
    </tbody>
  </table>

  <h2>Outreach pipeline (all-time snapshot)</h2>
  <table>
    <thead><tr><th>Status</th><th>Count</th></tr></thead>
    <tbody>
      <tr><td>Pending in queue</td><td>${fmtInt(outreach.pending)}</td></tr>
      <tr><td>Sent</td><td>${fmtInt(outreach.sent)}</td></tr>
      <tr><td>Replied</td><td>${fmtInt(outreach.replied)} <span style="color:#94a3b8;">(${pct(outreach.replied, outreach.sent)} of sent)</span></td></tr>
      <tr><td>Bounced</td><td>${fmtInt(outreach.bounced)} <span style="color:#94a3b8;">(${pct(outreach.bounced, outreach.sent)} of sent)</span></td></tr>
      <tr><td>Unsubscribed</td><td>${fmtInt(outreach.unsubscribed)}</td></tr>
      <tr><td><strong>Total contacts</strong></td><td><strong>${fmtInt(outreach.total)}</strong></td></tr>
    </tbody>
  </table>

  <h2>Homepage lead capture (last ${windowDays} days)</h2>
  <div class="grid">
    <div class="card"><div class="label">Homepage leads captured</div><div class="value">${fmtInt(homepageLeads)}</div><div class="meta">Visitors who submitted email on the marketing site</div></div>
  </div>

  <p class="sub" style="margin-top:32px;">Generated ${new Date().toISOString()}</p>
</body>
</html>`;
}

export function registerAdminFunnelRoutes(app: express.Application): void {
  app.get(
    "/admin/funnel",
    requireAdminAuthPage,
    asyncHandler(async (req, res) => {
      const requested = Number(req.query.window);
      const windowDays = [7, 30, 90, 365].includes(requested) ? requested : 30;

      const data = await loadFunnel(windowDays);
      res
        .status(200)
        .set("Cache-Control", "no-store")
        .send(renderHtml(windowDays, data));
    }),
  );

  app.get(
    "/api/admin/funnel",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Forbidden" });
      const requested = Number(req.query.window);
      const windowDays = [7, 30, 90, 365].includes(requested) ? requested : 30;
      const data = await loadFunnel(windowDays);
      res.json({ success: true, windowDays, data });
    }),
  );
}
