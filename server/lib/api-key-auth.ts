import express from "express";
import crypto from "crypto";
import { db } from "../db.js";
import { apiKeys } from "../../shared/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { log } from "./logger.js";
import { auditSecurityEvent } from "./audit.js";
import rateLimit from "express-rate-limit";
import { getEffectiveSub, isBusinessTier } from "./team-helpers.js";

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = "pbk";
  const secret = crypto.randomBytes(32).toString("hex");
  const key = `${prefix}_${secret}`;
  const hash = hashApiKey(key);
  return { key, prefix, hash };
}

export function isApiKeyFormat(token: string): boolean {
  return token.startsWith("pbk_") || token.startsWith("pb_live_");
}

type VerifyOk = {
  ok: true;
  apiKey: {
    id: number | string;
    userId: string;
    scopes: string[];
    rateLimit: number;
    requestCount: number | null;
  };
};
type VerifyErr = { ok: false; status: number; code: string; message: string };

export async function verifyApiKey(
  key: string,
  req?: express.Request,
): Promise<VerifyOk | VerifyErr> {
  if (!isApiKeyFormat(key)) {
    return { ok: false, status: 401, code: "unauthorized", message: "Invalid API key format" };
  }
  if (!db) {
    return { ok: false, status: 503, code: "service_unavailable", message: "Database not configured" };
  }
  try {
    const hash = hashApiKey(key);
    const [apiKey] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (!apiKey) {
      if (req) auditSecurityEvent("api_key_invalid", { keyPrefix: key.substring(0, 12) }, req);
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid or revoked API key" };
    }

    if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
      if (req) auditSecurityEvent("api_key_expired", { keyId: apiKey.id }, req);
      return { ok: false, status: 401, code: "unauthorized", message: "API key has expired" };
    }

    db.update(apiKeys)
      .set({
        lastUsedAt: Date.now(),
        requestCount: (apiKey.requestCount || 0) + 1,
      })
      .where(eq(apiKeys.id, apiKey.id))
      .catch((err) => log("error", "Failed to update API key usage", { error: String(err) }));

    return {
      ok: true,
      apiKey: {
        id: apiKey.id,
        userId: apiKey.userId,
        scopes: (apiKey.scopes || "").split(",").map((s) => s.trim()).filter(Boolean),
        rateLimit: apiKey.rateLimit ?? 100,
        requestCount: apiKey.requestCount ?? 0,
      },
    };
  } catch (err) {
    log("error", "API key verification error", { error: String(err) });
    return { ok: false, status: 500, code: "internal_error", message: "Authentication failed" };
  }
}

export async function authenticateApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid Authorization header. Use: Bearer <api_key>",
    });
    return;
  }

  const key = authHeader.substring(7);
  const result = await verifyApiKey(key, req);
  if (!result.ok) {
    const err = result as VerifyErr;
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }

  (req as any).apiKeyId = result.apiKey.id;
  (req as any).apiKeyUserId = result.apiKey.userId;
  (req as any).apiKeyScopes = result.apiKey.scopes;
  (req as any).apiKeyRateLimit = result.apiKey.rateLimit;

  next();
}

export function requireScope(scope: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const scopes: string[] = (req as any).apiKeyScopes || [];
    if (!scopes.includes(scope) && !scopes.includes("*")) {
      res.status(403).json({
        error: "forbidden",
        message: `This API key does not have the '${scope}' scope`,
      });
      return;
    }
    next();
  };
}

export function requireApiKeyOrSession(scope: string) {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    const session = (req as any).session as { uid?: string } | undefined;
    if (session && session.uid) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: "Authentication required: provide a session cookie or Bearer API key",
      });
      return;
    }

    const key = authHeader.substring(7).trim();
    if (!isApiKeyFormat(key)) {
      res.status(401).json({
        success: false,
        error: "Invalid API key format. Expected key prefix: pbk_",
      });
      return;
    }

    const result = await verifyApiKey(key, req);
    if (!result.ok) {
      const err = result as VerifyErr;
      res.status(err.status).json({ success: false, error: err.message });
      return;
    }

    if (!result.apiKey.scopes.includes(scope) && !result.apiKey.scopes.includes("*")) {
      res.status(403).json({
        success: false,
        error: `API key is missing required scope: ${scope}`,
      });
      return;
    }

    (req as any).apiKeyId = result.apiKey.id;
    (req as any).apiKeyUserId = result.apiKey.userId;
    (req as any).apiKeyScopes = result.apiKey.scopes;
    (req as any).apiKeyRateLimit = result.apiKey.rateLimit;
    (req as any).isApiKeyAuth = true;
    (req as any).authUserId = result.apiKey.userId;

    // Expose the API key owner via `req.session.uid` for code paths that
    // historically read identity from the session — but make the property
    // NON-ENUMERABLE so cookie-session (which serializes only own-enumerable
    // keys via Session.serialize/isPopulated change detection) does not
    // write it back to the browser as a Set-Cookie.  Without this guard,
    // a scoped API key would bootstrap a full web session cookie and bypass
    // scope isolation on every other session-protected endpoint.
    // Prefer `req.authUserId` / `req.isApiKeyAuth` in NEW code paths.
    try {
      if (!(req as any).session) (req as any).session = {};
      Object.defineProperty((req as any).session, "uid", {
        value: result.apiKey.userId,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    } catch (e) {
      log("warn", "Could not attach apiKey uid to req.session (non-fatal)", {
        error: String(e),
      });
    }

    apiKeyRateLimiter(req, res, next);
  };
}

const apiKeyRateLimiters = new Map<number, ReturnType<typeof rateLimit>>();

export function apiKeyRateLimiter(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const limit = (req as any).apiKeyRateLimit || 100;

  if (!apiKeyRateLimiters.has(limit)) {
    apiKeyRateLimiters.set(
      limit,
      rateLimit({
        windowMs: 60 * 1000,
        max: limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => (req as any).apiKeyId || req.ip || "unknown",
        handler: (_req, res) => {
          res.status(429).json({
            error: "rate_limit_exceeded",
            message: `Rate limit of ${limit} requests per minute exceeded`,
          });
        },
      }),
    );
  }

  apiKeyRateLimiters.get(limit)!(req, res, next);
}

export async function hasApiBusinessAccess(userId: string): Promise<boolean> {
  try {
    const sub = await getEffectiveSub(userId);
    if (!sub) return false;
    return isBusinessTier(sub.priceId);
  } catch (err) {
    log("error", "api-key-auth: hasApiBusinessAccess() error", { error: String(err) });
    return false;
  }
}
