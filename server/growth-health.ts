// Growth Engine Health rollups — turns raw operational tables into a
// per-subsystem traffic-light view. Designed to be cheap to call (60s
// in-memory cache) so the admin dashboard can poll on a 30s interval.
//
// Rules live in `lib/growth-health-rules.ts` so the alerting side and the
// dashboard side share one definition of "what counts as silent failure".

import { pool, getPoolResetStats, getDuplicateDealRaceStats } from "./db.js";
import {
  BUSINESS_HOURS_UTC,
  GROWTH_HEALTH_RULES,
  HealthStatus,
  SubsystemRule,
} from "./lib/growth-health-rules.js";
import { outreachPaused, outreachPauseReason } from "./lib/outreach-state.js";
import {
  getDupeDealRaceThresholds,
  getDbPoolThresholds,
  getErrorRateThresholds,
  getWebhookSuccessThresholds,
  getLeadScraperThresholds,
  getOutreachProcessorThresholds,
  getOutreachDeliverabilityThresholds,
  getStripeWebhookThresholds,
  getProcoreSyncThresholds,
  getCronSchedulerThresholds,
} from "./lib/watchtower-settings.js";

export interface SubsystemRollup {
  key: string;
  label: string;
  description: string;
  status: HealthStatus;
  reasons: string[];
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  throughput24h: number;
  failureCount24h: number;
  failureRate24h: number | null;
  latestError: string | null;
  drilldownPath?: string;
  meta?: Record<string, unknown>;
}

export interface GrowthHealthSnapshot {
  generatedAt: number;
  overall: HealthStatus;
  subsystems: SubsystemRollup[];
}

const CACHE_TTL_MS = 60_000;
let cached: { at: number; snapshot: GrowthHealthSnapshot } | null = null;

// ── threshold display helper ─────────────────────────────────────────────

interface ThresholdsMeta {
  yellow: string;
  red: string;
  label: string;
  /** "ceil" = trip when value ≥ threshold; "floor" = trip when value < threshold */
  direction: "ceil" | "floor";
  /** Current live metric value for display in alert emails */
  currentValue?: string;
}

function fmtMin(m: number): string {
  if (m >= 60 * 24) return `${Math.round(m / (60 * 24))}d`;
  if (m >= 60) return `${Math.round(m / 60)}h`;
  return `${m}m`;
}

function ruleThresholdsMeta(rule: SubsystemRule): ThresholdsMeta {
  if (rule.poolResetsPerHour) {
    const t = rule.poolResetsPerHour;
    return { yellow: String(t.yellow), red: String(t.red), label: "resets/hr", direction: "ceil" };
  }
  if (rule.errorFingerprintsLastHour) {
    const t = rule.errorFingerprintsLastHour;
    return { yellow: String(t.yellow), red: String(t.red), label: "errors/hr", direction: "ceil" };
  }
  if (rule.webhookSuccessRate1h) {
    const t = rule.webhookSuccessRate1h;
    return {
      yellow: `${(t.yellow * 100).toFixed(0)}%`,
      red: `${(t.red * 100).toFixed(0)}%`,
      label: "success rate",
      direction: "floor",
    };
  }
  if (rule.duplicateDealRacesPerHour) {
    const t = rule.duplicateDealRacesPerHour;
    return { yellow: String(t.yellow), red: String(t.red), label: "races/hr", direction: "ceil" };
  }
  if (rule.perConnectionStaleAfterMinutes) {
    const t = rule.perConnectionStaleAfterMinutes;
    return { yellow: fmtMin(t.yellow), red: fmtMin(t.red), label: "per-conn idle", direction: "ceil" };
  }
  if (rule.maxFailureRate24h) {
    const t = rule.maxFailureRate24h;
    return {
      yellow: `${(t.yellow * 100).toFixed(0)}%`,
      red: `${(t.red * 100).toFixed(0)}%`,
      label: "24h failure rate",
      direction: "ceil",
    };
  }
  const sam = rule.staleAfterMinutes;
  if (sam.red < Number.MAX_SAFE_INTEGER) {
    return { yellow: fmtMin(sam.yellow), red: fmtMin(sam.red), label: "stale", direction: "ceil" };
  }
  return { yellow: "—", red: "—", label: "", direction: "ceil" };
}

export function invalidateGrowthHealthCache(): void {
  cached = null;
}

export async function getGrowthHealthSnapshot(
  force = false,
): Promise<GrowthHealthSnapshot> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.snapshot;
  }
  const snapshot = await computeGrowthHealth();
  cached = { at: Date.now(), snapshot };
  return snapshot;
}

async function computeGrowthHealth(): Promise<GrowthHealthSnapshot> {
  const subsystems = await Promise.all(
    GROWTH_HEALTH_RULES.map((rule) => evaluate(rule)),
  );
  const overall: HealthStatus = subsystems.some((s) => s.status === "red")
    ? "red"
    : subsystems.some((s) => s.status === "yellow")
      ? "yellow"
      : subsystems.every((s) => s.status === "green" || s.status === "paused")
        ? "green"
        : "unknown";
  return { generatedAt: Date.now(), overall, subsystems };
}

async function evaluate(rule: SubsystemRule): Promise<SubsystemRollup> {
  switch (rule.key) {
    case "lead_scraper":
      return evalLeadScraper(rule);
    case "outreach_processor":
      return evalOutreachProcessor(rule);
    case "outreach_deliverability":
      return evalOutreachDeliverability(rule);
    case "stripe_webhooks":
      return evalStripeWebhooks(rule);
    case "procore_sync":
      return evalProcoreSync(rule);
    case "cron_scheduler":
      return evalCronScheduler(rule);
    case "db_pool_health":
      return evalDbPoolHealth(rule);
    case "error_rate":
      return evalErrorRate(rule);
    case "outbound_webhooks":
      return evalOutboundWebhooks(rule);
    case "duplicate_deal_races":
      return evalDuplicateDealRaces(rule);
    default:
      return baseRollup(rule, "unknown", ["No evaluator implemented"]);
  }
}

function baseRollup(
  rule: SubsystemRule,
  status: HealthStatus,
  reasons: string[],
  extras: Partial<SubsystemRollup> = {},
): SubsystemRollup {
  return {
    key: rule.key,
    label: rule.label,
    description: rule.description,
    status,
    reasons,
    lastSuccessAt: null,
    lastFailureAt: null,
    throughput24h: 0,
    failureCount24h: 0,
    failureRate24h: null,
    latestError: null,
    drilldownPath: rule.drilldownPath,
    ...extras,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── job_runs-backed subsystems ────────────────────────────────────────────

async function evalJobRun(
  rule: SubsystemRule,
  jobName: string,
): Promise<SubsystemRollup> {
  const since = Date.now() - DAY_MS;
  const [aggRes, lastSuccessRes, lastFailureRes] = await Promise.all([
    pool.query<{ runs: string; ok_runs: string; fail_runs: string; items: string | null }>(
      `SELECT COUNT(*)::text AS runs,
              COUNT(*) FILTER (WHERE status = 'completed')::text AS ok_runs,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS fail_runs,
              SUM(success_count) FILTER (WHERE status = 'completed')::text AS items
         FROM job_runs WHERE job_name = $1 AND started_at >= $2`,
      [jobName, since],
    ),
    pool.query<{ started_at: string; success_count: number; items_processed: number }>(
      `SELECT started_at, success_count, items_processed FROM job_runs
        WHERE job_name = $1 AND status = 'completed'
        ORDER BY started_at DESC LIMIT 1`,
      [jobName],
    ),
    pool.query<{ started_at: string; error_summary: string | null }>(
      `SELECT started_at, error_summary FROM job_runs
        WHERE job_name = $1 AND status = 'failed'
        ORDER BY started_at DESC LIMIT 1`,
      [jobName],
    ),
  ]);

  const okRuns = Number(aggRes.rows[0]?.ok_runs ?? 0);
  const failRuns = Number(aggRes.rows[0]?.fail_runs ?? 0);
  const totalRuns = okRuns + failRuns;
  const throughput24h = Number(aggRes.rows[0]?.items ?? 0);
  const failureRate = totalRuns > 0 ? failRuns / totalRuns : null;

  const lastSuccessAt = lastSuccessRes.rows[0]
    ? Number(lastSuccessRes.rows[0].started_at)
    : null;
  const lastFailureAt = lastFailureRes.rows[0]
    ? Number(lastFailureRes.rows[0].started_at)
    : null;
  const latestError = lastFailureRes.rows[0]?.error_summary ?? null;

  const { status, reasons } = decide(rule, {
    lastSuccessAt,
    failureRate,
    throughput24h,
  });
  const thresholdsMeta = ruleThresholdsMeta(rule);
  let currentValue: string | undefined;
  if (rule.maxFailureRate24h && failureRate !== null) {
    currentValue = `${(failureRate * 100).toFixed(1)}%`;
  } else if (lastSuccessAt !== null) {
    const ageMin = (Date.now() - lastSuccessAt) / 60_000;
    currentValue = fmtMin(Math.round(ageMin));
  }
  return {
    ...baseRollup(rule, status, reasons),
    lastSuccessAt,
    lastFailureAt,
    throughput24h,
    failureCount24h: failRuns,
    failureRate24h: failureRate,
    latestError,
    meta: { thresholds: { ...thresholdsMeta, currentValue } },
  };
}

export async function evalLeadScraper(rule: SubsystemRule): Promise<SubsystemRollup> {
  const dbT = await getLeadScraperThresholds({
    staleYellow: rule.staleAfterMinutes.yellow,
    staleRed: rule.staleAfterMinutes.red,
    failRateYellow: rule.maxFailureRate24h?.yellow ?? 0.5,
    failRateRed: rule.maxFailureRate24h?.red ?? 0.9,
    zeroOutputRunsRed: rule.zeroOutputRunsRed ?? 3,
  });
  const patchedRule: SubsystemRule = {
    ...rule,
    staleAfterMinutes: { yellow: dbT.staleYellow, red: dbT.staleRed },
    maxFailureRate24h: { yellow: dbT.failRateYellow, red: dbT.failRateRed },
    zeroOutputRunsRed: dbT.zeroOutputRunsRed,
  };
  const base = await evalJobRun(patchedRule, "scrape-leads");
  // Silent failure: scraper completes but yields zero leads N runs in a row.
  const zeroRunsRed = dbT.zeroOutputRunsRed;
  if (zeroRunsRed > 0) {
    const recent = await pool.query<{ success_count: number }>(
      `SELECT COALESCE(success_count, 0) AS success_count FROM job_runs
        WHERE job_name = 'scrape-leads' AND status = 'completed'
        ORDER BY started_at DESC LIMIT $1`,
      [zeroRunsRed],
    );
    if (
      recent.rows.length >= zeroRunsRed &&
      recent.rows.every((r) => Number(r.success_count) === 0)
    ) {
      return {
        ...base,
        status: "red",
        reasons: [
          ...base.reasons.filter((r) => r !== "Within all thresholds"),
          `${zeroRunsRed} consecutive successful runs returned 0 leads`,
        ],
        meta: { ...base.meta, thresholdSource: dbT.source },
      };
    }
  }
  return { ...base, meta: { ...base.meta, thresholdSource: dbT.source } };
}

export async function evalOutreachProcessor(rule: SubsystemRule): Promise<SubsystemRollup> {
  const dbT = await getOutreachProcessorThresholds({
    staleYellow: rule.staleAfterMinutes.yellow,
    staleRed: rule.staleAfterMinutes.red,
    zeroSendYellow: rule.zeroSendBusinessHours?.yellow ?? 4,
    zeroSendRed: rule.zeroSendBusinessHours?.red ?? 8,
  });
  const patchedRule: SubsystemRule = {
    ...rule,
    staleAfterMinutes: { yellow: dbT.staleYellow, red: dbT.staleRed },
    zeroSendBusinessHours: { yellow: dbT.zeroSendYellow, red: dbT.zeroSendRed },
  };
  const base = await evalJobRun(patchedRule, "process-outreach");
  if (outreachPaused) {
    return {
      ...base,
      status: "paused",
      reasons: [`Outreach paused: ${outreachPauseReason || "unspecified"}`],
    };
  }
  // Silent failure: processor runs but sends 0 messages during business hours.
  // Window is clipped to today's business-hours start so the overnight quiet
  // period can't trigger a red at 09:00 ET.
  const zsbh = patchedRule.zeroSendBusinessHours;
  const nowD = new Date();
  if (zsbh && isBusinessHourUTC(nowD)) {
    const bizStart = Date.UTC(
      nowD.getUTCFullYear(),
      nowD.getUTCMonth(),
      nowD.getUTCDate(),
      BUSINESS_HOURS_UTC.start,
      0,
      0,
    );
    const redSince = Math.max(Date.now() - zsbh.red * 3_600_000, bizStart);
    const yelSince = Math.max(Date.now() - zsbh.yellow * 3_600_000, bizStart);
    const redHrs = Math.max(1, Math.round((Date.now() - redSince) / 3_600_000));
    const yelHrs = Math.max(1, Math.round((Date.now() - yelSince) / 3_600_000));
    const sendsRes = await pool.query<{ red_c: string; yel_c: string }>(
      `SELECT COUNT(*) FILTER (WHERE sent_at >= $1)::text AS red_c,
              COUNT(*) FILTER (WHERE sent_at >= $2)::text AS yel_c
         FROM lead_email_audit_log
        WHERE status = 'sent' AND sent_at >= $1`,
      [new Date(redSince).toISOString(), new Date(yelSince).toISOString()],
    );
    const redSends = Number(sendsRes.rows[0]?.red_c ?? 0);
    const yelSends = Number(sendsRes.rows[0]?.yel_c ?? 0);
    // Need at least the full red window of business hours elapsed today
    // before treating zero as a red signal.
    if (redSends === 0 && redHrs >= zsbh.red) {
      return {
        ...base,
        status: "red",
        reasons: [
          ...base.reasons.filter((r) => r !== "Within all thresholds"),
          `0 outbound messages in last ${redHrs}h of business hours`,
        ],
        meta: { ...base.meta, thresholdSource: dbT.source },
      };
    }
    if (yelSends === 0 && yelHrs >= zsbh.yellow && base.status === "green") {
      return {
        ...base,
        status: "yellow",
        reasons: [
          ...base.reasons.filter((r) => r !== "Within all thresholds"),
          `0 outbound messages in last ${yelHrs}h of business hours`,
        ],
        meta: { ...base.meta, thresholdSource: dbT.source },
      };
    }
  }
  return { ...base, meta: { ...base.meta, thresholdSource: dbT.source } };
}

function isBusinessHourUTC(d: Date): boolean {
  const h = d.getUTCHours();
  return h >= BUSINESS_HOURS_UTC.start && h < BUSINESS_HOURS_UTC.end;
}

// ── lead_email_audit_log: real send+bounce volume ────────────────────────

export async function evalOutreachDeliverability(rule: SubsystemRule): Promise<SubsystemRollup> {
  const dbT = await getOutreachDeliverabilityThresholds({
    staleYellow: rule.staleAfterMinutes.yellow,
    staleRed: rule.staleAfterMinutes.red,
    failRateYellow: rule.maxFailureRate24h?.yellow ?? 0.05,
    failRateRed: rule.maxFailureRate24h?.red ?? 0.1,
  });
  const patchedRule: SubsystemRule = {
    ...rule,
    staleAfterMinutes: { yellow: dbT.staleYellow, red: dbT.staleRed },
    maxFailureRate24h: { yellow: dbT.failRateYellow, red: dbT.failRateRed },
  };
  if (outreachPaused) {
    return baseRollup(patchedRule, "paused", [`Outreach paused: ${outreachPauseReason || "unspecified"}`], {
      meta: { thresholds: ruleThresholdsMeta(patchedRule), thresholdSource: dbT.source },
    });
  }
  const sinceISO = new Date(Date.now() - DAY_MS).toISOString();
  const aggRes = await pool.query<{ sent: string; bounced: string; complained: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')::text AS sent,
       COUNT(*) FILTER (WHERE status LIKE 'bounced_%')::text AS bounced,
       COUNT(*) FILTER (WHERE status = 'complained')::text AS complained
     FROM lead_email_audit_log
     WHERE sent_at >= $1`,
    [sinceISO],
  );
  const sent = Number(aggRes.rows[0]?.sent ?? 0);
  const bounced = Number(aggRes.rows[0]?.bounced ?? 0);
  const complained = Number(aggRes.rows[0]?.complained ?? 0);
  const bad = bounced + complained;
  const total = sent + bad;
  const failureRate = total > 0 ? bad / total : null;

  const lastSentRes = await pool.query<{ sent_at: string }>(
    `SELECT sent_at FROM lead_email_audit_log WHERE status = 'sent'
      ORDER BY sent_at DESC LIMIT 1`,
  );
  const lastBounceRes = await pool.query<{ sent_at: string; status: string; subject: string | null }>(
    `SELECT sent_at, status, subject FROM lead_email_audit_log
      WHERE status LIKE 'bounced_%' OR status = 'complained'
      ORDER BY sent_at DESC LIMIT 1`,
  );

  const lastSuccessAt = lastSentRes.rows[0]
    ? Date.parse(lastSentRes.rows[0].sent_at)
    : null;
  const lastFailureAt = lastBounceRes.rows[0]
    ? Date.parse(lastBounceRes.rows[0].sent_at)
    : null;
  const latestError = lastBounceRes.rows[0]
    ? `${lastBounceRes.rows[0].status}: ${lastBounceRes.rows[0].subject ?? "n/a"}`
    : null;

  const { status, reasons } = decide(patchedRule, {
    lastSuccessAt,
    failureRate,
    throughput24h: sent,
  });
  return {
    ...baseRollup(patchedRule, status, reasons),
    lastSuccessAt,
    lastFailureAt,
    throughput24h: sent,
    failureCount24h: bad,
    failureRate24h: failureRate,
    latestError,
    meta: { bounced24h: bounced, complained24h: complained, thresholds: { ...ruleThresholdsMeta(patchedRule), currentValue: failureRate !== null ? `${(failureRate * 100).toFixed(1)}%` : "n/a" }, thresholdSource: dbT.source },
  };
}

// ── stripe_webhooks: error_logs path-based heuristic ─────────────────────

export async function evalStripeWebhooks(rule: SubsystemRule): Promise<SubsystemRollup> {
  const dbT = await getStripeWebhookThresholds({
    failRateYellow: rule.maxFailureRate24h?.yellow ?? 0.2,
    failRateRed: rule.maxFailureRate24h?.red ?? 0.5,
    sigFailsRed: rule.signatureFailuresLastHourRed ?? 1,
  });
  const patchedRule: SubsystemRule = {
    ...rule,
    maxFailureRate24h: { yellow: dbT.failRateYellow, red: dbT.failRateRed },
    signatureFailuresLastHourRed: dbT.sigFailsRed,
  };
  const since = Date.now() - DAY_MS;
  // Scope strictly to the Stripe webhook handler so Resend/developer webhook
  // failures (different paths, different owners) don't surface as Stripe red.
  const errAggRes = await pool.query<{ c: string; latest: string | null; latest_at: string | null }>(
    `WITH stripe_errs AS (
       SELECT message, last_seen_at FROM error_logs
        WHERE path = '/api/stripe/webhook' AND last_seen_at >= $1
     )
     SELECT COUNT(*)::text AS c,
            (SELECT message       FROM stripe_errs ORDER BY last_seen_at DESC LIMIT 1) AS latest,
            (SELECT last_seen_at::text FROM stripe_errs ORDER BY last_seen_at DESC LIMIT 1) AS latest_at
       FROM stripe_errs`,
    [since],
  );
  const errCount = Number(errAggRes.rows[0]?.c ?? 0);
  const latestError = errAggRes.rows[0]?.latest ?? null;
  const lastFailureAt = errAggRes.rows[0]?.latest_at
    ? Number(errAggRes.rows[0].latest_at)
    : null;

  // Positive signal: any subscriptions or purchases written in the last 24h
  // implies the webhook pipeline produced at least one good outcome.
  const sigRes = await pool.query<{ subs: string; purchases: string; latest: string | null }>(
    `SELECT
       (SELECT COUNT(*)::text FROM subscriptions WHERE updated_at >= $1) AS subs,
       (SELECT COUNT(*)::text FROM purchases    WHERE created_at >= $1) AS purchases,
       (SELECT GREATEST(
          COALESCE((SELECT MAX(updated_at) FROM subscriptions), 0),
          COALESCE((SELECT MAX(created_at) FROM purchases), 0)
        )::text) AS latest`,
    [since],
  );
  const subs24h = Number(sigRes.rows[0]?.subs ?? 0);
  const purch24h = Number(sigRes.rows[0]?.purchases ?? 0);
  const throughput24h = subs24h + purch24h;
  const lastSuccessRaw = Number(sigRes.rows[0]?.latest ?? 0);
  const lastSuccessAt = lastSuccessRaw > 0 ? lastSuccessRaw : null;

  const totalEvents = throughput24h + errCount;
  const failureRate = totalEvents > 0 ? errCount / totalEvents : null;

  // Hot signal: any signature-failure events in the last hour → red. Stripe
  // signature failures usually mean rotated secret or replay; can't wait 24h.
  let sigFails60m = 0;
  if (patchedRule.signatureFailuresLastHourRed) {
    const sinceMs = Date.now() - 60 * 60_000;
    const sigErr = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM error_logs
        WHERE path = '/api/stripe/webhook'
          AND last_seen_at >= $1
          AND (message ILIKE '%signature%' OR message ILIKE '%verification%')`,
      [sinceMs],
    );
    sigFails60m = Number(sigErr.rows[0]?.c ?? 0);
  }

  let { status, reasons } = decide(patchedRule, {
    lastSuccessAt,
    failureRate,
    // Stripe webhooks are event-driven — no positive volume just means quiet day.
    throughput24h: Number.MAX_SAFE_INTEGER,
  });
  if (
    patchedRule.signatureFailuresLastHourRed &&
    sigFails60m >= patchedRule.signatureFailuresLastHourRed
  ) {
    status = "red";
    reasons = [
      ...reasons.filter((r) => r !== "Within all thresholds"),
      `${sigFails60m} Stripe signature failure(s) in last 60 min`,
    ];
  }
  return {
    ...baseRollup(patchedRule, status, reasons),
    lastSuccessAt,
    lastFailureAt,
    throughput24h,
    failureCount24h: errCount,
    failureRate24h: failureRate,
    latestError,
    meta: { subs24h, purchases24h: purch24h, errors24h: errCount, sigFails60m, thresholds: { ...ruleThresholdsMeta(patchedRule), currentValue: failureRate !== null ? `${(failureRate * 100).toFixed(1)}%` : "n/a" }, thresholdSource: dbT.source },
  };
}

// ── procore_sync: connection lastSyncAt freshness ────────────────────────

export async function evalProcoreSync(rule: SubsystemRule): Promise<SubsystemRollup> {
  const dbT = await getProcoreSyncThresholds({
    staleYellow: rule.staleAfterMinutes.yellow,
    staleRed: rule.staleAfterMinutes.red,
    connStaleYellow: rule.perConnectionStaleAfterMinutes?.yellow ?? 26 * 60,
    connStaleRed: rule.perConnectionStaleAfterMinutes?.red ?? 36 * 60,
  });
  const patchedRule: SubsystemRule = {
    ...rule,
    staleAfterMinutes: { yellow: dbT.staleYellow, red: dbT.staleRed },
    perConnectionStaleAfterMinutes: { yellow: dbT.connStaleYellow, red: dbT.connStaleRed },
  };
  // Per-active-connection check so one busy connection can't mask another
  // that's silently stuck (rotated token, revoked grant, etc.).
  const rowsRes = await pool.query<{
    id: string;
    company_name: string | null;
    last_sync_at: string | null;
    created_at: string | null;
    status: string;
  }>(
    `SELECT id, company_name, last_sync_at::text AS last_sync_at,
            created_at::text AS created_at, status
       FROM procore_connections`,
  );
  const total = rowsRes.rows.length;
  const active = rowsRes.rows.filter((r) => r.status === "active");
  if (total === 0) {
    return baseRollup(patchedRule, "unknown", ["No Procore connections — nothing to sync"], {
      meta: { total, active: 0, thresholds: ruleThresholdsMeta(patchedRule), thresholdSource: dbT.source },
    });
  }
  if (active.length === 0) {
    return baseRollup(patchedRule, "unknown", ["No active Procore connections"], {
      meta: { total, active: 0, thresholds: ruleThresholdsMeta(patchedRule), thresholdSource: dbT.source },
    });
  }

  const now = Date.now();
  const stale = patchedRule.perConnectionStaleAfterMinutes;
  const staleConns: { name: string; ageMin: number; level: "yellow" | "red" }[] = [];
  let latestActiveSync = 0;

  for (const c of active) {
    const ts = c.last_sync_at ? Number(c.last_sync_at) : 0;
    if (ts > latestActiveSync) latestActiveSync = ts;
    if (!stale) continue;
    // Reference age from created_at when no sync has happened yet, so a
    // freshly-activated connection isn't immediately RED before its first
    // scheduled run. Falls back to "now" (age=0) if created_at is also missing.
    const refTs = ts > 0 ? ts : c.created_at ? Number(c.created_at) : now;
    const ageMin = (now - refTs) / 60_000;
    if (ageMin >= stale.red) {
      staleConns.push({ name: c.company_name ?? `#${c.id}`, ageMin, level: "red" });
    } else if (ageMin >= stale.yellow) {
      staleConns.push({ name: c.company_name ?? `#${c.id}`, ageMin, level: "yellow" });
    }
  }

  const lastSuccessAt = latestActiveSync > 0 ? latestActiveSync : null;
  let { status, reasons } = decide(patchedRule, {
    lastSuccessAt,
    failureRate: null,
    throughput24h: Number.MAX_SAFE_INTEGER,
  });
  if (staleConns.some((s) => s.level === "red")) {
    status = "red";
    reasons = [
      ...reasons.filter((r) => r !== "Within all thresholds"),
      `${staleConns.filter((s) => s.level === "red").length} active connection(s) stale > ${stale!.red} min`,
    ];
  } else if (staleConns.some((s) => s.level === "yellow") && status === "green") {
    status = "yellow";
    reasons = [
      ...reasons.filter((r) => r !== "Within all thresholds"),
      `${staleConns.length} active connection(s) stale > ${stale!.yellow} min`,
    ];
  }
  const maxStaleMin = staleConns.length > 0
    ? Math.max(...staleConns.map((s) => s.ageMin))
    : latestActiveSync > 0
      ? (now - latestActiveSync) / 60_000
      : undefined;
  const procoreCurrentValue = maxStaleMin !== undefined ? fmtMin(Math.round(maxStaleMin)) : undefined;
  return {
    ...baseRollup(patchedRule, status, reasons),
    lastSuccessAt,
    meta: {
      totalConnections: total,
      activeConnections: active.length,
      staleActive: staleConns.map((s) => ({
        name: s.name,
        ageMin: Math.round(s.ageMin),
        level: s.level,
      })),
      thresholds: { ...ruleThresholdsMeta(patchedRule), currentValue: procoreCurrentValue },
      thresholdSource: dbT.source,
    },
  };
}

// ── cron_scheduler: heartbeat from cron_last_* keys ──────────────────────

export async function evalCronScheduler(rule: SubsystemRule): Promise<SubsystemRollup> {
  const dbT = await getCronSchedulerThresholds({
    staleYellow: rule.staleAfterMinutes.yellow,
    staleRed: rule.staleAfterMinutes.red,
  });
  const patchedRule: SubsystemRule = {
    ...rule,
    staleAfterMinutes: { yellow: dbT.staleYellow, red: dbT.staleRed },
  };
  const rowsRes = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM lead_outreach_config WHERE key LIKE 'cron_last_%'`,
  );
  if (rowsRes.rows.length === 0) {
    return baseRollup(patchedRule, "unknown", ["No cron heartbeat recorded yet"], {
      meta: { heartbeats: 0, thresholds: ruleThresholdsMeta(patchedRule), thresholdSource: dbT.source },
    });
  }
  let lastSuccessAt: number | null = null;
  for (const row of rowsRes.rows) {
    const ts = Date.parse(row.value);
    if (!isNaN(ts) && (!lastSuccessAt || ts > lastSuccessAt)) lastSuccessAt = ts;
  }
  const { status, reasons } = decide(patchedRule, {
    lastSuccessAt,
    failureRate: null,
    throughput24h: Number.MAX_SAFE_INTEGER,
  });
  const cronCurrentValue = lastSuccessAt !== null
    ? fmtMin(Math.round((Date.now() - lastSuccessAt) / 60_000))
    : undefined;
  return {
    ...baseRollup(patchedRule, status, reasons),
    lastSuccessAt,
    meta: { heartbeats: rowsRes.rows.length, thresholds: { ...ruleThresholdsMeta(patchedRule), currentValue: cronCurrentValue }, thresholdSource: dbT.source },
  };
}

// ── db_pool_health: in-process counter from db.ts ────────────────────────

export async function evalDbPoolHealth(rule: SubsystemRule): Promise<SubsystemRollup> {
  const stats = getPoolResetStats(60 * 60 * 1000);
  const reasons: string[] = [];
  let status: HealthStatus = "green";
  const envT = rule.poolResetsPerHour ?? { yellow: 30, red: 60 };
  const { yellow: yellowThreshold, red: redThreshold, source: thresholdSource } =
    await getDbPoolThresholds(envT.yellow, envT.red);
  if (stats.count >= redThreshold) {
    status = "red";
    reasons.push(`${stats.count} pool resets in last hour ≥ red ${redThreshold}`);
  } else if (stats.count >= yellowThreshold) {
    status = "yellow";
    reasons.push(`${stats.count} pool resets in last hour ≥ yellow ${yellowThreshold}`);
  }
  if (status === "green") reasons.push(`${stats.count} pool resets in last hour (within thresholds)`);
  return {
    ...baseRollup(rule, status, reasons),
    lastSuccessAt: Date.now(),
    throughput24h: stats.count,
    failureCount24h: stats.count,
    meta: {
      totalResetsSinceBoot: stats.total,
      windowMs: stats.windowMs,
      thresholds: { yellow: String(yellowThreshold), red: String(redThreshold), label: "resets/hr", direction: "ceil" as const, source: thresholdSource, currentValue: String(stats.count) },
    },
  };
}

// ── error_rate: error_logs distinct fingerprints in last hour ────────────

const ERROR_RATE_EXCLUDED_PATHS = ["/api/stripe/webhook"];

export async function evalErrorRate(rule: SubsystemRule): Promise<SubsystemRollup> {
  const since = Date.now() - 60 * 60 * 1000;
  const aggRes = await pool.query<{ c: string; latest: string | null; latest_at: string | null }>(
    `WITH recent AS (
       SELECT fingerprint, message, last_seen_at
         FROM error_logs
        WHERE resolved = false
          AND last_seen_at >= $1
          AND (path IS NULL OR path != ALL($2::text[]))
     )
     SELECT COUNT(DISTINCT fingerprint)::text AS c,
            (SELECT message       FROM recent ORDER BY last_seen_at DESC LIMIT 1) AS latest,
            (SELECT last_seen_at::text FROM recent ORDER BY last_seen_at DESC LIMIT 1) AS latest_at
       FROM recent`,
    [since, ERROR_RATE_EXCLUDED_PATHS],
  );
  const distinctCount = Number(aggRes.rows[0]?.c ?? 0);
  const latestError = aggRes.rows[0]?.latest ?? null;
  const lastFailureAt = aggRes.rows[0]?.latest_at
    ? Number(aggRes.rows[0].latest_at)
    : null;

  const envT = rule.errorFingerprintsLastHour ?? { yellow: 20, red: 50 };
  const { yellow: yellowThreshold, red: redThreshold, source: thresholdSource } =
    await getErrorRateThresholds(envT.yellow, envT.red);

  const reasons: string[] = [];
  let status: HealthStatus = "green";
  if (distinctCount >= redThreshold) {
    status = "red";
    reasons.push(`${distinctCount} distinct error fingerprints in last hour ≥ red ${redThreshold}`);
  } else if (distinctCount >= yellowThreshold) {
    status = "yellow";
    reasons.push(`${distinctCount} distinct error fingerprints in last hour ≥ yellow ${yellowThreshold}`);
  }
  if (status === "green") reasons.push(`${distinctCount} distinct error fingerprints in last hour (within thresholds)`);
  return {
    ...baseRollup(rule, status, reasons),
    lastSuccessAt: Date.now(),
    lastFailureAt,
    throughput24h: distinctCount,
    failureCount24h: distinctCount,
    latestError,
    meta: {
      excludedPaths: ERROR_RATE_EXCLUDED_PATHS,
      thresholds: { yellow: String(yellowThreshold), red: String(redThreshold), label: "errors/hr", direction: "ceil" as const, source: thresholdSource, currentValue: String(distinctCount) },
    },
  };
}

// ── outbound_webhooks: webhook_deliveries success rate (1h window) ──────

export async function evalOutboundWebhooks(rule: SubsystemRule): Promise<SubsystemRollup> {
  const since = Date.now() - 60 * 60 * 1000;
  const aggRes = await pool.query<{ delivered: string; failed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'delivered')::text AS delivered,
       COUNT(*) FILTER (WHERE status = 'failed')::text    AS failed
       FROM webhook_deliveries
      WHERE COALESCE(last_attempt_at, created_at) >= $1`,
    [since],
  );
  const delivered = Number(aggRes.rows[0]?.delivered ?? 0);
  const failed = Number(aggRes.rows[0]?.failed ?? 0);
  const total = delivered + failed;
  const successRate = total > 0 ? delivered / total : null;

  const envT = rule.webhookSuccessRate1h ?? { yellow: 0.95, red: 0.9, minVolume: 5 };
  const { yellow: yellowThreshold, red: redThreshold, minVolume, source: thresholdSource } =
    await getWebhookSuccessThresholds(envT.yellow, envT.red, envT.minVolume);

  const reasons: string[] = [];
  let status: HealthStatus = "green";
  if (total >= minVolume && successRate !== null) {
    const pct = (successRate * 100).toFixed(1);
    if (successRate < redThreshold) {
      status = "red";
      reasons.push(`Success rate ${pct}% < red ${(redThreshold * 100).toFixed(0)}% (${delivered}/${total} delivered, last 1h)`);
    } else if (successRate < yellowThreshold) {
      status = "yellow";
      reasons.push(`Success rate ${pct}% < yellow ${(yellowThreshold * 100).toFixed(0)}% (${delivered}/${total} delivered, last 1h)`);
    }
  }
  if (status === "green") {
    reasons.push(
      total === 0
        ? "No deliveries attempted in last hour (idle)"
        : `Success rate ${(successRate! * 100).toFixed(1)}% (${delivered}/${total} delivered, last 1h)`,
    );
  }
  return {
    ...baseRollup(rule, status, reasons),
    lastSuccessAt: delivered > 0 ? Date.now() : null,
    throughput24h: total,
    failureCount24h: failed,
    failureRate24h: successRate !== null ? 1 - successRate : null,
    meta: {
      delivered1h: delivered,
      failed1h: failed,
      successRate1h: successRate,
      thresholds: { yellow: `${(yellowThreshold * 100).toFixed(0)}%`, red: `${(redThreshold * 100).toFixed(0)}%`, label: "success rate", direction: "floor" as const, minVolume, source: thresholdSource, currentValue: successRate !== null ? `${(successRate * 100).toFixed(1)}%` : "n/a" },
    },
  };
}

// ── duplicate_deal_races: in-process ring-buffer counter ─────────────────

export async function evalDuplicateDealRaces(rule: SubsystemRule): Promise<SubsystemRollup> {
  const stats = getDuplicateDealRaceStats(60 * 60 * 1000);
  const reasons: string[] = [];
  let status: HealthStatus = "green";

  const envThresholds = rule.duplicateDealRacesPerHour ?? { yellow: 5, red: 20 };
  const { yellow: yellowThreshold, red: redThreshold, source: thresholdSource } =
    await getDupeDealRaceThresholds(envThresholds.yellow, envThresholds.red);

  if (stats.count >= redThreshold) {
    status = "red";
    reasons.push(`${stats.count} duplicate-deal races in last hour >= red threshold ${redThreshold}`);
  } else if (stats.count >= yellowThreshold) {
    status = "yellow";
    reasons.push(`${stats.count} duplicate-deal races in last hour >= yellow threshold ${yellowThreshold}`);
  }

  if (status === "green") {
    reasons.push(`${stats.count} duplicate-deal races in last hour (within thresholds)`);
  }
  return {
    ...baseRollup(rule, status, reasons),
    lastSuccessAt: Date.now(),
    throughput24h: stats.count,
    failureCount24h: stats.count,
    meta: {
      totalRacesSinceBoot: stats.total,
      windowMs: stats.windowMs,
      thresholds: {
        yellow: String(yellowThreshold),
        red: String(redThreshold),
        label: "races/hr",
        direction: "ceil" as const,
        source: thresholdSource,
        currentValue: String(stats.count),
      },
    },
  };
}

// ── shared decision logic ────────────────────────────────────────────────

interface DecisionInputs {
  lastSuccessAt: number | null;
  failureRate: number | null;
  throughput24h: number;
}

function decide(
  rule: SubsystemRule,
  inputs: DecisionInputs,
): { status: HealthStatus; reasons: string[] } {
  const reasons: string[] = [];
  let level: HealthStatus = "green";

  const ageMin = inputs.lastSuccessAt
    ? (Date.now() - inputs.lastSuccessAt) / 60_000
    : Number.POSITIVE_INFINITY;
  if (inputs.lastSuccessAt === null) {
    reasons.push("No successful run on record");
  } else {
    if (ageMin >= rule.staleAfterMinutes.red) {
      level = worse(level, "red");
      reasons.push(
        `Last success ${Math.round(ageMin)} min ago (red threshold ${rule.staleAfterMinutes.red} min)`,
      );
    } else if (ageMin >= rule.staleAfterMinutes.yellow) {
      level = worse(level, "yellow");
      reasons.push(
        `Last success ${Math.round(ageMin)} min ago (yellow threshold ${rule.staleAfterMinutes.yellow} min)`,
      );
    }
  }

  if (rule.maxFailureRate24h && inputs.failureRate !== null) {
    const pct = (inputs.failureRate * 100).toFixed(1);
    if (inputs.failureRate >= rule.maxFailureRate24h.red) {
      level = worse(level, "red");
      reasons.push(`24h failure rate ${pct}% ≥ red ${(rule.maxFailureRate24h.red * 100).toFixed(0)}%`);
    } else if (inputs.failureRate >= rule.maxFailureRate24h.yellow) {
      level = worse(level, "yellow");
      reasons.push(`24h failure rate ${pct}% ≥ yellow ${(rule.maxFailureRate24h.yellow * 100).toFixed(0)}%`);
    }
  }

  if (rule.minThroughput24h) {
    if (inputs.throughput24h < rule.minThroughput24h.red) {
      level = worse(level, "red");
      reasons.push(`24h throughput ${inputs.throughput24h} below red ${rule.minThroughput24h.red}`);
    } else if (inputs.throughput24h < rule.minThroughput24h.yellow) {
      level = worse(level, "yellow");
      reasons.push(`24h throughput ${inputs.throughput24h} below yellow ${rule.minThroughput24h.yellow}`);
    }
  }

  if (level === "green" && reasons.length === 0) reasons.push("Within all thresholds");
  return { status: level, reasons };
}

const SEVERITY_RANK: Record<HealthStatus, number> = {
  green: 0,
  paused: 0,
  unknown: 1,
  yellow: 2,
  red: 3,
};
function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}
