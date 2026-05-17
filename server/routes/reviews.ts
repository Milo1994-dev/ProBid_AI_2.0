import express from "express";
import { z } from "zod";
import { db } from "../db.js";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { reviews } from "../../shared/schema.js";
import { asyncHandler, requireAuthJson } from "../lib/middleware.js";
import { now } from "../lib/utils.js";
import { log } from "../lib/logger.js";

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  userName: z.string().max(50).optional(),
  userTrade: z.string().max(60).optional(),
});

export function registerReviewRoutes(app: express.Application) {
  app.post(
    "/api/reviews",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const parseResult = reviewSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues[0].message });
      }

      const { rating, comment, userName, userTrade } = parseResult.data;

      try {
        const [inserted] = await db.insert(reviews).values({
          userId: uid,
          userName: userName?.trim() || null,
          userTrade: userTrade?.trim() || null,
          rating,
          comment: comment?.trim() || null,
          approved: false,
          hidden: false,
          createdAt: now(),
        }).returning();

        log("info", "Review submitted", { userId: uid, reviewId: inserted.id, rating });

        res.json({ success: true, data: { id: inserted.id } });
      } catch (err: any) {
        if (err?.code === "23505" || err?.constraint?.includes("user")) {
          return res.status(409).json({ success: false, error: "You have already submitted a review" });
        }
        throw err;
      }
    }),
  );

  app.get(
    "/api/reviews",
    asyncHandler(async (req, res) => {
      const approvedReviews = await db
        .select()
        .from(reviews)
        .where(and(eq(reviews.approved, true), eq(reviews.hidden, false)))
        .orderBy(desc(reviews.createdAt))
        .limit(6);

      const [statsRow] = await db
        .select({
          avgRating: sql<number>`ROUND(AVG(${reviews.rating})::numeric, 1)`,
          totalCount: count(),
        })
        .from(reviews)
        .where(and(eq(reviews.approved, true), eq(reviews.hidden, false)));

      const avgRating = statsRow?.avgRating ? Number(statsRow.avgRating) : 0;
      const totalCount = statsRow?.totalCount ?? 0;

      res.json({
        success: true,
        data: {
          reviews: approvedReviews.map((r) => ({
            id: r.id,
            userName: r.userName,
            userTrade: r.userTrade,
            rating: r.rating,
            comment: r.comment,
            createdAt: r.createdAt,
          })),
          aggregate: {
            avgRating,
            totalCount,
          },
        },
      });
    }),
  );

  app.get(
    "/api/reviews/mine",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const [myReview] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.userId, uid))
        .limit(1);

      res.json({
        success: true,
        data: myReview
          ? {
              id: myReview.id,
              rating: myReview.rating,
              comment: myReview.comment,
              approved: myReview.approved,
              createdAt: myReview.createdAt,
            }
          : null,
      });
    }),
  );
}
