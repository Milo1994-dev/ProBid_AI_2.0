import express from "express";
import { log } from "../lib/logger.js";
import crypto from "crypto";
import fs from "fs";
import { z } from "zod";
import { db } from "../db.js";
import { eq, and, or, desc, count, ilike, sql } from "drizzle-orm";
import { estimates, estimateLineItems, leads, users, purchases } from "../../shared/schema.js";
import { asyncHandler, requireAuthJson } from "../lib/middleware.js";
import { requireApiKeyOrSession } from "../lib/api-key-auth.js";
import { incrementPartnerUsage } from "./partner.js";
import { getSdkCsrfToken } from "../lib/sdk-session.js";
import { now } from "../lib/utils.js";
import { FREE_ESTIMATES_LIFETIME, getFreeLifetimeAllowance } from "../lib/user-helpers.js";
import { upload } from "../lib/upload.js";
import { generateAIEstimate, extractStructuredLineItems } from "../lib/ai.js";
import { trackEvent } from "../lib/analytics.js";
import { notifyEstimateReady } from "./notifications.js";
import { speechToText, convertWebmToWav } from "../replit_integrations/audio/client.js";
import {
  getSub,
  isPaidActive,
  getTotalEstimates,
  incrementUsage,
  enforcePaywall,
  consumeSingleCredit,
  getDailyUsage,
} from "../lib/user-helpers.js";
import { sendUpsellEmail, scheduleFollowUpEmail } from "../lib/email-helpers.js";
import { buildEstimatePdfBuffer } from "../lib/estimate-pdf-helpers.js";
import { getResendClient, sendEmailWithRetry } from "../resend-client.js";
import {
  syncDealForNewEstimate,
  syncDealStageFromEstimateStatus,
  parseEstimateTotalValue,
} from "../lib/pipeline-sync.js";
import {
  claimIdempotencyKey,
  finalizeIdempotencyKey,
  hashRequestBody,
  maybeReapExpiredIdempotencyKeys,
  readIdempotencyKey,
  releaseIdempotencyKey,
} from "../lib/idempotency.js";

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

const PRICE_BIZ = process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? "";
const PRICE_PRO = process.env.STRIPE_PRICE_PRO_MONTHLY ?? "";
const PRICE_BIZ_ANNUAL = process.env.STRIPE_PRICE_BUSINESS_ANNUAL ?? "";
const PRICE_PRO_ANNUAL = process.env.STRIPE_PRICE_PRO_ANNUAL ?? "";

export function registerEstimateRoutes(app: express.Application) {
  app.post(
    "/api/transcribe",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const { audio, format } = req.body;
      if (!audio || typeof audio !== "string") {
        return res.status(400).json({ success: false, error: "Audio data (base64) is required" });
      }
      const inputFormat = format === "wav" ? "wav" : "webm";
      let audioBuffer: Buffer = Buffer.from(audio, "base64") as Buffer;
      if (inputFormat === "webm") {
        audioBuffer = await convertWebmToWav(audioBuffer) as Buffer;
      }
      const transcript = await speechToText(audioBuffer as Buffer, "wav");
      res.json({ success: true, data: { transcript } });
    })
  );

  // GET /api/usage — estimates used vs limit for current user
  app.get(
    "/api/usage",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const sub = await getSub(uid);
      const paid = isPaidActive(sub);
      const dailyUsed = await getDailyUsage(uid);
      const total = await getTotalEstimates(uid);

      let plan = "free";
      if (sub?.status === "active" || sub?.status === "trialing" || sub?.status === "past_due") {
        if (sub.priceId === PRICE_BIZ || sub.priceId === PRICE_BIZ_ANNUAL) plan = "business";
        else plan = "pro";
      }

      const lifetimePurchases = await db
        .select({ id: purchases.id })
        .from(purchases)
        .where(and(eq(purchases.userId, uid), eq(purchases.type, "lifetime")))
        .limit(1);
      const hasLifetime = lifetimePurchases.length > 0;
      if (hasLifetime) plan = "lifetime";

      const isUnlimited = paid || hasLifetime;

      let singleCredits = 0;
      if (!isUnlimited) {
        const creditRows = await db
          .select({ creditsRemaining: purchases.creditsRemaining })
          .from(purchases)
          .where(and(eq(purchases.userId, uid), eq(purchases.type, "single_estimate")));
        singleCredits = creditRows.reduce((sum, r) => sum + (r.creditsRemaining ?? 0), 0);
      }

      let bonusEstimates = 0;
      let freeAllowance = 0;
      if (!isUnlimited) {
        const [bonusRow] = await db
          .select({
            referralBonusEstimates: users.referralBonusEstimates,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(eq(users.id, uid));
        bonusEstimates = bonusRow?.referralBonusEstimates ?? 0;
        freeAllowance = getFreeLifetimeAllowance(bonusRow?.createdAt);
      }

      const effectiveLimit = isUnlimited ? null : freeAllowance + bonusEstimates;

      res.json({
        success: true,
        data: { used: total, total, limit: effectiveLimit, bonusEstimates, plan, isUnlimited, singleCredits },
      });
    }),
  );

  // GET /api/estimates — paginated list
  app.get(
    "/api/estimates",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
      const search = String(req.query.search || "").trim();
      const pageSize = 20;
      const offset = (page - 1) * pageSize;

      const userFilter = eq(estimates.userId, uid);
      const searchFilter = search
        ? or(ilike(estimates.jobType, `%${search}%`), ilike(estimates.details, `%${search}%`))
        : undefined;
      const whereClause = searchFilter ? and(userFilter, searchFilter) : userFilter;

      const [rows, totalRows] = await Promise.all([
        db.select().from(estimates).where(whereClause).orderBy(desc(estimates.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(estimates).where(whereClause),
      ]);

      const total = totalRows[0]?.c ?? 0;

      res.json({
        success: true,
        data: {
          estimates: rows.map((e) => ({
            id: e.id,
            jobType: e.jobType,
            market: e.market,
            details: e.details,
            estimateText: e.estimateText,
            clientName: e.clientName,
            clientEmail: e.clientEmail,
            clientPhone: e.clientPhone,
            createdAt: new Date(e.createdAt).getTime(),
          })),
          total,
          page,
          pages: Math.max(1, Math.ceil(total / pageSize)),
        },
      });
    }),
  );

  // GET /api/estimates/:id — single estimate
  app.get(
    "/api/estimates/:id",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const rows = await db
        .select()
        .from(estimates)
        .where(and(eq(estimates.id, req.params.id), eq(estimates.userId, uid)));

      if (!rows[0]) return res.status(404).json({ success: false, error: "Estimate not found" });

      const e = rows[0];

      const items = await db
        .select()
        .from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, e.id))
        .orderBy(estimateLineItems.sortOrder);

      const structuredLineItems = items.map((li) => ({
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        unitCost: li.unitCost,
        uom: li.uom,
        costType: li.costType,
        lineTotal: li.quantity * li.unitCost,
      }));

      const totals = structuredLineItems.length
        ? computeLineItemTotals(structuredLineItems)
        : null;

      res.json({
        success: true,
        data: {
          id: e.id,
          jobType: e.jobType,
          market: e.market,
          details: e.details,
          estimateText: e.estimateText,
          name: e.name,
          source: e.source,
          clientName: e.clientName,
          clientEmail: e.clientEmail,
          clientPhone: e.clientPhone,
          createdAt: new Date(e.createdAt).getTime(),
          wonLostStatus: e.wonLostStatus ?? null,
          wonLostUpdatedAt: e.wonLostUpdatedAt ? new Date(e.wonLostUpdatedAt).getTime() : null,
          lineItems: structuredLineItems,
          totals,
        },
      });
    }),
  );

  const lineItemsCache = new Map<string, { data: any; ts: number }>();
  const LINE_ITEMS_CACHE_TTL = 1000 * 60 * 60;
  const lineItemsRateLimit = new Map<string, number>();

  app.get(
    "/api/estimates/:id/line-items",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid) return res.status(401).json({ success: false, error: "Not authenticated" });

      const now = Date.now();
      const lastCall = lineItemsRateLimit.get(uid) || 0;
      if (now - lastCall < 3000) {
        return res.status(429).json({ success: false, error: "Please wait a moment before trying again." });
      }
      lineItemsRateLimit.set(uid, now);

      const rows = await db
        .select()
        .from(estimates)
        .where(and(eq(estimates.id, req.params.id), eq(estimates.userId, uid)));

      if (!rows[0]) return res.status(404).json({ success: false, error: "Estimate not found" });

      const cacheKey = `${uid}:${req.params.id}`;
      const cached = lineItemsCache.get(cacheKey);
      if (cached && now - cached.ts < LINE_ITEMS_CACHE_TTL) {
        return res.json({ success: true, data: cached.data });
      }

      const lineItems = await extractStructuredLineItems(rows[0].estimateText);
      const data = { lineItems };
      lineItemsCache.set(cacheKey, { data, ts: now });
      res.json({ success: true, data });
    }),
  );

  app.post(
    "/api/estimates",
    requireAuthJson,
    upload.array("photos", 5),
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const photoFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

      try {
        const parseResult = estimateSchema.safeParse(req.body);
        if (!parseResult.success) {
          return res.status(400).json({ success: false, error: parseResult.error.issues[0].message });
        }
        const { jobType, market, details, zipCode, clientName, clientEmail, clientPhone, tradePreset } = parseResult.data;

        const gate = await enforcePaywall(uid);
        if (!gate.ok) {
          return res.status(402).json({
            success: false,
            error: "Estimate limit reached. Upgrade to Pro or buy a $7 single estimate to continue.",
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
        if (creditId) {
          const consumed = await consumeSingleCredit(creditId);
          if (!consumed) {
            return res.status(402).json({
              success: false,
              error: "Credit is no longer available. Please purchase another estimate.",
              upgrade: true,
            });
          }
        }

        let estimateText: string;
        let estimateId: string;
        try {
          const genStartedAt = now();
          estimateText = await generateAIEstimate(
            jobType,
            market,
            details ?? "",
            photoFiles,
            zipCode,
            tradePreset,
          );
          const genCompletedAt = now();

          estimateId = crypto.randomUUID();
          await db.insert(estimates).values({
            id: estimateId,
            userId: uid,
            jobType,
            market,
            details,
            estimateText,
            clientName: clientName || null,
            clientEmail: clientEmail || null,
            clientPhone: clientPhone || null,
            status: "sent",
            generationStartedAt: genStartedAt,
            generationCompletedAt: genCompletedAt,
            createdAt: now(),
          });
        } catch (coreErr: any) {
          if (creditId) {
            await db
              .update(purchases)
              .set({ creditsRemaining: sql`${purchases.creditsRemaining} + 1` })
              .where(eq(purchases.id, creditId))
              .catch(refundErr => log("error", "Credit refund failed after estimate error", { creditId, error: refundErr?.message }));
          }
          log("error", "Estimate generation/save failed", { error: coreErr?.message, userId: uid });
          throw coreErr;
        }

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
          }).catch(err => {
            createdLeadId = null;
            log("warn", "Lead insert failed (non-critical)", { error: err?.message });
          });
        }

        // Auto-populate Sales Pipeline: new estimate → "Estimate Sent" stage
        // deal. If a lead-deal already exists for the just-inserted leadId,
        // it is updated in place rather than duplicated.
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
        }).catch(err => log("warn", "Pipeline sync (estimate) failed", { error: err?.message }));

        await trackEvent("estimate_generated", uid, {
          jobType,
          market,
          hasPhoto: photoFiles.length > 0,
        }).catch(err => log("warn", "trackEvent estimate_generated failed", { error: err?.message }));

        notifyEstimateReady(uid, estimateId).catch(err =>
          log("warn", "Push notification for estimate_ready failed", { error: err?.message }),
        );

        import("../lib/automation-engine.js").then(m =>
          m.fireAutomationEvent(uid, "estimate_created", { jobType, market, estimateId, clientName: clientName || undefined, clientEmail: clientEmail || undefined })
        ).catch(err => log("warn", "Automation estimate_created event failed", { error: err?.message }));

        // If a lead was auto-created from this estimate, fire lead_created so
        // the same event fans out to webhook subscribers as the manual
        // /leads POST path. Webhook partners expect every new lead row to
        // emit lead.created regardless of which UI flow produced it.
        if (createdLeadId) {
          import("../lib/automation-engine.js").then(m =>
            m.fireAutomationEvent(uid, "lead_created", {
              leadId: createdLeadId,
              name: clientName || "Unknown",
              email: clientEmail || undefined,
              phone: clientPhone || undefined,
              source: "estimate_form",
            })
          ).catch(err => log("warn", "Automation lead_created event failed", { error: err?.message }));
        }

        const totalEstimatesCount = await getTotalEstimates(uid);
        if (totalEstimatesCount === 1) {
          db.update(users).set({ hasSeenOnboarding: true }).where(eq(users.id, uid)).catch(err => log("warn", "hasSeenOnboarding update failed", { error: err?.message }));
        }
        if (!paid && totalEstimatesCount === 2) {
          sendUpsellEmail(req.session!.email!, totalEstimatesCount, jobType);
        }
        if (!paid && !isLifetime && req.session!.email) {
          scheduleFollowUpEmail(req.session!.email, uid);
        }

        let freeBonus = 0;
        let freeAllowance = 0;
        if (!paid && !isLifetime) {
          const [bonusRow2] = await db
            .select({
              referralBonusEstimates: users.referralBonusEstimates,
              createdAt: users.createdAt,
            })
            .from(users)
            .where(eq(users.id, uid));
          freeBonus = bonusRow2?.referralBonusEstimates ?? 0;
          freeAllowance = getFreeLifetimeAllowance(bonusRow2?.createdAt);
        }
        const estimatesRemaining =
          paid || isLifetime
            ? null
            : Math.max(0, freeAllowance + freeBonus - totalEstimatesCount);

        res.json({
          success: true,
          data: {
            estimateId,
            text: estimateText,
            tier: paid ? "paid" : "free",
            estimatesRemaining,
          },
        });
      } catch (err: any) {
        res.status(500).json({ success: false, error: "Failed to generate estimate. Please try again." });
      } finally {
        photoFiles.forEach((f) => fs.unlink(f.path, () => {}));
      }
    }),
  );

  // PATCH /api/estimates/:id/won-lost — mark an estimate as won or lost.
  // Used by the Win-Jobs Guarantee eligibility check.
  app.patch(
    "/api/estimates/:id/won-lost",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const { id } = req.params;
      const { status } = req.body as { status?: string };

      if (!status || !["won", "lost", "none"].includes(status)) {
        return res.status(400).json({ success: false, error: "status must be 'won', 'lost', or 'none'." });
      }

      const rows = await db.select({ id: estimates.id, userId: estimates.userId })
        .from(estimates)
        .where(and(eq(estimates.id, id), eq(estimates.userId, uid)))
        .limit(1);

      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: "Estimate not found." });
      }

      await db.update(estimates)
        .set({
          wonLostStatus: status === "none" ? null : status,
          wonLostUpdatedAt: now(),
        })
        .where(eq(estimates.id, id));

      res.json({ success: true, data: { id, wonLostStatus: status === "none" ? null : status } });
    }),
  );

  // POST /api/estimates/send — programmatic estimate creation with structured line items.
  // Accepts either a logged-in session OR an API key with the `estimates:write` scope.
  //
  // Cookie-auth callers (the integrate.js SDK on a partner site) must also send
  // a CSRF token they fetched from `/api/csrf`. CORS keeps non-allowlisted
  // origins from being able to read that token, which prevents random sites
  // from forging a cross-site mutation just because the user is signed in.
  // API-key callers (Bearer header) bypass the CSRF check — they have no
  // session cookie, so there is no cross-site cookie to forge against.
  app.post(
    "/api/estimates/send",
    requireApiKeyOrSession("estimates:write"),
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      if (!(req as any).isApiKeyAuth) {
        // Cookie-auth callers must echo a CSRF token. SDK callers (cross-site
        // dedicated cookie) get a stateless token derived from their SDK
        // session signature; first-party callers use the per-session token
        // stored in the regular Lax session cookie.
        const expectedToken = (req as any).isSdkAuth
          ? getSdkCsrfToken(req)
          : req.session?.csrfToken;
        const submittedToken =
          (req.headers["x-csrf-token"] as string | undefined) ||
          (req.body && typeof req.body._csrf === "string" ? req.body._csrf : undefined);
        if (!expectedToken || !submittedToken || submittedToken !== expectedToken) {
          return res.status(403).json({
            success: false,
            error: "Missing or invalid CSRF token. Fetch /api/csrf first and send the token in the X-CSRF-Token header.",
          });
        }
      }

      const parseResult = sendEstimateSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: parseResult.error.issues[0].message,
        });
      }
      const { name, source, jobType, market, details, clientName, clientEmail, clientPhone, lineItems } = parseResult.data;

      // ── Idempotency: scoped per API key only. Cookie-auth callers get
      // CSRF protection above and the SDK doesn't retry on its own, so we
      // don't burn a row in the replay-cache table for every browser hit.
      const isApiKeyAuthRequest = Boolean((req as any).isApiKeyAuth);
      const apiKeyIdRaw = (req as any).apiKeyId;
      const apiKeyIdStr = apiKeyIdRaw != null ? String(apiKeyIdRaw) : null;
      const idem = readIdempotencyKey(req as any);
      if (idem.error) {
        return res.status(400).json({ success: false, error: idem.error });
      }
      const idempotencyKey =
        isApiKeyAuthRequest && apiKeyIdStr && idem.key ? idem.key : null;
      if (idempotencyKey) {
        const requestHash = hashRequestBody(req.body);
        const claim = await claimIdempotencyKey({
          apiKeyId: apiKeyIdStr!,
          idempotencyKey,
          requestHash,
          now: Date.now(),
        });
        if (claim.kind === "replay") {
          res.setHeader("Idempotent-Replayed", "true");
          return res.status(claim.status).json(claim.body);
        }
        if (claim.kind === "mismatch") {
          return res.status(422).json({
            success: false,
            error:
              "Idempotency-Key was already used with a different request body. Generate a new key for a different payload.",
          });
        }
        if (claim.kind === "in_flight") {
          return res.status(409).json({
            success: false,
            error:
              "A request with this Idempotency-Key is still being processed. Retry shortly.",
          });
        }
        if (claim.kind === "error") {
          // Fail-closed: the partner asked for replay protection and the
          // idempotency store could not confirm we'd honor it. Refuse the
          // request rather than risk a silent duplicate / double-charge.
          return res.status(503).json({
            success: false,
            error:
              "Idempotency store is temporarily unavailable. Please retry with the same Idempotency-Key.",
          });
        }
        // claim.kind === "fresh" → proceed and finalize on success.
      }
      maybeReapExpiredIdempotencyKeys(Date.now()).catch(() => {});

      // Helper to drop the in-flight idempotency claim when we bail out
      // before producing a final response, so the partner's next retry
      // can succeed instead of being blocked by a stale "pending" row.
      const releaseIdemOnError = async () => {
        if (idempotencyKey && apiKeyIdStr) {
          await releaseIdempotencyKey({ apiKeyId: apiKeyIdStr, idempotencyKey });
        }
      };

      const gate = await enforcePaywall(uid);
      if (!gate.ok) {
        await releaseIdemOnError();
        return res.status(402).json({
          success: false,
          error: "Free estimate limit reached. Upgrade to Pro for unlimited estimates.",
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
      if (creditId) {
        const consumed = await consumeSingleCredit(creditId);
        if (!consumed) {
          await releaseIdemOnError();
          return res.status(402).json({
            success: false,
            error: "Credit is no longer available. Please purchase another estimate.",
            upgrade: true,
          });
        }
      }

      const estimateId = crypto.randomUUID();
      const ts = now();
      const totals = computeLineItemTotals(
        lineItems.map((li) => ({ ...li, lineTotal: li.quantity * li.unitCost })),
      );
      const estimateText = renderLineItemsAsText({ name, source, lineItems, totals });

      try {
        await db.transaction(async (tx) => {
          await tx.insert(estimates).values({
            id: estimateId,
            userId: uid,
            jobType: jobType || name,
            market: market || "N/A",
            details: details ?? null,
            estimateText,
            name,
            source: source ?? null,
            clientName: clientName || null,
            clientEmail: clientEmail || null,
            clientPhone: clientPhone || null,
            status: "sent",
            createdAt: ts,
            // Programmatic estimates are assembled synchronously — record ts for both
            // so the Speed Guarantee evaluator can verify they were within threshold
            generationStartedAt: ts,
            generationCompletedAt: ts,
          });

          if (lineItems.length > 0) {
            await tx.insert(estimateLineItems).values(
              lineItems.map((li, idx) => ({
                id: crypto.randomUUID(),
                estimateId,
                description: li.description,
                quantity: li.quantity,
                unitCost: li.unitCost,
                uom: li.uom ?? null,
                costType: li.costType ?? null,
                sortOrder: idx,
                createdAt: ts,
              })),
            );
          }
        });
      } catch (insertErr: any) {
        if (creditId) {
          await db
            .update(purchases)
            .set({ creditsRemaining: sql`${purchases.creditsRemaining} + 1` })
            .where(eq(purchases.id, creditId))
            .catch((refundErr) =>
              log("error", "Credit refund failed after send-estimate error", { creditId, error: refundErr?.message }),
            );
        }
        await releaseIdemOnError();
        log("error", "Programmatic estimate insert failed", { error: insertErr?.message, userId: uid });
        const errPartnerId: string | null = (req as any).apiKeyPartnerId ?? null;
        if (errPartnerId) {
          const errKeyId: string | null = (req as any).apiKeyId ? String((req as any).apiKeyId) : null;
          incrementPartnerUsage({ partnerId: errPartnerId, apiKeyId: errKeyId, field: "errors" }).catch(() => {});
        }
        return res.status(500).json({ success: false, error: "Failed to create estimate." });
      }

      let createdLeadId: string | null = null;
      if (clientName || clientEmail || clientPhone) {
        createdLeadId = crypto.randomUUID();
        await db
          .insert(leads)
          .values({
            id: createdLeadId,
            userId: uid,
            name: clientName || "Unknown",
            email: clientEmail || null,
            phone: clientPhone || null,
            notes: `From estimate: ${name}`,
            status: "new",
            createdAt: ts,
            updatedAt: ts,
          })
          .catch((err) => {
            createdLeadId = null;
            log("warn", "Lead insert failed (non-critical)", { error: err?.message });
          });
      }

      // Auto-populate Sales Pipeline (programmatic /send path): new estimate
      // → "Estimate Sent" stage deal, with the line-item total as deal value.
      syncDealForNewEstimate({
        userId: uid,
        estimateId,
        leadId: createdLeadId,
        source: {
          title: name,
          clientName: clientName || null,
          clientEmail: clientEmail || null,
          clientPhone: clientPhone || null,
          description: details || null,
          projectType: jobType || null,
          value: totals.total,
        },
      }).catch((err) => log("warn", "Pipeline sync (estimate /send) failed", { error: err?.message }));

      const isApiKeyAuth = Boolean((req as any).isApiKeyAuth);
      await trackEvent("estimate_generated", uid, {
        jobType: jobType || name,
        market: market || "N/A",
        source: source || (isApiKeyAuth ? "api_key" : "api"),
        programmatic: true,
        apiKey: isApiKeyAuth,
        apiKeyId: (req as any).apiKeyId ?? null,
        lineItemCount: lineItems.length,
      }).catch((err) => log("warn", "trackEvent estimate_generated failed", { error: err?.message }));

      const partnerId: string | null = (req as any).apiKeyPartnerId ?? null;
      if (partnerId) {
        const apiKeyId: string | null = (req as any).apiKeyId ? String((req as any).apiKeyId) : null;
        const isSdkAuth = Boolean((req as any).isSdkAuth);
        incrementPartnerUsage({
          partnerId,
          apiKeyId,
          field: isSdkAuth ? "estimatesSdk" : "estimatesApi",
        }).catch(() => {});
      }

      notifyEstimateReady(uid, estimateId).catch((err) =>
        log("warn", "Push notification for estimate_ready failed", { error: err?.message }),
      );

      import("../lib/automation-engine.js")
        .then((m) =>
          m.fireAutomationEvent(uid, "estimate_created", {
            jobType: jobType || name,
            market: market || "N/A",
            estimateId,
            clientName: clientName || undefined,
            clientEmail: clientEmail || undefined,
          }),
        )
        .catch((err) => log("warn", "Automation estimate_created event failed", { error: err?.message }));

      // Mirror the lead_created emit from the manual /leads POST path so
      // webhook subscribers see every new lead row regardless of source.
      if (createdLeadId) {
        import("../lib/automation-engine.js")
          .then((m) =>
            m.fireAutomationEvent(uid, "lead_created", {
              leadId: createdLeadId,
              name: clientName || "Unknown",
              email: clientEmail || undefined,
              phone: clientPhone || undefined,
              source: "estimate_send_api",
            }),
          )
          .catch((err) => log("warn", "Automation lead_created event failed", { error: err?.message }));
      }

      const responseBody = {
        success: true,
        data: {
          estimateId,
          name,
          source: source ?? null,
          lineItems: lineItems.map((li, idx) => ({
            description: li.description,
            quantity: li.quantity,
            unitCost: li.unitCost,
            uom: li.uom ?? null,
            costType: li.costType ?? null,
            lineTotal: li.quantity * li.unitCost,
            sortOrder: idx,
          })),
          totals,
          createdAt: ts,
        },
      };

      if (idempotencyKey && apiKeyIdStr) {
        await finalizeIdempotencyKey({
          apiKeyId: apiKeyIdStr,
          idempotencyKey,
          responseStatus: 200,
          responseBody,
          estimateId,
        });
      }

      res.json(responseBody);
    }),
  );

  // PATCH /api/estimates/:id — in-place edit of an existing estimate's line items
  // and metadata. Reuses the same shape as /api/estimates/send but does NOT
  // consume a paywall credit and preserves the original `createdAt`. Session
  // auth only (no API key path) — this is a UI-driven edit flow.
  app.patch(
    "/api/estimates/:id",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const [existing] = await db
        .select()
        .from(estimates)
        .where(and(eq(estimates.id, req.params.id), eq(estimates.userId, uid)));
      if (!existing) {
        return res.status(404).json({ success: false, error: "Estimate not found" });
      }

      const parseResult = sendEstimateSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: parseResult.error.issues[0].message,
        });
      }
      const { name, source, jobType, market, details, clientName, clientEmail, clientPhone, lineItems } = parseResult.data;

      const ts = now();
      const totals = computeLineItemTotals(
        lineItems.map((li) => ({ ...li, lineTotal: li.quantity * li.unitCost })),
      );
      const estimateText = renderLineItemsAsText({ name, source, lineItems, totals });

      try {
        await db.transaction(async (tx) => {
          await tx
            .update(estimates)
            .set({
              jobType: jobType || name,
              market: market || "N/A",
              details: details ?? null,
              estimateText,
              name,
              source: source ?? null,
              clientName: clientName || null,
              clientEmail: clientEmail || null,
              clientPhone: clientPhone || null,
              // createdAt is intentionally preserved
            })
            .where(eq(estimates.id, existing.id));

          await tx.delete(estimateLineItems).where(eq(estimateLineItems.estimateId, existing.id));

          if (lineItems.length > 0) {
            await tx.insert(estimateLineItems).values(
              lineItems.map((li, idx) => ({
                id: crypto.randomUUID(),
                estimateId: existing.id,
                description: li.description,
                quantity: li.quantity,
                unitCost: li.unitCost,
                uom: li.uom ?? null,
                costType: li.costType ?? null,
                sortOrder: idx,
                createdAt: ts,
              })),
            );
          }
        });
      } catch (updateErr: any) {
        log("error", "Estimate update failed", {
          error: updateErr?.message,
          userId: uid,
          estimateId: existing.id,
        });
        return res.status(500).json({ success: false, error: "Failed to update estimate." });
      }

      // Drop any cached AI-extracted line items for this estimate so the
      // structured rows we just wrote are what callers see going forward.
      lineItemsCache.delete(`${uid}:${existing.id}`);

      await trackEvent("estimate_updated", uid, {
        jobType: jobType || name,
        market: market || "N/A",
        lineItemCount: lineItems.length,
      }).catch((err) => log("warn", "trackEvent estimate_updated failed", { error: err?.message }));

      import("../lib/automation-engine.js")
        .then((m) =>
          m.fireAutomationEvent(uid, "estimate_updated", {
            estimateId: existing.id,
            jobType: jobType || name,
            market: market || "N/A",
            clientName: clientName || undefined,
            clientEmail: clientEmail || undefined,
            lineItemCount: lineItems.length,
          }),
        )
        .catch((err) =>
          log("warn", "Automation estimate_updated event failed", { error: err?.message }),
        );

      res.json({
        success: true,
        data: {
          estimateId: existing.id,
          name,
          source: source ?? null,
          lineItems: lineItems.map((li, idx) => ({
            description: li.description,
            quantity: li.quantity,
            unitCost: li.unitCost,
            uom: li.uom ?? null,
            costType: li.costType ?? null,
            lineTotal: li.quantity * li.unitCost,
            sortOrder: idx,
          })),
          totals,
          createdAt: existing.createdAt,
        },
      });
    }),
  );

  // PATCH /api/estimates/:id/status — flip an estimate to accepted / rejected
  // (or any other status). When the new status is accepted/rejected, the
  // linked pipeline deal (if any) is auto-moved to Won / Lost. Session-only.
  app.patch(
    "/api/estimates/:id/status",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const { status } = req.body ?? {};
      if (typeof status !== "string" || !status.trim()) {
        return res.status(400).json({ success: false, error: "status is required" });
      }
      const normalized = status.trim().toLowerCase();
      const allowed = new Set(["sent", "accepted", "rejected"]);
      if (!allowed.has(normalized)) {
        return res.status(400).json({
          success: false,
          error: "status must be one of: sent, accepted, rejected",
        });
      }

      const [existing] = await db
        .select()
        .from(estimates)
        .where(and(eq(estimates.id, req.params.id), eq(estimates.userId, uid)));
      if (!existing) {
        return res.status(404).json({ success: false, error: "Estimate not found" });
      }

      await db
        .update(estimates)
        .set({ status: normalized })
        .where(and(eq(estimates.id, existing.id), eq(estimates.userId, uid)));

      if (normalized === "accepted" || normalized === "rejected") {
        await syncDealStageFromEstimateStatus({
          userId: uid,
          estimateId: existing.id,
          status: normalized,
        });
      }

      import("../lib/automation-engine.js")
        .then((m) =>
          m.fireAutomationEvent(uid, "estimate_updated", {
            estimateId: existing.id,
            status: normalized,
            jobType: existing.jobType,
            market: existing.market,
          }),
        )
        .catch((err) =>
          log("warn", "Automation estimate_updated (status) event failed", {
            error: err?.message,
          }),
        );

      res.json({ success: true, data: { estimateId: existing.id, status: normalized } });
    }),
  );

  // POST /api/estimates/:id/email — email the estimate PDF directly to a
  // recipient (the saved client email by default). The PDF attachment is
  // built through `buildEstimatePdfBuffer`, which calls the same shared
  // renderer as `GET /estimate/:id/pdf`, so the homeowner-facing trust bar
  // and footer stay identical whether the contractor downloads the PDF or
  // has us email it. Session auth + CSRF only — this is a UI flow.
  app.post(
    "/api/estimates/:id/email",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const estimateId = req.params.id;

      const expectedToken = req.session?.csrfToken;
      const submittedToken =
        (req.headers["x-csrf-token"] as string | undefined) ||
        (req.body && typeof req.body._csrf === "string" ? req.body._csrf : undefined);
      if (!expectedToken || !submittedToken || submittedToken !== expectedToken) {
        return res.status(403).json({
          success: false,
          error: "Missing or invalid CSRF token. Fetch /api/csrf first and send the token in the X-CSRF-Token header.",
        });
      }

      const recipientRaw =
        (typeof req.body?.to === "string" ? req.body.to : "").trim() || null;
      const messageRaw =
        typeof req.body?.message === "string" ? req.body.message.slice(0, 4000) : "";

      const built = await buildEstimatePdfBuffer(uid, estimateId);
      if (!built) {
        return res.status(404).json({ success: false, error: "Estimate not found" });
      }

      const recipient = recipientRaw || built.estimate.clientEmail;
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!recipient || !emailRe.test(recipient)) {
        return res.status(400).json({
          success: false,
          error: "A valid recipient email is required (no client email is saved on this estimate).",
        });
      }

      const sub = await getSub(uid);
      const senderName = (req.session?.email || "Your contractor").split("@")[0] || "Your contractor";
      const subject = `Your estimate from ${senderName}`;
      const introHtml = messageRaw
        ? `<p style="white-space:pre-wrap">${messageRaw.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</p>`
        : `<p>Hi${built.estimate.clientName ? ` ${built.estimate.clientName}` : ""}, your estimate is attached as a PDF.</p>`;

      try {
        const { client, fromEmail } = await getResendClient();
        await sendEmailWithRetry(
          client,
          {
            from: fromEmail,
            to: recipient,
            subject,
            html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#333">${introHtml}<p>Reply to this email if you have any questions.</p></div>`,
            attachments: [
              {
                filename: built.filename,
                content: built.buffer,
              },
            ],
          },
          {
            idempotencyKey: `estimate-email/${estimateId}/${recipient.toLowerCase()}`,
            logContext: { estimateId, userId: uid },
          },
        );
      } catch (err: any) {
        log("error", "Failed to email estimate PDF", {
          estimateId,
          userId: uid,
          error: err?.message,
        });
        return res.status(502).json({ success: false, error: "Failed to send the email. Please try again shortly." });
      }

      await trackEvent("estimate_emailed", uid, {
        estimateId,
        paid: isPaidActive(sub),
      }).catch(() => {});

      res.json({ success: true, data: { estimateId, sentTo: recipient } });
    }),
  );
}

const lineItemSchema = z.object({
  description: z.string().min(1, "Line item description is required"),
  quantity: z.number().positive("Quantity must be greater than zero"),
  unitCost: z.number().nonnegative("Unit cost cannot be negative"),
  uom: z.string().max(32).optional(),
  costType: z.string().max(64).optional(),
});

const sendEstimateSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  source: z.string().max(64).optional(),
  jobType: z.string().max(120).optional(),
  market: z.string().max(120).optional(),
  details: z.string().optional(),
  clientName: z.string().optional(),
  clientEmail: z.string().email().optional().or(z.literal("")),
  clientPhone: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1, "At least one line item is required").max(500),
});

interface ComputedLineItem {
  description: string;
  quantity: number;
  unitCost: number;
  uom?: string | null;
  costType?: string | null;
  lineTotal: number;
}

function computeLineItemTotals(items: ComputedLineItem[]) {
  const subtotal = items.reduce((sum, li) => sum + li.lineTotal, 0);
  const byCostType: Record<string, number> = {};
  for (const li of items) {
    const key = li.costType || "Uncategorized";
    byCostType[key] = (byCostType[key] || 0) + li.lineTotal;
  }
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    total: Math.round(subtotal * 100) / 100,
    byCostType: Object.fromEntries(
      Object.entries(byCostType).map(([k, v]) => [k, Math.round(v * 100) / 100]),
    ),
    itemCount: items.length,
  };
}

function renderLineItemsAsText(opts: {
  name: string;
  source?: string;
  lineItems: Array<{ description: string; quantity: number; unitCost: number; uom?: string; costType?: string }>;
  totals: ReturnType<typeof computeLineItemTotals>;
}): string {
  const lines: string[] = [];
  lines.push(opts.name);
  if (opts.source) lines.push(`Source: ${opts.source}`);
  lines.push("");
  lines.push("Line Items:");
  for (const li of opts.lineItems) {
    const lineTotal = li.quantity * li.unitCost;
    const uom = li.uom ? ` ${li.uom}` : "";
    const costType = li.costType ? ` (${li.costType})` : "";
    lines.push(`- ${li.description}: ${li.quantity}${uom} × $${li.unitCost.toFixed(2)} = $${lineTotal.toFixed(2)}${costType}`);
  }
  lines.push("");
  for (const [type, amt] of Object.entries(opts.totals.byCostType)) {
    lines.push(`${type}: $${amt.toFixed(2)}`);
  }
  lines.push(`Total: $${opts.totals.total.toFixed(2)}`);
  return lines.join("\n");
}
