import express from "express";
import { pool } from "../../db.js";
import { asyncHandler } from "../../lib/middleware.js";
import { isAdminRequest } from "../admin/shared.js";
import { setPausedState } from "../../lib/outreach-helpers.js";
import { outreachPaused, outreachPauseReason } from "../../lib/outreach-state.js";

export function registerAdminStatusRoutes(app: express.Application) {
// GET /api/admin/outreach-status — check if outreach is paused
app.get(
  "/api/admin/outreach-status",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    res.json({
      success: true,
      data: { paused: outreachPaused, reason: outreachPauseReason },
    });
  }),
);

// POST /api/admin/outreach-resume — resume paused outreach
app.post(
  "/api/admin/outreach-resume",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    await setPausedState(false, "");
    res.json({ success: true, data: { paused: false } });
  }),
);

// GET /api/admin/outreach-alerts — list pause alert history from DB
app.get(
  "/api/admin/outreach-alerts",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const rows = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM lead_outreach_config WHERE key LIKE 'alert_%' ORDER BY key DESC LIMIT 50`,
    );
    const alerts = rows.rows.map((r) => {
      try {
        return { key: r.key, ...JSON.parse(r.value) };
      } catch {
        return { key: r.key, raw: r.value };
      }
    });
    res.json({ success: true, data: alerts });
  }),
);

// POST /api/admin/outreach-alerts/:key/acknowledge — mark alert as acknowledged
app.post(
  "/api/admin/outreach-alerts/:key/acknowledge",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { key } = req.params;
    const existing = await pool.query<{ value: string }>(
      `SELECT value FROM lead_outreach_config WHERE key = $1`,
      [key],
    );
    if (existing.rows.length === 0)
      return res.status(404).json({ success: false, error: "Alert not found" });
    let alert: Record<string, unknown> = {};
    try {
      alert = JSON.parse(existing.rows[0].value);
    } catch {
      /* keep as-is */
    }
    alert.acknowledged = true;
    await pool.query(
      `UPDATE lead_outreach_config SET value = $1 WHERE key = $2`,
      [JSON.stringify(alert), key],
    );
    res.json({ success: true });
  }),
);
}
