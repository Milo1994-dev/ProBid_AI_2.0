import express from "express";
import { db } from "../../db.js";
import { eq, isNull, desc, and, or } from "drizzle-orm";
import { sdkAllowedOrigins, partners } from "../../../shared/schema.js";
import { requireAdminAuth } from "../../lib/middleware.js";
import { asyncHandler } from "../../lib/middleware.js";
import {
  parseAllowlistEntry,
  bumpSdkAllowlistCache,
  isParsedEntrySuccess,
  isSdkAllowlistDbLoaderActive,
} from "../../lib/cors.js";
import { recordAudit } from "../../lib/audit.js";
import { log } from "../../lib/logger.js";

const MAX_NOTE_LEN = 500;

function getAdminUserId(req: express.Request): string {
  // Both `uid` and `userId` are part of the project's session
  // augmentation (see other middleware in server/lib/middleware.ts
  // that reads `req.session?.uid` directly). When the admin used the
  // header key path (no logged-in session) we fall back to a stable
  // sentinel so the audit log still names a principal.
  return (
    req.session?.uid ||
    req.session?.userId ||
    "admin-key"
  );
}

function isPgUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /unique/i.test(message);
}

function envEntries(): Array<{ origin: string; kind: "exact" | "wildcard" }> {
  const raw = (process.env.SDK_ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return [];
  const out: Array<{ origin: string; kind: "exact" | "wildcard" }> = [];
  for (const entryRaw of raw.split(",")) {
    const result = parseAllowlistEntry(entryRaw.trim());
    if (!result.ok) continue;
    out.push({ origin: result.normalized, kind: result.kind });
  }
  return out;
}

export function registerAdminSdkAllowlistRoutes(app: express.Application): void {
  // List DB entries (active + revoked) and env-derived bootstrap entries.
  // Surfaces `dbLoaderActive` so the UI can flag degraded env-only mode.
  app.get(
    "/api/admin/sdk-allowlist",
    requireAdminAuth,
    asyncHandler(async (_req: express.Request, res: express.Response) => {
      const rows = await db
        .select()
        .from(sdkAllowedOrigins)
        .orderBy(desc(sdkAllowedOrigins.createdAt));

      res.json({
        success: true,
        data: {
          dbLoaderActive: isSdkAllowlistDbLoaderActive(),
          envEntries: envEntries(),
          dbEntries: rows.map((row) => ({
            id: row.id,
            origin: row.origin,
            kind: row.kind,
            note: row.note,
            createdAt: row.createdAt,
            createdBy: row.createdBy,
            revokedAt: row.revokedAt,
            revokedBy: row.revokedBy,
          })),
        },
      });
    }),
  );

  // POST { origin, note? } — adds a new origin, resurrects a previously
  // revoked one, or returns 409 if already active.
  app.post(
    "/api/admin/sdk-allowlist",
    requireAdminAuth,
    express.json(),
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { origin: rawOrigin, note: rawNote } = (req.body ?? {}) as {
        origin?: unknown;
        note?: unknown;
      };

      const parsed = parseAllowlistEntry(rawOrigin);
      if (!isParsedEntrySuccess(parsed)) {
        return res
          .status(400)
          .json({ success: false, error: parsed.reason });
      }

      const note =
        typeof rawNote === "string" && rawNote.trim()
          ? rawNote.trim().slice(0, MAX_NOTE_LEN)
          : null;

      const adminId = getAdminUserId(req);
      const now = Date.now();

      // Look for an existing row (active or revoked) with this origin.
      const existing = await db
        .select()
        .from(sdkAllowedOrigins)
        .where(eq(sdkAllowedOrigins.origin, parsed.normalized))
        .limit(1);

      if (existing.length > 0) {
        const row = existing[0];
        if (row.revokedAt == null) {
          return res.status(409).json({
            success: false,
            error: "Origin is already on the allowlist",
            data: { id: row.id },
          });
        }
        // Resurrect a previously revoked row. Keep the original
        // `createdAt`/`createdBy` so historical "when was this origin
        // first added" stays accurate; the resurrect event is captured
        // in the audit log below (action: sdk_allowlist:resurrect),
        // which is the source of truth for reactivation history.
        const updated = await db
          .update(sdkAllowedOrigins)
          .set({
            revokedAt: null,
            revokedBy: null,
            note: note ?? row.note,
          })
          .where(eq(sdkAllowedOrigins.id, row.id))
          .returning();

        bumpSdkAllowlistCache();
        await recordAudit({
          action: "sdk_allowlist:resurrect",
          userId: adminId,
          resource: "sdk_allowed_origins",
          resourceId: String(row.id),
          ipAddress: req.ip || req.socket.remoteAddress,
          userAgent: req.headers["user-agent"]?.substring(0, 500),
          method: req.method,
          path: req.path,
          statusCode: 200,
          details: JSON.stringify({
            origin: parsed.normalized,
            kind: parsed.kind,
          }),
        });
        log("info", "SDK allowlist origin resurrected", {
          id: row.id,
          origin: parsed.normalized,
          adminId,
        });
        return res.json({ success: true, data: { entry: updated[0] } });
      }

      let inserted;
      try {
        inserted = await db
          .insert(sdkAllowedOrigins)
          .values({
            origin: parsed.normalized,
            kind: parsed.kind,
            note,
            createdAt: now,
            createdBy: adminId,
          })
          .returning();
      } catch (err: unknown) {
        // Two requests could race past the SELECT above and both try
        // to INSERT the same origin. The unique index on `origin`
        // turns the loser into a Postgres `unique_violation` (SQLSTATE
        // 23505). Translate that into a deterministic 409 instead of
        // a 500 so the admin UI can show a clear "already on the
        // allowlist" message.
        if (isPgUniqueViolation(err)) {
          const existingNow = await db
            .select({ id: sdkAllowedOrigins.id })
            .from(sdkAllowedOrigins)
            .where(eq(sdkAllowedOrigins.origin, parsed.normalized))
            .limit(1);
          return res.status(409).json({
            success: false,
            error: "Origin is already on the allowlist",
            data: { id: existingNow[0]?.id },
          });
        }
        throw err;
      }

      bumpSdkAllowlistCache();
      await recordAudit({
        action: "sdk_allowlist:add",
        userId: adminId,
        resource: "sdk_allowed_origins",
        resourceId: String(inserted[0]?.id ?? ""),
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.headers["user-agent"]?.substring(0, 500),
        method: req.method,
        path: req.path,
        statusCode: 200,
        details: JSON.stringify({
          origin: parsed.normalized,
          kind: parsed.kind,
        }),
      });
      log("info", "SDK allowlist origin added", {
        id: inserted[0]?.id,
        origin: parsed.normalized,
        adminId,
      });
      return res.json({ success: true, data: { entry: inserted[0] } });
    }),
  );

  // Soft-revoke. We never hard-delete so the audit trail and the
  // resurrect-on-readd flow above keep working.
  app.delete(
    "/api/admin/sdk-allowlist/:id",
    requireAdminAuth,
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid id" });
      }

      const existing = await db
        .select()
        .from(sdkAllowedOrigins)
        .where(eq(sdkAllowedOrigins.id, id))
        .limit(1);

      if (existing.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Origin not found" });
      }
      if (existing[0].revokedAt != null) {
        return res
          .status(409)
          .json({ success: false, error: "Origin already revoked" });
      }

      const adminId = getAdminUserId(req);
      const now = Date.now();
      await db
        .update(sdkAllowedOrigins)
        .set({ revokedAt: now, revokedBy: adminId })
        .where(eq(sdkAllowedOrigins.id, id));

      bumpSdkAllowlistCache();
      await recordAudit({
        action: "sdk_allowlist:revoke",
        userId: adminId,
        resource: "sdk_allowed_origins",
        resourceId: String(id),
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.headers["user-agent"]?.substring(0, 500),
        method: req.method,
        path: req.path,
        statusCode: 200,
        details: JSON.stringify({
          origin: existing[0].origin,
          kind: existing[0].kind,
        }),
      });
      log("info", "SDK allowlist origin revoked", {
        id,
        origin: existing[0].origin,
        adminId,
      });
      return res.json({ success: true });
    }),
  );
}

/**
 * The DB loader the cors module uses to merge env + DB entries.
 * Wired in `server.ts` via `setSdkAllowlistDbLoader`. Returns the
 * raw `origin` strings of every active row; the cors module
 * re-parses each through `parseAllowlistEntry` so DB and env
 * entries take the same validation path.
 */
export async function loadActiveSdkOrigins(): Promise<Array<{ origin: string }>> {
  const rows = await db
    .select({ origin: sdkAllowedOrigins.origin, partnerId: sdkAllowedOrigins.partnerId })
    .from(sdkAllowedOrigins)
    .where(isNull(sdkAllowedOrigins.revokedAt));

  if (rows.length === 0) return [];

  const partnerIdSet = new Set(rows.map((r) => r.partnerId).filter((id): id is string => id != null));
  let suspendedPartnerIds = new Set<string>();

  if (partnerIdSet.size > 0) {
    const suspendedRows = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.status, "suspended"));
    suspendedPartnerIds = new Set(suspendedRows.map((r) => r.id));
  }

  return rows
    .filter((r) => r.partnerId == null || !suspendedPartnerIds.has(r.partnerId))
    .map((r) => ({ origin: r.origin }));
}

export async function getPartnerAllowedOrigins(partnerId: string): Promise<Set<string>> {
  if (!db) return new Set();
  const rows = await db
    .select({ origin: sdkAllowedOrigins.origin })
    .from(sdkAllowedOrigins)
    .where(and(isNull(sdkAllowedOrigins.revokedAt), eq(sdkAllowedOrigins.partnerId, partnerId)));
  return new Set(rows.map((r) => r.origin));
}

export async function isOriginAllowedForPartner(origin: string, partnerId: string): Promise<boolean> {
  if (!db) return false;
  const allowed = await getPartnerAllowedOrigins(partnerId);
  if (!origin) return false;
  let normalized: string;
  try {
    const u = new URL(origin);
    normalized = `${u.protocol}//${u.host}`;
  } catch {
    return false;
  }
  for (const entry of allowed) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1).toLowerCase();
      const host = normalized.replace(/^https?:\/\//, "").toLowerCase();
      if (host.endsWith(suffix)) return true;
    } else {
      if (entry === normalized) return true;
    }
  }
  return false;
}
