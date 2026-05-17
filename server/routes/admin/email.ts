import express from "express";
import { db } from "../../db.js";
import { eq, and, or, count } from "drizzle-orm";
import {
  users, leads, estimates, purchases, referrals,
} from "../../../shared/schema.js";
import { asyncHandler, requireAdminAuth } from "../../lib/middleware.js";
import { log } from "../../lib/logger.js";
import { trackEvent } from "../../lib/analytics.js";
import { getResendClient, sendEmailWithRetry } from "../../resend-client.js";
import { now, dayKey } from "../../lib/utils.js";
import { followUpEmailsSentToday, pendingFollowUpEmails } from "../../lib/email-helpers.js";
import { getUser, getSub, isPaidActive } from "../../lib/user-helpers.js";

const APP_URL =
  process.env.REPLIT_DEPLOYMENT === "1"
    ? "https://probidcore.net"
    : process.env.APP_URL || "http://localhost:5000";

export function registerAdminEmailRoutes(app: express.Application) {
// --- Email Notification Helpers ---
async function sendFollowUpEmail(email: string, userId: string): Promise<void> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Your Estimate Is Ready – Want to Win This Job Faster?",
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
                        <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #e8f0ff;">ProBid AI</h1>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 40px;">
                        <p style="margin: 0 0 24px 0; font-size: 18px; line-height: 1.6; color: #e8f0ff;">
                          Your ProBid AI estimate is ready.
                        </p>
                        <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.7; color: #94a3b8;">
                          The contractor who replies first usually wins the job — getting your PDF over while it's still on the homeowner's mind matters.
                        </p>
                        <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.7; color: #94a3b8;">
                          You can download your PDF, make edits, or create another estimate anytime.
                        </p>
                        <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.7; color: #94a3b8;">
                          If you're doing multiple bids per week, upgrading saves time instantly.
                        </p>
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td align="center">
                              <a href="${APP_URL}/pricing" style="display: inline-block; padding: 16px 32px; background-color: #22c55e; color: #0b0f19; text-decoration: none; font-weight: 700; font-size: 16px; border-radius: 10px;">Upgrade to Pro</a>
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
        idempotencyKey: `followup/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Follow-up email sent", { userId, email });
  } catch (error) {
    log("error", "Failed to send follow-up email", {
      userId,
      email,
      error: String(error),
    });
  }
}

function scheduleFollowUpEmail(email: string, userId: string): void {
  const todayKey = `${userId}:${dayKey()}`;

  if (followUpEmailsSentToday.has(todayKey)) {
    log("info", "Follow-up email already sent today, skipping", { userId });
    return;
  }

  if (pendingFollowUpEmails.has(userId)) {
    log("info", "Follow-up email already pending, skipping", { userId });
    return;
  }

  const timeoutId = setTimeout(async () => {
    pendingFollowUpEmails.delete(userId);

    try {
      const user = await getUser(userId);
      if (!user || !user.email) {
        log("info", "User not found or no email, skipping follow-up", {
          userId,
        });
        return;
      }

      const sub = await getSub(userId);
      if (isPaidActive(sub)) {
        log("info", "User is paid subscriber, skipping follow-up email", {
          userId,
        });
        return;
      }

      const lifetimeResult = await db
        .select()
        .from(purchases)
        .where(
          and(eq(purchases.userId, userId), eq(purchases.type, "lifetime")),
        );
      if (lifetimeResult.length > 0) {
        log("info", "User has lifetime access, skipping follow-up email", {
          userId,
        });
        return;
      }

      await sendFollowUpEmail(user.email, userId);
      followUpEmailsSentToday.add(todayKey);
    } catch (error) {
      log("error", "Error in scheduled follow-up email", {
        userId,
        error: String(error),
      });
    }
  }, 900000);

  pendingFollowUpEmails.set(userId, timeoutId);
  log("info", "Follow-up email scheduled for 15 minutes", { userId, email });
}

async function sendWelcomeEmail(email: string): Promise<void> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Welcome to ProBid AI!",
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
              .header { background: linear-gradient(135deg, #4f46e5, #6366f1); padding: 30px; text-align: center; }
              .header h1 { color: white; margin: 0; font-size: 28px; }
              .content { padding: 30px; background: #f9fafb; }
              .feature { background: white; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #4f46e5; }
              .cta { text-align: center; margin: 30px 0; }
              .cta a { background: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; }
              .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>Welcome to ProBid AI!</h1>
            </div>
            <div class="content">
              <p>Thanks for signing up! You're now ready to create professional construction estimates in seconds using AI.</p>
              
              <div class="feature">
                <strong>Get Started:</strong>
                <p>Start a 7-day free trial of Pro for unlimited estimates, or grab a single estimate for $7. No charge during the trial.</p>
              </div>
              
              <div class="feature">
                <strong>How It Works:</strong>
                <p>Simply describe your job, select your market, and our AI generates a detailed, professional estimate you can send to clients immediately.</p>
              </div>
              
              <div class="cta">
                <a href="${APP_URL}/app">Create Your First Estimate</a>
              </div>
              
              <p>Need unlimited estimates? Upgrade to Pro for just $25/month and get unlimited estimates, PDF exports, and more!</p>
            </div>
            <div class="footer">
              <p>ProBid AI - Professional estimates, powered by AI</p>
            </div>
          </body>
          </html>
        `,
      },
      {
        idempotencyKey: `welcome/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Welcome email sent", { email });
  } catch (err: any) {
    log("error", "Failed to send welcome email", {
      email,
      error: err?.message || err,
    });
  }
}

async function sendUpgradeConfirmationEmail(email: string): Promise<void> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "You're now a Pro member!",
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
              .header { background: linear-gradient(135deg, #22c55e, #16a34a); padding: 30px; text-align: center; }
              .header h1 { color: white; margin: 0; font-size: 28px; }
              .content { padding: 30px; background: #f9fafb; }
              .benefit { background: white; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #22c55e; }
              .cta { text-align: center; margin: 30px 0; }
              .cta a { background: #22c55e; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; }
              .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>You're Now a Pro Member!</h1>
            </div>
            <div class="content">
              <p>Thank you for upgrading to ProBid AI Pro! Your subscription is now active.</p>
              
              <div class="benefit">
                <strong>Unlimited Estimates</strong>
                <p>Create as many AI-powered estimates as you need - no daily limits!</p>
              </div>
              
              <div class="benefit">
                <strong>Professional PDF Exports</strong>
                <p>Download and share polished PDF proposals with your clients.</p>
              </div>
              
              <div class="benefit">
                <strong>Priority Support</strong>
                <p>Get faster responses from our support team when you need help.</p>
              </div>
              
              <div class="cta">
                <a href="${APP_URL}/app">Start Creating Estimates</a>
              </div>
              
              <p>If you have any questions about your subscription, just reply to this email - we're here to help!</p>
            </div>
            <div class="footer">
              <p>ProBid AI - Professional estimates, powered by AI</p>
            </div>
          </body>
          </html>
        `,
      },
      {
        idempotencyKey: `upgrade-conf/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Upgrade confirmation email sent", { email });
  } catch (err: any) {
    log("error", "Failed to send upgrade confirmation email", {
      email,
      error: err?.message || err,
    });
  }
}

async function sendUpsellEmail(
  email: string,
  estimateCount: number,
  jobType?: string,
) {
  log("info", "Upsell email triggered", { email, estimateCount, jobType });

  // Derive a plain-English trade label from the jobType string
  const jt = (jobType || "").toLowerCase();
  let tradePhrase = "construction jobs";
  if (/roof/.test(jt))
    tradePhrase =
      "roofing jobs (shingle replacement, flat roof repairs, gutters)";
  else if (/mason|brick|tuck/.test(jt))
    tradePhrase = "masonry work (tuckpointing, brick repair, chimney work)";
  else if (/concrete|cement/.test(jt))
    tradePhrase = "concrete jobs (driveways, flatwork, foundation work)";
  else if (/remodel|renovation|kitchen|bath/.test(jt))
    tradePhrase = "remodeling projects (kitchens, bathrooms, additions)";
  else if (/hvac|heat|cool|air/.test(jt))
    tradePhrase = "HVAC jobs (installs, replacements, ductwork)";
  else if (/electric/.test(jt))
    tradePhrase = "electrical work (panels, wiring, installs)";
  else if (/plumb/.test(jt))
    tradePhrase = "plumbing work (repairs, installs, repiping)";
  else if (/landscape|lawn|grade|drain/.test(jt))
    tradePhrase = "landscaping projects (hardscaping, grading, drainage)";
  else if (/paint/.test(jt))
    tradePhrase = "painting jobs (interior, exterior, commercial)";
  else if (/floor|tile|hardwood|lvp/.test(jt))
    tradePhrase = "flooring installs (hardwood, tile, LVP)";

  try {
    const { client, fromEmail } = await getResendClient();
    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Your last free estimate is waiting",
        text: `You've used ${estimateCount} of your 3 free estimates on ProBid AI.

  You have 1 estimate left — make it count.

  Contractors who work on ${tradePhrase} use Pro to generate unlimited estimates without hitting a wall mid-job.

  Upgrade to Pro now:
  • Unlimited AI-powered estimates
  • PDF export for every job
  • Priority email support

  Upgrade now → ${APP_URL}/app/billing

  Or use your last free estimate here → ${APP_URL}/app/estimate/new

  – The ProBid AI Team`,
        html: `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; background: #f4f4f4; }
      .container { background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
      .header { background: linear-gradient(135deg, #f59e0b, #d97706); padding: 32px; text-align: center; }
      .header h1 { color: white; margin: 0; font-size: 24px; font-weight: 800; }
      .header p { color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px; }
      .content { padding: 32px; }
      .urgency { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
      .urgency p { margin: 0; color: #92400e; font-size: 15px; font-weight: 600; }
      .progress { background: #f3f4f6; border-radius: 8px; height: 10px; margin: 8px 0 0; overflow: hidden; }
      .progress-fill { background: #f59e0b; height: 100%; width: 67%; border-radius: 8px; }
      .content p { color: #444; margin: 0 0 16px; font-size: 15px; }
      .features { margin: 20px 0; padding: 0; list-style: none; }
      .features li { padding: 8px 0; border-bottom: 1px solid #f3f4f6; color: #374151; font-size: 14px; }
      .features li:last-child { border-bottom: none; }
      .features li::before { content: "✓ "; color: #16a34a; font-weight: 700; }
      .cta { text-align: center; margin: 28px 0; }
      .cta a { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; }
      .secondary { text-align: center; margin-top: 12px; }
      .secondary a { color: #6b7280; font-size: 13px; text-decoration: underline; }
      .footer { text-align: center; padding: 24px; background: #f9f9f9; border-top: 1px solid #eee; }
      .footer p { color: #888; font-size: 12px; margin: 0; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>⚠️ 1 Free Estimate Left</h1>
        <p>Your account is almost at its free limit</p>
      </div>
      <div class="content">
        <div class="urgency">
          <p>You've used ${estimateCount} of 3 free estimates</p>
          <div class="progress"><div class="progress-fill"></div></div>
        </div>
        <p>You're one estimate away from the wall. Contractors who work on ${tradePhrase} use Pro to generate unlimited estimates without stopping mid-job.</p>
        <ul class="features">
          <li>Unlimited AI-powered estimates — no caps</li>
          <li>PDF export for every job to send clients</li>
          <li>Photo upload for visual job analysis</li>
          <li>Priority email support</li>
        </ul>
        <div class="cta">
          <a href="${APP_URL}/app/billing">Upgrade to Pro — $25/mo</a>
        </div>
        <div class="secondary">
          <a href="${APP_URL}/app/estimate/new">Use my last free estimate first →</a>
        </div>
      </div>
      <div class="footer">
        <p>ProBid AI · <a href="${APP_URL}">probidcore.net</a></p>
      </div>
    </div>
  </body>
  </html>`,
      },
      {
        idempotencyKey: `upsell/${email}/${dayKey()}`,
        logContext: { email },
      },
    );
    log("info", "Upsell email sent", { email });
  } catch (err: any) {
    log("error", "Failed to send upsell email", { email, error: err.message });
  }
}

// --- Launch Marketing Email Templates ---

const EMAIL_STYLES = `
  body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; background: #f4f4f4; }
  .email-container { background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .header { background: linear-gradient(135deg, #f7931a, #e8850f); padding: 32px; text-align: center; }
  .header h1 { color: white; margin: 0; font-size: 26px; font-weight: 700; }
  .header p { color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px; }
  .content { padding: 32px; }
  .content h2 { color: #1a1a1a; font-size: 22px; margin: 0 0 16px; }
  .content p { color: #444; margin: 0 0 16px; font-size: 15px; }
  .feature-box { background: #fff8f0; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #f7931a; }
  .feature-box h3 { color: #f7931a; margin: 0 0 8px; font-size: 16px; }
  .feature-box p { margin: 0; color: #555; font-size: 14px; }
  .stat-row { display: flex; justify-content: space-around; margin: 24px 0; text-align: center; }
  .stat { flex: 1; padding: 16px; }
  .stat-number { font-size: 32px; font-weight: 800; color: #f7931a; display: block; }
  .stat-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  .cta { text-align: center; margin: 28px 0; }
  .cta a { background: linear-gradient(135deg, #f7931a, #e8850f); color: white; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(247,147,26,0.35); }
  .cta a:hover { background: linear-gradient(135deg, #e8850f, #d67500); }
  .testimonial { background: #fafafa; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #eee; }
  .testimonial p { font-style: italic; color: #555; margin: 0 0 12px; }
  .testimonial .author { font-weight: 600; color: #333; font-size: 14px; }
  .footer { text-align: center; padding: 24px; background: #f9f9f9; border-top: 1px solid #eee; }
  .footer p { color: #888; font-size: 12px; margin: 0; }
  .footer a { color: #f7931a; text-decoration: none; }
  .urgency-badge { background: #dc2626; color: white; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; display: inline-block; margin-bottom: 16px; }
  ul { padding-left: 20px; margin: 16px 0; }
  li { color: #444; margin: 8px 0; font-size: 15px; }
`;

async function sendMarketingWelcomeEmail(
  email: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Welcome to ProBid AI – your first estimate is minutes away!",
        text: `Welcome to ProBid AI!

  Glad you're here. ProBid AI was built by a working masonry contractor to make estimates fast and painless.

  Here's what you can do right now:
  • Create your first AI-powered estimate in under 2 minutes
  • Get accurate pricing based on real market data
  • Send professional proposals that win more jobs

  Ready to get started?
  Visit: ${APP_URL}/app

  Your first estimate is on us – completely free.

  Questions? Just reply to this email.

  – The ProBid AI Team`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <h1>Welcome to ProBid AI!</h1>
                <p>Your first estimate is minutes away</p>
              </div>
              <div class="content">
                <p>Glad you're here. ProBid AI was built by a working masonry contractor to make estimates fast and painless.</p>
                
                <div class="feature-box">
                  <h3>🚀 Here's what you can do right now:</h3>
                  <p>Create your first AI-powered estimate in under 2 minutes. Get accurate pricing based on real market data, and send professional proposals that win more jobs.</p>
                </div>
                
                <div class="cta">
                  <a href="${APP_URL}/app">Create Your First Estimate</a>
                </div>
                
                <p style="text-align: center; color: #666; font-size: 14px;">Your first estimate is on us – completely free.</p>
              </div>
              <div class="footer">
                <p>Questions? Just reply to this email.<br>– The ProBid AI Team</p>
              </div>
            </div>
          </body>
          </html>
        `,
      },
      {
        idempotencyKey: `mkt-welcome/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Marketing welcome email sent", { email });
    return { success: true };
  } catch (err: any) {
    log("error", "Failed to send marketing welcome email", {
      email,
      error: err?.message || err,
    });
    return { success: false, error: err?.message || "Unknown error" };
  }
}

async function sendSocialProofEmail(
  email: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Built by a contractor — for contractors",
        text: `A note from the founder.

  ProBid AI wasn't built in a Silicon Valley office. It was built by a working masonry contractor who got tired of losing his evenings to estimating.

  "After a long day on the job site, I'd still have hours of measuring, pricing, and typing ahead of me. ProBid AI is the tool I wished I had — snap a photo, get a quote, send the PDF, move on."

  — Jesse Kirchner, Founder · Kirchner Masonry, Galena, IL

  What's in the box:
  • Snap a photo or describe the job — get a full estimate in about a minute
  • Materials, labor, and regional pricing factored in automatically
  • Client-ready PDF you can send straight from your phone
  • 10+ trades supported (masonry, roofing, concrete, and more)

  Ready to try it?
  Visit: ${APP_URL}/app

  – Jesse & the ProBid AI Team`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <h1>Built by a Contractor — for Contractors</h1>
                <p>A note from the founder</p>
              </div>
              <div class="content">
                <p>ProBid AI wasn't built in a Silicon Valley office. It was built by a working masonry contractor who got tired of losing his evenings to estimating.</p>

                <div class="testimonial">
                  <p>"After a long day on the job site, I'd still have hours of measuring, pricing, and typing ahead of me. ProBid AI is the tool I wished I had — snap a photo, get a quote, send the PDF, move on."</p>
                  <span class="author">— Jesse Kirchner, Founder · Kirchner Masonry, Galena, IL</span>
                </div>

                <div class="feature-box">
                  <h3>What's in the box</h3>
                  <p>• Snap a photo or describe the job — full estimate in about a minute<br>
                  • Materials, labor, and regional pricing factored in automatically<br>
                  • Client-ready PDF you can send straight from your phone<br>
                  • 10+ trades supported (masonry, roofing, concrete, and more)</p>
                </div>

                <div class="cta">
                  <a href="${APP_URL}/app">Try It Free</a>
                </div>
              </div>
              <div class="footer">
                <p>Built by a contractor who needed it himself.<br>– Jesse & the ProBid AI Team</p>
              </div>
            </div>
          </body>
          </html>
        `,
      },
      {
        idempotencyKey: `mkt-social-proof/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Social proof email sent", { email });
    return { success: true };
  } catch (err: any) {
    log("error", "Failed to send social proof email", {
      email,
      error: err?.message || err,
    });
    return { success: false, error: err?.message || "Unknown error" };
  }
}

async function sendFeatureTeaseEmail(
  email: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Unlock unlimited estimates, branding, and more!",
        text: `You've been using the free version of ProBid AI. Here's what you're missing:

  UNLIMITED ESTIMATES
  No daily limits. Create as many estimates as you need, whenever you need them.

  YOUR BRANDING
  Add your logo, company name, and contact info to every proposal. Look professional on every bid.

  PDF EXPORTS
  Download polished, client-ready PDFs you can email, print, or present in person.

  PRIORITY SUPPORT
  Get faster responses from our team when you need help.

  ESTIMATE TEMPLATES
  Save your most common job types and generate estimates even faster.

  Upgrade to Pro for just $25/month – that's less than one hour of billable work.

  Upgrade now: ${APP_URL}/pricing

  – The ProBid AI Team`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <h1>Unlock the Full Power</h1>
                <p>Here's what Pro members get</p>
              </div>
              <div class="content">
                <p>You've been using the free version of ProBid AI. Here's what you're missing:</p>
                
                <div class="feature-box">
                  <h3>♾️ Unlimited Estimates</h3>
                  <p>No daily limits. Create as many estimates as you need, whenever you need them.</p>
                </div>
                
                <div class="feature-box">
                  <h3>🎨 Your Branding</h3>
                  <p>Add your logo, company name, and contact info to every proposal. Look professional on every bid.</p>
                </div>
                
                <div class="feature-box">
                  <h3>📄 PDF Exports</h3>
                  <p>Download polished, client-ready PDFs you can email, print, or present in person.</p>
                </div>
                
                <div class="feature-box">
                  <h3>⚡ Priority Support</h3>
                  <p>Get faster responses from our team when you need help.</p>
                </div>
                
                <div class="feature-box">
                  <h3>📋 Estimate Templates</h3>
                  <p>Save your most common job types and generate estimates even faster.</p>
                </div>
                
                <p style="text-align: center; font-weight: 600; color: #1a1a1a; font-size: 18px; margin: 24px 0 8px;">Just $25/month</p>
                <p style="text-align: center; color: #666; font-size: 14px;">That's less than one hour of billable work.</p>
                
                <div class="cta">
                  <a href="${APP_URL}/pricing">Upgrade to Pro</a>
                </div>
              </div>
              <div class="footer">
                <p>Questions about Pro? Just reply to this email.<br>– The ProBid AI Team</p>
              </div>
            </div>
          </body>
          </html>
        `,
      },
      {
        idempotencyKey: `mkt-feature-tease/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Feature tease email sent", { email });
    return { success: true };
  } catch (err: any) {
    log("error", "Failed to send feature tease email", {
      email,
      error: err?.message || err,
    });
    return { success: false, error: err?.message || "Unknown error" };
  }
}

async function sendUrgencyEmail(
  email: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Your free plan is limited – upgrade before it resets!",
        text: `Quick heads up about your ProBid AI account...

  Your free plan gives you 3 lifetime estimates. That might work to evaluate the tool, but what happens when you have 5 leads in one afternoon?

  If a homeowner asks you for three quick quotes in one afternoon, the free tier won't cover it — and the contractor who replies first usually wins the job.

  PRO MEMBERS GET:
  • Unlimited estimates (no cap)
  • Professional PDF exports
  • Saved estimate history
  • Priority support

  Upgrade to Pro for just $25/month – cancel anytime.

  Upgrade now: ${APP_URL}/pricing

  This isn't about pressure. It's about making sure you have the tools when opportunity knocks.

  – The ProBid AI Team`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <h1>Don't Miss Your Next Big Job</h1>
                <p>Your free plan has limits</p>
              </div>
              <div class="content">
                <span class="urgency-badge">⏰ LIMITED ACCESS</span>
                
                <p>Your free plan gives you <strong>3 lifetime estimates</strong>. That's enough to evaluate the tool, but if a homeowner asks you for three quick quotes in one afternoon, the free tier won't cover it — and the contractor who replies first usually wins the job.</p>
                
                <h2 style="font-size: 18px; margin: 24px 0 16px;">Pro Members Get:</h2>
                <ul>
                  <li><strong>Unlimited estimates</strong> – no cap ever</li>
                  <li><strong>Professional PDF exports</strong> – client-ready proposals</li>
                  <li><strong>Saved estimate history</strong> – access past jobs anytime</li>
                  <li><strong>Priority support</strong> – faster help when you need it</li>
                </ul>
                
                <p style="text-align: center; font-weight: 600; color: #1a1a1a; font-size: 18px; margin: 24px 0 8px;">Just $25/month – Cancel anytime</p>
                
                <div class="cta">
                  <a href="${APP_URL}/pricing">Upgrade to Pro Now</a>
                </div>
                
                <p style="text-align: center; color: #666; font-size: 13px; margin-top: 20px;">This isn't about pressure. It's about making sure you have the tools when opportunity knocks.</p>
              </div>
              <div class="footer">
                <p>Questions? Just reply to this email.<br>– The ProBid AI Team</p>
              </div>
            </div>
          </body>
          </html>
        `,
      },
      {
        idempotencyKey: `mkt-urgency/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Urgency email sent", { email });
    return { success: true };
  } catch (err: any) {
    log("error", "Failed to send urgency email", {
      email,
      error: err?.message || err,
    });
    return { success: false, error: err?.message || "Unknown error" };
  }
}

async function sendReferralEmail(
  email: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, fromEmail } = await getResendClient();

    await sendEmailWithRetry(
      client,
      {
        from: fromEmail,
        to: email,
        subject: "Earn 20% by referring contractors to ProBid AI!",
        text: `Want to earn money while helping fellow contractors?

  Introducing the ProBid AI Referral Program!

  HOW IT WORKS:
  1. Share your unique referral link with other contractors
  2. When they sign up and subscribe to Pro, you earn 20% of their payment
  3. Get paid every month they stay subscribed – for life!

  REAL EARNING POTENTIAL:
  • Refer 5 contractors = $49/month passive income
  • Refer 10 contractors = $98/month passive income
  • Refer 25 contractors = $245/month passive income

  Your referral link is waiting in your dashboard.

  Get your referral link: ${APP_URL}/app/affiliate

  Already know a contractor who could use ProBid AI? Share your link today and start earning.

  – The ProBid AI Team

  P.S. There's no limit to how many contractors you can refer. The more you share, the more you earn!`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <h1>Earn 20% Referral Commission!</h1>
                <p>Help contractors. Get paid.</p>
              </div>
              <div class="content">
                <p>Want to earn money while helping fellow contractors? Introducing the <strong>ProBid AI Referral Program!</strong></p>
                
                <div class="feature-box">
                  <h3>🔗 How It Works:</h3>
                  <p>1. Share your unique referral link with other contractors<br>
                  2. When they sign up and subscribe to Pro, you earn 20%<br>
                  3. Get paid every month they stay subscribed – for life!</p>
                </div>
                
                <h2 style="font-size: 18px; text-align: center; margin: 24px 0 16px;">Real Earning Potential</h2>
                
                <div style="background: #fff8f0; border-radius: 12px; padding: 20px; margin: 20px 0;">
                  <div class="stat-row">
                    <div class="stat">
                      <span class="stat-number">$49</span>
                      <span class="stat-label">5 Referrals/mo</span>
                    </div>
                    <div class="stat">
                      <span class="stat-number">$98</span>
                      <span class="stat-label">10 Referrals/mo</span>
                    </div>
                    <div class="stat">
                      <span class="stat-number">$245</span>
                      <span class="stat-label">25 Referrals/mo</span>
                    </div>
                  </div>
                </div>
                
                <p style="text-align: center; color: #666;">Your referral link is waiting in your dashboard.</p>
                
                <div class="cta">
                  <a href="${APP_URL}/app/affiliate">Get Your Referral Link</a>
                </div>
                
                <p style="text-align: center; color: #666; font-size: 13px; margin-top: 20px;">Already know a contractor who could use ProBid AI? Share your link today and start earning.</p>
              </div>
              <div class="footer">
                <p>No limit on referrals. The more you share, the more you earn!<br>– The ProBid AI Team</p>
              </div>
            </div>
          </body>
          </html>
        `,
      },
      {
        idempotencyKey: `mkt-referral/${email}/${dayKey()}`,
        logContext: { email },
      },
    );

    log("info", "Referral email sent", { email });
    return { success: true };
  } catch (err: any) {
    log("error", "Failed to send referral email", {
      email,
      error: err?.message || err,
    });
    return { success: false, error: err?.message || "Unknown error" };
  }
}

// Email template registry for admin endpoint
const MARKETING_EMAIL_TEMPLATES: Record<
  string,
  (email: string) => Promise<{ success: boolean; error?: string }>
> = {
  welcome: sendMarketingWelcomeEmail,
  social_proof: sendSocialProofEmail,
  feature_tease: sendFeatureTeaseEmail,
  urgency: sendUrgencyEmail,
  referral: sendReferralEmail,
};

// --- Admin Email Send Endpoint ---
app.post(
  "/api/admin/send-email",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const { userId, email, templateKey } = req.body;

    if (!templateKey || typeof templateKey !== "string") {
      return res.status(400).json({ error: "Missing or invalid templateKey" });
    }

    const templateFn = MARKETING_EMAIL_TEMPLATES[templateKey];
    if (!templateFn) {
      return res.status(400).json({
        error: `Invalid templateKey. Available templates: ${Object.keys(MARKETING_EMAIL_TEMPLATES).join(", ")}`,
      });
    }

    let targetEmail: string | undefined;

    if (email && typeof email === "string") {
      targetEmail = email;
    } else if (userId) {
      const userResult = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, String(userId)));
      if (!userResult[0]) {
        return res.status(404).json({ error: "User not found" });
      }
      targetEmail = userResult[0].email;
    }

    if (!targetEmail) {
      return res
        .status(400)
        .json({ error: "Must provide either userId or email" });
    }

    const result = await templateFn(targetEmail);

    if (result.success) {
      await trackEvent("admin_email_sent", undefined, {
        templateKey,
        email: targetEmail,
      });
      res.json({
        success: true,
        message: `Email "${templateKey}" sent to ${targetEmail}`,
      });
    } else {
      res
        .status(500)
        .json({
          success: false,
          error: result.error || "Failed to send email",
        });
    }
  }),
);


}
