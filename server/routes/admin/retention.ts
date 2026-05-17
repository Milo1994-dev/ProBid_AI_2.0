import express from "express";
import { pool } from "../../db.js";
import { asyncHandler, requireAdminAuth } from "../../lib/middleware.js";

const DAY_MS = 86_400_000;
const BUCKETS = [7, 30, 60, 90, 180] as const;
type Bucket = (typeof BUCKETS)[number];
const MAX_COHORTS = 52;

interface CohortRow {
  cohortStart: string;
  cohortSize: number;
  retainedD7: number | null;
  retainedD30: number | null;
  retainedD60: number | null;
  retainedD90: number | null;
  retainedD180: number | null;
  dataQuality: "complete" | "partial";
}

interface HeadlineStat {
  weighted90DayRetentionPct: number | null;
  customersRetainedAt90Days: number;
  customersEligibleAt90Days: number;
  notEnoughData: boolean;
  proxySourceCount: number;
}

interface CohortsPayload {
  granularity: "weekly" | "monthly";
  lookback: number;
  cohorts: CohortRow[];
  headline: HeadlineStat;
  generatedAt: string;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function periodStart(joinMs: number, granularity: "weekly" | "monthly"): string {
  const d = new Date(joinMs);
  if (granularity === "monthly") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  const dow = d.getUTCDay();
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  return isoDate(joinMs + daysToMonday * DAY_MS);
}

type SubEvent = {
  event: "subscription_updated";
  createdAt: number;
  eventStatus: "active" | "canceled" | string;
};

function buildPaidIntervals(
  subEvents: SubEvent[],
  subStatus: "active" | "canceled",
  cancelMs: number | null,
  nowMs: number,
): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  let openStart: number | null = null;

  for (const ev of subEvents) {
    if (ev.eventStatus === "active") {
      if (openStart === null) openStart = ev.createdAt;
    } else if (ev.eventStatus === "canceled" || ev.eventStatus === "past_due" || ev.eventStatus === "unpaid" || ev.eventStatus === "incomplete_expired") {
      if (openStart !== null) {
        intervals.push([openStart, ev.createdAt]);
        openStart = null;
      }
    }
  }

  if (openStart !== null) {
    if (subStatus === "active") {
      intervals.push([openStart, nowMs]);
    } else if (subStatus === "canceled" && cancelMs !== null) {
      intervals.push([openStart, cancelMs]);
    }
  }

  return intervals;
}

type Entry = {
  joinMs: number;
  paidIntervals: Array<[number, number]>;
  usedProxy: boolean;
};

function isRetainedAt(e: Entry, targetMs: number): boolean {
  return e.paidIntervals.some(([start, end]) => start <= targetMs && targetMs <= end);
}

async function computeCohorts(
  granularity: "weekly" | "monthly",
  lookback: number,
): Promise<CohortsPayload> {
  const nowMs = Date.now();
  const cappedLookback = Math.min(lookback, MAX_COHORTS);

  const [subEventsRes, subsRes, lifetimeRes] = await Promise.all([
    // subscription_updated events (paid status transitions) per subscriber.
    pool.query<{
      user_id: string;
      created_at: string;
      event_status: string;
    }>(`
      SELECT
        a.user_id,
        a.created_at,
        (a.data::jsonb->>'status') AS event_status
      FROM analytics a
      JOIN subscriptions s ON s.user_id = a.user_id
      WHERE a.event = 'subscription_updated'
        AND a.data IS NOT NULL
        AND s.status IN ('active', 'canceled')
      ORDER BY a.user_id, a.created_at ASC
    `),
    // All paid (non-trial) subscribers: status='active' or 'canceled'.
    pool.query<{
      user_id: string;
      sub_status: string;
      updated_at_ms: string;
    }>(`
      SELECT user_id, status AS sub_status, updated_at::text AS updated_at_ms
      FROM subscriptions
      WHERE status IN ('active', 'canceled')
    `),
    // Lifetime purchasers.
    pool.query<{
      user_id: string;
      join_ms: string;
    }>(`
      SELECT user_id, MIN(created_at)::text AS join_ms
      FROM purchases
      WHERE type = 'lifetime'
      GROUP BY user_id
    `),
  ]);

  // Group subscription_updated events per user.
  const subEvtsByUser = new Map<string, SubEvent[]>();
  for (const row of subEventsRes.rows) {
    const arr = subEvtsByUser.get(row.user_id) ?? [];
    arr.push({ event: "subscription_updated", createdAt: Number(row.created_at), eventStatus: row.event_status });
    subEvtsByUser.set(row.user_id, arr);
  }

  const byPeriod = new Map<string, Entry[]>();
  let totalProxy = 0;

  // Subscribers.
  for (const row of subsRes.rows) {
    const subStatus = row.sub_status as "active" | "canceled";
    const updatedAtMs = Number(row.updated_at_ms);
    const events = subEvtsByUser.get(row.user_id) ?? [];
    const cancelMs = subStatus === "canceled" ? updatedAtMs : null;

    let joinMs: number;
    let paidIntervals: Array<[number, number]>;
    let usedProxy: boolean;

    if (events.length > 0) {
      paidIntervals = buildPaidIntervals(events, subStatus, cancelMs, nowMs);
      const firstActive = events.find((e) => e.eventStatus === "active");
      joinMs = firstActive?.createdAt ?? updatedAtMs;
      usedProxy = firstActive == null;
    } else if (subStatus === "active") {
      // No events: subscriber pre-dates event tracking. Follow sellability/billing
      // convention: subscriptions.updated_at is the best available proxy for when
      // the subscription became active.
      joinMs = updatedAtMs;
      paidIntervals = [[updatedAtMs, nowMs]];
      usedProxy = true;
    } else {
      // Canceled with no events: cannot determine first-paid date.
      // Still include with the cancel date as a conservative join anchor.
      // They will never show as retained past Day 0 since their interval is empty.
      joinMs = updatedAtMs;
      paidIntervals = [];
      usedProxy = true;
    }

    if (!Number.isFinite(joinMs) || joinMs <= 0) continue;
    if (usedProxy) totalProxy++;

    const p = periodStart(joinMs, granularity);
    const arr = byPeriod.get(p) ?? [];
    arr.push({ joinMs, paidIntervals, usedProxy });
    byPeriod.set(p, arr);
  }

  // Lifetime purchasers (not already in subs).
  const subUserIds = new Set(subsRes.rows.map((r) => r.user_id));
  for (const row of lifetimeRes.rows) {
    if (subUserIds.has(row.user_id)) continue;
    const joinMs = Number(row.join_ms);
    if (!Number.isFinite(joinMs) || joinMs <= 0) continue;
    const p = periodStart(joinMs, granularity);
    const arr = byPeriod.get(p) ?? [];
    arr.push({ joinMs, paidIntervals: [[joinMs, Infinity]], usedProxy: false });
    byPeriod.set(p, arr);
  }

  if (byPeriod.size === 0) {
    return {
      granularity,
      lookback: cappedLookback,
      cohorts: [],
      headline: {
        weighted90DayRetentionPct: null,
        customersRetainedAt90Days: 0,
        customersEligibleAt90Days: 0,
        notEnoughData: true,
        proxySourceCount: 0,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  const sortedPeriods = [...byPeriod.keys()]
    .sort()
    .reverse()
    .slice(0, cappedLookback)
    .reverse();

  const cohorts: CohortRow[] = [];
  for (const period of sortedPeriods) {
    const users = byPeriod.get(period)!;
    const hasProxy = users.some((u) => u.usedProxy);
    const retainedAt: Partial<Record<Bucket, number | null>> = {};

    for (const bucket of BUCKETS) {
      const allEligible = users.every((u) => u.joinMs + bucket * DAY_MS <= nowMs);
      if (!allEligible) {
        retainedAt[bucket] = null;
        continue;
      }
      let retained = 0;
      for (const u of users) {
        if (isRetainedAt(u, u.joinMs + bucket * DAY_MS)) retained++;
      }
      retainedAt[bucket] = Math.round((retained / users.length) * 100);
    }

    cohorts.push({
      cohortStart: period,
      cohortSize: users.length,
      retainedD7: retainedAt[7] ?? null,
      retainedD30: retainedAt[30] ?? null,
      retainedD60: retainedAt[60] ?? null,
      retainedD90: retainedAt[90] ?? null,
      retainedD180: retainedAt[180] ?? null,
      dataQuality: hasProxy ? "partial" : "complete",
    });
  }

  let totalEligibleAt90 = 0;
  let totalRetainedAt90 = 0;
  for (const users of byPeriod.values()) {
    for (const u of users) {
      if (u.usedProxy) continue;
      const targetMs = u.joinMs + 90 * DAY_MS;
      if (targetMs > nowMs) continue;
      totalEligibleAt90++;
      if (isRetainedAt(u, targetMs)) totalRetainedAt90++;
    }
  }

  return {
    granularity,
    lookback: cappedLookback,
    cohorts,
    headline: {
      weighted90DayRetentionPct:
        totalEligibleAt90 > 0
          ? Math.round((totalRetainedAt90 / totalEligibleAt90) * 100)
          : null,
      customersRetainedAt90Days: totalRetainedAt90,
      customersEligibleAt90Days: totalEligibleAt90,
      notEnoughData: totalEligibleAt90 < 10,
      proxySourceCount: totalProxy,
    },
    generatedAt: new Date().toISOString(),
  };
}

function buildCsv(data: CohortsPayload): string {
  const header = "cohort_start,cohort_size,retained_d7,retained_d30,retained_d60,retained_d90,retained_d180,data_quality";
  const rows = data.cohorts.map((c) =>
    [
      c.cohortStart,
      c.cohortSize,
      c.retainedD7 ?? "",
      c.retainedD30 ?? "",
      c.retainedD60 ?? "",
      c.retainedD90 ?? "",
      c.retainedD180 ?? "",
      c.dataQuality,
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

export function registerAdminRetentionRoutes(app: express.Application): void {
  app.get(
    "/api/admin/retention/cohorts",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const granularity = req.query.granularity === "monthly" ? "monthly" : "weekly";
      const lookback = Math.min(MAX_COHORTS, Math.max(1, parseInt(String(req.query.lookback ?? "12"), 10) || 12));
      res.json({ success: true, data: await computeCohorts(granularity, lookback) });
    }),
  );

  app.get(
    "/api/admin/retention/cohorts.csv",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const granularity = req.query.granularity === "monthly" ? "monthly" : "weekly";
      const lookback = Math.min(MAX_COHORTS, Math.max(1, parseInt(String(req.query.lookback ?? "52"), 10) || 52));
      const data = await computeCohorts(granularity, lookback);
      const dateStr = new Date().toISOString().slice(0, 10);
      res
        .set("Content-Type", "text/csv")
        .set("Content-Disposition", `attachment; filename="retention-cohorts-${dateStr}.csv"`)
        .set("Cache-Control", "no-store")
        .send(buildCsv(data));
    }),
  );
}
