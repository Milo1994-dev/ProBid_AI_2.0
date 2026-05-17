import express from "express";
import PDFDocument from "pdfkit";
import { checkDatabaseConnection } from "../db.js";
import { asyncHandler } from "../lib/middleware.js";
import { getMissingEnv, SUBSYSTEM_ENV } from "../lib/config.js";
import { buildHealthPayload } from "../lib/system-helpers.js";
import { log } from "../lib/logger.js";

export function registerSystemRoutes(app: express.Application) {
  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      res.json(await buildHealthPayload());
    }),
  );

  app.get(
    "/api/health",
    asyncHandler(async (_req, res) => {
      res.json(await buildHealthPayload());
    }),
  );

  app.get(
    "/api/system/health",
    asyncHandler(async (_req, res) => {
      let database = false;
      try {
        database = await checkDatabaseConnection();
      } catch {
        database = false;
      }

      const leadScraper =
        getMissingEnv(SUBSYSTEM_ENV["lead-scraper"]).length === 0;
      const emailDrip = getMissingEnv(SUBSYSTEM_ENV["email-drip"]).length === 0;
      const smsOutreach =
        getMissingEnv(SUBSYSTEM_ENV["sms-outreach"]).length === 0;

      const allRequired = [
        ...SUBSYSTEM_ENV["lead-scraper"],
        ...SUBSYSTEM_ENV["email-drip"],
        ...SUBSYSTEM_ENV["sms-outreach"],
      ];
      const missingSecrets = [...new Set(getMissingEnv(allRequired))];

      res.json({ database, leadScraper, emailDrip, smsOutreach, missingSecrets });
    }),
  );

  app.get(
    "/api/uptime",
    asyncHandler(async (req, res) => {
      const uptimeSeconds = Math.floor(process.uptime());
      const now = new Date();

      log("info", "Uptime ping received", {
        uptime: uptimeSeconds,
        timestamp: now.toISOString(),
      });

      res.json({
        status: "alive",
        uptime: uptimeSeconds,
        timestamp: now.toISOString(),
        autonomous_systems: {
          email_drip: "active",
          seo_pages: 96,
          sitemap: "/sitemap.xml",
        },
      });
    }),
  );

  app.get("/favicon.ico", (req, res) => {
    res.status(204).end();
  });

  app.get(
    "/api/sample-estimate.pdf",
    asyncHandler(async (_req, res) => {
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ProBid-AI-Sample-Estimate.pdf"`,
      );
      doc.pipe(res);

      doc.fontSize(24).font("Helvetica-Bold").fillColor("#1a56db")
        .text("ProBid AI — Sample Estimate", { align: "center" });
      doc.moveDown(0.3);
      doc.fontSize(10).font("Helvetica").fillColor("#555555")
        .text("probidcore.net  ·  AI-Powered Construction Estimating", { align: "center" });
      doc.moveDown(0.5);

      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#cccccc").lineWidth(1).stroke();
      doc.moveDown(0.8);

      doc.fontSize(13).font("Helvetica-Bold").fillColor("#111111").text("Project Details");
      doc.moveDown(0.3);
      const details = [
        ["Job Type", "Chimney Tuckpointing"],
        ["Scope", "Tuckpointing of approx. 120 sq ft of deteriorated mortar joints on a brick chimney exterior."],
        ["Location", "Chicago Metro Area"],
        ["Date", new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })],
        ["Generated In", "27 seconds"],
      ];
      doc.fontSize(10).font("Helvetica").fillColor("#333333");
      for (const [label, value] of details) {
        doc.text(`${label}: `, { continued: true }).font("Helvetica-Bold").text(value).font("Helvetica");
        doc.moveDown(0.2);
      }
      doc.moveDown(0.6);

      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#cccccc").lineWidth(1).stroke();
      doc.moveDown(0.8);
      doc.fontSize(13).font("Helvetica-Bold").fillColor("#111111").text("Cost Breakdown");
      doc.moveDown(0.5);

      const lineItems = [
        ["Materials — Type S Mortar, Cleaning Supplies", "$380"],
        ["Labor — 2-man crew, 4 hours @ $90/hr", "$720"],
      ];
      for (const [desc, cost] of lineItems) {
        const y = doc.y;
        doc.fontSize(10).font("Helvetica").fillColor("#333333").text(desc, 50, y, { width: 400 });
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#111111").text(cost, 450, y, { width: 100, align: "right" });
        doc.moveDown(0.8);
      }
      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#22c55e").lineWidth(1.5).stroke();
      doc.moveDown(0.5);
      const totalY = doc.y;
      doc.fontSize(13).font("Helvetica-Bold").fillColor("#111111").text("Total Estimate", 50, totalY, { width: 400 });
      doc.fontSize(15).font("Helvetica-Bold").fillColor("#16a34a").text("$1,100 – $1,350", 400, totalY, { width: 150, align: "right" });
      doc.moveDown(1.5);

      doc.fontSize(10).font("Helvetica").fillColor("#555555")
        .text("Notes: Price reflects 2-man crew at standard regional rates. Material cost may vary by mortar type. Price range accounts for site conditions.", { width: 512 });
      doc.moveDown(1.5);

      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#cccccc").lineWidth(1).stroke();
      doc.moveDown(0.6);
      doc.fontSize(9).font("Helvetica").fillColor("#1a56db")
        .text("Generated by ProBid AI — Create Yours Free", { align: "center" });
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor("#888888")
        .text("probidcore.net  ·  Instant AI-Powered Contractor Estimates", { align: "center" });

      doc.end();
    }),
  );
}
