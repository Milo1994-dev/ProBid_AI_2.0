import type { Express, Request, Response } from "express";
import { pool } from "../db.js";

interface MarketingStats {
  estimatesGenerated: number;
  contractorsServed: number;
  regionsActive: number;
  photoAssistedEstimates: number;
  generatedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: MarketingStats | null = null;
let cachePromise: Promise<MarketingStats> | null = null;

async function loadStats(): Promise<MarketingStats> {
  const [estimatesRes, contractorsRes, regionsRes, photosRes] = await Promise.all([
    pool.query<{ c: string }>(`SELECT COUNT(*) AS c FROM estimates`),
    pool.query<{ c: string }>(
      `SELECT COUNT(DISTINCT user_id) AS c FROM estimates WHERE user_id IS NOT NULL`,
    ),
    pool.query<{ c: string }>(
      `SELECT COUNT(DISTINCT market) AS c FROM estimates WHERE market IS NOT NULL AND market <> ''`,
    ),
    pool.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM analytics
       WHERE event = 'estimate_generated' AND data LIKE '%"hasPhoto":true%'`,
    ),
  ]);
  return {
    estimatesGenerated: Number(estimatesRes.rows[0]?.c ?? 0),
    contractorsServed: Number(contractorsRes.rows[0]?.c ?? 0),
    regionsActive: Number(regionsRes.rows[0]?.c ?? 0),
    photoAssistedEstimates: Number(photosRes.rows[0]?.c ?? 0),
    generatedAt: Date.now(),
  };
}

async function getStats(): Promise<MarketingStats> {
  const now = Date.now();
  if (cache && now - cache.generatedAt < CACHE_TTL_MS) {
    return cache;
  }
  if (cachePromise) return cachePromise;
  cachePromise = loadStats()
    .then((s) => {
      cache = s;
      return s;
    })
    .finally(() => {
      cachePromise = null;
    });
  return cachePromise;
}

export function registerMarketingStatsRoutes(app: Express): void {
  app.get("/api/marketing/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await getStats();
      res.set("Cache-Control", "public, max-age=300");
      res.json({
        data: {
          estimatesGenerated: stats.estimatesGenerated,
          contractorsServed: stats.contractorsServed,
          regionsActive: stats.regionsActive,
          photoAssistedEstimates: stats.photoAssistedEstimates,
        },
      });
    } catch {
      res.status(503).json({ error: "Stats unavailable" });
    }
  });
}
