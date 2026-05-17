import express from "express";
import { db } from "../db.js";
import { eq, and, desc } from "drizzle-orm";
import { automationRules, automationRuns } from "../../shared/schema.js";
import { asyncHandler, requireAuthJson } from "../lib/middleware.js";
import { now } from "../lib/utils.js";
import { seedDefaultAutomations } from "../lib/automation-engine.js";

export function registerAutomationRoutes(app: express.Express) {
  app.get("/api/automations", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    await seedDefaultAutomations(userId);

    const rules = await db.select().from(automationRules)
      .where(eq(automationRules.userId, userId))
      .orderBy(automationRules.createdAt);

    res.json({ success: true, data: { rules } });
  }));

  app.post("/api/automations", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const { name, description, trigger, conditions, action, actionConfig, enabled } = req.body;

    if (!name || !trigger || !action || !actionConfig) {
      return res.status(400).json({ success: false, error: "Name, trigger, action, and actionConfig are required" });
    }

    const ts = now();
    const [rule] = await db.insert(automationRules).values({
      userId,
      name,
      description: description || null,
      trigger,
      conditions: conditions ? JSON.stringify(conditions) : null,
      action,
      actionConfig: typeof actionConfig === "string" ? actionConfig : JSON.stringify(actionConfig),
      enabled: enabled !== false,
      isSystem: false,
      createdAt: ts,
      updatedAt: ts,
    }).returning();

    res.json({ success: true, data: { rule } });
  }));

  app.patch("/api/automations/:id", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const ruleId = parseInt(req.params.id);

    const [existing] = await db.select().from(automationRules)
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.userId, userId)));
    if (!existing) return res.status(404).json({ success: false, error: "Rule not found" });

    const { name, description, trigger, conditions, action, actionConfig, enabled } = req.body;
    const updates: Record<string, unknown> = { updatedAt: now() };

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (trigger !== undefined) updates.trigger = trigger;
    if (conditions !== undefined) updates.conditions = conditions ? JSON.stringify(conditions) : null;
    if (action !== undefined) updates.action = action;
    if (actionConfig !== undefined) updates.actionConfig = typeof actionConfig === "string" ? actionConfig : JSON.stringify(actionConfig);
    if (enabled !== undefined) updates.enabled = enabled;

    const [updated] = await db.update(automationRules).set(updates)
      .where(eq(automationRules.id, ruleId)).returning();

    res.json({ success: true, data: { rule: updated } });
  }));

  app.delete("/api/automations/:id", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const ruleId = parseInt(req.params.id);

    const [existing] = await db.select().from(automationRules)
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.userId, userId)));
    if (!existing) return res.status(404).json({ success: false, error: "Rule not found" });
    if (existing.isSystem) return res.status(400).json({ success: false, error: "System rules cannot be deleted" });

    await db.delete(automationRuns).where(eq(automationRuns.ruleId, ruleId));
    await db.delete(automationRules).where(eq(automationRules.id, ruleId));
    res.json({ success: true });
  }));

  app.get("/api/automations/:id/runs", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    const ruleId = parseInt(req.params.id);

    const [existing] = await db.select().from(automationRules)
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.userId, userId)));
    if (!existing) return res.status(404).json({ success: false, error: "Rule not found" });

    const runs = await db.select().from(automationRuns)
      .where(eq(automationRuns.ruleId, ruleId))
      .orderBy(desc(automationRuns.createdAt))
      .limit(50);

    res.json({ success: true, data: { runs } });
  }));

  app.get("/api/automations/stats", requireAuthJson, asyncHandler(async (req, res) => {
    const userId = (req.session as any).uid;
    await seedDefaultAutomations(userId);

    const rules = await db.select().from(automationRules)
      .where(eq(automationRules.userId, userId));

    const totalRules = rules.length;
    const activeRules = rules.filter(r => r.enabled).length;
    const totalRuns = rules.reduce((sum, r) => sum + (r.runCount || 0), 0);

    const recentRuns = await db.select().from(automationRuns)
      .where(eq(automationRuns.userId, userId))
      .orderBy(desc(automationRuns.createdAt))
      .limit(10);

    const successCount = recentRuns.filter(r => r.status === "success").length;
    const failCount = recentRuns.filter(r => r.status === "failed").length;

    res.json({
      success: true,
      data: {
        totalRules,
        activeRules,
        totalRuns,
        recentSuccessRate: recentRuns.length > 0 ? Math.round((successCount / recentRuns.length) * 100) : 100,
        recentRuns,
      },
    });
  }));
}
