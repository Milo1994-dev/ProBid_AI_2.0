import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";
import { db } from "../db.js";
import { eq, and, desc, sql, count } from "drizzle-orm";
import {
  pipelineStages,
  pipelineDeals,
  pipelineActivities,
  pipelineDealAttachments,
  estimates,
} from "../../shared/schema.js";
import { asyncHandler, requireAuthJson } from "../lib/middleware.js";
import { log } from "../lib/logger.js";
import { now } from "../lib/utils.js";
import { fireAutomationEvent } from "../lib/automation-engine.js";
import {
  syncEstimateStatusFromDealStage,
  syncDealForNewEstimate,
} from "../lib/pipeline-sync.js";
import { CANONICAL_STAGES } from "../lib/pipeline-stages.js";
import { attachmentUpload, uploadsDir } from "../lib/upload.js";

export { CANONICAL_STAGES };

const ALLOWED_PRIORITIES = new Set(["low", "medium", "high"]);

async function ensureStages(userId: string) {
  const existing = await db.select().from(pipelineStages).where(eq(pipelineStages.userId, userId));
  if (existing.length > 0) return existing;

  const ts = now();
  const stages = [];
  for (const s of CANONICAL_STAGES) {
    const [inserted] = await db.insert(pipelineStages).values({
      userId,
      name: s.name,
      color: s.color,
      position: s.position,
      isDefault: s.isDefault,
      isWon: s.isWon,
      isLost: s.isLost,
      createdAt: ts,
    }).returning();
    stages.push(inserted);
  }
  return stages;
}

function normalizePriority(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value).toLowerCase();
  return ALLOWED_PRIORITIES.has(s) ? s : undefined;
}

function normalizeEpochMs(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfTodayMs(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function registerPipelineRoutes(app: express.Express) {
  app.get("/api/pipeline/stages", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const stages = await ensureStages(userId);
    stages.sort((a, b) => a.position - b.position);
    res.json({ success: true, data: { stages } });
  }));

  app.post("/api/pipeline/stages", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const { name, color, position } = req.body;
    if (!name) return res.status(400).json({ success: false, error: "Name is required" });

    await ensureStages(userId);
    const maxPos = await db.select({ max: sql<number>`COALESCE(MAX(position), 0)` })
      .from(pipelineStages).where(eq(pipelineStages.userId, userId));

    const [stage] = await db.insert(pipelineStages).values({
      userId,
      name,
      color: color || "#6366f1",
      position: position ?? (maxPos[0]?.max ?? 0) + 1,
      createdAt: now(),
    }).returning();

    res.json({ success: true, data: { stage } });
  }));

  app.patch("/api/pipeline/stages/:id", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const stageId = parseInt(req.params.id);
    const { name, color, position, isWon, isLost } = req.body;

    const [existing] = await db.select().from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.userId, userId)));
    if (!existing) return res.status(404).json({ success: false, error: "Stage not found" });

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (color !== undefined) updates.color = color;
    if (position !== undefined) updates.position = position;
    if (isWon !== undefined) updates.isWon = isWon;
    if (isLost !== undefined) updates.isLost = isLost;

    const [updated] = await db.update(pipelineStages).set(updates)
      .where(eq(pipelineStages.id, stageId)).returning();
    res.json({ success: true, data: { stage: updated } });
  }));

  app.delete("/api/pipeline/stages/:id", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const stageId = parseInt(req.params.id);

    const [existing] = await db.select().from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.userId, userId)));
    if (!existing) return res.status(404).json({ success: false, error: "Stage not found" });

    const dealCount = await db.select({ count: count() }).from(pipelineDeals)
      .where(eq(pipelineDeals.stageId, stageId));
    if ((dealCount[0]?.count ?? 0) > 0) {
      return res.status(400).json({ success: false, error: "Cannot delete stage with deals. Move deals first." });
    }

    await db.delete(pipelineStages).where(eq(pipelineStages.id, stageId));
    res.json({ success: true });
  }));

  app.post("/api/pipeline/stages/reset-canonical", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;

    const userStages = await db.select().from(pipelineStages).where(eq(pipelineStages.userId, userId));
    const stageIds = userStages.map(s => s.id);

    if (stageIds.length > 0) {
      const [{ c }] = await db.select({ c: count() }).from(pipelineDeals)
        .where(eq(pipelineDeals.userId, userId)) as { c: number }[];
      if (c > 0) {
        return res.status(400).json({
          success: false,
          error: "Cannot reset stages while deals exist. Delete or move all deals first.",
        });
      }
      await db.delete(pipelineStages).where(eq(pipelineStages.userId, userId));
    }

    const ts = now();
    const inserted = [];
    for (const s of CANONICAL_STAGES) {
      const [row] = await db.insert(pipelineStages).values({
        userId,
        name: s.name,
        color: s.color,
        position: s.position,
        isDefault: s.isDefault,
        isWon: s.isWon,
        isLost: s.isLost,
        createdAt: ts,
      }).returning();
      inserted.push(row);
    }

    res.json({ success: true, data: { stages: inserted } });
  }));

  app.get("/api/pipeline/deals", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    await ensureStages(userId);

    const deals = await db.select().from(pipelineDeals)
      .where(eq(pipelineDeals.userId, userId))
      .orderBy(pipelineDeals.position);

    res.json({ success: true, data: { deals } });
  }));

  app.post("/api/pipeline/deals", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const {
      title, stageId, value, clientName, clientEmail, clientPhone, description,
      projectAddress, projectType, priority, nextAction,
      expectedStartDate, followUpDate,
      estimateId, leadId, probability, expectedCloseDate,
    } = req.body;

    if (!title) return res.status(400).json({ success: false, error: "Title is required" });

    const stages = await ensureStages(userId);
    let targetStageId = stageId;
    if (!targetStageId) {
      const defaultStage = stages.find(s => s.isDefault);
      targetStageId = defaultStage?.id ?? stages[0]?.id;
    }

    const [validStage] = await db.select().from(pipelineStages)
      .where(and(eq(pipelineStages.id, targetStageId), eq(pipelineStages.userId, userId)));
    if (!validStage) return res.status(400).json({ success: false, error: "Invalid stage" });

    const ts = now();
    const id = crypto.randomUUID();

    let normalizedPriority = "medium";
    // Match PATCH: any present `priority` key (including null / "") that
    // isn't one of low/medium/high is a 400. Omitting the key entirely
    // keeps the default.
    if (priority !== undefined) {
      const p = normalizePriority(priority);
      if (!p) {
        return res.status(400).json({
          success: false,
          error: "Priority must be low, medium, or high",
        });
      }
      normalizedPriority = p;
    }

    const [deal] = await db.insert(pipelineDeals).values({
      id,
      userId,
      stageId: targetStageId,
      title,
      value: value || 0,
      clientName: clientName || null,
      clientEmail: clientEmail || null,
      clientPhone: clientPhone || null,
      description: description || null,
      projectAddress: projectAddress || null,
      projectType: projectType || null,
      priority: normalizedPriority,
      nextAction: nextAction || null,
      expectedStartDate: normalizeEpochMs(expectedStartDate) ?? null,
      followUpDate: normalizeEpochMs(followUpDate) ?? null,
      estimateId: estimateId || null,
      leadId: leadId || null,
      probability: probability ?? 50,
      expectedCloseDate: normalizeEpochMs(expectedCloseDate) ?? null,
      position: 0,
      createdAt: ts,
      updatedAt: ts,
    }).returning();

    await db.insert(pipelineActivities).values({
      userId,
      dealId: id,
      type: "created",
      description: `Deal "${title}" created in ${validStage.name}`,
      createdAt: ts,
    });

    res.json({ success: true, data: { deal } });
  }));

  app.patch("/api/pipeline/deals/:id", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const dealId = req.params.id;

    const [existing] = await db.select().from(pipelineDeals)
      .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));
    if (!existing) return res.status(404).json({ success: false, error: "Deal not found" });

    const {
      title, stageId, value, clientName, clientEmail, clientPhone, description,
      projectAddress, projectType, priority, nextAction,
      expectedStartDate, followUpDate,
      probability, expectedCloseDate, lostReason, position,
    } = req.body;
    const ts = now();
    const updates: Record<string, unknown> = { updatedAt: ts };

    if (title !== undefined) updates.title = title;
    if (value !== undefined) updates.value = value;
    if (clientName !== undefined) updates.clientName = clientName;
    if (clientEmail !== undefined) updates.clientEmail = clientEmail;
    if (clientPhone !== undefined) updates.clientPhone = clientPhone;
    if (description !== undefined) updates.description = description;
    if (projectAddress !== undefined) updates.projectAddress = projectAddress;
    if (projectType !== undefined) updates.projectType = projectType;
    if (priority !== undefined) {
      const p = normalizePriority(priority);
      if (!p) return res.status(400).json({ success: false, error: "Priority must be low, medium, or high" });
      updates.priority = p;
    }
    if (nextAction !== undefined) updates.nextAction = nextAction;
    if (expectedStartDate !== undefined) updates.expectedStartDate = normalizeEpochMs(expectedStartDate);
    if (followUpDate !== undefined) updates.followUpDate = normalizeEpochMs(followUpDate);
    if (probability !== undefined) updates.probability = probability;
    if (expectedCloseDate !== undefined) updates.expectedCloseDate = normalizeEpochMs(expectedCloseDate);
    if (lostReason !== undefined) updates.lostReason = lostReason;
    if (position !== undefined) updates.position = position;

    if (stageId !== undefined && stageId !== existing.stageId) {
      const [newStage] = await db.select().from(pipelineStages)
        .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.userId, userId)));
      if (!newStage) return res.status(400).json({ success: false, error: "Invalid stage" });

      const [oldStage] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, existing.stageId));

      updates.stageId = stageId;
      if (newStage.isWon) {
        updates.wonAt = ts;
        updates.probability = 100;
      } else if (newStage.isLost) {
        updates.lostAt = ts;
        updates.probability = 0;
      }

      await db.insert(pipelineActivities).values({
        userId,
        dealId,
        type: "stage_changed",
        description: `Moved from "${oldStage?.name || "Unknown"}" to "${newStage.name}"`,
        metadata: JSON.stringify({ fromStageId: existing.stageId, toStageId: stageId }),
        createdAt: ts,
      });

      const eventData = {
        dealId,
        dealTitle: existing.title,
        fromStage: oldStage?.name,
        toStage: newStage.name,
        isWon: newStage.isWon,
        isLost: newStage.isLost,
        value: existing.value,
      };
      fireAutomationEvent(userId, "deal_stage_changed", eventData)
        .catch(err => log("error", "Automation event fire failed", { error: String(err) }));
      if (newStage.isWon) {
        fireAutomationEvent(userId, "deal_won", eventData)
          .catch(err => log("error", "Automation deal_won event failed", { error: String(err) }));
      }
      if (newStage.isLost) {
        fireAutomationEvent(userId, "deal_lost", eventData)
          .catch(err => log("error", "Automation deal_lost event failed", { error: String(err) }));
      }

      // Mirror Won/Lost back onto the linked estimate's status so the two
      // halves stay in sync regardless of which side moved first. Fail-soft.
      if ((newStage.isWon || newStage.isLost) && existing.estimateId) {
        await syncEstimateStatusFromDealStage({
          userId,
          estimateId: existing.estimateId,
          isWon: !!newStage.isWon,
          isLost: !!newStage.isLost,
        });
      }
    }

    const [updated] = await db.update(pipelineDeals).set(updates)
      .where(eq(pipelineDeals.id, dealId)).returning();

    res.json({ success: true, data: { deal: updated } });
  }));

  app.delete("/api/pipeline/deals/:id", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const dealId = req.params.id;

    const [existing] = await db.select().from(pipelineDeals)
      .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));
    if (!existing) return res.status(404).json({ success: false, error: "Deal not found" });

    const attachments = await db.select().from(pipelineDealAttachments)
      .where(eq(pipelineDealAttachments.dealId, dealId));
    for (const att of attachments) {
      const filePath = path.join(uploadsDir, att.id);
      fs.promises.unlink(filePath).catch(() => undefined);
    }
    await db.delete(pipelineDealAttachments).where(eq(pipelineDealAttachments.dealId, dealId));
    await db.delete(pipelineActivities).where(eq(pipelineActivities.dealId, dealId));
    await db.delete(pipelineDeals).where(eq(pipelineDeals.id, dealId));
    res.json({ success: true });
  }));

  app.get("/api/pipeline/deals/:id/activities", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const dealId = req.params.id;

    const [deal] = await db.select().from(pipelineDeals)
      .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));
    if (!deal) return res.status(404).json({ success: false, error: "Deal not found" });

    const activities = await db.select().from(pipelineActivities)
      .where(eq(pipelineActivities.dealId, dealId))
      .orderBy(desc(pipelineActivities.createdAt))
      .limit(50);

    res.json({ success: true, data: { activities } });
  }));

  app.post("/api/pipeline/deals/:id/activities", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const dealId = req.params.id;
    const { type, description } = req.body;

    if (!type || !description) return res.status(400).json({ success: false, error: "Type and description are required" });

    const [deal] = await db.select().from(pipelineDeals)
      .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));
    if (!deal) return res.status(404).json({ success: false, error: "Deal not found" });

    const [activity] = await db.insert(pipelineActivities).values({
      userId,
      dealId,
      type,
      description,
      createdAt: now(),
    }).returning();

    res.json({ success: true, data: { activity } });
  }));

  // ----- Attachments -----

  app.get("/api/pipeline/deals/:id/attachments", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const dealId = req.params.id;

    const [deal] = await db.select().from(pipelineDeals)
      .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));
    if (!deal) return res.status(404).json({ success: false, error: "Deal not found" });

    const attachments = await db.select().from(pipelineDealAttachments)
      .where(eq(pipelineDealAttachments.dealId, dealId))
      .orderBy(desc(pipelineDealAttachments.createdAt));

    res.json({ success: true, data: { attachments } });
  }));

  app.post(
    "/api/pipeline/deals/:id/attachments",
    requireAuthJson,
    attachmentUpload.single("file"),
    asyncHandler(async (req, res) => {
      const userId = (req.session as any).uid;
      const dealId = req.params.id;
      const file = req.file;

      if (!file) return res.status(400).json({ success: false, error: "No file uploaded" });

      const [deal] = await db.select().from(pipelineDeals)
        .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));
      if (!deal) {
        fs.promises.unlink(file.path).catch(() => undefined);
        return res.status(404).json({ success: false, error: "Deal not found" });
      }

      const ts = now();
      const id = crypto.randomUUID();
      const fileUrl = `/api/pipeline/attachments/${id}/download`;
      const newPath = path.join(uploadsDir, id);

      // Move file to its final location FIRST. If this fails, no DB row is written.
      try {
        await fs.promises.rename(file.path, newPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("error", "Attachment file move failed", { error: message, id });
        await fs.promises.unlink(file.path).catch(() => undefined);
        return res.status(500).json({ success: false, error: "Failed to save attachment" });
      }

      let attachment;
      try {
        const inserted = await db.insert(pipelineDealAttachments).values({
          id,
          dealId,
          userId,
          fileUrl,
          fileName: file.originalname,
          fileType: file.mimetype,
          sizeBytes: file.size,
          createdAt: ts,
        }).returning();
        attachment = inserted[0];
      } catch (err) {
        // Roll back the file if DB insert failed
        await fs.promises.unlink(newPath).catch(() => undefined);
        throw err;
      }

      await db.insert(pipelineActivities).values({
        userId,
        dealId,
        type: "attachment_added",
        description: `Attachment added: ${file.originalname}`,
        createdAt: ts,
      });

      res.json({ success: true, data: { attachment } });
    })
  );

  app.get("/api/pipeline/attachments/:id/download", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const attachmentId = req.params.id;

    const [attachment] = await db.select().from(pipelineDealAttachments)
      .where(and(
        eq(pipelineDealAttachments.id, attachmentId),
        eq(pipelineDealAttachments.userId, userId),
      ));
    if (!attachment) return res.status(404).json({ success: false, error: "Attachment not found" });

    const filePath = path.join(uploadsDir, attachmentId);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: "File missing" });

    res.setHeader("Content-Type", attachment.fileType);
    res.setHeader("Content-Disposition", `inline; filename="${attachment.fileName.replace(/"/g, "")}"`);
    fs.createReadStream(filePath).pipe(res);
  }));

  app.delete("/api/pipeline/attachments/:id", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const attachmentId = req.params.id;

    const [attachment] = await db.select().from(pipelineDealAttachments)
      .where(and(
        eq(pipelineDealAttachments.id, attachmentId),
        eq(pipelineDealAttachments.userId, userId),
      ));
    if (!attachment) return res.status(404).json({ success: false, error: "Attachment not found" });

    const filePath = path.join(uploadsDir, attachmentId);
    fs.promises.unlink(filePath).catch(() => undefined);
    await db.delete(pipelineDealAttachments).where(eq(pipelineDealAttachments.id, attachmentId));

    await db.insert(pipelineActivities).values({
      userId,
      dealId: attachment.dealId,
      type: "attachment_removed",
      description: `Attachment removed: ${attachment.fileName}`,
      createdAt: now(),
    });

    res.json({ success: true });
  }));

  // ----- Convert to estimate -----

  app.post("/api/pipeline/deals/:id/convert-to-estimate", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const dealId = req.params.id;

    const [deal] = await db.select().from(pipelineDeals)
      .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));
    if (!deal) return res.status(404).json({ success: false, error: "Deal not found" });

    const ts = now();
    const estimateId = crypto.randomUUID();
    const jobType = deal.projectType || deal.title;
    const market = deal.projectAddress || "";
    const detailsParts = [
      deal.description,
      deal.nextAction ? `Next action: ${deal.nextAction}` : null,
      deal.value ? `Estimated value: $${deal.value}` : null,
    ].filter(Boolean);

    await db.insert(estimates).values({
      id: estimateId,
      userId,
      jobType,
      market,
      details: detailsParts.join("\n") || null,
      estimateText: "",
      clientName: deal.clientName,
      clientEmail: deal.clientEmail,
      clientPhone: deal.clientPhone,
      status: "sent",
      createdAt: ts,
    });

    // Link the deal to the new estimate first, so the auto-sync helper below
    // can find this exact deal by estimateId (and not accidentally create a
    // duplicate when the deal has no leadId).
    await db.update(pipelineDeals)
      .set({ estimateId, updatedAt: ts })
      .where(and(eq(pipelineDeals.id, dealId), eq(pipelineDeals.userId, userId)));

    await db.insert(pipelineActivities).values({
      userId,
      dealId,
      type: "converted_to_estimate",
      description: `Converted to estimate (${estimateId.slice(0, 8)})`,
      metadata: JSON.stringify({ estimateId }),
      createdAt: ts,
    });

    // Run the same auto-sync used by the regular estimate-creation paths so
    // the existing deal is advanced to the "Estimate Sent" stage in place
    // (no duplicate row) and the deal_stage_changed automation fires
    // consistently with manual moves.
    await syncDealForNewEstimate({
      userId,
      estimateId,
      leadId: deal.leadId,
      source: {
        title: deal.title,
        clientName: deal.clientName,
        clientEmail: deal.clientEmail,
        clientPhone: deal.clientPhone,
        description: deal.description,
        projectAddress: deal.projectAddress,
        projectType: deal.projectType,
        value: deal.value,
      },
    });

    res.json({ success: true, data: { estimateId } });
  }));

  // ----- Analytics -----

  app.get("/api/pipeline/analytics", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const stages = await ensureStages(userId);

    const deals = await db.select().from(pipelineDeals)
      .where(eq(pipelineDeals.userId, userId));

    const totalDeals = deals.length;
    const totalValue = deals.reduce((sum, d) => sum + (d.value || 0), 0);
    const wonDeals = deals.filter(d => d.wonAt);
    const lostDeals = deals.filter(d => d.lostAt);
    const wonValue = wonDeals.reduce((sum, d) => sum + (d.value || 0), 0);
    const activeDeals = deals.filter(d => !d.wonAt && !d.lostAt);
    const activeValue = activeDeals.reduce((sum, d) => sum + (d.value || 0), 0);
    const winRate = (wonDeals.length + lostDeals.length) > 0
      ? Math.round((wonDeals.length / (wonDeals.length + lostDeals.length)) * 100)
      : 0;

    const avgDealSize = wonDeals.length > 0
      ? Math.round(wonValue / wonDeals.length)
      : 0;

    const stageBreakdown = stages.map(stage => {
      const stageDeals = deals.filter(d => d.stageId === stage.id);
      return {
        stageId: stage.id,
        stageName: stage.name,
        color: stage.color,
        dealCount: stageDeals.length,
        totalValue: stageDeals.reduce((sum, d) => sum + (d.value || 0), 0),
      };
    });

    const thirtyDaysAgo = now() - (30 * 24 * 60 * 60 * 1000);
    const recentWon = wonDeals.filter(d => d.wonAt && d.wonAt > thirtyDaysAgo);
    const monthlyRevenue = recentWon.reduce((sum, d) => sum + (d.value || 0), 0);

    const todayStart = startOfTodayMs();
    const todayEnd = endOfTodayMs();
    const followUpToday = activeDeals.filter(d =>
      d.followUpDate != null && d.followUpDate >= todayStart && d.followUpDate <= todayEnd
    ).length;
    const followUpOverdue = activeDeals.filter(d =>
      d.followUpDate != null && d.followUpDate < todayStart
    ).length;

    res.json({
      success: true,
      data: {
        totalDeals,
        totalValue,
        activeDeals: activeDeals.length,
        activeValue,
        wonDeals: wonDeals.length,
        wonValue,
        lostDeals: lostDeals.length,
        winRate,
        avgDealSize,
        monthlyRevenue,
        followUpToday,
        followUpOverdue,
        stageBreakdown,
      },
    });
  }));
}
