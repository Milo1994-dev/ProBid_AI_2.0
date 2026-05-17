import express from "express";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../db.js";
import { eq, and, asc, desc, count, sql, isNotNull } from "drizzle-orm";
import { savedLineItems } from "../../shared/schema.js";
import { asyncHandler, requireAuthJson, validateCsrf } from "../lib/middleware.js";
import { now } from "../lib/utils.js";

const MAX_DESCRIPTION = 500;
const MAX_UOM = 32;
const MAX_COST_TYPE = 64;
const MAX_TAG = 48;
const MAX_PRESETS_PER_USER = 200;
const MAX_SEARCH_LEN = 200;
const RECENT_LIMIT = 5;

const savedLineItemSchema = z.object({
  description: z.string().trim().min(1, "Description is required").max(MAX_DESCRIPTION),
  quantity: z.number().finite().positive("Quantity must be > 0"),
  unitCost: z.number().finite().nonnegative("Unit cost must be ≥ 0"),
  uom: z.string().trim().max(MAX_UOM).optional().or(z.literal("")),
  costType: z.string().trim().max(MAX_COST_TYPE).optional().or(z.literal("")),
  tag: z.string().trim().max(MAX_TAG).optional().or(z.literal("")),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const listQuerySchema = z.object({
  q: z.string().trim().max(MAX_SEARCH_LEN).optional(),
  tag: z.string().trim().max(MAX_TAG).optional(),
  costType: z.string().trim().max(MAX_COST_TYPE).optional(),
});

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function rowToPreset(r: typeof savedLineItems.$inferSelect) {
  return {
    id: r.id,
    description: r.description,
    quantity: r.quantity,
    unitCost: r.unitCost,
    uom: r.uom,
    costType: r.costType,
    tag: r.tag,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  };
}

export function registerSavedLineItemRoutes(app: express.Application) {
  // GET /api/saved-line-items — list current user's saved presets.
  // Optional ?q=<text>, ?tag=<tag>, ?costType=<type> filters.
  // Sorted with most-recently-used first, then alphabetical by description.
  // Also returns the user's distinct tag list (for the picker chip row) and
  // a `recent` slice (top 5 most recently used) so the picker can render its
  // "Recently used" section without an extra round trip.
  app.get(
    "/api/saved-line-items",
    requireAuthJson,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ success: false, error: parsed.error.issues[0].message });
      }
      const { q, tag, costType } = parsed.data;

      const filters = [eq(savedLineItems.userId, uid)];
      if (q && q.length > 0) {
        const like = `%${escapeLike(q.toLowerCase())}%`;
        filters.push(
          sql`lower(${savedLineItems.description}) LIKE ${like} ESCAPE '\\'`,
        );
      }
      if (tag && tag.length > 0) {
        filters.push(eq(savedLineItems.tag, tag));
      }
      if (costType && costType.length > 0) {
        filters.push(eq(savedLineItems.costType, costType));
      }

      const rows = await db
        .select()
        .from(savedLineItems)
        .where(and(...filters))
        .orderBy(
          // NULLS LAST so never-used presets fall below recently-used ones,
          // then break ties alphabetically.
          sql`${savedLineItems.lastUsedAt} DESC NULLS LAST`,
          asc(savedLineItems.description),
        );

      const recent = await db
        .select()
        .from(savedLineItems)
        .where(
          and(
            eq(savedLineItems.userId, uid),
            isNotNull(savedLineItems.lastUsedAt),
          ),
        )
        .orderBy(desc(savedLineItems.lastUsedAt))
        .limit(RECENT_LIMIT);

      const tagRows = await db
        .selectDistinct({ tag: savedLineItems.tag })
        .from(savedLineItems)
        .where(
          and(
            eq(savedLineItems.userId, uid),
            isNotNull(savedLineItems.tag),
          ),
        );
      const tags = tagRows
        .map((t) => t.tag)
        .filter((t): t is string => !!t && t.length > 0)
        .sort((a, b) => a.localeCompare(b));

      res.json({
        success: true,
        data: {
          presets: rows.map(rowToPreset),
          recent: recent.map(rowToPreset),
          tags,
        },
      });
    }),
  );

  // POST /api/saved-line-items — save a new preset for the current user
  app.post(
    "/api/saved-line-items",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const parsed = savedLineItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ success: false, error: parsed.error.issues[0].message });
      }

      const [{ c: existingCount } = { c: 0 }] = await db
        .select({ c: count() })
        .from(savedLineItems)
        .where(eq(savedLineItems.userId, uid));

      if (existingCount >= MAX_PRESETS_PER_USER) {
        return res.status(400).json({
          success: false,
          error: `You can save up to ${MAX_PRESETS_PER_USER} presets. Delete some before adding more.`,
        });
      }

      const id = crypto.randomUUID();
      const description = parsed.data.description.trim();
      const uom = parsed.data.uom?.trim() || null;
      const costType = parsed.data.costType?.trim() || null;
      const tag = parsed.data.tag?.trim() || null;
      const createdAt = now();

      await db.insert(savedLineItems).values({
        id,
        userId: uid,
        description,
        quantity: parsed.data.quantity,
        unitCost: parsed.data.unitCost,
        uom,
        costType,
        tag,
        lastUsedAt: null,
        createdAt,
      });

      res.json({
        success: true,
        data: {
          preset: {
            id,
            description,
            quantity: parsed.data.quantity,
            unitCost: parsed.data.unitCost,
            uom,
            costType,
            tag,
            lastUsedAt: null,
            createdAt,
          },
        },
      });
    }),
  );

  // POST /api/saved-line-items/:id/use — bump lastUsedAt when the user inserts
  // a preset into an estimate. Best-effort; if the preset doesn't belong to
  // the current user we silently noop (no rows updated).
  app.post(
    "/api/saved-line-items/:id/use",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const parsed = idParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: "Invalid preset id" });
      }

      const lastUsedAt = now();
      await db
        .update(savedLineItems)
        .set({ lastUsedAt })
        .where(
          and(
            eq(savedLineItems.id, parsed.data.id),
            eq(savedLineItems.userId, uid),
          ),
        );

      res.json({ success: true, data: { lastUsedAt } });
    }),
  );

  // DELETE /api/saved-line-items/:id — delete a preset owned by the current user
  app.delete(
    "/api/saved-line-items/:id",
    requireAuthJson,
    validateCsrf,
    asyncHandler(async (req, res) => {
      const uid = req.session!.uid!;

      const parsed = idParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: "Invalid preset id" });
      }

      await db
        .delete(savedLineItems)
        .where(
          and(
            eq(savedLineItems.id, parsed.data.id),
            eq(savedLineItems.userId, uid),
          ),
        );

      res.json({ success: true, data: null });
    }),
  );
}
