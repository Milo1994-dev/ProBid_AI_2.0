import express from "express";
import { pool } from "../../db.js";
import { asyncHandler } from "../../lib/middleware.js";
import { isAdminRequest } from "../admin/shared.js";

export function registerAdminSystemAlertsRoutes(app: express.Application) {
// GET /api/admin/system-alerts — list unresolved alerts
app.get(
  "/api/admin/system-alerts",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const rows = await pool.query<{
      id: number;
      type: string;
      message: string;
      severity: string;
      resolved_at: number | null;
      created_at: number;
    }>(
      `SELECT * FROM system_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`,
    );
    res.json({ success: true, data: rows.rows });
  }),
);

// POST /api/admin/system-alerts/:id/resolve — mark alert resolved
app.post(
  "/api/admin/system-alerts/:id/resolve",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const alertId = parseInt(req.params.id, 10);
    if (isNaN(alertId))
      return res.status(400).json({ success: false, error: "Invalid id" });
    const result = await pool.query(
      `UPDATE system_alerts SET resolved_at = $1 WHERE id = $2 AND resolved_at IS NULL`,
      [Date.now(), alertId],
    );
    if (result.rowCount === 0)
      return res
        .status(404)
        .json({ success: false, error: "Alert not found or already resolved" });
    // If called from a browser form, redirect back to admin; otherwise return JSON
    const acceptsHtml = req.headers.accept?.includes("text/html");
    if (acceptsHtml)
      return res.redirect(`/admin`);
    res.json({ success: true });
  }),
);
}
