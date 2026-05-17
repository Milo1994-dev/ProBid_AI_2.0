import express from "express";
import crypto from "crypto";
import { db } from "../db.js";
import { eq, and } from "drizzle-orm";
import { log } from "../lib/logger.js";
import { asyncHandler, requireAuth, validateCsrf, generateCsrfToken } from "../lib/middleware.js";
import { safeEqual } from "./admin/shared.js";
import { getEffectiveSub, isBusinessTier } from "../lib/team-helpers.js";
import * as procore from "../procore.js";
import * as metricsEngine from "../metrics-engine.js";
import * as shadowEstimator from "../shadow-estimator.js";
import * as proofGenerator from "../proof-generator.js";
import {
  procoreConnections,
  procoreEstimatePushes,
  purchases,
  users,
  estimates,
} from "../../shared/schema.js";

async function hasLifetimeAccess(uid: string): Promise<boolean> {
  const result = await db.select().from(purchases)
    .where(and(eq(purchases.userId, uid), eq(purchases.type, "lifetime")));
  return result.length > 0;
}

function isAdminSession(req: express.Request): boolean {
  const adminKey = process.env.ADMIN_KEY || "";
  if (!adminKey) return false;
  // Header only — query-string `?key=` is rejected (leaks via logs/Referer).
  // Hard-fail when `?key=` is present even alongside a valid header.
  if (typeof req.query?.key !== "undefined") return false;
  return safeEqual(req.headers["x-admin-key"], adminKey);
}

function requireBusinessTier(req: express.Request, res: express.Response, next: express.NextFunction) {
  const uid = req.session?.uid;
  if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

  if (isAdminSession(req)) return next();

  Promise.all([getEffectiveSub(uid), hasLifetimeAccess(uid)]).then(([sub, lifetime]) => {
    if (lifetime) return next();
    if (!sub || !isBusinessTier(sub.priceId)) {
      return res.status(403).json({
        success: false,
        error: "Business plan required",
        code: "BUSINESS_TIER_REQUIRED",
      });
    }
    next();
  }).catch(next);
}

const APP_URL = process.env.REPLIT_DEPLOYMENT === "1"
  ? "https://probidcore.net"
  : process.env.APP_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://localhost:5000");

const PROCORE_OAUTH_STATES = new Map<string, { userId: string; createdAt: number }>();

async function getUser(uid: string) {
  const result = await db.select().from(users).where(eq(users.id, uid));
  return result[0];
}

function parseEstimateLineItems(estimateText: string): Array<{ description: string; amount: number }> {
  const lines: Array<{ description: string; amount: number }> = [];
  const lineRegex = /^[\s\-\*•]*(.+?)\s*[\:\-–—]+\s*\$?([\d,]+(?:\.\d{1,2})?)/gm;
  let match;
  while ((match = lineRegex.exec(estimateText)) !== null) {
    const description = match[1].trim();
    const amount = parseFloat(match[2].replace(/,/g, ""));
    if (description && !isNaN(amount) && amount > 0) {
      const lower = description.toLowerCase();
      if (lower.includes("total") || lower.includes("grand total") || lower.includes("subtotal")) continue;
      lines.push({ description, amount });
    }
  }
  return lines;
}

export function registerProcoreRoutes(app: express.Application) {
  // Log credential status at startup so it's visible in server logs
  const procoreConfigured = !!(process.env.PROCORE_CLIENT_ID && process.env.PROCORE_CLIENT_SECRET);
  log("info", "Procore Trust Engine status", {
    configured: procoreConfigured,
    callbackUrl: `${APP_URL}/api/procore/callback`,
  });

  // Canonical redirect URI registered in the Procore developer portal
  const PROCORE_REDIRECT_URI = `${APP_URL}/api/procore/callback`;

  app.get("/api/procore/auth/start", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const state = procore.generateState();
    PROCORE_OAUTH_STATES.set(state, { userId: uid, createdAt: Date.now() });
    setTimeout(() => PROCORE_OAUTH_STATES.delete(state), 10 * 60 * 1000);
    const authUrl = procore.getAuthorizationUrl(state, PROCORE_REDIRECT_URI);
    res.json({ success: true, data: { authUrl } });
  }));

  app.get("/api/procore/config", asyncHandler(async (_req, res) => {
    const configured = !!(process.env.PROCORE_CLIENT_ID?.trim() && process.env.PROCORE_CLIENT_SECRET?.trim());
    res.json({ success: true, data: { configured } });
  }));

  // Canonical OAuth callback — register https://probidcore.net/api/procore/callback
  // in your Procore developer app redirect URIs.
  async function handleProcoreOAuthCallback(req: express.Request, res: express.Response) {
    const { code, state, error } = req.query;
    if (error) {
      log('error', 'Procore OAuth error', { error });
      return res.redirect("/app/procore?error=oauth_denied");
    }
    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      return res.redirect("/app/procore?error=invalid_callback");
    }
    const stateData = PROCORE_OAUTH_STATES.get(state);
    if (!stateData) {
      return res.redirect("/app/procore?error=invalid_state");
    }
    PROCORE_OAUTH_STATES.delete(state);
    try {
      const tokens = await procore.exchangeCodeForTokens(code, PROCORE_REDIRECT_URI);
      const tempConnectionId = crypto.randomUUID();
      await db.insert(procoreConnections).values({
        id: tempConnectionId,
        userId: stateData.userId,
        procoreCompanyId: "pending",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: Date.now() + tokens.expires_in * 1000,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      log('info', 'Procore OAuth complete — connection pending company selection', { userId: stateData.userId, connectionId: tempConnectionId });
      res.redirect(`/app/procore?selecting=${tempConnectionId}`);
    } catch (err) {
      log('error', 'Procore token exchange failed', { error: String(err) });
      const reason = err instanceof procore.ProcoreTokenExchangeError ? err.reason : "unknown";
      res.redirect(`/app/procore?error=token_exchange_failed&reason=${encodeURIComponent(reason)}`);
    }
  }

  // Canonical path — must match the redirect URI registered in Procore developer portal
  app.get("/api/procore/callback", asyncHandler(handleProcoreOAuthCallback));
  // Legacy alias for backwards compatibility
  app.get("/api/procore/auth/callback", asyncHandler(handleProcoreOAuthCallback));

  app.get("/api/procore/companies", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    try {
      const companies = await procore.getCompanies(connectionId);
      res.json({ success: true, data: { companies } });
    } catch (err) {
      log('error', 'Failed to get Procore companies', { error: String(err) });
      res.status(500).json({ success: false, error: "Failed to get companies" });
    }
  }));

  app.get("/procore/select-company", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.redirect("/app/procore?error=missing_connection");
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.redirect("/app/procore?error=invalid_connection");
    const csrfToken = req.session!.csrfToken || generateCsrfToken();
    req.session!.csrfToken = csrfToken;
    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Select Procore Company - ProBid</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 500px; width: 100%; padding: 40px; }
    .card { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 16px; padding: 40px; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { color: #888; margin-bottom: 24px; }
    .companies-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
    .company-btn { background: #333; border: 2px solid #444; border-radius: 8px; padding: 16px; text-align: left; cursor: pointer; transition: all 0.2s; color: #fff; font-size: 16px; }
    .company-btn:hover { border-color: #f7931a; background: #2a2a3e; }
    .company-btn.selected { border-color: #f7931a; background: #2a2a3e; }
    .btn { display: inline-block; padding: 12px 32px; border-radius: 8px; font-weight: 600; cursor: pointer; border: none; font-size: 16px; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(90deg, #f7931a, #ffab40); color: #000; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .loading { text-align: center; padding: 40px; color: #888; }
    .error { color: #f87171; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Select Your Company</h1>
      <p>Choose the Procore company you want to connect.</p>
      <div id="companies-list" class="companies-list">
        <div class="loading">Loading companies...</div>
      </div>
      <button id="continue-btn" class="btn btn-primary" disabled onclick="selectCompany()">Continue</button>
      <div id="error" class="error"></div>
    </div>
  </div>
  <script>
    const connectionId = "${connectionId}";
    const csrfToken = "${csrfToken}";
    let selectedCompany = null;
    async function loadCompanies() {
      try {
        const res = await fetch('/api/procore/companies?connection=' + connectionId);
        const data = await res.json();
        if (data.error) { document.getElementById('error').textContent = data.error; document.getElementById('companies-list').innerHTML = ''; return; }
        if (data.companies && data.companies.length > 0) {
          let html = '';
          for (const company of data.companies) {
            html += '<button class="company-btn" data-id="' + company.id + '" data-name="' + (company.name || '').replace(/"/g, '&quot;') + '" onclick="selectCompanyBtn(this)">' + (company.name || 'Company ' + company.id) + '</button>';
          }
          document.getElementById('companies-list').innerHTML = html;
        } else {
          document.getElementById('companies-list').innerHTML = '<p style="color: #888;">No companies found in your Procore account.</p>';
        }
      } catch (err) { document.getElementById('error').textContent = 'Failed to load companies'; document.getElementById('companies-list').innerHTML = ''; }
    }
    function selectCompanyBtn(btn) {
      document.querySelectorAll('.company-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedCompany = { id: btn.dataset.id, name: btn.dataset.name };
      document.getElementById('continue-btn').disabled = false;
    }
    async function selectCompany() {
      if (!selectedCompany) return;
      const btn = document.getElementById('continue-btn');
      btn.disabled = true; btn.textContent = 'Connecting...';
      try {
        const res = await fetch('/api/procore/select-company', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ connectionId, companyId: selectedCompany.id, companyName: selectedCompany.name })
        });
        const data = await res.json();
        if (data.success) { window.location.href = '/app/procore?connected=1'; } else { document.getElementById('error').textContent = data.error || 'Failed to connect'; btn.disabled = false; btn.textContent = 'Continue'; }
      } catch (err) { document.getElementById('error').textContent = 'Connection error'; btn.disabled = false; btn.textContent = 'Continue'; }
    }
    loadCompanies();
  </script>
</body>
</html>
    `);
  }));

  app.post("/api/procore/select-company", requireAuth, requireBusinessTier, validateCsrf, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { connectionId, companyId, companyName } = req.body;
    if (!connectionId || !companyId) return res.status(400).json({ success: false, error: "Connection ID and Company ID required" });

    // Verify ownership and that the connection exists before proceeding
    const existing = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (existing.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });

    const updateResult = await db.update(procoreConnections)
      .set({ procoreCompanyId: String(companyId), companyName: companyName || null, status: "active", updatedAt: Date.now() })
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (!updateResult.rowCount) return res.status(500).json({ success: false, error: "Failed to update connection" });

    // Auto-trigger the full Trust Engine pipeline asynchronously:
    // sync projects → generate shadow estimates → calculate accuracy metrics
    setImmediate(async () => {
      try {
        log("info", "Procore Trust Engine pipeline starting", { connectionId, companyId, companyName });
        const syncedCount = await procore.syncClosedProjects(connectionId);
        log("info", "Procore projects synced", { connectionId, syncedCount });

        const projects = await procore.getConnectionProjects(connectionId);
        for (const project of projects) {
          try {
            await procore.syncProjectBudgets(connectionId, project.id);
            await procore.syncChangeOrders(connectionId, project.id);
          } catch (err) {
            log("warn", "Failed to sync project details", { projectId: project.id, error: String(err) });
          }
        }

        const shadowResult = await shadowEstimator.runShadowEstimatesForConnection(connectionId);
        log("info", "Shadow estimates generated", { connectionId, ...shadowResult });

        await metricsEngine.calculateAndSaveAllMetrics(connectionId);
        const metrics = await metricsEngine.getLatestMetrics(connectionId);
        log("info", "Procore Trust Engine pipeline complete", {
          connectionId,
          accuracyErrorPct: metrics["accuracy_error_pct"]?.value ?? null,
          sampleSize: metrics["accuracy_error_pct"]?.sampleSize ?? null,
        });
      } catch (err) {
        log("error", "Procore Trust Engine pipeline failed", { connectionId, error: String(err) });
      }
    });

    res.json({ success: true, data: { connectionId, pipelineStarted: true } });
  }));

  app.get("/api/procore/connections", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connections = await procore.getUserConnections(uid);
    res.json({ success: true, data: { connections: connections.filter((c: any) => c.status === "active" || c.status === "expired") } });
  }));

  app.post("/api/procore/sync", requireAuth, requireBusinessTier, validateCsrf, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { connectionId } = req.body;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    try {
      const syncedCount = await procore.syncClosedProjects(connectionId);
      const projects = await procore.getConnectionProjects(connectionId);
      for (const project of projects) {
        try {
          await procore.syncProjectBudgets(connectionId, project.id);
          await procore.syncChangeOrders(connectionId, project.id);
        } catch (err) {
          log('warn', 'Failed to sync project details', { projectId: project.id, error: String(err) });
        }
      }
      res.json({ success: true, data: { syncedProjects: syncedCount } });
    } catch (err) {
      log('error', 'Procore sync failed', { error: String(err) });
      res.status(500).json({ success: false, error: "Sync failed" });
    }
  }));

  app.get("/api/procore/projects", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const projects = await procore.getClosedProjectsWithActuals(connectionId);
    res.json({ success: true, data: { projects } });
  }));

  app.post("/api/procore/shadow-estimates", requireAuth, requireBusinessTier, validateCsrf, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { connectionId } = req.body;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    try {
      const result = await shadowEstimator.runShadowEstimatesForConnection(connectionId);
      res.json({ success: true, data: { processed: result.processed, errors: result.errors } });
    } catch (err) {
      log('error', 'Shadow estimate generation failed', { error: String(err) });
      res.status(500).json({ success: false, error: "Failed to generate shadow estimates" });
    }
  }));

  app.post("/api/procore/calculate-metrics", requireAuth, requireBusinessTier, validateCsrf, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { connectionId } = req.body;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    try {
      await metricsEngine.calculateAndSaveAllMetrics(connectionId);
      const metrics = await metricsEngine.getLatestMetrics(connectionId);
      res.json({ success: true, data: { metrics } });
    } catch (err) {
      log('error', 'Metrics calculation failed', { error: String(err) });
      res.status(500).json({ success: false, error: "Failed to calculate metrics" });
    }
  }));

  app.get("/api/procore/metrics", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const metrics = await metricsEngine.getLatestMetrics(connectionId);
    res.json({ success: true, data: { metrics } });
  }));

  app.get("/api/procore/comparisons", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const comparisons = await shadowEstimator.getAllProjectComparisons(connectionId);
    res.json({ success: true, data: { comparisons } });
  }));

  app.get("/api/procore/charts", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const chartData = await proofGenerator.generateChartData(connectionId);
    res.json({ success: true, data: { chartData } });
  }));

  app.get("/api/procore/report/pdf", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    try {
      const filepath = await proofGenerator.generateAccuracyReportPDF(connectionId);
      res.download(filepath);
    } catch (err) {
      log('error', 'PDF generation failed', { error: String(err) });
      res.status(500).json({ success: false, error: "Failed to generate PDF" });
    }
  }));

  app.get("/api/procore/report/markdown", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const markdown = await proofGenerator.generateMarkdownReport(connectionId);
    res.type('text/markdown').send(markdown);
  }));

  app.get("/api/procore/report/csv", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const csv = await proofGenerator.generateCSVExport(connectionId);
    res.type('text/csv').attachment('procore-accuracy-export.csv').send(csv);
  }));

  app.get("/api/procore/sales-copy", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const copy = await proofGenerator.generateSalesCopy(connectionId);
    res.type('text/markdown').send(copy);
  }));

  app.get("/api/procore/investor-narrative", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connectionId = req.query.connection as string;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    const narrative = await proofGenerator.generateInvestorNarrative(connectionId);
    res.type('text/markdown').send(narrative);
  }));

  app.post("/api/procore/disconnect", requireAuth, requireBusinessTier, validateCsrf, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { connectionId } = req.body;
    if (!connectionId) return res.status(400).json({ success: false, error: "Connection ID required" });
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).json({ success: false, error: "Connection not found" });
    await procore.disconnectProcore(connectionId);
    res.json({ success: true, data: {} });
  }));

  app.get("/api/procore/benchmarks", asyncHandler(async (req, res) => {
    const benchmarks = await metricsEngine.getPublicBenchmarks();
    res.json({ success: true, data: { benchmarks } });
  }));

  app.get("/procore", requireAuth, (_req, res) => {
    res.redirect(301, "/app/procore");
  });

  // Legacy SSR handler body (redirected above via /procore → /app/procore)
  {const _legacyNotUsed = asyncHandler(async (req: express.Request, res: express.Response) => {
    const uid = (req.session as any)!.uid!;
    const connections = await procore.getUserConnections(uid);
    const activeConnections = connections.filter((c: any) => c.status === "active");
    const csrfToken = req.session!.csrfToken || generateCsrfToken();
    req.session!.csrfToken = csrfToken;

    let connectionsHtml = "";
    if (activeConnections.length === 0) {
      connectionsHtml = `<p class="no-connections">No Procore connections yet. Connect your Procore account to get started.</p>`;
    } else {
      for (const conn of activeConnections) {
        connectionsHtml += `
        <div class="connection-card" data-connection-id="${conn.id}">
          <div class="connection-header">
            <h3>${conn.companyName || "Procore Company"}</h3>
            <span class="status-badge active">Connected</span>
          </div>
          <p>Last sync: ${conn.lastSyncAt ? new Date(conn.lastSyncAt).toLocaleDateString() : "Never"}</p>
          <div class="connection-actions">
            <button onclick="syncProjects('${conn.id}')" class="btn btn-secondary">Sync Projects</button>
            <button onclick="runShadowEstimates('${conn.id}')" class="btn btn-secondary">Generate Shadow Estimates</button>
            <button onclick="calculateMetrics('${conn.id}')" class="btn btn-secondary">Calculate Metrics</button>
            <a href="/procore/dashboard/${conn.id}" class="btn btn-primary">View Dashboard</a>
          </div>
        </div>`;
      }
    }

    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Procore Trust Engine - ProBid</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; }
    .header h1 { font-size: 24px; background: linear-gradient(90deg, #f7931a, #ffab40); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .nav-links { display: flex; gap: 20px; }
    .nav-links a { color: #aaa; text-decoration: none; transition: color 0.2s; }
    .nav-links a:hover { color: #fff; }
    .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
    .hero { text-align: center; margin-bottom: 60px; }
    .hero h2 { font-size: 36px; margin-bottom: 16px; }
    .hero p { color: #888; font-size: 18px; max-width: 600px; margin: 0 auto; }
    .connect-section { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 16px; padding: 40px; margin-bottom: 40px; text-align: center; }
    .connect-section h3 { font-size: 24px; margin-bottom: 16px; }
    .connect-section p { color: #888; margin-bottom: 24px; }
    .btn { display: inline-block; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; font-size: 16px; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(90deg, #f7931a, #ffab40); color: #000; }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(247, 147, 26, 0.4); }
    .btn-secondary { background: #333; color: #fff; }
    .btn-secondary:hover { background: #444; }
    .connections-grid { display: grid; gap: 24px; }
    .connection-card { background: #1a1a2e; border-radius: 12px; padding: 24px; border: 1px solid #333; }
    .connection-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .connection-header h3 { font-size: 20px; }
    .status-badge { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status-badge.active { background: #1a472a; color: #4ade80; }
    .connection-actions { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
    .no-connections { color: #888; text-align: center; padding: 40px; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; margin-top: 60px; }
    .feature-card { background: #1a1a2e; border-radius: 12px; padding: 24px; border: 1px solid #333; }
    .feature-card h4 { font-size: 18px; margin-bottom: 8px; color: #f7931a; }
    .feature-card p { color: #888; font-size: 14px; }
    .loading { opacity: 0.5; pointer-events: none; }
    .toast { position: fixed; bottom: 20px; right: 20px; padding: 16px 24px; border-radius: 8px; color: #fff; font-weight: 500; z-index: 1000; animation: slideIn 0.3s ease; }
    .toast.success { background: #1a472a; }
    .toast.error { background: #4a1a1a; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  </style>
</head>
<body>
  <header class="header">
    <h1>Procore Trust Engine</h1>
    <nav class="nav-links">
      <a href="/">Dashboard</a>
      <a href="/procore">Procore</a>
      <a href="/logout">Logout</a>
    </nav>
  </header>
  <main class="container">
    <div class="hero">
      <h2>Prove Your Accuracy with Procore Data</h2>
      <p>Connect your Procore account (read-only) and let your closed projects judge ProBid's accuracy. No marketing claims — just math.</p>
    </div>
    <div class="connect-section">
      <h3>Connect Your Procore Account</h3>
      <p>Read-only access. Your data stays yours. Disconnect anytime.</p>
      <button onclick="startProcoreAuth()" class="btn btn-primary" id="connectBtn">Connect Procore</button>
    </div>
    <h3 style="margin-bottom: 24px;">Your Connections</h3>
    <div class="connections-grid">${connectionsHtml}</div>
    <div class="features">
      <div class="feature-card"><h4>Shadow Estimates</h4><p>ProBid generates estimates for your closed projects without affecting your workflow.</p></div>
      <div class="feature-card"><h4>Accuracy Metrics</h4><p>Compare ProBid estimates against actual costs with percentile distributions.</p></div>
      <div class="feature-card"><h4>Proof Reports</h4><p>Generate PDF, Markdown, and CSV reports you can share with anyone.</p></div>
      <div class="feature-card"><h4>Verify Yourself</h4><p>Export all data and check the math. If you don't believe us, verify it.</p></div>
    </div>
  </main>
  <script>
    const csrfToken = "${csrfToken}";
    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
    async function startProcoreAuth() {
      const btn = document.getElementById('connectBtn');
      btn.classList.add('loading'); btn.textContent = 'Connecting...';
      try {
        const res = await fetch('/api/procore/auth/start');
        const data = await res.json();
        if (data.authUrl) { window.location.href = data.authUrl; }
        else { showToast('Failed to start authentication', 'error'); btn.classList.remove('loading'); btn.textContent = 'Connect Procore'; }
      } catch (err) { showToast('Connection error', 'error'); btn.classList.remove('loading'); btn.textContent = 'Connect Procore'; }
    }
    async function syncProjects(connectionId) {
      showToast('Syncing projects...');
      try {
        const res = await fetch('/api/procore/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ connectionId }) });
        const data = await res.json();
        if (data.success) { showToast('Synced ' + data.syncedProjects + ' projects'); } else { showToast(data.error || 'Sync failed', 'error'); }
      } catch (err) { showToast('Sync error', 'error'); }
    }
    async function runShadowEstimates(connectionId) {
      showToast('Generating shadow estimates... This may take a few minutes.');
      try {
        const res = await fetch('/api/procore/shadow-estimates', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ connectionId }) });
        const data = await res.json();
        if (data.success) { showToast('Generated ' + data.processed + ' estimates'); } else { showToast(data.error || 'Generation failed', 'error'); }
      } catch (err) { showToast('Generation error', 'error'); }
    }
    async function calculateMetrics(connectionId) {
      showToast('Calculating metrics...');
      try {
        const res = await fetch('/api/procore/calculate-metrics', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ connectionId }) });
        const data = await res.json();
        if (data.success) { showToast('Metrics calculated successfully'); } else { showToast(data.error || 'Calculation failed', 'error'); }
      } catch (err) { showToast('Calculation error', 'error'); }
    }
  </script>
</body>
</html>
    `);
  })}

  app.get("/procore/dashboard/:connectionId", requireAuth, (_req, res) => {
    res.redirect(301, "/app/procore");
  });

  {const _legacyDashboard = asyncHandler(async (req: express.Request, res: express.Response) => {
    const uid = req.session!.uid!;
    const connectionId = req.params.connectionId;
    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) return res.status(404).send("Connection not found");
    const connection = connectionResult[0];
    const csrfToken = req.session!.csrfToken || generateCsrfToken();
    req.session!.csrfToken = csrfToken;

    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${connection.companyName || "Procore"} - Trust Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; }
    .header h1 { font-size: 24px; }
    .nav-links { display: flex; gap: 20px; }
    .nav-links a { color: #aaa; text-decoration: none; }
    .container { max-width: 1400px; margin: 0 auto; padding: 40px 20px; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; margin-bottom: 40px; }
    .metric-card { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 12px; padding: 24px; text-align: center; }
    .metric-value { font-size: 48px; font-weight: 700; background: linear-gradient(90deg, #f7931a, #ffab40); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .metric-label { color: #888; margin-top: 8px; }
    .section { background: #1a1a2e; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .section h3 { margin-bottom: 20px; font-size: 20px; }
    .btn { display: inline-block; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; font-size: 14px; transition: all 0.2s; margin-right: 12px; margin-bottom: 12px; }
    .btn-primary { background: linear-gradient(90deg, #f7931a, #ffab40); color: #000; }
    .btn-secondary { background: #333; color: #fff; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
    .table th { color: #888; font-weight: 500; }
    .positive { color: #4ade80; }
    .negative { color: #f87171; }
    #comparisons-table { max-height: 500px; overflow-y: auto; }
    .loading { text-align: center; padding: 40px; color: #888; }
    .percentile-bar { display: flex; align-items: center; gap: 12px; margin: 8px 0; }
    .percentile-label { width: 40px; color: #888; font-size: 14px; }
    .percentile-track { flex: 1; height: 8px; background: #333; border-radius: 4px; overflow: hidden; }
    .percentile-fill { height: 100%; background: linear-gradient(90deg, #4ade80, #f7931a); border-radius: 4px; transition: width 0.5s; }
    .percentile-value { width: 60px; text-align: right; font-weight: 600; }
  </style>
</head>
<body>
  <header class="header">
    <h1>${connection.companyName || "Procore Company"}</h1>
    <nav class="nav-links">
      <a href="/procore">Back to Connections</a>
      <a href="/">Dashboard</a>
      <a href="/logout">Logout</a>
    </nav>
  </header>
  <main class="container">
    <div class="metrics-grid" id="metrics-grid">
      <div class="metric-card"><div class="metric-value" id="accuracy-value">--%</div><div class="metric-label">Median Accuracy</div></div>
      <div class="metric-card"><div class="metric-value" id="calibration-value">--%</div><div class="metric-label">Within Confidence Bands</div></div>
      <div class="metric-card"><div class="metric-value" id="time-value">-- hrs</div><div class="metric-label">Time Saved Per Estimate</div></div>
      <div class="metric-card"><div class="metric-value" id="projects-value">--</div><div class="metric-label">Projects Analyzed</div></div>
    </div>
    <div class="section">
      <h3>Accuracy Distribution</h3>
      <div id="percentile-chart">
        <div class="percentile-bar"><span class="percentile-label">P25</span><div class="percentile-track"><div class="percentile-fill" id="p25-bar" style="width: 0%"></div></div><span class="percentile-value" id="p25-value">--%</span></div>
        <div class="percentile-bar"><span class="percentile-label">P50</span><div class="percentile-track"><div class="percentile-fill" id="p50-bar" style="width: 0%"></div></div><span class="percentile-value" id="p50-value">--%</span></div>
        <div class="percentile-bar"><span class="percentile-label">P75</span><div class="percentile-track"><div class="percentile-fill" id="p75-bar" style="width: 0%"></div></div><span class="percentile-value" id="p75-value">--%</span></div>
        <div class="percentile-bar"><span class="percentile-label">P90</span><div class="percentile-track"><div class="percentile-fill" id="p90-bar" style="width: 0%"></div></div><span class="percentile-value" id="p90-value">--%</span></div>
      </div>
    </div>
    <div class="section">
      <h3>Export & Reports</h3>
      <a href="/api/procore/report/pdf?connection=${connectionId}" class="btn btn-primary">Download PDF Report</a>
      <a href="/api/procore/report/markdown?connection=${connectionId}" class="btn btn-secondary">Download Markdown</a>
      <a href="/api/procore/report/csv?connection=${connectionId}" class="btn btn-secondary">Export CSV</a>
      <a href="/api/procore/sales-copy?connection=${connectionId}" class="btn btn-secondary">Generate Sales Copy</a>
      <a href="/api/procore/investor-narrative?connection=${connectionId}" class="btn btn-secondary">Investor Narrative</a>
    </div>
    <div class="section">
      <h3>Project Comparisons</h3>
      <div id="comparisons-table"><div class="loading">Loading comparisons...</div></div>
    </div>
  </main>
  <script>
    const connectionId = "${connectionId}";
    async function loadMetrics() {
      try {
        const res = await fetch('/api/procore/metrics?connection=' + connectionId);
        const data = await res.json();
        if (data.metrics) {
          const m = data.metrics;
          if (m.accuracy_error_pct) {
            document.getElementById('accuracy-value').textContent = (100 - m.accuracy_error_pct.value).toFixed(1) + '%';
            if (m.accuracy_error_pct.metadata) {
              const meta = m.accuracy_error_pct.metadata;
              updatePercentile('p25', meta.p25); updatePercentile('p50', meta.p50);
              updatePercentile('p75', meta.p75); updatePercentile('p90', meta.p90);
            }
          }
          if (m.confidence_calibration) document.getElementById('calibration-value').textContent = m.confidence_calibration.value.toFixed(0) + '%';
          if (m.time_saved_hours) { document.getElementById('time-value').textContent = m.time_saved_hours.value.toFixed(1) + ' hrs'; document.getElementById('projects-value').textContent = m.time_saved_hours.sampleSize; }
        }
      } catch (err) { console.error('Failed to load metrics:', err); }
    }
    function updatePercentile(id, value) {
      const width = Math.min((value / 30) * 100, 100);
      document.getElementById(id + '-bar').style.width = width + '%';
      document.getElementById(id + '-value').textContent = value.toFixed(1) + '%';
    }
    async function loadComparisons() {
      try {
        const res = await fetch('/api/procore/comparisons?connection=' + connectionId);
        const data = await res.json();
        if (data.comparisons && data.comparisons.length > 0) {
          let html = '<table class="table"><thead><tr><th>Project</th><th>Baseline Error</th><th>ProBid Error</th><th>Improvement</th><th>Within Band</th></tr></thead><tbody>';
          for (const c of data.comparisons) {
            const baselineError = c.baseline.variancePct != null ? Math.abs(c.baseline.variancePct).toFixed(1) + '%' : 'N/A';
            const probidError = c.probid?.variancePct != null ? Math.abs(c.probid.variancePct).toFixed(1) + '%' : 'N/A';
            let improvement = 'N/A', improvementClass = '';
            if (c.baseline.variancePct != null && c.probid?.variancePct != null) {
              const diff = Math.abs(c.baseline.variancePct) - Math.abs(c.probid.variancePct);
              improvement = (diff > 0 ? '+' : '') + diff.toFixed(1) + '%';
              improvementClass = diff > 0 ? 'positive' : 'negative';
            }
            const withinBand = c.probid?.withinBand != null ? (c.probid.withinBand ? '✅' : '❌') : 'N/A';
            html += '<tr><td>' + c.project.name.slice(0, 40) + '</td><td>' + baselineError + '</td><td>' + probidError + '</td><td class="' + improvementClass + '">' + improvement + '</td><td>' + withinBand + '</td></tr>';
          }
          html += '</tbody></table>';
          document.getElementById('comparisons-table').innerHTML = html;
        } else {
          document.getElementById('comparisons-table').innerHTML = '<p style="color: #888; text-align: center;">No project comparisons yet. Sync projects and generate shadow estimates first.</p>';
        }
      } catch (err) { console.error('Failed to load comparisons:', err); document.getElementById('comparisons-table').innerHTML = '<p style="color: #f87171;">Failed to load comparisons</p>'; }
    }
    loadMetrics();
    loadComparisons();
  </script>
</body>
</html>
    `);
  })}

  app.get("/api/procore/all-projects", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const connections = await procore.getUserConnections(uid);
    if (!connections.length) {
      return res.json({ success: true, data: [] });
    }
    const conn = connections[0];
    const projects = await procore.getAllProjects(conn.id, conn.procoreCompanyId);
    res.json({
      success: true,
      data: projects.map((p: any) => ({
        id: p.id,
        name: p.name,
        project_number: p.project_number,
        status: p.stage || p.status,
        address: p.address,
        city: p.city,
        state_code: p.state_code,
      })),
    });
  }));

  app.post("/api/procore/push-estimate", requireAuth, requireBusinessTier, validateCsrf, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { estimateId, procoreProjectId, createNew } = req.body;

    if (!estimateId) {
      return res.status(400).json({ success: false, error: "estimateId is required" });
    }

    const [estimate] = await db.select().from(estimates).where(
      and(eq(estimates.id, estimateId), eq(estimates.userId, uid))
    );
    if (!estimate) {
      return res.status(404).json({ success: false, error: "Estimate not found" });
    }

    const connections = await procore.getUserConnections(uid);
    if (!connections.length) {
      return res.status(400).json({ success: false, error: "No Procore connection found. Please connect your Procore account first." });
    }
    const conn = connections[0];

    const existingPush = await db.select().from(procoreEstimatePushes).where(
      and(eq(procoreEstimatePushes.estimateId, estimateId), eq(procoreEstimatePushes.connectionId, conn.id))
    );
    if (existingPush.length > 0) {
      return res.status(409).json({ success: false, error: "This estimate has already been pushed to Procore", data: existingPush[0] });
    }

    let targetProjectId: number;
    let projectName: string;

    if (createNew) {
      const jobLabel = estimate.jobType.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
      const projectData: any = {
        name: `ProBid: ${jobLabel} — ${estimate.market}`,
        description: `Estimate generated by ProBid AI on ${new Date(estimate.createdAt).toLocaleDateString()}.\n\n${estimate.details || ""}`.trim(),
      };

      try {
        const created = await procore.createProject(conn.id, conn.procoreCompanyId, projectData);
        targetProjectId = created.id;
        projectName = created.name;
        log("info", "Created Procore project", { projectId: targetProjectId, projectName, estimateId });
      } catch (err: any) {
        log("error", "Failed to create Procore project", { error: err.message });
        return res.status(502).json({ success: false, error: `Failed to create project in Procore: ${err.message}` });
      }
    } else if (procoreProjectId) {
      targetProjectId = parseInt(procoreProjectId, 10);
      if (isNaN(targetProjectId)) {
        return res.status(400).json({ success: false, error: "Invalid procoreProjectId" });
      }
      projectName = `Linked Project #${targetProjectId}`;
    } else {
      return res.status(400).json({ success: false, error: "Either createNew=true or procoreProjectId is required" });
    }

    let budgetItemsPushed = 0;
    const lines = parseEstimateLineItems(estimate.estimateText);
    for (const line of lines) {
      try {
        await procore.createBudgetLineItem(conn.id, conn.procoreCompanyId, targetProjectId, {
          description: line.description,
          amount: line.amount,
        });
        budgetItemsPushed++;
      } catch (err: any) {
        log("warn", "Failed to push budget line item", { description: line.description, error: err.message });
      }
    }

    let pdfUploaded = 0;
    try {
      const pdfRes = await fetch(`${APP_URL}/estimate/${estimateId}/pdf`, {
        headers: { cookie: req.headers.cookie || "" },
      });
      if (pdfRes.ok) {
        const pdfBuffer = new Uint8Array(await pdfRes.arrayBuffer());
        const jobLabel = estimate.jobType.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        const fileName = `ProBid_Estimate_${jobLabel}_${new Date(estimate.createdAt).toISOString().slice(0, 10)}.pdf`;
        await procore.uploadProjectDocument(conn.id, conn.procoreCompanyId, targetProjectId, fileName, pdfBuffer);
        pdfUploaded = 1;
        log("info", "Uploaded estimate PDF to Procore", { projectId: targetProjectId, fileName });
      }
    } catch (err: any) {
      log("warn", "Failed to upload PDF to Procore", { error: err.message });
    }

    const pushId = crypto.randomUUID();
    const procoreProjectUrl = `https://app.procore.com/projects/${targetProjectId}`;
    const pushStatus = (lines.length > 0 && budgetItemsPushed === 0) ? "failed" :
      (budgetItemsPushed < lines.length || (pdfUploaded === 0)) ? "partial" : "pushed";
    await db.insert(procoreEstimatePushes).values({
      id: pushId,
      userId: uid,
      estimateId,
      connectionId: conn.id,
      procoreProjectId: String(targetProjectId),
      procoreCompanyId: conn.procoreCompanyId,
      projectName,
      status: pushStatus,
      budgetItemsPushed,
      pdfUploaded,
      procoreProjectUrl,
      createdAt: Date.now(),
    });

    log("info", "Estimate pushed to Procore", { estimateId, procoreProjectId: targetProjectId, budgetItemsPushed, pdfUploaded });

    res.json({
      success: true,
      data: {
        pushId,
        procoreProjectId: targetProjectId,
        procoreProjectUrl,
        projectName,
        budgetItemsPushed,
        pdfUploaded,
        totalLineItems: lines.length,
      },
    });
  }));

  app.get("/api/procore/push-status/:estimateId", requireAuth, requireBusinessTier, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { estimateId } = req.params;

    const pushes = await db.select().from(procoreEstimatePushes).where(
      and(eq(procoreEstimatePushes.estimateId, estimateId), eq(procoreEstimatePushes.userId, uid))
    );

    res.json({ success: true, data: pushes[0] || null });
  }));

  app.patch("/api/procore/connections/:connectionId/benchmark-consent", requireAuth, requireBusinessTier, validateCsrf, asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const { connectionId } = req.params;
    const { includeInPublicBenchmarks } = req.body;

    if (typeof includeInPublicBenchmarks !== "boolean") {
      return res.status(400).json({ success: false, error: "includeInPublicBenchmarks (boolean) is required" });
    }

    const connectionResult = await db.select().from(procoreConnections)
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));
    if (connectionResult.length === 0) {
      return res.status(404).json({ success: false, error: "Connection not found" });
    }

    await db.update(procoreConnections)
      .set({ includeInPublicBenchmarks: includeInPublicBenchmarks ? 1 : 0, updatedAt: Date.now() })
      .where(and(eq(procoreConnections.id, connectionId), eq(procoreConnections.userId, uid)));

    log("info", "Benchmark consent updated", { connectionId, uid, includeInPublicBenchmarks });
    res.json({ success: true, data: { connectionId, includeInPublicBenchmarks } });
  }));

  app.get("/api/procore/endpoint-map", asyncHandler(async (req, res) => {
    res.json({
      description: "Procore API endpoints used by ProBid Trust Engine",
      version: "v1.0",
      authMethod: "OAuth 2.0 (read-only)",
      endpoints: [
        { name: "Companies", path: "/rest/v1.0/companies", method: "GET", description: "List all companies the authenticated user has access to", sampleResponse: { id: 12345, name: "ABC Construction", is_active: true } },
        { name: "Projects", path: "/rest/v1.0/projects", method: "GET", headers: { "Procore-Company-Id": "<company_id>" }, description: "List all projects in a company", sampleResponse: { id: 67890, name: "Downtown Office Building", project_number: "PRJ-001", stage: "Closed", address: "123 Main St", city: "Chicago", state_code: "IL" } },
        { name: "Budget Views", path: "/rest/v1.0/projects/{project_id}/budget/views", method: "GET", description: "Get budget line items with original and actual amounts", sampleResponse: { cost_code: { code: "03000", name: "Concrete" }, original_budget_amount: 150000, actual_costs: 145000 } },
        { name: "Change Events", path: "/rest/v1.0/projects/{project_id}/change_events", method: "GET", description: "List change events/orders for a project", sampleResponse: { id: 111, title: "Foundation modification", status: "approved", amount: 25000 } }
      ],
      dataSchema: {
        project_id: "string", contractor_id: "string", trade: "string", region: "string",
        project_value_usd: "number", cost_code: "string", baseline_estimate_usd: "number",
        probid_estimate_usd: "number", actual_cost_usd: "number", change_order_count: "integer",
        change_order_value_usd: "number", project_close_date: "date"
      }
    });
  }));
}
