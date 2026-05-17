import express from "express";
import { db, pool } from "../../db.js";
import { eq, and, desc, asc, count, inArray } from "drizzle-orm";
import {
  scrapedLeads,
  leadOutreachQueue,
} from "../../../shared/schema.js";
import { asyncHandler } from "../../lib/middleware.js";
import { isAdminRequest } from "../admin/shared.js";
import { getWarmupPhaseForDay, getOutreachDailyLimit } from "../../lib/outreach-helpers.js";
import { computeScore, deriveStage } from "../../lead-engine.js";

export function registerAdminLeadsRoutes(app: express.Application) {
// POST /api/admin/leads/mark-replied — manually mark a lead as replied (by email or id)
app.post(
  "/api/admin/leads/mark-replied",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { email, id } = req.body as { email?: string; id?: string };
    const nowMs = Date.now();

    if (!email && !id)
      return res
        .status(400)
        .json({ success: false, error: "Provide email or id" });

    const condition = id
      ? eq(scrapedLeads.id, id)
      : eq(scrapedLeads.email, email!.trim().toLowerCase());

    const updated = await db
      .update(scrapedLeads)
      .set({ repliedAt: nowMs, updatedAt: nowMs })
      .where(condition)
      .returning();

    for (const lead of updated) {
      const score = computeScore({ ...lead, contacted: true });
      const stage = deriveStage({ ...lead, contacted: true });
      await db
        .update(scrapedLeads)
        .set({ score, stage, updatedAt: nowMs })
        .where(eq(scrapedLeads.id, lead.id));
      await db
        .update(leadOutreachQueue)
        .set({ status: "suppressed", sentAt: new Date(nowMs).toISOString() })
        .where(
          and(
            eq(leadOutreachQueue.leadId, lead.id),
            eq(leadOutreachQueue.status, "pending"),
          ),
        );
    }

    res.json({ success: true, data: { updated: updated.length } });
  }),
);

// POST /api/admin/leads/mark-converted — manually mark a lead as converted
app.post(
  "/api/admin/leads/mark-converted",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { id } = req.body as { id?: string };
    const nowMs = Date.now();
    if (!id)
      return res.status(400).json({ success: false, error: "Provide id" });

    const updated = await db
      .update(scrapedLeads)
      .set({ convertedAt: nowMs, updatedAt: nowMs })
      .where(eq(scrapedLeads.id, id))
      .returning();

    for (const lead of updated) {
      const score = computeScore({ ...lead, contacted: true });
      const stage = deriveStage({ ...lead, contacted: true });
      await db
        .update(scrapedLeads)
        .set({ score, stage, updatedAt: nowMs })
        .where(eq(scrapedLeads.id, lead.id));
      await db
        .update(leadOutreachQueue)
        .set({ status: "suppressed", sentAt: new Date(nowMs).toISOString() })
        .where(
          and(
            eq(leadOutreachQueue.leadId, lead.id),
            eq(leadOutreachQueue.status, "pending"),
          ),
        );
    }

    res.json({ success: true, data: { updated: updated.length } });
  }),
);

// GET /api/admin/leads — paginated lead list with stage/score filters
app.get(
  "/api/admin/leads",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });

    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    const offset = (page - 1) * limit;
    const stageFilter = req.query.stage as string | undefined;
    const sortParam = (req.query.sort as string | undefined) ?? "score";

    const conditions: ReturnType<typeof eq>[] = [];
    if (stageFilter && stageFilter !== "all") {
      conditions.push(eq(scrapedLeads.stage, stageFilter) as ReturnType<typeof eq>);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const orderClause =
      sortParam === "createdAt"
        ? [desc(scrapedLeads.createdAt)]
        : [desc(scrapedLeads.score), desc(scrapedLeads.createdAt)];

    const [rowsResult, totalResult] = await Promise.all([
      db
        .select()
        .from(scrapedLeads)
        .where(whereClause)
        .orderBy(...orderClause)
        .limit(limit)
        .offset(offset),
      db
        .select({ c: count() })
        .from(scrapedLeads)
        .where(whereClause),
    ]);

    // Compute nextContact for each lead from the queue
    const leadIds = rowsResult.map((l) => l.id);
    let nextContactMap: Record<string, string | null> = {};
    if (leadIds.length > 0) {
      const queueRows = await db
        .select({
          leadId: leadOutreachQueue.leadId,
          scheduledFor: leadOutreachQueue.scheduledFor,
        })
        .from(leadOutreachQueue)
        .where(
          and(
            inArray(leadOutreachQueue.leadId, leadIds),
            eq(leadOutreachQueue.status, "pending"),
          ),
        )
        .orderBy(asc(leadOutreachQueue.scheduledFor));
      for (const row of queueRows) {
        if (!nextContactMap[row.leadId]) {
          nextContactMap[row.leadId] = row.scheduledFor;
        }
      }
    }

    const leadsWithMeta = rowsResult.map((lead) => ({
      ...lead,
      nextContact: nextContactMap[lead.id] ?? null,
    }));

    res.json({
      success: true,
      data: {
        leads: leadsWithMeta,
        total: Number(totalResult[0]?.c ?? 0),
        page,
        limit,
      },
    });
  }),
);

// POST /api/admin/leads/set-daily-limit — update DB-configurable outreach daily limit
app.post(
  "/api/admin/leads/set-daily-limit",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { limit: rawLimit } = req.body as { limit?: unknown };
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      return res
        .status(400)
        .json({ success: false, error: "limit must be integer 1-10000" });

    await pool.query(
      `INSERT INTO lead_outreach_config (key, value) VALUES ('daily_limit', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(limit)],
    );
    res.json({ success: true, data: { daily_limit: limit } });
  }),
);

// GET /api/admin/leads/daily-limit — fetch current outreach daily limit + warmup phase
app.get(
  "/api/admin/leads/daily-limit",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const limit = await getOutreachDailyLimit();
    // Include warmup phase info for admin dashboard display
    let warmup: Record<string, unknown> | null = null;
    try {
      const warmupRow = await pool.query<{ value: string }>(
        `SELECT value FROM lead_outreach_config WHERE key = 'warmup_started_at' LIMIT 1`,
      );
      const warmupStartedAt = warmupRow.rows[0]?.value ?? null;
      if (warmupStartedAt) {
        const daysElapsed = Math.floor(
          (Date.now() - new Date(warmupStartedAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        const { phase, nextPhase, daysUntilNext } = getWarmupPhaseForDay(daysElapsed);
        warmup = {
          started_at: warmupStartedAt,
          days_elapsed: daysElapsed,
          phase_label: phase.label,
          scheduled_limit: phase.limit,
          next_bump_limit: nextPhase?.limit ?? null,
          days_until_next: daysUntilNext,
        };
      }
    } catch { /* non-critical */ }

    // Tracking health stats — total emails sent, opened, clicked + token coverage
    let tracking: Record<string, number> | null = null;
    try {
      const [sentRow, openedRow, clickedRow, tokenRow] = await Promise.all([
        // Total sent emails (not distinct leads — counts all templates per lead)
        pool.query<{ c: string }>(
          `SELECT COUNT(*) AS c FROM lead_email_audit_log WHERE status = 'sent'`,
        ),
        pool.query<{ c: string }>(
          `SELECT COUNT(*) AS c FROM scraped_leads WHERE opened_at IS NOT NULL`,
        ),
        pool.query<{ c: string }>(
          `SELECT COUNT(*) AS c FROM scraped_leads WHERE clicked_at IS NOT NULL`,
        ),
        // Token coverage: queue rows with open + click tokens generated (tracking pixel health)
        pool.query<{ with_tokens: string; total: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE open_token IS NOT NULL AND click_token IS NOT NULL) AS with_tokens,
             COUNT(*) AS total
           FROM lead_outreach_queue WHERE status IN ('pending','sent')`,
        ),
      ]);
      tracking = {
        sent: Number(sentRow.rows[0]?.c ?? 0),
        opened: Number(openedRow.rows[0]?.c ?? 0),
        clicked: Number(clickedRow.rows[0]?.c ?? 0),
        token_coverage: Number(tokenRow.rows[0]?.with_tokens ?? 0),
        token_total: Number(tokenRow.rows[0]?.total ?? 0),
      };
    } catch { /* non-critical */ }

    res.json({ success: true, data: { daily_limit: limit, warmup, tracking } });
  }),
);

// GET /api/admin/leads/buckets — global hot/warm/cold counts
app.get(
  "/api/admin/leads/buckets",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const rows = await pool.query<{ bucket: string; cnt: string }>(`
      SELECT
        CASE WHEN score >= 70 THEN 'hot' WHEN score >= 40 THEN 'warm' ELSE 'cold' END AS bucket,
        COUNT(*) AS cnt
      FROM scraped_leads
      GROUP BY bucket
    `);
    const buckets: Record<string, number> = { hot: 0, warm: 0, cold: 0 };
    for (const r of rows.rows) buckets[r.bucket] = Number(r.cnt);
    res.json({ success: true, data: buckets });
  }),
);

// POST /api/admin/leads/:id/delete — hard-delete a lead and its queue entries
app.post(
  "/api/admin/leads/:id/delete",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { id } = req.params;
    await db
      .update(leadOutreachQueue)
      .set({ status: "suppressed", sentAt: new Date().toISOString() })
      .where(
        and(
          eq(leadOutreachQueue.leadId, id),
          eq(leadOutreachQueue.status, "pending"),
        ),
      );
    const deleted = await db
      .delete(scrapedLeads)
      .where(eq(scrapedLeads.id, id))
      .returning({ id: scrapedLeads.id });
    if (deleted.length === 0)
      return res.status(404).json({ success: false, error: "Lead not found" });
    res.json({ success: true, data: { deleted: deleted.length } });
  }),
);

// POST /api/admin/leads/:id/pause — set doNotContact=true, cancel pending queue
app.post(
  "/api/admin/leads/:id/pause",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { id } = req.params;
    const nowMs = Date.now();
    const [updated] = await db
      .update(scrapedLeads)
      .set({ doNotContact: true, stage: "do_not_contact", score: 0, updatedAt: nowMs })
      .where(eq(scrapedLeads.id, id))
      .returning({ id: scrapedLeads.id });
    if (!updated)
      return res.status(404).json({ success: false, error: "Lead not found" });
    await db
      .update(leadOutreachQueue)
      .set({ status: "suppressed", sentAt: new Date(nowMs).toISOString() })
      .where(
        and(
          eq(leadOutreachQueue.leadId, id),
          eq(leadOutreachQueue.status, "pending"),
        ),
      );
    res.json({ success: true });
  }),
);

// POST /api/admin/leads/:id/resume — set doNotContact=false, re-derive stage
app.post(
  "/api/admin/leads/:id/resume",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { id } = req.params;
    const nowMs = Date.now();
    const [preUpdate] = await db
      .select()
      .from(scrapedLeads)
      .where(eq(scrapedLeads.id, id))
      .limit(1);
    if (!preUpdate)
      return res.status(404).json({ success: false, error: "Lead not found" });
    // Check if this lead has already been contacted via the queue
    const queueRow = await db
      .select({ id: leadOutreachQueue.id })
      .from(leadOutreachQueue)
      .where(eq(leadOutreachQueue.leadId, id))
      .limit(1);
    const wasContacted = queueRow.length > 0;
    const signals = { ...preUpdate, doNotContact: false, contacted: wasContacted };
    const score = computeScore(signals);
    const stage = deriveStage(signals);
    await db
      .update(scrapedLeads)
      .set({ doNotContact: false, score, stage, updatedAt: nowMs })
      .where(eq(scrapedLeads.id, id));
    res.json({ success: true, data: { stage, score } });
  }),
);

// POST /api/admin/leads/:id/mark-interested — manually set stage=interested
app.post(
  "/api/admin/leads/:id/mark-interested",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { id } = req.params;
    const nowMs = Date.now();
    const [updated] = await db
      .update(scrapedLeads)
      .set({ stage: "interested", updatedAt: nowMs })
      .where(eq(scrapedLeads.id, id))
      .returning({ id: scrapedLeads.id });
    if (!updated)
      return res.status(404).json({ success: false, error: "Lead not found" });
    res.json({ success: true });
  }),
);

// POST /api/admin/leads/:id/mark-subscribed — set convertedAt=now, stage=subscribed
app.post(
  "/api/admin/leads/:id/mark-subscribed",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { id } = req.params;
    const nowMs = Date.now();
    const [preUpdate] = await db
      .select()
      .from(scrapedLeads)
      .where(eq(scrapedLeads.id, id))
      .limit(1);
    if (!preUpdate)
      return res.status(404).json({ success: false, error: "Lead not found" });
    const updated = { ...preUpdate, convertedAt: nowMs, doNotContact: false };
    const score = computeScore({ ...updated, contacted: true });
    // Always force stage=subscribed for this admin action regardless of DNC state
    const stage: "subscribed" = "subscribed";
    await db
      .update(scrapedLeads)
      .set({ convertedAt: nowMs, doNotContact: false, score, stage, updatedAt: nowMs })
      .where(eq(scrapedLeads.id, id));
    await db
      .update(leadOutreachQueue)
      .set({ status: "suppressed", sentAt: new Date(nowMs).toISOString() })
      .where(
        and(
          eq(leadOutreachQueue.leadId, id),
          eq(leadOutreachQueue.status, "pending"),
        ),
      );
    res.json({ success: true, data: { stage, score } });
  }),
);
}
