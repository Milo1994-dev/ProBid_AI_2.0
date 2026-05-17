import express from "express";
import { z } from "zod";
import { db } from "../db.js";
import { eq, and } from "drizzle-orm";
import { pushTokens, users, subscriptions } from "../../shared/schema.js";
import { requireAuthJson, asyncHandler } from "../lib/middleware.js";
import { log } from "../lib/logger.js";

const registerTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]),
  preferences: z.object({
    estimateReady: z.boolean().default(true),
    trialExpiring: z.boolean().default(true),
    failedPayment: z.boolean().default(true),
  }).optional(),
});

export function registerNotificationRoutes(app: express.Express) {
  app.post(
    "/api/push-tokens",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const parsed = registerTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        });
      }

      const { token, platform, preferences } = parsed.data;
      const now = Date.now();

      const existing = await db
        .select()
        .from(pushTokens)
        .where(eq(pushTokens.token, token));

      if (existing.length > 0) {
        await db
          .update(pushTokens)
          .set({
            userId: uid,
            platform,
            prefEstimateReady: preferences?.estimateReady ?? true,
            prefTrialExpiring: preferences?.trialExpiring ?? true,
            prefFailedPayment: preferences?.failedPayment ?? true,
            updatedAt: now,
          })
          .where(eq(pushTokens.token, token));
      } else {
        await db.insert(pushTokens).values({
          userId: uid,
          token,
          platform,
          prefEstimateReady: preferences?.estimateReady ?? true,
          prefTrialExpiring: preferences?.trialExpiring ?? true,
          prefFailedPayment: preferences?.failedPayment ?? true,
          createdAt: now,
          updatedAt: now,
        });
      }

      res.json({ success: true, data: { registered: true } });
    }),
  );

  app.delete(
    "/api/push-tokens",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;
      const { token } = req.body;
      if (token) {
        await db
          .delete(pushTokens)
          .where(and(eq(pushTokens.userId, uid), eq(pushTokens.token, token)));
      }
      res.json({ success: true });
    }),
  );
}

export async function sendPushNotification(
  expoPushToken: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: expoPushToken,
        sound: "default",
        title,
        body,
        data: data ?? {},
      }),
    });

    const result = await response.json();
    if (result.data?.status === "error") {
      log("warn", "Push notification failed", {
        token: expoPushToken.substring(0, 20) + "...",
        error: result.data.message,
      });
      return false;
    }
    return true;
  } catch (err: any) {
    log("error", "Push notification send error", { error: err?.message });
    return false;
  }
}

export async function notifyEstimateReady(userId: string, estimateId: string): Promise<void> {
  const tokens = await db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.prefEstimateReady, true)));

  for (const t of tokens) {
    await sendPushNotification(
      t.token,
      "Estimate Ready",
      "Your estimate has been generated and is ready to view.",
      { type: "estimate_ready", estimateId },
    );
  }
}

export async function notifyTrialExpiring(userId: string): Promise<void> {
  const tokens = await db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.prefTrialExpiring, true)));

  for (const t of tokens) {
    await sendPushNotification(
      t.token,
      "Trial Expiring Tomorrow",
      "Your free trial expires tomorrow. Upgrade now to keep unlimited access.",
      { type: "trial_expiring" },
    );
  }
}

export async function notifyFailedPayment(userId: string): Promise<void> {
  const tokens = await db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.prefFailedPayment, true)));

  for (const t of tokens) {
    await sendPushNotification(
      t.token,
      "Payment Failed",
      "Your recent payment could not be processed. Please update your payment method.",
      { type: "failed_payment" },
    );
  }
}
