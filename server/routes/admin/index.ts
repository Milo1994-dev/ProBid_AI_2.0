import express from "express";
import { registerAdminDashboardRoutes } from "./dashboard.js";
import { registerAdminEmailRoutes } from "./email.js";
import { registerAdminSeoRoutes } from "./seo.js";
import { registerAdminAffiliateRoutes } from "./affiliate.js";
import { registerAdminReviewRoutes } from "./reviews.js";
import { registerAdminFunnelRoutes } from "./funnel.js";
import { registerAdminSdkAllowlistRoutes } from "./sdk-allowlist.js";
import { registerAdminPartnerRoutes } from "./partners.js";
import { registerAdminGrowthHealthRoutes } from "./growth-health.js";
import { registerAdminHealthRoutes } from "./health.js";
import { registerAdminSellabilityRoutes } from "./sellability.js";
import { registerAdminRetentionRoutes } from "./retention.js";
import { registerAdminLoginRoutes } from "./login.js";
import { registerInvestorRoutes } from "./investor.js";
import { registerAdminGuaranteeRoutes } from "./guarantees.js";
import { getAllSequences } from "../../config/outreach-sequences.js";
import { isAdminRequest } from "./shared.js";

export function registerAdminRoutes(app: express.Application): void {
  registerAdminLoginRoutes(app);
  registerAdminDashboardRoutes(app);
  registerAdminEmailRoutes(app);
  registerAdminSeoRoutes(app);
  registerAdminAffiliateRoutes(app);
  registerAdminReviewRoutes(app);
  registerAdminFunnelRoutes(app);
  registerAdminSdkAllowlistRoutes(app);
  registerAdminPartnerRoutes(app);
  registerAdminGrowthHealthRoutes(app);
  registerAdminHealthRoutes(app);
  registerAdminSellabilityRoutes(app);
  registerAdminRetentionRoutes(app);
  registerInvestorRoutes(app);
  registerAdminGuaranteeRoutes(app);

  app.get("/api/admin/outreach-sequences", (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Forbidden" });
    res.json({ success: true, data: { sequences: getAllSequences() } });
  });
}
