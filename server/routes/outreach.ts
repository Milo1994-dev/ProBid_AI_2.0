// Barrel: registers all outreach-related routes from focused submodules.
// The original ~2200-line outreach.ts was split into per-family files under
// ./outreach/ as part of task #95. Behavior, route paths, and middleware
// composition are unchanged — only the file layout changed.
import express from "express";
import { registerTrackingRoutes } from "./outreach/tracking.js";
import { registerCronRoutes } from "./outreach/cron.js";
import { registerCronDailyReportRoutes } from "./outreach/cron-daily-report.js";
import { registerWebhooksRoutes } from "./outreach/webhooks.js";
import { registerAdminStatusRoutes } from "./outreach/admin-status.js";
import { registerAdminLeadsRoutes } from "./outreach/admin-leads.js";
import { registerAdminAdsRoutes } from "./outreach/admin-ads.js";
import { registerAdminSystemAlertsRoutes } from "./outreach/admin-system-alerts.js";

export function registerOutreachRoutes(app: express.Application) {
  registerTrackingRoutes(app);
  registerCronRoutes(app);
  registerCronDailyReportRoutes(app);
  registerWebhooksRoutes(app);
  registerAdminStatusRoutes(app);
  registerAdminLeadsRoutes(app);
  registerAdminAdsRoutes(app);
  registerAdminSystemAlertsRoutes(app);
}
