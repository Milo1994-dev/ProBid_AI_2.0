import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema.js";

const { Pool } = pg;

export const isDatabaseConfigured = !!process.env.DATABASE_URL;

if (!isDatabaseConfigured) {
  console.warn("WARNING: DATABASE_URL is not set. Database features will be unavailable.");
}

const TRANSIENT_MESSAGES = [
  "terminating connection due to administrator command",
  "terminating connection",
  "Connection terminated unexpectedly",
  "Connection terminated",
  "connection reset by peer",
  "connection reset",
  "server closed the connection unexpectedly",
  "server closed the connection",
];

const TRANSIENT_CODES = ["57P01", "ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT"];

export function isTransientDbError(err: any): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  if (TRANSIENT_CODES.includes(code)) return true;
  const msg = (err.message ?? "").toLowerCase();
  return TRANSIENT_MESSAGES.some((p) => msg.includes(p.toLowerCase()));
}

/**
 * Rate-limit transient pool warnings: at most one line per 60s per key, with
 * a "(suppressed N similar in the last 60s)" counter on the next emission.
 * Non-transient errors must NOT use this — they go straight to console.error.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const transientLogState = new Map<string, { lastEmittedAt: number; suppressed: number }>();

// Watchtower (Task #140): bounded ring buffer of pool-reset timestamps so the
// health monitor can compute "resets in last N minutes" without persisting
// anything to the DB. Cap at POOL_RESET_RING_CAP entries — older entries are
// dropped when the ring is full, which is fine because thresholds are per-hour.
const POOL_RESET_RING_CAP = 1024;
const poolResetRing: number[] = [];
let poolResetTotal = 0;

function recordPoolReset(): void {
  const now = Date.now();
  poolResetRing.push(now);
  if (poolResetRing.length > POOL_RESET_RING_CAP) poolResetRing.shift();
  poolResetTotal += 1;
}

export function getPoolResetStats(windowMs: number = 60 * 60 * 1000): {
  count: number;
  total: number;
  windowMs: number;
} {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (let i = poolResetRing.length - 1; i >= 0; i--) {
    if (poolResetRing[i] >= cutoff) count++;
    else break;
  }
  return { count, total: poolResetTotal, windowMs };
}

/** Test-only: reset the in-process counter. Not exported from the package surface. */
export function __resetPoolResetStatsForTests(): void {
  poolResetRing.length = 0;
  poolResetTotal = 0;
}

// Duplicate-deal race counter (Task #186): tracks how often a 23505
// unique_violation is caught in pipeline-sync (concurrent insert race). Uses
// the same ring-buffer pattern as pool resets so the health endpoint can report
// both a windowed count and a lifetime total without hitting the DB.
const DEDUPE_RACE_RING_CAP = 1024;
const dupeRaceRing: number[] = [];
let dupeRaceTotal = 0;

export function recordDuplicateDealRace(): void {
  const now = Date.now();
  dupeRaceRing.push(now);
  if (dupeRaceRing.length > DEDUPE_RACE_RING_CAP) dupeRaceRing.shift();
  dupeRaceTotal += 1;
}

export function getDuplicateDealRaceStats(windowMs: number = 60 * 60 * 1000): {
  count: number;
  total: number;
  windowMs: number;
} {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (let i = dupeRaceRing.length - 1; i >= 0; i--) {
    if (dupeRaceRing[i] >= cutoff) count++;
    else break;
  }
  return { count, total: dupeRaceTotal, windowMs };
}

/** Test-only: reset the duplicate-deal race counter. */
export function __resetDuplicateDealRaceStatsForTests(): void {
  dupeRaceRing.length = 0;
  dupeRaceTotal = 0;
}

function rateLimitedTransientWarn(key: string, baseMessage: string): void {
  recordPoolReset();
  const now = Date.now();
  const state = transientLogState.get(key) ?? { lastEmittedAt: 0, suppressed: 0 };
  const elapsed = now - state.lastEmittedAt;

  if (elapsed >= RATE_LIMIT_WINDOW_MS) {
    const suffix =
      state.suppressed > 0
        ? ` (suppressed ${state.suppressed} similar in the last 60s)`
        : "";
    console.info(`${baseMessage}${suffix}`);
    transientLogState.set(key, { lastEmittedAt: now, suppressed: 0 });
  } else {
    state.suppressed += 1;
    transientLogState.set(key, state);
  }
}

// Strip the deprecated `sslmode` aliases (`require`/`prefer`/`verify-ca`) from
// the URL. We pass an explicit `ssl` object below, which is what actually
// controls the TLS handshake — but pg-connection-string still parses any
// legacy `sslmode` value in the URL and emits a noisy deprecation warning at
// startup ("treated as 'verify-full'"). We preserve `disable` and `verify-full`
// so callers can still explicitly opt out of TLS (e.g. local dev / test DBs)
// or pin the strictest mode.
const PRESERVED_SSL_MODES = new Set(["disable", "verify-full"]);
export function stripSslModeFromUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    const mode = u.searchParams.get("sslmode");
    if (mode && !PRESERVED_SSL_MODES.has(mode)) {
      u.searchParams.delete("sslmode");
    }
    return u.toString();
  } catch {
    return url;
  }
}

// Honor `sslmode=disable` so local/test Postgres without TLS still works.
function resolvePoolSsl(url: string | undefined): false | { rejectUnauthorized: boolean } {
  if (url) {
    try {
      const mode = new URL(url).searchParams.get("sslmode");
      if (mode === "disable") return false;
    } catch {
      /* fall through */
    }
  }
  // Neon/managed Postgres providers use CA-signed certs, so verify-full is
  // both correct and the safest setting.
  return { rejectUnauthorized: true };
}

export const pool = isDatabaseConfigured
  ? new Pool({
      connectionString: stripSslModeFromUrl(process.env.DATABASE_URL),
      ssl: resolvePoolSsl(process.env.DATABASE_URL),
      max: 10,
      // min: 0 — don't park idle connections just to watch the server close
      // them. First request after a quiet window pays a cold-connect.
      min: 0,
      // Close idle clients on our side BEFORE managed-Postgres providers
      // (Neon, RDS, pgbouncer-style proxies) do. They typically drop idle
      // sockets at 30-60s; 10s gives a comfortable margin.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: false,
      // TCP keepalive prevents silent drops on sockets we hold mid-request.
      // 10s initial delay matches idleTimeoutMillis.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
  : null;

if (pool) {
  // Transient idle-connection drops are expected against managed Postgres
  // providers; the pool replaces the client automatically. Logged at info
  // and rate-limited so a burst can't fill the log.
  pool.on("error", (err) => {
    if (isTransientDbError(err)) {
      rateLimitedTransientWarn(
        "pool_idle_terminated",
        "[db] idle connection recycled by server (auto-replaced by pool)",
      );
    } else {
      console.error("[db] Unexpected pool error:", err?.message ?? err);
    }
  });

  pool.on("connect", (client) => {
    client.on("error", (err) => {
      if (isTransientDbError(err)) {
        rateLimitedTransientWarn(
          "client_reset",
          "[db] client connection reset by server (auto-replaced by pool)",
        );
      } else {
        console.error("[db] Client error:", err?.message ?? err);
      }
    });
  });
}

export const db = pool ? drizzle(pool, { schema }) : null as any;

export async function checkDatabaseConnection(): Promise<boolean> {
  if (!pool) return false;
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch (error) {
    console.error("Database connection failed:", error);
    return false;
  } finally {
    if (client) {
      try { client.release(); } catch {}
    }
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (!isTransientDbError(err) || attempt === retries) {
        throw err;
      }
      console.warn(`[db] Transient error (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
  throw lastError;
}
