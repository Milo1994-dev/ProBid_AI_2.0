import crypto from "crypto";
import OpenAI from "openai";
import { db } from "./db.js";
import { eq, and, desc } from "drizzle-orm";
import {
  procoreProjects,
  shadowEstimates,
  procoreBudgetItems,
} from "../shared/schema.js";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

interface ShadowEstimateResult {
  low: number;
  base: number;
  high: number;
  details: string;
  confidence: number;
}

export async function generateShadowEstimate(
  projectId: string
): Promise<ShadowEstimateResult> {
  const projectResult = await db
    .select()
    .from(procoreProjects)
    .where(eq(procoreProjects.id, projectId));

  const project = projectResult[0];
  if (!project) {
    throw new Error("Project not found");
  }

  const budgetItems = await db
    .select()
    .from(procoreBudgetItems)
    .where(eq(procoreBudgetItems.projectId, projectId));

  const costCodeSummary = budgetItems
    .map(
      (item) =>
        `${item.costCode}: ${item.costCodeDescription} - Budget: $${item.budgetedAmountUsd?.toLocaleString()}`
    )
    .join("\n");

  const prompt = `You are a construction cost estimator. Based on the following project details, generate a cost estimate with low, base, and high ranges.

PROJECT DETAILS:
- Name: ${project.name}
- Trade: ${project.trade || "General Construction"}
- Location: ${project.city}, ${project.state} ${project.zipCode}
- Address: ${project.address}
- Project Value: $${project.projectValueUsd?.toLocaleString() || "Unknown"}

COST CODE BREAKDOWN:
${costCodeSummary || "No detailed cost codes available"}

Generate a realistic cost estimate considering:
1. Current market rates in ${project.state || "the US"}
2. Material costs
3. Labor rates
4. Project complexity
5. Regional variations

Respond ONLY with a valid JSON object in this exact format:
{
  "low": <number - lowest reasonable estimate>,
  "base": <number - most likely estimate>,
  "high": <number - highest reasonable estimate>,
  "details": "<string - brief explanation of estimate methodology>",
  "confidence": <number 0-100 - confidence level>
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are an expert construction cost estimator with deep knowledge of material costs, labor rates, and regional pricing variations. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.3,
    max_tokens: 500,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from AI");
  }

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    const result = JSON.parse(jsonMatch[0]);
    return {
      low: Number(result.low) || 0,
      base: Number(result.base) || 0,
      high: Number(result.high) || 0,
      details: String(result.details) || "",
      confidence: Number(result.confidence) || 50,
    };
  } catch (err) {
    console.error("Failed to parse AI response:", content);
    throw new Error("Failed to parse estimate response");
  }
}

export async function createShadowEstimate(projectId: string): Promise<string> {
  const result = await generateShadowEstimate(projectId);

  const id = crypto.randomUUID();
  const now = Date.now();

  await db.insert(shadowEstimates).values({
    id,
    projectId,
    probidEstimateLow: result.low,
    probidEstimateBase: result.base,
    probidEstimateHigh: result.high,
    estimateDetails: result.details,
    generatedAt: now,
    modelVersion: "gpt-4o",
    inputHash: crypto
      .createHash("sha256")
      .update(projectId + now)
      .digest("hex")
      .slice(0, 16),
  });

  return id;
}

export async function runShadowEstimatesForConnection(
  connectionId: string
): Promise<{ processed: number; errors: number }> {
  const projects = await db
    .select()
    .from(procoreProjects)
    .where(
      and(
        eq(procoreProjects.connectionId, connectionId),
        eq(procoreProjects.isClosed, 1)
      )
    );

  let processed = 0;
  let errors = 0;

  for (const project of projects) {
    const existingResult = await db
      .select({ id: shadowEstimates.id })
      .from(shadowEstimates)
      .where(eq(shadowEstimates.projectId, project.id))
      .limit(1);

    if (existingResult.length > 0) {
      continue;
    }

    try {
      await createShadowEstimate(project.id);
      processed++;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err) {
      console.error(`Failed to generate shadow estimate for ${project.id}:`, err);
      errors++;
    }
  }

  return { processed, errors };
}

export async function getShadowEstimate(projectId: string) {
  const result = await db
    .select()
    .from(shadowEstimates)
    .where(eq(shadowEstimates.projectId, projectId))
    .orderBy(desc(shadowEstimates.generatedAt))
    .limit(1);

  return result[0];
}

export async function getProjectComparison(projectId: string) {
  const projectResult = await db
    .select()
    .from(procoreProjects)
    .where(eq(procoreProjects.id, projectId));

  const project = projectResult[0];
  if (!project) {
    throw new Error("Project not found");
  }

  const shadowResult = await db
    .select()
    .from(shadowEstimates)
    .where(eq(shadowEstimates.projectId, projectId))
    .orderBy(desc(shadowEstimates.generatedAt))
    .limit(1);

  const shadow = shadowResult[0];

  const comparison = {
    project: {
      id: project.id,
      name: project.name,
      trade: project.trade,
      location: `${project.city}, ${project.state}`,
      closeDate: project.closeDate,
    },
    baseline: {
      estimate: project.originalEstimateUsd,
      actual: project.actualCostUsd,
      variance: project.originalEstimateUsd && project.actualCostUsd
        ? project.originalEstimateUsd - project.actualCostUsd
        : null,
      variancePct: project.originalEstimateUsd && project.actualCostUsd
        ? ((project.originalEstimateUsd - project.actualCostUsd) / project.actualCostUsd) * 100
        : null,
    },
    probid: shadow
      ? {
          estimateLow: shadow.probidEstimateLow,
          estimateBase: shadow.probidEstimateBase,
          estimateHigh: shadow.probidEstimateHigh,
          variance: shadow.probidEstimateBase && project.actualCostUsd
            ? shadow.probidEstimateBase - project.actualCostUsd
            : null,
          variancePct: shadow.probidEstimateBase && project.actualCostUsd
            ? ((shadow.probidEstimateBase - project.actualCostUsd) / project.actualCostUsd) * 100
            : null,
          withinBand:
            shadow.probidEstimateLow &&
            shadow.probidEstimateHigh &&
            project.actualCostUsd
              ? project.actualCostUsd >= shadow.probidEstimateLow &&
                project.actualCostUsd <= shadow.probidEstimateHigh
              : null,
          details: shadow.estimateDetails,
        }
      : null,
    changeOrders: {
      count: project.changeOrderCount,
      value: project.changeOrderValueUsd,
      rate: project.projectValueUsd && project.changeOrderValueUsd
        ? (project.changeOrderValueUsd / project.projectValueUsd) * 100
        : null,
    },
  };

  return comparison;
}

export async function getAllProjectComparisons(connectionId: string) {
  const projects = await db
    .select()
    .from(procoreProjects)
    .where(
      and(
        eq(procoreProjects.connectionId, connectionId),
        eq(procoreProjects.isClosed, 1)
      )
    )
    .orderBy(desc(procoreProjects.closeDate));

  const comparisons = [];

  for (const project of projects) {
    try {
      const comparison = await getProjectComparison(project.id);
      comparisons.push(comparison);
    } catch (err) {
      console.error(`Failed to get comparison for ${project.id}:`, err);
    }
  }

  return comparisons;
}
