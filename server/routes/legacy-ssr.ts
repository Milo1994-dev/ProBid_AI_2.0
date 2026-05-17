import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import multer from "multer";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import OpenAI from "openai";
import Stripe from "stripe";
import { z } from "zod";
import { db, pool } from "../db.js";
import {
  eq,
  and,
  or,
  desc,
  asc,
  sql,
  gt,
  lt,
  gte,
  lte,
  count,
  sum,
  ilike,
  inArray,
} from "drizzle-orm";
import {
  users,
  stripeCustomers,
  subscriptions,
  usage,
  estimates,
  leads,
  analytics,
  guaranteeBadgeClicks,
  affiliateClicks,
  referrals,
  affiliateEarnings,
  seoPages,
  estimateTemplates,
  teams,
  teamMembers,
  teamInvites,
  purchases,
  referralLeads,
  adCampaigns,
  systemAlerts,
  emailDripQueue,
  homepageLeads,
  launchTasks,
  procoreConnections,
  procoreProjects,
  shadowEstimates as shadowEstimatesTable,
  procoreMetrics,
  proofAssets as proofAssetsTable,
  scrapedLeads,
  leadOutreachQueue,
  leadEmailAuditLog,
  jobRuns,
} from "../../shared/schema.js";
import {
  asyncHandler,
  requireAuth,
  requireAuthJson,
  requireAdminAuth,
  requireAdminAuthPage,
  generateAdminSessionToken,
  generateCsrfToken,
  validateCsrf,
} from "../lib/middleware.js";
import { log } from "../lib/logger.js";
import { APP_URL, CANONICAL_URL } from "../lib/config.js";
import { escapeHtml, dayKey, now, AppError } from "../lib/utils.js";
import { trackEvent } from "../lib/analytics.js";
import {
  getUser,
  getSub,
  isPaidActive,
  getDailyUsage,
  getTotalEstimates,
  incrementUsage,
  enforcePaywall,
  consumeSingleCredit,
  FREE_ESTIMATES_LIFETIME,
} from "../lib/user-helpers.js";
import {
  getTeamForOwner,
  getTeamById,
  getUserTeamMembership,
  getTeamMembers,
  getTeamInvites,
  getTeamInviteByCode,
  getEffectiveSub,
  isBusinessTier,
  canManageTeam,
} from "../lib/team-helpers.js";
import { prepareEstimatePdfRender } from "../lib/estimate-pdf-helpers.js";
import {
  ensureAffiliateCode,
  trackAffiliateClick,
  attributeReferral,
  createAffiliateEarning,
} from "../lib/affiliate-helpers.js";
import {
  sendWelcomeEmail,
  sendUpsellEmail,
  scheduleFollowUpEmail,
  enqueueOnboardingSequence,
  sendAdminSmsAlert,
  generateUnsubToken,
} from "../lib/email-helpers.js";
import { getDripEmailTemplate, scheduleEmailDrip } from "../lib/drip-templates.js";
import {
  stripe,
  getStripeCustomerIdOrNull,
  createStripeCustomer,
  upsertStripeCustomer,
} from "../lib/stripe-helpers.js";
import { generateAIEstimate } from "../lib/ai.js";
import { syncDealForNewEstimate, parseEstimateTotalValue } from "../lib/pipeline-sync.js";
import { SEO_STATES, SEO_SERVICES, generateSeoContent } from "../lib/seo-helpers.js";
import * as procore from "../procore.js";
import * as metricsEngine from "../metrics-engine.js";
import * as shadowEstimator from "../shadow-estimator.js";
import * as proofGenerator from "../proof-generator.js";
import { getLifetimeStatus } from "./billing.js";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const PRICE_PRO = process.env.STRIPE_PRICE_PRO_MONTHLY || "";
const PRICE_BIZ = process.env.STRIPE_PRICE_BUSINESS_MONTHLY || "";
const PRICE_PRO_ANNUAL = process.env.STRIPE_PRICE_PRO_ANNUAL || "";
const PRICE_BIZ_ANNUAL = process.env.STRIPE_PRICE_BUSINESS_ANNUAL || "";
const PRICE_SINGLE = process.env.STRIPE_PRICE_SINGLE_ESTIMATE || "";
const PRICE_LIFETIME = process.env.STRIPE_PRICE_LIFETIME_ACCESS || "";

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  ref: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
});

const signupSchema = z.object({
  email: z.string().email("Invalid email format"),
  ref: z.string().optional(),
});

const estimateSchema = z.object({
  jobType: z.string().min(1, "Job type is required"),
  market: z.string().min(1, "Market is required"),
  details: z.string().optional(),
  zipCode: z.string().optional(),
  clientName: z.string().optional(),
  clientEmail: z.string().email().optional().or(z.literal("")),
  clientPhone: z.string().optional(),
  tradePreset: z.string().optional(),
});

const templateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  jobType: z.string().min(1, "Job type is required"),
  market: z.string().min(1, "Market is required"),
  details: z.string().optional(),
  clientName: z.string().optional(),
  clientEmail: z.string().email().optional().or(z.literal("")),
  clientPhone: z.string().optional(),
});

const leadSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
});

const idParamSchema = z.object({
  id: z.string().min(1, "ID is required"),
});

interface SessionData {
  uid?: string;
  email?: string;
  csrfToken?: string;
  userRole?: string;
  adminSession?: string;
}

// Aggregate guarantee_badge_click events for a single contractor. Returns both
// per-estimate click counts (used by the /history table — scoped to the latest
// visible estimates) and per-guarantee rollup totals across ALL of the
// contractor's estimates (used by the dashboard panel telling contractors
// which trust signal — speed, win-jobs, or money-back — resonates most).
// Reads from the denormalized `guarantee_badge_clicks` table joined to
// `estimates` for ownership scoping, so the cost scales with the contractor's
// own click volume instead of the full analytics history. The rollup `total`
// only counts events with a recognized `utm_content` value so the displayed
// per-guarantee shares aren't diluted by unknown variants (individual rounded
// percentages may still differ from 100% by ±1). Also returns a per-day trend
// per guarantee for the last `trendDays` days (used by the dashboard
// sparkline so contractors can see whether engagement is growing, flat, or
// fading after messaging changes), reading from the same denormalized table
// so the trend cost also scales with the contractor's own click volume.
type GuaranteeKey = "speed" | "win-jobs" | "money-back";
async function getGuaranteeBadgeClickStatsForUser(
  userId: string,
  visibleEstimateIds: string[],
  trendDays = 30,
): Promise<{
  perEstimate: Map<string, number>;
  rollup: {
    total: number;
    byGuarantee: Record<GuaranteeKey, number>;
  };
  trend: {
    days: string[];
    series: Record<GuaranteeKey, number[]>;
    windowDays: number;
    totalInWindow: number;
  };
}> {
  const perEstimate = new Map<string, number>();
  for (const id of visibleEstimateIds) perEstimate.set(id, 0);
  const rollup = {
    total: 0,
    byGuarantee: { speed: 0, "win-jobs": 0, "money-back": 0 } as Record<
      GuaranteeKey,
      number
    >,
  };

  // Build the trend day buckets in UTC so date math stays stable across DST.
  const dayMs = 24 * 60 * 60 * 1000;
  const todayUtc = new Date();
  const todayKey = Date.UTC(
    todayUtc.getUTCFullYear(),
    todayUtc.getUTCMonth(),
    todayUtc.getUTCDate(),
  );
  const days: string[] = [];
  const dayIndex = new Map<string, number>();
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(todayKey - i * dayMs);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    dayIndex.set(key, days.length);
    days.push(key);
  }
  const trend = {
    days,
    series: {
      speed: new Array<number>(days.length).fill(0),
      "win-jobs": new Array<number>(days.length).fill(0),
      "money-back": new Array<number>(days.length).fill(0),
    } as Record<GuaranteeKey, number[]>,
    windowDays: trendDays,
    totalInWindow: 0,
  };

  const visibleIds = new Set(visibleEstimateIds);
  const rows = await db
    .select({
      estimateId: guaranteeBadgeClicks.estimateId,
      utmContent: guaranteeBadgeClicks.utmContent,
      total: count(),
    })
    .from(guaranteeBadgeClicks)
    .innerJoin(estimates, eq(estimates.id, guaranteeBadgeClicks.estimateId))
    .where(eq(estimates.userId, userId))
    .groupBy(guaranteeBadgeClicks.estimateId, guaranteeBadgeClicks.utmContent);
  for (const row of rows) {
    const n = Number(row.total);
    if (visibleIds.has(row.estimateId)) {
      perEstimate.set(row.estimateId, (perEstimate.get(row.estimateId) || 0) + n);
    }
    const c = row.utmContent;
    if (c === "speed" || c === "win-jobs" || c === "money-back") {
      rollup.byGuarantee[c] += n;
      rollup.total += n;
    }
  }

  // Per-day trend (still scoped strictly to estimates owned by this user, via
  // the same denormalized table — cost scales with the contractor's own
  // clicks within the trend window only).
  const windowStartMs = todayKey - (trendDays - 1) * dayMs;
  const trendRows = await db
    .select({
      utmContent: guaranteeBadgeClicks.utmContent,
      createdAt: guaranteeBadgeClicks.createdAt,
    })
    .from(guaranteeBadgeClicks)
    .innerJoin(estimates, eq(estimates.id, guaranteeBadgeClicks.estimateId))
    .where(
      and(
        eq(estimates.userId, userId),
        gte(guaranteeBadgeClicks.createdAt, windowStartMs),
      ),
    );
  for (const row of trendRows) {
    const c = row.utmContent;
    if (c !== "speed" && c !== "win-jobs" && c !== "money-back") continue;
    if (typeof row.createdAt !== "number") continue;
    const d = new Date(row.createdAt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const idx = dayIndex.get(key);
    if (idx !== undefined) {
      trend.series[c as GuaranteeKey][idx]++;
      trend.totalInWindow++;
    }
  }
  return { perEstimate, rollup, trend };
}

export function registerLegacySsrRoutes(app: express.Application) {
app.get(
  "/legacy-ssr-root",
  asyncHandler(async (req, res) => {
    const uid = req.session?.uid;
    const sub = uid ? await getSub(uid) : undefined;
    const paid = isPaidActive(sub);

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <meta name="description" content="ProBid AI - Create fast, professional job estimates using AI. Built for contractors who want faster, cleaner estimates."/>
  <title>ProBid AI - Instant Construction Estimates | Built for Real Contractors</title>
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
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
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
      overflow-x: hidden;
    }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    .animate-fade-in { animation: fadeInUp 0.8s ease-out forwards; opacity: 0; }
    .animate-delay-1 { animation-delay: 0.1s; }
    .animate-delay-2 { animation-delay: 0.2s; }
    .animate-delay-3 { animation-delay: 0.3s; }
    .animate-delay-4 { animation-delay: 0.4s; }
    .animate-delay-5 { animation-delay: 0.5s; }
    .animate-delay-6 { animation-delay: 0.6s; }

    .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }

    /* Navigation */
    .nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      padding: 16px 0;
      background: rgba(10, 14, 26, 0.8);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
      transition: all 0.3s ease;
    }

    .nav-inner {
      display: flex;
      justify-content: space-between;
      align-items: center;
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

    .nav-links { display: flex; gap: 8px; align-items: center; }

    .nav-link {
      padding: 10px 18px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      transition: all 0.3s ease;
    }

    .nav-link:hover { color: var(--text-primary); background: var(--glass-bg); }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(99, 102, 241, 0.2));
      border: 1px solid var(--border-light);
      font-size: 13px;
      font-weight: 600;
      color: var(--primary-light);
    }

    /* Hero Section */
    .hero {
      position: relative;
      min-height: 100vh;
      display: flex;
      align-items: center;
      padding: 120px 0 80px;
      overflow: hidden;
    }

    .hero-bg {
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
    }

    .hero-glow {
      position: absolute;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.3;
    }

    .hero-glow-1 { top: -200px; left: -200px; background: var(--primary); }
    .hero-glow-2 { bottom: -200px; right: -200px; background: #7c3aed; }

    .hero-content {
      position: relative;
      z-index: 10;
      text-align: center;
      max-width: 900px;
      margin: 0 auto;
    }

    .trust-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 20px;
      border-radius: 999px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: var(--accent);
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 24px;
    }

    .hero h1 {
      font-size: clamp(2.5rem, 6vw, 4rem);
      font-weight: 900;
      line-height: 1.1;
      margin-bottom: 24px;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 50%, var(--text-primary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .hero-subtitle {
      font-size: clamp(1.1rem, 2vw, 1.35rem);
      color: var(--text-muted);
      max-width: 650px;
      margin: 0 auto 32px;
      line-height: 1.7;
    }

    .hero-cta-group { display: flex; flex-direction: column; align-items: center; gap: 16px; }

    .hero-buttons { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 16px 32px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .btn-primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(79, 70, 229, 0.5);
    }

    .btn-secondary {
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      backdrop-filter: blur(10px);
    }

    .btn-secondary:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
      transform: translateY(-2px);
    }

    .btn-accent {
      color: var(--text-dark);
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 4px 20px rgba(34, 197, 94, 0.3);
    }

    .btn-accent:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(34, 197, 94, 0.4);
    }

    .pricing-teaser {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      justify-content: center;
      align-items: center;
      margin-top: 8px;
    }

    .pricing-teaser span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .pricing-teaser .highlight {
      color: var(--accent);
      font-weight: 600;
    }

    /* Risk Reversal Badges */
    .risk-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: center;
      margin-top: 32px;
    }

    .risk-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 8px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      font-size: 13px;
      color: var(--text-muted);
    }

    .risk-badge svg { width: 16px; height: 16px; color: var(--accent); }

    /* Trust Stats */
    .trust-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 24px;
      margin-top: 60px;
      padding-top: 40px;
      border-top: 1px solid var(--border-color);
    }

    .stat-item { text-align: center; }

    .stat-number {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--primary-light) 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stat-label { font-size: 14px; color: var(--text-muted); margin-top: 4px; }

    /* Section Styles */
    section { padding: 100px 0; }

    .section-header {
      text-align: center;
      max-width: 700px;
      margin: 0 auto 60px;
    }

    .section-label {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid var(--border-light);
      color: var(--primary-light);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .section-title {
      font-size: clamp(2rem, 4vw, 2.75rem);
      font-weight: 800;
      margin-bottom: 16px;
      color: var(--text-primary);
    }

    .section-subtitle {
      font-size: 1.1rem;
      color: var(--text-muted);
      line-height: 1.7;
    }

    /* How It Works */
    .how-it-works { background: linear-gradient(180deg, var(--bg-dark) 0%, rgba(15, 23, 42, 0.5) 50%, var(--bg-dark) 100%); }

    .steps-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      position: relative;
    }

    .steps-grid::before {
      content: '';
      position: absolute;
      top: 60px;
      left: 12.5%;
      right: 12.5%;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--primary-light), var(--accent), var(--primary-light), transparent);
      opacity: 0.3;
    }

    .step-card {
      position: relative;
      text-align: center;
      padding: 32px 20px;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      transition: all 0.4s ease;
    }

    .step-card:hover {
      transform: translateY(-8px);
      border-color: var(--border-light);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }

    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      color: white;
      font-size: 18px;
      font-weight: 800;
      margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .step-icon {
      font-size: 2.5rem;
      margin-bottom: 16px;
      display: block;
      animation: float 3s ease-in-out infinite;
    }

    .step-card:nth-child(2) .step-icon { animation-delay: 0.5s; }
    .step-card:nth-child(3) .step-icon { animation-delay: 1s; }

    .step-title {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 8px;
      color: var(--text-primary);
    }

    .step-desc {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Estimate Preview */
    .estimate-preview {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.05) 0%, rgba(34, 197, 94, 0.05) 100%);
    }

    .preview-container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 60px;
      align-items: center;
    }

    .preview-content h2 {
      font-size: 2.25rem;
      font-weight: 800;
      margin-bottom: 20px;
    }

    .preview-content p {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 32px;
      line-height: 1.7;
    }

    .preview-features {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .preview-feature {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .preview-feature-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(34, 197, 94, 0.15);
      color: var(--accent);
      font-size: 16px;
    }

    .preview-feature span { color: var(--text-muted); }

    .estimate-mockup {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      font-family: 'Inter', monospace;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }

    .estimate-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-color);
    }

    .estimate-logo { font-weight: 800; color: var(--primary-light); font-size: 1.1rem; }
    .estimate-date { font-size: 12px; color: var(--text-muted); }

    .estimate-title {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 16px;
    }

    .estimate-line {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px dashed rgba(148, 163, 184, 0.2);
      font-size: 14px;
    }

    .estimate-line-label { color: var(--text-muted); }
    .estimate-line-value { color: var(--text-primary); font-weight: 600; }

    .estimate-total {
      display: flex;
      justify-content: space-between;
      padding: 16px 0 0;
      margin-top: 8px;
      font-size: 1.1rem;
      font-weight: 700;
    }

    .estimate-total-value { color: var(--accent); font-size: 1.5rem; }

    /* Features Grid */
    .features { background: var(--bg-dark); }

    .features-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }

    .feature-card {
      padding: 32px;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      transition: all 0.4s ease;
    }

    .feature-card:hover {
      transform: translateY(-6px);
      border-color: var(--border-light);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
    }

    .feature-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      border-radius: 14px;
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(99, 102, 241, 0.1));
      font-size: 1.75rem;
      margin-bottom: 20px;
    }

    .feature-title {
      font-size: 1.2rem;
      font-weight: 700;
      margin-bottom: 10px;
      color: var(--text-primary);
    }

    .feature-desc {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Testimonials */
    .testimonials {
      background: linear-gradient(180deg, var(--bg-dark) 0%, rgba(15, 23, 42, 0.8) 100%);
    }

    .testimonials-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }

    .testimonial-card {
      padding: 32px;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      transition: all 0.4s ease;
    }

    .testimonial-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-light);
    }

    .testimonial-stars {
      color: #fbbf24;
      font-size: 1.1rem;
      margin-bottom: 16px;
    }

    .testimonial-text {
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.7;
      margin-bottom: 24px;
      font-style: italic;
    }

    .testimonial-author {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .testimonial-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 18px;
      color: white;
    }

    .testimonial-info h4 {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .testimonial-info p {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Partners */
    .partners {
      padding: 60px 0;
      border-top: 1px solid var(--border-color);
      border-bottom: 1px solid var(--border-color);
    }

    .partners-label {
      text-align: center;
      font-size: 13px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 32px;
    }

    .partners-logos {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 48px;
      flex-wrap: wrap;
      opacity: 0.5;
    }

    .partner-logo {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-muted);
      padding: 12px 24px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
    }

    /* FAQ */
    .faq { background: var(--bg-dark); }

    .faq-list {
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .faq-item {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .faq-item:hover { border-color: var(--border-light); }

    .faq-question {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 24px;
      cursor: pointer;
      font-weight: 600;
      color: var(--text-primary);
      transition: all 0.3s ease;
    }

    .faq-question:hover { color: var(--primary-light); }

    .faq-icon {
      font-size: 1.25rem;
      color: var(--primary-light);
      transition: transform 0.3s ease;
    }

    .faq-answer {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease, padding 0.3s ease;
    }

    .faq-item.active .faq-answer {
      max-height: 300px;
      padding: 0 24px 24px;
    }

    .faq-item.active .faq-icon { transform: rotate(45deg); }

    .faq-answer-text {
      color: var(--text-muted);
      line-height: 1.7;
      font-size: 15px;
    }

    /* Final CTA */
    .final-cta {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%);
      text-align: center;
      padding: 100px 0;
    }

    .final-cta h2 {
      font-size: clamp(2rem, 4vw, 2.75rem);
      font-weight: 800;
      margin-bottom: 16px;
    }

    .final-cta p {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 32px;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }

    .final-cta .btn { padding: 18px 40px; font-size: 18px; }

    .guarantee-box {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      margin-top: 32px;
      padding: 16px 24px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 12px;
    }

    .guarantee-icon { font-size: 2rem; }

    .guarantee-text {
      text-align: left;
    }

    .guarantee-text strong {
      display: block;
      color: var(--accent);
      font-size: 15px;
    }

    .guarantee-text span {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Sample Output Section */
    .sample-output {
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.5) 0%, var(--bg-dark) 50%, rgba(15, 23, 42, 0.5) 100%);
      padding: 80px 0;
    }

    .sample-output-card {
      max-width: 600px;
      margin: 0 auto;
      background: rgba(18, 26, 42, 0.8);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-light);
      border-radius: 20px;
      padding: 32px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4), 0 0 40px rgba(79, 70, 229, 0.1);
    }

    .sample-output-header {
      text-align: center;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border-color);
    }

    .sample-output-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }

    .sample-output-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
    }

    .sample-output-list {
      list-style: none;
      padding: 0;
      margin: 0 0 20px 0;
    }

    .sample-output-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 0;
      border-bottom: 1px dashed rgba(148, 163, 184, 0.2);
    }

    .sample-output-item:last-child {
      border-bottom: none;
    }

    .sample-output-label {
      color: var(--text-muted);
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .sample-output-label::before {
      content: '•';
      color: var(--primary-light);
      font-weight: bold;
    }

    .sample-output-value {
      color: var(--text-primary);
      font-weight: 600;
      font-size: 15px;
    }

    .sample-output-total {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 0 0;
      margin-top: 8px;
      border-top: 2px solid var(--border-light);
    }

    .sample-output-total-label {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .sample-output-total-value {
      font-size: 1.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent) 0%, #4ade80 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .sample-output-disclaimer {
      text-align: center;
      margin-top: 20px;
      padding: 14px 20px;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 10px;
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    /* Example Estimates Section */
    .example-estimates {
      background: linear-gradient(180deg, var(--bg-dark) 0%, rgba(15, 23, 42, 0.5) 50%, var(--bg-dark) 100%);
    }

    .example-estimates-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }

    .example-card {
      position: relative;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 28px;
      transition: all 0.3s ease;
      overflow: hidden;
    }

    .example-card:hover {
      border-color: var(--border-light);
      transform: translateY(-4px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    }

    .example-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-color);
    }

    .example-header-icon {
      font-size: 1.75rem;
    }

    .example-header-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
    }

    .example-line-items {
      list-style: none;
      padding: 0;
      margin: 0 0 20px 0;
    }

    .example-line-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px dashed rgba(148, 163, 184, 0.15);
    }

    .example-line-item:last-child {
      border-bottom: none;
    }

    .example-line-label {
      color: var(--text-muted);
      font-size: 14px;
    }

    .example-line-value {
      color: var(--text-primary);
      font-weight: 600;
      font-size: 14px;
    }

    .example-total {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0 0;
      margin-top: 8px;
      border-top: 2px solid var(--border-light);
    }

    .example-total-label {
      font-size: 1rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .example-total-value {
      font-size: 1.35rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent) 0%, #4ade80 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .example-watermark {
      position: absolute;
      bottom: 12px;
      right: 16px;
      font-size: 10px;
      color: rgba(148, 163, 184, 0.4);
      font-weight: 500;
      letter-spacing: 0.3px;
    }

    @media (max-width: 1024px) {
      .example-estimates-grid { grid-template-columns: repeat(2, 1fr); }
    }

    @media (max-width: 640px) {
      .example-estimates-grid { grid-template-columns: 1fr; }
      .example-card { padding: 24px 20px; }
    }

    /* Trust Block Section */
    .trust-block {
      background: var(--bg-dark);
      padding: 80px 0;
      border-top: 1px solid var(--border-color);
    }

    .trust-block-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 24px;
    }

    .trust-block-item {
      text-align: center;
      padding: 28px 20px;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      transition: all 0.3s ease;
    }

    .trust-block-item:hover {
      border-color: var(--border-light);
      transform: translateY(-4px);
    }

    .trust-block-icon {
      font-size: 2rem;
      margin-bottom: 12px;
      display: block;
    }

    .trust-block-text {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.4;
    }

    .trust-block-subtext {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    @media (max-width: 1024px) {
      .trust-block-grid { grid-template-columns: repeat(2, 1fr); }
    }

    @media (max-width: 480px) {
      .trust-block-grid { grid-template-columns: 1fr; }
      .sample-output-card { padding: 24px 20px; }
    }

    /* Footer */
    .footer {
      background: var(--bg-darker);
      padding: 80px 0 40px;
      border-top: 1px solid var(--border-color);
    }

    .footer-grid {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: 60px;
      margin-bottom: 60px;
    }

    .footer-brand .logo { font-size: 1.75rem; margin-bottom: 16px; display: inline-block; }

    .footer-brand p {
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.7;
      max-width: 300px;
    }

    .footer-col h4 {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .footer-col ul { list-style: none; }

    .footer-col li { margin-bottom: 12px; }

    .footer-col a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 14px;
      transition: color 0.3s ease;
    }

    .footer-col a:hover { color: var(--primary-light); }

    .footer-bottom {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 32px;
      border-top: 1px solid var(--border-color);
    }

    .footer-bottom p {
      font-size: 14px;
      color: var(--text-muted);
    }

    .footer-social {
      display: flex;
      gap: 16px;
    }

    .footer-social a {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      text-decoration: none;
      transition: all 0.3s ease;
    }

    .footer-social a:hover {
      background: var(--primary);
      border-color: var(--primary);
      color: white;
    }

    /* Responsive */
    @media (max-width: 1024px) {
      .steps-grid { grid-template-columns: repeat(2, 1fr); }
      .steps-grid::before { display: none; }
      .features-grid { grid-template-columns: repeat(2, 1fr); }
      .testimonials-grid { grid-template-columns: repeat(2, 1fr); }
      .preview-container { grid-template-columns: 1fr; gap: 40px; }
      .footer-grid { grid-template-columns: repeat(2, 1fr); gap: 40px; }
    }

    @media (max-width: 768px) {
      .nav-links { gap: 4px; }
      .nav-link { padding: 8px 12px; font-size: 13px; }
      .steps-grid { grid-template-columns: 1fr; gap: 16px; }
      .features-grid { grid-template-columns: 1fr; }
      .testimonials-grid { grid-template-columns: 1fr; }
      .hero-buttons { flex-direction: column; width: 100%; }
      .hero-buttons .btn { width: 100%; justify-content: center; }
      .trust-stats { grid-template-columns: repeat(2, 1fr); }
      .footer-grid { grid-template-columns: 1fr; gap: 32px; }
      .footer-bottom { flex-direction: column; gap: 20px; text-align: center; }
      section { padding: 60px 0; }
    }

    @media (max-width: 480px) {
      .container { padding: 0 16px; }
      .hero h1 { font-size: 2rem; }
      .section-title { font-size: 1.75rem; }
      .trust-stats { grid-template-columns: 1fr; }
      .risk-badges { flex-direction: column; }
    }
  </style>
</head>
<body>
  <!-- Navigation -->
  <nav class="nav">
    <div class="container nav-inner">
      <a href="/" class="logo">ProBid AI</a>
      <div class="nav-links">
        ${uid ? `<span class="pill">${escapeHtml(req.session?.email || "user")}</span>` : ""}
        <a href="/pricing" class="nav-link">Pricing</a>
        ${uid ? `<a href="/app" class="btn btn-primary" style="padding:10px 20px;font-size:14px;">Open App</a>` : `<a href="/login" class="nav-link">Login</a>`}
        ${uid ? `<a href="/logout" class="nav-link">Logout</a>` : `<a href="/login" class="btn btn-primary" style="padding:10px 20px;font-size:14px;">Get Started Free</a>`}
        ${uid && paid ? `<a href="/billing" class="nav-link">Billing</a>` : ""}
      </div>
    </div>
  </nav>

  <!-- Hero Section -->
  <section class="hero">
    <div class="hero-bg"></div>
    <div class="hero-glow hero-glow-1"></div>
    <div class="hero-glow hero-glow-2"></div>
    <div class="container">
      <div class="hero-content">
        <div class="trust-badge animate-fade-in">
          <span>🔨</span> Built by a contractor, for contractors
        </div>
        <h1 class="animate-fade-in animate-delay-1">Fast Estimates for Small Contractors</h1>
        <p class="hero-subtitle animate-fade-in animate-delay-2">
          Skip the spreadsheets. Get professional estimates in under 30 seconds. Perfect for handymen, subcontractors, and small crews who need fast, polished proposals.
        </p>
        <div class="hero-benefits animate-fade-in animate-delay-2" style="display:flex;gap:24px;justify-content:center;margin-bottom:24px;flex-wrap:wrap;">
          <span style="color:var(--accent);font-weight:600;">✔ 30-second quotes</span>
          <span style="color:var(--accent);font-weight:600;">✔ No software to learn</span>
          <span style="color:var(--accent);font-weight:600;">✔ Professional PDFs</span>
        </div>
        <div class="hero-cta-group animate-fade-in animate-delay-3">
          <div class="hero-buttons">
            <a href="${uid ? "/app" : "/login"}" class="btn btn-accent">${uid ? "Open App" : "Start Free Today"} &rarr;</a>
            <a href="/pricing" class="btn btn-secondary">View Pricing</a>
          </div>
          <div class="pricing-teaser">
            <span class="highlight">$7 per estimate</span>
            <span>•</span>
            <span class="highlight">$199 lifetime access</span>
            <span>•</span>
            <span class="highlight">3 free estimates</span>
          </div>
          <div class="pricing-teaser" style="margin-top: 8px;">
            <span>No subscriptions required</span>
            <span>•</span>
            <span>No software to install</span>
          </div>
        </div>

        <!-- Trust Bar -->
        <div class="risk-badges animate-fade-in animate-delay-4">
          <div class="risk-badge">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            Built for contractors
          </div>
          <div class="risk-badge">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            Designed for real-world jobs
          </div>
          <div class="risk-badge">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            No credit card required
          </div>
          <div class="risk-badge">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            Cancel anytime
          </div>
        </div>

        <!-- Value Props -->
        <div class="trust-stats animate-fade-in animate-delay-5">
          <div class="stat-item">
            <div class="stat-number" style="font-size:1.5rem;">⚡</div>
            <div class="stat-label">Quote jobs in under 30 seconds</div>
          </div>
          <div class="stat-item">
            <div class="stat-number" style="font-size:1.5rem;">📱</div>
            <div class="stat-label">Works on any phone or tablet</div>
          </div>
          <div class="stat-item">
            <div class="stat-number" style="font-size:1.5rem;">📄</div>
            <div class="stat-label">Client-ready PDF proposals</div>
          </div>
          <div class="stat-item">
            <div class="stat-number" style="font-size:1.5rem;">💰</div>
            <div class="stat-label">Pay per quote or go unlimited</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- How It Works -->
  <section class="how-it-works" id="how-it-works">
    <div class="container">
      <div class="section-header">
        <span class="section-label">How It Works</span>
        <h2 class="section-title">Quote Any Job in 3 Simple Steps</h2>
        <p class="section-subtitle">No spreadsheets. No complicated software. Just fast, professional quotes.</p>
      </div>

      <div class="steps-grid">
        <div class="step-card animate-fade-in">
          <span class="step-number">1</span>
          <span class="step-icon">📝</span>
          <h3 class="step-title">Describe the Job</h3>
          <p class="step-desc">Upload a photo or type the scope of work. Tell us what needs to be done.</p>
        </div>
        <div class="step-card animate-fade-in animate-delay-1">
          <span class="step-number">2</span>
          <span class="step-icon">🤖</span>
          <h3 class="step-title">AI Analyzes the Project</h3>
          <p class="step-desc">Labor, materials, complexity, and regional pricing — calculated in seconds.</p>
        </div>
        <div class="step-card animate-fade-in animate-delay-2">
          <span class="step-number">3</span>
          <span class="step-icon">📄</span>
          <h3 class="step-title">Get Your Estimate</h3>
          <p class="step-desc">Use it internally or share with clients. Export as a professional PDF anytime.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Sample Output Section -->
  <section class="sample-output" id="sample-output">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Sample Output</span>
        <h2 class="section-title">What You'll Get</h2>
        <p class="section-subtitle">See exactly what a ProBid AI estimate looks like — professional, detailed, ready to use.</p>
      </div>

      <div class="sample-output-card animate-fade-in">
        <div class="sample-output-header">
          <span class="sample-output-badge">Sample Estimate Preview</span>
          <h3 class="sample-output-title">Tuckpointing - Brick Wall</h3>
        </div>
        
        <ul class="sample-output-list">
          <li class="sample-output-item">
            <span class="sample-output-label">Job Type</span>
            <span class="sample-output-value">Tuckpointing - Brick Wall</span>
          </li>
          <li class="sample-output-item">
            <span class="sample-output-label">Labor</span>
            <span class="sample-output-value">14–18 hours</span>
          </li>
          <li class="sample-output-item">
            <span class="sample-output-label">Materials</span>
            <span class="sample-output-value">$1,100–$1,400</span>
          </li>
          <li class="sample-output-item">
            <span class="sample-output-label">Includes</span>
            <span class="sample-output-value">Mortar, tools, cleanup</span>
          </li>
        </ul>
        
        <div class="sample-output-total">
          <span class="sample-output-total-label">Estimated Total</span>
          <span class="sample-output-total-value">$2,800–$3,400</span>
        </div>
        
        <div class="sample-output-disclaimer">
          Estimates are AI-generated starting points. Final pricing should be confirmed on-site.
        </div>
      </div>
    </div>
  </section>

  <!-- Example Estimates -->
  <section class="example-estimates" id="example-estimates">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Example Estimates</span>
        <h2 class="section-title">See Real Estimate Examples</h2>
        <p class="section-subtitle">Professional estimates your clients will love — here's exactly what you'll get.</p>
      </div>

      <div class="example-estimates-grid">
        <div class="example-card animate-fade-in">
          <div class="example-header">
            <span class="example-header-icon">🧱</span>
            <h3 class="example-header-title">Brick Chimney Rebuild (25 LF)</h3>
          </div>
          <ul class="example-line-items">
            <li class="example-line-item">
              <span class="example-line-label">Labor</span>
              <span class="example-line-value">$3,200</span>
            </li>
            <li class="example-line-item">
              <span class="example-line-label">Materials</span>
              <span class="example-line-value">$1,450</span>
            </li>
            <li class="example-line-item">
              <span class="example-line-label">Overhead & Margin</span>
              <span class="example-line-value">$1,050</span>
            </li>
          </ul>
          <div class="example-total">
            <span class="example-total-label">TOTAL</span>
            <span class="example-total-value">$5,700</span>
          </div>
          <span class="example-watermark">Example Estimate • ProBid AI</span>
        </div>

        <div class="example-card animate-fade-in animate-delay-1">
          <div class="example-header">
            <span class="example-header-icon">🏗️</span>
            <h3 class="example-header-title">Concrete Patio (400 sq ft)</h3>
          </div>
          <ul class="example-line-items">
            <li class="example-line-item">
              <span class="example-line-label">Labor</span>
              <span class="example-line-value">$4,800</span>
            </li>
            <li class="example-line-item">
              <span class="example-line-label">Materials</span>
              <span class="example-line-value">$3,200</span>
            </li>
            <li class="example-line-item">
              <span class="example-line-label">Overhead & Margin</span>
              <span class="example-line-value">$2,000</span>
            </li>
          </ul>
          <div class="example-total">
            <span class="example-total-label">TOTAL</span>
            <span class="example-total-value">$10,000</span>
          </div>
          <span class="example-watermark">Example Estimate • ProBid AI</span>
        </div>

        <div class="example-card animate-fade-in animate-delay-2">
          <div class="example-header">
            <span class="example-header-icon">🏠</span>
            <h3 class="example-header-title">Roof Replacement (2,000 sq ft)</h3>
          </div>
          <ul class="example-line-items">
            <li class="example-line-item">
              <span class="example-line-label">Labor</span>
              <span class="example-line-value">$6,200</span>
            </li>
            <li class="example-line-item">
              <span class="example-line-label">Materials</span>
              <span class="example-line-value">$5,900</span>
            </li>
            <li class="example-line-item">
              <span class="example-line-label">Overhead & Margin</span>
              <span class="example-line-value">$2,400</span>
            </li>
          </ul>
          <div class="example-total">
            <span class="example-total-label">TOTAL</span>
            <span class="example-total-value">$14,500</span>
          </div>
          <span class="example-watermark">Example Estimate • ProBid AI</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Estimate Preview -->
  <section class="estimate-preview">
    <div class="container">
      <div class="preview-container">
        <div class="preview-content animate-fade-in">
          <span class="section-label">See It In Action</span>
          <h2>Professional Estimates Your Clients Will Love</h2>
          <p>Generate detailed, itemized estimates that build trust and win more jobs. Every estimate includes labor, materials, and regional pricing adjustments.</p>
          <div class="preview-features">
            <div class="preview-feature">
              <div class="preview-feature-icon">&#10003;</div>
              <span>Itemized labor and materials breakdown</span>
            </div>
            <div class="preview-feature">
              <div class="preview-feature-icon">&#10003;</div>
              <span>Regional market price adjustments</span>
            </div>
            <div class="preview-feature">
              <div class="preview-feature-icon">&#10003;</div>
              <span>Professional PDF export ready to send</span>
            </div>
            <div class="preview-feature">
              <div class="preview-feature-icon">&#10003;</div>
              <span>Save and track all your estimates</span>
            </div>
          </div>
        </div>
        <div class="estimate-mockup animate-fade-in animate-delay-2">
          <div class="estimate-header">
            <span class="estimate-logo">ProBid AI</span>
            <span class="estimate-date">Sample Estimate</span>
          </div>
          <h3 class="estimate-title">Tuckpointing Estimate - 2-Story Residential</h3>
          <div class="estimate-line">
            <span class="estimate-line-label">Mortar Removal & Repoint (45 LF)</span>
            <span class="estimate-line-value">$1,125.00</span>
          </div>
          <div class="estimate-line">
            <span class="estimate-line-label">Premium Type S Mortar</span>
            <span class="estimate-line-value">$185.00</span>
          </div>
          <div class="estimate-line">
            <span class="estimate-line-label">Scaffold Setup & Safety</span>
            <span class="estimate-line-value">$350.00</span>
          </div>
          <div class="estimate-line">
            <span class="estimate-line-label">Clean-up & Disposal</span>
            <span class="estimate-line-value">$150.00</span>
          </div>
          <div class="estimate-line">
            <span class="estimate-line-label">Midwest Region Adjustment (+5%)</span>
            <span class="estimate-line-value">$90.50</span>
          </div>
          <div class="estimate-total">
            <span>Total Estimate</span>
            <span class="estimate-total-value">$1,900.50</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Features Grid -->
  <section class="features" id="features">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Features</span>
        <h2 class="section-title">Everything You Need to Bid Smarter</h2>
        <p class="section-subtitle">Powerful tools designed specifically for construction professionals.</p>
      </div>

      <div class="features-grid">
        <div class="feature-card animate-fade-in">
          <div class="feature-icon">📷</div>
          <h3 class="feature-title">Photo Analysis</h3>
          <p class="feature-desc">AI examines job site photos to assess scope, identify materials, and spot potential issues.</p>
        </div>
        <div class="feature-card animate-fade-in animate-delay-1">
          <div class="feature-icon">🤖</div>
          <h3 class="feature-title">GPT-4o Vision</h3>
          <p class="feature-desc">Industry-leading AI understands construction work better than any other tool on the market.</p>
        </div>
        <div class="feature-card animate-fade-in animate-delay-2">
          <div class="feature-icon">💰</div>
          <h3 class="feature-title">Regional Pricing</h3>
          <p class="feature-desc">Estimates automatically adjusted for your local market rates and material costs.</p>
        </div>
        <div class="feature-card animate-fade-in animate-delay-3">
          <div class="feature-icon">⚡</div>
          <h3 class="feature-title">Instant Results</h3>
          <p class="feature-desc">Get professional estimates in seconds, not hours. Respond to leads faster than competitors.</p>
        </div>
        <div class="feature-card animate-fade-in animate-delay-4">
          <div class="feature-icon">📄</div>
          <h3 class="feature-title">PDF Export</h3>
          <p class="feature-desc">Generate branded, professional proposals ready to send to clients immediately.</p>
        </div>
        <div class="feature-card animate-fade-in animate-delay-5">
          <div class="feature-icon">📊</div>
          <h3 class="feature-title">Lead Tracking</h3>
          <p class="feature-desc">Save client info, track estimates, and manage your pipeline all in one place.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- What You'll Get -->
  <section class="testimonials" id="benefits">
    <div class="container">
      <div class="section-header">
        <span class="section-label">What You'll Get</span>
        <h2 class="section-title">Built for Contractors Who Want Faster, Cleaner Estimates</h2>
        <p class="section-subtitle">Designed from real job workflows to help you quote smarter and win more work.</p>
      </div>

      <div class="testimonials-grid">
        <div class="testimonial-card animate-fade-in">
          <div class="testimonial-stars" style="color:var(--primary-light);">⏱️</div>
          <p class="testimonial-text" style="font-style:normal;">"Stop spending hours on each quote. Upload a photo or describe the job — get a professional estimate in seconds, not hours."</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar" style="background:linear-gradient(135deg, var(--accent), var(--accent-dark));">⚡</div>
            <div class="testimonial-info">
              <h4>Save Time</h4>
              <p>Respond to leads faster than competitors</p>
            </div>
          </div>
        </div>
        <div class="testimonial-card animate-fade-in animate-delay-1">
          <div class="testimonial-stars" style="color:var(--primary-light);">📊</div>
          <p class="testimonial-text" style="font-style:normal;">"AI-powered analysis helps you catch details you might have missed. Get itemized breakdowns with labor, materials, and regional pricing."</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar" style="background:linear-gradient(135deg, var(--accent), var(--accent-dark));">🎯</div>
            <div class="testimonial-info">
              <h4>Quote Smarter</h4>
              <p>Accurate estimates adjusted for your market</p>
            </div>
          </div>
        </div>
        <div class="testimonial-card animate-fade-in animate-delay-2">
          <div class="testimonial-stars" style="color:var(--primary-light);">📄</div>
          <p class="testimonial-text" style="font-style:normal;">"Generate branded, client-ready PDFs that look professional. Impress clients with fast turnaround and polished proposals."</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar" style="background:linear-gradient(135deg, var(--accent), var(--accent-dark));">🏆</div>
            <div class="testimonial-info">
              <h4>Win More Jobs</h4>
              <p>Professional proposals that close deals</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Early Access CTA -->
  <section class="partners">
    <div class="container">
      <p class="partners-label">Join early access and help shape the future</p>
      <div class="partners-logos">
        <div class="partner-logo">Masonry</div>
        <div class="partner-logo">Concrete</div>
        <div class="partner-logo">Roofing</div>
        <div class="partner-logo">Tuckpointing</div>
        <div class="partner-logo">& More</div>
      </div>
    </div>
  </section>

  <!-- Trust Block -->
  <section class="trust-block" id="trust">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Your Trust Matters</span>
        <h2 class="section-title">Built With Security & Transparency</h2>
        <p class="section-subtitle">We take your privacy and security seriously. Here's what you can count on.</p>
      </div>

      <div class="trust-block-grid">
        <div class="trust-block-item animate-fade-in">
          <span class="trust-block-icon">🔒</span>
          <div class="trust-block-text">Your data stays private</div>
          <div class="trust-block-subtext">Encrypted and never shared</div>
        </div>
        <div class="trust-block-item animate-fade-in animate-delay-1">
          <span class="trust-block-icon">💳</span>
          <div class="trust-block-text">Secure payments via Stripe</div>
          <div class="trust-block-subtext">Industry-leading security</div>
        </div>
        <div class="trust-block-item animate-fade-in animate-delay-2">
          <span class="trust-block-icon">❌</span>
          <div class="trust-block-text">Cancel anytime, no contracts</div>
          <div class="trust-block-subtext">No hidden fees or lock-ins</div>
        </div>
        <div class="trust-block-item animate-fade-in animate-delay-3">
          <span class="trust-block-icon">📧</span>
          <div class="trust-block-text">Real support</div>
          <div class="trust-block-subtext">support@probidai.com</div>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="faq" id="faq">
    <div class="container">
      <div class="section-header">
        <span class="section-label">FAQ</span>
        <h2 class="section-title">Frequently Asked Questions</h2>
        <p class="section-subtitle">Everything you need to know about ProBid AI.</p>
      </div>

      <div class="faq-list">
        <div class="faq-item active">
          <div class="faq-question">
            <span>How accurate are the AI estimates?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">ProBid AI uses current regional material and labor pricing as a solid starting point for your estimate. Always review the line items against your own knowledge of the job before sending the PDF to a client.</p>
          </div>
        </div>
        <div class="faq-item">
          <div class="faq-question">
            <span>What types of jobs can ProBid estimate?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">ProBid excels at masonry, concrete, roofing, and general construction. We support tuckpointing, chimney repair, retaining walls, flatwork, brick repair, and many more job types. New categories are added regularly.</p>
          </div>
        </div>
        <div class="faq-item">
          <div class="faq-question">
            <span>Is my data secure?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">Absolutely. All data is encrypted in transit and at rest. We never share your estimates, client information, or photos with third parties. Your business data belongs to you.</p>
          </div>
        </div>
        <div class="faq-item">
          <div class="faq-question">
            <span>Can I cancel my subscription anytime?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">Yes! There are no long-term contracts. Cancel anytime directly from your billing page. Plus, we offer a 7-day money-back guarantee if you're not satisfied.</p>
          </div>
        </div>
        <div class="faq-item">
          <div class="faq-question">
            <span>Do I need a credit card for the free tier?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">No credit card required. Sign up with just your email and get 3 free estimates immediately. Upgrade only when you're ready for unlimited access.</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Final CTA -->
  <section class="final-cta">
    <div class="container">
      <h2 class="animate-fade-in">Ready to Quote Faster?</h2>
      <p class="animate-fade-in animate-delay-1">Skip the spreadsheets. Get professional estimates in seconds. Try it free — no credit card required.</p>
      <a href="${uid ? "/app" : "/login"}" class="btn btn-accent animate-fade-in animate-delay-2">${uid ? "Open App" : "Start Free Today"} &rarr;</a>
      <div class="guarantee-box animate-fade-in animate-delay-3">
        <span class="guarantee-icon">&#128737;</span>
        <div class="guarantee-text">
          <strong>7-Day Money-Back Guarantee</strong>
          <span>Not satisfied? Get a full refund, no questions asked.</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a href="/" class="logo">ProBid AI</a>
          <p>AI-powered construction estimates built for real contractors. Generate professional bids in seconds, not hours.</p>
        </div>
        <div class="footer-col">
          <h4>Product</h4>
          <ul>
            <li><a href="#features">Features</a></li>
            <li><a href="/pricing">Pricing</a></li>
            <li><a href="#how-it-works">How It Works</a></li>
            <li><a href="#benefits">Benefits</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>Estimators</h4>
          <ul>
            <li><a href="/estimate/tuckpointing">Tuckpointing</a></li>
            <li><a href="/estimate/chimney-repair">Chimney Repair</a></li>
            <li><a href="/estimate/retaining-wall">Retaining Wall</a></li>
            <li><a href="/estimate/concrete-flatwork">Concrete</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>Company</h4>
          <ul>
            <li><a href="#faq">FAQ</a></li>
            <li><a href="/login">Login</a></li>
            <li><a href="/pricing">Pricing</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <p>&copy; 2025 ProBid AI — Built by Jesse Kirchner • United States</p>
        <p style="font-size: 12px; margin-top: 8px;">Not affiliated with any construction association.</p>
        <p style="font-size: 13px; margin-top: 12px;">
          <a href="#" style="color: var(--text-muted);">Privacy Policy</a> | 
          <a href="#" style="color: var(--text-muted);">Terms of Service</a> | 
          Contact: <a href="mailto:support@probidai.com" style="color: var(--primary-light);">support@probidai.com</a>
        </p>
      </div>
    </div>
  </footer>

  <script>
    // FAQ Accordion
    document.querySelectorAll('.faq-question').forEach(question => {
      question.addEventListener('click', () => {
        const item = question.parentElement;
        const isActive = item.classList.contains('active');
        document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('active'));
        if (!isActive) item.classList.add('active');
      });
    });

    // Scroll animations with Intersection Observer
    const observerOptions = { threshold: 0.1, rootMargin: '0px 0px -50px 0px' };
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.style.animationPlayState = 'running';
          observer.unobserve(entry.target);
        }
      });
    }, observerOptions);

    document.querySelectorAll('.animate-fade-in').forEach(el => {
      el.style.animationPlayState = 'paused';
      observer.observe(el);
    });

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  </script>
</body>
</html>
  `);
  }),
);

// Sitemap for SEO
app.get("/sitemap.xml", (req, res) => {
  const CANONICAL = "https://probidcore.net";
  const pages = [
    { loc: "/", priority: "1.0" },
    { loc: "/pricing", priority: "0.8" },
    { loc: "/estimate/tuckpointing", priority: "0.9" },
    { loc: "/estimate/chimney-repair", priority: "0.9" },
    { loc: "/estimate/retaining-wall", priority: "0.9" },
    { loc: "/estimate/brick-repair", priority: "0.9" },
    { loc: "/estimate/concrete-flatwork", priority: "0.9" },
  ];

  const urls = pages
    .map(
      (p) => `
  <url>
    <loc>${CANONICAL}${p.loc}</loc>
    <priority>${p.priority}</priority>
    <changefreq>weekly</changefreq>
  </url>`,
    )
    .join("");

  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
});

// Robots.txt for SEO
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(`User-agent: *
Allow: /
Sitemap: https://probidcore.net/sitemap.xml`);
});

app.get("/pricing", asyncHandler(async (req, res) => {
  const uid = req.session?.uid;
  const sub = uid ? getSub(uid) : undefined;
  const paid = isPaidActive(sub);
  const ltStatus = await getLifetimeStatus().catch(() => ({ soldOut: false, remaining: 100, cap: 100, purchased: 0, totalRevenueCents: 0 }));

  res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <meta name="description" content="ProBid AI pricing - Choose the perfect plan for your contracting business. Start free, upgrade anytime."/>
  <title>Pricing - ProBid AI | Plans for Every Contractor</title>
  <link rel="canonical" href="https://probidcore.net/pricing"/>
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
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
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
      overflow-x: hidden;
    }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-6px); }
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
      50% { box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
    }

    .animate-fade-in { animation: fadeInUp 0.8s ease-out forwards; opacity: 0; }
    .animate-delay-1 { animation-delay: 0.1s; }
    .animate-delay-2 { animation-delay: 0.2s; }
    .animate-delay-3 { animation-delay: 0.3s; }
    .animate-delay-4 { animation-delay: 0.4s; }
    .animate-delay-5 { animation-delay: 0.5s; }

    .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }

    /* Navigation */
    .nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      padding: 16px 0;
      background: rgba(10, 14, 26, 0.8);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
    }

    .nav-inner {
      display: flex;
      justify-content: space-between;
      align-items: center;
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

    .nav-links { display: flex; gap: 8px; align-items: center; }

    .nav-link {
      padding: 10px 18px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      transition: all 0.3s ease;
    }

    .nav-link:hover { color: var(--text-primary); background: var(--glass-bg); }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(99, 102, 241, 0.2));
      border: 1px solid var(--border-light);
      font-size: 13px;
      font-weight: 600;
      color: var(--primary-light);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 32px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
      width: 100%;
    }

    .btn-primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .btn-primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(79, 70, 229, 0.5);
    }

    .btn-accent {
      color: var(--text-dark);
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 4px 20px rgba(34, 197, 94, 0.3);
    }

    .btn-accent:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(34, 197, 94, 0.4);
    }

    .btn-outline {
      color: var(--text-primary);
      background: transparent;
      border: 2px solid var(--border-color);
    }

    .btn-outline:hover {
      border-color: var(--primary-light);
      background: var(--glass-bg);
    }

    /* Hero Section */
    .pricing-hero {
      position: relative;
      padding: 140px 0 80px;
      text-align: center;
      overflow: hidden;
    }

    .pricing-hero-bg {
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
    }

    .hero-glow {
      position: absolute;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.25;
    }

    .hero-glow-1 { top: -150px; left: -150px; background: var(--primary); }
    .hero-glow-2 { bottom: -150px; right: -150px; background: #7c3aed; }

    .pricing-hero-content {
      position: relative;
      z-index: 10;
    }

    .section-label {
      display: inline-block;
      padding: 8px 18px;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid var(--border-light);
      color: var(--primary-light);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .pricing-hero h1 {
      font-size: clamp(2.25rem, 5vw, 3.5rem);
      font-weight: 900;
      line-height: 1.15;
      margin-bottom: 20px;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 50%, var(--text-primary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .pricing-hero p {
      font-size: 1.15rem;
      color: var(--text-muted);
      max-width: 600px;
      margin: 0 auto 32px;
      line-height: 1.7;
    }

    /* Risk Badges */
    .risk-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: center;
    }

    .risk-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 10px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      font-size: 14px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .risk-badge svg { width: 18px; height: 18px; color: var(--accent); flex-shrink: 0; }

    /* Pricing Cards */
    .pricing-section { padding: 60px 0 100px; }

    .pricing-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      align-items: stretch;
    }

    .pricing-card {
      position: relative;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 36px 28px;
      transition: all 0.4s ease;
      display: flex;
      flex-direction: column;
    }

    .pricing-card:hover {
      transform: translateY(-8px);
      border-color: var(--border-light);
      box-shadow: 0 24px 50px rgba(0, 0, 0, 0.35);
    }

    .pricing-card.featured {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.15) 0%, rgba(99, 102, 241, 0.1) 100%);
      border: 2px solid var(--primary-light);
      transform: scale(1.05);
      box-shadow: 0 20px 60px rgba(79, 70, 229, 0.25);
    }

    .pricing-card.featured:hover {
      transform: scale(1.05) translateY(-8px);
    }

    .popular-badge {
      position: absolute;
      top: -14px;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 20px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      color: var(--text-dark);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      animation: pulse 2s infinite;
    }

    .pricing-card-header { margin-bottom: 24px; text-align: center; }

    .plan-name {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 8px;
    }

    .plan-desc {
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    .plan-price {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 4px;
    }

    .price-currency {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-muted);
    }

    .price-amount {
      font-size: 3.5rem;
      font-weight: 900;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      line-height: 1;
    }

    .price-period {
      font-size: 1rem;
      color: var(--text-muted);
      font-weight: 500;
    }

    .pricing-card-features {
      flex: 1;
      margin-bottom: 28px;
    }

    .feature-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .feature-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .feature-item svg {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .feature-item svg.check { color: var(--accent); }
    .feature-item svg.cross { color: #64748b; }

    .feature-item.highlight { color: var(--text-primary); font-weight: 500; }

    /* Feature Comparison Table */
    .comparison-section {
      padding: 80px 0;
      background: linear-gradient(180deg, var(--bg-dark) 0%, rgba(15, 23, 42, 0.5) 50%, var(--bg-dark) 100%);
    }

    .section-header {
      text-align: center;
      max-width: 700px;
      margin: 0 auto 50px;
    }

    .section-title {
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      font-weight: 800;
      margin-bottom: 16px;
      color: var(--text-primary);
    }

    .section-subtitle {
      font-size: 1.05rem;
      color: var(--text-muted);
      line-height: 1.7;
    }

    .comparison-table-wrapper {
      overflow-x: auto;
      border-radius: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
    }

    .comparison-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 700px;
    }

    .comparison-table th,
    .comparison-table td {
      padding: 18px 24px;
      text-align: center;
      border-bottom: 1px solid var(--border-color);
    }

    .comparison-table th {
      background: rgba(79, 70, 229, 0.1);
      font-weight: 700;
      font-size: 15px;
      color: var(--text-primary);
    }

    .comparison-table th:first-child { text-align: left; }
    .comparison-table td:first-child { text-align: left; color: var(--text-muted); font-size: 14px; }

    .comparison-table tr:last-child td { border-bottom: none; }

    .comparison-table tbody tr:hover { background: rgba(99, 102, 241, 0.05); }

    .table-check {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(34, 197, 94, 0.15);
      color: var(--accent);
    }

    .table-cross {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      color: #64748b;
    }

    .table-text { font-size: 14px; color: var(--text-primary); font-weight: 600; }

    /* Testimonials */
    .testimonials-section { padding: 80px 0; }

    .testimonials-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }

    .testimonial-card {
      padding: 28px;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      transition: all 0.4s ease;
    }

    .testimonial-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-light);
    }

    .testimonial-stars {
      color: #fbbf24;
      font-size: 1rem;
      margin-bottom: 14px;
    }

    .testimonial-text {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.7;
      margin-bottom: 20px;
      font-style: italic;
    }

    .testimonial-author {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .testimonial-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      color: white;
    }

    .testimonial-info h4 {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .testimonial-info p {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* FAQ Section */
    .faq-section {
      padding: 80px 0;
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.3) 0%, var(--bg-dark) 100%);
    }

    .faq-list {
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .faq-item {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .faq-item:hover { border-color: var(--border-light); }

    .faq-question {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 22px 24px;
      cursor: pointer;
      font-weight: 600;
      font-size: 15px;
      color: var(--text-primary);
      transition: all 0.3s ease;
    }

    .faq-question:hover { color: var(--primary-light); }

    .faq-icon {
      font-size: 1.5rem;
      color: var(--primary-light);
      transition: transform 0.3s ease;
      font-weight: 300;
    }

    .faq-answer {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease, padding 0.3s ease;
    }

    .faq-item.active .faq-answer {
      max-height: 400px;
      padding: 0 24px 24px;
    }

    .faq-item.active .faq-icon { transform: rotate(45deg); }

    .faq-answer-text {
      color: var(--text-muted);
      line-height: 1.7;
      font-size: 14px;
    }

    /* CTA Section */
    .cta-section {
      padding: 100px 0;
      text-align: center;
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.1) 0%, rgba(34, 197, 94, 0.08) 100%);
    }

    .cta-section h2 {
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      font-weight: 800;
      margin-bottom: 16px;
    }

    .cta-section p {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 32px;
      max-width: 550px;
      margin-left: auto;
      margin-right: auto;
    }

    .cta-buttons {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
    }

    .cta-buttons .btn { width: auto; padding: 18px 36px; }

    .guarantee-box {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      margin-top: 36px;
      padding: 18px 28px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 14px;
    }

    .guarantee-icon { font-size: 2.25rem; }

    .guarantee-text { text-align: left; }
    .guarantee-text strong { display: block; color: var(--accent); font-size: 15px; }
    .guarantee-text span { font-size: 13px; color: var(--text-muted); }

    /* Footer */
    .footer {
      background: var(--bg-darker);
      padding: 50px 0 30px;
      border-top: 1px solid var(--border-color);
      text-align: center;
    }

    .footer p { color: var(--text-muted); font-size: 14px; }
    .footer a { color: var(--primary-light); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }

    /* Responsive */
    @media (max-width: 1024px) {
      .pricing-grid { grid-template-columns: 1fr; max-width: 420px; margin: 0 auto; }
      .pricing-card.featured { transform: none; }
      .pricing-card.featured:hover { transform: translateY(-8px); }
      .testimonials-grid { grid-template-columns: 1fr 1fr; }
    }

    @media (max-width: 768px) {
      .nav-links { gap: 4px; }
      .nav-link { padding: 8px 12px; font-size: 13px; }
      .testimonials-grid { grid-template-columns: 1fr; }
      .risk-badges { flex-direction: column; align-items: center; }
      .cta-buttons { flex-direction: column; align-items: center; }
      .cta-buttons .btn { width: 100%; max-width: 300px; }
    }

    @media (max-width: 480px) {
      .container { padding: 0 16px; }
      .pricing-card { padding: 28px 20px; }
      .comparison-table th, .comparison-table td { padding: 14px 16px; }
    }
  </style>
</head>
<body>
  <!-- Navigation -->
  <nav class="nav">
    <div class="container nav-inner">
      <a href="/" class="logo">ProBid AI</a>
      <div class="nav-links">
        ${uid ? `<span class="pill">${escapeHtml(req.session?.email || "user")}</span>` : ""}
        <a href="/" class="nav-link">Home</a>
        ${uid ? `<a href="/app" class="btn btn-primary" style="padding:10px 20px;font-size:14px;width:auto;">Open App</a>` : `<a href="/login" class="nav-link">Login</a>`}
        ${uid ? `<a href="/logout" class="nav-link">Logout</a>` : `<a href="/login" class="btn btn-primary" style="padding:10px 20px;font-size:14px;width:auto;">Get Started Free</a>`}
        ${uid && paid ? `<a href="/billing" class="nav-link">Billing</a>` : ""}
      </div>
    </div>
  </nav>

  <!-- Hero Section -->
  <section class="pricing-hero">
    <div class="pricing-hero-bg"></div>
    <div class="hero-glow hero-glow-1"></div>
    <div class="hero-glow hero-glow-2"></div>
    <div class="container pricing-hero-content">
      <span class="section-label animate-fade-in">Simple, Transparent Pricing</span>
      <h1 class="animate-fade-in animate-delay-1">Choose the Perfect Plan<br>for Your Business</h1>
      <p class="animate-fade-in animate-delay-2">Start free with 3 lifetime estimates. Upgrade anytime to unlock unlimited power and grow your contracting business.</p>
      <div class="risk-badges animate-fade-in animate-delay-3">
        <div class="risk-badge">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          7-Day Money-Back Guarantee
        </div>
        <div class="risk-badge">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          Cancel Anytime
        </div>
        <div class="risk-badge">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          No Credit Card for Free Tier
        </div>
      </div>
    </div>
  </section>

  <!-- One-Time Options -->
  <section class="pricing-section" style="padding-bottom: 20px;">
    <div class="container">
      <div class="section-header" style="margin-bottom: 32px;">
        <span class="section-label">No Subscription Needed</span>
        <h2 class="section-title" style="font-size: 28px;">One-Time Payment Options</h2>
        <p class="section-subtitle">Pay only for what you need. No recurring charges.</p>
      </div>
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; max-width: 700px; margin: 0 auto;">
        <!-- Single Estimate -->
        <div class="pricing-card animate-fade-in" style="transform: none;">
          <div class="pricing-card-header">
            <div class="plan-name">Single Estimate</div>
            <div class="plan-desc">Pay as you go</div>
            <div class="plan-price">
              <span class="price-currency">$</span>
              <span class="price-amount">7</span>
              <span class="price-period">one-time</span>
            </div>
          </div>
          <div class="pricing-card-features">
            <ul class="feature-list">
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                1 AI-powered estimate
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Photo upload included
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                No subscription required
              </li>
            </ul>
          </div>
          <a href="${uid ? "/checkout/single" : "/login?redirect=/checkout/single"}" class="btn btn-outline">Buy Single Estimate</a>
        </div>

        <!-- Lifetime Deal -->
        <div class="pricing-card animate-fade-in animate-delay-1" style="transform: none; border-color: ${ltStatus.soldOut ? "#6b7280" : "var(--accent)"};">
          ${ltStatus.soldOut
            ? `<div class="popular-badge" style="background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);">Sold Out</div>`
            : `<div class="popular-badge" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">Best Value</div>`
          }
          <div class="pricing-card-header">
            <div class="plan-name">Lifetime Access</div>
            <div class="plan-desc">${ltStatus.soldOut ? "This offer has sold out" : `Limited launch offer — ${ltStatus.remaining} of ${ltStatus.cap} spots left`}</div>
            <div class="plan-price">
              <span class="price-currency">$</span>
              <span class="price-amount">199</span>
              <span class="price-period">one-time</span>
            </div>
          </div>
          <div class="pricing-card-features">
            <ul class="feature-list">
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Unlimited estimates forever
              </li>
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Never pay again
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Photo upload included
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                All Pro features
              </li>
            </ul>
          </div>
          ${ltStatus.soldOut
            ? `<button class="btn" style="opacity:0.5;cursor:not-allowed;background:#374151;border-color:#374151;" disabled>Lifetime Offer — Sold Out</button>`
            : `<a href="${uid ? "/checkout/lifetime" : "/login?redirect=/checkout/lifetime"}" class="btn btn-accent">Get Lifetime Access — $199</a>`
          }
        </div>
      </div>
    </div>
  </section>

  <!-- Subscription Plans -->
  <section class="pricing-section" style="padding-top: 40px;">
    <div class="container">
      <div class="section-header" style="margin-bottom: 32px;">
        <span class="section-label">Monthly Plans</span>
        <h2 class="section-title" style="font-size: 28px;">Or Choose a Subscription</h2>
        <p class="section-subtitle">Flexible monthly plans for ongoing needs.</p>
      </div>
      <div class="pricing-grid">
        <!-- FREE Plan -->
        <div class="pricing-card animate-fade-in">
          <div class="pricing-card-header">
            <div class="plan-name">Free</div>
            <div class="plan-desc">Perfect for trying it out</div>
            <div class="plan-price">
              <span class="price-currency">$</span>
              <span class="price-amount">0</span>
              <span class="price-period">/forever</span>
            </div>
          </div>
          <div class="pricing-card-features">
            <ul class="feature-list">
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                3 lifetime free estimates
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                AI-powered estimates
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Photo upload analysis
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Basic job types
              </li>
              <li class="feature-item">
                <svg class="cross" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                No saved history
              </li>
              <li class="feature-item">
                <svg class="cross" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                No PDF exports
              </li>
            </ul>
          </div>
          <a href="/login" class="btn btn-outline">Start Free</a>
        </div>

        <!-- PRO Plan -->
        <div class="pricing-card featured animate-fade-in animate-delay-1">
          <div class="popular-badge">Most Popular</div>
          <div class="pricing-card-header">
            <div class="plan-name">Pro</div>
            <div class="plan-desc">For serious contractors</div>
            <div class="plan-price">
              <span class="price-currency">$</span>
              <span class="price-amount">25</span>
              <span class="price-period">/month</span>
            </div>
          </div>
          <div class="pricing-card-features">
            <ul class="feature-list">
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Unlimited estimates
              </li>
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Save estimate history
              </li>
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                PDF export with branding
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Priority AI responses
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Lead management CRM
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Email support
              </li>
            </ul>
          </div>
          <a href="/checkout?plan=pro" class="btn btn-accent">Get Pro Plan</a>
        </div>

        <!-- BUSINESS Plan -->
        <div class="pricing-card animate-fade-in animate-delay-2">
          <div class="pricing-card-header">
            <div class="plan-name">Business</div>
            <div class="plan-desc">For teams & agencies</div>
            <div class="plan-price">
              <span class="price-currency">$</span>
              <span class="price-amount">55</span>
              <span class="price-period">/month</span>
            </div>
          </div>
          <div class="pricing-card-features">
            <ul class="feature-list">
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Everything in Pro
              </li>
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Unlimited estimates
              </li>
              <li class="feature-item highlight">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Saved estimate history
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Professional PDF exports
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Priority support (24hr)
              </li>
              <li class="feature-item">
                <svg class="check" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                Best value for busy contractors
              </li>
            </ul>
          </div>
          <a href="/checkout?plan=business" class="btn btn-primary">Get Business Plan</a>
        </div>
      </div>
    </div>
  </section>

  <!-- Feature Comparison Table -->
  <section class="comparison-section">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Compare Plans</span>
        <h2 class="section-title">Feature Comparison</h2>
        <p class="section-subtitle">See exactly what you get with each plan</p>
      </div>

      <div class="comparison-table-wrapper">
        <table class="comparison-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Free</th>
              <th>Pro</th>
              <th>Business</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Free Estimates</td>
              <td><span class="table-text">3 lifetime</span></td>
              <td><span class="table-text">Unlimited</span></td>
              <td><span class="table-text">Unlimited</span></td>
            </tr>
            <tr>
              <td>AI-Powered Analysis</td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
            </tr>
            <tr>
              <td>Photo Upload</td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
            </tr>
            <tr>
              <td>Save Estimate History</td>
              <td><span class="table-cross"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
            </tr>
            <tr>
              <td>PDF Export</td>
              <td><span class="table-cross"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
            </tr>
            <tr>
              <td>Priority AI Responses</td>
              <td><span class="table-cross"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
            </tr>
            <tr>
              <td>Lead Management CRM</td>
              <td><span class="table-cross"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
              <td><span class="table-check"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span></td>
            </tr>
            <tr>
              <td>Priority Support</td>
              <td><span class="table-cross"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></span></td>
              <td><span class="table-text">Email</span></td>
              <td><span class="table-text">24hr Priority</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- Testimonials -->
  <section class="testimonials-section">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Testimonials</span>
        <h2 class="section-title">Built by a Working Contractor</h2>
        <p class="section-subtitle">A note from the founder, Jesse Kirchner</p>
      </div>

      <div class="testimonials-grid" style="grid-template-columns: 1fr; max-width: 640px; margin: 0 auto;">
        <div class="testimonial-card">
          <p class="testimonial-text">"I built ProBid AI because I was sick of losing my evenings to estimates. After a long day of masonry work, I'd still have hours of measuring, pricing, and typing ahead of me. Now I generate a full estimate from a photo on the drive home."</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar">JK</div>
            <div class="testimonial-info">
              <h4>Jesse Kirchner</h4>
              <p>Founder · Kirchner Masonry, Galena, IL</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ Section -->
  <section class="faq-section">
    <div class="container">
      <div class="section-header">
        <span class="section-label">FAQ</span>
        <h2 class="section-title">Frequently Asked Questions</h2>
        <p class="section-subtitle">Everything you need to know about our pricing</p>
      </div>

      <div class="faq-list">
        <div class="faq-item active">
          <div class="faq-question">
            <span>Can I try ProBid AI for free?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">Absolutely! Our Free plan gives you 3 free lifetime estimates with no credit card required. It's a great way to see how ProBid AI can transform your bidding process before committing to a paid plan.</p>
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question">
            <span>What's your refund policy?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">We offer a 7-day money-back guarantee on all paid plans. If you're not completely satisfied within the first 7 days, contact us and we'll refund your payment in full—no questions asked.</p>
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question">
            <span>Can I cancel my subscription anytime?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">Yes! You can cancel your subscription at any time from your billing dashboard. Your access will continue until the end of your current billing period, and you won't be charged again.</p>
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question">
            <span>What's the difference between Pro and Business?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">Both plans include unlimited estimates, saved estimate history, and professional PDF exports. Business offers the same full feature set as Pro, making it ideal for contractors who want a higher-tier plan with priority 24-hour support included.</p>
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question">
            <span>How accurate are the AI estimates?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">ProBid AI uses GPT-4o Vision to analyze job site photos plus current regional material and labor pricing. Estimates are designed as a strong starting point — always review the line items against your own knowledge of the job before sending the PDF to a client.</p>
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question">
            <span>Do you offer annual billing discounts?</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-answer">
            <p class="faq-answer-text">We're currently working on annual billing options that will include a discount. Contact our support team if you're interested in annual billing and we can arrange a custom plan for you.</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA Section -->
  <section class="cta-section">
    <div class="container">
      <h2>Ready to Transform Your Estimating?</h2>
      <p>Join contractors who are winning more bids and saving hours every week with ProBid AI.</p>
      <div class="cta-buttons">
        <a href="/login" class="btn btn-accent">Start Free Today</a>
        <a href="/checkout?plan=pro" class="btn btn-primary">Get Pro Plan</a>
      </div>
      <div class="guarantee-box">
        <span class="guarantee-icon">🛡️</span>
        <div class="guarantee-text">
          <strong>100% Risk-Free Guarantee</strong>
          <span>7-day money-back guarantee on all paid plans. Cancel anytime.</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="container">
      <p>&copy; ${new Date().getFullYear()} ProBid AI. All rights reserved. <a href="/">Home</a> &middot; <a href="/login">Login</a></p>
    </div>
  </footer>

  <script>
    document.querySelectorAll('.faq-question').forEach(question => {
      question.addEventListener('click', () => {
        const item = question.parentElement;
        const wasActive = item.classList.contains('active');
        document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('active'));
        if (!wasActive) item.classList.add('active');
      });
    });
  </script>
</body>
</html>
  `);
}));

// --- SEO Landing Pages ---
const SEO_PAGES_META: Record<
  string,
  {
    title: string;
    h1: string;
    description: string;
    keywords: string;
    benefits: string[];
  }
> = {
  tuckpointing: {
    title: "Free Tuckpointing Cost Estimator | ProBid AI",
    h1: "Tuckpointing Cost Estimator",
    description:
      "Get instant, accurate tuckpointing estimates. Upload a photo of your brick wall and receive a professional bid in seconds. Free for contractors.",
    keywords:
      "tuckpointing cost, tuckpointing estimate, brick repair cost, mortar repair price, masonry estimate",
    benefits: [
      "Analyze mortar joint condition from photos",
      "Calculate linear feet and labor costs automatically",
      "Regional pricing for Midwest, South, West, Northeast",
      "Professional PDF estimates to share with clients",
    ],
  },
  "chimney-repair": {
    title: "Chimney Repair Cost Calculator | ProBid AI",
    h1: "Chimney Repair Estimate Calculator",
    description:
      "Instant chimney repair and rebuild estimates. AI analyzes your chimney photos and provides accurate bids with material and labor breakdowns.",
    keywords:
      "chimney repair cost, chimney rebuild estimate, chimney crown repair, flashing repair cost",
    benefits: [
      "Assess chimney damage from uploaded photos",
      "Crown, flashing, and rebuild cost breakdowns",
      "Account for height and accessibility factors",
      "Generate client-ready PDF proposals",
    ],
  },
  "retaining-wall": {
    title: "Retaining Wall Cost Estimator | ProBid AI",
    h1: "Retaining Wall Estimate Calculator",
    description:
      "Calculate retaining wall costs instantly. Upload site photos and get accurate estimates for block, stone, and poured concrete walls.",
    keywords:
      "retaining wall cost, retaining wall estimate, block wall price, stone wall estimate, landscape wall cost",
    benefits: [
      "Estimate material needs from site photos",
      "Calculate drainage and reinforcement costs",
      "Compare block, stone, and concrete options",
      "Factor in excavation and backfill labor",
    ],
  },
  "brick-repair": {
    title: "Brick Repair Cost Calculator | ProBid AI",
    h1: "Brick Repair Estimate Calculator",
    description:
      "Get instant brick repair estimates. AI-powered tool analyzes damage photos and calculates replacement, patching, and cleaning costs.",
    keywords:
      "brick repair cost, brick replacement estimate, brick cleaning price, masonry repair cost",
    benefits: [
      "Identify damaged bricks from photos",
      "Calculate replacement vs repair costs",
      "Include matching brick sourcing estimates",
      "Professional estimates in under 30 seconds",
    ],
  },
  "concrete-flatwork": {
    title: "Concrete Flatwork Cost Estimator | ProBid AI",
    h1: "Concrete Flatwork Estimate Calculator",
    description:
      "Instant estimates for driveways, patios, and sidewalks. Upload project photos and get accurate concrete flatwork bids with AI.",
    keywords:
      "concrete driveway cost, patio estimate, sidewalk price, concrete flatwork estimate",
    benefits: [
      "Calculate square footage from descriptions",
      "Include prep, forming, and finishing labor",
      "Factor in reinforcement and thickness options",
      "Regional concrete and labor pricing",
    ],
  },
};

app.get(
  "/estimate/:jobType",
  asyncHandler(async (req, res) => {
    const jobType = req.params.jobType;
    const page = SEO_PAGES_META[jobType];

    if (!page) {
      return res.redirect("/");
    }

    const uid = req.session?.uid;
    const sub = uid ? await getSub(uid) : undefined;
    const paid = isPaidActive(sub);

    const founderNote: { quote: string; name: string; title: string; initials: string } = {
      quote:
        "I built ProBid AI because I was sick of losing my evenings to estimates. After a long day of masonry work, I'd still have hours of measuring, pricing, and typing ahead of me. Now I generate a full estimate from a photo on the drive home.",
      name: "Jesse Kirchner",
      title: "Founder · Kirchner Masonry, Galena, IL",
      initials: "JK",
    };

    const testimonial = founderNote;

    const benefitsList = page.benefits
      .map(
        (b) => `
    <li class="benefit-item">
      <span class="benefit-icon">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
      </span>
      <span>${escapeHtml(b)}</span>
    </li>
  `,
      )
      .join("");

    const relatedEstimators = Object.entries(SEO_PAGES_META)
      .filter(([k]) => k !== jobType)
      .map(
        ([k, v]) => `
      <a href="/estimate/${k}" class="related-card">
        <span class="related-icon">${k === "tuckpointing" ? "🧱" : k === "chimney-repair" ? "🏠" : k === "retaining-wall" ? "🪨" : k === "brick-repair" ? "🔨" : "🚧"}</span>
        <span class="related-title">${escapeHtml((v.h1 || "").replace(" Estimate Calculator", "").replace(" Cost Estimator", ""))}</span>
        <span class="related-arrow">→</span>
      </a>
    `,
      )
      .join("");

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}"/>
  <meta name="keywords" content="${escapeHtml(page.keywords)}"/>
  <meta name="robots" content="index, follow"/>
  <link rel="canonical" href="${APP_URL}/estimate/${jobType}"/>

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(page.title)}"/>
  <meta property="og:description" content="${escapeHtml(page.description)}"/>
  <meta property="og:type" content="website"/>
  <meta property="og:url" content="${APP_URL}/estimate/${jobType}"/>
  <meta property="og:site_name" content="ProBid AI"/>

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${escapeHtml(page.title)}"/>
  <meta name="twitter:description" content="${escapeHtml(page.description)}"/>

  <!-- Schema.org structured data -->
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `ProBid AI - ${page.h1}`,
    description: page.description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  })}
  </script>

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
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
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
      overflow-x: hidden;
    }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .animate-fade-in { animation: fadeInUp 0.8s ease-out forwards; opacity: 0; }
    .animate-delay-1 { animation-delay: 0.1s; }
    .animate-delay-2 { animation-delay: 0.2s; }
    .animate-delay-3 { animation-delay: 0.3s; }
    .animate-delay-4 { animation-delay: 0.4s; }
    .animate-delay-5 { animation-delay: 0.5s; }

    .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }

    /* Navigation */
    .nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      padding: 16px 0;
      background: rgba(10, 14, 26, 0.9);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
    }

    .nav-inner {
      display: flex;
      justify-content: space-between;
      align-items: center;
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

    .nav-links { display: flex; gap: 8px; align-items: center; }

    .nav-link {
      padding: 10px 18px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      transition: all 0.3s ease;
    }

    .nav-link:hover { color: var(--text-primary); background: var(--glass-bg); }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(99, 102, 241, 0.2));
      border: 1px solid var(--border-light);
      font-size: 13px;
      font-weight: 600;
      color: var(--primary-light);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 16px 32px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .btn-primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(79, 70, 229, 0.5);
    }

    .btn-accent {
      color: var(--text-dark);
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 4px 20px rgba(34, 197, 94, 0.3);
    }

    .btn-accent:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(34, 197, 94, 0.4);
    }

    .btn-secondary {
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      backdrop-filter: blur(10px);
    }

    .btn-secondary:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
      transform: translateY(-2px);
    }

    /* Hero Section */
    .hero {
      position: relative;
      min-height: 90vh;
      display: flex;
      align-items: center;
      padding: 140px 0 80px;
      overflow: hidden;
    }

    .hero-bg {
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
    }

    .hero-glow {
      position: absolute;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.25;
    }

    .hero-glow-1 { top: -150px; left: -150px; background: var(--primary); }
    .hero-glow-2 { bottom: -150px; right: -150px; background: #7c3aed; }

    .hero-content {
      position: relative;
      z-index: 10;
      text-align: center;
      max-width: 800px;
      margin: 0 auto;
    }

    .free-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(34, 197, 94, 0.05));
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: var(--accent);
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 24px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .free-badge svg { width: 18px; height: 18px; }

    .hero h1 {
      font-size: clamp(2.25rem, 5vw, 3.5rem);
      font-weight: 900;
      line-height: 1.15;
      margin-bottom: 20px;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 50%, var(--text-primary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .hero-subtitle {
      font-size: clamp(1rem, 2vw, 1.25rem);
      color: var(--text-muted);
      max-width: 600px;
      margin: 0 auto 32px;
      line-height: 1.7;
    }

    .hero-cta-group { display: flex; flex-direction: column; align-items: center; gap: 16px; }

    .hero-buttons { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }

    .pricing-teaser {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      justify-content: center;
      align-items: center;
      margin-top: 8px;
    }

    .pricing-teaser span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .pricing-teaser .highlight {
      color: var(--accent);
      font-weight: 600;
    }

    .trust-mini {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 24px;
      margin-top: 40px;
      padding-top: 32px;
      border-top: 1px solid var(--border-color);
      flex-wrap: wrap;
    }

    .trust-mini-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .trust-mini-item svg { width: 18px; height: 18px; color: var(--accent); }

    /* Section Styles */
    section { padding: 80px 0; }

    .section-header {
      text-align: center;
      max-width: 700px;
      margin: 0 auto 50px;
    }

    .section-label {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid var(--border-light);
      color: var(--primary-light);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .section-title {
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      font-weight: 800;
      margin-bottom: 14px;
      color: var(--text-primary);
    }

    .section-subtitle {
      font-size: 1.05rem;
      color: var(--text-muted);
      line-height: 1.7;
    }

    /* How It Works */
    .how-it-works {
      background: linear-gradient(180deg, var(--bg-dark) 0%, rgba(15, 23, 42, 0.5) 50%, var(--bg-dark) 100%);
    }

    .steps-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      position: relative;
    }

    .steps-grid::before {
      content: '';
      position: absolute;
      top: 50px;
      left: 16.6%;
      right: 16.6%;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--primary-light), var(--accent), transparent);
      opacity: 0.3;
    }

    .step-card {
      position: relative;
      text-align: center;
      padding: 32px 24px;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      transition: all 0.4s ease;
    }

    .step-card:hover {
      transform: translateY(-8px);
      border-color: var(--border-light);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }

    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      color: white;
      font-size: 18px;
      font-weight: 800;
      margin-bottom: 18px;
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .step-icon {
      font-size: 2.5rem;
      margin-bottom: 14px;
      display: block;
      animation: float 3s ease-in-out infinite;
    }

    .step-card:nth-child(2) .step-icon { animation-delay: 0.5s; }
    .step-card:nth-child(3) .step-icon { animation-delay: 1s; }

    .step-title {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 8px;
      color: var(--text-primary);
    }

    .step-desc {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Benefits Section */
    .benefits { background: var(--bg-dark); }

    .benefits-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 60px;
      align-items: center;
    }

    .benefits-content h2 {
      font-size: 2rem;
      font-weight: 800;
      margin-bottom: 24px;
    }

    .benefits-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .benefit-item {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    .benefit-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: rgba(34, 197, 94, 0.15);
      flex-shrink: 0;
      margin-top: 2px;
    }

    .benefit-icon svg {
      width: 16px;
      height: 16px;
      color: var(--accent);
    }

    .benefit-item span:last-child { flex: 1; }

    /* Comparison Section */
    .comparison {
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.3) 0%, var(--bg-dark) 100%);
    }

    .comparison-table {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      overflow: hidden;
      max-width: 900px;
      margin: 0 auto;
    }

    .comparison-header {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      background: rgba(79, 70, 229, 0.1);
      border-bottom: 1px solid var(--border-color);
    }

    .comparison-header div {
      padding: 20px 24px;
      font-weight: 700;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .comparison-header div:first-child { color: var(--text-muted); }
    .comparison-header div:nth-child(2) { text-align: center; color: var(--text-muted); }
    .comparison-header div:nth-child(3) { text-align: center; color: var(--accent); background: rgba(34, 197, 94, 0.05); }

    .comparison-row {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      border-bottom: 1px solid var(--border-color);
    }

    .comparison-row:last-child { border-bottom: none; }

    .comparison-row div {
      padding: 18px 24px;
      font-size: 14px;
    }

    .comparison-row div:first-child { color: var(--text-primary); }
    .comparison-row div:nth-child(2),
    .comparison-row div:nth-child(3) { text-align: center; }

    .check-icon { color: var(--accent); font-size: 18px; }
    .x-icon { color: #ef4444; font-size: 18px; }
    .muted-text { color: var(--text-muted); }

    /* Testimonial */
    .testimonial-section {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.05) 0%, rgba(34, 197, 94, 0.03) 100%);
    }

    .testimonial-card {
      max-width: 800px;
      margin: 0 auto;
      padding: 48px;
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      text-align: center;
    }

    .testimonial-stars {
      color: #fbbf24;
      font-size: 1.5rem;
      margin-bottom: 24px;
    }

    .testimonial-quote {
      font-size: 1.25rem;
      color: var(--text-primary);
      line-height: 1.8;
      font-style: italic;
      margin-bottom: 32px;
    }

    .testimonial-author {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
    }

    .testimonial-avatar {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 20px;
      color: white;
    }

    .testimonial-info { text-align: left; }
    .testimonial-info h4 { font-size: 16px; font-weight: 700; color: var(--text-primary); }
    .testimonial-info p { font-size: 14px; color: var(--text-muted); }

    .trust-stats {
      display: flex;
      justify-content: center;
      gap: 48px;
      margin-top: 48px;
      padding-top: 32px;
      border-top: 1px solid var(--border-color);
      flex-wrap: wrap;
    }

    .stat-item { text-align: center; }

    .stat-number {
      font-size: 2rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--primary-light) 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stat-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }

    /* Related Estimators */
    .related { background: var(--bg-dark); }

    .related-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }

    .related-card {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 20px 24px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      text-decoration: none;
      transition: all 0.3s ease;
    }

    .related-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-light);
      background: var(--bg-card-hover);
    }

    .related-icon { font-size: 1.75rem; }
    .related-title { flex: 1; font-weight: 600; color: var(--text-primary); font-size: 15px; }
    .related-arrow { color: var(--primary-light); font-size: 18px; font-weight: 700; }

    /* Final CTA */
    .final-cta {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.12) 0%, rgba(34, 197, 94, 0.08) 100%);
      text-align: center;
      padding: 100px 0;
    }

    .final-cta h2 {
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      font-weight: 800;
      margin-bottom: 16px;
    }

    .final-cta p {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 32px;
      max-width: 550px;
      margin-left: auto;
      margin-right: auto;
    }

    .final-cta .btn { padding: 18px 40px; font-size: 18px; }

    .guarantee-box {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      margin-top: 32px;
      padding: 18px 28px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 14px;
    }

    .guarantee-icon { font-size: 2.25rem; }

    .guarantee-text { text-align: left; }
    .guarantee-text strong { display: block; color: var(--accent); font-size: 15px; }
    .guarantee-text span { font-size: 13px; color: var(--text-muted); }

    /* Footer */
    .footer {
      background: var(--bg-darker);
      padding: 60px 0 32px;
      border-top: 1px solid var(--border-color);
    }

    .footer-inner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 24px;
    }

    .footer-brand .logo { font-size: 1.5rem; margin-bottom: 8px; display: inline-block; }
    .footer-brand p { color: var(--text-muted); font-size: 14px; }

    .footer-links {
      display: flex;
      gap: 32px;
      flex-wrap: wrap;
    }

    .footer-links a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 14px;
      transition: color 0.3s ease;
    }

    .footer-links a:hover { color: var(--primary-light); }

    .footer-bottom {
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid var(--border-color);
      text-align: center;
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Responsive */
    @media (max-width: 1024px) {
      .steps-grid { grid-template-columns: repeat(3, 1fr); }
      .steps-grid::before { display: none; }
      .benefits-grid { grid-template-columns: 1fr; gap: 40px; }
    }

    @media (max-width: 768px) {
      .nav-links { gap: 4px; }
      .nav-link { padding: 8px 12px; font-size: 13px; }
      .steps-grid { grid-template-columns: 1fr; gap: 16px; }
      .hero-buttons { flex-direction: column; width: 100%; }
      .hero-buttons .btn { width: 100%; justify-content: center; }
      .trust-mini { flex-direction: column; gap: 12px; }
      .comparison-header, .comparison-row { grid-template-columns: 1.5fr 1fr 1fr; }
      .comparison-header div, .comparison-row div { padding: 14px 12px; font-size: 12px; }
      .testimonial-card { padding: 32px 24px; }
      .testimonial-quote { font-size: 1.05rem; }
      .trust-stats { gap: 32px; }
      .footer-inner { flex-direction: column; text-align: center; }
      .footer-links { justify-content: center; }
      section { padding: 60px 0; }
    }

    @media (max-width: 480px) {
      .container { padding: 0 16px; }
      .hero h1 { font-size: 1.85rem; }
      .section-title { font-size: 1.5rem; }
      .pricing-teaser { flex-direction: column; gap: 8px; }
      .pricing-teaser span:nth-child(2) { display: none; }
      .stat-number { font-size: 1.5rem; }
      .related-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <!-- Navigation -->
  <nav class="nav">
    <div class="container nav-inner">
      <a href="/" class="logo">ProBid AI</a>
      <div class="nav-links">
        ${uid ? `<span class="pill">${escapeHtml(req.session?.email || "user")}</span>` : ""}
        <a href="/pricing" class="nav-link">Pricing</a>
        ${uid ? `<a href="/app" class="btn btn-primary" style="padding:10px 20px;font-size:14px;">Open App</a>` : `<a href="/login" class="nav-link">Login</a>`}
        ${uid ? `<a href="/logout" class="nav-link">Logout</a>` : `<a href="/login" class="btn btn-primary" style="padding:10px 20px;font-size:14px;">Get Started</a>`}
        ${uid && paid ? `<a href="/billing" class="nav-link">Billing</a>` : ""}
      </div>
    </div>
  </nav>

  <!-- Hero Section -->
  <section class="hero">
    <div class="hero-bg"></div>
    <div class="hero-glow hero-glow-1"></div>
    <div class="hero-glow hero-glow-2"></div>
    <div class="container">
      <div class="hero-content">
        <div class="free-badge animate-fade-in">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>
          FREE TOOL
        </div>
        <h1 class="animate-fade-in animate-delay-1">${escapeHtml(page.h1)}</h1>
        <p class="hero-subtitle animate-fade-in animate-delay-2">${escapeHtml(page.description)}</p>
        <div class="hero-cta-group animate-fade-in animate-delay-3">
          <div class="hero-buttons">
            <a href="/login" class="btn btn-accent">Get Your Free Estimate →</a>
            <a href="/pricing" class="btn btn-secondary">View Pricing</a>
          </div>
          <div class="pricing-teaser">
            <span><span class="highlight">3 free estimates</span></span>
            <span>|</span>
            <span>Plans from <span class="highlight">$25/mo</span></span>
            <span>|</span>
            <span>No credit card required</span>
          </div>
        </div>

        <div class="trust-mini animate-fade-in animate-delay-4">
          <div class="trust-mini-item">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            <span>Built for contractors nationwide</span>
          </div>
          <div class="trust-mini-item">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            <span>7-day money-back guarantee</span>
          </div>
          <div class="trust-mini-item">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            <span>Cancel anytime</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- How It Works -->
  <section class="how-it-works">
    <div class="container">
      <div class="section-header">
        <span class="section-label">How It Works</span>
        <h2 class="section-title">Professional Estimates in 3 Simple Steps</h2>
        <p class="section-subtitle">Our AI-powered workflow makes estimating faster and more accurate than ever.</p>
      </div>

      <div class="steps-grid">
        <div class="step-card animate-fade-in">
          <span class="step-number">1</span>
          <span class="step-icon">📷</span>
          <h3 class="step-title">Upload Photo</h3>
          <p class="step-desc">Take a picture of the job site. Our AI analyzes the scope, materials, and conditions instantly.</p>
        </div>
        <div class="step-card animate-fade-in animate-delay-1">
          <span class="step-number">2</span>
          <span class="step-icon">🤖</span>
          <h3 class="step-title">AI Analysis</h3>
          <p class="step-desc">GPT-4o Vision evaluates the work, calculates materials, and applies regional pricing.</p>
        </div>
        <div class="step-card animate-fade-in animate-delay-2">
          <span class="step-number">3</span>
          <span class="step-icon">📄</span>
          <h3 class="step-title">Get Estimate</h3>
          <p class="step-desc">Receive a detailed, professional PDF estimate ready to share with your client.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Benefits Section -->
  <section class="benefits">
    <div class="container">
      <div class="benefits-grid">
        <div class="benefits-content">
          <span class="section-label">Why Contractors Choose Us</span>
          <h2>Built for ${escapeHtml(page.h1.replace(" Estimate Calculator", "").replace(" Cost Estimator", ""))} Professionals</h2>
          <ul class="benefits-list">
            ${benefitsList}
            <li class="benefit-item">
              <span class="benefit-icon">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              </span>
              <span><strong>Save hours</strong> — Stop guessing, get accurate bids in seconds</span>
            </li>
            <li class="benefit-item">
              <span class="benefit-icon">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              </span>
              <span><strong>Win more jobs</strong> — Professional estimates impress clients</span>
            </li>
          </ul>
        </div>
        <div class="testimonial-card" style="padding: 32px;">
          <p class="testimonial-quote" style="font-size: 1rem;">"${escapeHtml(testimonial.quote)}"</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar">${testimonial.initials}</div>
            <div class="testimonial-info">
              <h4>${escapeHtml(testimonial.name)}</h4>
              <p>${escapeHtml(testimonial.title)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Comparison Section -->
  <section class="comparison">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Comparison</span>
        <h2 class="section-title">ProBid AI vs Manual Estimating</h2>
        <p class="section-subtitle">See why contractors are switching to AI-powered estimates.</p>
      </div>

      <div class="comparison-table">
        <div class="comparison-header">
          <div>Feature</div>
          <div>Manual Estimating</div>
          <div>ProBid AI</div>
        </div>
        <div class="comparison-row">
          <div>Time per estimate</div>
          <div class="muted-text">30-60 minutes</div>
          <div><strong>Under 1 minute</strong></div>
        </div>
        <div class="comparison-row">
          <div>Photo analysis</div>
          <div><span class="x-icon">✕</span></div>
          <div><span class="check-icon">✓</span></div>
        </div>
        <div class="comparison-row">
          <div>Regional pricing</div>
          <div class="muted-text">Manual research</div>
          <div><span class="check-icon">✓</span> Built-in</div>
        </div>
        <div class="comparison-row">
          <div>Professional PDFs</div>
          <div class="muted-text">Extra software</div>
          <div><span class="check-icon">✓</span> Included</div>
        </div>
        <div class="comparison-row">
          <div>Material calculations</div>
          <div class="muted-text">Manual math</div>
          <div><span class="check-icon">✓</span> Automatic</div>
        </div>
        <div class="comparison-row">
          <div>Accuracy</div>
          <div class="muted-text">Varies by experience</div>
          <div><strong>Consistent AI accuracy</strong></div>
        </div>
      </div>
    </div>
  </section>

  <!-- Trust Stats Section -->
  <section class="testimonial-section">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Trusted Nationwide</span>
        <h2 class="section-title">Built by a Working Contractor</h2>
      </div>

      <div class="trust-stats" style="border-top: none; margin-top: 0; padding-top: 0;">
        <div class="stat-item">
          <div class="stat-number">AI-Powered</div>
          <div class="stat-label">GPT-4o Vision</div>
        </div>
        <div class="stat-item">
          <div class="stat-number">Seconds</div>
          <div class="stat-label">Not Hours</div>
        </div>
        <div class="stat-item">
          <div class="stat-number">Free</div>
          <div class="stat-label">3 Free Estimates</div>
        </div>
        <div class="stat-item">
          <div class="stat-number">PDF Ready</div>
          <div class="stat-label">Send to Clients</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Related Estimators -->
  <section class="related">
    <div class="container">
      <div class="section-header">
        <span class="section-label">Explore More</span>
        <h2 class="section-title">Other Estimator Tools</h2>
        <p class="section-subtitle">ProBid AI supports a wide range of construction trades.</p>
      </div>

      <div class="related-grid">
        ${relatedEstimators}
      </div>
    </div>
  </section>

  <!-- Final CTA -->
  <section class="final-cta">
    <div class="container">
      <h2 class="animate-fade-in">Ready to Transform Your Estimating?</h2>
      <p class="animate-fade-in animate-delay-1">Join contractors who are winning more jobs with faster, more accurate AI-powered estimates.</p>
      <a href="/login" class="btn btn-accent animate-fade-in animate-delay-2">Start Free - No Credit Card →</a>
      
      <div class="guarantee-box animate-fade-in animate-delay-3">
        <span class="guarantee-icon">🛡️</span>
        <div class="guarantee-text">
          <strong>7-Day Money-Back Guarantee</strong>
          <span>Not satisfied? Get a full refund, no questions asked.</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="container">
      <div class="footer-inner">
        <div class="footer-brand">
          <a href="/" class="logo">ProBid AI</a>
          <p>AI-powered construction estimates</p>
        </div>
        <div class="footer-links">
          <a href="/">Home</a>
          <a href="/pricing">Pricing</a>
          <a href="/login">Login</a>
          ${Object.keys(SEO_PAGES_META)
            .map(
              (k) =>
                `<a href="/estimate/${k}">${k.charAt(0).toUpperCase() + k.slice(1).replace("-", " ")}</a>`,
            )
            .join("")}
        </div>
      </div>
      <div class="footer-bottom">
        <p>&copy; ${new Date().getFullYear()} ProBid AI. All rights reserved.</p>
      </div>
    </div>
  </footer>

  <script>
    document.querySelectorAll('.animate-fade-in').forEach((el, i) => {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.style.animationPlayState = 'running';
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1 });
      el.style.animationPlayState = 'paused';
      observer.observe(el);
    });
  </script>
</body>
</html>
  `);
  }),
);

app.get("/login", (req, res) => {
  const refCode = req.query.ref ? String(req.query.ref).trim() : "";
  const utmSource = req.query.utm_source
    ? String(req.query.utm_source).trim()
    : "";
  const utmMedium = req.query.utm_medium
    ? String(req.query.utm_medium).trim()
    : "";
  const utmCampaign = req.query.utm_campaign
    ? String(req.query.utm_campaign).trim()
    : "";

  const refBadge = refCode
    ? `
      <div class="referral-badge" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 16px; border-radius: 999px; background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.25); color: var(--primary-light); font-size: 13px; font-weight: 600; margin-bottom: 16px;">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>
        You were referred by a ProBid member
      </div>
  `
    : "";
  const refHiddenField = refCode
    ? `<input type="hidden" name="ref" value="${refCode.replace(/"/g, "&quot;")}" />`
    : "";
  const utmHiddenFields = `
    ${utmSource ? `<input type="hidden" name="utm_source" value="${utmSource.replace(/"/g, "&quot;")}" />` : ""}
    ${utmMedium ? `<input type="hidden" name="utm_medium" value="${utmMedium.replace(/"/g, "&quot;")}" />` : ""}
    ${utmCampaign ? `<input type="hidden" name="utm_campaign" value="${utmCampaign.replace(/"/g, "&quot;")}" />` : ""}
  `;
  res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <meta name="description" content="Login to ProBid AI - Generate professional construction estimates in seconds."/>
  <title>Login - ProBid AI</title>
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
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
      --text-dark: #0b0f19;
      --glass-bg: rgba(255, 255, 255, 0.05);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-6px); }
    }

    body {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow-x: hidden;
      position: relative;
    }

    .bg-animated {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
      z-index: 0;
    }

    .glow {
      position: fixed;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.25;
      pointer-events: none;
    }

    .glow-1 { width: 500px; height: 500px; top: -150px; left: -150px; background: var(--primary); }
    .glow-2 { width: 400px; height: 400px; bottom: -100px; right: -100px; background: #7c3aed; }

    .container {
      position: relative;
      z-index: 10;
      width: 100%;
      max-width: 460px;
      padding: 24px;
      animation: fadeInUp 0.6s ease-out;
    }

    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 24px;
      transition: color 0.3s ease;
    }

    .back-link:hover { color: var(--text-primary); }

    .back-link svg { width: 16px; height: 16px; }

    .login-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }

    .logo {
      font-size: 1.75rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-align: center;
      margin-bottom: 8px;
    }

    .tagline {
      text-align: center;
      color: var(--text-muted);
      font-size: 15px;
      margin-bottom: 32px;
    }

    .trust-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.25);
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 28px;
    }

    .trust-badge svg { width: 16px; height: 16px; }

    .form-group { margin-bottom: 20px; }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .form-input {
      width: 100%;
      padding: 16px 18px;
      border-radius: 14px;
      border: 1px solid var(--border-color);
      background: rgba(11, 15, 25, 0.7);
      color: var(--text-primary);
      font-size: 16px;
      font-family: inherit;
      transition: all 0.3s ease;
    }

    .form-input::placeholder { color: var(--text-muted); opacity: 0.7; }

    .form-input:focus {
      outline: none;
      border-color: var(--primary-light);
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
    }

    .btn-primary {
      display: block;
      width: 100%;
      padding: 16px 24px;
      border-radius: 14px;
      border: none;
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      font-size: 16px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(79, 70, 229, 0.5);
    }

    .magic-link-note {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-top: 20px;
      padding: 14px 16px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: 12px;
    }

    .magic-link-note svg {
      width: 20px;
      height: 20px;
      color: var(--primary-light);
      flex-shrink: 0;
      margin-top: 1px;
    }

    .magic-link-note p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .divider {
      display: flex;
      align-items: center;
      gap: 16px;
      margin: 28px 0;
      color: var(--text-muted);
      font-size: 13px;
    }

    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-color);
    }

    .benefits-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 14px;
      text-align: center;
    }

    .benefits-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .benefits-list li {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .benefits-list li svg {
      width: 18px;
      height: 18px;
      color: var(--accent);
      flex-shrink: 0;
    }

    .footer-note {
      text-align: center;
      margin-top: 24px;
      font-size: 13px;
      color: var(--text-muted);
    }

    .footer-note a {
      color: var(--primary-light);
      text-decoration: none;
      font-weight: 600;
    }

    .footer-note a:hover { text-decoration: underline; }

    @media (max-width: 480px) {
      .container { padding: 16px; }
      .login-card { padding: 32px 24px; }
      .logo { font-size: 1.5rem; }
    }
  </style>
</head>
<body>
  <div class="bg-animated"></div>
  <div class="glow glow-1"></div>
  <div class="glow glow-2"></div>

  <div class="container">
    <a href="/" class="back-link">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
      Back to Home
    </a>

    <div class="login-card">
      <div class="logo">ProBid AI</div>
      <p class="tagline">Generate professional estimates in seconds</p>

      <div class="trust-badge">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
        Built for contractors nationwide
      </div>

      ${refBadge}

      <form method="POST" action="/login" id="loginForm">
        ${refHiddenField}
        ${utmHiddenFields}
        <div class="form-group">
          <label class="form-label">Email Address</label>
          <input type="email" name="email" id="emailInput" class="form-input" placeholder="you@company.com" required autocomplete="email" />
        </div>

        <button type="submit" class="btn-primary" id="submitBtn">Continue &rarr;</button>

        <div class="magic-link-note">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          <p><strong>No password required.</strong> We'll create your account instantly - just enter your email and start estimating.</p>
        </div>
      </form>

      <div class="divider">Why ProBid?</div>

      <ul class="benefits-list">
        <li>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          AI-powered estimates in seconds, not hours
        </li>
        <li>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          Professional PDF proposals ready to send
        </li>
        <li>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          3 free estimates - no credit card
        </li>
        <li>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          Built for contractors nationwide
        </li>
      </ul>

      <p class="footer-note">
        Questions? <a href="/">Learn more about ProBid AI</a>
      </p>
    </div>
  </div>
</body>
</html>
  `);
});

app.post(
  "/login",
  asyncHandler(async (req, res) => {
    log("info", "Login attempt started", { body: req.body });

    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      log("warn", "Login validation failed", {
        error: parseResult.error.issues[0].message,
      });
      return res
        .status(400)
        .json({ error: parseResult.error.issues[0].message });
    }
    const email = parseResult.data.email.trim().toLowerCase();
    const refCode = parseResult.data.ref ? parseResult.data.ref.trim() : "";
    const utmSource = parseResult.data.utm_source
      ? parseResult.data.utm_source.trim()
      : "";
    const utmMedium = parseResult.data.utm_medium
      ? parseResult.data.utm_medium.trim()
      : "";
    const utmCampaign = parseResult.data.utm_campaign
      ? parseResult.data.utm_campaign.trim()
      : "";

    log("info", "Looking up user", { email });

    // upsert user
    let userResult;
    try {
      userResult = await db.select().from(users).where(eq(users.email, email));
    } catch (dbErr: any) {
      log("error", "Database error looking up user", {
        error: dbErr.message,
        stack: dbErr.stack,
      });
      throw dbErr;
    }

    let user = userResult[0];
    const isNewUser = !user;
    if (!user) {
      const uid = crypto.randomUUID();
      log("info", "Creating new user", { uid, email });
      try {
        await db
          .insert(users)
          .values({ id: uid, email: email, createdAt: now() });
      } catch (insertErr: any) {
        log("error", "Database error inserting user", {
          error: insertErr.message,
          stack: insertErr.stack,
        });
        throw insertErr;
      }
      user = { id: uid, email };

      const signupData: Record<string, any> = { email };
      if (refCode) signupData.ref = refCode;
      if (utmSource) signupData.utm_source = utmSource;
      if (utmMedium) signupData.utm_medium = utmMedium;
      if (utmCampaign) signupData.utm_campaign = utmCampaign;

      try {
        await trackEvent("signup", uid, signupData);
      } catch (trackErr: any) {
        log("error", "Error tracking signup event", {
          error: trackErr.message,
        });
      }

      // Attribute referral if ref code is provided
      if (refCode) {
        await attributeReferral(uid, refCode);
      }

      // Send welcome email (async, don't block login flow)
      sendWelcomeEmail(email).catch(() => {});
      enqueueOnboardingSequence(email, uid).catch(() => {});
    } else {
      log("info", "Existing user login", { userId: user.id });
      try {
        await trackEvent("login", user.id);
      } catch (trackErr: any) {
        log("error", "Error tracking login event", { error: trackErr.message });
      }
    }

    req.session!.uid = user.id;
    req.session!.email = user.email;
    req.session!.csrfToken = generateCsrfToken();
    log("info", "Login successful, redirecting to /app", { userId: user.id });
    return res.redirect("/app");
  }),
);

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/");
});

// --- Marketing Kit Page ---
app.get(
  "/marketing-kit",
  asyncHandler(async (req, res) => {
    const uid = req.session?.uid;
    let affiliateLink = "";
    let affiliateCode = "";

    if (uid) {
      affiliateCode = await ensureAffiliateCode(uid);
      affiliateLink = `${APP_URL}/r/${affiliateCode}`;
    }

    // Get some real stats
    const totalUsersResult = await db.select({ c: count() }).from(users);
    const totalUsers = totalUsersResult[0]?.c || 2500;

    const totalEstimatesResult = await db
      .select({ c: count() })
      .from(estimates);
    const totalEstimates = totalEstimatesResult[0]?.c || 10000;

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <meta name="description" content="ProBid AI Marketing Kit - Ready-to-use social media posts, email templates, and promotional materials for affiliates and partners."/>
  <title>Marketing Kit - ProBid AI</title>
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
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
      --text-dark: #0b0f19;
      --glass-bg: rgba(255, 255, 255, 0.05);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      line-height: 1.6;
    }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .hero-bg {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
      z-index: 0;
    }

    .nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      padding: 16px 0;
      background: rgba(10, 14, 26, 0.8);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
    }

    .nav-inner {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
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

    .nav-links { display: flex; gap: 8px; align-items: center; }

    .nav-link {
      padding: 10px 18px;
      border-radius: 10px;
      text-decoration: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      transition: all 0.3s ease;
    }

    .nav-link:hover { color: var(--text-primary); background: var(--glass-bg); }

    .container {
      position: relative;
      z-index: 10;
      max-width: 1000px;
      margin: 0 auto;
      padding: 120px 24px 80px;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 2.5rem);
      font-weight: 900;
      margin-bottom: 12px;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-light) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .subtitle {
      color: var(--text-muted);
      font-size: 1.1rem;
      margin-bottom: 48px;
    }

    h2 {
      font-size: 1.4rem;
      font-weight: 700;
      margin: 48px 0 20px;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    h2::before {
      content: '';
      width: 4px;
      height: 24px;
      background: linear-gradient(180deg, var(--primary), var(--accent));
      border-radius: 2px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 48px;
    }

    .stat-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      text-align: center;
    }

    .stat-value {
      font-size: 2.5rem;
      font-weight: 800;
      color: var(--accent);
    }

    .stat-label {
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 4px;
    }

    .content-grid {
      display: grid;
      gap: 20px;
    }

    .content-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      transition: all 0.3s ease;
    }

    .content-card:hover {
      border-color: var(--border-light);
    }

    .content-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--primary-light);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .content-label svg {
      width: 18px;
      height: 18px;
    }

    .content-text {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 16px;
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.7;
      white-space: pre-wrap;
    }

    .copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 12px;
      padding: 8px 16px;
      border-radius: 8px;
      background: var(--glass-bg);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .copy-btn:hover {
      border-color: var(--primary);
      color: var(--text-primary);
      background: rgba(79, 70, 229, 0.1);
    }

    .copy-btn svg {
      width: 14px;
      height: 14px;
    }

    .affiliate-section {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.15), rgba(34, 197, 94, 0.1));
      border: 1px solid var(--border-light);
      border-radius: 20px;
      padding: 32px;
      margin-top: 48px;
    }

    .affiliate-section h3 {
      font-size: 1.2rem;
      font-weight: 700;
      margin-bottom: 12px;
      color: var(--text-primary);
    }

    .affiliate-section p {
      color: var(--text-muted);
      margin-bottom: 20px;
    }

    .affiliate-input-group {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .affiliate-input {
      flex: 1;
      min-width: 250px;
      padding: 14px 18px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      font-size: 14px;
      font-family: 'SF Mono', Monaco, monospace;
    }

    .affiliate-input:focus {
      outline: none;
      border-color: var(--primary);
    }

    .btn-primary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 24px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      border: none;
      color: white;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .login-cta {
      text-align: center;
      padding: 32px;
      background: var(--bg-card);
      border-radius: 16px;
      border: 1px solid var(--border-color);
      margin-top: 48px;
    }

    .login-cta p {
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    .login-cta a {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 28px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      color: white;
      text-decoration: none;
      font-weight: 600;
      transition: all 0.3s ease;
    }

    .login-cta a:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    @media (max-width: 640px) {
      .container { padding: 100px 16px 60px; }
      h1 { font-size: 1.75rem; }
      .affiliate-input-group { flex-direction: column; }
      .affiliate-input { min-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="hero-bg"></div>

  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="logo">ProBid AI</a>
      <div class="nav-links">
        <a href="/pricing" class="nav-link">Pricing</a>
        ${uid ? '<a href="/app" class="nav-link">Dashboard</a>' : '<a href="/login" class="nav-link">Login</a>'}
      </div>
    </div>
  </nav>

  <div class="container">
    <h1>Marketing Kit</h1>
    <p class="subtitle">Ready-to-use content to help you promote ProBid AI. Copy, customize, and share!</p>

    <h2>Key Stats</h2>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">AI-Powered</div>
        <div class="stat-label">GPT-4o Vision</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">30s</div>
        <div class="stat-label">Average Estimate Time</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">Free</div>
        <div class="stat-label">3 Lifetime Estimates</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">20%</div>
        <div class="stat-label">Affiliate Commission</div>
      </div>
    </div>

    <h2>Share This Link</h2>
    <div class="content-card" style="margin-bottom: 32px;">
      <div class="content-label">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
        Your Link
      </div>
      <div class="content-text" id="share-url" style="font-size: 1.1rem; font-weight: 600; color: var(--primary-light);">https://probidcore.net</div>
      <button class="copy-btn" onclick="copyContent('share-url')">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
        Copy
      </button>
    </div>

    <h2>Social Media Posts</h2>
    <div class="content-grid">
      <div class="content-card">
        <div class="content-label">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
          Twitter / X
        </div>
        <div class="content-text" id="twitter-post">🚀 Just discovered ProBid AI - it creates professional construction estimates in 30 seconds using AI.

No more spending hours on spreadsheets. Just describe the job and get an instant, detailed estimate ready to send to clients.

3 free estimates to start. Game changer for contractors! 🏗️

👉 https://probidcore.net</div>
        <button class="copy-btn" onclick="copyContent('twitter-post')">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy
        </button>
      </div>

      <div class="content-card">
        <div class="content-label">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"/></svg>
          Facebook
        </div>
        <div class="content-text" id="facebook-post">Fellow contractors - are you still spending hours creating estimates? 📋

I've been using ProBid AI and it's completely changed how I quote jobs. You describe the project, and AI generates a professional, detailed estimate in about 30 seconds.

It includes labor, materials, profit margins, and looks polished enough to send directly to clients. They even have a PDF export.

Best part? You get 3 free estimates to try it out. No credit card needed.

Check it out if you're tired of the estimate grind! 🏗️💪

👉 https://probidcore.net</div>
        <button class="copy-btn" onclick="copyContent('facebook-post')">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy
        </button>
      </div>

      <div class="content-card">
        <div class="content-label">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
          LinkedIn
        </div>
        <div class="content-text" id="linkedin-post">The construction industry is finally getting AI tools that actually work.

I've been testing ProBid AI for estimate generation, and the results have been impressive:

✅ Generates detailed estimates in ~30 seconds
✅ Accounts for local market rates
✅ Professional PDF output ready for clients
✅ Tracks leads and estimate history

For contractors who spend hours on quotes, this is a significant productivity gain. The free tier (3 lifetime estimates) is enough to evaluate whether it fits your workflow.

Worth a look if you're exploring AI tools for construction businesses.

👉 https://probidcore.net</div>
        <button class="copy-btn" onclick="copyContent('linkedin-post')">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy
        </button>
      </div>

      <div class="content-card">
        <div class="content-label">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"/></svg>
          Reddit
        </div>
        <div class="content-text" id="reddit-post">For those of you spending hours on estimates...

Found this tool called ProBid AI that uses AI to generate construction estimates. You describe the job (retaining wall, kitchen remodel, etc.) and your market, and it spits out a detailed estimate with labor, materials, and profit margins.

Not affiliated, just been using it for a few weeks. The estimates are surprisingly accurate for my area. They give you 3 free estimates, so you can try it without paying anything.

Curious if anyone else has tried it or similar tools?

Link: https://probidcore.net</div>
        <button class="copy-btn" onclick="copyContent('reddit-post')">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy
        </button>
      </div>
    </div>

    <h2>Email Templates</h2>
    <div class="content-grid">
      <div class="content-card">
        <div class="content-label">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
          Introduction Email
        </div>
        <div class="content-text" id="email-intro">Subject: Cut your estimate time by 90% 📋

Hey [Name],

Quick question - how long do you typically spend creating estimates for clients?

I used to spend 2-3 hours per estimate. Now I'm doing them in under a minute.

I've been using this AI tool called ProBid AI. You basically describe the job and your market, and it generates a professional estimate with accurate labor and material costs.

The best part? You can try it free - they give you 3 estimates at no cost, no credit card needed.

Worth checking out: [Your Link]

Let me know if you try it!

[Your Name]</div>
        <button class="copy-btn" onclick="copyContent('email-intro')">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy
        </button>
      </div>

      <div class="content-card">
        <div class="content-label">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
          Follow-up Email
        </div>
        <div class="content-text" id="email-followup">Subject: Still doing estimates the old way?

Hey [Name],

I know you mentioned struggling with the time estimates take. Wanted to follow up about that AI tool I mentioned - ProBid AI.

A few things I've noticed since using it:

• Estimates that used to take 2 hours now take 2 minutes
• The pricing is actually accurate for my local market
• Clients comment on how professional the proposals look
• I can respond to leads same-day instead of losing them

They have a free tier if you want to test it out: [Your Link]

Happy to show you how I use it if you're interested.

[Your Name]</div>
        <button class="copy-btn" onclick="copyContent('email-followup')">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy
        </button>
      </div>
    </div>

    ${
      uid
        ? `
    <div class="affiliate-section">
      <h3>Your Affiliate Link</h3>
      <p>Share this link to earn 20% commission on any paid subscriptions. Your code: <strong>${affiliateCode}</strong></p>
      <div class="affiliate-input-group">
        <input type="text" class="affiliate-input" id="affiliate-link" value="${affiliateLink}" readonly />
        <button class="btn-primary" onclick="copyAffiliateLink()">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          Copy Link
        </button>
      </div>
    </div>
    `
        : `
    <div class="login-cta">
      <p>Log in to get your unique affiliate link and earn 20% commission on referrals!</p>
      <a href="/login">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"/></svg>
        Log In to Get Your Affiliate Link
      </a>
    </div>
    `
    }
  </div>

  <script>
    function copyContent(elementId) {
      const text = document.getElementById(elementId).innerText;
      navigator.clipboard.writeText(text).then(() => {
        const btn = event.target.closest('.copy-btn');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Copied!';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 2000);
      });
    }

    function copyAffiliateLink() {
      const input = document.getElementById('affiliate-link');
      navigator.clipboard.writeText(input.value).then(() => {
        const btn = event.target.closest('.btn-primary');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Copied!';
        setTimeout(() => {
          btn.innerHTML = originalText;
        }, 2000);
      });
    }
  </script>
</body>
</html>
  `);
  }),
);

// --- App (Gated) ---
app.get(
  "/app",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const user = await getUser(uid);
    const showOnboarding = user && !user.hasSeenOnboarding;
    const sub = await getSub(uid);
    const paid = isPaidActive(sub);
    const used = await getTotalEstimates(uid);
    const remaining = Math.max(0, FREE_ESTIMATES_LIFETIME - used);
    const totalEstimatesCount = used;
    const usagePercent = paid
      ? 100
      : Math.round((used / FREE_ESTIMATES_LIFETIME) * 100);

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>Dashboard - ProBid AI</title>
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

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .animate-fade-in { animation: fadeInUp 0.5s ease-out forwards; }
    .animate-delay-1 { animation-delay: 0.1s; opacity: 0; }
    .animate-delay-2 { animation-delay: 0.2s; opacity: 0; }
    .animate-delay-3 { animation-delay: 0.3s; opacity: 0; }

    /* Dashboard Header */
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

    /* Main Container */
    .main-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    /* Welcome Section */
    .welcome-section {
      margin-bottom: 32px;
    }

    .welcome-title {
      font-size: 2rem;
      font-weight: 800;
      margin-bottom: 8px;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .welcome-subtitle {
      color: var(--text-muted);
      font-size: 16px;
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
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

    .stat-icon.usage { background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(79, 70, 229, 0.2)); }
    .stat-icon.total { background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2)); }
    .stat-icon.plan { background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(251, 191, 36, 0.2)); }

    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 800;
      color: var(--text-primary);
      margin-bottom: 8px;
    }

    .stat-subtext {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Progress Bar */
    .progress-bar {
      height: 8px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      overflow: hidden;
      margin-top: 12px;
    }

    .progress-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.5s ease;
    }

    .progress-fill.low { background: linear-gradient(90deg, var(--accent), var(--accent-dark)); }
    .progress-fill.medium { background: linear-gradient(90deg, var(--warning), #d97706); }
    .progress-fill.high { background: linear-gradient(90deg, var(--danger), #dc2626); }

    /* Quick Actions */
    .quick-actions {
      display: flex;
      gap: 12px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 24px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }

    .action-btn.primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
    }

    .action-btn.primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4);
    }

    .action-btn.secondary {
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
    }

    .action-btn.secondary:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
    }

    .action-btn.accent {
      color: var(--text-dark);
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 4px 16px rgba(34, 197, 94, 0.3);
    }

    .action-btn.accent:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(34, 197, 94, 0.4);
    }

    /* Upgrade Banner */
    .upgrade-banner {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.15), rgba(34, 197, 94, 0.1));
      border: 1px solid var(--border-light);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
    }

    .upgrade-content h3 {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 4px;
      color: var(--text-primary);
    }

    .upgrade-content p {
      color: var(--text-muted);
      font-size: 14px;
    }

    .upgrade-actions {
      display: flex;
      gap: 12px;
    }

    /* Main Card */
    .main-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      overflow: hidden;
    }

    .card-header {
      padding: 24px 28px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .card-title {
      font-size: 1.5rem;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .card-title-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .card-subtitle {
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 4px;
    }

    .card-body {
      padding: 28px;
    }

    /* Form Sections */
    .form-section {
      margin-bottom: 28px;
    }

    .form-section:last-child {
      margin-bottom: 0;
    }

    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary-light);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-divider {
      flex: 1;
      height: 1px;
      background: var(--border-color);
    }

    /* Form Grid */
    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
    }

    .form-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .form-label .optional {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 400;
    }

    .form-input,
    .form-select,
    .form-textarea {
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
    .form-select:focus,
    .form-textarea:focus {
      outline: none;
      border-color: var(--primary-light);
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
    }

    .form-input::placeholder,
    .form-textarea::placeholder {
      color: rgba(148, 163, 184, 0.6);
    }

    .form-select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 16px center;
      background-size: 16px;
      padding-right: 48px;
    }

    .form-select option {
      background: var(--bg-dark);
      color: var(--text-primary);
    }

    .form-textarea {
      resize: vertical;
      min-height: 120px;
    }

    .input-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 6px;
    }

    .input-hint.success {
      color: var(--accent);
    }

    /* File Upload */
    .file-upload-zone {
      border: 2px dashed var(--border-color);
      border-radius: 16px;
      padding: 32px;
      text-align: center;
      transition: all 0.3s ease;
      cursor: pointer;
      background: rgba(11, 15, 25, 0.4);
    }

    .file-upload-zone:hover,
    .file-upload-zone.dragover {
      border-color: var(--primary-light);
      background: rgba(79, 70, 229, 0.05);
    }

    .file-upload-zone.has-file {
      border-color: var(--accent);
      border-style: solid;
    }

    .upload-icon {
      font-size: 48px;
      margin-bottom: 16px;
      display: block;
    }

    .upload-text {
      font-size: 15px;
      color: var(--text-primary);
      font-weight: 600;
      margin-bottom: 8px;
    }

    .upload-hint {
      font-size: 13px;
      color: var(--text-muted);
    }

    .file-preview {
      margin-top: 16px;
      position: relative;
      display: inline-block;
    }

    .file-preview img {
      max-width: 300px;
      max-height: 200px;
      border-radius: 12px;
      border: 2px solid var(--accent);
    }

    .file-preview-name {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      padding: 10px 16px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 8px;
      font-size: 13px;
      color: var(--accent);
      font-weight: 600;
    }

    .remove-file {
      position: absolute;
      top: -8px;
      right: -8px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--danger);
      color: white;
      border: none;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    }

    .remove-file:hover {
      transform: scale(1.1);
    }

    /* Client Info Section */
    .client-section {
      background: rgba(79, 70, 229, 0.05);
      border: 1px solid var(--border-light);
      border-radius: 16px;
      padding: 24px;
    }

    /* Submit Section */
    .submit-section {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
      padding-top: 28px;
      border-top: 1px solid var(--border-color);
      margin-top: 28px;
    }

    .submit-btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 18px 36px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .submit-btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(79, 70, 229, 0.5);
    }

    .submit-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .submit-btn .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .status-text {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .status-text.loading {
      color: var(--primary-light);
    }

    /* Results Section */
    .results-container {
      margin-top: 28px;
    }

    .result-card {
      background: rgba(11, 15, 25, 0.6);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      overflow: hidden;
    }

    .result-card.error {
      border-color: rgba(239, 68, 68, 0.5);
      background: rgba(239, 68, 68, 0.05);
    }

    .result-header {
      padding: 16px 20px;
      background: rgba(34, 197, 94, 0.1);
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .result-header.error {
      background: rgba(239, 68, 68, 0.1);
    }

    .result-header-icon {
      font-size: 20px;
    }

    .result-header-title {
      font-weight: 700;
      color: var(--accent);
    }

    .result-header.error .result-header-title {
      color: var(--danger);
    }

    .result-body {
      padding: 20px;
    }

    .result-estimate {
      white-space: pre-wrap;
      font-size: 14px;
      line-height: 1.8;
      color: var(--text-primary);
      font-family: inherit;
    }

    .result-actions {
      display: flex;
      gap: 12px;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid var(--border-color);
      flex-wrap: wrap;
    }

    /* Mobile Responsive */
    @media (max-width: 768px) {
      .header-inner {
        flex-direction: column;
        gap: 16px;
      }

      .user-info {
        order: 2;
      }

      .nav-actions {
        order: 3;
        justify-content: center;
      }

      .welcome-title {
        font-size: 1.5rem;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }

      .quick-actions {
        justify-content: center;
      }

      .form-grid {
        grid-template-columns: 1fr;
      }

      .upgrade-banner {
        flex-direction: column;
        text-align: center;
      }

      .submit-section {
        flex-direction: column;
        align-items: stretch;
      }

      .submit-btn {
        justify-content: center;
      }

      .result-actions {
        flex-direction: column;
      }

      .action-btn, .result-actions a {
        width: 100%;
        justify-content: center;
      }
    }

    @media (max-width: 480px) {
      .main-container {
        padding: 20px 16px;
      }

      .card-body {
        padding: 20px;
      }

      .file-upload-zone {
        padding: 24px;
      }

      .nav-link span {
        display: none;
      }
    }

    /* Template Section Styles */
    .template-controls {
      display: flex;
      gap: 16px;
      align-items: flex-end;
      flex-wrap: wrap;
    }

    .template-select-group {
      flex: 1;
      min-width: 250px;
    }

    .template-section {
      background: rgba(79, 70, 229, 0.05);
      border: 1px solid var(--border-light);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 28px;
    }

    /* Modal Styles */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s ease;
    }

    .modal-overlay.active {
      opacity: 1;
      visibility: visible;
    }

    .modal {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 32px;
      max-width: 480px;
      width: 90%;
      transform: scale(0.9);
      transition: all 0.3s ease;
    }

    .modal-overlay.active .modal {
      transform: scale(1);
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }

    .modal-title {
      font-size: 1.25rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .modal-close {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      border: none;
      background: var(--glass-bg);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    }

    .modal-close:hover {
      background: rgba(239, 68, 68, 0.2);
      color: var(--danger);
    }

    .modal-body {
      margin-bottom: 24px;
    }

    .modal-footer {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    }

    .template-delete-btn {
      padding: 6px 12px;
      border-radius: 8px;
      border: none;
      background: rgba(239, 68, 68, 0.1);
      color: var(--danger);
      cursor: pointer;
      font-size: 12px;
      margin-left: 8px;
      transition: all 0.3s ease;
    }

    .template-delete-btn:hover {
      background: rgba(239, 68, 68, 0.2);
    }

    /* Onboarding Modal Styles */
    .onboarding-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      animation: fadeIn 0.3s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes fadeOut {
      from { opacity: 1; }
      to { opacity: 0; }
    }

    .onboarding-overlay.fade-out {
      animation: fadeOut 0.3s ease-out forwards;
    }

    .onboarding-modal {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      max-width: 520px;
      width: 100%;
      padding: 40px;
      animation: slideUp 0.4s ease-out;
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .onboarding-title {
      font-size: 1.75rem;
      font-weight: 800;
      color: var(--text-primary);
      margin-bottom: 32px;
      text-align: center;
      line-height: 1.3;
    }

    .onboarding-steps {
      display: flex;
      flex-direction: column;
      gap: 20px;
      margin-bottom: 36px;
    }

    .onboarding-step {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }

    .step-number {
      width: 32px;
      height: 32px;
      min-width: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
    }

    .step-text {
      color: var(--text-muted);
      font-size: 15px;
      line-height: 1.5;
      padding-top: 4px;
    }

    .onboarding-cta {
      display: block;
      width: 100%;
      padding: 16px 24px;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s ease;
      text-align: center;
    }

    .onboarding-cta:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(79, 70, 229, 0.4);
    }

    /* Upsell Modal Styles */
    .upsell-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px);
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .upsell-overlay.active {
      display: flex;
      opacity: 1;
    }

    .upsell-overlay.fade-out {
      opacity: 0;
    }

    .upsell-modal {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      max-width: 480px;
      width: 100%;
      padding: 40px;
      position: relative;
      animation: slideUp 0.4s ease-out;
    }

    .upsell-close {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    }

    .upsell-close:hover {
      background: rgba(239, 68, 68, 0.2);
      color: var(--danger);
    }

    .upsell-title {
      font-size: 1.75rem;
      font-weight: 800;
      color: var(--text-primary);
      margin-bottom: 12px;
      text-align: center;
      line-height: 1.3;
    }

    .upsell-subtitle {
      font-size: 1rem;
      color: var(--text-muted);
      text-align: center;
      margin-bottom: 32px;
      line-height: 1.5;
    }

    .upsell-plans {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 32px;
    }

    .upsell-plan {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
    }

    .upsell-plan-name {
      font-size: 1rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .upsell-plan-price {
      font-size: 1.25rem;
      font-weight: 800;
      color: var(--primary-light);
    }

    .upsell-plan-features {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .upsell-actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .upsell-btn-primary {
      display: block;
      width: 100%;
      padding: 16px 24px;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s ease;
      text-align: center;
      text-decoration: none;
    }

    .upsell-btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(79, 70, 229, 0.4);
    }

    .upsell-btn-secondary {
      display: block;
      width: 100%;
      padding: 14px 24px;
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      text-align: center;
    }

    .upsell-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-primary);
    }
  </style>
</head>
<body>
  \${showOnboarding ? \`
  <!-- Onboarding Modal -->
  <div id="onboarding-overlay" class="onboarding-overlay">
    <div class="onboarding-modal">
      <h2 class="onboarding-title">Create Professional Estimates in Under 30 Seconds</h2>
      <div class="onboarding-steps">
        <div class="onboarding-step">
          <span class="step-number">1</span>
          <span class="step-text">Describe the job or upload photos. The more detail you give, the better the estimate.</span>
        </div>
        <div class="onboarding-step">
          <span class="step-number">2</span>
          <span class="step-text">Add the job location so pricing matches your local market.</span>
        </div>
        <div class="onboarding-step">
          <span class="step-number">3</span>
          <span class="step-text">Review the AI-generated breakdown. Adjust anything you want.</span>
        </div>
        <div class="onboarding-step">
          <span class="step-number">4</span>
          <span class="step-text">Download a client-ready PDF and send it instantly.</span>
        </div>
      </div>
      <button class="onboarding-cta" onclick="dismissOnboarding()">Create My First Estimate</button>
    </div>
  </div>
  \` : ''}
  \${!paid ? \`
  <!-- Upsell Modal -->
  <div id="upsellModal" class="upsell-overlay">
    <div class="upsell-modal">
      <button class="upsell-close" id="upsellClose">&times;</button>
      <h2 class="upsell-title">You're bidding like a pro.</h2>
      <p class="upsell-subtitle">Upgrade to create unlimited estimates and close jobs faster.</p>
      <div class="upsell-plans">
        <div class="upsell-plan">
          <div>
            <div class="upsell-plan-name">Pro</div>
            <div class="upsell-plan-features">Unlimited estimates, priority support</div>
          </div>
          <div class="upsell-plan-price">$25/month</div>
        </div>
        <div class="upsell-plan">
          <div>
            <div class="upsell-plan-name">Business</div>
            <div class="upsell-plan-features">Team accounts, white-label PDFs</div>
          </div>
          <div class="upsell-plan-price">$55/month</div>
        </div>
      </div>
      <div class="upsell-actions">
        <a href="/pricing" class="upsell-btn-primary">Upgrade Now</a>
        <button type="button" class="upsell-btn-secondary" id="upsellDismiss">Maybe Later</button>
      </div>
    </div>
  </div>
  \` : ''}
  <!-- Dashboard Header -->
  <header class="dashboard-header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      
      <div class="user-info">
        <div class="user-avatar">${escapeHtml((req.session!.email || "U")[0].toUpperCase())}</div>
        <div class="user-details">
          <span class="user-email">${escapeHtml(req.session!.email || "")}</span>
          <span class="user-plan">${paid ? "Pro Member" : "Free Plan"}</span>
        </div>
        <span class="plan-badge ${paid ? "paid" : "free"}">${paid ? "Pro" : "Free"}</span>
      </div>

      <nav class="nav-actions">
        <a href="/app" class="nav-link active">
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
        <a href="/affiliate" class="nav-link">
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

  <!-- Main Container -->
  <main class="main-container">
    <!-- Welcome Section -->
    <section class="welcome-section animate-fade-in">
      <h1 class="welcome-title">Welcome back! 👋</h1>
      <p class="welcome-subtitle">Generate professional construction estimates in seconds with AI.</p>
    </section>

    <!-- Stats Grid -->
    <section class="stats-grid">
      <div class="stat-card animate-fade-in animate-delay-1">
        <div class="stat-header">
          <div class="stat-icon usage">📊</div>
          <span class="stat-label">Free Estimates Used</span>
        </div>
        <div class="stat-value">${paid ? "∞" : `${used}/${FREE_ESTIMATES_LIFETIME}`}</div>
        <div class="stat-subtext">${paid ? "Unlimited estimates with Pro" : `${remaining} free estimate${remaining !== 1 ? "s" : ""} remaining`}</div>
        ${
          !paid
            ? `
        <div class="progress-bar">
          <div class="progress-fill ${usagePercent < 50 ? "low" : usagePercent < 100 ? "medium" : "high"}" style="width: ${usagePercent}%"></div>
        </div>
        `
            : ""
        }
      </div>

      <div class="stat-card animate-fade-in animate-delay-2">
        <div class="stat-header">
          <div class="stat-icon total">📈</div>
          <span class="stat-label">Total Estimates</span>
        </div>
        <div class="stat-value">${totalEstimatesCount}</div>
        <div class="stat-subtext">All-time estimates generated</div>
      </div>

      <div class="stat-card animate-fade-in animate-delay-3">
        <div class="stat-header">
          <div class="stat-icon plan">${paid ? "⭐" : "🎯"}</div>
          <span class="stat-label">Current Plan</span>
        </div>
        <div class="stat-value">${paid ? "Pro" : "Free"}</div>
        <div class="stat-subtext">${paid ? "Full access unlocked" : "Upgrade for unlimited access"}</div>
      </div>
    </section>

    <!-- Quick Actions -->
    <section class="quick-actions animate-fade-in">
      <a href="/history" class="action-btn secondary">
        <span>📋</span>
        View History
      </a>
      <a href="/leads" class="action-btn secondary">
        <span>👥</span>
        Manage Leads
      </a>
      ${paid ? `<a href="/billing" class="action-btn secondary"><span>💳</span>Billing</a>` : `<a href="/checkout?plan=pro" class="action-btn accent"><span>⚡</span>Upgrade to Pro</a>`}
    </section>

    ${
      !paid
        ? `
    <!-- Upgrade Banner -->
    <section class="upgrade-banner animate-fade-in">
      <div class="upgrade-content">
        <h3>🚀 Unlock Unlimited Estimates</h3>
        <p>You're using the free tier. Upgrade to Pro for unlimited estimates, PDF exports, and priority support.</p>
      </div>
      <div class="upgrade-actions">
        <a href="/checkout?plan=pro" class="action-btn primary">Upgrade to Pro - $25/mo</a>
        <a href="/checkout?plan=business" class="action-btn secondary">Business Plan</a>
      </div>
    </section>
    `
        : ""
    }

    <!-- Main Estimate Form Card -->
    <section class="main-card animate-fade-in">
      <div class="card-header">
        <div>
          <h2 class="card-title">
            <span class="card-title-icon">🤖</span>
            Generate AI Estimate
          </h2>
          <p class="card-subtitle">Upload a photo and describe the job for an accurate, AI-powered estimate.</p>
        </div>
      </div>

      <div class="card-body">
        <form id="estimateForm" enctype="multipart/form-data">
          <input type="hidden" name="_csrf" id="csrfToken" value="${req.session!.csrfToken || ""}"/>
          <!-- Template Section -->
          <div class="form-section template-section">
            <div class="section-title">
              <span>📁</span>
              Saved Templates
              <span class="section-divider"></span>
            </div>

            <div class="template-controls">
              <div class="form-group template-select-group">
                <select id="templateSelect" class="form-select">
                  <option value="">-- Select a saved template --</option>
                </select>
              </div>
              <button type="button" id="saveTemplateBtn" class="action-btn secondary">
                <span>💾</span>
                Save as Template
              </button>
            </div>
          </div>

          <!-- Job Details Section -->
          <div class="form-section">
            <div class="section-title">
              <span>📋</span>
              Job Details
              <span class="section-divider"></span>
            </div>

            <div class="form-grid">
              <div class="form-group">
                <label class="form-label">
                  <span>🏗️</span>
                  Trade Preset (Optional)
                </label>
                <select name="tradePreset" id="tradePreset" class="form-select"
                  data-preset-masonry='{"laborMultiplier": 1.15, "defaultMargin": 20, "includes": "demo, cleanup, mortar, brick/stone allowance"}'
                  data-preset-roofing='{"laborMultiplier": 1.10, "defaultMargin": 18, "includes": "tear-off, disposal, underlayment"}'
                  data-preset-concrete='{"laborMultiplier": 1.20, "defaultMargin": 22, "includes": "forms, rebar, finish work"}'
                  data-preset-remodeling='{"laborMultiplier": 1.25, "defaultMargin": 25, "includes": "uncertainty buffer"}'>
                  <option value="">General Construction</option>
                  <option value="masonry">Masonry</option>
                  <option value="roofing">Roofing</option>
                  <option value="concrete">Concrete</option>
                  <option value="remodeling">Remodeling</option>
                </select>
                <div id="tradePresetNote" class="input-hint" style="color: #6366f1; margin-top: 4px;"></div>
              </div>

              <div class="form-group">
                <label class="form-label">
                  <span>🔧</span>
                  Job Type
                </label>
                <select name="jobType" class="form-select">
                  <option value="tuckpointing">Tuckpointing</option>
                  <option value="chimney_rebuild">Chimney Rebuild</option>
                  <option value="retaining_wall">Retaining Wall</option>
                  <option value="concrete_flatwork">Concrete Flatwork</option>
                  <option value="roof_repair">Roof Repair</option>
                  <option value="general">General Construction</option>
                </select>
              </div>

              <div class="form-group">
                <label class="form-label">
                  <span>📍</span>
                  Zip Code
                </label>
                <input type="text" name="zipCode" id="zipCode" class="form-input" placeholder="60601" maxlength="5" pattern="[0-9]{5}"/>
                <div id="locationInfo" class="input-hint"></div>
              </div>
            </div>

            <input type="hidden" name="market" id="market" value="midwest"/>
          </div>

          <!-- Photo Upload Section -->
          <div class="form-section">
            <div class="section-title">
              <span>📷</span>
              Job Site Photo
              <span class="optional">(Optional)</span>
              <span class="section-divider"></span>
            </div>

            <input type="file" name="photo" accept="image/*" id="photoInput" style="display:none"/>
            <div class="file-upload-zone" id="uploadZone">
              <span class="upload-icon">📁</span>
              <div class="upload-text">Drag & drop a photo here, or click to browse</div>
              <div class="upload-hint">Supports JPG, PNG, WebP, GIF up to 10MB</div>
              <div id="filePreview" class="file-preview"></div>
            </div>
          </div>

          <!-- Job Description Section -->
          <div class="form-section">
            <div class="section-title">
              <span>📝</span>
              Job Description
              <span class="section-divider"></span>
            </div>

            <div class="form-group">
              <label class="form-label">
                Describe the scope, dimensions, materials, and access requirements
              </label>
              <textarea name="details" class="form-textarea" placeholder="Example: 30 ft tuckpointing on 2-story brick building, mortar color match needed, scaffolding required, includes cleanup. Side access only, neighbor approval obtained."></textarea>
            </div>
          </div>

          <!-- Client Info Section -->
          <div class="form-section">
            <div class="section-title">
              <span>👤</span>
              Client Information
              <span class="optional">(Optional - saves to leads)</span>
              <span class="section-divider"></span>
            </div>

            <div class="client-section">
              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label">Client Name</label>
                  <input type="text" name="clientName" class="form-input" placeholder="John Smith"/>
                </div>
                <div class="form-group">
                  <label class="form-label">Email Address</label>
                  <input type="email" name="clientEmail" class="form-input" placeholder="john@example.com"/>
                </div>
                <div class="form-group">
                  <label class="form-label">Phone Number</label>
                  <input type="tel" name="clientPhone" class="form-input" placeholder="(555) 123-4567"/>
                </div>
              </div>
            </div>
          </div>

          <!-- Submit Section -->
          <div class="submit-section">
            <button type="submit" class="submit-btn" id="submitBtn">
              <span>🤖</span>
              Generate AI Estimate
            </button>
            <div class="status-text" id="statusText"></div>
          </div>
        </form>

        <!-- Results Container -->
        <div id="resultsContainer" class="results-container"></div>
      </div>
    </section>
  </main>

  <script>
    const form = document.getElementById('estimateForm');
    const resultsContainer = document.getElementById('resultsContainer');
    const statusText = document.getElementById('statusText');
    const submitBtn = document.getElementById('submitBtn');
    const photoInput = document.getElementById('photoInput');
    const uploadZone = document.getElementById('uploadZone');
    const filePreview = document.getElementById('filePreview');
    const zipInput = document.getElementById('zipCode');
    const locationInfo = document.getElementById('locationInfo');
    const marketInput = document.getElementById('market');

    // File Upload Handling
    uploadZone.addEventListener('click', () => photoInput.click());

    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });

    uploadZone.addEventListener('dragleave', () => {
      uploadZone.classList.remove('dragover');
    });

    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        photoInput.files = files;
        handleFileSelect(files[0]);
      }
    });

    photoInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileSelect(file);
    });

    function handleFileSelect(file) {
      uploadZone.classList.add('has-file');
      const reader = new FileReader();
      reader.onload = (e) => {
        filePreview.innerHTML = \`
          <button type="button" class="remove-file" onclick="removeFile()">×</button>
          <img src="\${e.target.result}" alt="Preview"/>
          <div class="file-preview-name">
            <span>✓</span>
            \${file.name}
          </div>
        \`;
      };
      reader.readAsDataURL(file);
    }

    function removeFile() {
      photoInput.value = '';
      filePreview.innerHTML = '';
      uploadZone.classList.remove('has-file');
    }

    // Zip Code Lookup
    zipInput.addEventListener('blur', async () => {
      const zip = zipInput.value.trim();
      if (zip.length === 5 && /^[0-9]{5}$/.test(zip)) {
        try {
          const r = await fetch('/api/zip-lookup?zip=' + zip);
          const data = await r.json();
          if (data.city && data.state) {
            locationInfo.textContent = data.city + ', ' + data.state + ' - ' + data.region + ' region';
            locationInfo.classList.add('success');
            marketInput.value = data.market;
          } else {
            locationInfo.textContent = '';
            locationInfo.classList.remove('success');
          }
        } catch (e) {
          locationInfo.textContent = '';
          locationInfo.classList.remove('success');
        }
      } else {
        locationInfo.textContent = '';
        locationInfo.classList.remove('success');
      }
    });

    // Trade Preset Selection Handler
    const tradePresetSelect = document.getElementById('tradePreset');
    const tradePresetNote = document.getElementById('tradePresetNote');
    
    const presetDescriptions = {
      masonry: '🧱 Includes: demo, cleanup, mortar, brick/stone allowance (1.15x labor, 20% margin)',
      roofing: '🏠 Includes: tear-off, disposal, underlayment (1.10x labor, 18% margin)',
      concrete: '🏗️ Includes: forms, rebar, finish work (1.20x labor, 22% margin)',
      remodeling: '🔨 Includes: uncertainty buffer (1.25x labor, 25% margin)'
    };

    tradePresetSelect.addEventListener('change', () => {
      const selectedPreset = tradePresetSelect.value;
      if (selectedPreset && presetDescriptions[selectedPreset]) {
        tradePresetNote.textContent = presetDescriptions[selectedPreset];
        tradePresetNote.style.display = 'block';
      } else {
        tradePresetNote.textContent = '';
        tradePresetNote.style.display = 'none';
      }
    });

    // Form Submission
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span> Analyzing...';
      statusText.innerHTML = '<span class="loading">AI is analyzing your job details...</span>';
      statusText.classList.add('loading');
      resultsContainer.innerHTML = '';

      const formData = new FormData(form);

      try {
        const r = await fetch('/estimate', {
          method: 'POST',
          body: formData
        });

        const data = await r.json().catch(() => ({}));

        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>🤖</span> Generate AI Estimate';
        statusText.innerHTML = '';
        statusText.classList.remove('loading');

        if (!r.ok) {
          const isLimitError = r.status === 402 || data?.upgrade === true;
          const isAuthError = r.status === 403;
          const title = isLimitError ? 'Daily Limit Reached' : isAuthError ? 'Session Expired' : 'Error';
          const msg = data?.message || data?.error || (isLimitError ? 'You\'ve used all 3 free estimates. Upgrade to Pro for unlimited access.' : isAuthError ? 'Please refresh the page and try again.' : 'Something went wrong. Please try again.');
          resultsContainer.innerHTML = \`
            <div class="result-card error">
              <div class="result-header error">
                <span class="result-header-icon">⚠️</span>
                <span class="result-header-title">\${title}</span>
              </div>
              <div class="result-body">
                <p>\${msg}</p>
                \${isLimitError ? \`
                <p style="font-size:0.85rem;color:#9ca3af;margin-top:4px;">Resets at midnight — or upgrade for unlimited estimates.</p>
                <div class="result-actions" style="margin-top:16px;">
                  <a href="/checkout?plan=pro" class="action-btn primary">
                    <span>⚡</span>
                    Upgrade to Pro — $25/mo
                  </a>
                  <a href="/checkout?plan=business" class="action-btn secondary">
                    <span>🏢</span>
                    Business Plan — $55/mo
                  </a>
                  <a href="/checkout?plan=lifetime" class="action-btn secondary" style="background:#16a34a;">
                    <span>♾️</span>
                    Lifetime Access — $199
                  </a>
                </div>
                \` : isAuthError ? \`
                <div class="result-actions" style="margin-top:16px;">
                  <a href="javascript:window.location.reload()" class="action-btn primary">
                    <span>🔄</span>
                    Refresh Page
                  </a>
                </div>
                \` : ''}
              </div>
            </div>
          \`;
          return;
        }

        resultsContainer.innerHTML = \`
          <div class="result-card">
            <div class="result-header">
              <span class="result-header-icon">✅</span>
              <span class="result-header-title">Estimate Generated Successfully</span>
            </div>
            <div class="result-body">
              <div class="result-estimate">\${data?.text || JSON.stringify(data, null, 2)}</div>
              \${data?.estimateId ? \`
              <div class="result-actions">
                <a href="/estimate/\${data.estimateId}/pdf" target="_blank" class="action-btn primary">
                  <span>📄</span>
                  Download PDF
                </a>
                <a href="/history" class="action-btn secondary">
                  <span>📋</span>
                  View History
                </a>
              </div>
              \` : ''}
            </div>
          </div>
        \`;

        // Check if upsell modal should be shown (free users only)
        if (data.tier === 'free') {
          const dailyUsed = data.dailyUsed || 0;
          const totalEstimates = data.totalEstimates || 0;
          const upsellDismissed = sessionStorage.getItem('upsellDismissed');
          
          if (!upsellDismissed && (dailyUsed >= 2 || totalEstimates >= 5)) {
            const upsellModal = document.getElementById('upsellModal');
            if (upsellModal) {
              setTimeout(() => {
                upsellModal.classList.add('active');
              }, 500);
            }
          }
        }
      } catch (error) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>🤖</span> Generate AI Estimate';
        statusText.innerHTML = '';
        
        resultsContainer.innerHTML = \`
          <div class="result-card error">
            <div class="result-header error">
              <span class="result-header-icon">❌</span>
              <span class="result-header-title">Error</span>
            </div>
            <div class="result-body">
              <p>Failed to generate estimate. Please try again.</p>
            </div>
          </div>
        \`;
      }
    });

    // Template functionality
    const templateSelect = document.getElementById('templateSelect');
    const saveTemplateBtn = document.getElementById('saveTemplateBtn');
    const templateModal = document.getElementById('templateModal');
    const modalClose = document.getElementById('modalClose');
    const cancelTemplateBtn = document.getElementById('cancelTemplateBtn');
    const confirmSaveTemplateBtn = document.getElementById('confirmSaveTemplateBtn');
    const templateNameInput = document.getElementById('templateName');

    let templates = [];

    async function loadTemplates() {
      try {
        const r = await fetch('/templates');
        templates = await r.json();
        renderTemplateOptions();
      } catch (e) {
        console.error('Failed to load templates:', e);
      }
    }

    function renderTemplateOptions() {
      templateSelect.innerHTML = '<option value="">-- Select a saved template --</option>';
      templates.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        option.textContent = t.name;
        templateSelect.appendChild(option);
      });
    }

    templateSelect.addEventListener('change', () => {
      const templateId = templateSelect.value;
      if (!templateId) return;

      const template = templates.find(t => t.id === templateId);
      if (!template) return;

      form.querySelector('[name="jobType"]').value = template.job_type;
      marketInput.value = template.market;
      form.querySelector('[name="details"]').value = template.details || '';
      form.querySelector('[name="clientName"]').value = template.client_name || '';
      form.querySelector('[name="clientEmail"]').value = template.client_email || '';
      form.querySelector('[name="clientPhone"]').value = template.client_phone || '';
    });

    saveTemplateBtn.addEventListener('click', () => {
      templateNameInput.value = '';
      templateModal.classList.add('active');
    });

    modalClose.addEventListener('click', () => {
      templateModal.classList.remove('active');
    });

    cancelTemplateBtn.addEventListener('click', () => {
      templateModal.classList.remove('active');
    });

    templateModal.addEventListener('click', (e) => {
      if (e.target === templateModal) {
        templateModal.classList.remove('active');
      }
    });

    confirmSaveTemplateBtn.addEventListener('click', async () => {
      const name = templateNameInput.value.trim();
      if (!name) {
        alert('Please enter a template name');
        return;
      }

      const data = {
        name,
        job_type: form.querySelector('[name="jobType"]').value,
        market: marketInput.value,
        details: form.querySelector('[name="details"]').value,
        client_name: form.querySelector('[name="clientName"]').value,
        client_email: form.querySelector('[name="clientEmail"]').value,
        client_phone: form.querySelector('[name="clientPhone"]').value
      };

      try {
        confirmSaveTemplateBtn.disabled = true;
        confirmSaveTemplateBtn.textContent = 'Saving...';

        const csrfToken = document.getElementById('csrfToken').value;
        const r = await fetch('/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify(data)
        });

        const result = await r.json();

        if (r.ok) {
          templateModal.classList.remove('active');
          await loadTemplates();
          templateSelect.value = result.id;
        } else {
          alert(result.error || 'Failed to save template');
        }
      } catch (e) {
        alert('Failed to save template');
      } finally {
        confirmSaveTemplateBtn.disabled = false;
        confirmSaveTemplateBtn.textContent = 'Save Template';
      }
    });

    async function deleteTemplate(id) {
      if (!confirm('Are you sure you want to delete this template?')) return;

      try {
        const csrfToken = document.getElementById('csrfToken').value;
        const r = await fetch('/templates/' + id, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
        if (r.ok) {
          await loadTemplates();
        } else {
          alert('Failed to delete template');
        }
      } catch (e) {
        alert('Failed to delete template');
      }
    }

    loadTemplates();

    async function dismissOnboarding() {
      const overlay = document.getElementById('onboarding-overlay');
      if (overlay) {
        overlay.classList.add('fade-out');
        try {
          await fetch('/api/onboarding-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (e) {
          console.error('Failed to mark onboarding complete:', e);
        }
        setTimeout(() => {
          overlay.remove();
        }, 300);
      }
    }

    // Upsell Modal Dismiss Functionality
    function dismissUpsellModal() {
      const upsellModal = document.getElementById('upsellModal');
      if (upsellModal) {
        upsellModal.classList.add('fade-out');
        sessionStorage.setItem('upsellDismissed', 'true');
        setTimeout(() => {
          upsellModal.classList.remove('active', 'fade-out');
        }, 300);
      }
    }

    // Set up upsell modal dismiss handlers
    const upsellCloseBtn = document.getElementById('upsellClose');
    const upsellDismissBtn = document.getElementById('upsellDismiss');
    const upsellModalOverlay = document.getElementById('upsellModal');

    if (upsellCloseBtn) {
      upsellCloseBtn.addEventListener('click', dismissUpsellModal);
    }
    if (upsellDismissBtn) {
      upsellDismissBtn.addEventListener('click', dismissUpsellModal);
    }
    if (upsellModalOverlay) {
      upsellModalOverlay.addEventListener('click', (e) => {
        if (e.target === upsellModalOverlay) {
          dismissUpsellModal();
        }
      });
    }
  </script>

  <!-- Save Template Modal -->
  <div class="modal-overlay" id="templateModal">
    <div class="modal">
      <div class="modal-header">
        <h3 class="modal-title">
          <span>💾</span>
          Save as Template
        </h3>
        <button class="modal-close" id="modalClose">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Template Name</label>
          <input type="text" id="templateName" class="form-input" placeholder="e.g., Standard Tuckpointing Job"/>
          <div class="input-hint">Give your template a memorable name</div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="action-btn secondary" id="cancelTemplateBtn">Cancel</button>
        <button type="button" class="action-btn primary" id="confirmSaveTemplateBtn">Save Template</button>
      </div>
    </div>
  </div>
</body>
</html>
  `);
  }),
);

// --- Onboarding Complete API ---
app.post(
  "/api/onboarding-complete",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    try {
      await db
        .update(users)
        .set({ hasSeenOnboarding: true })
        .where(eq(users.id, uid));
      res.json({ success: true });
    } catch (e) {
      log("error", "Failed to mark onboarding complete", {
        userId: uid,
        error: String(e),
      });
      res.status(500).json({ error: "Failed to update onboarding status" });
    }
  }),
);

// --- Estimate API (Paywall enforced here) ---
// Note: upload.single must come BEFORE validateCsrf so multer parses the multipart body first
app.post(
  "/estimate",
  requireAuth,
  upload.single("photo"),
  validateCsrf,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;

    // Capture uploaded file immediately — multer writes to disk before handler
    // runs, so photoFiles must be declared here to guarantee cleanup via finally
    // even when validation or paywall check returns early.
    const photoFiles = req.file ? [req.file] : [];

    try {
      const parseResult = estimateSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res
          .status(400)
          .json({ error: parseResult.error.issues[0].message });
      }
      const {
        jobType,
        market,
        details,
        zipCode,
        clientName,
        clientEmail,
        clientPhone,
        tradePreset,
      } = parseResult.data;

      const gate = await enforcePaywall(uid);
      if (!gate.ok) {
        return res.status(402).json({
          message:
            "Free preview limit reached. Upgrade to unlock unlimited estimates.",
          upgrade: true,
        });
      }

      const creditId =
        gate.tier === "single_credit"
          ? (gate as { ok: true; tier: "single_credit"; creditId: string }).creditId
          : null;

      const sub = await getSub(uid);
      const paid = isPaidActive(sub);
      const isLifetime = gate.tier === "lifetime";
      const isSingleCredit = gate.tier === "single_credit";
      if (!paid && !isLifetime && !isSingleCredit) await incrementUsage(uid);

      const estimateText = await generateAIEstimate(
        jobType,
        market,
        details,
        photoFiles,
        zipCode,
        tradePreset,
      );

      // Save estimate to history
      const estimateId = crypto.randomUUID();
      await db.insert(estimates).values({
        id: estimateId,
        userId: uid,
        jobType: jobType,
        market: market,
        details: details,
        estimateText: estimateText,
        clientName: clientName || null,
        clientEmail: clientEmail || null,
        clientPhone: clientPhone || null,
        status: "sent",
        createdAt: now(),
      });

      const totalEstimatesCount = await getTotalEstimates(uid);

      // Auto-create lead if client info provided
      let createdLeadId: string | null = null;
      if (clientName || clientEmail || clientPhone) {
        createdLeadId = crypto.randomUUID();
        await db.insert(leads).values({
          id: createdLeadId,
          userId: uid,
          name: clientName || "Unknown",
          email: clientEmail || null,
          phone: clientPhone || null,
          notes: `From estimate: ${jobType}`,
          status: "new",
          createdAt: now(),
          updatedAt: now(),
        });
      }

      // Auto-populate Sales Pipeline (legacy SSR path): the homepage estimate
      // form lands a deal directly in "Estimate Sent" stage, linked to the
      // newly-inserted lead so estimate-status flips later sync the same row.
      syncDealForNewEstimate({
        userId: uid,
        estimateId,
        leadId: createdLeadId,
        source: {
          title: jobType,
          clientName: clientName || null,
          clientEmail: clientEmail || null,
          clientPhone: clientPhone || null,
          description: details || null,
          projectType: jobType || null,
          value: parseEstimateTotalValue(estimateText),
        },
      }).catch((err) => log("warn", "Pipeline sync (legacy estimate) failed", { error: err?.message }));

      await trackEvent("estimate_generated", uid, {
        jobType,
        market,
        hasPhoto: photoFiles.length > 0,
      });

      // Consume single credit AFTER successful generation (so failed estimates don't charge user)
      if (creditId) {
        await consumeSingleCredit(creditId);
      }

      // Check if user has 1 estimate left (upsell moment — fire after 2nd estimate)
      if (!paid && totalEstimatesCount === 2) {
        sendUpsellEmail(req.session!.email!, totalEstimatesCount, jobType);
        await trackEvent("upsell_email_sent", uid, {
          estimates: totalEstimatesCount,
        });
      }

      // Schedule follow-up email 15 minutes after estimate (non-blocking, free users only)
      if (!paid && !isLifetime && req.session!.email) {
        scheduleFollowUpEmail(req.session!.email, uid);
      }

      const dailyUsed = await getDailyUsage(uid);

      res.json({
        ok: true,
        tier: paid ? "paid" : "free",
        text: estimateText,
        estimateId,
        dailyUsed,
        totalEstimates: totalEstimatesCount,
      });
    } catch (err: any) {
      log("error", "AI estimate error (legacy SSR route)", { error: err.message });
      res.status(500).json({ error: "Failed to generate estimate" });
    } finally {
      // Always clean up temp upload files regardless of success or failure
      photoFiles.forEach((f) => fs.unlink(f.path, () => {}));
    }
  }),
);

// --- Zip Code Lookup API ---
app.get(
  "/api/zip-lookup",
  asyncHandler(async (req, res) => {
    const zip = String(req.query.zip || "").trim();

    if (!/^[0-9]{5}$/.test(zip)) {
      return res.status(400).json({ error: "Invalid zip code" });
    }

    try {
      // Use free zippopotam.us API for zip code lookups
      const response = await fetch(`https://api.zippopotam.us/us/${zip}`);

      if (!response.ok) {
        return res.status(404).json({ error: "Zip code not found" });
      }

      const data = await response.json();
      const state = data.places?.[0]?.["state abbreviation"];
      const city = data.places?.[0]?.["place name"];

      // Map states to regions and markets
      const stateToMarket: Record<string, { region: string; market: string }> =
        {
          // Midwest
          IL: { region: "Midwest", market: "midwest" },
          IN: { region: "Midwest", market: "midwest" },
          IA: { region: "Midwest", market: "midwest" },
          KS: { region: "Midwest", market: "midwest" },
          MI: { region: "Midwest", market: "midwest" },
          MN: { region: "Midwest", market: "midwest" },
          MO: { region: "Midwest", market: "midwest" },
          NE: { region: "Midwest", market: "midwest" },
          ND: { region: "Midwest", market: "midwest" },
          OH: { region: "Midwest", market: "midwest" },
          SD: { region: "Midwest", market: "midwest" },
          WI: { region: "Midwest", market: "midwest" },

          // South
          AL: { region: "South", market: "south" },
          AR: { region: "South", market: "south" },
          DE: { region: "South", market: "south" },
          FL: { region: "South", market: "south" },
          GA: { region: "South", market: "south" },
          KY: { region: "South", market: "south" },
          LA: { region: "South", market: "south" },
          MD: { region: "South", market: "south" },
          MS: { region: "South", market: "south" },
          NC: { region: "South", market: "south" },
          OK: { region: "South", market: "south" },
          SC: { region: "South", market: "south" },
          TN: { region: "South", market: "south" },
          TX: { region: "South", market: "south" },
          VA: { region: "South", market: "south" },
          WV: { region: "South", market: "south" },

          // West
          AK: { region: "West", market: "west" },
          AZ: { region: "West", market: "west" },
          CA: { region: "West", market: "west" },
          CO: { region: "West", market: "west" },
          HI: { region: "West", market: "west" },
          ID: { region: "West", market: "west" },
          MT: { region: "West", market: "west" },
          NV: { region: "West", market: "west" },
          NM: { region: "West", market: "west" },
          OR: { region: "West", market: "west" },
          UT: { region: "West", market: "west" },
          WA: { region: "West", market: "west" },
          WY: { region: "West", market: "west" },

          // Northeast
          CT: { region: "Northeast", market: "northeast" },
          MA: { region: "Northeast", market: "northeast" },
          ME: { region: "Northeast", market: "northeast" },
          NH: { region: "Northeast", market: "northeast" },
          NJ: { region: "Northeast", market: "northeast" },
          NY: { region: "Northeast", market: "northeast" },
          PA: { region: "Northeast", market: "northeast" },
          RI: { region: "Northeast", market: "northeast" },
          VT: { region: "Northeast", market: "northeast" },
        };

      const location = stateToMarket[state] || {
        region: "Midwest",
        market: "midwest",
      };

      res.json({
        city,
        state,
        zip,
        region: location.region,
        market: location.market,
      });
    } catch (error) {
      console.error("Zip lookup error:", error);
      res.status(500).json({ error: "Lookup failed" });
    }
  }),
);

// --- Checkout (Stripe) ---
app.get(
  "/checkout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const plan = String(req.query.plan || "pro");
    const priceId = plan === "business" ? PRICE_BIZ : PRICE_PRO;

    const email = req.session!.email!;
    let customerId = await getStripeCustomerIdOrNull(uid);
    if (!customerId) {
      customerId = await createStripeCustomer(email);
      await upsertStripeCustomer(uid, customerId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: 7,
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" },
        },
      },
      payment_method_collection: "if_required",
      success_url: `${APP_URL}/success`,
      cancel_url: `${APP_URL}/pricing`,
      metadata: { user_id: uid },
    });

    await trackEvent("checkout_started", uid, { plan });

    res.redirect(303, session.url!);
  }),
);

app.get(
  "/checkout/single",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const email = req.session!.email!;

    let customerId = await getStripeCustomerIdOrNull(uid);
    if (!customerId) {
      customerId = await createStripeCustomer(email);
      await upsertStripeCustomer(uid, customerId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: PRICE_SINGLE, quantity: 1 }],
      success_url: `${APP_URL}/success?type=single`,
      cancel_url: `${APP_URL}/pricing`,
      metadata: { user_id: uid, purchase_type: "single_estimate" },
    });

    await trackEvent("checkout_single_started", uid);
    res.redirect(303, session.url!);
  }),
);

app.get(
  "/checkout/lifetime",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const email = req.session!.email!;

    const lifetimeStatus = await getLifetimeStatus();
    if (lifetimeStatus.soldOut) {
      return res.redirect(303, `${APP_URL}/pricing?lifetime_sold_out=1`);
    }

    let customerId = await getStripeCustomerIdOrNull(uid);
    if (!customerId) {
      customerId = await createStripeCustomer(email);
      await upsertStripeCustomer(uid, customerId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: PRICE_LIFETIME, quantity: 1 }],
      success_url: `${APP_URL}/success?type=lifetime`,
      cancel_url: `${APP_URL}/pricing`,
      metadata: { user_id: uid, purchase_type: "lifetime" },
    });

    await trackEvent("checkout_lifetime_started", uid);
    res.redirect(303, session.url!);
  }),
);

app.get("/success", requireAuth, (req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>Success - ProBid AI</title>
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
      --bg-dark: #0a0e1a;
      --bg-darker: #060912;
      --bg-card: rgba(18, 26, 42, 0.6);
      --bg-card-hover: rgba(26, 39, 64, 0.8);
      --border-color: rgba(34, 48, 77, 0.5);
      --border-light: rgba(99, 102, 241, 0.3);
      --text-primary: #e8f0ff;
      --text-muted: #94a3b8;
      --text-dark: #0b0f19;
      --glass-bg: rgba(255, 255, 255, 0.05);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.5); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes checkDraw {
      0% { stroke-dashoffset: 100; }
      100% { stroke-dashoffset: 0; }
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.05); opacity: 0.9; }
    }

    @keyframes confetti {
      0% { transform: translateY(0) rotate(0deg); opacity: 1; }
      100% { transform: translateY(-100px) rotate(720deg); opacity: 0; }
    }

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .page-bg {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
      z-index: 0;
    }

    .glow {
      position: fixed;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.25;
      z-index: 0;
    }

    .glow-1 { top: -150px; left: -150px; background: var(--accent); }
    .glow-2 { bottom: -150px; right: -150px; background: var(--primary); }

    .container {
      position: relative;
      z-index: 10;
      max-width: 560px;
      margin: 0 auto;
      padding: 24px;
      text-align: center;
    }

    .success-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 48px 40px;
      animation: fadeInUp 0.6s ease-out forwards;
    }

    .checkmark-circle {
      width: 100px;
      height: 100px;
      margin: 0 auto 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 32px rgba(34, 197, 94, 0.4);
      animation: scaleIn 0.5s ease-out 0.2s forwards, pulse 2s ease-in-out 1s infinite;
      opacity: 0;
    }

    .checkmark-circle svg {
      width: 48px;
      height: 48px;
      stroke: white;
      stroke-width: 3;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .checkmark-circle svg path {
      stroke-dasharray: 100;
      stroke-dashoffset: 100;
      animation: checkDraw 0.6s ease-out 0.5s forwards;
    }

    .success-title {
      font-size: 2rem;
      font-weight: 800;
      margin-bottom: 12px;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .success-subtitle {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 36px;
      line-height: 1.7;
    }

    .next-steps {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 32px;
      text-align: left;
    }

    .next-steps-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary-light);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
    }

    .step-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }

    .step-item:last-child { margin-bottom: 0; }

    .step-number {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      color: white;
      font-size: 12px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .step-text {
      font-size: 14px;
      color: var(--text-muted);
      padding-top: 2px;
    }

    .btn-group {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 32px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
      flex: 1;
      min-width: 160px;
    }

    .btn-primary {
      color: var(--text-dark);
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 4px 20px rgba(34, 197, 94, 0.3);
    }

    .btn-primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(34, 197, 94, 0.4);
    }

    .btn-secondary {
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      backdrop-filter: blur(10px);
    }

    .btn-secondary:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
      transform: translateY(-2px);
    }

    .confetti-container {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      pointer-events: none;
      z-index: 100;
    }

    .confetti {
      position: absolute;
      width: 10px;
      height: 10px;
      opacity: 0;
    }

    @media (max-width: 480px) {
      .success-card { padding: 32px 24px; }
      .success-title { font-size: 1.5rem; }
      .btn-group { flex-direction: column; }
      .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="page-bg"></div>
  <div class="glow glow-1"></div>
  <div class="glow glow-2"></div>

  <div class="container">
    <div class="success-card">
      <div class="checkmark-circle">
        <svg viewBox="0 0 24 24">
          <path d="M5 13l4 4L19 7"/>
        </svg>
      </div>

      <h1 class="success-title">Welcome to ProBid AI Pro!</h1>
      <p class="success-subtitle">Your subscription is now active. You have unlimited access to all premium features.</p>

      <div class="next-steps">
        <div class="next-steps-title">What's Next</div>
        <div class="step-item">
          <span class="step-number">1</span>
          <span class="step-text">Create your first professional estimate with AI</span>
        </div>
        <div class="step-item">
          <span class="step-number">2</span>
          <span class="step-text">Export estimates as branded PDFs</span>
        </div>
        <div class="step-item">
          <span class="step-number">3</span>
          <span class="step-text">Track leads and manage your pipeline</span>
        </div>
      </div>

      <div class="btn-group">
        <a href="/app" class="btn btn-primary">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          Start Creating
        </a>
        <a href="/billing" class="btn btn-secondary">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>
          Manage Billing
        </a>
      </div>
    </div>
  </div>

  <script>
    function createConfetti() {
      const container = document.createElement('div');
      container.className = 'confetti-container';
      document.body.appendChild(container);
      
      const colors = ['#22c55e', '#4f46e5', '#6366f1', '#fbbf24', '#f472b6'];
      
      for (let i = 0; i < 50; i++) {
        setTimeout(() => {
          const confetti = document.createElement('div');
          confetti.className = 'confetti';
          confetti.style.left = Math.random() * 100 + '%';
          confetti.style.top = '-20px';
          confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
          confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
          confetti.style.animation = 'confetti 2s ease-out forwards';
          confetti.style.animationDelay = Math.random() * 0.5 + 's';
          container.appendChild(confetti);
          
          setTimeout(() => confetti.remove(), 3000);
        }, i * 30);
      }
    }
    
    setTimeout(createConfetti, 600);
  </script>
</body>
</html>
  `);
});

// --- Billing portal ---
app.get(
  "/billing",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const user = await getUser(uid);
    const sub = await getSub(uid);
    const paid = isPaidActive(sub);
    const userEmail = req.session?.email || "user";
    const planName = paid
      ? sub?.priceId === PRICE_BIZ || sub?.priceId === PRICE_BIZ_ANNUAL
        ? "Business"
        : "Pro"
      : "Free";
    const planPrice = paid
      ? sub?.priceId === PRICE_BIZ || sub?.priceId === PRICE_BIZ_ANNUAL
        ? "$55"
        : "$25"
      : "$0";

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>Billing & Support - ProBid AI</title>
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

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .animate-fade-in { animation: fadeInUp 0.5s ease-out forwards; }
    .animate-delay-1 { animation-delay: 0.1s; opacity: 0; }
    .animate-delay-2 { animation-delay: 0.2s; opacity: 0; }
    .animate-delay-3 { animation-delay: 0.3s; opacity: 0; }

    .page-bg {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
      z-index: 0;
    }

    .header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(10, 14, 26, 0.9);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
      padding: 16px 0;
    }

    .header-inner {
      max-width: 800px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
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

    .nav-actions { display: flex; gap: 10px; align-items: center; }

    .nav-link {
      padding: 10px 18px;
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

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 24px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(79, 70, 229, 0.4);
    }

    .btn-secondary {
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
      transform: translateY(-1px);
    }

    .btn-accent {
      color: var(--text-dark);
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 4px 16px rgba(34, 197, 94, 0.3);
    }

    .btn-accent:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(34, 197, 94, 0.4);
    }

    .container {
      position: relative;
      z-index: 10;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 24px;
    }

    .page-header {
      margin-bottom: 40px;
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

    .card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 32px;
      margin-bottom: 24px;
      transition: all 0.3s ease;
    }

    .card:hover {
      border-color: var(--border-light);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
    }

    .card-icon {
      width: 56px;
      height: 56px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
    }

    .card-icon.plan { background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(99, 102, 241, 0.2)); }
    .card-icon.support { background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2)); }

    .card-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .card-desc {
      font-size: 14px;
      color: var(--text-muted);
    }

    .plan-display {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: 16px;
      padding: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }

    .plan-info { display: flex; flex-direction: column; gap: 4px; }

    .plan-label {
      font-size: 13px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .plan-name {
      font-size: 1.5rem;
      font-weight: 800;
      color: var(--text-primary);
    }

    .plan-badge {
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
    }

    .plan-badge.active {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2));
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: var(--accent);
    }

    .plan-badge.free {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(251, 191, 36, 0.2));
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: var(--warning);
    }

    .plan-price {
      text-align: right;
    }

    .price-amount {
      font-size: 2rem;
      font-weight: 800;
      color: var(--text-primary);
    }

    .price-period {
      font-size: 14px;
      color: var(--text-muted);
    }

    .form-group { margin-bottom: 20px; }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .form-input {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 16px;
      font-family: inherit;
      transition: all 0.3s ease;
    }

    .form-input:focus {
      outline: none;
      border-color: var(--primary-light);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .form-input::placeholder { color: var(--text-muted); opacity: 0.6; }

    .form-hint {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 8px;
    }

    .features-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }

    .feature-item {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .feature-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(34, 197, 94, 0.15);
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .feature-icon svg { width: 12px; height: 12px; }

    @media (max-width: 640px) {
      .page-title { font-size: 1.5rem; }
      .card { padding: 24px; }
      .plan-display { flex-direction: column; gap: 16px; text-align: center; }
      .plan-price { text-align: center; }
      .header-inner { flex-wrap: wrap; gap: 12px; }
    }
  </style>
</head>
<body>
  <div class="page-bg"></div>

  <header class="header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      <div class="nav-actions">
        <a href="/app" class="nav-link">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
          Back to App
        </a>
      </div>
    </div>
  </header>

  <main class="container">
    <div class="page-header animate-fade-in">
      <h1 class="page-title">Billing & Support</h1>
      <p class="page-subtitle">Manage your subscription and get priority support</p>
    </div>

    <div class="card animate-fade-in animate-delay-1">
      <div class="card-header">
        <div class="card-icon plan">
          <svg width="28" height="28" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>
        </div>
        <div>
          <div class="card-title">Current Plan</div>
          <div class="card-desc">Your subscription details</div>
        </div>
      </div>

      <div class="plan-display">
        <div class="plan-info">
          <span class="plan-label">Plan</span>
          <span class="plan-name">${planName}</span>
          <span class="plan-badge ${paid ? "active" : "free"}">${paid ? "Active" : "Free Tier"}</span>
        </div>
        <div class="plan-price">
          <div class="price-amount">${planPrice}</div>
          <div class="price-period">${paid ? "/month" : "forever"}</div>
        </div>
      </div>

      <div class="features-list">
        <div class="feature-item">
          <span class="feature-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg></span>
          ${paid ? "Unlimited AI estimates" : "3 free estimates included"}
        </div>
        <div class="feature-item">
          <span class="feature-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg></span>
          ${paid ? "Professional PDF exports" : "Basic PDF exports"}
        </div>
        <div class="feature-item">
          <span class="feature-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg></span>
          ${paid ? "Priority support callbacks" : "Email support only"}
        </div>
      </div>

      <a href="${paid ? "/billing/portal" : "/pricing"}" class="btn ${paid ? "btn-secondary" : "btn-primary"}" style="width:100%;">
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        ${paid ? "Manage Subscription" : "Upgrade to Pro"}
      </a>
    </div>

    ${
      paid
        ? `
    <div class="card animate-fade-in animate-delay-2">
      <div class="card-header">
        <div class="card-icon support">
          <svg width="28" height="28" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
        </div>
        <div>
          <div class="card-title">Priority Support</div>
          <div class="card-desc">Get callbacks from our support team</div>
        </div>
      </div>

      <form method="POST" action="/update-phone">
        <input type="hidden" name="_csrf" value="${req.session!.csrfToken || ""}"/>
        <div class="form-group">
          <label class="form-label">Your Phone Number</label>
          <input type="tel" name="phone" class="form-input" placeholder="(815) 281-9268" value="${escapeHtml(user?.phone || "")}"/>
          <div class="form-hint">We'll call you back within 24 hours for any support requests</div>
        </div>
        <button type="submit" class="btn btn-accent" style="width:100%;">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          Save Phone Number
        </button>
      </form>
    </div>
    `
        : ""
    }
  </main>
</body>
</html>
  `);
  }),
);

app.get(
  "/billing/portal",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const email = req.session!.email!;
    let customerId = await getStripeCustomerIdOrNull(uid);
    if (!customerId) {
      customerId = await createStripeCustomer(email);
      await upsertStripeCustomer(uid, customerId);
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL}/billing`,
    });

    res.redirect(303, portal.url);
  }),
);

app.post(
  "/update-phone",
  requireAuth,
  validateCsrf,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const phone = String(req.body.phone || "").trim();

    await db
      .update(users)
      .set({ phone: phone || null })
      .where(eq(users.id, uid));

    res.redirect("/billing");
  }),
);

// --- Estimate Templates ---
app.get(
  "/templates",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const templatesList = await db
      .select()
      .from(estimateTemplates)
      .where(eq(estimateTemplates.userId, uid))
      .orderBy(desc(estimateTemplates.createdAt));
    res.json(templatesList);
  }),
);

app.post(
  "/templates",
  requireAuth,
  validateCsrf,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;

    const parseResult = templateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res
        .status(400)
        .json({ error: parseResult.error.issues[0].message });
    }
    const {
      name,
      jobType,
      market,
      details,
      clientName,
      clientEmail,
      clientPhone,
    } = parseResult.data;

    const id = crypto.randomUUID();
    const createdAt = now();

    try {
      await db.insert(estimateTemplates).values({
        id: id,
        userId: uid,
        name: name,
        jobType: jobType,
        market: market,
        details: details || null,
        clientName: clientName || null,
        clientEmail: clientEmail || null,
        clientPhone: clientPhone || null,
        createdAt: createdAt,
      });

      res.json({ success: true, id, name });
    } catch (e) {
      console.error("Error saving template:", e);
      res.status(500).json({ error: "Failed to save template" });
    }
  }),
);

app.delete(
  "/templates/:id",
  requireAuth,
  validateCsrf,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;

    const parseResult = idParamSchema.safeParse(req.params);
    if (!parseResult.success) {
      return res
        .status(400)
        .json({ error: parseResult.error.issues[0].message });
    }
    const templateId = parseResult.data.id;

    const result = await db
      .delete(estimateTemplates)
      .where(
        and(
          eq(estimateTemplates.id, templateId),
          eq(estimateTemplates.userId, uid),
        ),
      );

    res.json({ success: true });
  }),
);

// --- PDF Export ---
// Layout, footer, and Triple Guarantee trust bar all live in the shared
// builder (`server/lib/estimate-pdf-helpers.ts`). Both this download route
// and the email-attachment endpoint (`POST /api/estimates/:id/email`) call
// the same builder so the PDF the homeowner sees is byte-for-byte the same
// whether the contractor downloaded it locally or had us email it.
app.get(
  "/estimate/:id/pdf",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const estimateId = req.params.id;

    const prepared = await prepareEstimatePdfRender(uid, estimateId);
    if (!prepared) return res.status(404).send("Estimate not found");

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="estimate-${estimateId.slice(0, 8)}.pdf"`,
    );
    doc.pipe(res);
    prepared.render(doc);
    doc.end();
  }),
);

// --- Estimate History ---
app.get(
  "/history",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const sub = await getSub(uid);
    const paid = isPaidActive(sub);
    const userEmail = req.session?.email || "User";

    const estimatesList = await db
      .select({
        id: estimates.id,
        jobType: estimates.jobType,
        market: estimates.market,
        clientName: estimates.clientName,
        createdAt: estimates.createdAt,
      })
      .from(estimates)
      .where(eq(estimates.userId, uid))
      .orderBy(desc(estimates.createdAt))
      .limit(50);

    // Single-pass aggregation that powers both the per-estimate "PDF Views"
    // column (scoped to the latest 50 shown) and the dashboard rollup panel
    // (scoped to ALL of this user's estimates so it reflects long-term
    // engagement rather than recent activity only).
    const {
      perEstimate: badgeClickCounts,
      rollup: guaranteeTotals,
      trend: guaranteeTrend,
    } = await getGuaranteeBadgeClickStatsForUser(
      uid,
      estimatesList.map((e) => e.id),
      30,
    );
    const guaranteeMeta: Array<{
      key: "speed" | "win-jobs" | "money-back";
      label: string;
      tagline: string;
      color: string;
    }> = [
      {
        key: "speed",
        label: "Same-Week Start",
        tagline: "Speed promise",
        color: "#f59e0b",
      },
      {
        key: "win-jobs",
        label: "Win More Jobs",
        tagline: "Quality promise",
        color: "#6366f1",
      },
      {
        key: "money-back",
        label: "Money-Back Guarantee",
        tagline: "Risk-reversal",
        color: "#22c55e",
      },
    ];
    const guaranteeWinnerKey = guaranteeMeta.reduce<
      "speed" | "win-jobs" | "money-back" | null
    >((best, m) => {
      const c = guaranteeTotals.byGuarantee[m.key];
      if (c <= 0) return best;
      if (best === null) return m.key;
      return c > guaranteeTotals.byGuarantee[best] ? m.key : best;
    }, null);
    const guaranteeBars = guaranteeMeta
      .map((m) => {
        const count = guaranteeTotals.byGuarantee[m.key];
        const pct =
          guaranteeTotals.total > 0
            ? Math.round((count / guaranteeTotals.total) * 100)
            : 0;
        const isWinner = guaranteeWinnerKey === m.key;
        return `
        <div class="badge-rollup-row${isWinner ? " winner" : ""}">
          <div class="badge-rollup-row-head">
            <span class="badge-rollup-dot" style="background:${m.color}"></span>
            <span class="badge-rollup-label">${m.label}${isWinner ? ' <span class="badge-rollup-winner-pill">Top performer</span>' : ""}</span>
            <span class="badge-rollup-count">${count} click${count === 1 ? "" : "s"} <span class="badge-rollup-pct">(${pct}%)</span></span>
          </div>
          <div class="badge-rollup-bar-track">
            <div class="badge-rollup-bar-fill" style="width:${pct}%;background:${m.color}"></div>
          </div>
          <div class="badge-rollup-tagline">${m.tagline}</div>
        </div>`;
      })
      .join("");
    // Build a small multi-line SVG chart of clicks per day per guarantee for
    // the trend window. Rendered server-side as inline SVG so it has no JS
    // dependency and degrades cleanly if CSS fails to load.
    const trendChartHtml = (() => {
      const w = 720;
      const h = 140;
      const padL = 32;
      const padR = 12;
      const padT = 12;
      const padB = 22;
      const innerW = w - padL - padR;
      const innerH = h - padT - padB;
      const n = guaranteeTrend.days.length;
      const allCounts = guaranteeMeta.flatMap(
        (m) => guaranteeTrend.series[m.key],
      );
      const maxCount = Math.max(1, ...allCounts);
      const xFor = (i: number) =>
        n <= 1 ? padL + innerW / 2 : padL + (i * innerW) / (n - 1);
      const yFor = (v: number) => padT + innerH - (v / maxCount) * innerH;

      const yTicks = [0, Math.ceil(maxCount / 2), maxCount];
      const gridLines = yTicks
        .map((t) => {
          const y = yFor(t);
          return `<line x1="${padL}" y1="${y}" x2="${padL + innerW}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
                  <text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="Inter, sans-serif">${t}</text>`;
        })
        .join("");

      const fmtTick = (key: string) => {
        const d = new Date(`${key}T00:00:00Z`);
        return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      };
      const tickIdxs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
      const xLabels = tickIdxs
        .map((i) => {
          const x = xFor(i);
          return `<text x="${x}" y="${h - 6}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter, sans-serif">${fmtTick(guaranteeTrend.days[i])}</text>`;
        })
        .join("");

      const lines = guaranteeMeta
        .map((m) => {
          const series = guaranteeTrend.series[m.key];
          const totalForKey = series.reduce((a, b) => a + b, 0);
          const path = series
            .map(
              (v, i) =>
                `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`,
            )
            .join(" ");
          const dots =
            n === 1
              ? `<circle cx="${xFor(0)}" cy="${yFor(series[0])}" r="3" fill="${m.color}"/>`
              : "";
          return `<g aria-label="${m.label}: ${totalForKey} click${totalForKey === 1 ? "" : "s"} in last ${guaranteeTrend.windowDays} days">
            <path d="${path}" fill="none" stroke="${m.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>
            ${dots}
          </g>`;
        })
        .join("");

      const legend = guaranteeMeta
        .map((m) => {
          const totalForKey = guaranteeTrend.series[m.key].reduce(
            (a, b) => a + b,
            0,
          );
          return `<span class="badge-rollup-trend-legend-item">
            <span class="badge-rollup-trend-legend-dot" style="background:${m.color}"></span>
            <span class="badge-rollup-trend-legend-label">${m.label}</span>
            <span class="badge-rollup-trend-legend-count">${totalForKey}</span>
          </span>`;
        })
        .join("");

      const subtitle =
        guaranteeTrend.totalInWindow === 0
          ? `No badge clicks in the last ${guaranteeTrend.windowDays} days yet — send a few PDFs and check back.`
          : `${guaranteeTrend.totalInWindow} click${guaranteeTrend.totalInWindow === 1 ? "" : "s"} in the last ${guaranteeTrend.windowDays} days, split by guarantee.`;

      return `
      <div class="badge-rollup-trend">
        <div class="badge-rollup-trend-head">
          <div class="badge-rollup-trend-title">Click trend · last ${guaranteeTrend.windowDays} days</div>
          <div class="badge-rollup-trend-sub">${subtitle}</div>
        </div>
        <div class="badge-rollup-trend-chart">
          <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Trust badge clicks per day for the last ${guaranteeTrend.windowDays} days, split by guarantee">
            ${gridLines}
            ${lines}
            ${xLabels}
          </svg>
        </div>
        <div class="badge-rollup-trend-legend">${legend}</div>
      </div>`;
    })();

    const guaranteePanelInner =
      guaranteeTotals.total === 0
        ? `<div class="badge-rollup-empty">
            <div class="badge-rollup-empty-icon">📨</div>
            <div class="badge-rollup-empty-title">No badge clicks yet</div>
            <div class="badge-rollup-empty-text">Send your estimate PDFs to clients — every tap on a trust badge in the PDF lands here so you can see which guarantee is doing the most selling for you.</div>
          </div>`
        : `<div class="badge-rollup-rows">${guaranteeBars}</div>
           ${trendChartHtml}
           <div class="badge-rollup-footnote">Across all of your estimates · ${guaranteeTotals.total} total click${guaranteeTotals.total === 1 ? "" : "s"}</div>`;

    // Calculate stats
    const totalEstimatesCount = estimatesList.length;
    const thisMonth = new Date();
    const firstDayOfMonth = new Date(
      thisMonth.getFullYear(),
      thisMonth.getMonth(),
      1,
    ).getTime();
    const thisMonthEstimates = estimatesList.filter(
      (e) => e.createdAt >= firstDayOfMonth,
    ).length;
    const lastWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thisWeekEstimates = estimatesList.filter(
      (e) => e.createdAt >= lastWeek,
    ).length;

    const jobLabels: Record<string, string> = {
      tuckpointing: "Tuckpointing",
      chimney_rebuild: "Chimney Rebuild",
      retaining_wall: "Retaining Wall",
      concrete_flatwork: "Concrete Flatwork",
      roof_repair: "Roof Repair",
      general: "General Construction",
    };

    const jobColors: Record<string, string> = {
      tuckpointing: "#f59e0b",
      chimney_rebuild: "#ef4444",
      retaining_wall: "#8b5cf6",
      concrete_flatwork: "#06b6d4",
      roof_repair: "#ec4899",
      general: "#6366f1",
    };

    const rows = estimatesList
      .map(
        (e, index) => `
    <tr class="table-row ${index % 2 === 0 ? "even" : "odd"}">
      <td class="td-date">
        <div class="date-cell">
          <span class="date-day">${new Date(e.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <span class="date-year">${new Date(e.createdAt).getFullYear()}</span>
        </div>
      </td>
      <td>
        <span class="job-badge" style="background: ${jobColors[e.jobType] || "#6366f1"}20; color: ${jobColors[e.jobType] || "#6366f1"}; border: 1px solid ${jobColors[e.jobType] || "#6366f1"}40;">
          ${jobLabels[e.jobType] || e.jobType}
        </span>
      </td>
      <td class="td-market">
        <span class="market-text">📍 ${escapeHtml(e.market)}</span>
      </td>
      <td class="td-client">
        <span class="client-name">${escapeHtml(e.clientName || "—")}</span>
      </td>
      <td class="td-badge-clicks">
        <span class="badge-click-pill" title="Homeowner taps on the trust-badges in this estimate's PDF">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
          ${badgeClickCounts.get(e.id) || 0}
        </span>
      </td>
      <td class="td-actions">
        <div class="action-buttons">
          <a class="action-btn-small view" href="/estimate/${e.id}" title="View Estimate">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            <span>View</span>
          </a>
          <a class="action-btn-small pdf" href="/estimate/${e.id}/pdf" title="Download PDF">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <span>PDF</span>
          </a>
        </div>
      </td>
    </tr>
  `,
      )
      .join("");

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>Estimate History - ProBid AI</title>
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

    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    .animate-fade-in { animation: fadeInUp 0.5s ease-out forwards; }
    .animate-delay-1 { animation-delay: 0.1s; opacity: 0; }
    .animate-delay-2 { animation-delay: 0.2s; opacity: 0; }
    .animate-delay-3 { animation-delay: 0.3s; opacity: 0; }
    .animate-delay-4 { animation-delay: 0.4s; opacity: 0; }

    /* Dashboard Header */
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

    /* Main Container */
    .main-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    /* Page Header */
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
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .page-subtitle {
      color: var(--text-muted);
      font-size: 16px;
    }

    /* Stats Grid */
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
      margin-bottom: 12px;
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
    .stat-icon.month { background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2)); }
    .stat-icon.week { background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(251, 191, 36, 0.2)); }
    .stat-icon.types { background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(124, 58, 237, 0.2)); }

    /* Trust-Badge Click Rollup */
    .badge-rollup-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .badge-rollup-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .badge-rollup-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--text-primary);
    }
    .badge-rollup-title svg { color: var(--primary-light); }
    .badge-rollup-sub {
      font-size: 12px;
      color: var(--text-muted);
    }
    .badge-rollup-rows {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .badge-rollup-row {
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(11, 15, 25, 0.5);
      border: 1px solid var(--border-color);
    }
    .badge-rollup-row.winner {
      border-color: rgba(34, 197, 94, 0.45);
      box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.15) inset;
    }
    .badge-rollup-row-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .badge-rollup-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .badge-rollup-label {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge-rollup-winner-pill {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(34, 197, 94, 0.18);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.35);
    }
    .badge-rollup-count {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .badge-rollup-pct {
      color: var(--text-muted);
      font-weight: 500;
    }
    .badge-rollup-bar-track {
      height: 6px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      overflow: hidden;
    }
    .badge-rollup-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.4s ease;
      min-width: 2px;
    }
    .badge-rollup-tagline {
      margin-top: 6px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .badge-rollup-footnote {
      margin-top: 14px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: right;
    }
    .badge-rollup-empty {
      text-align: center;
      padding: 24px 16px;
    }
    .badge-rollup-empty-icon {
      font-size: 32px;
      margin-bottom: 8px;
    }
    .badge-rollup-empty-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 6px;
    }
    .badge-rollup-empty-text {
      font-size: 13px;
      color: var(--text-muted);
      max-width: 520px;
      margin: 0 auto;
      line-height: 1.5;
    }
    .badge-rollup-trend {
      margin-top: 18px;
      padding: 16px;
      border-radius: 12px;
      background: rgba(11, 15, 25, 0.5);
      border: 1px solid var(--border-color);
    }
    .badge-rollup-trend-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .badge-rollup-trend-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: 0.02em;
    }
    .badge-rollup-trend-sub {
      font-size: 12px;
      color: var(--text-muted);
    }
    .badge-rollup-trend-chart {
      width: 100%;
    }
    .badge-rollup-trend-chart svg {
      display: block;
      width: 100%;
      height: auto;
      max-height: 180px;
    }
    .badge-rollup-trend-legend {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      justify-content: flex-end;
    }
    .badge-rollup-trend-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .badge-rollup-trend-legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .badge-rollup-trend-legend-label {
      color: var(--text-primary);
      font-weight: 600;
    }
    .badge-rollup-trend-legend-count {
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 800;
      color: var(--text-primary);
    }

    .stat-subtext {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* Search and Filter Bar */
    .toolbar {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
    }

    .search-box {
      flex: 1;
      max-width: 400px;
      position: relative;
    }

    .search-input {
      width: 100%;
      padding: 14px 16px 14px 48px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: var(--bg-card);
      color: var(--text-primary);
      font-size: 15px;
      font-family: inherit;
      transition: all 0.3s ease;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--primary-light);
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
    }

    .search-input::placeholder {
      color: rgba(148, 163, 184, 0.6);
    }

    .search-icon {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
    }

    .filter-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .filter-btn {
      padding: 10px 18px;
      border-radius: 10px;
      border: 1px solid var(--border-color);
      background: var(--bg-card);
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .filter-btn:hover {
      border-color: var(--border-light);
      color: var(--text-primary);
    }

    .filter-btn.active {
      background: rgba(79, 70, 229, 0.1);
      border-color: var(--primary-light);
      color: var(--primary-light);
    }

    /* Quick Actions */
    .quick-actions {
      display: flex;
      gap: 12px;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 24px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }

    .action-btn.primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
    }

    .action-btn.primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4);
    }

    .action-btn.secondary {
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
    }

    .action-btn.secondary:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
    }

    /* Table Card */
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
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .table-count {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }

    /* Table Styles */
    .data-table {
      width: 100%;
      border-collapse: collapse;
    }

    .data-table thead {
      background: rgba(0, 0, 0, 0.2);
    }

    .data-table th {
      padding: 16px 20px;
      text-align: left;
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border-color);
    }

    .data-table td {
      padding: 16px 20px;
      font-size: 14px;
      color: var(--text-primary);
      border-bottom: 1px solid rgba(34, 48, 77, 0.3);
    }

    /* Zebra Striping */
    .table-row.odd {
      background: rgba(0, 0, 0, 0.1);
    }

    .table-row.even {
      background: transparent;
    }

    /* Hover Effect */
    .table-row {
      transition: all 0.2s ease;
    }

    .table-row:hover {
      background: rgba(79, 70, 229, 0.08);
      transform: scale(1.002);
    }

    .table-row:last-child td {
      border-bottom: none;
    }

    /* Date Cell */
    .date-cell {
      display: flex;
      flex-direction: column;
    }

    .date-day {
      font-weight: 600;
      color: var(--text-primary);
    }

    .date-year {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Job Type Badge */
    .job-badge {
      display: inline-flex;
      align-items: center;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
    }

    /* Market Text */
    .market-text {
      color: var(--text-muted);
      font-size: 14px;
    }

    /* Client Name */
    .client-name {
      font-weight: 500;
      color: var(--text-primary);
    }

    /* PDF badge click pill */
    .badge-click-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.25);
    }

    /* Action Buttons */
    .action-buttons {
      display: flex;
      gap: 8px;
    }

    .action-btn-small {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 8px 14px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 13px;
      transition: all 0.2s ease;
    }

    .action-btn-small.view {
      color: var(--primary-light);
      background: rgba(79, 70, 229, 0.1);
      border: 1px solid rgba(79, 70, 229, 0.2);
    }

    .action-btn-small.view:hover {
      background: rgba(79, 70, 229, 0.2);
      border-color: var(--primary-light);
      transform: translateY(-1px);
    }

    .action-btn-small.pdf {
      color: var(--accent);
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.2);
    }

    .action-btn-small.pdf:hover {
      background: rgba(34, 197, 94, 0.2);
      border-color: var(--accent);
      transform: translateY(-1px);
    }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 80px 40px;
    }

    .empty-icon {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(79, 70, 229, 0.1));
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }

    .empty-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 12px;
    }

    .empty-text {
      color: var(--text-muted);
      font-size: 16px;
      margin-bottom: 32px;
      max-width: 400px;
      margin-left: auto;
      margin-right: auto;
    }

    .empty-cta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 16px 32px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
      transition: all 0.3s ease;
    }

    .empty-cta:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(79, 70, 229, 0.5);
    }

    /* Mobile Table */
    .mobile-card {
      display: none;
    }

    /* Responsive */
    @media (max-width: 1024px) {
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 768px) {
      .header-inner {
        flex-wrap: wrap;
      }

      .user-details {
        display: none;
      }

      .nav-actions {
        flex-wrap: wrap;
      }

      .nav-link span {
        display: none;
      }

      .stats-grid {
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }

      .stat-card {
        padding: 16px;
      }

      .stat-value {
        font-size: 1.5rem;
      }

      .toolbar {
        flex-direction: column;
        align-items: stretch;
      }

      .search-box {
        max-width: none;
      }

      .filter-buttons {
        justify-content: flex-start;
      }

      /* Hide table on mobile, show cards */
      .table-wrapper {
        display: none;
      }

      .mobile-cards {
        display: block;
      }

      .mobile-card {
        display: block;
        background: rgba(0, 0, 0, 0.1);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 12px;
        border: 1px solid var(--border-color);
        transition: all 0.2s ease;
      }

      .mobile-card:hover {
        border-color: var(--border-light);
      }

      .mobile-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 12px;
      }

      .mobile-card-date {
        font-size: 13px;
        color: var(--text-muted);
      }

      .mobile-card-body {
        margin-bottom: 12px;
      }

      .mobile-card-row {
        display: flex;
        justify-content: space-between;
        padding: 6px 0;
        border-bottom: 1px solid rgba(34, 48, 77, 0.2);
      }

      .mobile-card-row:last-child {
        border-bottom: none;
      }

      .mobile-card-label {
        font-size: 12px;
        color: var(--text-muted);
        text-transform: uppercase;
      }

      .mobile-card-value {
        font-size: 14px;
        color: var(--text-primary);
        font-weight: 500;
      }

      .mobile-card-actions {
        display: flex;
        gap: 8px;
      }

      .mobile-card-actions .action-btn-small {
        flex: 1;
        justify-content: center;
      }
    }

    @media (max-width: 480px) {
      .main-container {
        padding: 16px;
      }

      .page-title {
        font-size: 1.5rem;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }

      .quick-actions {
        flex-direction: column;
      }

      .action-btn {
        justify-content: center;
      }
    }

    /* Table wrapper for desktop */
    .table-wrapper {
      overflow-x: auto;
    }

    .mobile-cards {
      display: none;
      padding: 16px;
    }

    @media (max-width: 768px) {
      .mobile-cards {
        display: block;
      }
    }
  </style>
</head>
<body>
  <!-- Dashboard Header -->
  <header class="dashboard-header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      
      <div class="nav-actions">
        <a href="/app" class="nav-link">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          <span>New Estimate</span>
        </a>
        <a href="/history" class="nav-link active">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span>History</span>
        </a>
        <a href="/leads" class="nav-link">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>
          <span>Leads</span>
        </a>
        ${
          paid
            ? `<a href="/billing" class="nav-link">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>
          <span>Billing</span>
        </a>`
            : ""
        }
        <span class="plan-badge ${paid ? "paid" : "free"}">${paid ? "Pro" : "Free"}</span>
      </div>

      <div class="user-info">
        <div class="user-avatar">${escapeHtml(userEmail.charAt(0).toUpperCase())}</div>
        <div class="user-details">
          <span class="user-email">${escapeHtml(userEmail)}</span>
          <span class="user-plan">${paid ? "Pro Plan" : "Free Plan"}</span>
        </div>
        <a href="/logout" class="nav-link">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
        </a>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main class="main-container">
    <!-- Page Header -->
    <div class="page-header animate-fade-in">
      <h1 class="page-title">
        <svg width="32" height="32" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        Estimate History
      </h1>
      <p class="page-subtitle">View and manage all your generated estimates</p>
    </div>

    <!-- Trust-Badge Click Rollup -->
    <section class="badge-rollup-card animate-fade-in" aria-label="Trust badge clicks across all estimates">
      <div class="badge-rollup-head">
        <div class="badge-rollup-title">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
          Which trust badge homeowners click most
        </div>
        <span class="badge-rollup-sub">Aggregated across every estimate you've sent</span>
      </div>
      ${guaranteePanelInner}
    </section>

    <!-- Stats Grid -->
    <div class="stats-grid">
      <div class="stat-card animate-fade-in animate-delay-1">
        <div class="stat-header">
          <div class="stat-icon total">📊</div>
        </div>
        <div class="stat-label">Total Estimates</div>
        <div class="stat-value">${totalEstimatesCount}</div>
        <div class="stat-subtext">All time</div>
      </div>
      <div class="stat-card animate-fade-in animate-delay-2">
        <div class="stat-header">
          <div class="stat-icon month">📅</div>
        </div>
        <div class="stat-label">This Month</div>
        <div class="stat-value">${thisMonthEstimates}</div>
        <div class="stat-subtext">${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>
      </div>
      <div class="stat-card animate-fade-in animate-delay-3">
        <div class="stat-header">
          <div class="stat-icon week">⚡</div>
        </div>
        <div class="stat-label">This Week</div>
        <div class="stat-value">${thisWeekEstimates}</div>
        <div class="stat-subtext">Last 7 days</div>
      </div>
      <div class="stat-card animate-fade-in animate-delay-4">
        <div class="stat-header">
          <div class="stat-icon types">🏗️</div>
        </div>
        <div class="stat-label">Job Types</div>
        <div class="stat-value">${new Set(estimatesList.map((e) => e.jobType)).size}</div>
        <div class="stat-subtext">Unique categories</div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar animate-fade-in">
      <div class="search-box">
        <svg class="search-icon" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        <input type="text" class="search-input" placeholder="Search estimates by client, job type, or region...">
      </div>
      <div class="filter-buttons">
        <button class="filter-btn active">All</button>
        <button class="filter-btn">This Week</button>
        <button class="filter-btn">This Month</button>
      </div>
      <div class="quick-actions">
        <a href="/app" class="action-btn primary">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          New Estimate
        </a>
      </div>
    </div>

    <!-- Table Card -->
    <div class="table-card animate-fade-in">
      <div class="table-header">
        <div class="table-title">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          Recent Estimates
        </div>
        <span class="table-count">${totalEstimatesCount} estimate${totalEstimatesCount !== 1 ? "s" : ""}</span>
      </div>

      ${
        estimatesList.length === 0
          ? `<div class="empty-state">
            <div class="empty-icon">📋</div>
            <h3 class="empty-title">No Estimates Yet</h3>
            <p class="empty-text">You haven't created any estimates yet. Start by generating your first AI-powered construction estimate.</p>
            <a href="/app" class="empty-cta">
              <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
              Create Your First Estimate
            </a>
          </div>`
          : `
          <!-- Desktop Table -->
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Job Type</th>
                  <th>Region</th>
                  <th>Client</th>
                  <th title="Homeowner taps on the trust-badges in this estimate's PDF">PDF Views</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>

          <!-- Mobile Cards -->
          <div class="mobile-cards">
            ${estimatesList
              .map(
                (e, index) => `
              <div class="mobile-card">
                <div class="mobile-card-header">
                  <span class="job-badge" style="background: ${jobColors[e.jobType] || "#6366f1"}20; color: ${jobColors[e.jobType] || "#6366f1"}; border: 1px solid ${jobColors[e.jobType] || "#6366f1"}40;">
                    ${jobLabels[e.jobType] || e.jobType}
                  </span>
                  <span class="mobile-card-date">${new Date(e.createdAt).toLocaleDateString()}</span>
                </div>
                <div class="mobile-card-body">
                  <div class="mobile-card-row">
                    <span class="mobile-card-label">Region</span>
                    <span class="mobile-card-value">📍 ${escapeHtml(e.market)}</span>
                  </div>
                  <div class="mobile-card-row">
                    <span class="mobile-card-label">Client</span>
                    <span class="mobile-card-value">${escapeHtml(e.clientName || "—")}</span>
                  </div>
                  <div class="mobile-card-row">
                    <span class="mobile-card-label">PDF Views</span>
                    <span class="mobile-card-value">👀 ${badgeClickCounts.get(e.id) || 0}</span>
                  </div>
                </div>
                <div class="mobile-card-actions">
                  <a class="action-btn-small view" href="/estimate/${e.id}">
                    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                    View
                  </a>
                  <a class="action-btn-small pdf" href="/estimate/${e.id}/pdf">
                    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                    PDF
                  </a>
                </div>
              </div>
            `,
              )
              .join("")}
          </div>
        `
      }
    </div>
  </main>

  <script>
    // Search functionality (placeholder - client-side filtering)
    document.querySelector('.search-input')?.addEventListener('input', function(e) {
      const query = e.target.value.toLowerCase();
      document.querySelectorAll('.table-row').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? '' : 'none';
      });
      document.querySelectorAll('.mobile-card').forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? '' : 'none';
      });
    });

    // Filter button clicks (placeholder)
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
      });
    });
  </script>
</body>
</html>
  `);
  }),
);

// --- View single estimate ---
app.get(
  "/estimate/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.session!.uid!;
    const estimateId = req.params.id;

    const estimateResult = await db
      .select()
      .from(estimates)
      .where(and(eq(estimates.id, estimateId), eq(estimates.userId, uid)));
    const estimate = estimateResult[0];
    if (!estimate) return res.status(404).send("Estimate not found");

    // Per-guarantee click breakdown for this estimate. Filtered server-side
    // to this estimate id (already authorized above) and grouped by guarantee
    // variant in SQL so the read cost scales with the clicks on this single
    // estimate instead of the entire analytics history.
    const badgeClickStats: Record<string, number> = {
      total: 0,
      speed: 0,
      "win-jobs": 0,
      "money-back": 0,
    };
    const badgeClickRows = await db
      .select({
        utmContent: guaranteeBadgeClicks.utmContent,
        total: count(),
      })
      .from(guaranteeBadgeClicks)
      .where(eq(guaranteeBadgeClicks.estimateId, estimateId))
      .groupBy(guaranteeBadgeClicks.utmContent);
    for (const row of badgeClickRows) {
      const n = Number(row.total);
      badgeClickStats.total += n;
      const c = row.utmContent;
      if (c === "speed" || c === "win-jobs" || c === "money-back") {
        badgeClickStats[c] += n;
      }
    }

    const jobLabels: Record<string, string> = {
      tuckpointing: "Tuckpointing",
      chimney_rebuild: "Chimney Rebuild",
      retaining_wall: "Retaining Wall",
      concrete_flatwork: "Concrete Flatwork",
      roof_repair: "Roof Repair",
      general: "General Construction",
    };

    const jobIcons: Record<string, string> = {
      tuckpointing: "&#x1F9F1;",
      chimney_rebuild: "&#x1F3E0;",
      retaining_wall: "&#x1F9F1;",
      concrete_flatwork: "&#x1F6A7;",
      roof_repair: "&#x1F3E0;",
      general: "&#x1F528;",
    };

    const formattedDate = new Date(estimate.createdAt).toLocaleDateString(
      "en-US",
      {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      },
    );

    res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION || ""}" />
  <title>${jobLabels[estimate.jobType] || estimate.jobType} Estimate - ProBid AI</title>
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

    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .animate-fade-in { animation: fadeInUp 0.5s ease-out forwards; }
    .animate-delay-1 { animation-delay: 0.1s; opacity: 0; }
    .animate-delay-2 { animation-delay: 0.2s; opacity: 0; }
    .animate-delay-3 { animation-delay: 0.3s; opacity: 0; }

    .page-bg {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 25%, #0f172a 50%, #1e1b4b 75%, #0a0e1a 100%);
      background-size: 400% 400%;
      animation: gradientShift 15s ease infinite;
      z-index: 0;
    }

    .header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(10, 14, 26, 0.9);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-color);
      padding: 16px 0;
    }

    .header-inner {
      max-width: 1000px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
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

    .nav-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 20px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      color: white;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
      box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(79, 70, 229, 0.4);
    }

    .btn-secondary {
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-light);
      transform: translateY(-1px);
    }

    .btn-accent {
      color: var(--text-dark);
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 4px 16px rgba(34, 197, 94, 0.3);
    }

    .btn-accent:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(34, 197, 94, 0.4);
    }

    .container {
      position: relative;
      z-index: 10;
      max-width: 1000px;
      margin: 0 auto;
      padding: 40px 24px;
    }

    .estimate-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }

    .estimate-info { flex: 1; min-width: 280px; }

    .estimate-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(99, 102, 241, 0.2));
      border: 1px solid var(--border-light);
      font-size: 14px;
      font-weight: 600;
      color: var(--primary-light);
      margin-bottom: 16px;
    }

    .estimate-title {
      font-size: 2rem;
      font-weight: 800;
      margin-bottom: 8px;
      background: linear-gradient(135deg, var(--text-primary) 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .estimate-date {
      color: var(--text-muted);
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .estimate-actions { display: flex; gap: 10px; flex-wrap: wrap; }

    .card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 32px;
      margin-bottom: 24px;
      transition: all 0.3s ease;
    }

    .card:hover {
      border-color: var(--border-light);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
    }

    .card-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
    }

    .card-icon.client { background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(22, 163, 74, 0.2)); }
    .card-icon.views { background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.2)); }

    .badge-clicks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px;
    }

    .badge-clicks-tile {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 16px;
      background: var(--bg-input);
      border: 1px solid var(--border-color);
      border-radius: 12px;
    }

    .badge-clicks-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .badge-clicks-value {
      font-size: 1.75rem;
      font-weight: 800;
      color: var(--text-primary);
      line-height: 1;
    }

    .badge-clicks-tile.total .badge-clicks-value {
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .badge-clicks-help {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 16px;
      line-height: 1.6;
    }

    .card-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .client-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 20px;
    }

    .client-item { display: flex; flex-direction: column; gap: 4px; }

    .client-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .client-value {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .estimate-content {
      background: var(--bg-input);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 28px;
      font-size: 15px;
      line-height: 1.8;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: var(--text-primary);
    }

    .estimate-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid var(--border-color);
      flex-wrap: wrap;
      gap: 16px;
    }

    .footer-info {
      font-size: 13px;
      color: var(--text-muted);
    }

    .footer-actions { display: flex; gap: 10px; flex-wrap: wrap; }

    @media (max-width: 768px) {
      .estimate-title { font-size: 1.5rem; }
      .card { padding: 24px; }
      .estimate-header { flex-direction: column; }
      .estimate-actions { width: 100%; }
      .estimate-actions .btn { flex: 1; }
      .header-inner { flex-wrap: wrap; gap: 12px; }
    }

    @media (max-width: 480px) {
      .container { padding: 24px 16px; }
      .client-grid { grid-template-columns: 1fr; }
      .footer-actions { width: 100%; flex-direction: column; }
      .footer-actions .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="page-bg"></div>

  <header class="header">
    <div class="header-inner">
      <a href="/" class="logo">ProBid AI</a>
      <div class="nav-actions">
        <a href="/history" class="btn btn-secondary">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
          History
        </a>
        <a href="/app" class="btn btn-primary">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          New Estimate
        </a>
      </div>
    </div>
  </header>

  <main class="container">
    <div class="estimate-header animate-fade-in">
      <div class="estimate-info">
        <div class="estimate-badge">
          <span>${jobIcons[estimate.jobType] || "&#x1F4CB;"}</span>
          ${jobLabels[estimate.jobType] || estimate.jobType}
        </div>
        <h1 class="estimate-title">${jobLabels[estimate.jobType] || estimate.jobType} Estimate</h1>
        <div class="estimate-date">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          ${formattedDate}
        </div>
      </div>
      <div class="estimate-actions">
        <a href="/estimate/${estimateId}/pdf" class="btn btn-accent">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          Download PDF
        </a>
      </div>
    </div>

    ${
      estimate.clientName || estimate.clientEmail || estimate.clientPhone
        ? `
    <div class="card animate-fade-in animate-delay-1">
      <div class="card-header">
        <div class="card-icon client">
          <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
        </div>
        <div class="card-title">Client Information</div>
      </div>
      <div class="client-grid">
        ${
          estimate.clientName
            ? `
        <div class="client-item">
          <span class="client-label">Name</span>
          <span class="client-value">${escapeHtml(estimate.clientName)}</span>
        </div>
        `
            : ""
        }
        ${
          estimate.clientEmail
            ? `
        <div class="client-item">
          <span class="client-label">Email</span>
          <span class="client-value">${escapeHtml(estimate.clientEmail)}</span>
        </div>
        `
            : ""
        }
        ${
          estimate.clientPhone
            ? `
        <div class="client-item">
          <span class="client-label">Phone</span>
          <span class="client-value">${escapeHtml(estimate.clientPhone)}</span>
        </div>
        `
            : ""
        }
      </div>
    </div>
    `
        : ""
    }

    <div class="card animate-fade-in animate-delay-1">
      <div class="card-header">
        <div class="card-icon views">
          <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
        </div>
        <div class="card-title">PDF Trust Badge Views</div>
      </div>
      <div class="badge-clicks-grid">
        <div class="badge-clicks-tile total">
          <span class="badge-clicks-label">Total clicks</span>
          <span class="badge-clicks-value">${badgeClickStats.total}</span>
        </div>
        <div class="badge-clicks-tile">
          <span class="badge-clicks-label">⚡ Speed</span>
          <span class="badge-clicks-value">${badgeClickStats.speed}</span>
        </div>
        <div class="badge-clicks-tile">
          <span class="badge-clicks-label">🏆 Win Jobs</span>
          <span class="badge-clicks-value">${badgeClickStats["win-jobs"]}</span>
        </div>
        <div class="badge-clicks-tile">
          <span class="badge-clicks-label">↩️ Money-Back</span>
          <span class="badge-clicks-value">${badgeClickStats["money-back"]}</span>
        </div>
      </div>
      <p class="badge-clicks-help">
        ${badgeClickStats.total === 0
          ? "No homeowners have tapped a trust badge in this estimate's PDF yet. Send the PDF to your client to start tracking interest."
          : "Counts homeowner taps on the speed, win-jobs, and money-back badges in this estimate's PDF — a strong signal that your client is engaging with your guarantees."}
      </p>
    </div>

    <div class="card animate-fade-in animate-delay-2">
      <div class="card-header">
        <div class="card-icon" style="background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(99, 102, 241, 0.2));">
          <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        </div>
        <div class="card-title">Estimate Details</div>
      </div>
      <div class="estimate-content">${escapeHtml(estimate.estimateText)}</div>
      <div class="estimate-footer">
        <div class="footer-info">
          Estimate ID: ${estimateId.slice(0, 8)}... | Market: ${escapeHtml(estimate.market)}
        </div>
        <div class="footer-actions">
          <a href="/estimate/${estimateId}/pdf" class="btn btn-accent">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            Download PDF
          </a>
          <a href="/app" class="btn btn-primary">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            New Estimate
          </a>
        </div>
      </div>
    </div>
  </main>
</body>
</html>
  `);
  }),
);

}
