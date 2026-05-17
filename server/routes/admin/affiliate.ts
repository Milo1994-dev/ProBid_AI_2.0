import express from "express";
import { db, pool } from "../../db.js";
import { eq, and, or, desc, count, sum, between } from "drizzle-orm";
import {
  users, leads, affiliateEarnings, affiliateClicks, referrals,
} from "../../../shared/schema.js";
import { asyncHandler, requireAdminAuth, requireAdminAuthPage, requireAuth } from "../../lib/middleware.js";
import { escapeHtml } from "../../lib/utils.js";
import { getUser, getSub, isPaidActive } from "../../lib/user-helpers.js";
import { ensureAffiliateCode } from "../../lib/affiliate-helpers.js";

const APP_URL =
  process.env.REPLIT_DEPLOYMENT === "1"
    ? "https://probidcore.net"
    : process.env.APP_URL || "http://localhost:5000";

export function registerAdminAffiliateRoutes(app: express.Application) {
// --- Affiliate Dashboard ---
app.get(
  "/affiliate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const sub = await getSub(uid);
    const paid = isPaidActive(sub);
    const user = await getUser(uid);

    const affiliateCode = await ensureAffiliateCode(uid);
    const affiliateLink = `${APP_URL}/r/${affiliateCode}`;
    const commissionRate = user?.commissionRate || 0.2;
    const commissionPercent = Math.round(commissionRate * 100);

    const totalClicksResult = await db
      .select({ c: count() })
      .from(affiliateClicks)
      .where(eq(affiliateClicks.affiliateCode, affiliateCode));
    const totalClicks = totalClicksResult[0]?.c || 0;

    const totalSignupsResult = await db
      .select({ c: count() })
      .from(referrals)
      .where(eq(referrals.referrerUserId, uid));
    const totalSignups = totalSignupsResult[0]?.c || 0;

    const convertedCountResult = await db
      .select({ c: count() })
      .from(referrals)
      .where(
        and(
          eq(referrals.referrerUserId, uid),
          eq(referrals.status, "subscribed"),
        ),
      );
    const convertedCount = convertedCountResult[0]?.c || 0;

    const pendingEarningsResult = await db
      .select({ total: sum(affiliateEarnings.amountCents) })
      .from(affiliateEarnings)
      .where(
        and(
          eq(affiliateEarnings.affiliateUserId, uid),
          eq(affiliateEarnings.status, "pending"),
        ),
      );
    const pendingEarnings = pendingEarningsResult[0]?.total || 0;

    const paidEarningsResult = await db
      .select({ total: sum(affiliateEarnings.amountCents) })
      .from(affiliateEarnings)
      .where(
        and(
          eq(affiliateEarnings.affiliateUserId, uid),
          eq(affiliateEarnings.status, "paid"),
        ),
      );
    const paidEarnings = paidEarningsResult[0]?.total || 0;

    const referralsRaw = await pool.query(
      `
    SELECT r.*, u.email as referred_email 
    FROM referrals r 
    JOIN users u ON r.referred_user_id = u.id 
    WHERE r.referrer_user_id = $1 
    ORDER BY r.created_at DESC 
    LIMIT 50
  `,
      [uid],
    );
    const referralsList = referralsRaw.rows as any[];

    const earningsList = await db
      .select()
      .from(affiliateEarnings)
      .where(eq(affiliateEarnings.affiliateUserId, uid))
      .orderBy(desc(affiliateEarnings.createdAt))
      .limit(50);

    function maskEmail(email: string): string {
      if (!email || !email.includes("@")) return "***@***.***";
      const [local, domain] = email.split("@");
      const maskedLocal =
        local.length > 2 ? local[0] + "***" + local[local.length - 1] : "***";
      const domainParts = domain.split(".");
      const maskedDomain =
        domainParts[0].length > 2 ? domainParts[0][0] + "***" : "***";
      return `${maskedLocal}@${maskedDomain}.${domainParts.slice(1).join(".")}`;
    }

    function formatCents(cents: number): string {
      return "$" + (cents / 100).toFixed(2);
    }

    function formatDate(dateStr: string): string {
      const d = new Date(dateStr);
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    function getStatusBadgeClass(status: string): string {
      switch (status) {
        case "signed_up":
          return "badge-yellow";
        case "subscribed":
          return "badge-green";
        case "cancelled":
          return "badge-red";
        case "pending":
          return "badge-yellow";
        case "paid":
          return "badge-green";
        default:
          return "badge-gray";
      }
    }

    const referralsHtml =
      referralsList.length > 0
        ? referralsList
            .map(
              (r) => `
      <tr>
        <td>${formatDate(r.created_at)}</td>
        <td>${maskEmail(r.referred_email)}</td>
        <td><span class="status-badge ${getStatusBadgeClass(r.status)}">${r.status === "signed_up" ? "Signed Up" : r.status === "subscribed" ? "Subscribed" : r.status === "cancelled" ? "Cancelled" : r.status}</span></td>
      </tr>
    `,
            )
            .join("")
        : `<tr><td colspan="3" class="empty-state">No referrals yet. Share your link to get started!</td></tr>`;

    const earningsHtml =
      earningsList.length > 0
        ? earningsList
            .map(
              (e) => `
      <tr>
        <td>${formatDate(e.createdAt as string)}</td>
        <td class="amount">${formatCents(e.amountCents as number)}</td>
        <td><span class="status-badge ${getStatusBadgeClass(e.status as string)}">${e.status === "pending" ? "Pending" : e.status === "paid" ? "Paid" : e.status}</span></td>
        <td class="invoice-id">${e.stripeInvoiceId ? (e.stripeInvoiceId as string).substring(0, 20) + "..." : "-"}</td>
      </tr>
    `,
            )
            .join("")
        : `<tr><td colspan="4" class="empty-state">No earnings yet. Earnings appear when referrals subscribe.</td></tr>`;

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>Affiliate Dashboard - ProBid AI</title>
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

    .nav-actions { display: flex; gap: 8px; align-items: center; }

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

    .nav-link:hover { color: var(--text-primary); background: var(--glass-bg); }
    .nav-link.active { color: var(--primary-light); background: rgba(79, 70, 229, 0.1); }

    .main-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    .page-header {
      margin-bottom: 32px;
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

    .affiliate-link-card {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%);
      backdrop-filter: blur(10px);
      border: 2px solid var(--border-light);
      border-radius: 20px;
      padding: 32px;
      margin-bottom: 32px;
    }

    .affiliate-link-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .affiliate-link-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }

    .affiliate-link-title {
      font-size: 1.25rem;
      font-weight: 700;
    }

    .affiliate-link-subtitle {
      color: var(--text-muted);
      font-size: 14px;
    }

    .link-copy-container {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }

    .link-input {
      flex: 1;
      padding: 16px 20px;
      background: var(--bg-input);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      color: var(--text-primary);
      font-size: 15px;
      font-family: monospace;
    }

    .copy-btn {
      padding: 16px 28px;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      border: none;
      border-radius: 12px;
      color: white;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .copy-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4);
    }

    .copy-btn.copied {
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
    }

    .commission-highlight {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 999px;
      color: var(--accent);
      font-size: 14px;
      font-weight: 600;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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

    .stat-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      margin-bottom: 12px;
    }

    .stat-icon.clicks { background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(79, 70, 229, 0.2)); }
    .stat-icon.signups { background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(37, 99, 235, 0.2)); }
    .stat-icon.converted { background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2)); }
    .stat-icon.pending { background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.2)); }
    .stat-icon.paid { background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2)); }
    .stat-icon.rate { background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(139, 92, 246, 0.2)); }

    .stat-value {
      font-size: 1.75rem;
      font-weight: 800;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 600;
    }

    .section-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 28px;
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
    }

    .data-table th,
    .data-table td {
      padding: 14px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
    }

    .data-table th {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.02);
    }

    .data-table td {
      font-size: 14px;
      color: var(--text-primary);
    }

    .data-table tr:last-child td {
      border-bottom: none;
    }

    .data-table tr:hover td {
      background: rgba(99, 102, 241, 0.05);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: capitalize;
    }

    .badge-green {
      background: rgba(34, 197, 94, 0.15);
      color: var(--accent);
      border: 1px solid rgba(34, 197, 94, 0.3);
    }

    .badge-yellow {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .badge-gray {
      background: rgba(148, 163, 184, 0.15);
      color: var(--text-muted);
      border: 1px solid rgba(148, 163, 184, 0.3);
    }

    .amount { font-weight: 700; color: var(--accent); }

    .invoice-id {
      font-family: monospace;
      font-size: 12px;
      color: var(--text-muted);
    }

    .empty-state {
      text-align: center;
      color: var(--text-muted);
      padding: 40px 20px !important;
      font-style: italic;
    }

    .totals-row {
      background: rgba(79, 70, 229, 0.1);
      font-weight: 700;
    }

    .totals-row td {
      border-bottom: none;
      padding: 16px;
    }

    .how-it-works {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
    }

    .step-card {
      text-align: center;
      padding: 24px 16px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: 16px;
      transition: all 0.3s ease;
    }

    .step-card:hover {
      border-color: var(--border-light);
      transform: translateY(-4px);
    }

    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      color: white;
      font-weight: 800;
      font-size: 16px;
      margin-bottom: 12px;
    }

    .step-icon {
      font-size: 2rem;
      margin-bottom: 12px;
      display: block;
    }

    .step-title {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 6px;
      color: var(--text-primary);
    }

    .step-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    @media (max-width: 768px) {
      .header-inner { flex-wrap: wrap; }
      .nav-actions { width: 100%; justify-content: center; flex-wrap: wrap; }
      .link-copy-container { flex-direction: column; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .data-table { font-size: 13px; }
      .data-table th, .data-table td { padding: 10px 8px; }
    }

    @media (max-width: 480px) {
      .main-container { padding: 20px 16px; }
      .affiliate-link-card { padding: 20px; }
      .section-card { padding: 20px; }
      .stats-grid { grid-template-columns: 1fr 1fr; gap: 12px; }
      .stat-card { padding: 16px; }
      .stat-value { font-size: 1.5rem; }
      .nav-link span:last-child { display: none; }
    }
  </style>
</head>
<body>
  <header class="dashboard-header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      <nav class="nav-actions">
        <a href="/app" class="nav-link">
          <span>🏠</span>
          <span>Dashboard</span>
        </a>
        <a href="/history" class="nav-link">
          <span>📋</span>
          <span>History</span>
        </a>
        <a href="/leads" class="nav-link">
          <span>👥</span>
          <span>Leads</span>
        </a>
        <a href="/affiliate" class="nav-link active">
          <span>🤝</span>
          <span>Affiliate</span>
        </a>
        ${paid ? `<a href="/billing" class="nav-link"><span>💳</span><span>Billing</span></a>` : ""}
        <a href="/logout" class="nav-link">
          <span>🚪</span>
          <span>Logout</span>
        </a>
      </nav>
    </div>
  </header>

  <main class="main-container">
    <div class="page-header animate-fade-in">
      <h1 class="page-title">Affiliate Dashboard 🤝</h1>
      <p class="page-subtitle">Earn ${commissionPercent}% recurring commission for every subscription you refer.</p>
    </div>

    <div class="affiliate-link-card animate-fade-in animate-delay-1">
      <div class="affiliate-link-header">
        <div class="affiliate-link-icon">🔗</div>
        <div>
          <div class="affiliate-link-title">Your Unique Referral Link</div>
          <div class="affiliate-link-subtitle">Share this link to earn ${commissionPercent}% recurring commission on every subscription</div>
        </div>
      </div>
      <div class="link-copy-container">
        <input type="text" class="link-input" id="affiliateLink" value="${affiliateLink}" readonly />
        <button class="copy-btn" id="copyBtn" onclick="copyLink()">
          <span id="copyIcon">📋</span>
          <span id="copyText">Copy Link</span>
        </button>
      </div>
      <div class="commission-highlight">
        💰 Earn ${commissionPercent}% on every payment - recurring monthly!
      </div>
    </div>

    <section class="stats-grid animate-fade-in animate-delay-2">
      <div class="stat-card">
        <div class="stat-icon clicks">👆</div>
        <div class="stat-value">${totalClicks}</div>
        <div class="stat-label">Total Clicks</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon signups">📝</div>
        <div class="stat-value">${totalSignups}</div>
        <div class="stat-label">Total Signups</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon converted">✅</div>
        <div class="stat-value">${convertedCount}</div>
        <div class="stat-label">Converted to Paid</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon pending">⏳</div>
        <div class="stat-value">${formatCents(pendingEarnings)}</div>
        <div class="stat-label">Pending Earnings</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon paid">💵</div>
        <div class="stat-value">${formatCents(paidEarnings)}</div>
        <div class="stat-label">Paid Earnings</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon rate">📊</div>
        <div class="stat-value">${commissionPercent}%</div>
        <div class="stat-label">Commission Rate</div>
      </div>
    </section>

    <div class="section-card animate-fade-in animate-delay-3">
      <h2 class="section-title">📋 Your Referrals</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Referred User</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${referralsHtml}
        </tbody>
      </table>
    </div>

    <div class="section-card animate-fade-in">
      <h2 class="section-title">💰 Your Earnings</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Invoice ID</th>
          </tr>
        </thead>
        <tbody>
          ${earningsHtml}
          ${
            pendingEarnings > 0 || paidEarnings > 0
              ? `
          <tr class="totals-row">
            <td>Totals</td>
            <td class="amount">${formatCents(pendingEarnings + paidEarnings)}</td>
            <td colspan="2">Pending: ${formatCents(pendingEarnings)} | Paid: ${formatCents(paidEarnings)}</td>
          </tr>
          `
              : ""
          }
        </tbody>
      </table>
    </div>

    <div class="section-card animate-fade-in">
      <h2 class="section-title">🚀 How It Works</h2>
      <div class="how-it-works">
        <div class="step-card">
          <div class="step-number">1</div>
          <div class="step-icon">🔗</div>
          <div class="step-title">Share Your Link</div>
          <div class="step-desc">Copy your unique referral link and share it with contractors, friends, or on social media.</div>
        </div>
        <div class="step-card">
          <div class="step-number">2</div>
          <div class="step-icon">📝</div>
          <div class="step-title">They Sign Up Free</div>
          <div class="step-desc">When someone clicks your link and creates an account, they're tracked as your referral.</div>
        </div>
        <div class="step-card">
          <div class="step-number">3</div>
          <div class="step-icon">💳</div>
          <div class="step-title">They Subscribe</div>
          <div class="step-desc">When your referral upgrades to a paid plan, you earn ${commissionPercent}% commission.</div>
        </div>
        <div class="step-card">
          <div class="step-number">4</div>
          <div class="step-icon">🔄</div>
          <div class="step-title">Recurring Monthly</div>
          <div class="step-desc">You earn ${commissionPercent}% every month they stay subscribed. Passive income!</div>
        </div>
      </div>
    </div>
  </main>

  <script>
    function copyLink() {
      const linkInput = document.getElementById('affiliateLink');
      const copyBtn = document.getElementById('copyBtn');
      const copyIcon = document.getElementById('copyIcon');
      const copyText = document.getElementById('copyText');
      
      linkInput.select();
      linkInput.setSelectionRange(0, 99999);
      
      navigator.clipboard.writeText(linkInput.value).then(() => {
        copyBtn.classList.add('copied');
        copyIcon.textContent = '✅';
        copyText.textContent = 'Copied!';
        
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyIcon.textContent = '📋';
          copyText.textContent = 'Copy Link';
        }, 2000);
      }).catch(() => {
        document.execCommand('copy');
        copyBtn.classList.add('copied');
        copyIcon.textContent = '✅';
        copyText.textContent = 'Copied!';
        
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyIcon.textContent = '📋';
          copyText.textContent = 'Copy Link';
        }, 2000);
      });
    }
  </script>
</body>
</html>
  `);
  }),
);


}
