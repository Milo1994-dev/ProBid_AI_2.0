import express from "express";
import crypto from "crypto";
import { pool } from "../../db.js";
import { asyncHandler, requireAdminAuth } from "../../lib/middleware.js";
import { isAdminRequest } from "./shared.js";
import { getMrrHistory } from "../../lib/mrr-snapshots.js";
import { log } from "../../lib/logger.js";

const TOKEN_KEY = "investor_link_token";
const APP_NAME = "ProBid AI";

async function q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const r = await pool.query(sql, params);
  return r.rows as Record<string, unknown>[];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function getToken(): Promise<string | null> {
  const rows = await q(`SELECT value FROM lead_outreach_config WHERE key = $1`, [TOKEN_KEY]);
  return rows[0]?.value ? String(rows[0].value) : null;
}

async function setToken(token: string): Promise<void> {
  await pool.query(
    `INSERT INTO lead_outreach_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [TOKEN_KEY, token],
  );
}

async function deleteToken(): Promise<void> {
  await pool.query(`DELETE FROM lead_outreach_config WHERE key = $1`, [TOKEN_KEY]);
}

async function computeInvestorData() {
  const PRO_MONTHLY_PRICE = 25;
  const PRO_ANNUAL_PRICE = 20;
  const BIZ_MONTHLY_PRICE = 55;
  const BIZ_ANNUAL_PRICE = 79;

  const PRICE_PRO = process.env.STRIPE_PRICE_PRO_MONTHLY || "";
  const PRICE_BIZ = process.env.STRIPE_PRICE_BUSINESS_MONTHLY || "";
  const PRICE_PRO_ANNUAL = process.env.STRIPE_PRICE_PRO_ANNUAL || "";
  const PRICE_BIZ_ANNUAL = process.env.STRIPE_PRICE_BUSINESS_ANNUAL || "";

  const priceMap: Record<string, number> = {};
  if (PRICE_PRO) priceMap[PRICE_PRO] = PRO_MONTHLY_PRICE;
  if (PRICE_BIZ) priceMap[PRICE_BIZ] = BIZ_MONTHLY_PRICE;
  if (PRICE_PRO_ANNUAL) priceMap[PRICE_PRO_ANNUAL] = PRO_ANNUAL_PRICE;
  if (PRICE_BIZ_ANNUAL) priceMap[PRICE_BIZ_ANNUAL] = BIZ_ANNUAL_PRICE;

  const nowMs = Date.now();
  const thirtyDaysAgo = nowMs - 30 * 86_400_000;

  const thisMonthStart = new Date();
  thisMonthStart.setUTCDate(1);
  thisMonthStart.setUTCHours(0, 0, 0, 0);
  const lastMonthStart = new Date(thisMonthStart);
  lastMonthStart.setUTCMonth(lastMonthStart.getUTCMonth() - 1);

  const [subRows, canceledRows30, totalUsersRows, mrrLastMonthRows] = await Promise.all([
    q(`SELECT price_id, COUNT(*)::int AS cnt FROM subscriptions WHERE status = 'active' GROUP BY price_id`),
    q(`SELECT COUNT(*)::int AS c FROM subscriptions WHERE status = 'canceled' AND updated_at >= $1`, [thirtyDaysAgo]),
    q(`SELECT COUNT(*)::int AS c FROM users`),
    q(
      `SELECT price_id, COUNT(*)::int AS cnt
       FROM subscriptions
       WHERE (status = 'active' AND updated_at < $1)
          OR (status = 'canceled' AND updated_at >= $1)
       GROUP BY price_id`,
      [thisMonthStart.getTime()],
    ),
  ]);

  const counts: Record<string, number> = {};
  for (const row of subRows) counts[String(row.price_id)] = num(row.cnt);

  const proMonthly = num(counts[PRICE_PRO]);
  const proAnnual = num(counts[PRICE_PRO_ANNUAL]);
  const bizMonthly = num(counts[PRICE_BIZ]);
  const bizAnnual = num(counts[PRICE_BIZ_ANNUAL]);

  const mrr = proMonthly * PRO_MONTHLY_PRICE + proAnnual * PRO_ANNUAL_PRICE + bizMonthly * BIZ_MONTHLY_PRICE + bizAnnual * BIZ_ANNUAL_PRICE;
  const arr = mrr * 12;
  const payingCustomers = proMonthly + proAnnual + bizMonthly + bizAnnual;
  const totalUsers = num(totalUsersRows[0]?.c);
  const canceledLast30 = num(canceledRows30[0]?.c);

  let mrrLastMonth = 0;
  for (const row of mrrLastMonthRows) {
    mrrLastMonth += num(row.cnt) * (priceMap[String(row.price_id)] ?? 0);
  }

  const arpu = payingCustomers > 0 ? mrr / payingCustomers : 0;
  const monthlyChurnRate = payingCustomers + canceledLast30 > 0 ? canceledLast30 / (payingCustomers + canceledLast30) : 0;
  const ltv = monthlyChurnRate > 0 ? arpu / monthlyChurnRate : 0;
  const logoChurn30Pct = payingCustomers + canceledLast30 > 0 ? (canceledLast30 / (payingCustomers + canceledLast30)) * 100 : 0;
  const mrrGrowthMoM = mrrLastMonth > 0 ? ((mrr - mrrLastMonth) / mrrLastMonth) * 100 : null;
  const netNewMrr = mrr - mrrLastMonth;

  const valLow = arr * 3;
  const valMid = arr * 4;
  const valHigh = arr * 5;

  const history = await getMrrHistory(90);

  return {
    generatedAt: new Date().toISOString(),
    mrr,
    arr,
    payingCustomers,
    totalUsers,
    arpu,
    ltv,
    logoChurn30Pct,
    mrrGrowthMoM,
    mrrLastMonth,
    netNewMrr,
    breakdown: { proMonthly, proAnnual, bizMonthly, bizAnnual },
    valuation: { low: valLow, mid: valMid, high: valHigh },
    history,
  };
}

function renderInvestorPage(data: Awaited<ReturnType<typeof computeInvestorData>>, token: string): string {
  const { mrr, arr, payingCustomers, totalUsers, arpu, ltv, logoChurn30Pct, mrrGrowthMoM, netNewMrr, breakdown, valuation, history, generatedAt } = data;

  const growthBadge = mrrGrowthMoM === null
    ? `<span class="badge neutral">No history yet</span>`
    : mrrGrowthMoM >= 0
    ? `<span class="badge green">+${mrrGrowthMoM.toFixed(1)}% MoM</span>`
    : `<span class="badge red">${mrrGrowthMoM.toFixed(1)}% MoM</span>`;

  const churnBadge = logoChurn30Pct < 2
    ? `<span class="badge green">${logoChurn30Pct.toFixed(1)}% / mo</span>`
    : logoChurn30Pct < 5
    ? `<span class="badge yellow">${logoChurn30Pct.toFixed(1)}% / mo</span>`
    : `<span class="badge red">${logoChurn30Pct.toFixed(1)}% / mo</span>`;

  const historyRows = history.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#888;padding:24px">No snapshot history yet — check back tomorrow.</td></tr>`
    : history.map((row, i) => {
        const prev = i > 0 ? history[i - 1].mrr : null;
        const delta = prev !== null ? row.mrr - prev : null;
        const deltaHtml = delta === null
          ? `<td class="num">—</td>`
          : delta >= 0
          ? `<td class="num" style="color:#16a34a">+${fmtUsd(delta)}</td>`
          : `<td class="num" style="color:#dc2626">${fmtUsd(delta)}</td>`;
        return `<tr>
          <td>${row.dayKey}</td>
          <td class="num">${fmtUsd(row.mrr)}</td>
          <td class="num">${fmt(row.payingCustomers)}</td>
          ${deltaHtml}
        </tr>`;
      }).reverse().join("");

  const exportUrl = `/investor/export?token=${encodeURIComponent(token)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${APP_NAME} — Investor Overview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #0f172a; min-height: 100vh; }
    .header { background: #0f172a; color: #fff; padding: 28px 40px; display: flex; justify-content: space-between; align-items: center; }
    .header-left h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.01em; }
    .header-left p { color: #94a3b8; font-size: 0.85rem; margin-top: 4px; }
    .header-right { display: flex; gap: 12px; align-items: center; }
    .export-btn { background: #1e40af; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-size: 0.85rem; cursor: pointer; text-decoration: none; font-weight: 500; }
    .export-btn:hover { background: #1d4ed8; }
    .confidential { font-size: 0.75rem; color: #64748b; background: #1e293b; padding: 4px 10px; border-radius: 4px; }
    .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
    .section-title { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 14px; margin-top: 36px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px 24px; }
    .card .label { font-size: 0.75rem; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .card .value { font-size: 2rem; font-weight: 700; color: #0f172a; margin-top: 6px; letter-spacing: -0.02em; }
    .card .sub { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }
    .card .badge-wrap { margin-top: 8px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .badge.green { background: #dcfce7; color: #16a34a; }
    .badge.red { background: #fee2e2; color: #dc2626; }
    .badge.yellow { background: #fef9c3; color: #ca8a04; }
    .badge.neutral { background: #f1f5f9; color: #64748b; }
    .val-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; display: flex; gap: 0; overflow: hidden; }
    .val-tier { flex: 1; padding: 0 24px; text-align: center; border-right: 1px solid #e2e8f0; }
    .val-tier:last-child { border-right: none; }
    .val-tier .tier-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; }
    .val-tier .tier-value { font-size: 1.8rem; font-weight: 700; margin-top: 8px; color: #0f172a; }
    .val-tier.mid .tier-value { color: #1d4ed8; font-size: 2.2rem; }
    .val-tier .tier-sub { font-size: 0.75rem; color: #94a3b8; margin-top: 4px; }
    .note { font-size: 0.75rem; color: #94a3b8; margin-top: 10px; }
    .breakdown-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .breakdown-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; }
    .breakdown-card .b-label { font-size: 0.7rem; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
    .breakdown-card .b-value { font-size: 1.4rem; font-weight: 700; color: #0f172a; margin-top: 4px; }
    .breakdown-card .b-sub { font-size: 0.75rem; color: #94a3b8; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
    thead { background: #f8fafc; }
    th { text-align: left; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; }
    td { padding: 11px 16px; font-size: 0.875rem; border-bottom: 1px solid #f1f5f9; color: #334155; }
    tr:last-child td { border-bottom: none; }
    .num { font-variant-numeric: tabular-nums; }
    .footer { text-align: center; padding: 32px; font-size: 0.75rem; color: #94a3b8; }
    @media (max-width: 600px) {
      .header { flex-direction: column; gap: 12px; padding: 20px; }
      .val-box { flex-direction: column; }
      .val-tier { border-right: none; border-bottom: 1px solid #e2e8f0; padding: 16px 0; }
      .val-tier:last-child { border-bottom: none; }
      .breakdown-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>${APP_NAME} &mdash; Investor Overview</h1>
      <p>Generated ${new Date(generatedAt).toUTCString()} &nbsp;·&nbsp; Confidential</p>
    </div>
    <div class="header-right">
      <span class="confidential">Confidential</span>
      <a href="${exportUrl}" class="export-btn">Export JSON</a>
    </div>
  </div>

  <div class="container">
    <div class="section-title">Core SaaS Metrics</div>
    <div class="cards">
      <div class="card">
        <div class="label">MRR</div>
        <div class="value">${fmtUsd(mrr)}</div>
        <div class="sub">Monthly Recurring Revenue</div>
        <div class="badge-wrap">${growthBadge}</div>
      </div>
      <div class="card">
        <div class="label">ARR</div>
        <div class="value">${fmtUsd(arr)}</div>
        <div class="sub">Annual Run Rate</div>
      </div>
      <div class="card">
        <div class="label">Paying Customers</div>
        <div class="value">${fmt(payingCustomers)}</div>
        <div class="sub">${fmt(totalUsers)} total registered users</div>
      </div>
      <div class="card">
        <div class="label">ARPU</div>
        <div class="value">${fmtUsd(arpu)}</div>
        <div class="sub">Avg Revenue / Customer / Mo</div>
      </div>
      <div class="card">
        <div class="label">LTV (Est.)</div>
        <div class="value">${ltv > 0 ? fmtUsd(ltv) : '—'}</div>
        <div class="sub">Based on current churn rate</div>
      </div>
      <div class="card">
        <div class="label">Logo Churn</div>
        <div class="value">${logoChurn30Pct.toFixed(1)}%</div>
        <div class="sub">30-day customer churn</div>
        <div class="badge-wrap">${churnBadge}</div>
      </div>
      <div class="card">
        <div class="label">Net New MRR</div>
        <div class="value">${netNewMrr >= 0 ? '+' : ''}${fmtUsd(netNewMrr)}</div>
        <div class="sub">vs. start of this month</div>
      </div>
    </div>

    <div class="section-title">Valuation Range (ARR Multiple)</div>
    <div class="val-box">
      <div class="val-tier">
        <div class="tier-label">Conservative &nbsp; 3× ARR</div>
        <div class="tier-value">${fmtUsd(valuation.low)}</div>
        <div class="tier-sub">Floor — high churn / early traction</div>
      </div>
      <div class="val-tier mid">
        <div class="tier-label">Base Case &nbsp; 4× ARR</div>
        <div class="tier-value">${fmtUsd(valuation.mid)}</div>
        <div class="tier-sub">Moderate growth, SaaS norms</div>
      </div>
      <div class="val-tier">
        <div class="tier-label">Optimistic &nbsp; 5× ARR</div>
        <div class="tier-value">${fmtUsd(valuation.high)}</div>
        <div class="tier-sub">Strong growth + low churn</div>
      </div>
    </div>
    <p class="note">* Valuation multiples are typical for early-stage vertical SaaS. Actual value depends on growth rate, churn, team, and market size.</p>

    <div class="section-title">Subscriber Breakdown</div>
    <div class="breakdown-grid">
      <div class="breakdown-card">
        <div class="b-label">Pro Monthly</div>
        <div class="b-value">${fmt(breakdown.proMonthly)}</div>
        <div class="b-sub">$${PRO_MONTHLY_PRICE}/mo each</div>
      </div>
      <div class="breakdown-card">
        <div class="b-label">Pro Annual</div>
        <div class="b-value">${fmt(breakdown.proAnnual)}</div>
        <div class="b-sub">$${PRO_ANNUAL_PRICE}/mo equiv.</div>
      </div>
      <div class="breakdown-card">
        <div class="b-label">Business Monthly</div>
        <div class="b-value">${fmt(breakdown.bizMonthly)}</div>
        <div class="b-sub">$${BIZ_MONTHLY_PRICE}/mo each</div>
      </div>
      <div class="breakdown-card">
        <div class="b-label">Business Annual</div>
        <div class="b-value">${fmt(breakdown.bizAnnual)}</div>
        <div class="b-sub">$${BIZ_ANNUAL_PRICE}/mo equiv.</div>
      </div>
    </div>

    <div class="section-title">MRR History (Last 90 Days)</div>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>MRR</th>
          <th>Customers</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
        ${historyRows}
      </tbody>
    </table>
  </div>

  <div class="footer">
    This document is confidential and intended solely for the recipient. &copy; ${new Date().getFullYear()} ${APP_NAME}.
  </div>
</body>
</html>`;
}

const PRO_MONTHLY_PRICE = 25;
const PRO_ANNUAL_PRICE = 20;
const BIZ_MONTHLY_PRICE = 55;
const BIZ_ANNUAL_PRICE = 79;

export function registerInvestorRoutes(app: express.Application): void {
  app.get(
    "/api/admin/investor-link",
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const token = await getToken();
      const baseUrl = process.env.REPLIT_DEPLOYMENT === "1"
        ? "https://probidcore.net"
        : process.env.APP_URL || "http://localhost:5000";
      res.json({
        success: true,
        data: {
          active: Boolean(token),
          url: token ? `${baseUrl}/investor?token=${token}` : null,
        },
      });
    }),
  );

  app.post(
    "/api/admin/investor-link",
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const token = crypto.randomBytes(24).toString("hex");
      await setToken(token);
      const baseUrl = process.env.REPLIT_DEPLOYMENT === "1"
        ? "https://probidcore.net"
        : process.env.APP_URL || "http://localhost:5000";
      log("info", "Investor link generated");
      res.json({
        success: true,
        data: { url: `${baseUrl}/investor?token=${token}` },
      });
    }),
  );

  app.delete(
    "/api/admin/investor-link",
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      await deleteToken();
      log("info", "Investor link revoked");
      res.json({ success: true });
    }),
  );

  app.get(
    "/investor",
    asyncHandler(async (req, res) => {
      const providedToken = req.query.token as string | undefined;
      if (!providedToken) {
        return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Access Denied</h2><p>This page requires a valid investor link.</p></body></html>`);
      }
      const storedToken = await getToken();
      if (!storedToken) {
        return res.status(403).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Link Not Active</h2><p>No investor link is currently active.</p></body></html>`);
      }
      const a = Buffer.from(providedToken, "utf8");
      const b = Buffer.from(storedToken, "utf8");
      const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!valid) {
        return res.status(403).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Invalid Link</h2><p>This investor link is invalid or has been revoked.</p></body></html>`);
      }
      const data = await computeInvestorData();
      res.set("Cache-Control", "no-store").send(renderInvestorPage(data, providedToken));
    }),
  );

  app.get(
    "/investor/export",
    asyncHandler(async (req, res) => {
      const providedToken = req.query.token as string | undefined;
      if (!providedToken) return res.status(401).json({ success: false, error: "Token required" });
      const storedToken = await getToken();
      if (!storedToken) return res.status(403).json({ success: false, error: "No active investor link" });
      const a = Buffer.from(providedToken, "utf8");
      const b = Buffer.from(storedToken, "utf8");
      const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!valid) return res.status(403).json({ success: false, error: "Invalid token" });
      const data = await computeInvestorData();
      const dateStr = new Date().toISOString().slice(0, 10);
      res
        .set("Content-Type", "application/json")
        .set("Content-Disposition", `attachment; filename="probidai-investor-${dateStr}.json"`)
        .set("Cache-Control", "no-store")
        .send(JSON.stringify({ exportedAt: data.generatedAt, ...data }, null, 2));
    }),
  );
}
