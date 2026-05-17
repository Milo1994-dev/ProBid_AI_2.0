import crypto from "crypto";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { db } from "./db.js";
import { eq, and, desc } from "drizzle-orm";
import {
  procoreConnections,
  procoreProjects,
  shadowEstimates,
  proofAssets,
} from "../shared/schema.js";
import { getLatestMetrics, calculatePercentiles } from "./metrics-engine.js";
import { getAllProjectComparisons } from "./shadow-estimator.js";

const PROOF_DIR = path.join(process.cwd(), "uploads", "proofs");

if (!fs.existsSync(PROOF_DIR)) {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
}

interface AccuracyReportData {
  companyName: string;
  totalProjects: number;
  metrics: {
    accuracyErrorPct: number;
    confidenceCalibration: number;
    timeSavedHours: number;
    marginDelta: number;
  };
  percentiles: {
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  };
  projectComparisons: any[];
  generatedAt: string;
}

export async function generateAccuracyReportData(
  connectionId: string
): Promise<AccuracyReportData> {
  const connectionResult = await db
    .select()
    .from(procoreConnections)
    .where(eq(procoreConnections.id, connectionId));

  const connection = connectionResult[0];
  if (!connection) {
    throw new Error("Connection not found");
  }

  const metrics = await getLatestMetrics(connectionId);
  const comparisons = await getAllProjectComparisons(connectionId);

  const errors = comparisons
    .filter((c) => c.probid?.variancePct != null)
    .map((c) => Math.abs(c.probid.variancePct));

  const percentiles = calculatePercentiles(errors);

  return {
    companyName: connection.companyName || "Unknown Company",
    totalProjects: comparisons.length,
    metrics: {
      accuracyErrorPct: metrics.accuracy_error_pct?.value || 0,
      confidenceCalibration: metrics.confidence_calibration?.value || 0,
      timeSavedHours: metrics.time_saved_hours?.value || 0,
      marginDelta: metrics.margin_delta?.value || 0,
    },
    percentiles: {
      p25: percentiles.p25,
      p50: percentiles.p50,
      p75: percentiles.p75,
      p90: percentiles.p90,
    },
    projectComparisons: comparisons,
    generatedAt: new Date().toISOString(),
  };
}

export async function generateAccuracyReportPDF(
  connectionId: string
): Promise<string> {
  const data = await generateAccuracyReportData(connectionId);
  const filename = `accuracy-report-${connectionId}-${Date.now()}.pdf`;
  const filepath = path.join(PROOF_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filepath);

    doc.pipe(stream);

    doc.fontSize(24).text("ProBid Accuracy Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(14).text(`Company: ${data.companyName}`, { align: "center" });
    doc.fontSize(12).text(`Generated: ${new Date().toLocaleDateString()}`, { align: "center" });
    doc.moveDown(2);

    doc.fontSize(18).text("Executive Summary", { underline: true });
    doc.moveDown();
    doc.fontSize(12);
    doc.text(`Total Projects Analyzed: ${data.totalProjects}`);
    doc.text(`Median Estimate Error: ${data.percentiles.p50.toFixed(1)}%`);
    doc.text(`Confidence Calibration: ${data.metrics.confidenceCalibration.toFixed(1)}% within bands`);
    doc.text(`Average Time Saved: ${data.metrics.timeSavedHours.toFixed(1)} hours per estimate`);
    doc.moveDown(2);

    doc.fontSize(18).text("Accuracy Distribution", { underline: true });
    doc.moveDown();
    doc.fontSize(12);
    doc.text(`P25 (Best 25%): ${data.percentiles.p25.toFixed(1)}% error`);
    doc.text(`P50 (Median): ${data.percentiles.p50.toFixed(1)}% error`);
    doc.text(`P75: ${data.percentiles.p75.toFixed(1)}% error`);
    doc.text(`P90: ${data.percentiles.p90.toFixed(1)}% error`);
    doc.moveDown(2);

    doc.fontSize(18).text("Project-by-Project Comparison", { underline: true });
    doc.moveDown();

    const tableTop = doc.y;
    const tableHeaders = ["Project", "Baseline Error", "ProBid Error", "Within Band"];
    const colWidths = [180, 100, 100, 80];
    let xPos = 50;

    doc.fontSize(10).font("Helvetica-Bold");
    tableHeaders.forEach((header, i) => {
      doc.text(header, xPos, tableTop, { width: colWidths[i] });
      xPos += colWidths[i];
    });

    doc.font("Helvetica").fontSize(9);
    let yPos = tableTop + 20;

    for (const comparison of data.projectComparisons.slice(0, 15)) {
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }

      xPos = 50;
      const projectName = comparison.project.name.slice(0, 25);
      const baselineError = comparison.baseline.variancePct != null
        ? `${comparison.baseline.variancePct.toFixed(1)}%`
        : "N/A";
      const probidError = comparison.probid?.variancePct != null
        ? `${comparison.probid.variancePct.toFixed(1)}%`
        : "N/A";
      const withinBand = comparison.probid?.withinBand != null
        ? (comparison.probid.withinBand ? "Yes" : "No")
        : "N/A";

      doc.text(projectName, xPos, yPos, { width: colWidths[0] });
      xPos += colWidths[0];
      doc.text(baselineError, xPos, yPos, { width: colWidths[1] });
      xPos += colWidths[1];
      doc.text(probidError, xPos, yPos, { width: colWidths[2] });
      xPos += colWidths[2];
      doc.text(withinBand, xPos, yPos, { width: colWidths[3] });

      yPos += 15;
    }

    doc.addPage();
    doc.fontSize(18).text("Methodology", { underline: true });
    doc.moveDown();
    doc.fontSize(11);
    doc.text(
      "This report compares ProBid AI-generated estimates against actual project costs from Procore. " +
      "All data is sourced directly from your Procore account via read-only OAuth access. " +
      "Metrics are calculated using the following formulas:",
      { align: "left" }
    );
    doc.moveDown();
    doc.text("Estimate Error % = |ProBid Estimate - Actual Cost| / Actual Cost × 100");
    doc.moveDown();
    doc.text("Confidence Calibration = % of actuals within ProBid low/base/high bands");
    doc.moveDown(2);

    doc.fontSize(10).fillColor("gray");
    doc.text(
      "This report was generated by ProBid using data from your Procore account. " +
      "You can verify all calculations by exporting the raw data.",
      50,
      doc.page.height - 80,
      { align: "center", width: doc.page.width - 100 }
    );

    doc.end();

    stream.on("finish", () => resolve(filepath));
    stream.on("error", reject);
  });
}

export async function generateMarkdownReport(
  connectionId: string
): Promise<string> {
  const data = await generateAccuracyReportData(connectionId);

  let md = `# ProBid Accuracy Report

**Company:** ${data.companyName}  
**Generated:** ${new Date().toLocaleDateString()}  
**Projects Analyzed:** ${data.totalProjects}

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Median Estimate Error | ${data.percentiles.p50.toFixed(1)}% |
| Confidence Calibration | ${data.metrics.confidenceCalibration.toFixed(1)}% |
| Avg. Time Saved | ${data.metrics.timeSavedHours.toFixed(1)} hours |
| Avg. Margin Impact | $${data.metrics.marginDelta.toLocaleString()} |

---

## Accuracy Distribution

| Percentile | Error Rate |
|------------|------------|
| P25 (Best 25%) | ${data.percentiles.p25.toFixed(1)}% |
| P50 (Median) | ${data.percentiles.p50.toFixed(1)}% |
| P75 | ${data.percentiles.p75.toFixed(1)}% |
| P90 | ${data.percentiles.p90.toFixed(1)}% |

---

## Project Comparisons

| Project | Baseline Error | ProBid Error | Within Band |
|---------|---------------|--------------|-------------|
`;

  for (const comparison of data.projectComparisons) {
    const projectName = comparison.project.name.slice(0, 30);
    const baselineError = comparison.baseline.variancePct != null
      ? `${comparison.baseline.variancePct.toFixed(1)}%`
      : "N/A";
    const probidError = comparison.probid?.variancePct != null
      ? `${comparison.probid.variancePct.toFixed(1)}%`
      : "N/A";
    const withinBand = comparison.probid?.withinBand != null
      ? (comparison.probid.withinBand ? "✅" : "❌")
      : "N/A";

    md += `| ${projectName} | ${baselineError} | ${probidError} | ${withinBand} |\n`;
  }

  md += `
---

## Methodology

All data sourced directly from Procore via read-only OAuth.

**Formulas:**
- Estimate Error % = |ProBid Estimate - Actual Cost| / Actual Cost × 100
- Confidence Calibration = % of actuals within ProBid low/base/high bands

---

*"If you don't believe us, export the data and verify it."*
`;

  return md;
}

export async function generateChartData(connectionId: string) {
  const comparisons = await getAllProjectComparisons(connectionId);

  const accuracyDistribution = comparisons
    .filter((c) => c.probid?.variancePct != null)
    .map((c) => ({
      project: c.project.name.slice(0, 20),
      baselineError: Math.abs(c.baseline.variancePct || 0),
      probidError: Math.abs(c.probid.variancePct || 0),
      withinBand: c.probid.withinBand,
    }));

  const histogramBuckets = [
    { range: "0-2%", count: 0 },
    { range: "2-5%", count: 0 },
    { range: "5-10%", count: 0 },
    { range: "10-15%", count: 0 },
    { range: "15-20%", count: 0 },
    { range: "20%+", count: 0 },
  ];

  for (const c of accuracyDistribution) {
    const error = c.probidError;
    if (error < 2) histogramBuckets[0].count++;
    else if (error < 5) histogramBuckets[1].count++;
    else if (error < 10) histogramBuckets[2].count++;
    else if (error < 15) histogramBuckets[3].count++;
    else if (error < 20) histogramBuckets[4].count++;
    else histogramBuckets[5].count++;
  }

  const baselineVsProbid = comparisons
    .filter((c) => c.baseline.variancePct != null && c.probid?.variancePct != null)
    .map((c) => ({
      project: c.project.name.slice(0, 15),
      baseline: Math.abs(c.baseline.variancePct),
      probid: Math.abs(c.probid.variancePct),
      improvement: Math.abs(c.baseline.variancePct) - Math.abs(c.probid.variancePct),
    }));

  const wins = baselineVsProbid.filter((p) => p.improvement > 0).length;
  const total = baselineVsProbid.length;

  return {
    accuracyDistribution,
    histogram: histogramBuckets,
    baselineVsProbid,
    summary: {
      totalProjects: total,
      probidWins: wins,
      winRate: total > 0 ? (wins / total) * 100 : 0,
    },
  };
}

export async function saveProofAsset(
  connectionId: string,
  assetType: string,
  title: string,
  content: string,
  filePath?: string
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await db.insert(proofAssets).values({
    id,
    connectionId,
    assetType,
    title,
    content,
    filePath,
    isPublic: 0,
    createdAt: now,
  });

  return id;
}

export async function approveProofAsset(
  assetId: string,
  approvedBy: string
): Promise<void> {
  const now = Date.now();

  await db
    .update(proofAssets)
    .set({
      isPublic: 1,
      approvedAt: now,
      approvedBy,
    })
    .where(eq(proofAssets.id, assetId));
}

export async function getProofAssets(connectionId: string) {
  return db
    .select()
    .from(proofAssets)
    .where(eq(proofAssets.connectionId, connectionId))
    .orderBy(desc(proofAssets.createdAt));
}

export async function getPublicProofAssets() {
  return db
    .select()
    .from(proofAssets)
    .where(eq(proofAssets.isPublic, 1))
    .orderBy(desc(proofAssets.approvedAt));
}

export async function generateSalesCopy(connectionId: string): Promise<string> {
  const data = await generateAccuracyReportData(connectionId);

  const copy = `## Procore-Verified Results

**${data.totalProjects} closed projects. Real numbers. No guesswork.**

### The Results Speak for Themselves

- **${data.percentiles.p50.toFixed(1)}%** median estimate accuracy
- **${data.metrics.confidenceCalibration.toFixed(0)}%** of actuals fell within our confidence bands
- **${data.metrics.timeSavedHours.toFixed(1)} hours** saved per estimate

### How We Prove It

We don't ask you to trust marketing claims. We connect to your Procore account (read-only), analyze your closed projects, and show you exactly how ProBid would have performed.

- Direct Procore integration
- Your historical data, your projects
- Exportable calculations you can verify

### The Challenge

"If you don't believe the numbers, export the CSV and check the math yourself."

---

*Measured on ${data.totalProjects} closed Procore jobs. Generated ${new Date().toLocaleDateString()}.*
`;

  return copy;
}

export async function generateInvestorNarrative(
  connectionId: string
): Promise<string> {
  const data = await generateAccuracyReportData(connectionId);

  const narrative = `# ProBid Trust Engine: Investor Brief

## The Credibility Problem

Every construction estimating tool claims accuracy. None can prove it.

## Our Solution: Procore as the Source of Truth

ProBid connects directly to contractors' Procore accounts and measures our estimates against their actual project outcomes.

### Key Metrics (Real Data)

| Metric | Value | Sample |
|--------|-------|--------|
| Median Accuracy | ${data.percentiles.p50.toFixed(1)}% | ${data.totalProjects} projects |
| Calibration Rate | ${data.metrics.confidenceCalibration.toFixed(0)}% | Within confidence bands |
| Time Savings | ${data.metrics.timeSavedHours.toFixed(1)} hrs | Per estimate |

## The Trust Flywheel

\`\`\`
Procore Data → ProBid Estimates → Actual Outcomes → Public Proof → More Contractors → More Data
\`\`\`

### Competitive Moat

1. **Data moat**: Every closed job improves our models
2. **Switching cost**: Historical accuracy benchmark is unique to each contractor
3. **Network effect**: More data = better benchmarks = more credibility

## Business Model

- **Free**: Shadow bids, backtesting, accuracy reports
- **Paid**: Only if ProBid outperforms baseline accuracy

## Key Insight

We didn't buy credibility. We borrowed it from Procore — and let the data speak.

---

*Generated from live Procore data. ${new Date().toLocaleDateString()}*
`;

  return narrative;
}

export async function generateCSVExport(connectionId: string): Promise<string> {
  const comparisons = await getAllProjectComparisons(connectionId);

  let csv = "project_id,project_name,trade,location,baseline_estimate_usd,probid_estimate_usd,actual_cost_usd,baseline_error_pct,probid_error_pct,within_band,change_order_count,change_order_value_usd\n";

  for (const c of comparisons) {
    const row = [
      c.project.id,
      `"${c.project.name.replace(/"/g, '""')}"`,
      c.project.trade || "",
      `"${c.project.location}"`,
      c.baseline.estimate || "",
      c.probid?.estimateBase || "",
      c.baseline.actual || "",
      c.baseline.variancePct?.toFixed(2) || "",
      c.probid?.variancePct?.toFixed(2) || "",
      c.probid?.withinBand != null ? (c.probid.withinBand ? "true" : "false") : "",
      c.changeOrders.count || 0,
      c.changeOrders.value || 0,
    ].join(",");

    csv += row + "\n";
  }

  return csv;
}
