import express from "express";
import { pool } from "../../db.js";
import { asyncHandler, requireAdminAuthPage } from "../../lib/middleware.js";
import { isAdminRequest } from "../admin/shared.js";
import { escapeHtml } from "../../lib/utils.js";

export function registerAdminAdsRoutes(app: express.Application) {
// ============================================================
// AD CAMPAIGNS API
// ============================================================

// GET /api/admin/ads — list all campaigns
app.get(
  "/api/admin/ads",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const rows = await pool.query<{
      id: number;
      platform: string;
      name: string;
      budget: number;
      spend: number;
      clicks: number;
      impressions: number;
      status: string;
      created_at: number;
      updated_at: number;
    }>(`SELECT * FROM ad_campaigns ORDER BY created_at DESC`);
    res.json({ success: true, data: rows.rows });
  }),
);

// POST /api/admin/ads — create campaign
app.post(
  "/api/admin/ads",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const { platform, name, budget, spend, clicks, impressions, status } =
      req.body as {
        platform?: string;
        name?: string;
        budget?: number;
        spend?: number;
        clicks?: number;
        impressions?: number;
        status?: string;
      };
    if (!platform?.trim() || !name?.trim())
      return res
        .status(400)
        .json({ success: false, error: "platform and name required" });
    const safeNum = (v: unknown, def = 0) =>
      Math.max(0, Number(v ?? def) || def);
    const nowMs = Date.now();
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO ad_campaigns (platform, name, budget, spend, clicks, impressions, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        platform.trim(),
        name.trim(),
        safeNum(budget),
        safeNum(spend),
        safeNum(clicks),
        safeNum(impressions),
        status ?? "active",
        nowMs,
        nowMs,
      ],
    );
    res.status(201).json({ success: true, data: { id: inserted.rows[0].id } });
  }),
);

// PUT /api/admin/ads/:id — update campaign
app.put(
  "/api/admin/ads/:id",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const campaignId = parseInt(req.params.id, 10);
    if (isNaN(campaignId))
      return res.status(400).json({ success: false, error: "Invalid id" });
    const { platform, name, budget, spend, clicks, impressions, status } =
      req.body as {
        platform?: string;
        name?: string;
        budget?: number;
        spend?: number;
        clicks?: number;
        impressions?: number;
        status?: string;
      };
    const safeNumOrNull = (v: unknown) =>
      v != null ? Math.max(0, Number(v) || 0) : null;
    const nowMs = Date.now();
    const result = await pool.query(
      `UPDATE ad_campaigns SET
       platform = COALESCE($1, platform),
       name = COALESCE($2, name),
       budget = COALESCE($3, budget),
       spend = COALESCE($4, spend),
       clicks = COALESCE($5, clicks),
       impressions = COALESCE($6, impressions),
       status = COALESCE($7, status),
       updated_at = $8
     WHERE id = $9`,
      [
        platform?.trim() ?? null,
        name?.trim() ?? null,
        safeNumOrNull(budget),
        safeNumOrNull(spend),
        safeNumOrNull(clicks),
        safeNumOrNull(impressions),
        status ?? null,
        nowMs,
        campaignId,
      ],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true });
  }),
);

// DELETE /api/admin/ads/:id — delete campaign
app.delete(
  "/api/admin/ads/:id",
  asyncHandler(async (req, res) => {
    if (!isAdminRequest(req))
      return res.status(401).json({ success: false, error: "Unauthorized" });
    const campaignId = parseInt(req.params.id, 10);
    if (isNaN(campaignId))
      return res.status(400).json({ success: false, error: "Invalid id" });
    await pool.query(`DELETE FROM ad_campaigns WHERE id = $1`, [campaignId]);
    res.json({ success: true });
  }),
);

// GET /admin/ads — server-rendered ad campaigns admin page
app.get(
  "/admin/ads",
  requireAdminAuthPage,
  asyncHandler(async (req, res) => {
    const campaignsRaw = await pool.query<{
      id: number;
      platform: string;
      name: string;
      budget: number;
      spend: number;
      clicks: number;
      impressions: number;
      status: string;
      created_at: number;
      updated_at: number;
    }>(`SELECT * FROM ad_campaigns ORDER BY created_at DESC`);
    const campaigns = campaignsRaw.rows;

    // Signups per day for last 30 days (for chart)
    const signupsByDayRaw = await pool.query<{ day: string; c: string }>(
      `SELECT TO_CHAR(TO_TIMESTAMP(created_at / 1000), 'MM/DD') AS day, COUNT(*) AS c
     FROM users WHERE created_at >= $1
     GROUP BY day ORDER BY day`,
      [Date.now() - 30 * 86400000],
    );
    const chartLabels = signupsByDayRaw.rows.map((r) => escapeHtml(r.day));
    const chartData = signupsByDayRaw.rows.map((r) => Number(r.c));

    const totalSpend = campaigns.reduce((a, c) => a + (c.spend ?? 0), 0);
    const totalClicks = campaigns.reduce((a, c) => a + (c.clicks ?? 0), 0);
    const totalImpressions = campaigns.reduce(
      (a, c) => a + (c.impressions ?? 0),
      0,
    );
    const cpc = totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : "—";
    const ctr =
      totalImpressions > 0
        ? ((totalClicks / totalImpressions) * 100).toFixed(2) + "%"
        : "—";

    const statusColor: Record<string, string> = {
      active: "#22c55e",
      paused: "#f59e0b",
      ended: "#94a3b8",
    };
    const platformEmoji: Record<string, string> = {
      google: "🔍",
      meta: "📘",
      facebook: "📘",
      instagram: "📷",
      youtube: "▶️",
      linkedin: "💼",
      tiktok: "🎵",
      twitter: "🐦",
      other: "📢",
    };

    const tableRows =
      campaigns.length === 0
        ? `<tr><td colspan="8" style="padding:32px;text-align:center;color:#94a3b8">No campaigns yet — create your first one below</td></tr>`
        : campaigns
            .map((c) => {
              const emoji = platformEmoji[c.platform?.toLowerCase()] ?? "📢";
              const sCps = c.clicks > 0 ? (c.spend / c.clicks).toFixed(2) : "—";
              return `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
          <td style="padding:12px 16px;color:#e8f0ff;font-weight:600">${emoji} ${escapeHtml(c.name)}</td>
          <td style="padding:12px 16px;color:#94a3b8;font-size:13px">${escapeHtml(c.platform)}</td>
          <td style="padding:12px 16px;color:#e8f0ff">$${(c.budget ?? 0).toFixed(0)}</td>
          <td style="padding:12px 16px;color:#e8f0ff">$${(c.spend ?? 0).toFixed(2)}</td>
          <td style="padding:12px 16px;color:#e8f0ff">${(c.clicks ?? 0).toLocaleString()}</td>
          <td style="padding:12px 16px;color:#e8f0ff">${(c.impressions ?? 0).toLocaleString()}</td>
          <td style="padding:12px 16px">
            <span style="background:${statusColor[c.status] ?? "#94a3b8"}22;color:${statusColor[c.status] ?? "#94a3b8"};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600">
              ${escapeHtml(c.status)}
            </span>
          </td>
          <td style="padding:12px 16px">
            <button
              class="edit-btn"
              data-id="${c.id}"
              data-name="${escapeHtml(c.name)}"
              data-platform="${escapeHtml(c.platform)}"
              data-status="${escapeHtml(c.status)}"
              data-budget="${c.budget ?? 0}"
              data-spend="${c.spend ?? 0}"
              data-clicks="${c.clicks ?? 0}"
              data-impressions="${c.impressions ?? 0}"
              style="background:rgba(79,70,229,0.15);color:#a5b4fc;border:1px solid rgba(79,70,229,0.3);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin-right:6px">Edit</button>
            <button
              class="delete-btn"
              data-id="${c.id}"
              style="background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.2);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer">Delete</button>
          </td>
        </tr>`;
            })
            .join("");

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ad Campaigns — ProBid AI Admin</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,sans-serif;background:#0a0e1a;color:#e8f0ff;padding:0}
    .header{background:#121a2a;border-bottom:1px solid rgba(255,255,255,0.08);padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
    .logo{font-size:18px;font-weight:800;color:#e8f0ff;text-decoration:none}
    .back{color:#94a3b8;text-decoration:none;font-size:13px}
    .container{max-width:1200px;margin:0 auto;padding:32px 20px}
    h1{font-size:1.8rem;font-weight:800;margin:0 0 4px;color:#e8f0ff}
    .subtitle{color:#94a3b8;margin:0 0 32px;font-size:14px}
    .stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-bottom:32px}
    .stat{background:#121a2a;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px}
    .stat-val{font-size:1.6rem;font-weight:800;color:#e8f0ff;margin-bottom:4px}
    .stat-lbl{font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
    .card{background:#121a2a;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;margin-bottom:32px}
    .card-header{padding:20px 24px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between}
    .card-title{font-size:15px;font-weight:700;color:#e8f0ff;margin:0}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;border:none;transition:all .2s}
    .btn-primary{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff}
    .btn-primary:hover{opacity:.9}
    table{width:100%;border-collapse:collapse}
    th{padding:10px 16px;text-align:left;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;background:rgba(255,255,255,0.03)}
    .chart-wrap{padding:20px 24px;height:280px}
    input,select{width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#e8f0ff;font-size:14px;font-family:inherit}
    input::placeholder{color:#4b5563}
    input:focus,select:focus{outline:none;border-color:rgba(99,102,241,0.6)}
    select option{background:#0a0e1a}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:24px}
    .form-group label{display:block;font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center}
    .modal-overlay.open{display:flex}
    .modal{background:#121a2a;border:1px solid rgba(79,70,229,0.3);border-radius:16px;width:100%;max-width:560px;padding:32px;max-height:90vh;overflow-y:auto}
    .modal h2{margin:0 0 24px;font-size:18px;color:#e8f0ff}
    .modal-footer{display:flex;gap:12px;margin-top:24px;justify-content:flex-end}
    .btn-cancel{background:rgba(255,255,255,0.06);color:#94a3b8;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer}
    @media(max-width:640px){.form-grid{grid-template-columns:1fr}.stats-row{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body>
  <div class="header">
    <a href="/" class="logo">ProBid AI</a>
    <a href="/admin" class="back">← Admin Dashboard</a>
  </div>
  <div class="container">
    <h1>Ad Campaigns</h1>
    <p class="subtitle">Track manual ad spend and performance across all platforms</p>

    <div class="stats-row">
      <div class="stat"><div class="stat-val">${campaigns.length}</div><div class="stat-lbl">Campaigns</div></div>
      <div class="stat"><div class="stat-val">$${totalSpend.toFixed(0)}</div><div class="stat-lbl">Total Spend</div></div>
      <div class="stat"><div class="stat-val">${totalClicks.toLocaleString()}</div><div class="stat-lbl">Total Clicks</div></div>
      <div class="stat"><div class="stat-val">${ctr}</div><div class="stat-lbl">Avg CTR</div></div>
      <div class="stat"><div class="stat-val">$${cpc}</div><div class="stat-lbl">Avg CPC</div></div>
    </div>

    <!-- 30-day signups chart -->
    <div class="card">
      <div class="card-header"><h3 class="card-title">30-Day Signups</h3></div>
      <div class="chart-wrap">
        <canvas id="signupsChart"></canvas>
      </div>
    </div>

    <!-- Campaign table -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">All Campaigns</h3>
        <button class="btn btn-primary" onclick="openCreate()">+ Add Campaign</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th><th>Platform</th><th>Budget</th><th>Spend</th>
            <th>Clicks</th><th>Impressions</th><th>Status</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </div>

  <!-- Create / Edit modal -->
  <div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <h2 id="modalTitle">Add Campaign</h2>
      <form id="campaignForm" onsubmit="submitCampaign(event)">
        <input type="hidden" id="campaignId" value="">
        <div class="form-grid">
          <div class="form-group" style="grid-column:1/-1">
            <label>Campaign Name *</label>
            <input type="text" id="fName" placeholder="e.g. Google Search — Roofers" required>
          </div>
          <div class="form-group">
            <label>Platform *</label>
            <select id="fPlatform">
              <option value="google">Google</option>
              <option value="meta">Meta (FB/IG)</option>
              <option value="youtube">YouTube</option>
              <option value="linkedin">LinkedIn</option>
              <option value="tiktok">TikTok</option>
              <option value="twitter">Twitter/X</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label>Status</label>
            <select id="fStatus">
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="ended">Ended</option>
            </select>
          </div>
          <div class="form-group">
            <label>Budget ($)</label>
            <input type="number" id="fBudget" min="0" step="1" placeholder="0">
          </div>
          <div class="form-group">
            <label>Spend ($)</label>
            <input type="number" id="fSpend" min="0" step="0.01" placeholder="0.00">
          </div>
          <div class="form-group">
            <label>Clicks</label>
            <input type="number" id="fClicks" min="0" placeholder="0">
          </div>
          <div class="form-group">
            <label>Impressions</label>
            <input type="number" id="fImpressions" min="0" placeholder="0">
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-cancel" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="submitBtn">Save Campaign</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    // Spend-vs-Signups chart (dual axis: signups bars + total campaign spend line)
    const totalSpend = ${totalSpend};
    const numDays = ${Math.max(chartLabels.length, 1)};
    const avgDailySpend = totalSpend / numDays;
    const spendLine = Array(${chartLabels.length}).fill(parseFloat(avgDailySpend.toFixed(2)));

    const ctx = document.getElementById('signupsChart').getContext('2d');
    new Chart(ctx, {
      data: {
        labels: ${JSON.stringify(chartLabels)},
        datasets: [
          {
            type: 'bar',
            label: 'Signups',
            data: ${JSON.stringify(chartData)},
            backgroundColor: 'rgba(79,70,229,0.5)',
            borderColor: 'rgba(99,102,241,1)',
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'ySignups',
          },
          {
            type: 'line',
            label: 'Avg Daily Spend $ (total ÷ days)',
            data: spendLine,
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.08)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0,
            fill: true,
            yAxisID: 'ySpend',
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: { color: '#94a3b8', font: { size: 11 } }
          }
        },
        scales: {
          x: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
          ySignups: {
            type: 'linear', position: 'left',
            ticks: { color: '#a5b4fc', font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'Signups', color: '#a5b4fc', font: { size: 11 } }
          },
          ySpend: {
            type: 'linear', position: 'right',
            ticks: { color: '#22c55e', font: { size: 11 }, callback: v => '$' + v },
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Avg Daily Spend', color: '#22c55e', font: { size: 11 } }
          }
        }
      }
    });

    function openCreate() {
      document.getElementById('modalTitle').textContent = 'Add Campaign';
      document.getElementById('campaignId').value = '';
      document.getElementById('campaignForm').reset();
      document.getElementById('submitBtn').textContent = 'Add Campaign';
      document.getElementById('modalOverlay').classList.add('open');
    }

    // Edit: read campaign data from data-* attributes (safe — no JSON in HTML attr)
    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('modalTitle').textContent = 'Edit Campaign';
        document.getElementById('campaignId').value = btn.dataset.id;
        document.getElementById('fName').value = btn.dataset.name || '';
        document.getElementById('fPlatform').value = (btn.dataset.platform || 'google').toLowerCase();
        document.getElementById('fStatus').value = btn.dataset.status || 'active';
        document.getElementById('fBudget').value = btn.dataset.budget || '0';
        document.getElementById('fSpend').value = btn.dataset.spend || '0';
        document.getElementById('fClicks').value = btn.dataset.clicks || '0';
        document.getElementById('fImpressions').value = btn.dataset.impressions || '0';
        document.getElementById('submitBtn').textContent = 'Save Changes';
        document.getElementById('modalOverlay').classList.add('open');
      });
    });

    // Delete: use data-id attribute to call DELETE endpoint directly
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this campaign?')) return;
        const id = btn.dataset.id;
        const r = await fetch('/api/admin/ads/' + id, { method: 'DELETE' });
        const data = await r.json();
        if (data.success) location.reload();
        else alert('Delete failed: ' + (data.error || 'Unknown error'));
      });
    });

    function closeModal() {
      document.getElementById('modalOverlay').classList.remove('open');
    }

    async function submitCampaign(e) {
      e.preventDefault();
      const id = document.getElementById('campaignId').value;
      const body = {
        name: document.getElementById('fName').value,
        platform: document.getElementById('fPlatform').value,
        status: document.getElementById('fStatus').value,
        budget: parseFloat(document.getElementById('fBudget').value) || 0,
        spend: parseFloat(document.getElementById('fSpend').value) || 0,
        clicks: parseInt(document.getElementById('fClicks').value) || 0,
        impressions: parseInt(document.getElementById('fImpressions').value) || 0,
      };
      const url = id
        ? '/api/admin/ads/' + id
        : '/api/admin/ads';
      const method = id ? 'PUT' : 'POST';
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (data.success) location.reload();
      else alert('Error: ' + (data.error || 'Unknown'));
    }
  </script>
</body>
</html>`);
  }),
);
}
