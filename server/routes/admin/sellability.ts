import express from "express";
import { pool } from "../../db.js";
import { asyncHandler, requireAdminAuth } from "../../lib/middleware.js";
import { PRICE_PRO, PRICE_BIZ, PRICE_PRO_ANNUAL, PRICE_BIZ_ANNUAL } from "./shared.js";

const PRO_MONTHLY_PRICE = 25;
const PRO_ANNUAL_PRICE = 20;
const BIZ_MONTHLY_PRICE = 55;
const BIZ_ANNUAL_PRICE = 79;

const AI_COST_KEY = "sellability:ai_cost_per_estimate";
const DEFAULT_AI_COST = 0.05;

async function q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const r = await pool.query(sql, params);
  return r.rows as Record<string, unknown>[];
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(n: number, d: number): number {
  if (!d) return 0;
  return (n / d) * 100;
}

async function getAiCostPerEstimate(): Promise<number> {
  const rows = await q(
    `SELECT value FROM lead_outreach_config WHERE key = $1`,
    [AI_COST_KEY],
  );
  if (rows[0]?.value != null) return num(rows[0].value);
  return DEFAULT_AI_COST;
}

async function setAiCostPerEstimate(cost: number): Promise<void> {
  await pool.query(
    `INSERT INTO lead_outreach_config (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [AI_COST_KEY, String(cost)],
  );
}

function monthStart(monthsBack: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return d.toISOString().slice(0, 10);
}

function dateToMs(dateStr: string): number {
  return new Date(dateStr).getTime();
}

async function computeSellability() {
  const nowMs = Date.now();
  const DAY_MS = 86_400_000;
  const sevenDaysAgo = nowMs - 7 * DAY_MS;
  const thirtyDaysAgo = nowMs - 30 * DAY_MS;
  const ninetyDaysAgo = nowMs - 90 * DAY_MS;

  const thisMonth = monthStart(0);
  const lastMonth = monthStart(1);
  const threeMonthsAgo = monthStart(3);
  const sixMonthsAgo = monthStart(6);

  const thisMonthMs = dateToMs(thisMonth);
  const lastMonthMs = dateToMs(lastMonth);

  const priceMap: Record<string, number> = {};
  if (PRICE_PRO) priceMap[PRICE_PRO] = PRO_MONTHLY_PRICE;
  if (PRICE_BIZ) priceMap[PRICE_BIZ] = BIZ_MONTHLY_PRICE;
  if (PRICE_PRO_ANNUAL) priceMap[PRICE_PRO_ANNUAL] = PRO_ANNUAL_PRICE;
  if (PRICE_BIZ_ANNUAL) priceMap[PRICE_BIZ_ANNUAL] = BIZ_ANNUAL_PRICE;

  const [
    subRows,
    canceledThisMonth,
    canceledLastMonth,
    canceledRows30,
    canceledRows90,
    estimatesThisMonth,
    estimatesLastMonth,
    openAlerts,
    failedJobRuns,
    emailsThisMonth,
    subscriberMrrRows,
  ] = await Promise.all([
    q(`SELECT price_id, COUNT(*)::int AS cnt FROM subscriptions WHERE status = 'active' GROUP BY price_id`),
    q(`SELECT price_id, COUNT(*)::int AS cnt FROM subscriptions WHERE status = 'canceled' AND updated_at >= $1 GROUP BY price_id`, [thisMonthMs]),
    q(`SELECT price_id, COUNT(*)::int AS cnt FROM subscriptions WHERE status = 'canceled' AND updated_at >= $1 AND updated_at < $2 GROUP BY price_id`, [lastMonthMs, thisMonthMs]),
    q(`SELECT COUNT(*)::int AS c FROM subscriptions WHERE status = 'canceled' AND updated_at >= $1`, [thirtyDaysAgo]),
    q(`SELECT COUNT(*)::int AS c FROM subscriptions WHERE status = 'canceled' AND updated_at >= $1`, [ninetyDaysAgo]),
    q(`SELECT COALESCE(SUM(estimates_count),0)::int AS c FROM usage WHERE day_key >= $1`, [thisMonth]),
    q(`SELECT COALESCE(SUM(estimates_count),0)::int AS c FROM usage WHERE day_key >= $1 AND day_key < $2`, [lastMonth, thisMonth]),
    q(`SELECT COUNT(*)::int AS c FROM system_alerts WHERE resolved_at IS NULL`),
    q(`SELECT job_name, COUNT(*)::int AS cnt FROM job_runs WHERE status = 'failed' AND started_at >= $1 GROUP BY job_name ORDER BY cnt DESC`, [sevenDaysAgo]),
    q(`SELECT COUNT(*)::int AS c FROM lead_email_audit_log WHERE sent_at >= $1`, [new Date(thisMonthMs).toISOString()]),
    q(`SELECT user_id, price_id FROM subscriptions WHERE status = 'active'`),
  ]);

  // Subscription-derived MRR snapshot at a past cutoff.
  // A subscription was definitely "active at cutoff" if it is currently
  // active AND was last touched before the cutoff (so its state hasn't
  // changed since), OR it is currently canceled but was canceled AFTER the
  // cutoff (i.e. it was still active at the cutoff). This is a *floor* on
  // past MRR — it undercounts subs whose `updated_at` was bumped within
  // the window for non-cancel reasons (renewals, plan changes), so derived
  // growth is an upper bound. It's still a real subscription-revenue
  // signal, not a usage proxy.
  async function mrrAt(cutoffMs: number): Promise<number> {
    const rows = await q(
      `SELECT price_id, COUNT(*)::int AS cnt
         FROM subscriptions
        WHERE (status = 'active' AND updated_at < $1)
           OR (status = 'canceled' AND updated_at >= $1)
        GROUP BY price_id`,
      [cutoffMs],
    );
    let total = 0;
    for (const row of rows) total += num(row.cnt) * (priceMap[String(row.price_id)] ?? 0);
    return total;
  }
  const [mrrLastMonthStart, mrrThreeMoAgo, mrrSixMoAgo] = await Promise.all([
    mrrAt(thisMonthMs),
    mrrAt(dateToMs(threeMonthsAgo)),
    mrrAt(dateToMs(sixMonthsAgo)),
  ]);

  const subCounts: Record<string, number> = {};
  for (const row of subRows) subCounts[String(row.price_id)] = num(row.cnt);

  const proMonthly = num(subCounts[PRICE_PRO]);
  const proAnnual = num(subCounts[PRICE_PRO_ANNUAL]);
  const bizMonthly = num(subCounts[PRICE_BIZ]);
  const bizAnnual = num(subCounts[PRICE_BIZ_ANNUAL]);
  const mrr = proMonthly * PRO_MONTHLY_PRICE + proAnnual * PRO_ANNUAL_PRICE + bizMonthly * BIZ_MONTHLY_PRICE + bizAnnual * BIZ_ANNUAL_PRICE;
  const arr = mrr * 12;
  const payingCustomers = proMonthly + proAnnual + bizMonthly + bizAnnual;

  const sumChurnedMrr = (rows: Record<string, unknown>[]): number => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.price_id)] = num(row.cnt);
    return (num(counts[PRICE_PRO]) * PRO_MONTHLY_PRICE) +
      (num(counts[PRICE_PRO_ANNUAL]) * PRO_ANNUAL_PRICE) +
      (num(counts[PRICE_BIZ]) * BIZ_MONTHLY_PRICE) +
      (num(counts[PRICE_BIZ_ANNUAL]) * BIZ_ANNUAL_PRICE);
  };
  const churnedMrrThisMonth = sumChurnedMrr(canceledThisMonth);
  const churnedMrrLastMonth = sumChurnedMrr(canceledLastMonth);

  const subscriberMrrs: number[] = subscriberMrrRows
    .map((row) => priceMap[String(row.price_id)] ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => b - a);

  const totalMrr = subscriberMrrs.reduce((a, b) => a + b, 0) || 1;
  const top1Pct = subscriberMrrs.length > 0 ? pct(subscriberMrrs[0], totalMrr) : 0;
  const top3Sum = subscriberMrrs.slice(0, 3).reduce((a, b) => a + b, 0);
  const top3Pct = pct(top3Sum, totalMrr);
  const top5Sum = subscriberMrrs.slice(0, 5).reduce((a, b) => a + b, 0);
  const top5Pct = pct(top5Sum, totalMrr);

  const canceled30 = num(canceledRows30[0]?.c);
  const canceled90 = num(canceledRows90[0]?.c);
  const logoChurn30 = payingCustomers + canceled30 > 0 ? pct(canceled30, payingCustomers + canceled30) : 0;
  const logoChurn90 = payingCustomers + canceled90 > 0 ? pct(canceled90, payingCustomers + canceled90) : 0;
  const avgMrr = payingCustomers > 0 ? mrr / payingCustomers : 0;
  const revChurn30 = mrr + canceled30 * avgMrr > 0 ? pct(canceled30 * avgMrr, mrr + canceled30 * avgMrr) : 0;
  const revChurn90 = mrr + canceled90 * avgMrr > 0 ? pct(canceled90 * avgMrr, mrr + canceled90 * avgMrr) : 0;

  const arpu = payingCustomers > 0 ? mrr / payingCustomers : 0;
  const monthlyChurnRate = payingCustomers + canceled30 > 0 ? canceled30 / (payingCustomers + canceled30) : 0;
  const ltv = monthlyChurnRate > 0 ? arpu / monthlyChurnRate : 0;

  const estimatesThisMonthCount = num(estimatesThisMonth[0]?.c);
  const estimatesLastMonthCount = num(estimatesLastMonth[0]?.c);

  const mrrGrowthMoMPct = mrrLastMonthStart > 0 ? pct(mrr - mrrLastMonthStart, mrrLastMonthStart) : null;
  const mrrGrowth3MoPct = mrrThreeMoAgo > 0 ? pct(mrr - mrrThreeMoAgo, mrrThreeMoAgo) : null;
  const mrrGrowth6MoPct = mrrSixMoAgo > 0 ? pct(mrr - mrrSixMoAgo, mrrSixMoAgo) : null;
  const netNewMrrThisMonth = mrr - mrrLastMonthStart;

  const aiCostPerEstimate = await getAiCostPerEstimate();
  const aiCostThisMonth = estimatesThisMonthCount * aiCostPerEstimate;
  const emailsThisMonthCount = num(emailsThisMonth[0]?.c);
  const estimatedGrossMarginPct = mrr > 0 ? pct(mrr - aiCostThisMonth, mrr) : 0;

  const openAlertsCount = num(openAlerts[0]?.c);
  const failedJobRunsList = failedJobRuns.map((r) => ({ jobName: String(r.job_name), count: num(r.cnt) }));
  const totalFailedRuns = failedJobRunsList.reduce((a, b) => a + b.count, 0);

  const hasBounceWebhook = Boolean(
    process.env.RESEND_WEBHOOK_SECRET ||
    process.env.RESEND_WEBHOOK_SIGNING_SECRET ||
    process.env.WEBHOOK_SIGNING_SECRET,
  );

  const growthScoreSource = mrrGrowthMoMPct ?? 0;
  const growthScore = Math.min(25, Math.max(0,
    growthScoreSource > 20 ? 25 :
    growthScoreSource > 10 ? 20 :
    growthScoreSource > 5 ? 15 :
    growthScoreSource > 0 ? 10 :
    growthScoreSource > -5 ? 5 : 0,
  ));
  const churnScore = Math.min(25, Math.max(0,
    logoChurn30 < 1 ? 25 :
    logoChurn30 < 2 ? 20 :
    logoChurn30 < 3 ? 15 :
    logoChurn30 < 5 ? 10 :
    logoChurn30 < 10 ? 5 : 0,
  ));
  const concentrationScore = Math.min(20, Math.max(0,
    top1Pct < 10 ? 20 :
    top1Pct < 20 ? 16 :
    top1Pct < 30 ? 12 :
    top1Pct < 50 ? 8 :
    top1Pct < 75 ? 4 : 0,
  ));
  const vendorScore = 5;
  const opsScore = Math.min(15, Math.max(0,
    openAlertsCount === 0 && totalFailedRuns === 0 ? 15 :
    openAlertsCount <= 1 && totalFailedRuns <= 2 ? 12 :
    openAlertsCount <= 3 && totalFailedRuns <= 5 ? 8 : 4,
  ));
  const sellabilityScore = growthScore + churnScore + concentrationScore + vendorScore + opsScore;

  return {
    generatedAt: new Date().toISOString(),
    valuation: {
      low: arr * 3,
      mid: arr * 4,
      high: arr * 5,
      arr,
      mrr,
      multiplesUsed: { low: 3, mid: 4, high: 5 },
      note: "Valuation moves up with faster growth and lower churn; moves down with customer concentration and vendor risk.",
    },
    coreSaasMetrics: {
      mrr,
      arr,
      payingCustomers,
      payingCustomerBreakdown: { proMonthly, proAnnual, bizMonthly, bizAnnual },
      mrrGrowth: {
        momPct: mrrGrowthMoMPct,
        trailing3MoPct: mrrGrowth3MoPct,
        trailing6MoPct: mrrGrowth6MoPct,
        mrrAtMonthStart: mrrLastMonthStart,
        mrrAt3MoAgo: mrrThreeMoAgo,
        mrrAt6MoAgo: mrrSixMoAgo,
        note: "Past MRR is reconstructed from current subscription rows: a sub was 'active at cutoff' if it is currently active and untouched since the cutoff, OR currently canceled with cancel time after the cutoff. This is a floor on past MRR (it misses subs whose updated_at was bumped within the window for non-cancel reasons), so derived growth is an upper bound. Returns null when not enough history exists.",
      },
      netNewMrrThisMonth,
      churnedMrrThisMonth,
      churnedMrrLastMonth,
      logoChurn: { last30DaysPct: logoChurn30, last90DaysPct: logoChurn90, canceled30, canceled90 },
      revChurn: { last30DaysPct: revChurn30, last90DaysPct: revChurn90 },
      arpu,
      ltv,
      churnNote: "Churn approximated from current `subscriptions.status='canceled'` rows using `updated_at` as the cancel timestamp; no `canceled_at` field exists. Active counts use status='active' only (trialing excluded).",
    },
    costAndMargin: {
      aiCostPerEstimate,
      estimatesThisMonth: estimatesThisMonthCount,
      estimatesLastMonth: estimatesLastMonthCount,
      aiCostThisMonth,
      emailVolumeThisMonth: emailsThisMonthCount,
      estimatedGrossMarginPct,
      note: "AI cost is an estimate based on configurable per-estimate assumption. Actual OpenAI spend may differ.",
    },
    riskFlags: {
      customerConcentration: {
        top1Pct,
        top3Pct,
        top5Pct,
        totalPayingCustomers: payingCustomers,
      },
      vendorConcentration: { aiProvider: "OpenAI", pct: 100 },
      openSystemAlerts: openAlertsCount,
      failedJobRuns: { last7Days: totalFailedRuns, byJob: failedJobRunsList },
      hasBounceWebhook,
    },
    sellabilityScore: {
      total: sellabilityScore,
      maxTotal: 100,
      grade: sellabilityScore >= 80 ? "A" : sellabilityScore >= 65 ? "B" : sellabilityScore >= 50 ? "C" : sellabilityScore >= 35 ? "D" : "F",
      rubric: {
        growth: { score: growthScore, maxScore: 25, label: "Growth", notes: mrrGrowthMoMPct === null ? "Not enough subscription history" : `MoM MRR growth: ${mrrGrowthMoMPct.toFixed(1)}%` },
        churn: { score: churnScore, maxScore: 25, label: "Churn", notes: `30d logo churn: ${logoChurn30.toFixed(1)}%` },
        concentration: { score: concentrationScore, maxScore: 20, label: "Customer Concentration", notes: `Top customer: ${top1Pct.toFixed(1)}% of MRR` },
        vendorRisk: { score: vendorScore, maxScore: 15, label: "Vendor Risk", notes: "100% OpenAI dependency (capped at 5/15)" },
        opsHealth: { score: opsScore, maxScore: 15, label: "Ops Health", notes: `${openAlertsCount} open alerts, ${totalFailedRuns} failed jobs (7d)` },
      },
    },
  };
}

export function registerAdminSellabilityRoutes(app: express.Application): void {
  app.get(
    "/api/admin/sellability",
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const data = await computeSellability();
      res.json({ success: true, data });
    }),
  );

  app.put(
    "/api/admin/sellability/settings",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const { aiCostPerEstimate } = req.body as { aiCostPerEstimate?: unknown };
      if (aiCostPerEstimate === undefined || aiCostPerEstimate === null) {
        return res.status(400).json({ success: false, error: "aiCostPerEstimate is required" });
      }
      const cost = Number(aiCostPerEstimate);
      if (!Number.isFinite(cost) || cost < 0 || cost > 100) {
        return res.status(400).json({ success: false, error: "aiCostPerEstimate must be a number between 0 and 100" });
      }
      await setAiCostPerEstimate(cost);
      res.json({ success: true, data: { aiCostPerEstimate: cost } });
    }),
  );

  app.get(
    "/api/admin/sellability/export",
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const data = await computeSellability();
      const dateStr = new Date().toISOString().slice(0, 10);
      res
        .set("Content-Type", "application/json")
        .set("Content-Disposition", `attachment; filename="sellability-${dateStr}.json"`)
        .set("Cache-Control", "no-store")
        .send(JSON.stringify({ exportedAt: data.generatedAt, ...data }, null, 2));
    }),
  );
}
