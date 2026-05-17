import express from "express";
import { db } from "../../db.js";
import { eq, desc } from "drizzle-orm";
import { reviews } from "../../../shared/schema.js";
import { asyncHandler, requireAdminAuthPage } from "../../lib/middleware.js";
import { isAdminRequest } from "./shared.js";
import { log } from "../../lib/logger.js";
import { escapeHtml } from "../../lib/utils.js";

export function registerAdminReviewRoutes(app: express.Application) {
  app.get(
    "/admin/reviews",
    requireAdminAuthPage,
    asyncHandler(async (req, res) => {
      const allReviews = await db
        .select()
        .from(reviews)
        .orderBy(desc(reviews.createdAt));

      const rows = allReviews.map((r) => {
        const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
        const date = new Date(r.createdAt).toLocaleDateString("en-US", {
          year: "numeric", month: "short", day: "numeric",
        });
        const statusBadge = r.hidden
          ? '<span style="background:rgba(239,68,68,0.2);color:#ef4444;padding:2px 8px;border-radius:4px;font-size:0.75rem">Hidden</span>'
          : r.approved
            ? '<span style="background:rgba(34,197,94,0.2);color:#22c55e;padding:2px 8px;border-radius:4px;font-size:0.75rem">Approved</span>'
            : '<span style="background:rgba(234,179,8,0.2);color:#eab308;padding:2px 8px;border-radius:4px;font-size:0.75rem">Pending</span>';

        const actions: string[] = [];
        if (!r.approved && !r.hidden) {
          actions.push(`<button onclick="adminAction('approve', ${r.id})" style="background:rgba(34,197,94,0.2);color:#22c55e;border:1px solid #22c55e;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:0.8rem">Approve</button>`);
        }
        if (!r.hidden) {
          actions.push(`<button onclick="adminAction('hide', ${r.id})" style="background:rgba(239,68,68,0.2);color:#ef4444;border:1px solid #ef4444;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:0.8rem">Hide</button>`);
        } else {
          actions.push(`<button onclick="adminAction('unhide', ${r.id})" style="background:rgba(59,130,246,0.2);color:#3b82f6;border:1px solid #3b82f6;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:0.8rem">Unhide</button>`);
        }

        return `<tr>
          <td style="padding:12px;border-bottom:1px solid #1e293b">${r.id}</td>
          <td style="padding:12px;border-bottom:1px solid #1e293b">${escapeHtml(r.userName || "—")}</td>
          <td style="padding:12px;border-bottom:1px solid #1e293b">${escapeHtml(r.userTrade || "—")}</td>
          <td style="padding:12px;border-bottom:1px solid #1e293b;color:#facc15">${stars}</td>
          <td style="padding:12px;border-bottom:1px solid #1e293b;max-width:300px">${escapeHtml(r.comment || "—")}</td>
          <td style="padding:12px;border-bottom:1px solid #1e293b">${statusBadge}</td>
          <td style="padding:12px;border-bottom:1px solid #1e293b">${date}</td>
          <td style="padding:12px;border-bottom:1px solid #1e293b">${actions.join(" ")}</td>
        </tr>`;
      }).join("");

      res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Reviews</title>
<style>
  body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
  h1 { font-size: 1.8rem; margin-bottom: 8px; }
  .back { color: #818cf8; text-decoration: none; font-size: 0.9rem; }
  .back:hover { text-decoration: underline; }
  .stats { display: flex; gap: 16px; margin: 20px 0; }
  .stat-card { background: #1e293b; border-radius: 12px; padding: 16px 24px; }
  .stat-card .label { font-size: 0.8rem; color: #94a3b8; }
  .stat-card .value { font-size: 1.5rem; font-weight: 800; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; margin-top: 16px; }
  th { text-align: left; padding: 12px; background: #0f172a; font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  td { font-size: 0.85rem; }
</style>
</head><body>
<a href="/admin" class="back">← Back to Admin</a>
<h1>Reviews Management</h1>
<p style="color:#94a3b8;font-size:0.9rem">${allReviews.length} total reviews</p>

<div class="stats">
  <div class="stat-card">
    <div class="label">Approved</div>
    <div class="value" style="color:#22c55e">${allReviews.filter(r => r.approved && !r.hidden).length}</div>
  </div>
  <div class="stat-card">
    <div class="label">Pending</div>
    <div class="value" style="color:#eab308">${allReviews.filter(r => !r.approved && !r.hidden).length}</div>
  </div>
  <div class="stat-card">
    <div class="label">Hidden</div>
    <div class="value" style="color:#ef4444">${allReviews.filter(r => r.hidden).length}</div>
  </div>
</div>

<table>
  <thead><tr>
    <th>ID</th><th>Name</th><th>Trade</th><th>Rating</th><th>Comment</th><th>Status</th><th>Date</th><th>Actions</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="8" style="padding:24px;text-align:center;color:#94a3b8">No reviews yet</td></tr>'}</tbody>
</table>

<script>
async function adminAction(action, id) {
  if (!confirm('Are you sure you want to ' + action + ' review #' + id + '?')) return;
  const res = await fetch('/api/admin/reviews/' + id + '/' + action, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.ok) { location.reload(); }
  else { alert('Failed to ' + action + ' review'); }
}
</script>
</body></html>`);
    }),
  );

  app.get(
    "/api/admin/reviews",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });

      const allReviews = await db
        .select()
        .from(reviews)
        .orderBy(desc(reviews.createdAt));

      res.json({
        success: true,
        data: allReviews.map((r) => ({
          id: r.id,
          userId: r.userId,
          userName: r.userName,
          userTrade: r.userTrade,
          rating: r.rating,
          comment: r.comment,
          approved: r.approved,
          hidden: r.hidden,
          createdAt: r.createdAt,
        })),
      });
    }),
  );

  app.patch(
    "/api/admin/reviews/:id/approve",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ success: false, error: "Invalid review ID" });

      await db.update(reviews).set({ approved: true }).where(eq(reviews.id, id));
      log("info", "Review approved by admin", { reviewId: id });

      res.json({ success: true });
    }),
  );

  app.patch(
    "/api/admin/reviews/:id/hide",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ success: false, error: "Invalid review ID" });

      await db.update(reviews).set({ hidden: true, approved: false }).where(eq(reviews.id, id));
      log("info", "Review hidden by admin", { reviewId: id });

      res.json({ success: true });
    }),
  );

  app.patch(
    "/api/admin/reviews/:id/unhide",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ success: false, error: "Invalid review ID" });

      await db.update(reviews).set({ hidden: false }).where(eq(reviews.id, id));
      log("info", "Review unhidden by admin", { reviewId: id });

      res.json({ success: true });
    }),
  );
}
