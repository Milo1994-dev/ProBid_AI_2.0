import express from "express";
import crypto from "crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { eq, and, sql, gt } from "drizzle-orm";
import { users, scrapedLeads, verificationCodes } from "../../shared/schema.js";
import { asyncHandler, generateCsrfToken, generateMobileToken, verifyMobileToken, validateCsrf } from "../lib/middleware.js";
import { now } from "../lib/utils.js";
import { trackEvent } from "../lib/analytics.js";
import { fireServerConversions } from "../lib/ad-conversions.js";
import { attributeReferral } from "../lib/affiliate-helpers.js";
import { sendWelcomeEmail, enqueueOnboardingSequence, sendVerificationCode } from "../lib/email-helpers.js";
import { log } from "../lib/logger.js";
import { setSdkSessionCookie, clearSdkSessionCookie, getSdkCsrfToken } from "../lib/sdk-session.js";

const BCRYPT_ROUNDS = 12;

function isMobileRequest(req: express.Request): boolean {
  const platform = req.headers["x-platform"];
  if (platform === "ios" || platform === "android" || platform === "mobile") return true;
  const ua = req.headers["user-agent"] ?? "";
  return /expo|react-native|okhttp|darwin/i.test(ua);
}

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
  ref: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
});

// `meta_event_id` is a browser-generated dedup token forwarded straight to
// Meta CAPI's `event_id` field so the server-side CompleteRegistration is
// matched with the browser pixel's CompleteRegistration. Bounded length and
// kept opaque (no semantic parsing here).
const metaEventIdSchema = z.string().min(1).max(120).optional();

const signupSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  ref: z.string().optional(),
  meta_event_id: metaEventIdSchema,
});

const verifySchema = z.object({
  email: z.string().email("Invalid email format"),
  code: z.string().regex(/^\d{6}$/, "Code must be exactly 6 digits"),
  mode: z.enum(["login", "signup"]),
  ref: z.string().optional(),
  meta_event_id: metaEventIdSchema,
});

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const verifyAttempts = new Map<string, { count: number; windowStart: number }>();
const resendAttempts = new Map<string, { count: number; windowStart: number }>();

const MAX_RESEND_PER_WINDOW = 5;
const RESEND_WINDOW_MS = 15 * 60 * 1000;
const MIN_RESEND_INTERVAL_MS = 30 * 1000;

function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function checkResendRateLimit(email: string): { allowed: boolean; retryAfterSeconds?: number } {
  const key = email.toLowerCase();
  const entry = resendAttempts.get(key);
  const currentTime = Date.now();

  if (!entry || currentTime - entry.windowStart > RESEND_WINDOW_MS) {
    resendAttempts.set(key, { count: 1, windowStart: currentTime });
    return { allowed: true };
  }

  if (entry.count >= MAX_RESEND_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + RESEND_WINDOW_MS - currentTime) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  entry.count++;
  return { allowed: true };
}

function checkRateLimit(email: string): { allowed: boolean; retryAfterSeconds?: number } {
  const key = email.toLowerCase();
  const entry = verifyAttempts.get(key);
  const currentTime = Date.now();

  if (!entry || currentTime - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    verifyAttempts.set(key, { count: 1, windowStart: currentTime });
    return { allowed: true };
  }

  if (entry.count >= MAX_VERIFY_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - currentTime) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  entry.count++;
  return { allowed: true };
}

async function createAndSendOtp(email: string): Promise<void> {
  await db
    .update(verificationCodes)
    .set({ used: true })
    .where(and(eq(verificationCodes.email, email), eq(verificationCodes.used, false)));

  const code = generateOtp();
  const codeH = hashCode(code);
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  await db.insert(verificationCodes).values({
    email,
    codeHash: codeH,
    expiresAt,
    used: false,
    attempts: 0,
    createdAt: Date.now(),
  });

  await sendVerificationCode(email, code);
}

export function registerAuthRoutes(app: express.Application) {
  app.get("/api/csrf", (req, res) => {
    // SDK callers (authenticated via the dedicated cross-site SDK cookie)
    // get a stateless CSRF token derived from the HMAC signature embedded
    // in their SDK session cookie. CORS keeps non-allowlisted origins
    // from reading this response, so the token can't leak to attackers.
    if ((req as any).isSdkAuth) {
      const token = getSdkCsrfToken(req);
      if (!token) {
        return res.status(401).json({ success: false, error: "SDK session invalid or expired." });
      }
      return res.json({ success: true, data: { token } });
    }
    if (!req.session!.csrfToken) {
      req.session!.csrfToken = generateCsrfToken();
    }
    res.json({ success: true, data: { token: req.session!.csrfToken } });
  });

  app.get(
    "/api/me",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.json({ success: true, data: null });

      const rows = await db
        .select({ id: users.id, email: users.email, affiliateCode: users.affiliateCode, hasSeenOnboarding: users.hasSeenOnboarding, pdfShowGuaranteeBadges: users.pdfShowGuaranteeBadges })
        .from(users)
        .where(eq(users.id, uid));
      if (!rows[0]) return res.status(401).json({ success: false, error: "User not found" });
      res.json({ success: true, data: rows[0] });
    }),
  );

  app.put(
    "/api/me/pdf-settings",
    validateCsrf,
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Unauthorized" });

      const showRaw = (req.body as any)?.pdfShowGuaranteeBadges;
      if (typeof showRaw !== "boolean") {
        return res.status(400).json({ success: false, error: "pdfShowGuaranteeBadges must be a boolean" });
      }

      await db
        .update(users)
        .set({ pdfShowGuaranteeBadges: showRaw })
        .where(eq(users.id, uid));

      res.json({ success: true, data: { pdfShowGuaranteeBadges: showRaw } });
    }),
  );

  app.post(
    "/api/login",
    asyncHandler(async (req, res) => {
      const parseResult = loginSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues[0].message });
      }
      const email = parseResult.data.email.trim().toLowerCase();
      const password = parseResult.data.password;

      const userResult = await db.select().from(users).where(eq(users.email, email));

      if (userResult.length === 0) {
        return res.status(401).json({ success: false, error: "Invalid email or password." });
      }

      const existingUser = userResult[0];

      if (!existingUser.passwordHash) {
        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await db.update(users).set({ passwordHash: hashed }).where(eq(users.id, existingUser.id));
      } else {
        const valid = await bcrypt.compare(password, existingUser.passwordHash);
        if (!valid) {
          return res.status(401).json({ success: false, error: "Invalid email or password." });
        }
      }

      await trackEvent("login", existingUser.id).catch(err => log("warn", "trackEvent login failed", { error: err?.message }));

      if (isMobileRequest(req)) {
        const token = generateMobileToken(existingUser.id, email);
        return res.json({ success: true, data: { id: existingUser.id, email, token } });
      }

      req.session!.uid = existingUser.id;
      req.session!.email = email;
      req.session!.csrfToken = generateCsrfToken();
      req.session!.userRole = existingUser.role || "user";
      setSdkSessionCookie(res, existingUser.id, email);

      res.json({ success: true, data: { id: existingUser.id, email } });
    }),
  );

  app.post(
    "/api/signup",
    asyncHandler(async (req, res) => {
      const parseResult = signupSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues[0].message });
      }
      const email = parseResult.data.email.trim().toLowerCase();
      const password = parseResult.data.password;
      const refCode = parseResult.data.ref?.trim() ?? "";
      const metaEventId = parseResult.data.meta_event_id;

      const existingUser = await db.select().from(users).where(eq(users.email, email));
      if (existingUser.length > 0) {
        return res.status(409).json({ success: false, error: "An account with this email already exists. Please log in instead." });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const userId = crypto.randomUUID();
      await db.insert(users).values({ id: userId, email, passwordHash, createdAt: now() });

      await trackEvent("signup", userId, { email }).catch(err => log("warn", "trackEvent signup failed", { error: err?.message }));
      fireServerConversions("signup", { email, sourceUrl: "https://probidcore.net/signup", userAgent: req.headers["user-agent"], clientIp: req.ip, eventId: metaEventId }).catch(() => {});
      if (refCode) await attributeReferral(userId, refCode).catch(err => log("warn", "attributeReferral failed", { error: err?.message }));
      sendWelcomeEmail(email).catch(err => log("warn", "sendWelcomeEmail failed", { error: err?.message }));
      enqueueOnboardingSequence(email, userId).catch(err => log("warn", "enqueueOnboardingSequence failed", { error: err?.message }));
      import("../lib/automation-engine.js").then(m => m.seedDefaultAutomations(userId)).catch(err => log("warn", "seedDefaultAutomations failed", { error: err?.message }));
      db.update(scrapedLeads)
        .set({ convertedAt: Date.now(), updatedAt: Date.now() })
        .where(and(eq(scrapedLeads.email, email), sql`converted_at IS NULL`))
        .catch(err => log("warn", "scrapedLeads conversion update failed", { error: err?.message }));

      if (isMobileRequest(req)) {
        const token = generateMobileToken(userId, email);
        return res.json({ success: true, data: { id: userId, email, token } });
      }

      req.session!.uid = userId;
      req.session!.email = email;
      req.session!.csrfToken = generateCsrfToken();
      req.session!.userRole = "user";
      setSdkSessionCookie(res, userId, email);

      res.json({ success: true, data: { id: userId, email } });
    }),
  );

  app.post(
    "/api/verify",
    asyncHandler(async (req, res) => {
      const parseResult = verifySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues[0].message });
      }

      const { email: rawEmail, code, mode, ref, meta_event_id: metaEventId } = parseResult.data;
      const email = rawEmail.trim().toLowerCase();
      const refCode = ref?.trim() ?? "";

      const rateCheck = checkRateLimit(email);
      if (!rateCheck.allowed) {
        return res.status(429).json({
          success: false,
          error: "Too many attempts. Please try again later.",
          retryAfter: rateCheck.retryAfterSeconds,
        });
      }

      const codeRows = await db
        .select()
        .from(verificationCodes)
        .where(
          and(
            eq(verificationCodes.email, email),
            eq(verificationCodes.used, false),
            gt(verificationCodes.expiresAt, Date.now())
          )
        )
        .limit(1);

      if (codeRows.length === 0) {
        return res.status(400).json({ success: false, error: "Code expired or not found. Please request a new code." });
      }

      const record = codeRows[0];
      const codeH = hashCode(code);

      if (record.codeHash !== codeH) {
        await db
          .update(verificationCodes)
          .set({ attempts: (record.attempts ?? 0) + 1 })
          .where(eq(verificationCodes.id, record.id));
        return res.status(400).json({ success: false, error: "Invalid code. Please try again." });
      }

      await db
        .update(verificationCodes)
        .set({ used: true })
        .where(eq(verificationCodes.id, record.id));

      const userResult = await db.select().from(users).where(eq(users.email, email));
      let userId: string;
      let isNewUser = false;

      if (userResult.length === 0) {
        userId = crypto.randomUUID();
        await db.insert(users).values({ id: userId, email, createdAt: now() });
        isNewUser = true;
        await trackEvent("signup", userId, { email }).catch(err => log("warn", "trackEvent signup failed", { error: err?.message }));
        fireServerConversions("signup", { email, sourceUrl: "https://probidcore.net/signup", userAgent: req.headers["user-agent"], clientIp: req.ip, eventId: metaEventId }).catch(() => {});
        if (refCode) await attributeReferral(userId, refCode).catch(err => log("warn", "attributeReferral failed", { error: err?.message }));
        sendWelcomeEmail(email).catch(err => log("warn", "sendWelcomeEmail failed", { error: err?.message }));
        enqueueOnboardingSequence(email, userId).catch(err => log("warn", "enqueueOnboardingSequence failed", { error: err?.message }));
        import("../lib/automation-engine.js").then(m => m.seedDefaultAutomations(userId)).catch(err => log("warn", "seedDefaultAutomations failed", { error: err?.message }));
        if (mode === "signup") {
          db.update(scrapedLeads)
            .set({ convertedAt: Date.now(), updatedAt: Date.now() })
            .where(and(eq(scrapedLeads.email, email), sql`converted_at IS NULL`))
            .catch(err => log("warn", "scrapedLeads conversion update failed", { error: err?.message }));
        }
      } else {
        userId = userResult[0].id;
        await trackEvent("login", userId).catch(err => log("warn", "trackEvent login failed", { error: err?.message }));
      }

      req.session!.uid = userId;
      req.session!.email = email;
      req.session!.csrfToken = generateCsrfToken();
      req.session!.userRole = userResult[0]?.role || "user";
      setSdkSessionCookie(res, userId, email);

      res.json({ success: true, data: { id: userId, email } });
    }),
  );

  app.post(
    "/api/resend-code",
    asyncHandler(async (req, res) => {
      const parseResult = z.object({ email: z.string().email() }).safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: "Invalid email" });
      }
      const email = parseResult.data.email.trim().toLowerCase();

      const resendCheck = checkResendRateLimit(email);
      if (!resendCheck.allowed) {
        return res.status(429).json({
          success: false,
          error: "Too many requests. Please try again later.",
          retryAfter: resendCheck.retryAfterSeconds,
        });
      }

      try {
        await createAndSendOtp(email);
      } catch (err: any) {
        log("error", "Failed to resend OTP", { email, error: err?.message });
        return res.status(500).json({ success: false, error: "Failed to send verification code. Please try again." });
      }

      res.json({ success: true, data: { sent: true } });
    }),
  );

  app.post(
    "/api/auth/token",
    asyncHandler(async (req, res) => {
      const parseResult = verifySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues[0].message });
      }

      const { email: rawEmail, code, mode, ref, meta_event_id: metaEventId } = parseResult.data;
      const email = rawEmail.trim().toLowerCase();
      const refCode = ref?.trim() ?? "";

      const rateCheck = checkRateLimit(email);
      if (!rateCheck.allowed) {
        return res.status(429).json({
          success: false,
          error: "Too many attempts. Please try again later.",
          retryAfter: rateCheck.retryAfterSeconds,
        });
      }

      const codeRows = await db
        .select()
        .from(verificationCodes)
        .where(
          and(
            eq(verificationCodes.email, email),
            eq(verificationCodes.used, false),
            gt(verificationCodes.expiresAt, Date.now())
          )
        )
        .limit(1);

      if (codeRows.length === 0) {
        return res.status(400).json({ success: false, error: "Code expired or not found. Please request a new code." });
      }

      const record = codeRows[0];
      const codeH = hashCode(code);

      if (record.codeHash !== codeH) {
        await db
          .update(verificationCodes)
          .set({ attempts: (record.attempts ?? 0) + 1 })
          .where(eq(verificationCodes.id, record.id));
        return res.status(400).json({ success: false, error: "Invalid code. Please try again." });
      }

      await db
        .update(verificationCodes)
        .set({ used: true })
        .where(eq(verificationCodes.id, record.id));

      const userResult = await db.select().from(users).where(eq(users.email, email));
      let userId: string;

      if (userResult.length === 0) {
        userId = crypto.randomUUID();
        await db.insert(users).values({ id: userId, email, createdAt: now() });
        await trackEvent("signup", userId, { email }).catch(err => log("warn", "trackEvent signup failed", { error: err?.message }));
        fireServerConversions("signup", { email, sourceUrl: "https://probidcore.net/signup", userAgent: req.headers["user-agent"], clientIp: req.ip, eventId: metaEventId }).catch(() => {});
        if (refCode) await attributeReferral(userId, refCode).catch(err => log("warn", "attributeReferral failed", { error: err?.message }));
        sendWelcomeEmail(email).catch(err => log("warn", "sendWelcomeEmail failed", { error: err?.message }));
        enqueueOnboardingSequence(email, userId).catch(err => log("warn", "enqueueOnboardingSequence failed", { error: err?.message }));
        import("../lib/automation-engine.js").then(m => m.seedDefaultAutomations(userId)).catch(err => log("warn", "seedDefaultAutomations failed", { error: err?.message }));
        if (mode === "signup") {
          db.update(scrapedLeads)
            .set({ convertedAt: Date.now(), updatedAt: Date.now() })
            .where(and(eq(scrapedLeads.email, email), sql`converted_at IS NULL`))
            .catch(err => log("warn", "scrapedLeads conversion update failed", { error: err?.message }));
        }
      } else {
        userId = userResult[0].id;
        await trackEvent("login", userId).catch(err => log("warn", "trackEvent login failed", { error: err?.message }));
      }

      const token = generateMobileToken(userId, email);

      res.json({ success: true, data: { id: userId, email, token } });
    }),
  );

  app.post(
    "/api/auth/refresh",
    asyncHandler(async (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, error: "No token provided" });
      }

      const oldToken = authHeader.slice(7);
      const result = verifyMobileToken(oldToken);
      if (!result || !result.userId || !result.email) {
        return res.status(401).json({ success: false, error: "Invalid or expired token" });
      }

      const userResult = await db.select().from(users).where(eq(users.id, result.userId));
      if (userResult.length === 0) {
        return res.status(401).json({ success: false, error: "User not found" });
      }

      const newToken = generateMobileToken(result.userId, result.email);
      res.json({ success: true, data: { id: result.userId, email: result.email, token: newToken } });
    }),
  );

  app.post("/api/logout", (req, res) => {
    req.session = null;
    clearSdkSessionCookie(res);
    res.json({ success: true, data: null });
  });
}
