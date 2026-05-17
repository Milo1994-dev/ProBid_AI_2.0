import crypto from "crypto";
import { db } from "./db.js";
import { eq, and, desc, sql, count, avg, gte, lte } from "drizzle-orm";
import {
  procoreConnections,
  procoreProjects,
  shadowEstimates,
  procoreMetrics,
  aggregateBenchmarks,
} from "../shared/schema.js";

export interface AccuracyMetrics {
  estimateErrorPct: number;
  estimateErrorPctP25: number;
  estimateErrorPctP50: number;
  estimateErrorPctP75: number;
  estimateErrorPctP90: number;
  sampleSize: number;
  withinBandPct: number;
}

export interface ROIMetrics {
  avgTimeSavedHours: number;
  avgMarginDelta: number;
  totalProjectsAnalyzed: number;
}

export interface ChangeOrderMetrics {
  avgChangeOrderRate: number;
  avgChangeOrderValue: number;
  projectsWithChangeOrders: number;
}

export function calculateEstimateError(
  probidEstimate: number,
  actualCost: number
): number {
  if (actualCost === 0) return 0;
  return Math.abs(probidEstimate - actualCost) / actualCost * 100;
}

export function calculateMarginDelta(
  baselineEstimate: number,
  probidEstimate: number,
  actualCost: number
): number {
  const baselineMargin = baselineEstimate - actualCost;
  const probidMargin = probidEstimate - actualCost;
  return probidMargin - baselineMargin;
}

export function calculateChangeOrderRate(
  changeOrderValue: number,
  projectValue: number
): number {
  if (projectValue === 0) return 0;
  return changeOrderValue / projectValue * 100;
}

export function calculatePercentiles(values: number[]): {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  mean: number;
} {
  if (values.length === 0) {
    return { p25: 0, p50: 0, p75: 0, p90: 0, mean: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const percentile = (p: number) => {
    const index = (p / 100) * (n - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
  };

  const mean = values.reduce((a, b) => a + b, 0) / n;

  return {
    p25: percentile(25),
    p50: percentile(50),
    p75: percentile(75),
    p90: percentile(90),
    mean,
  };
}

export function isWithinConfidenceBand(
  actual: number,
  low: number,
  high: number
): boolean {
  return actual >= low && actual <= high;
}

export async function calculateAccuracyMetrics(
  connectionId: string
): Promise<AccuracyMetrics> {
  const projects = await db
    .select({
      id: procoreProjects.id,
      actualCostUsd: procoreProjects.actualCostUsd,
    })
    .from(procoreProjects)
    .where(
      and(
        eq(procoreProjects.connectionId, connectionId),
        eq(procoreProjects.isClosed, 1)
      )
    );

  const errors: number[] = [];
  let withinBandCount = 0;

  for (const project of projects) {
    const shadowResult = await db
      .select()
      .from(shadowEstimates)
      .where(eq(shadowEstimates.projectId, project.id))
      .orderBy(desc(shadowEstimates.generatedAt))
      .limit(1);

    const shadow = shadowResult[0];
    if (shadow && project.actualCostUsd) {
      const baseEstimate = shadow.probidEstimateBase || 0;
      const error = calculateEstimateError(baseEstimate, project.actualCostUsd);
      errors.push(error);

      if (
        shadow.probidEstimateLow &&
        shadow.probidEstimateHigh &&
        isWithinConfidenceBand(
          project.actualCostUsd,
          shadow.probidEstimateLow,
          shadow.probidEstimateHigh
        )
      ) {
        withinBandCount++;
      }
    }
  }

  const percentiles = calculatePercentiles(errors);

  return {
    estimateErrorPct: percentiles.mean,
    estimateErrorPctP25: percentiles.p25,
    estimateErrorPctP50: percentiles.p50,
    estimateErrorPctP75: percentiles.p75,
    estimateErrorPctP90: percentiles.p90,
    sampleSize: errors.length,
    withinBandPct: errors.length > 0 ? (withinBandCount / errors.length) * 100 : 0,
  };
}

export async function calculateROIMetrics(
  connectionId: string,
  baselineHoursPerEstimate: number = 4
): Promise<ROIMetrics> {
  const projects = await db
    .select({
      id: procoreProjects.id,
      originalEstimateUsd: procoreProjects.originalEstimateUsd,
      actualCostUsd: procoreProjects.actualCostUsd,
    })
    .from(procoreProjects)
    .where(
      and(
        eq(procoreProjects.connectionId, connectionId),
        eq(procoreProjects.isClosed, 1)
      )
    );

  let totalMarginDelta = 0;
  let validCount = 0;
  const probidHoursPerEstimate = 0.25;

  for (const project of projects) {
    const shadowResult = await db
      .select()
      .from(shadowEstimates)
      .where(eq(shadowEstimates.projectId, project.id))
      .orderBy(desc(shadowEstimates.generatedAt))
      .limit(1);

    const shadow = shadowResult[0];
    if (shadow && project.originalEstimateUsd && project.actualCostUsd) {
      const marginDelta = calculateMarginDelta(
        project.originalEstimateUsd,
        shadow.probidEstimateBase || 0,
        project.actualCostUsd
      );
      totalMarginDelta += marginDelta;
      validCount++;
    }
  }

  const timeSavedPerProject = baselineHoursPerEstimate - probidHoursPerEstimate;

  return {
    avgTimeSavedHours: timeSavedPerProject,
    avgMarginDelta: validCount > 0 ? totalMarginDelta / validCount : 0,
    totalProjectsAnalyzed: projects.length,
  };
}

export async function calculateChangeOrderMetrics(
  connectionId: string
): Promise<ChangeOrderMetrics> {
  const projects = await db
    .select({
      projectValueUsd: procoreProjects.projectValueUsd,
      changeOrderCount: procoreProjects.changeOrderCount,
      changeOrderValueUsd: procoreProjects.changeOrderValueUsd,
    })
    .from(procoreProjects)
    .where(
      and(
        eq(procoreProjects.connectionId, connectionId),
        eq(procoreProjects.isClosed, 1)
      )
    );

  let totalChangeOrderRate = 0;
  let totalChangeOrderValue = 0;
  let projectsWithCOs = 0;

  for (const project of projects) {
    if (project.projectValueUsd && project.changeOrderValueUsd) {
      const rate = calculateChangeOrderRate(
        project.changeOrderValueUsd,
        project.projectValueUsd
      );
      totalChangeOrderRate += rate;
      totalChangeOrderValue += project.changeOrderValueUsd;
    }
    if ((project.changeOrderCount || 0) > 0) {
      projectsWithCOs++;
    }
  }

  return {
    avgChangeOrderRate:
      projects.length > 0 ? totalChangeOrderRate / projects.length : 0,
    avgChangeOrderValue:
      projects.length > 0 ? totalChangeOrderValue / projects.length : 0,
    projectsWithChangeOrders: projectsWithCOs,
  };
}

export async function saveMetrics(
  connectionId: string,
  projectId: string | null,
  metricType: string,
  value: number,
  sampleSize: number,
  metadata?: Record<string, any>
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await db.insert(procoreMetrics).values({
    id,
    connectionId,
    projectId,
    metricType,
    value,
    sampleSize,
    metadata: metadata ? JSON.stringify(metadata) : null,
    calculatedAt: now,
  });

  return id;
}

export async function calculateAndSaveAllMetrics(
  connectionId: string
): Promise<void> {
  const accuracy = await calculateAccuracyMetrics(connectionId);
  const roi = await calculateROIMetrics(connectionId);
  const changeOrders = await calculateChangeOrderMetrics(connectionId);

  await saveMetrics(connectionId, null, "accuracy_error_pct", accuracy.estimateErrorPct, accuracy.sampleSize, {
    p25: accuracy.estimateErrorPctP25,
    p50: accuracy.estimateErrorPctP50,
    p75: accuracy.estimateErrorPctP75,
    p90: accuracy.estimateErrorPctP90,
  });

  await saveMetrics(connectionId, null, "confidence_calibration", accuracy.withinBandPct, accuracy.sampleSize);

  await saveMetrics(connectionId, null, "time_saved_hours", roi.avgTimeSavedHours, roi.totalProjectsAnalyzed);
  await saveMetrics(connectionId, null, "margin_delta", roi.avgMarginDelta, roi.totalProjectsAnalyzed);

  await saveMetrics(connectionId, null, "change_order_rate", changeOrders.avgChangeOrderRate, changeOrders.projectsWithChangeOrders);
}

export async function updateAggregateBenchmarks(): Promise<void> {
  const now = Date.now();

  const allMetrics = await db
    .select({
      metricType: procoreMetrics.metricType,
      value: procoreMetrics.value,
    })
    .from(procoreMetrics)
    .where(eq(procoreMetrics.metricType, "accuracy_error_pct"));

  const values = allMetrics.map((m) => m.value);
  const percentiles = calculatePercentiles(values);

  const benchmarkId = crypto.randomUUID();
  await db
    .insert(aggregateBenchmarks)
    .values({
      id: benchmarkId,
      benchmarkType: "accuracy_error_pct",
      sampleSize: values.length,
      p25: percentiles.p25,
      p50: percentiles.p50,
      p75: percentiles.p75,
      p90: percentiles.p90,
      mean: percentiles.mean,
      calculatedAt: now,
    });
}

export async function getLatestMetrics(connectionId: string) {
  const metricTypes = [
    "accuracy_error_pct",
    "confidence_calibration",
    "time_saved_hours",
    "margin_delta",
    "change_order_rate",
  ];

  const results: Record<string, any> = {};

  for (const type of metricTypes) {
    const result = await db
      .select()
      .from(procoreMetrics)
      .where(
        and(
          eq(procoreMetrics.connectionId, connectionId),
          eq(procoreMetrics.metricType, type)
        )
      )
      .orderBy(desc(procoreMetrics.calculatedAt))
      .limit(1);

    if (result[0]) {
      results[type] = {
        value: result[0].value,
        sampleSize: result[0].sampleSize,
        metadata: result[0].metadata ? JSON.parse(result[0].metadata) : null,
        calculatedAt: result[0].calculatedAt,
      };
    }
  }

  return results;
}

export async function getPublicBenchmarks() {
  const benchmarkTypes = ["accuracy_error_pct", "time_saved_hours"];
  const results: Record<string, any> = {};

  for (const type of benchmarkTypes) {
    const result = await db
      .select()
      .from(aggregateBenchmarks)
      .where(eq(aggregateBenchmarks.benchmarkType, type))
      .orderBy(desc(aggregateBenchmarks.calculatedAt))
      .limit(1);

    if (result[0]) {
      results[type] = {
        p25: result[0].p25,
        p50: result[0].p50,
        p75: result[0].p75,
        p90: result[0].p90,
        mean: result[0].mean,
        sampleSize: result[0].sampleSize,
        calculatedAt: result[0].calculatedAt,
      };
    }
  }

  return results;
}

const MIN_SAMPLE_SIZE = 5;

export interface PublicBenchmarkData {
  overall: {
    p50ErrorPct: number;
    p80ErrorPct: number;
    sampleSize: number;
    withinBandPct: number;
    calculatedAt: number;
  } | null;
  byTrade: Array<{
    trade: string;
    p50ErrorPct: number;
    p80ErrorPct: number;
    sampleSize: number;
  }>;
  bySize: Array<{
    bucket: string;
    label: string;
    p50ErrorPct: number;
    p80ErrorPct: number;
    sampleSize: number;
  }>;
  lastUpdatedAt: number | null;
}

export async function updatePublicBenchmarksFromConsenting(): Promise<{ projectsIncluded: number; connectionsIncluded: number }> {
  const now = Date.now();

  const consentingConnections = await db
    .select()
    .from(procoreConnections)
    .where(
      and(
        eq(procoreConnections.status, "active"),
        eq(procoreConnections.includeInPublicBenchmarks, 1)
      )
    );

  if (consentingConnections.length === 0) {
    await db.transaction(async (tx) => {
      await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy"));
      await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_trade"));
      await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_size"));
    });
    return { projectsIncluded: 0, connectionsIncluded: 0 };
  }

  interface ErrorEntry {
    errorPct: number;
    withinBand: boolean;
    trade: string | null;
    actualCostUsd: number | null;
  }

  const allErrors: ErrorEntry[] = [];

  for (const connection of consentingConnections) {
    const projects = await db
      .select({
        id: procoreProjects.id,
        trade: procoreProjects.trade,
        actualCostUsd: procoreProjects.actualCostUsd,
      })
      .from(procoreProjects)
      .where(
        and(
          eq(procoreProjects.connectionId, connection.id),
          eq(procoreProjects.isClosed, 1)
        )
      );

    for (const project of projects) {
      if (!project.actualCostUsd) continue;

      const shadowResult = await db
        .select()
        .from(shadowEstimates)
        .where(eq(shadowEstimates.projectId, project.id))
        .orderBy(desc(shadowEstimates.generatedAt))
        .limit(1);

      const shadow = shadowResult[0];
      if (!shadow || !shadow.probidEstimateBase) continue;

      const errorPct = calculateEstimateError(shadow.probidEstimateBase, project.actualCostUsd);
      const withinBand =
        shadow.probidEstimateLow != null &&
        shadow.probidEstimateHigh != null &&
        isWithinConfidenceBand(project.actualCostUsd, shadow.probidEstimateLow, shadow.probidEstimateHigh);

      allErrors.push({
        errorPct,
        withinBand,
        trade: project.trade,
        actualCostUsd: project.actualCostUsd,
      });
    }
  }

  if (allErrors.length === 0) {
    await db.transaction(async (tx) => {
      await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy"));
      await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_trade"));
      await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_size"));
    });
    return { projectsIncluded: 0, connectionsIncluded: consentingConnections.length };
  }

  const allErrorValues = allErrors.map((e) => e.errorPct);
  const overallPercentiles = calculatePercentiles(allErrorValues);
  const p80 = (() => {
    const sorted = [...allErrorValues].sort((a, b) => a - b);
    const idx = (80 / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - idx) + sorted[upper] * (idx - lower);
  })();
  const withinBandCount = allErrors.filter((e) => e.withinBand).length;
  const withinBandPct = (withinBandCount / allErrors.length) * 100;

  type BenchmarkRow = typeof aggregateBenchmarks.$inferInsert;
  const rowsToInsert: BenchmarkRow[] = [];

  if (allErrors.length >= MIN_SAMPLE_SIZE) {
    rowsToInsert.push({
      id: crypto.randomUUID(),
      benchmarkType: "public_accuracy",
      sampleSize: allErrors.length,
      p25: overallPercentiles.p25,
      p50: overallPercentiles.p50,
      p75: overallPercentiles.p75,
      p90: overallPercentiles.p90,
      mean: overallPercentiles.mean,
      metadata: JSON.stringify({ p80, withinBandPct, connectionsIncluded: consentingConnections.length }),
      calculatedAt: now,
    });
  }

  const tradeGroups: Record<string, number[]> = {};
  for (const e of allErrors) {
    const trade = e.trade || "General";
    if (!tradeGroups[trade]) tradeGroups[trade] = [];
    tradeGroups[trade].push(e.errorPct);
  }

  for (const [trade, errors] of Object.entries(tradeGroups)) {
    if (errors.length < MIN_SAMPLE_SIZE) continue;
    const p = calculatePercentiles(errors);
    const tradeP80 = (() => {
      const sorted = [...errors].sort((a, b) => a - b);
      const idx = (80 / 100) * (sorted.length - 1);
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      if (lower === upper) return sorted[lower];
      return sorted[lower] * (upper - idx) + sorted[upper] * (idx - lower);
    })();
    rowsToInsert.push({
      id: crypto.randomUUID(),
      benchmarkType: "public_accuracy_by_trade",
      trade,
      sampleSize: errors.length,
      p25: p.p25,
      p50: p.p50,
      p75: p.p75,
      p90: p.p90,
      mean: p.mean,
      metadata: JSON.stringify({ p80: tradeP80 }),
      calculatedAt: now,
    });
  }

  const sizeBuckets: Record<string, { label: string; errors: number[] }> = {
    small: { label: "Small (<$100K)", errors: [] },
    mid: { label: "Mid ($100K–$1M)", errors: [] },
    large: { label: "Large (>$1M)", errors: [] },
  };

  for (const e of allErrors) {
    const cost = e.actualCostUsd || 0;
    if (cost < 100_000) sizeBuckets.small.errors.push(e.errorPct);
    else if (cost < 1_000_000) sizeBuckets.mid.errors.push(e.errorPct);
    else sizeBuckets.large.errors.push(e.errorPct);
  }

  for (const [bucket, { label, errors }] of Object.entries(sizeBuckets)) {
    if (errors.length < MIN_SAMPLE_SIZE) continue;
    const p = calculatePercentiles(errors);
    const bucketP80 = (() => {
      const sorted = [...errors].sort((a, b) => a - b);
      const idx = (80 / 100) * (sorted.length - 1);
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      if (lower === upper) return sorted[lower];
      return sorted[lower] * (upper - idx) + sorted[upper] * (idx - lower);
    })();
    rowsToInsert.push({
      id: crypto.randomUUID(),
      benchmarkType: "public_accuracy_by_size",
      region: bucket,
      sampleSize: errors.length,
      p25: p.p25,
      p50: p.p50,
      p75: p.p75,
      p90: p.p90,
      mean: p.mean,
      metadata: JSON.stringify({ p80: bucketP80, label }),
      calculatedAt: now,
    });
  }

  await db.transaction(async (tx) => {
    await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy"));
    await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_trade"));
    await tx.delete(aggregateBenchmarks).where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_size"));
    if (rowsToInsert.length > 0) {
      await tx.insert(aggregateBenchmarks).values(rowsToInsert);
    }
  });

  return { projectsIncluded: allErrors.length, connectionsIncluded: consentingConnections.length };
}

export async function getPublicBenchmarkData(): Promise<PublicBenchmarkData> {
  const overallResult = await db
    .select()
    .from(aggregateBenchmarks)
    .where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy"))
    .orderBy(desc(aggregateBenchmarks.calculatedAt))
    .limit(1);

  const rawOverall = overallResult[0] ?? null;
  const overall = rawOverall && rawOverall.sampleSize >= MIN_SAMPLE_SIZE ? rawOverall : null;
  const overallMeta = overall?.metadata ? JSON.parse(overall.metadata) : {};

  const tradeRows = await db
    .select()
    .from(aggregateBenchmarks)
    .where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_trade"))
    .orderBy(desc(aggregateBenchmarks.calculatedAt));

  const seenTrades = new Set<string>();
  const byTrade: PublicBenchmarkData["byTrade"] = [];
  for (const row of tradeRows) {
    if (!row.trade || seenTrades.has(row.trade)) continue;
    seenTrades.add(row.trade);
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    byTrade.push({
      trade: row.trade,
      p50ErrorPct: row.p50 ?? 0,
      p80ErrorPct: meta.p80 ?? (row.p90 ?? 0),
      sampleSize: row.sampleSize,
    });
  }

  const sizeRows = await db
    .select()
    .from(aggregateBenchmarks)
    .where(eq(aggregateBenchmarks.benchmarkType, "public_accuracy_by_size"))
    .orderBy(desc(aggregateBenchmarks.calculatedAt));

  const seenBuckets = new Set<string>();
  const bySize: PublicBenchmarkData["bySize"] = [];
  for (const row of sizeRows) {
    if (!row.region || seenBuckets.has(row.region)) continue;
    seenBuckets.add(row.region);
    const meta = row.metadata ? JSON.parse(row.metadata) : {};
    bySize.push({
      bucket: row.region,
      label: meta.label ?? row.region,
      p50ErrorPct: row.p50 ?? 0,
      p80ErrorPct: meta.p80 ?? (row.p90 ?? 0),
      sampleSize: row.sampleSize,
    });
  }

  const sizeOrder = ["small", "mid", "large"];
  bySize.sort((a, b) => sizeOrder.indexOf(a.bucket) - sizeOrder.indexOf(b.bucket));

  return {
    overall: overall
      ? {
          p50ErrorPct: overall.p50 ?? 0,
          p80ErrorPct: overallMeta.p80 ?? (overall.p90 ?? 0),
          sampleSize: overall.sampleSize,
          withinBandPct: overallMeta.withinBandPct ?? 0,
          calculatedAt: overall.calculatedAt,
        }
      : null,
    byTrade,
    bySize,
    lastUpdatedAt: overall?.calculatedAt ?? rawOverall?.calculatedAt ?? null,
  };
}
