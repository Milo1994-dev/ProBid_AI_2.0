import express from "express";
import { z } from "zod";
import { asyncHandler, validateCsrf } from "../lib/middleware.js";
import { getResendClient, sendEmailWithRetry } from "../resend-client.js";
import { log } from "../lib/logger.js";
import { escapeHtml } from "../lib/utils.js";

const SUBJECTS = [
  "general",
  "sales",
  "support",
  "billing",
  "partnership",
  "press",
  "other",
] as const;

const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  email: z.string().email("Valid email is required").max(254),
  subject: z.enum(SUBJECTS),
  message: z.string().min(10, "Message is too short").max(5000),
  company: z.string().max(200).optional(),
});

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const ipHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (ipHits.get(ip) || []).filter((t) => t > cutoff);
  if (hits.length >= RATE_MAX) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);

  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits.entries()) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) ipHits.delete(k);
      else ipHits.set(k, fresh);
    }
  }
  return false;
}

/**
 * Strip the optional "Display Name <addr@domain>" wrapper that Resend's
 * `from` field uses, so we can hand the raw email address to the `to:`
 * field of a follow-up send.
 */
function extractEmailAddress(rawFrom: string): string {
  const match = rawFrom.match(/<([^>]+)>/);
  return (match?.[1] ?? rawFrom).trim();
}

export function registerContactRoutes(app: express.Application) {
  app.post(
    "/api/contact",
    validateCsrf,
    asyncHandler(async (req, res) => {
      const ip = (req.ip || req.headers["x-forwarded-for"]?.toString().split(",")[0] || "unknown").trim();

      if (isRateLimited(ip)) {
        log("warn", "Contact form rate-limited", { ip });
        return res.status(429).json({
          success: false,
          error: "Too many submissions. Please try again later or email us directly.",
        });
      }

      const parsed = contactSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || "Invalid form submission",
        });
      }

      const { name, email, subject, message, company } = parsed.data;
      // Per task spec: route to CONTACT_EMAIL if configured, else fall
      // back to the verified transactional sender address. Resolved before
      // the try block so the catch logger can reference it.
      let to = process.env.CONTACT_EMAIL?.trim() || "";

      try {
        const { client, fromEmail } = await getResendClient();
        if (!to) to = extractEmailAddress(fromEmail);
        const idempotencyKey = `contact/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        await sendEmailWithRetry(
          client,
          {
            from: fromEmail,
            to,
            replyTo: email,
            subject: `[Contact – ${subject}] ${name}`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
                <h2 style="color:#111827;margin:0 0 12px">New contact form submission</h2>
                <p style="color:#374151;margin:0 0 8px"><strong>Name:</strong> ${escapeHtml(name)}</p>
                <p style="color:#374151;margin:0 0 8px"><strong>Email:</strong> ${escapeHtml(email)}</p>
                ${company ? `<p style="color:#374151;margin:0 0 8px"><strong>Company:</strong> ${escapeHtml(company)}</p>` : ""}
                <p style="color:#374151;margin:0 0 8px"><strong>Subject:</strong> ${escapeHtml(subject)}</p>
                <p style="color:#374151;margin:16px 0 4px"><strong>Message:</strong></p>
                <div style="white-space:pre-wrap;color:#111827;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px">${escapeHtml(message)}</div>
                <p style="color:#6b7280;font-size:12px;margin-top:16px">Submitted from probidcore.net contact form • IP: ${escapeHtml(ip)}</p>
              </div>
            `,
            text: [
              `New contact form submission`,
              ``,
              `Name: ${name}`,
              `Email: ${email}`,
              company ? `Company: ${company}` : null,
              `Subject: ${subject}`,
              ``,
              `Message:`,
              message,
            ].filter(Boolean).join("\n"),
          },
          {
            idempotencyKey,
            logContext: { route: "contact", to, subject },
          },
        );

        log("info", "Contact form submitted", { to, subject, ip });
        return res.json({ success: true });
      } catch (err: any) {
        log("error", "Contact form email failed", { error: err?.message, to });
        return res.status(500).json({
          success: false,
          error: "We couldn't send your message right now. Please email us directly.",
        });
      }
    }),
  );
}
