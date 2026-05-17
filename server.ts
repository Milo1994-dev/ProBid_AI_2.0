import "dotenv/config";
// Smoke-mode bootstrap: must be imported BEFORE `./server/db.js` so the
// optional SMOKE_DATABASE_URL override is applied before DATABASE_URL is read.
import "./server/lib/smoke-mode.js";
import express from "express";
import cookieSession from "cookie-session";
import compression from "compression";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const clientDistIndex = path.join(
  process.cwd(),
  "client",
  "dist",
  "index.html",
);
if (!fs.existsSync(clientDistIndex)) {
  console.log("[startup] client/dist not found — building React SPA...");
  try {
    execSync("npm run build:client", { stdio: "inherit", cwd: process.cwd() });
    console.log("[startup] React SPA build complete.");
  } catch (err) {
    console.warn("[startup] React SPA build failed (non-fatal):", err);
  }
}

import {
  db,
  pool,
  isDatabaseConfigured,
  checkDatabaseConnection,
} from "./server/db.js";
import { extractBearerAuth } from "./server/lib/middleware.js";
import { registerChatRoutes } from "./server/replit_integrations/chat/index.js";
import { registerImageRoutes } from "./server/replit_integrations/image/index.js";
import { registerProcoreRoutes } from "./server/routes/procore.js";
import { registerAuthRoutes } from "./server/routes/auth.js";
import { registerEstimateRoutes } from "./server/routes/estimates.js";
import { registerSavedLineItemRoutes } from "./server/routes/saved-line-items.js";
import { registerMarketingStatsRoutes } from "./server/routes/marketing-stats.js";
import { registerReviewRoutes } from "./server/routes/reviews.js";
import { registerBillingRoutes, stripeWebhookHandler } from "./server/routes/billing.js";
import { registerLeadsRoutes } from "./server/routes/leads.js";
import { registerContactRoutes } from "./server/routes/contact.js";
import { registerAdminRoutes } from "./server/routes/admin/index.js";
import { registerTeamRoutes } from "./server/routes/teams.js";
import { registerSystemRoutes } from "./server/routes/system.js";
import { registerAffiliateRoutes } from "./server/routes/affiliate.js";
import { registerMarketingRoutes } from "./server/routes/marketing.js";
import { registerOutreachRoutes } from "./server/routes/outreach.js";
import { registerLegacySsrRoutes } from "./server/routes/legacy-ssr.js";
import { registerApiKeyRoutes } from "./server/routes/api-keys.js";
import { registerWebhookRoutes } from "./server/routes/webhooks.js";
import { registerApiV1Routes } from "./server/routes/api-v1.js";
import { registerNotificationRoutes } from "./server/routes/notifications.js";
import { registerPipelineRoutes } from "./server/routes/pipeline.js";
import { registerAutomationRoutes } from "./server/routes/automations.js";
import { registerPartnerRoutes } from "./server/routes/partner.js";
import { registerGuaranteeRoutes } from "./server/routes/guarantee.js";
import { seedSeoPages, seedOutreachConfig, initOutreachState, cleanupStaleJobRuns, migrateReviewsTable, initSdkAllowlistTable, initPartnersSchema } from "./server/db/init.js";
import { runMigrations } from "./server/db/migrate.js";
import { startScheduler } from "./server/jobs/scheduler.js";
import { initSystemAlerts } from "./server/health-monitor.js";
import { log } from "./server/lib/logger.js";
import { APP_URL, hasEnv, logStartupSummary } from "./server/lib/config.js";
import { trackError, setupProcessErrorHandlers } from "./server/lib/error-tracker.js";
import { sdkCorsMiddleware, publicScriptCorsMiddleware } from "./server/lib/cors.js";
import { sdkSessionMiddleware } from "./server/lib/sdk-session.js";
import { isSmokeMode } from "./server/lib/smoke-mode.js";

function mustEnv(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
}

const SESSION_SECRET = mustEnv("SESSION_SECRET");

const app = express();

app.set("trust proxy", 1);

// ─────────────────────────────────────────────────────────────────────────────
// WordPress / .env probe blackhole.  Bots scan every internet-facing host for
// these paths; we are not WordPress and never will be. Return 410 Gone (tells
// bots the resource is permanently absent so they stop retrying) as cheaply as
// possible — before host redirects, before compression, before body parsing.
//
// Logging is throttled per-IP so an attack does not flood the logs.
// ─────────────────────────────────────────────────────────────────────────────
const WP_HONEYPOT_PATTERN =
  /^\/(wp-login\.php|wp-admin(\/|$)|wp-content(\/|$)|wp-includes(\/|$)|xmlrpc\.php|\.env|\.git(\/|$)|phpmyadmin(\/|$))/i;

const wpHoneypotLogCache = new Map<string, number>();
const WP_HONEYPOT_LOG_INTERVAL_MS = 5 * 60 * 1000;
const wpHoneypotHits = new Map<string, { count: number; firstAt: number }>();
const WP_HONEYPOT_WINDOW_MS = 15 * 60 * 1000;

app.use((req, res, next) => {
  if (!WP_HONEYPOT_PATTERN.test(req.path)) return next();

  const ip = (req.ip || req.headers["x-forwarded-for"] || "unknown")
    .toString()
    .split(",")[0]
    .trim();
  const now = Date.now();

  // Sliding-window hit counter for repeat-offender visibility.
  const bucket = wpHoneypotHits.get(ip);
  if (!bucket || now - bucket.firstAt > WP_HONEYPOT_WINDOW_MS) {
    wpHoneypotHits.set(ip, { count: 1, firstAt: now });
  } else {
    bucket.count += 1;
  }

  // Periodic cleanup so the map can't grow unbounded under attack.
  if (wpHoneypotHits.size > 5000) {
    for (const [k, v] of wpHoneypotHits) {
      if (now - v.firstAt > WP_HONEYPOT_WINDOW_MS) wpHoneypotHits.delete(k);
    }
  }

  // Log at most one line per IP every 5 minutes, with the current hit count.
  const lastLoggedAt = wpHoneypotLogCache.get(ip) ?? 0;
  if (now - lastLoggedAt > WP_HONEYPOT_LOG_INTERVAL_MS) {
    wpHoneypotLogCache.set(ip, now);
    const count = wpHoneypotHits.get(ip)?.count ?? 1;
    // eslint-disable-next-line no-console
    console.warn(
      `[wp-honeypot] blocked ip=${ip} path=${req.path} method=${req.method} ` +
        `count_15m=${count} ua=${String(req.headers["user-agent"] ?? "").slice(0, 120)}`,
    );
  }

  // Discourage retry: 410 = "this resource is permanently gone".
  res.set("Cache-Control", "public, max-age=86400");
  return res.status(410).end();
});

app.use((req, res, next) => {
  // Strip any port from the Host header so comparisons are robust whether the
  // request hits the public proxy (no port) or a local dev curl (e.g. ":5000").
  const host = (req.headers.host ?? "").toLowerCase().split(":")[0];

  // Belt-and-suspenders: never redirect the workspace dev preview, even if the
  // dev domain were ever to overlap with a redirect rule below.
  const devDomain = (process.env.REPLIT_DEV_DOMAIN ?? "").toLowerCase();
  if (devDomain && host === devDomain) return next();

  if (host === "probidcore.com" || host === "www.probidcore.com") {
    return res.redirect(301, `https://probidcore.net${req.originalUrl}`);
  }
  if (host === "www.probidcore.net") {
    return res.redirect(301, `https://probidcore.net${req.originalUrl}`);
  }
  // Auto-generated Replit deployment alias — redirect to the canonical brand
  // domain so SEO consolidates on probidcore.net (Task #113). The mobile app
  // uses a separate alias (probid-core.replit.app) which is NOT matched here.
  if (host === "pro-bid-core--jessekirchner24.replit.app") {
    return res.redirect(301, `https://probidcore.net${req.originalUrl}`);
  }
  next();
});

app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers["x-no-compression"]) return false;
    return compression.filter(req, res);
  },
}));

app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=(self)");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "js.stripe.com",
          "www.googletagmanager.com",
          "www.google-analytics.com",
          "googleads.g.doubleclick.net",
          "www.googleadservices.com",
          "connect.facebook.net",
          "snap.licdn.com",
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "fonts.googleapis.com",
        ],
        fontSrc: [
          "'self'",
          "fonts.gstatic.com",
          "data:",
        ],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "*.stripe.com",
          "www.google-analytics.com",
          "www.googletagmanager.com",
          "www.facebook.com",
          "*.facebook.com",
          "www.google.com",
          "googleads.g.doubleclick.net",
          "www.googleadservices.com",
          "*.google.com",
        ],
        connectSrc: [
          "'self'",
          "api.stripe.com",
          "www.google-analytics.com",
          "*.googleapis.com",
          "www.facebook.com",
          "*.facebook.com",
          "connect.facebook.net",
          "googleads.g.doubleclick.net",
          "www.googleadservices.com",
          "*.google-analytics.com",
          "*.analytics.google.com",
        ],
        frameSrc: [
          "'self'",
          "js.stripe.com",
          "hooks.stripe.com",
          "www.facebook.com",
          "bid.g.doubleclick.net",
          "td.doubleclick.net",
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: process.env.REPLIT_DEPLOYMENT === "1" ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
);

const ESTIMATE_WINDOW_S = 15 * 60;
const AUTH_WINDOW_S = 15 * 60;

const estimateLimiter = rateLimit({
  windowMs: ESTIMATE_WINDOW_S * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: "Too many requests. Please wait a few minutes and try again.",
      retryAfter: ESTIMATE_WINDOW_S,
    });
  },
});

const authLimiter = rateLimit({
  windowMs: AUTH_WINDOW_S * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: "Too many login attempts. Please try again in a few minutes.",
      retryAfter: AUTH_WINDOW_S,
    });
  },
});

const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, error: "Rate limit exceeded. Please slow down." });
  },
  skip: (req) => req.path.startsWith("/api/stripe/"),
});

// Cross-origin allowlist for the public `integrate.js` SDK.  Applied to
// the CSRF + session-info endpoints the SDK warms up against and to the
// estimate ingest endpoint it posts to. The middleware reflects the
// request Origin only when it appears in `SDK_ALLOWED_ORIGINS`, sets
// `Access-Control-Allow-Credentials: true`, and short-circuits OPTIONS
// preflight requests with 204 so they don't trip rate limiters or auth.
app.use(["/api/csrf", "/api/me", "/api/estimates/send"], sdkCorsMiddleware);

app.use("/api/", (req, res, next) => {
  if (req.path.startsWith("/v1")) return next();
  generalApiLimiter(req, res, next);
});
const entitlementsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, error: "Rate limit exceeded. Please slow down." });
  },
});
app.use("/api/estimates", estimateLimiter);
app.use("/api/entitlements", entitlementsLimiter);
app.use("/api/login", authLimiter);
app.use("/api/signup", authLimiter);

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler,
);

app.use(express.urlencoded({ extended: true }));
app.use(
  express.json({
    limit: "5mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// The primary first-party session cookie stays `SameSite=Lax`. Cross-origin
// SDK callers do NOT use this cookie — they ride a separate, dedicated
// `probid_sdk_session` cookie (see `server/lib/sdk-session.ts`) that is
// `SameSite=None; Secure` but is only ever consumed by the small set of
// SDK endpoints below. Keeping the main session cookie Lax means the rest
// of the app's session-protected routes retain their default CSRF posture.
app.use(
  cookieSession({
    name: "probid_session",
    secret: SESSION_SECRET,
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  }),
);

app.use(extractBearerAuth);

// Bridge the dedicated SDK cookie into `req.session` for the SDK endpoints
// only. Mounted AFTER `cookieSession` so the regular Lax session cookie
// wins on first-party calls; the SDK cookie is only consulted when no
// first-party session is present.
app.use(
  ["/api/csrf", "/api/me", "/api/estimates/send"],
  sdkSessionMiddleware,
);

registerChatRoutes(app);
registerImageRoutes(app);
registerSystemRoutes(app);
registerAuthRoutes(app);
registerEstimateRoutes(app);
registerSavedLineItemRoutes(app);
registerMarketingStatsRoutes(app);
registerReviewRoutes(app);
registerBillingRoutes(app);
registerAffiliateRoutes(app);
registerMarketingRoutes(app);
registerLegacySsrRoutes(app);
registerLeadsRoutes(app);
registerContactRoutes(app);
registerAdminRoutes(app);
registerProcoreRoutes(app);
registerTeamRoutes(app);
registerOutreachRoutes(app);
registerApiKeyRoutes(app);
registerWebhookRoutes(app);
registerApiV1Routes(app);
registerNotificationRoutes(app);
registerPipelineRoutes(app);
registerAutomationRoutes(app);
registerPartnerRoutes(app);
registerGuaranteeRoutes(app);

app.use("/api/", (req: express.Request, res: express.Response) => {
  res.status(404).json({ success: false, error: "API endpoint not found" });
});

const clientDistPath = path.join(process.cwd(), "client", "dist");
if (fs.existsSync(clientDistPath)) {
  // The SDK is served as a public asset and is intentionally loadable from any
  // origin via `<script src="https://probidcore.net/integrate.js">`. Add the
  // permissive CORS / CORP headers before the static handler so they reach
  // the response no matter where the partner site is hosted.
  app.use("/integrate.js", publicScriptCorsMiddleware);

  app.use(express.static(clientDistPath, {
    maxAge: "1d",
    setHeaders: (res, filePath) => {
      if (filePath.match(/\.[0-9a-f]{8,}\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|avif|ico)$/i)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }));

  const spaHtml = fs.readFileSync(path.join(clientDistPath, "index.html"), "utf-8")
    .replaceAll("__GOOGLE_SITE_VERIFICATION__", process.env.GOOGLE_SITE_VERIFICATION || "");

  app.get("*", (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.type("html").send(spaHtml);
  });
}

app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const statusCode = err.statusCode || 500;
    const message = err.isOperational
      ? err.message
      : "An unexpected error occurred";

    log("error", "Request error", {
      path: req.path,
      method: req.method,
      statusCode,
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });

    if (statusCode >= 500) {
      trackError({
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        statusCode,
        userId: (req as any).session?.uid,
      });
    }

    if (req.accepts("html") && !req.path.startsWith("/api/")) {
      res.status(statusCode).type("html").send(`Error: ${message}`);
    } else {
      res.status(statusCode).json({ success: false, error: message });
    }
  },
);

const port = Number(process.env.PORT || 5000);

async function startServer() {
  if (isDatabaseConfigured) {
    const dbConnected = await checkDatabaseConnection();
    if (!dbConnected) {
      log(
        "error",
        "Database connection failed - some features may be unavailable",
      );
    } else {
      log("info", "Database connected successfully");
    }
  } else {
    log("warn", "DATABASE_URL not configured - running without database");
  }

  // Always try to bind the deploy reservation port (23636 → external 80 per
  // .replit). Previously gated on NODE_ENV === "production", but that flag
  // isn't always set in the autoscale build/deploy environment, causing the
  // platform's port health check to fail with "expected port 23636 never
  // opened". The .on("error") handler below makes this safe in local dev:
  // if 23636 is already taken or unavailable, we log a warning and continue.
  let secondaryServer: ReturnType<typeof app.listen> | null = null;
  const secondaryPort = 23636;
  if (port !== secondaryPort) {
    try {
      secondaryServer = app
        .listen(secondaryPort, "0.0.0.0", () => {
          log("info", "Secondary listener bound (deploy port reservation)", {
            port: secondaryPort,
          });
        })
        .on("error", (err) => {
          log("warn", "Secondary listener failed to bind", {
            port: secondaryPort,
            error: String(err),
          });
        });
    } catch (err) {
      log("warn", "Failed to start secondary listener", { error: String(err) });
    }
  }

  const server = app.listen(port, "0.0.0.0", async () => {
    log("info", "Server started", { port, appUrl: APP_URL });
    logStartupSummary();

    const sdkOriginsRaw = (process.env.SDK_ALLOWED_ORIGINS ?? "").trim();
    if (!sdkOriginsRaw) {
      const msg =
        "SDK_ALLOWED_ORIGINS is empty — cross-origin integrate.js callers will be blocked. Set it to a comma-separated list of partner origins (e.g. https://partner.example.com,*.contractorsoft.io) to enable the SDK.";
      if (process.env.NODE_ENV === "production") {
        log("warn", msg);
      } else {
        log("info", msg);
      }
    }
    if (isDatabaseConfigured) {
      try {
        await runMigrations();
      } catch (error) {
        log("error", "Failed to apply database migrations", { error: String(error) });
      }

      try {
        await migrateReviewsTable();
      } catch (error) {
        log("error", "Failed to migrate reviews table", { error: String(error) });
      }

      try {
        await cleanupStaleJobRuns();
      } catch (error) {
        log("error", "Failed to cleanup stale job runs", { error: String(error) });
      }

      try {
        await seedSeoPages();
      } catch (error) {
        log("error", "Failed to seed SEO pages", { error: String(error) });
      }

      try {
        await seedOutreachConfig();
      } catch (error) {
        log("error", "Failed to seed outreach config", { error: String(error) });
      }

      try {
        await initOutreachState();
      } catch (error) {
        log("error", "Failed to init outreach state", { error: String(error) });
      }

      try {
        await initSdkAllowlistTable();
        const { setSdkAllowlistDbLoader } = await import("./server/lib/cors.js");
        const { loadActiveSdkOrigins } = await import("./server/routes/admin/sdk-allowlist.js");
        setSdkAllowlistDbLoader(loadActiveSdkOrigins);
      } catch (error) {
        log("error", "Failed to init SDK allowlist table", { error: String(error) });
      }

      try {
        await initPartnersSchema();
      } catch (error) {
        log("error", "Failed to init partners schema", { error: String(error) });
      }

      try {
        await initSystemAlerts();
      } catch (error) {
        log("error", "Failed to init system alerts", { error: String(error) });
      }

      if (isSmokeMode()) {
        log(
          "warn",
          "SMOKE_MODE=1 — skipping scheduler registration, lead-scraper catch-up, and all outbound recurring jobs (drip / dunning / weekly recap / dormant re-engage / health monitor / webhook retries). The smoke contract only verifies request routing.",
        );
      } else {
        startScheduler();
      }
    }
  });

  setupGracefulShutdown(server, secondaryServer);
}

function setupGracefulShutdown(
  server: ReturnType<typeof import("http").createServer>,
  secondaryServer?: ReturnType<typeof import("http").createServer> | null,
) {
  let isShuttingDown = false;

  const sockets = new Set<import("net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  if (secondaryServer) {
    secondaryServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  }

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log("info", "Graceful shutdown initiated", { signal });

    for (const socket of sockets) {
      socket.destroy();
    }

    if (secondaryServer) {
      try {
        secondaryServer.close();
      } catch (err) {
        log("warn", "Error closing secondary listener", { error: String(err) });
      }
    }

    server.close(async () => {
      log("info", "HTTP server closed — no new connections accepted");
      try {
        if (isDatabaseConfigured) {
          await pool.end();
          log("info", "Database pool closed");
        }
      } catch (err) {
        log("warn", "Error closing database pool", { error: String(err) });
      }
      log("info", "Shutdown complete");
      process.exit(0);
    });

    setTimeout(() => {
      log("warn", "Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 3_000).unref();
  }

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => process.exit(1));
  });
}

setupProcessErrorHandlers();

startServer().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
