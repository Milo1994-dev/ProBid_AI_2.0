import express from "express";
import fs from "fs";
import path from "path";
import rateLimit from "express-rate-limit";
import { renderHomepageSSR, renderPricingSSR, renderAccuracySSR } from "../ssr.js";
import OpenAI from "openai";
import { z } from "zod";
import { db, pool } from "../db.js";
import { eq, and, desc, count, sql } from "drizzle-orm";
import {
  users,
  referrals,
  referralLeads,
  homepageLeads,
  emailDripQueue,
  seoPages,
} from "../../shared/schema.js";
import { asyncHandler } from "../lib/middleware.js";
import { log } from "../lib/logger.js";
import { APP_URL, CANONICAL_URL } from "../lib/config.js";
import { sendHomepageLeadConfirmationEmail } from "../lib/email-helpers.js";
import { trackEvent } from "../lib/analytics.js";
import { fireServerConversions } from "../lib/ad-conversions.js";
import { escapeHtml } from "../lib/utils.js";
import { trackAffiliateClick } from "../lib/affiliate-helpers.js";
import { getResendClient, sendEmailWithRetry } from "../resend-client.js";
import { scheduleEmailDrip } from "../lib/drip-templates.js";
import * as metricsEngine from "../metrics-engine.js";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

export function registerMarketingRoutes(app: express.Application) {

app.get("/api/ad-config", (_req, res) => {
  const googleAdsConversions: Record<string, string> = {};
  const rawConversions = process.env.GOOGLE_ADS_CONVERSIONS;
  if (rawConversions) {
    try {
      const pairs = rawConversions.split(",");
      for (const pair of pairs) {
        const [key, label] = pair.split(":");
        if (key && label) googleAdsConversions[key.trim()] = label.trim();
      }
    } catch {}
  }

  res.json({
    success: true,
    data: {
      metaPixelId: process.env.META_PIXEL_ID || null,
      googleAdsId: process.env.GOOGLE_ADS_ID || null,
      googleAdsConversions,
    },
  });
});

// POST /api/leads/homepage — lead capture from landing page (no auth required)
app.post(
  "/api/leads/homepage",
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1, "Name is required").max(200),
      email: z.string().email("Invalid email address"),
      tradeType: z.string().min(1, "Trade type is required").max(100),
      description: z.string().max(2000).optional(),
      // Browser-generated event ID forwarded to Meta CAPI so the server-side
      // Lead event dedupes against the browser pixel's Lead event. Bounded
      // length, opaque value.
      meta_event_id: z.string().min(1).max(120).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid input",
        });
    }
    const { name, email, tradeType, description, meta_event_id: metaEventId } = parsed.data;

    // Insert lead (idempotent — duplicate email is non-fatal)
    try {
      await db.insert(homepageLeads).values({
        name,
        email,
        tradeType,
        projectDescription: description ?? null,
        createdAt: Date.now(),
      });
    } catch (insertErr: unknown) {
      // Allow duplicate-key (23505) to pass silently; re-throw real DB failures
      const errCode = (insertErr as { code?: string })?.code;
      if (errCode !== "23505") {
        log("error", "Homepage lead insert error", {
          email: email.replace(/(?<=.{2}).(?=.*@)/g, "*"),
          error: String(insertErr),
        });
      }
      // In both cases we continue — the visitor still gets the confirmation email
    }

    const maskedEmail = email.replace(/(?<=.{2}).(?=.*@)/g, "*");
    log("info", "Homepage lead captured", { email: maskedEmail, tradeType });

    fireServerConversions("lead", { email, sourceUrl: "https://probidcore.net", userAgent: req.headers["user-agent"], clientIp: req.ip, eventId: metaEventId }).catch(() => {});

    // Send immediate confirmation email (fire-and-forget — don't block response)
    sendHomepageLeadConfirmationEmail(name, email, tradeType).catch((err) =>
      log("warn", "Homepage lead confirmation email failed", {
        email: maskedEmail,
        error: String(err),
      }),
    );

    const normalizedEmail = email.toLowerCase();
    const createdAtISO = new Date().toISOString();
    const homepageDripSchedule = [
      { templateKey: "day3_upgrade", daysFromNow: 3 },
      { templateKey: "day7_upgrade", daysFromNow: 7 },
    ];
    for (const item of homepageDripSchedule) {
      const scheduledFor = new Date();
      scheduledFor.setDate(scheduledFor.getDate() + item.daysFromNow);
      scheduledFor.setHours(9, 0, 0, 0);
      db.insert(emailDripQueue)
        .values({
          email: normalizedEmail,
          userId: null,
          templateKey: item.templateKey,
          scheduledFor: scheduledFor.toISOString(),
          status: "pending",
          createdAt: createdAtISO,
        })
        .onConflictDoNothing()
        .catch(err => log("warn", "homepage drip enqueue failed", { error: err?.message }));
    }

    res.json({ success: true, data: null });
  }),
);
// === React SPA — serve index.html for all user-facing routes ===
// These handlers are registered BEFORE the legacy SSR pages below so Express
// matches them first and the SSR HTML is never reached for these paths.
const serveSpa: express.RequestHandler = (_req, res) => {
  const spaIndex = path.join(process.cwd(), "client", "dist", "index.html");
  if (fs.existsSync(spaIndex)) {
    res.sendFile(spaIndex);
  } else {
    res.status(503).send("Client not built. Run: npm run build:client");
  }
};

const publicBenchmarkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests — please try again later." },
});

app.get("/api/public/benchmarks", publicBenchmarkLimiter, asyncHandler(async (_req, res) => {
  try {
    const data = await metricsEngine.getPublicBenchmarkData();
    res.set("Cache-Control", "public, max-age=3600");
    res.json({ success: true, data });
  } catch (err) {
    log("error", "Failed to fetch public benchmarks", { error: String(err) });
    res.status(500).json({ success: false, error: "Failed to fetch benchmarks" });
  }
}));

app.get("/accuracy", asyncHandler(async (_req, res, next) => {
  try {
    const data = await metricsEngine.getPublicBenchmarkData();
    res.set("Cache-Control", "public, max-age=3600");
    res.type("html").send(renderAccuracySSR(data));
  } catch {
    serveSpa(_req, res, next);
  }
}));

app.get("/", asyncHandler(async (_req, res, next) => {
  try {
    let benchmarkN: number | null = null;
    try {
      const benchData = await metricsEngine.getPublicBenchmarkData();
      benchmarkN = benchData.overall?.sampleSize ?? null;
    } catch {
    }
    res.type("html").send(renderHomepageSSR(benchmarkN));
  } catch {
    serveSpa(_req, res, next);
  }
}));
app.get("/login", serveSpa);
app.get("/signup", serveSpa);
app.get("/pricing", (_req, res, next) => {
  try {
    res.type("html").send(renderPricingSSR());
  } catch {
    serveSpa(_req, res, next);
  }
});
app.get("/marketing-kit", serveSpa);
app.get("/success", serveSpa);
app.get("/checkout", serveSpa);
app.get("/checkout/:path", serveSpa);
app.get("/billing", serveSpa);
app.get("/app", serveSpa);
app.get("/app/*", serveSpa);
app.get("/templates", serveSpa);
app.get("/affiliate", serveSpa);
app.get("/estimate/new", serveSpa);
app.get("/video", serveSpa);
// ============================================================
// Sitemap for SEO — includes all 96+ dynamic guide pages
app.get("/sitemap.xml", async (req, res) => {
  const CANONICAL = "https://probidcore.net";
  const today = new Date().toISOString().split("T")[0];

  const corePages = [
    { loc: "/", priority: "1.0", changefreq: "daily" },
    { loc: "/pricing", priority: "0.8", changefreq: "weekly" },
    { loc: "/accuracy", priority: "0.9", changefreq: "daily" },
    { loc: "/guides", priority: "0.8", changefreq: "weekly" },
    { loc: "/estimate/tuckpointing", priority: "0.9", changefreq: "weekly" },
    { loc: "/estimate/chimney-repair", priority: "0.9", changefreq: "weekly" },
    { loc: "/estimate/retaining-wall", priority: "0.9", changefreq: "weekly" },
    { loc: "/estimate/brick-repair", priority: "0.9", changefreq: "weekly" },
    { loc: "/estimate/concrete-flatwork", priority: "0.9", changefreq: "weekly" },
    { loc: "/refer", priority: "0.6", changefreq: "monthly" },
    { loc: "/about", priority: "0.7", changefreq: "monthly" },
    { loc: "/contact", priority: "0.6", changefreq: "monthly" },
    { loc: "/terms", priority: "0.3", changefreq: "monthly" },
    { loc: "/privacy", priority: "0.3", changefreq: "monthly" },
  ];

  let guidePages: { loc: string; priority: string; changefreq: string }[] = [];
  try {
    const slugs = await db
      .select({ slug: seoPages.slug })
      .from(seoPages);
    guidePages = slugs.map((p) => ({
      loc: `/guide/${p.slug}`,
      priority: "0.7",
      changefreq: "monthly",
    }));
  } catch {
    // fallback — if DB fails, still serve core pages
  }

  const allPages = [...corePages, ...guidePages];
  const urls = allPages
    .map(
      (p) => `
  <url>
    <loc>${CANONICAL}${p.loc}</loc>
    <lastmod>${today}</lastmod>
    <priority>${p.priority}</priority>
    <changefreq>${p.changefreq}</changefreq>
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
Disallow: /app/
Disallow: /api/
Disallow: /admin/

Sitemap: https://probidcore.net/sitemap.xml`);
});
app.get(
  "/refer",
  asyncHandler(async (req, res) => {
    const refCode = (req.query.ref as string) || "";

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ProBid AI - AI-Powered Construction Estimates in 60 Seconds</title>
  <meta name="description" content="Generate professional construction estimates in under 60 seconds. AI-powered accuracy for contractors who want to win more jobs.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #0a0e1a 0%, #1a1f35 100%);
      min-height: 100vh;
      color: #e8f0ff;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    .header {
      text-align: center;
      margin-bottom: 60px;
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #22c55e;
      margin-bottom: 8px;
    }
    .tagline {
      color: #94a3b8;
      font-size: 16px;
    }
    .hero {
      text-align: center;
      margin-bottom: 60px;
    }
    .hero h1 {
      font-size: 48px;
      font-weight: 800;
      line-height: 1.2;
      margin-bottom: 24px;
      background: linear-gradient(135deg, #e8f0ff 0%, #22c55e 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero p {
      font-size: 20px;
      color: #94a3b8;
      max-width: 600px;
      margin: 0 auto 40px;
      line-height: 1.6;
    }
    .signup-form {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(79, 70, 229, 0.3);
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      margin: 0 auto 60px;
    }
    .signup-form h2 {
      font-size: 24px;
      margin-bottom: 8px;
      color: #e8f0ff;
    }
    .signup-form .subtitle {
      color: #94a3b8;
      margin-bottom: 24px;
      font-size: 15px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    .form-group input {
      width: 100%;
      padding: 16px 20px;
      font-size: 16px;
      border: 1px solid rgba(79, 70, 229, 0.4);
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.3);
      color: #e8f0ff;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .form-group input:focus {
      outline: none;
      border-color: #22c55e;
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
    }
    .form-group input::placeholder {
      color: #64748b;
    }
    .submit-btn {
      width: 100%;
      padding: 16px 32px;
      font-size: 18px;
      font-weight: 700;
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      color: #0b0f19;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .submit-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(34, 197, 94, 0.4);
    }
    .submit-btn:disabled {
      opacity: 0.7;
      cursor: not-allowed;
      transform: none;
    }
    .success-message {
      display: none;
      text-align: center;
      padding: 20px;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.4);
      border-radius: 10px;
      color: #22c55e;
      margin-top: 20px;
    }
    .error-message {
      display: none;
      text-align: center;
      padding: 20px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 10px;
      color: #ef4444;
      margin-top: 20px;
    }
    .benefits {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 30px;
      margin-bottom: 60px;
    }
    .benefit-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(79, 70, 229, 0.2);
      border-radius: 12px;
      padding: 32px;
      text-align: center;
    }
    .benefit-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    .benefit-card h3 {
      font-size: 20px;
      margin-bottom: 12px;
      color: #e8f0ff;
    }
    .benefit-card p {
      color: #94a3b8;
      font-size: 15px;
      line-height: 1.6;
    }
    .footer {
      text-align: center;
      padding-top: 40px;
      border-top: 1px solid rgba(79, 70, 229, 0.2);
      color: #64748b;
      font-size: 14px;
    }
    @media (max-width: 768px) {
      .hero h1 { font-size: 32px; }
      .hero p { font-size: 17px; }
      .signup-form { padding: 24px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="logo">ProBid AI</div>
      <div class="tagline">Built by Contractors, for Contractors</div>
    </header>

    <section class="hero">
      <h1>AI-Powered Construction Estimates in 60 Seconds</h1>
      <p>Stop spending hours on estimates. Upload a photo, describe the job, and get a professional bid your clients will trust—backed by real market data.</p>
    </section>

    <div class="signup-form">
      <h2>Get Early Access</h2>
      <p class="subtitle">Built by a working contractor. 7-day free trial of Pro or grab a $7 single estimate.</p>
      <form id="referralForm">
        <input type="hidden" name="ref" value="${refCode}" />
        <div class="form-group">
          <input type="email" name="email" placeholder="Enter your email address" required />
        </div>
        <button type="submit" class="submit-btn">Get Started Free</button>
      </form>
      <div class="success-message" id="successMessage">
        <strong>You're in!</strong> Check your email for next steps.
      </div>
      <div class="error-message" id="errorMessage"></div>
    </div>

    <section class="benefits">
      <div class="benefit-card">
        <div class="benefit-icon">⚡</div>
        <h3>60-Second Estimates</h3>
        <p>Upload a photo of the job site, add a few details, and get a complete estimate with line items instantly. No more spreadsheets or guesswork.</p>
      </div>
      <div class="benefit-card">
        <div class="benefit-icon">💰</div>
        <h3>Win More Jobs</h3>
        <p>Respond to leads faster with professional PDF estimates. The contractor who replies first usually wins the job — ProBid AI gets you there.</p>
      </div>
      <div class="benefit-card">
        <div class="benefit-icon">📊</div>
        <h3>Market-Accurate Pricing</h3>
        <p>Our AI uses real market data and regional labor rates to ensure your estimates are competitive and profitable for your area.</p>
      </div>
    </section>

    <footer class="footer">
      <p>&copy; 2026 ProBid AI. All rights reserved. | <a href="/pricing" style="color: #22c55e;">View Pricing</a></p>
    </footer>
  </div>

  <script>
    const form = document.getElementById('referralForm');
    const successMessage = document.getElementById('successMessage');
    const errorMessage = document.getElementById('errorMessage');
    const submitBtn = form.querySelector('.submit-btn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const email = form.querySelector('input[name="email"]').value;
      const ref = form.querySelector('input[name="ref"]').value;
      
      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing up...';
      successMessage.style.display = 'none';
      errorMessage.style.display = 'none';

      try {
        const response = await fetch('/api/refer/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, ref })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          successMessage.style.display = 'block';
          form.style.display = 'none';
        } else {
          errorMessage.textContent = data.error || 'Something went wrong. Please try again.';
          errorMessage.style.display = 'block';
        }
      } catch (err) {
        errorMessage.textContent = 'Network error. Please try again.';
        errorMessage.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Get Started Free';
      }
    });
  </script>
</body>
</html>
`;

    res.type("html").send(html);
  }),
);

// --- Referral Signup API ---
app.post(
  "/api/refer/signup",
  asyncHandler(async (req, res) => {
    const { email, ref } = req.body;

    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const referralCode = ref && typeof ref === "string" ? ref.trim() : null;
    const createdAt = new Date().toISOString();

    try {
      const existing = await db
        .select()
        .from(referralLeads)
        .where(eq(referralLeads.email, normalizedEmail));

      if (existing.length > 0) {
        return res
          .status(409)
          .json({ error: "This email is already registered" });
      }

      await db.insert(referralLeads).values({
        email: normalizedEmail,
        referralCode: referralCode,
        convertedToUser: false,
        createdAt: createdAt,
      });

      if (referralCode) {
        await trackAffiliateClick(referralCode, null, null);
        log("info", "Referral lead captured with code", {
          email: normalizedEmail,
          referralCode,
        });
      } else {
        log("info", "Referral lead captured", { email: normalizedEmail });
      }

      try {
        const { client, fromEmail } = await getResendClient();
        await sendEmailWithRetry(
          client,
          {
          from: fromEmail,
          to: normalizedEmail,
          subject: "Welcome to ProBid AI – Your First Estimate Awaits",
          html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #0a0e1a; color: #e8f0ff;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0e1a; padding: 40px 20px;">
              <tr>
                <td align="center">
                  <table width="600" cellpadding="0" cellspacing="0" style="background-color: #121a2a; border-radius: 12px; border: 1px solid rgba(79, 70, 229, 0.3);">
                    <tr>
                      <td style="padding: 40px 40px 30px 40px; text-align: center; border-bottom: 1px solid rgba(79, 70, 229, 0.2);">
                        <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #22c55e;">ProBid AI</h1>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 40px;">
                        <h2 style="margin: 0 0 24px 0; font-size: 22px; color: #e8f0ff;">Welcome to ProBid AI!</h2>
                        <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.7; color: #94a3b8;">
                          You're now on the list for early access to the fastest way to generate professional construction estimates.
                        </p>
                        <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.7; color: #94a3b8;">
                          With ProBid AI, you can:
                        </p>
                        <ul style="margin: 0 0 24px 20px; padding: 0; font-size: 16px; line-height: 1.8; color: #94a3b8;">
                          <li>Generate estimates in under 60 seconds</li>
                          <li>Upload job photos for AI-powered analysis</li>
                          <li>Get market-accurate pricing for your region</li>
                          <li>Create professional PDFs to send to clients</li>
                        </ul>
                        <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.7; color: #94a3b8;">
                          Ready to try it? Create your account, start a 7-day free trial of Pro, or grab a $7 single estimate.
                        </p>
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td align="center">
                              <a href="${APP_URL}/login" style="display: inline-block; padding: 16px 32px; background-color: #22c55e; color: #0b0f19; text-decoration: none; font-weight: 700; font-size: 16px; border-radius: 10px;">Create Your Free Account</a>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 30px 40px; text-align: center; border-top: 1px solid rgba(79, 70, 229, 0.2);">
                        <p style="margin: 0; font-size: 14px; color: #64748b;">
                          ProBid AI – Built by contractors, for contractors.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `,
          },
          {
            idempotencyKey: `referral-welcome/${normalizedEmail}`,
            logContext: { email: normalizedEmail },
          },
        );
        log("info", "Welcome email sent to referral lead", {
          email: normalizedEmail,
        });
      } catch (emailError) {
        log("error", "Failed to send welcome email to referral lead", {
          email: normalizedEmail,
          error: String(emailError),
        });
      }

      await scheduleEmailDrip(normalizedEmail);

      await trackEvent("referral_lead_signup", null, {
        email: normalizedEmail,
        referralCode,
      });

      res.json({ success: true, message: "Successfully signed up" });
    } catch (err: any) {
      if (err?.code === "23505") {
        return res
          .status(409)
          .json({ error: "This email is already registered" });
      }
      log("error", "Error capturing referral lead", { error: String(err) });
      throw err;
    }
  }),
);
app.get(
  "/leaderboard",
  asyncHandler(async (req, res) => {
    const top10Raw = await pool.query<{
      user_id: string;
      email: string;
      converted: string;
    }>(
      `SELECT u.id AS user_id, u.email,
            COUNT(r.id) AS converted
     FROM users u
     INNER JOIN referrals r ON r.referrer_user_id = u.id AND r.status = 'subscribed'
     GROUP BY u.id, u.email
     ORDER BY converted DESC
     LIMIT 10`,
    );

    const rows = top10Raw.rows.map((r, i) => {
      const email = r.email || "";
      const parts = email.split("@")[0] || "";
      // Show first name + last initial from username portion
      const nameParts = parts.split(/[.\-_]/);
      // Always cap first segment to 12 chars to prevent exposing long email local-parts
      const rawFirst = nameParts[0] || "";
      const firstName =
        rawFirst.length > 0
          ? rawFirst.charAt(0).toUpperCase() +
            rawFirst.slice(1, Math.min(rawFirst.length, 12)).toLowerCase()
          : "—";
      const lastInitial = nameParts[1]
        ? nameParts[1].charAt(0).toUpperCase() + "."
        : "";
      const displayName = lastInitial
        ? `${firstName} ${lastInitial}`
        : `${firstName}.`;
      return {
        rank: i + 1,
        displayName,
        converted: Number(r.converted),
        userId: r.user_id,
      };
    });

    const rowsHtml =
      rows.length === 0
        ? `<tr><td colspan="3" style="padding:32px;text-align:center;color:#94a3b8">No conversions yet — be the first!</td></tr>`
        : rows
            .map(
              (r) => `
      <tr>
        <td style="padding:14px 20px;color:${r.rank <= 3 ? "#fbbf24" : "#94a3b8"};font-weight:700;font-size:18px">
          ${r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : `#${r.rank}`}
        </td>
        <td style="padding:14px 20px;color:#e8f0ff;font-weight:600">${escapeHtml(r.displayName)}</td>
        <td style="padding:14px 20px;color:#22c55e;font-weight:700;text-align:right">${r.converted} paid referral${r.converted !== 1 ? "s" : ""}</td>
      </tr>`,
            )
            .join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Referral Leaderboard — ProBid AI</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,sans-serif;background:#0a0e1a;color:#e8f0ff;min-height:100vh}
    .container{max-width:680px;margin:0 auto;padding:60px 20px}
    .badge{display:inline-block;padding:4px 12px;background:rgba(79,70,229,0.15);color:#a5b4fc;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:16px}
    h1{font-size:2.2rem;font-weight:800;margin:0 0 8px;background:linear-gradient(135deg,#e8f0ff 0%,#a5b4fc 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .subtitle{color:#94a3b8;margin:0 0 40px;font-size:15px}
    .card{background:#121a2a;border:1px solid rgba(79,70,229,0.2);border-radius:16px;overflow:hidden}
    table{width:100%;border-collapse:collapse}
    tr+tr{border-top:1px solid rgba(255,255,255,0.06)}
    .cta{margin-top:32px;text-align:center}
    .cta a{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px}
    .cta p{color:#94a3b8;font-size:13px;margin-top:12px}
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">Affiliate Program</div>
    <h1>Referral Leaderboard</h1>
    <p class="subtitle">Top contractors earning passive income by referring colleagues to ProBid AI</p>
    <div class="card">
      <table>
        <thead>
          <tr style="background:rgba(79,70,229,0.12)">
            <th style="padding:12px 20px;text-align:left;color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Rank</th>
            <th style="padding:12px 20px;text-align:left;color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Referrer</th>
            <th style="padding:12px 20px;text-align:right;color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Conversions</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="cta">
      <a href="/app/affiliate">Join the Affiliate Program</a>
      <p>Earn 20% recurring commission on every paid referral</p>
    </div>
  </div>
</body>
</html>`;

    res.send(html);
  }),
);
app.post(
  "/api/social/generate",
  asyncHandler(async (req, res) => {
    const uid = req.session?.uid;
    if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

    const trade = String(req.body?.trade ?? "contractor").trim().slice(0, 60);
    const city = String(req.body?.city ?? "").trim().slice(0, 60);

    const cityPhrase = city ? ` in ${city}` : "";
    const prompt = `You are a social media expert helping a ${trade} contractor grow their business by sharing helpful content online.

Generate 4 platform-specific posts to promote ProBid AI (probidcore.net), an AI estimating tool for contractors. Each post should feel authentic and human, not salesy.

Trade: ${trade}
Location: ${city || "general US market"}

Format your response as a JSON array with exactly 4 items. Each item has:
- "platform": one of "Reddit", "Facebook", "LinkedIn", "Nextdoor"
- "title": post title (for Reddit only, 1 sentence, max 80 chars — omit for other platforms)
- "body": the post body (natural, conversational, 2-4 sentences for Facebook/Nextdoor, 3-6 sentences for Reddit/LinkedIn). Include probidcore.net naturally.
- "tip": a 1-sentence tip on where/how to post this (e.g. specific subreddit, Facebook group type)

Rules:
- Reddit post must sound like genuine advice from a fellow contractor, not advertising
- Facebook post should be warm and community-focused${cityPhrase}
- LinkedIn post should be professional with a concrete ROI angle (time saved, money won)
- Nextdoor should be hyper-local and helpful
- Never start with "I" — vary sentence openers
- Include a soft mention of probidcore.net in each post

Respond with ONLY valid JSON, no markdown, no code blocks.`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
        temperature: 0.8,
      });

      const raw = completion.choices[0]?.message?.content?.trim() ?? "[]";
      let posts: unknown[];
      try {
        posts = JSON.parse(raw);
      } catch {
        const match = raw.match(/\[[\s\S]*\]/);
        posts = match ? JSON.parse(match[0]) : [];
      }

      if (!Array.isArray(posts) || posts.length === 0) {
        return res.status(500).json({ success: false, error: "Failed to parse AI response. Please try again." });
      }

      res.json({ success: true, data: { posts } });
    } catch (err: any) {
      log("error", "Social content generation failed", { error: err?.message });
      res.status(500).json({ success: false, error: "Failed to generate content. Try again." });
    }
  }),
);
}
