import crypto from "crypto";
import express from "express";
import { z } from "zod";
import { db } from "../db.js";
import { eq, and, desc } from "drizzle-orm";
import { leads } from "../../shared/schema.js";
import { asyncHandler, requireAuth, validateCsrf } from "../lib/middleware.js";
import { now, escapeHtml } from "../lib/utils.js";
import { getSub, isPaidActive } from "../lib/user-helpers.js";
import { syncDealForNewLead } from "../lib/pipeline-sync.js";

const leadSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
});

export function registerLeadsRoutes(app: express.Application) {
// --- Leads CRM ---
app.get(
  "/leads",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const sub = await getSub(uid);
    const paid = isPaidActive(sub);
    const userEmail = req.session?.email || "user";

    const leadsList = await db
      .select()
      .from(leads)
      .where(eq(leads.userId, uid))
      .orderBy(desc(leads.createdAt))
      .limit(100);

    const totalLeads = leadsList.length;
    const newLeads = leadsList.filter((l) => l.status === "new").length;
    const contactedLeads = leadsList.filter(
      (l) => l.status === "contacted",
    ).length;
    const wonLeads = leadsList.filter((l) => l.status === "won").length;

    const statusConfig: Record<
      string,
      { bg: string; color: string; label: string }
    > = {
      new: { bg: "rgba(59, 130, 246, 0.15)", color: "#60a5fa", label: "New" },
      contacted: {
        bg: "rgba(245, 158, 11, 0.15)",
        color: "#fbbf24",
        label: "Contacted",
      },
      quoted: {
        bg: "rgba(139, 92, 246, 0.15)",
        color: "#a78bfa",
        label: "Quoted",
      },
      won: { bg: "rgba(34, 197, 94, 0.15)", color: "#4ade80", label: "Won" },
      lost: { bg: "rgba(239, 68, 68, 0.15)", color: "#f87171", label: "Lost" },
    };

    const rows = leadsList
      .map((l) => {
        const statusStyle = statusConfig[l.status] || statusConfig.new;
        return `
    <tr class="table-row">
      <td>
        <div class="lead-name">${escapeHtml(l.name)}</div>
        ${l.address ? `<div class="lead-address">${escapeHtml(l.address)}</div>` : ""}
      </td>
      <td><span class="table-cell-text">${escapeHtml(l.email || "-")}</span></td>
      <td><span class="table-cell-text">${escapeHtml(l.phone || "-")}</span></td>
      <td><span class="status-badge" style="background:${statusStyle.bg};color:${statusStyle.color};border:1px solid ${statusStyle.color}40">${statusStyle.label}</span></td>
      <td><span class="table-cell-text">${new Date(l.createdAt).toLocaleDateString()}</span></td>
      <td>
        <a class="action-btn-sm" href="/leads/${l.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </a>
      </td>
    </tr>
  `;
      })
      .join("");

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>Leads CRM - ProBid AI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4f46e5;
      --primary-light: #6366f1;
      --primary-dark: #3730a3;
      --accent: #22c55e;
      --accent-dark: #16a34a;
      --warning: #f59e0b;
      --danger: #ef4444;
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
      --bg-input: rgba(11, 15, 25, 0.8);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
      --text-dark: #0b0f19;
      --glass-bg: rgba(255, 255, 255, 0.05);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    html { scroll-behavior: smooth; }
    
    body {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .animate-fade-in { animation: fadeInUp 0.5s ease-out forwards; }
    .animate-delay-1 { animation-delay: 0.1s; opacity: 0; }
    .animate-delay-2 { animation-delay: 0.2s; opacity: 0; }
    .animate-delay-3 { animation-delay: 0.3s; opacity: 0; }
    .animate-delay-4 { animation-delay: 0.4s; opacity: 0; }

    .dashboard-header {
      background: rgba(10, 14, 26, 0.95);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
      padding: 16px 0;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-inner {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
    }

    .logo {
      font-size: 1.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-decoration: none;
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      color: white;
    }

    .user-details {
      display: flex;
      flex-direction: column;
    }

    .user-email {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .user-plan {
      font-size: 12px;
      color: var(--text-muted);
    }

    .nav-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .nav-link {
      padding: 10px 16px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .nav-link:hover {
      color: var(--text-primary);
      background: var(--glass-bg);
    }

    .nav-link.active {
      color: var(--primary-light);
      background: rgba(79, 70, 229, 0.1);
    }

    .plan-badge {
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .plan-badge.free {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(251, 191, 36, 0.2));
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: var(--warning);
    }

    .plan-badge.paid {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2));
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: var(--accent);
    }

    .main-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 32px;
      flex-wrap: wrap;
      gap: 20px;
    }

    .page-title {
      font-size: 2rem;
      font-weight: 800;
      margin-bottom: 8px;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .page-subtitle {
      color: var(--text-muted);
      font-size: 16px;
    }

    .add-lead-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 28px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
      transition: all 0.3s ease;
    }

    .add-lead-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }

    .stat-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      transition: all 0.3s ease;
    }

    .stat-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-light);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
    }

    .stat-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }

    .stat-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }

    .stat-icon.total { background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(79, 70, 229, 0.2)); }
    .stat-icon.new { background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(37, 99, 235, 0.2)); }
    .stat-icon.contacted { background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(251, 191, 36, 0.2)); }
    .stat-icon.won { background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2)); }

    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 2.25rem;
      font-weight: 800;
      color: var(--text-primary);
    }

    .table-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      overflow: hidden;
    }

    .table-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .table-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
    }

    .data-table thead th {
      padding: 16px 20px;
      text-align: left;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      background: rgba(0, 0, 0, 0.2);
      border-bottom: 1px solid var(--border-color);
    }

    .data-table tbody td {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-color);
      vertical-align: middle;
    }

    .table-row {
      transition: all 0.2s ease;
    }

    .table-row:hover {
      background: var(--bg-card-hover);
    }

    .table-row:last-child td {
      border-bottom: none;
    }

    .lead-name {
      font-weight: 600;
      color: var(--text-primary);
      font-size: 14px;
    }

    .lead-address {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .table-cell-text {
      color: var(--text-muted);
      font-size: 14px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: capitalize;
    }

    .action-btn-sm {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid var(--border-light);
      transition: all 0.2s ease;
    }

    .action-btn-sm:hover {
      background: rgba(99, 102, 241, 0.2);
      transform: translateY(-1px);
    }

    .empty-state {
      text-align: center;
      padding: 80px 40px;
    }

    .empty-icon {
      font-size: 4rem;
      margin-bottom: 24px;
      opacity: 0.6;
    }

    .empty-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 12px;
    }

    .empty-text {
      color: var(--text-muted);
      font-size: 15px;
      max-width: 400px;
      margin: 0 auto 32px;
      line-height: 1.7;
    }

    .empty-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 28px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
      transition: all 0.3s ease;
    }

    .empty-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4);
    }

    @media (max-width: 1024px) {
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 768px) {
      .header-inner {
        flex-wrap: wrap;
        gap: 12px;
      }

      .nav-actions {
        flex-wrap: wrap;
      }

      .page-header {
        flex-direction: column;
        align-items: stretch;
      }

      .add-lead-btn {
        justify-content: center;
      }

      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
      }

      .stat-card {
        padding: 16px;
      }

      .stat-value {
        font-size: 1.75rem;
      }

      .data-table {
        display: block;
        overflow-x: auto;
      }

      .user-details {
        display: none;
      }
    }

    @media (max-width: 480px) {
      .main-container {
        padding: 20px 16px;
      }

      .stats-grid {
        grid-template-columns: 1fr 1fr;
      }

      .nav-link span {
        display: none;
      }
    }
  </style>
</head>
<body>
  <header class="dashboard-header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      
      <nav class="nav-actions">
        <a href="/app" class="nav-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          <span>Dashboard</span>
        </a>
        <a href="/leads" class="nav-link active">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Leads</span>
        </a>
        <a href="/history" class="nav-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>History</span>
        </a>
        ${paid ? `<a href="/billing" class="nav-link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg><span>Billing</span></a>` : ""}
        <span class="plan-badge ${paid ? "paid" : "free"}">${paid ? "Pro" : "Free"}</span>
      </nav>

      <div class="user-info">
        <div class="user-avatar">${escapeHtml(userEmail.charAt(0).toUpperCase())}</div>
        <div class="user-details">
          <span class="user-email">${escapeHtml(userEmail)}</span>
          <span class="user-plan">${paid ? "Pro Plan" : "Free Plan"}</span>
        </div>
        <a href="/logout" class="nav-link">Logout</a>
      </div>
    </div>
  </header>

  <main class="main-container">
    <div class="page-header animate-fade-in">
      <div>
        <h1 class="page-title">Leads CRM</h1>
        <p class="page-subtitle">Manage your leads and track conversions</p>
      </div>
      <a href="/leads/new" class="add-lead-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Lead
      </a>
    </div>

    <div class="stats-grid">
      <div class="stat-card animate-fade-in animate-delay-1">
        <div class="stat-header">
          <span class="stat-label">Total Leads</span>
          <div class="stat-icon total">📊</div>
        </div>
        <div class="stat-value">${totalLeads}</div>
      </div>
      <div class="stat-card animate-fade-in animate-delay-2">
        <div class="stat-header">
          <span class="stat-label">New</span>
          <div class="stat-icon new">🆕</div>
        </div>
        <div class="stat-value">${newLeads}</div>
      </div>
      <div class="stat-card animate-fade-in animate-delay-3">
        <div class="stat-header">
          <span class="stat-label">Contacted</span>
          <div class="stat-icon contacted">📞</div>
        </div>
        <div class="stat-value">${contactedLeads}</div>
      </div>
      <div class="stat-card animate-fade-in animate-delay-4">
        <div class="stat-header">
          <span class="stat-label">Won</span>
          <div class="stat-icon won">🏆</div>
        </div>
        <div class="stat-value">${wonLeads}</div>
      </div>
    </div>

    <div class="table-card animate-fade-in animate-delay-3">
      ${
        leadsList.length === 0
          ? `<div class="empty-state">
            <div class="empty-icon">👥</div>
            <h3 class="empty-title">No leads yet</h3>
            <p class="empty-text">Start tracking your leads to manage your sales pipeline. Leads are automatically created when you add client info to estimates, or you can add them manually.</p>
            <a href="/leads/new" class="empty-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add Your First Lead
            </a>
          </div>`
          : `<div class="table-header">
            <span class="table-title">All Leads</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
      }
    </div>
  </main>
</body>
</html>
  `);
  }),
);

// --- Add/Edit Lead ---
app.get("/leads/new", requireAuth, (req, res) => {
  res.type("html").send(leadFormPage(null, req.session!.csrfToken || ""));
});

app.get(
  "/leads/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const leadResult = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, req.params.id), eq(leads.userId, uid)));
    const lead = leadResult[0];
    if (!lead) return res.status(404).send("Lead not found");
    res.type("html").send(leadFormPage(lead, req.session!.csrfToken || ""));
  }),
);

app.post(
  "/leads",
  requireAuth,
  validateCsrf,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;

    const parseResult = leadSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res
        .status(400)
        .json({ error: parseResult.error.issues[0].message });
    }
    const { id, name, email, phone, address, notes, status } = parseResult.data;

    if (id) {
      // Update
      await db
        .update(leads)
        .set({
          name: name,
          email: email || null,
          phone: phone || null,
          address: address || null,
          notes: notes || null,
          status: status || "new",
          updatedAt: now(),
        })
        .where(and(eq(leads.id, id), eq(leads.userId, uid)));
    } else {
      // Create
      const newId = crypto.randomUUID();
      await db.insert(leads).values({
        id: newId,
        userId: uid,
        name: name,
        email: email || null,
        phone: phone || null,
        address: address || null,
        notes: notes || null,
        status: status || "new",
        createdAt: now(),
        updatedAt: now(),
      });

      // Auto-populate Sales Pipeline: new lead → "Lead" stage deal.
      syncDealForNewLead({
        userId: uid,
        leadId: newId,
        source: {
          title: name,
          clientName: name,
          clientEmail: email || null,
          clientPhone: phone || null,
          projectAddress: address || null,
          description: notes || null,
        },
      }).catch(() => undefined);

      // Notify partner systems that a new lead landed. Fire-and-forget so
      // a slow webhook subscriber can never block the redirect below.
      import("../lib/automation-engine.js")
        .then((m) =>
          m.fireAutomationEvent(uid, "lead_created", {
            leadId: newId,
            name,
            email: email || undefined,
            phone: phone || undefined,
            address: address || undefined,
            status: status || "new",
          }),
        )
        .catch(() => undefined);
    }

    res.redirect("/leads");
  }),
);

}

function leadFormPage(lead: any | null, csrfToken: string) {
  const isEdit = !!lead;
  const safeName = isEdit ? escapeHtml(lead.name || "") : "";
  const safeEmail = isEdit ? escapeHtml(lead.email || "") : "";
  const safePhone = isEdit ? escapeHtml(lead.phone || "") : "";
  const safeAddress = isEdit ? escapeHtml(lead.address || "") : "";
  const safeNotes = isEdit ? escapeHtml(lead.notes || "") : "";
  const safeId = isEdit ? escapeHtml(lead.id || "") : "";

  return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>${isEdit ? "Edit" : "New"} Lead - ProBid AI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4f46e5;
      --primary-light: #6366f1;
      --primary-dark: #3730a3;
      --accent: #22c55e;
      --accent-dark: #16a34a;
      --warning: #f59e0b;
      --danger: #ef4444;
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
      --bg-input: rgba(11, 15, 25, 0.8);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
      --text-dark: #0b0f19;
      --glass-bg: rgba(255, 255, 255, 0.05);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    html { scroll-behavior: smooth; }
    
    body {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .animate-fade-in { animation: fadeInUp 0.5s ease-out forwards; }
    .animate-delay-1 { animation-delay: 0.1s; opacity: 0; }
    .animate-delay-2 { animation-delay: 0.2s; opacity: 0; }

    .dashboard-header {
      background: rgba(10, 14, 26, 0.95);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
      padding: 16px 0;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-inner {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
    }

    .logo {
      font-size: 1.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-decoration: none;
    }

    .nav-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .nav-link {
      padding: 10px 16px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .nav-link:hover {
      color: var(--text-primary);
      background: var(--glass-bg);
    }

    .nav-link.active {
      color: var(--primary-light);
      background: rgba(79, 70, 229, 0.1);
    }

    .main-container {
      max-width: 700px;
      margin: 0 auto;
      padding: 40px 24px;
    }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .page-title {
      font-size: 2rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      border-radius: 10px;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      transition: all 0.3s ease;
    }

    .back-btn:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
      transform: translateY(-1px);
    }

    .form-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 32px;
      transition: all 0.3s ease;
    }

    .form-card:hover {
      border-color: var(--border-light);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
    }

    .form-group {
      margin-bottom: 24px;
    }

    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .form-label .required {
      color: var(--danger);
      margin-left: 2px;
    }

    .form-input,
    .form-textarea,
    .form-select {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 15px;
      font-family: inherit;
      transition: all 0.3s ease;
    }

    .form-input:focus,
    .form-textarea:focus,
    .form-select:focus {
      outline: none;
      border-color: var(--primary-light);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .form-input::placeholder,
    .form-textarea::placeholder {
      color: rgba(148, 163, 184, 0.5);
    }

    .form-textarea {
      resize: vertical;
      min-height: 100px;
    }

    .form-select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 16px center;
      padding-right: 48px;
    }

    .form-select option {
      background: var(--bg-dark);
      color: var(--text-primary);
      padding: 12px;
    }

    .status-options {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
    }

    .status-option {
      position: relative;
    }

    .status-option input {
      position: absolute;
      opacity: 0;
      cursor: pointer;
    }

    .status-option label {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      border: 2px solid transparent;
    }

    .status-option.new label {
      background: rgba(59, 130, 246, 0.1);
      color: #60a5fa;
      border-color: rgba(59, 130, 246, 0.3);
    }

    .status-option.contacted label {
      background: rgba(245, 158, 11, 0.1);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.3);
    }

    .status-option.quoted label {
      background: rgba(139, 92, 246, 0.1);
      color: #a78bfa;
      border-color: rgba(139, 92, 246, 0.3);
    }

    .status-option.won label {
      background: rgba(34, 197, 94, 0.1);
      color: #4ade80;
      border-color: rgba(34, 197, 94, 0.3);
    }

    .status-option.lost label {
      background: rgba(239, 68, 68, 0.1);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
    }

    .status-option input:checked + label {
      transform: scale(1.02);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }

    .status-option.new input:checked + label {
      background: rgba(59, 130, 246, 0.25);
      border-color: #60a5fa;
    }

    .status-option.contacted input:checked + label {
      background: rgba(245, 158, 11, 0.25);
      border-color: #fbbf24;
    }

    .status-option.quoted input:checked + label {
      background: rgba(139, 92, 246, 0.25);
      border-color: #a78bfa;
    }

    .status-option.won input:checked + label {
      background: rgba(34, 197, 94, 0.25);
      border-color: #4ade80;
    }

    .status-option.lost input:checked + label {
      background: rgba(239, 68, 68, 0.25);
      border-color: #f87171;
    }

    .form-actions {
      display: flex;
      gap: 12px;
      margin-top: 32px;
    }

    .submit-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 32px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
      border: none;
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .submit-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4);
    }

    .cancel-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 24px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid var(--border-color);
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .cancel-btn:hover {
      color: var(--text-primary);
      background: var(--glass-bg);
      border-color: var(--border-light);
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    @media (max-width: 768px) {
      .main-container {
        padding: 24px 16px;
      }

      .form-card {
        padding: 24px;
      }

      .page-header {
        flex-direction: column;
        align-items: stretch;
      }

      .form-row {
        grid-template-columns: 1fr;
      }

      .status-options {
        grid-template-columns: repeat(2, 1fr);
      }

      .form-actions {
        flex-direction: column;
      }

      .cancel-btn {
        order: 2;
      }
    }

    @media (max-width: 480px) {
      .status-options {
        grid-template-columns: 1fr 1fr;
      }
    }
  </style>
</head>
<body>
  <header class="dashboard-header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      
      <nav class="nav-actions">
        <a href="/app" class="nav-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          Dashboard
        </a>
        <a href="/leads" class="nav-link active">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Leads
        </a>
        <a href="/history" class="nav-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          History
        </a>
      </nav>
    </div>
  </header>

  <main class="main-container">
    <div class="page-header animate-fade-in">
      <h1 class="page-title">${isEdit ? "Edit Lead" : "Add New Lead"}</h1>
      <a href="/leads" class="back-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        Back to Leads
      </a>
    </div>

    <div class="form-card animate-fade-in animate-delay-1">
      <form method="POST" action="/leads">
        <input type="hidden" name="_csrf" value="${csrfToken}"/>
        ${isEdit ? `<input type="hidden" name="id" value="${safeId}"/>` : ""}

        <div class="form-group">
          <label class="form-label">Name <span class="required">*</span></label>
          <input type="text" name="name" class="form-input" required value="${safeName}" placeholder="Enter lead name"/>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Email</label>
            <input type="email" name="email" class="form-input" value="${safeEmail}" placeholder="email@example.com"/>
          </div>

          <div class="form-group">
            <label class="form-label">Phone</label>
            <input type="tel" name="phone" class="form-input" value="${safePhone}" placeholder="(555) 123-4567"/>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Address</label>
          <input type="text" name="address" class="form-input" value="${safeAddress}" placeholder="Street address, city, state"/>
        </div>

        <div class="form-group">
          <label class="form-label">Status</label>
          <div class="status-options">
            <div class="status-option new">
              <input type="radio" name="status" id="status-new" value="new" ${!isEdit || lead.status === "new" ? "checked" : ""}>
              <label for="status-new">🆕 New</label>
            </div>
            <div class="status-option contacted">
              <input type="radio" name="status" id="status-contacted" value="contacted" ${isEdit && lead.status === "contacted" ? "checked" : ""}>
              <label for="status-contacted">📞 Contacted</label>
            </div>
            <div class="status-option quoted">
              <input type="radio" name="status" id="status-quoted" value="quoted" ${isEdit && lead.status === "quoted" ? "checked" : ""}>
              <label for="status-quoted">📋 Quoted</label>
            </div>
            <div class="status-option won">
              <input type="radio" name="status" id="status-won" value="won" ${isEdit && lead.status === "won" ? "checked" : ""}>
              <label for="status-won">🏆 Won</label>
            </div>
            <div class="status-option lost">
              <input type="radio" name="status" id="status-lost" value="lost" ${isEdit && lead.status === "lost" ? "checked" : ""}>
              <label for="status-lost">❌ Lost</label>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea name="notes" class="form-textarea" rows="4" placeholder="Add any additional notes about this lead...">${safeNotes}</textarea>
        </div>

        <div class="form-actions">
          <button class="submit-btn" type="submit">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            ${isEdit ? "Save Changes" : "Create Lead"}
          </button>
          <a href="/leads" class="cancel-btn">Cancel</a>
        </div>
      </form>
    </div>
  </main>
</body>
</html>
  `;
}
