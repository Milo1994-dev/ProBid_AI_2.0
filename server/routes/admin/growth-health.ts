import express from "express";
import { asyncHandler } from "../../lib/middleware.js";
import { isAdminRequest } from "./shared.js";
import { getGrowthHealthSnapshot, invalidateGrowthHealthCache } from "../../growth-health.js";
import { GROWTH_HEALTH_RULES, findRule } from "../../lib/growth-health-rules.js";
import { withGuaranteedAudit, getThresholdAuditLog, recordThresholdAudit, getAuditLogMeta } from "../../lib/watchtower-audit.js";
import { log } from "../../lib/logger.js";
import {
  getDupeDealRaceThresholds,
  setDupeDealRaceThresholds,
  resetDupeDealRaceThresholds,
  getDbPoolThresholds,
  setDbPoolThresholds,
  resetDbPoolThresholds,
  getErrorRateThresholds,
  setErrorRateThresholds,
  resetErrorRateThresholds,
  getWebhookSuccessThresholds,
  setWebhookSuccessThresholds,
  resetWebhookSuccessThresholds,
  getLeadScraperThresholds,
  setLeadScraperThresholds,
  resetLeadScraperThresholds,
  getOutreachProcessorThresholds,
  setOutreachProcessorThresholds,
  resetOutreachProcessorThresholds,
  getOutreachDeliverabilityThresholds,
  setOutreachDeliverabilityThresholds,
  resetOutreachDeliverabilityThresholds,
  getStripeWebhookThresholds,
  setStripeWebhookThresholds,
  resetStripeWebhookThresholds,
  getProcoreSyncThresholds,
  setProcoreSyncThresholds,
  resetProcoreSyncThresholds,
  getCronSchedulerThresholds,
  setCronSchedulerThresholds,
  resetCronSchedulerThresholds,
  resetAllThresholds,
} from "../../lib/watchtower-settings.js";

export function registerAdminGrowthHealthRoutes(app: express.Application): void {
  app.get(
    "/api/admin/growth-health",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const force = req.query.refresh === "1";
      const snapshot = await getGrowthHealthSnapshot(force);
      res.json({
        success: true,
        data: {
          ...snapshot,
          rules: GROWTH_HEALTH_RULES,
        },
      });
    }),
  );

  // ── Duplicate deal race thresholds ────────────────────────────────────

  app.get(
    "/api/admin/growth-health/dupe-deal-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("duplicate_deal_races");
      const envYellow = rule?.duplicateDealRacesPerHour?.yellow ?? 5;
      const envRed = rule?.duplicateDealRacesPerHour?.red ?? 20;
      const thresholds = await getDupeDealRaceThresholds(envYellow, envRed);
      res.json({
        success: true,
        data: {
          yellow: thresholds.yellow,
          red: thresholds.red,
          source: thresholds.source,
          ...(thresholds.readError && { readError: true }),
          envDefaults: { yellow: envYellow, red: envRed },
        },
      });
    }),
  );

  app.post(
    "/api/admin/growth-health/dupe-deal-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { yellow, red } = req.body as { yellow?: unknown; red?: unknown };
      const yellowN = Number(yellow);
      const redN = Number(red);
      if (!Number.isFinite(yellowN) || yellowN < 0) {
        return res.status(400).json({ success: false, error: "yellow must be a non-negative number" });
      }
      if (!Number.isFinite(redN) || redN < 0) {
        return res.status(400).json({ success: false, error: "red must be a non-negative number" });
      }
      if (yellowN >= redN) {
        return res.status(400).json({ success: false, error: "yellow threshold must be less than red threshold" });
      }
      const rule = findRule("duplicate_deal_races");
      const envYellow = rule?.duplicateDealRacesPerHour?.yellow ?? 5;
      const envRed = rule?.duplicateDealRacesPerHour?.red ?? 20;
      const old = await getDupeDealRaceThresholds(envYellow, envRed);
      await withGuaranteedAudit(
        { req, subsystem: "dupe-deal", action: "set", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, source: old.source }, newValue: { yellow: yellowN, red: redN } },
        async () => { await setDupeDealRaceThresholds(yellowN, redN); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { yellow: yellowN, red: redN, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/dupe-deal-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("duplicate_deal_races");
      const envYellow = rule?.duplicateDealRacesPerHour?.yellow ?? 5;
      const envRed = rule?.duplicateDealRacesPerHour?.red ?? 20;
      const old = await getDupeDealRaceThresholds(envYellow, envRed);
      await withGuaranteedAudit(
        { req, subsystem: "dupe-deal", action: "reset", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, source: old.source }, newValue: null },
        async () => { await resetDupeDealRaceThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── DB pool reset thresholds ──────────────────────────────────────────

  app.get(
    "/api/admin/growth-health/pool-resets-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("db_pool_health");
      const envYellow = rule?.poolResetsPerHour?.yellow ?? 30;
      const envRed = rule?.poolResetsPerHour?.red ?? 60;
      const thresholds = await getDbPoolThresholds(envYellow, envRed);
      res.json({
        success: true,
        data: {
          yellow: thresholds.yellow,
          red: thresholds.red,
          source: thresholds.source,
          ...(thresholds.readError && { readError: true }),
          envDefaults: { yellow: envYellow, red: envRed },
        },
      });
    }),
  );

  app.post(
    "/api/admin/growth-health/pool-resets-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { yellow, red } = req.body as { yellow?: unknown; red?: unknown };
      const yellowN = Number(yellow);
      const redN = Number(red);
      if (!Number.isFinite(yellowN) || yellowN < 0) {
        return res.status(400).json({ success: false, error: "yellow must be a non-negative number" });
      }
      if (!Number.isFinite(redN) || redN < 0) {
        return res.status(400).json({ success: false, error: "red must be a non-negative number" });
      }
      if (yellowN >= redN) {
        return res.status(400).json({ success: false, error: "yellow threshold must be less than red threshold" });
      }
      const rule = findRule("db_pool_health");
      const envYellow = rule?.poolResetsPerHour?.yellow ?? 30;
      const envRed = rule?.poolResetsPerHour?.red ?? 60;
      const old = await getDbPoolThresholds(envYellow, envRed);
      await withGuaranteedAudit(
        { req, subsystem: "pool-resets", action: "set", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, source: old.source }, newValue: { yellow: yellowN, red: redN } },
        async () => { await setDbPoolThresholds(yellowN, redN); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { yellow: yellowN, red: redN, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/pool-resets-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("db_pool_health");
      const envYellow = rule?.poolResetsPerHour?.yellow ?? 30;
      const envRed = rule?.poolResetsPerHour?.red ?? 60;
      const old = await getDbPoolThresholds(envYellow, envRed);
      await withGuaranteedAudit(
        { req, subsystem: "pool-resets", action: "reset", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, source: old.source }, newValue: null },
        async () => { await resetDbPoolThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Error rate thresholds ─────────────────────────────────────────────

  app.get(
    "/api/admin/growth-health/error-rate-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("error_rate");
      const envYellow = rule?.errorFingerprintsLastHour?.yellow ?? 20;
      const envRed = rule?.errorFingerprintsLastHour?.red ?? 50;
      const thresholds = await getErrorRateThresholds(envYellow, envRed);
      res.json({
        success: true,
        data: {
          yellow: thresholds.yellow,
          red: thresholds.red,
          source: thresholds.source,
          ...(thresholds.readError && { readError: true }),
          envDefaults: { yellow: envYellow, red: envRed },
        },
      });
    }),
  );

  app.post(
    "/api/admin/growth-health/error-rate-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { yellow, red } = req.body as { yellow?: unknown; red?: unknown };
      const yellowN = Number(yellow);
      const redN = Number(red);
      if (!Number.isFinite(yellowN) || yellowN < 0) {
        return res.status(400).json({ success: false, error: "yellow must be a non-negative number" });
      }
      if (!Number.isFinite(redN) || redN < 0) {
        return res.status(400).json({ success: false, error: "red must be a non-negative number" });
      }
      if (yellowN >= redN) {
        return res.status(400).json({ success: false, error: "yellow threshold must be less than red threshold" });
      }
      const rule = findRule("error_rate");
      const envYellow = rule?.errorFingerprintsLastHour?.yellow ?? 20;
      const envRed = rule?.errorFingerprintsLastHour?.red ?? 50;
      const old = await getErrorRateThresholds(envYellow, envRed);
      await withGuaranteedAudit(
        { req, subsystem: "error-rate", action: "set", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, source: old.source }, newValue: { yellow: yellowN, red: redN } },
        async () => { await setErrorRateThresholds(yellowN, redN); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { yellow: yellowN, red: redN, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/error-rate-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("error_rate");
      const envYellow = rule?.errorFingerprintsLastHour?.yellow ?? 20;
      const envRed = rule?.errorFingerprintsLastHour?.red ?? 50;
      const old = await getErrorRateThresholds(envYellow, envRed);
      await withGuaranteedAudit(
        { req, subsystem: "error-rate", action: "reset", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, source: old.source }, newValue: null },
        async () => { await resetErrorRateThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Outbound webhook success-rate thresholds ──────────────────────────

  app.get(
    "/api/admin/growth-health/webhook-success-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("outbound_webhooks");
      const envYellow = rule?.webhookSuccessRate1h?.yellow ?? 0.95;
      const envRed = rule?.webhookSuccessRate1h?.red ?? 0.9;
      const envMinVolume = rule?.webhookSuccessRate1h?.minVolume ?? 5;
      const thresholds = await getWebhookSuccessThresholds(envYellow, envRed, envMinVolume);
      res.json({
        success: true,
        data: {
          yellow: thresholds.yellow,
          red: thresholds.red,
          minVolume: thresholds.minVolume,
          source: thresholds.source,
          ...(thresholds.readError && { readError: true }),
          envDefaults: { yellow: envYellow, red: envRed, minVolume: envMinVolume },
        },
      });
    }),
  );

  app.post(
    "/api/admin/growth-health/webhook-success-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { yellow, red, minVolume } = req.body as { yellow?: unknown; red?: unknown; minVolume?: unknown };
      const yellowN = Number(yellow);
      const redN = Number(red);
      const minVolumeN = Number(minVolume);
      if (!Number.isFinite(yellowN) || yellowN < 0 || yellowN > 1) {
        return res.status(400).json({ success: false, error: "yellow must be a rate between 0 and 1" });
      }
      if (!Number.isFinite(redN) || redN < 0 || redN > 1) {
        return res.status(400).json({ success: false, error: "red must be a rate between 0 and 1" });
      }
      if (redN >= yellowN) {
        return res.status(400).json({ success: false, error: "red threshold must be less than yellow threshold (lower success rate = worse)" });
      }
      if (!Number.isFinite(minVolumeN) || minVolumeN < 0 || !Number.isInteger(minVolumeN)) {
        return res.status(400).json({ success: false, error: "minVolume must be a non-negative integer" });
      }
      const rule = findRule("outbound_webhooks");
      const envYellow = rule?.webhookSuccessRate1h?.yellow ?? 0.95;
      const envRed = rule?.webhookSuccessRate1h?.red ?? 0.9;
      const envMinVolume = rule?.webhookSuccessRate1h?.minVolume ?? 5;
      const old = await getWebhookSuccessThresholds(envYellow, envRed, envMinVolume);
      await withGuaranteedAudit(
        { req, subsystem: "webhook-success", action: "set", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, minVolume: old.minVolume, source: old.source }, newValue: { yellow: yellowN, red: redN, minVolume: minVolumeN } },
        async () => { await setWebhookSuccessThresholds(yellowN, redN, minVolumeN); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { yellow: yellowN, red: redN, minVolume: minVolumeN, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/webhook-success-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("outbound_webhooks");
      const envYellow = rule?.webhookSuccessRate1h?.yellow ?? 0.95;
      const envRed = rule?.webhookSuccessRate1h?.red ?? 0.9;
      const envMinVolume = rule?.webhookSuccessRate1h?.minVolume ?? 5;
      const old = await getWebhookSuccessThresholds(envYellow, envRed, envMinVolume);
      await withGuaranteedAudit(
        { req, subsystem: "webhook-success", action: "reset", endpoint: req.path, oldValue: { yellow: old.yellow, red: old.red, minVolume: old.minVolume, source: old.source }, newValue: null },
        async () => { await resetWebhookSuccessThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Lead Scraper thresholds ───────────────────────────────────────────

  app.get(
    "/api/admin/growth-health/lead-scraper-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("lead_scraper");
      const env = {
        staleYellow: rule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: rule?.staleAfterMinutes.red ?? 48 * 60,
        failRateYellow: rule?.maxFailureRate24h?.yellow ?? 0.5,
        failRateRed: rule?.maxFailureRate24h?.red ?? 0.9,
        zeroOutputRunsRed: rule?.zeroOutputRunsRed ?? 3,
      };
      const t = await getLeadScraperThresholds(env);
      res.json({ success: true, data: { ...t, envDefaults: env } });
    }),
  );

  app.post(
    "/api/admin/growth-health/lead-scraper-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { staleYellow, staleRed, failRateYellow, failRateRed, zeroOutputRunsRed } =
        req.body as Record<string, unknown>;
      const sy = Number(staleYellow);
      const sr = Number(staleRed);
      const fry = Number(failRateYellow);
      const frr = Number(failRateRed);
      const zzr = Number(zeroOutputRunsRed);
      if (!Number.isFinite(sy) || sy < 0) return res.status(400).json({ success: false, error: "staleYellow must be a non-negative number (minutes)" });
      if (!Number.isFinite(sr) || sr < 0) return res.status(400).json({ success: false, error: "staleRed must be a non-negative number (minutes)" });
      if (sy >= sr) return res.status(400).json({ success: false, error: "staleYellow must be less than staleRed" });
      if (!Number.isFinite(fry) || fry < 0 || fry > 1) return res.status(400).json({ success: false, error: "failRateYellow must be a rate 0..1" });
      if (!Number.isFinite(frr) || frr < 0 || frr > 1) return res.status(400).json({ success: false, error: "failRateRed must be a rate 0..1" });
      if (fry >= frr) return res.status(400).json({ success: false, error: "failRateYellow must be less than failRateRed" });
      if (!Number.isFinite(zzr) || zzr < 1 || !Number.isInteger(zzr)) return res.status(400).json({ success: false, error: "zeroOutputRunsRed must be a positive integer" });
      const lsRule = findRule("lead_scraper");
      const lsEnv = {
        staleYellow: lsRule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: lsRule?.staleAfterMinutes.red ?? 48 * 60,
        failRateYellow: lsRule?.maxFailureRate24h?.yellow ?? 0.5,
        failRateRed: lsRule?.maxFailureRate24h?.red ?? 0.9,
        zeroOutputRunsRed: lsRule?.zeroOutputRunsRed ?? 3,
      };
      const old = await getLeadScraperThresholds(lsEnv);
      await withGuaranteedAudit(
        { req, subsystem: "lead-scraper", action: "set", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, failRateYellow: old.failRateYellow, failRateRed: old.failRateRed, zeroOutputRunsRed: old.zeroOutputRunsRed, source: old.source }, newValue: { staleYellow: sy, staleRed: sr, failRateYellow: fry, failRateRed: frr, zeroOutputRunsRed: zzr } },
        async () => { await setLeadScraperThresholds({ staleYellow: sy, staleRed: sr, failRateYellow: fry, failRateRed: frr, zeroOutputRunsRed: zzr }); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { staleYellow: sy, staleRed: sr, failRateYellow: fry, failRateRed: frr, zeroOutputRunsRed: zzr, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/lead-scraper-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const lsRule = findRule("lead_scraper");
      const lsEnv = {
        staleYellow: lsRule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: lsRule?.staleAfterMinutes.red ?? 48 * 60,
        failRateYellow: lsRule?.maxFailureRate24h?.yellow ?? 0.5,
        failRateRed: lsRule?.maxFailureRate24h?.red ?? 0.9,
        zeroOutputRunsRed: lsRule?.zeroOutputRunsRed ?? 3,
      };
      const old = await getLeadScraperThresholds(lsEnv);
      await withGuaranteedAudit(
        { req, subsystem: "lead-scraper", action: "reset", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, failRateYellow: old.failRateYellow, failRateRed: old.failRateRed, zeroOutputRunsRed: old.zeroOutputRunsRed, source: old.source }, newValue: null },
        async () => { await resetLeadScraperThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Outreach Processor thresholds ────────────────────────────────────

  app.get(
    "/api/admin/growth-health/outreach-processor-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("outreach_processor");
      const env = {
        staleYellow: rule?.staleAfterMinutes.yellow ?? 90,
        staleRed: rule?.staleAfterMinutes.red ?? 240,
        zeroSendYellow: rule?.zeroSendBusinessHours?.yellow ?? 4,
        zeroSendRed: rule?.zeroSendBusinessHours?.red ?? 8,
      };
      const t = await getOutreachProcessorThresholds(env);
      res.json({ success: true, data: { ...t, envDefaults: env } });
    }),
  );

  app.post(
    "/api/admin/growth-health/outreach-processor-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { staleYellow, staleRed, zeroSendYellow, zeroSendRed } =
        req.body as Record<string, unknown>;
      const sy = Number(staleYellow);
      const sr = Number(staleRed);
      const zsy = Number(zeroSendYellow);
      const zsr = Number(zeroSendRed);
      if (!Number.isFinite(sy) || sy < 0) return res.status(400).json({ success: false, error: "staleYellow must be a non-negative number (minutes)" });
      if (!Number.isFinite(sr) || sr < 0) return res.status(400).json({ success: false, error: "staleRed must be a non-negative number (minutes)" });
      if (sy >= sr) return res.status(400).json({ success: false, error: "staleYellow must be less than staleRed" });
      if (!Number.isFinite(zsy) || zsy < 0) return res.status(400).json({ success: false, error: "zeroSendYellow must be a non-negative number (hours)" });
      if (!Number.isFinite(zsr) || zsr < 0) return res.status(400).json({ success: false, error: "zeroSendRed must be a non-negative number (hours)" });
      if (zsy >= zsr) return res.status(400).json({ success: false, error: "zeroSendYellow must be less than zeroSendRed" });
      const opRule = findRule("outreach_processor");
      const opEnv = {
        staleYellow: opRule?.staleAfterMinutes.yellow ?? 90,
        staleRed: opRule?.staleAfterMinutes.red ?? 240,
        zeroSendYellow: opRule?.zeroSendBusinessHours?.yellow ?? 4,
        zeroSendRed: opRule?.zeroSendBusinessHours?.red ?? 8,
      };
      const old = await getOutreachProcessorThresholds(opEnv);
      await withGuaranteedAudit(
        { req, subsystem: "outreach-processor", action: "set", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, zeroSendYellow: old.zeroSendYellow, zeroSendRed: old.zeroSendRed, source: old.source }, newValue: { staleYellow: sy, staleRed: sr, zeroSendYellow: zsy, zeroSendRed: zsr } },
        async () => { await setOutreachProcessorThresholds({ staleYellow: sy, staleRed: sr, zeroSendYellow: zsy, zeroSendRed: zsr }); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { staleYellow: sy, staleRed: sr, zeroSendYellow: zsy, zeroSendRed: zsr, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/outreach-processor-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const opRule = findRule("outreach_processor");
      const opEnv = {
        staleYellow: opRule?.staleAfterMinutes.yellow ?? 90,
        staleRed: opRule?.staleAfterMinutes.red ?? 240,
        zeroSendYellow: opRule?.zeroSendBusinessHours?.yellow ?? 4,
        zeroSendRed: opRule?.zeroSendBusinessHours?.red ?? 8,
      };
      const old = await getOutreachProcessorThresholds(opEnv);
      await withGuaranteedAudit(
        { req, subsystem: "outreach-processor", action: "reset", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, zeroSendYellow: old.zeroSendYellow, zeroSendRed: old.zeroSendRed, source: old.source }, newValue: null },
        async () => { await resetOutreachProcessorThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Outreach Deliverability thresholds ────────────────────────────────

  app.get(
    "/api/admin/growth-health/deliverability-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("outreach_deliverability");
      const env = {
        staleYellow: rule?.staleAfterMinutes.yellow ?? 36 * 60,
        staleRed: rule?.staleAfterMinutes.red ?? 72 * 60,
        failRateYellow: rule?.maxFailureRate24h?.yellow ?? 0.05,
        failRateRed: rule?.maxFailureRate24h?.red ?? 0.1,
      };
      const t = await getOutreachDeliverabilityThresholds(env);
      res.json({ success: true, data: { ...t, envDefaults: env } });
    }),
  );

  app.post(
    "/api/admin/growth-health/deliverability-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { staleYellow, staleRed, failRateYellow, failRateRed } =
        req.body as Record<string, unknown>;
      const sy = Number(staleYellow);
      const sr = Number(staleRed);
      const fry = Number(failRateYellow);
      const frr = Number(failRateRed);
      if (!Number.isFinite(sy) || sy < 0) return res.status(400).json({ success: false, error: "staleYellow must be a non-negative number (minutes)" });
      if (!Number.isFinite(sr) || sr < 0) return res.status(400).json({ success: false, error: "staleRed must be a non-negative number (minutes)" });
      if (sy >= sr) return res.status(400).json({ success: false, error: "staleYellow must be less than staleRed" });
      if (!Number.isFinite(fry) || fry < 0 || fry > 1) return res.status(400).json({ success: false, error: "failRateYellow must be a rate 0..1" });
      if (!Number.isFinite(frr) || frr < 0 || frr > 1) return res.status(400).json({ success: false, error: "failRateRed must be a rate 0..1" });
      if (fry >= frr) return res.status(400).json({ success: false, error: "failRateYellow must be less than failRateRed" });
      const odRule = findRule("outreach_deliverability");
      const odEnv = {
        staleYellow: odRule?.staleAfterMinutes.yellow ?? 36 * 60,
        staleRed: odRule?.staleAfterMinutes.red ?? 72 * 60,
        failRateYellow: odRule?.maxFailureRate24h?.yellow ?? 0.05,
        failRateRed: odRule?.maxFailureRate24h?.red ?? 0.1,
      };
      const old = await getOutreachDeliverabilityThresholds(odEnv);
      await withGuaranteedAudit(
        { req, subsystem: "deliverability", action: "set", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, failRateYellow: old.failRateYellow, failRateRed: old.failRateRed, source: old.source }, newValue: { staleYellow: sy, staleRed: sr, failRateYellow: fry, failRateRed: frr } },
        async () => { await setOutreachDeliverabilityThresholds({ staleYellow: sy, staleRed: sr, failRateYellow: fry, failRateRed: frr }); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { staleYellow: sy, staleRed: sr, failRateYellow: fry, failRateRed: frr, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/deliverability-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const odRule = findRule("outreach_deliverability");
      const odEnv = {
        staleYellow: odRule?.staleAfterMinutes.yellow ?? 36 * 60,
        staleRed: odRule?.staleAfterMinutes.red ?? 72 * 60,
        failRateYellow: odRule?.maxFailureRate24h?.yellow ?? 0.05,
        failRateRed: odRule?.maxFailureRate24h?.red ?? 0.1,
      };
      const old = await getOutreachDeliverabilityThresholds(odEnv);
      await withGuaranteedAudit(
        { req, subsystem: "deliverability", action: "reset", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, failRateYellow: old.failRateYellow, failRateRed: old.failRateRed, source: old.source }, newValue: null },
        async () => { await resetOutreachDeliverabilityThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Stripe Webhook thresholds ─────────────────────────────────────────

  app.get(
    "/api/admin/growth-health/stripe-webhook-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("stripe_webhooks");
      const env = {
        failRateYellow: rule?.maxFailureRate24h?.yellow ?? 0.2,
        failRateRed: rule?.maxFailureRate24h?.red ?? 0.5,
        sigFailsRed: rule?.signatureFailuresLastHourRed ?? 1,
      };
      const t = await getStripeWebhookThresholds(env);
      res.json({ success: true, data: { ...t, envDefaults: env } });
    }),
  );

  app.post(
    "/api/admin/growth-health/stripe-webhook-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { failRateYellow, failRateRed, sigFailsRed } =
        req.body as Record<string, unknown>;
      const fry = Number(failRateYellow);
      const frr = Number(failRateRed);
      const sfr = Number(sigFailsRed);
      if (!Number.isFinite(fry) || fry < 0 || fry > 1) return res.status(400).json({ success: false, error: "failRateYellow must be a rate 0..1" });
      if (!Number.isFinite(frr) || frr < 0 || frr > 1) return res.status(400).json({ success: false, error: "failRateRed must be a rate 0..1" });
      if (fry >= frr) return res.status(400).json({ success: false, error: "failRateYellow must be less than failRateRed" });
      if (!Number.isFinite(sfr) || sfr < 1 || !Number.isInteger(sfr)) return res.status(400).json({ success: false, error: "sigFailsRed must be a positive integer" });
      const swRule = findRule("stripe_webhooks");
      const swEnv = {
        failRateYellow: swRule?.maxFailureRate24h?.yellow ?? 0.2,
        failRateRed: swRule?.maxFailureRate24h?.red ?? 0.5,
        sigFailsRed: swRule?.signatureFailuresLastHourRed ?? 1,
      };
      const old = await getStripeWebhookThresholds(swEnv);
      await withGuaranteedAudit(
        { req, subsystem: "stripe-webhook", action: "set", endpoint: req.path, oldValue: { failRateYellow: old.failRateYellow, failRateRed: old.failRateRed, sigFailsRed: old.sigFailsRed, source: old.source }, newValue: { failRateYellow: fry, failRateRed: frr, sigFailsRed: sfr } },
        async () => { await setStripeWebhookThresholds({ failRateYellow: fry, failRateRed: frr, sigFailsRed: sfr }); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { failRateYellow: fry, failRateRed: frr, sigFailsRed: sfr, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/stripe-webhook-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const swRule = findRule("stripe_webhooks");
      const swEnv = {
        failRateYellow: swRule?.maxFailureRate24h?.yellow ?? 0.2,
        failRateRed: swRule?.maxFailureRate24h?.red ?? 0.5,
        sigFailsRed: swRule?.signatureFailuresLastHourRed ?? 1,
      };
      const old = await getStripeWebhookThresholds(swEnv);
      await withGuaranteedAudit(
        { req, subsystem: "stripe-webhook", action: "reset", endpoint: req.path, oldValue: { failRateYellow: old.failRateYellow, failRateRed: old.failRateRed, sigFailsRed: old.sigFailsRed, source: old.source }, newValue: null },
        async () => { await resetStripeWebhookThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Procore Sync thresholds ───────────────────────────────────────────

  app.get(
    "/api/admin/growth-health/procore-sync-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("procore_sync");
      const env = {
        staleYellow: rule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: rule?.staleAfterMinutes.red ?? 72 * 60,
        connStaleYellow: rule?.perConnectionStaleAfterMinutes?.yellow ?? 26 * 60,
        connStaleRed: rule?.perConnectionStaleAfterMinutes?.red ?? 36 * 60,
      };
      const t = await getProcoreSyncThresholds(env);
      res.json({ success: true, data: { ...t, envDefaults: env } });
    }),
  );

  app.post(
    "/api/admin/growth-health/procore-sync-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { staleYellow, staleRed, connStaleYellow, connStaleRed } =
        req.body as Record<string, unknown>;
      const sy = Number(staleYellow);
      const sr = Number(staleRed);
      const csy = Number(connStaleYellow);
      const csr = Number(connStaleRed);
      if (!Number.isFinite(sy) || sy < 0) return res.status(400).json({ success: false, error: "staleYellow must be a non-negative number (minutes)" });
      if (!Number.isFinite(sr) || sr < 0) return res.status(400).json({ success: false, error: "staleRed must be a non-negative number (minutes)" });
      if (sy >= sr) return res.status(400).json({ success: false, error: "staleYellow must be less than staleRed" });
      if (!Number.isFinite(csy) || csy < 0) return res.status(400).json({ success: false, error: "connStaleYellow must be a non-negative number (minutes)" });
      if (!Number.isFinite(csr) || csr < 0) return res.status(400).json({ success: false, error: "connStaleRed must be a non-negative number (minutes)" });
      if (csy >= csr) return res.status(400).json({ success: false, error: "connStaleYellow must be less than connStaleRed" });
      const psRule = findRule("procore_sync");
      const psEnv = {
        staleYellow: psRule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: psRule?.staleAfterMinutes.red ?? 72 * 60,
        connStaleYellow: psRule?.perConnectionStaleAfterMinutes?.yellow ?? 26 * 60,
        connStaleRed: psRule?.perConnectionStaleAfterMinutes?.red ?? 36 * 60,
      };
      const old = await getProcoreSyncThresholds(psEnv);
      await withGuaranteedAudit(
        { req, subsystem: "procore-sync", action: "set", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, connStaleYellow: old.connStaleYellow, connStaleRed: old.connStaleRed, source: old.source }, newValue: { staleYellow: sy, staleRed: sr, connStaleYellow: csy, connStaleRed: csr } },
        async () => { await setProcoreSyncThresholds({ staleYellow: sy, staleRed: sr, connStaleYellow: csy, connStaleRed: csr }); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { staleYellow: sy, staleRed: sr, connStaleYellow: csy, connStaleRed: csr, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/procore-sync-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const psRule = findRule("procore_sync");
      const psEnv = {
        staleYellow: psRule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: psRule?.staleAfterMinutes.red ?? 72 * 60,
        connStaleYellow: psRule?.perConnectionStaleAfterMinutes?.yellow ?? 26 * 60,
        connStaleRed: psRule?.perConnectionStaleAfterMinutes?.red ?? 36 * 60,
      };
      const old = await getProcoreSyncThresholds(psEnv);
      await withGuaranteedAudit(
        { req, subsystem: "procore-sync", action: "reset", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, connStaleYellow: old.connStaleYellow, connStaleRed: old.connStaleRed, source: old.source }, newValue: null },
        async () => { await resetProcoreSyncThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Cron Scheduler thresholds ─────────────────────────────────────────

  app.get(
    "/api/admin/growth-health/cron-scheduler-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const rule = findRule("cron_scheduler");
      const env = {
        staleYellow: rule?.staleAfterMinutes.yellow ?? 90,
        staleRed: rule?.staleAfterMinutes.red ?? 240,
      };
      const t = await getCronSchedulerThresholds(env);
      res.json({ success: true, data: { ...t, envDefaults: env } });
    }),
  );

  app.post(
    "/api/admin/growth-health/cron-scheduler-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const { staleYellow, staleRed } = req.body as Record<string, unknown>;
      const sy = Number(staleYellow);
      const sr = Number(staleRed);
      if (!Number.isFinite(sy) || sy < 0) return res.status(400).json({ success: false, error: "staleYellow must be a non-negative number (minutes)" });
      if (!Number.isFinite(sr) || sr < 0) return res.status(400).json({ success: false, error: "staleRed must be a non-negative number (minutes)" });
      if (sy >= sr) return res.status(400).json({ success: false, error: "staleYellow must be less than staleRed" });
      const csRule = findRule("cron_scheduler");
      const csEnv = {
        staleYellow: csRule?.staleAfterMinutes.yellow ?? 90,
        staleRed: csRule?.staleAfterMinutes.red ?? 240,
      };
      const old = await getCronSchedulerThresholds(csEnv);
      await withGuaranteedAudit(
        { req, subsystem: "cron-scheduler", action: "set", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, source: old.source }, newValue: { staleYellow: sy, staleRed: sr } },
        async () => { await setCronSchedulerThresholds({ staleYellow: sy, staleRed: sr }); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true, data: { staleYellow: sy, staleRed: sr, source: "db" } });
    }),
  );

  app.delete(
    "/api/admin/growth-health/cron-scheduler-thresholds",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const csRule = findRule("cron_scheduler");
      const csEnv = {
        staleYellow: csRule?.staleAfterMinutes.yellow ?? 90,
        staleRed: csRule?.staleAfterMinutes.red ?? 240,
      };
      const old = await getCronSchedulerThresholds(csEnv);
      await withGuaranteedAudit(
        { req, subsystem: "cron-scheduler", action: "reset", endpoint: req.path, oldValue: { staleYellow: old.staleYellow, staleRed: old.staleRed, source: old.source }, newValue: null },
        async () => { await resetCronSchedulerThresholds(); invalidateGrowthHealthCache(); },
      );
      res.json({ success: true });
    }),
  );

  // ── Bulk reset all watchtower thresholds ──────────────────────────────

  app.post(
    "/api/admin/growth-health/reset-all",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });

      const ddRule = findRule("duplicate_deal_races");
      const ddEnvY = ddRule?.duplicateDealRacesPerHour?.yellow ?? 5;
      const ddEnvR = ddRule?.duplicateDealRacesPerHour?.red ?? 20;

      const dpRule = findRule("db_pool_health");
      const dpEnvY = dpRule?.poolResetsPerHour?.yellow ?? 30;
      const dpEnvR = dpRule?.poolResetsPerHour?.red ?? 60;

      const erRule = findRule("error_rate");
      const erEnvY = erRule?.errorFingerprintsLastHour?.yellow ?? 20;
      const erEnvR = erRule?.errorFingerprintsLastHour?.red ?? 50;

      const whRule = findRule("outbound_webhooks");
      const whEnvY = whRule?.webhookSuccessRate1h?.yellow ?? 0.95;
      const whEnvR = whRule?.webhookSuccessRate1h?.red ?? 0.9;
      const whEnvMV = whRule?.webhookSuccessRate1h?.minVolume ?? 5;

      const lsRule = findRule("lead_scraper");
      const lsEnv = {
        staleYellow: lsRule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: lsRule?.staleAfterMinutes.red ?? 48 * 60,
        failRateYellow: lsRule?.maxFailureRate24h?.yellow ?? 0.5,
        failRateRed: lsRule?.maxFailureRate24h?.red ?? 0.9,
        zeroOutputRunsRed: lsRule?.zeroOutputRunsRed ?? 3,
      };

      const opRule = findRule("outreach_processor");
      const opEnv = {
        staleYellow: opRule?.staleAfterMinutes.yellow ?? 90,
        staleRed: opRule?.staleAfterMinutes.red ?? 240,
        zeroSendYellow: opRule?.zeroSendBusinessHours?.yellow ?? 4,
        zeroSendRed: opRule?.zeroSendBusinessHours?.red ?? 8,
      };

      const odRule = findRule("outreach_deliverability");
      const odEnv = {
        staleYellow: odRule?.staleAfterMinutes.yellow ?? 36 * 60,
        staleRed: odRule?.staleAfterMinutes.red ?? 72 * 60,
        failRateYellow: odRule?.maxFailureRate24h?.yellow ?? 0.05,
        failRateRed: odRule?.maxFailureRate24h?.red ?? 0.1,
      };

      const swRule = findRule("stripe_webhooks");
      const swEnv = {
        failRateYellow: swRule?.maxFailureRate24h?.yellow ?? 0.2,
        failRateRed: swRule?.maxFailureRate24h?.red ?? 0.5,
        sigFailsRed: swRule?.signatureFailuresLastHourRed ?? 1,
      };

      const psRule = findRule("procore_sync");
      const psEnv = {
        staleYellow: psRule?.staleAfterMinutes.yellow ?? 26 * 60,
        staleRed: psRule?.staleAfterMinutes.red ?? 72 * 60,
        connStaleYellow: psRule?.perConnectionStaleAfterMinutes?.yellow ?? 26 * 60,
        connStaleRed: psRule?.perConnectionStaleAfterMinutes?.red ?? 36 * 60,
      };

      const csRule = findRule("cron_scheduler");
      const csEnv = {
        staleYellow: csRule?.staleAfterMinutes.yellow ?? 90,
        staleRed: csRule?.staleAfterMinutes.red ?? 240,
      };

      const [oldDd, oldDp, oldEr, oldWh, oldLs, oldOp, oldOd, oldSw, oldPs, oldCs] =
        await Promise.all([
          getDupeDealRaceThresholds(ddEnvY, ddEnvR),
          getDbPoolThresholds(dpEnvY, dpEnvR),
          getErrorRateThresholds(erEnvY, erEnvR),
          getWebhookSuccessThresholds(whEnvY, whEnvR, whEnvMV),
          getLeadScraperThresholds(lsEnv),
          getOutreachProcessorThresholds(opEnv),
          getOutreachDeliverabilityThresholds(odEnv),
          getStripeWebhookThresholds(swEnv),
          getProcoreSyncThresholds(psEnv),
          getCronSchedulerThresholds(csEnv),
        ]);

      await resetAllThresholds();
      invalidateGrowthHealthCache();

      const auditResults = await Promise.allSettled([
        recordThresholdAudit(req, "dupe-deal", "reset", req.path, { yellow: oldDd.yellow, red: oldDd.red, source: oldDd.source }, null),
        recordThresholdAudit(req, "pool-resets", "reset", req.path, { yellow: oldDp.yellow, red: oldDp.red, source: oldDp.source }, null),
        recordThresholdAudit(req, "error-rate", "reset", req.path, { yellow: oldEr.yellow, red: oldEr.red, source: oldEr.source }, null),
        recordThresholdAudit(req, "webhook-success", "reset", req.path, { yellow: oldWh.yellow, red: oldWh.red, minVolume: oldWh.minVolume, source: oldWh.source }, null),
        recordThresholdAudit(req, "lead-scraper", "reset", req.path, { staleYellow: oldLs.staleYellow, staleRed: oldLs.staleRed, failRateYellow: oldLs.failRateYellow, failRateRed: oldLs.failRateRed, zeroOutputRunsRed: oldLs.zeroOutputRunsRed, source: oldLs.source }, null),
        recordThresholdAudit(req, "outreach-processor", "reset", req.path, { staleYellow: oldOp.staleYellow, staleRed: oldOp.staleRed, zeroSendYellow: oldOp.zeroSendYellow, zeroSendRed: oldOp.zeroSendRed, source: oldOp.source }, null),
        recordThresholdAudit(req, "deliverability", "reset", req.path, { staleYellow: oldOd.staleYellow, staleRed: oldOd.staleRed, failRateYellow: oldOd.failRateYellow, failRateRed: oldOd.failRateRed, source: oldOd.source }, null),
        recordThresholdAudit(req, "stripe-webhook", "reset", req.path, { failRateYellow: oldSw.failRateYellow, failRateRed: oldSw.failRateRed, sigFailsRed: oldSw.sigFailsRed, source: oldSw.source }, null),
        recordThresholdAudit(req, "procore-sync", "reset", req.path, { staleYellow: oldPs.staleYellow, staleRed: oldPs.staleRed, connStaleYellow: oldPs.connStaleYellow, connStaleRed: oldPs.connStaleRed, source: oldPs.source }, null),
        recordThresholdAudit(req, "cron-scheduler", "reset", req.path, { staleYellow: oldCs.staleYellow, staleRed: oldCs.staleRed, source: oldCs.source }, null),
      ]);
      const auditSubsystems = ["dupe-deal", "pool-resets", "error-rate", "webhook-success", "lead-scraper", "outreach-processor", "deliverability", "stripe-webhook", "procore-sync", "cron-scheduler"];
      for (const [i, result] of auditResults.entries()) {
        if (result.status === "rejected") {
          log("warn", "watchtower-audit: failed to record reset-all audit entry", { subsystem: auditSubsystems[i], error: String(result.reason) });
        }
      }

      res.json({ success: true });
    }),
  );

  // ── Audit log meta (row count + last prune) ───────────────────────────

  app.get(
    "/api/admin/growth-health/audit-log-meta",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });
      const meta = await getAuditLogMeta();
      res.json({ success: true, data: meta });
    }),
  );

  // ── Threshold audit log ───────────────────────────────────────────────

  app.get(
    "/api/admin/growth-health/threshold-audit-log",
    asyncHandler(async (req, res) => {
      if (!isAdminRequest(req))
        return res.status(401).json({ success: false, error: "Unauthorized" });

      const subsystem = typeof req.query.subsystem === "string" ? req.query.subsystem : undefined;

      const rawLimit = Number(req.query.limit);
      const limit = req.query.limit !== undefined ? Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500) : 100;

      const rawOffset = Number(req.query.offset);
      const offset = req.query.offset !== undefined ? Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0) : 0;

      const rawSince = Number(req.query.since);
      const since = req.query.since !== undefined && Number.isFinite(rawSince) ? rawSince : undefined;

      const rawUntil = Number(req.query.until);
      const until = req.query.until !== undefined && Number.isFinite(rawUntil) ? rawUntil : undefined;

      if (since !== undefined && until !== undefined && since > until) {
        return res.status(400).json({ success: false, error: "since must be <= until" });
      }

      const { entries, total } = await getThresholdAuditLog({ subsystem, limit, offset, since, until });
      res.json({ success: true, data: entries, total, limit, offset });
    }),
  );
}
