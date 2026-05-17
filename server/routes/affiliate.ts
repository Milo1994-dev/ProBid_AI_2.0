import express from "express";
import { db } from "../db.js";
import { eq, and, desc, count, sum, sql } from "drizzle-orm";
import { users, affiliateClicks, referrals, affiliateEarnings, referralLeads, homepageLeads } from "../../shared/schema.js";
import { asyncHandler } from "../lib/middleware.js";
import { ensureAffiliateCode, trackAffiliateClick, attributeReferral } from "../lib/affiliate-helpers.js";
import { log } from "../lib/logger.js";
import { trackEvent } from "../lib/analytics.js";
import { APP_URL } from "../lib/config.js";
import { z } from "zod";

export function registerAffiliateRoutes(app: express.Application) {
  app.get(
    "/api/affiliate",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid)
        return res
          .status(401)
          .json({ success: false, error: "Not authenticated" });

      const code = await ensureAffiliateCode(uid);
      const link = `${APP_URL}/r/${code}`;

      const [clickRows, referralRows, earningsRows] = await Promise.all([
        db
          .select({ c: count() })
          .from(affiliateClicks)
          .where(eq(affiliateClicks.affiliateCode, code)),
        db
          .select({ c: count() })
          .from(referrals)
          .where(
            and(
              eq(referrals.referrerUserId, uid),
              eq(referrals.status, "subscribed"),
            ),
          ),
        db
          .select({ s: sum(affiliateEarnings.amountCents) })
          .from(affiliateEarnings)
          .where(eq(affiliateEarnings.affiliateUserId, uid)),
      ]);

      const clicks = clickRows[0]?.c ?? 0;
      const conversions = referralRows[0]?.c ?? 0;
      const earnings = Number(earningsRows[0]?.s ?? 0);

      const rankResult = await db.execute(
        sql`SELECT count(*)::int AS cnt FROM (
        SELECT referrer_user_id FROM referrals WHERE status = 'subscribed'
        GROUP BY referrer_user_id HAVING count(*) > ${conversions}
      ) AS subq`,
      );
      const rank = ((rankResult.rows[0]?.cnt as number) ?? 0) + 1;

      res.json({
        success: true,
        data: { code, link, clicks, conversions, earnings, rank },
      });
    }),
  );

  app.get(
    "/api/referrals",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid;
      if (!uid)
        return res
          .status(401)
          .json({ success: false, error: "Not authenticated" });

      const rows = await db
        .select({
          id: referrals.id,
          referredUserId: referrals.referredUserId,
          status: referrals.status,
          createdAt: referrals.createdAt,
          referredEmail: users.email,
        })
        .from(referrals)
        .leftJoin(users, eq(users.id, referrals.referredUserId))
        .where(eq(referrals.referrerUserId, uid))
        .orderBy(desc(referrals.createdAt))
        .limit(50);

      const result = rows.map((r) => ({
        id: r.id,
        referredEmail: r.referredEmail ?? "",
        status: r.status ?? "signed_up",
        createdAt: r.createdAt,
      }));

      res.json({ success: true, data: { referrals: result } });
    }),
  );

  app.post(
    "/api/analytics/event",
    asyncHandler(async (req, res) => {
      const uid = req.session?.uid ?? undefined;
      const body = (req.body ?? {}) as { event?: unknown; properties?: unknown };
      const event = body.event;

      // Bound the event name (storage + abuse mitigation). Unauthenticated
      // callers can hit this endpoint, so reject anything that isn't a short
      // alphanumeric/underscore identifier.
      if (typeof event !== "string" || event.length === 0 || event.length > 64 || !/^[a-z0-9_]+$/i.test(event)) {
        res.json({ success: true, data: null });
        return;
      }

      // Cap properties payload size so a misbehaving client (or attacker)
      // can't fill the analytics table with multi-KB rows.
      let props: Record<string, unknown> | undefined;
      if (body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)) {
        const serialized = JSON.stringify(body.properties);
        if (serialized.length <= 2048) {
          props = body.properties as Record<string, unknown>;
        }
      }

      await trackEvent(event, uid, props || {}).catch(err =>
        log("warn", "trackEvent analytics failed", { error: err?.message }),
      );
      res.json({ success: true, data: null });
    }),
  );

  app.get(
    "/r/:code",
    asyncHandler(async (req, res) => {
      const code = req.params.code;
      const ip =
        req.headers["x-forwarded-for"]?.toString().split(",")[0] ||
        req.socket.remoteAddress ||
        null;
      const userAgent = req.headers["user-agent"] || null;
      await trackAffiliateClick(code, ip, userAgent);
      res.redirect(`/login?ref=${encodeURIComponent(code)}`);
    }),
  );
}
