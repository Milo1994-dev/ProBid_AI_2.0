import { pool } from "../../db.js";
import { log } from "../../lib/logger.js";

export async function seedOutreachConfig(): Promise<void> {
  try {
    const configDefaults: Array<[string, string]> = [
      ["daily_limit", "25"],
      ["outreach_from_name", "ProBid AI"],
      ["scraper_enabled", "true"],
      ["outreach_enabled", "true"],
      [
        "scraper_target_trades",
        "masonry,roofing,concrete,remodeling,tuckpointing,plumbing,electrical,hvac,general contractor",
      ],
      [
        "scraper_target_cities",
        "Chicago IL,Milwaukee WI,Minneapolis MN,Indianapolis IN,Columbus OH,Kansas City MO,St Louis MO,Detroit MI,Cleveland OH,Cincinnati OH,Atlanta GA,Nashville TN,Charlotte NC,Tampa FL,Baltimore MD,Dallas TX,Houston TX,San Antonio TX,Austin TX,Phoenix AZ,Denver CO,Las Vegas NV,Seattle WA,Portland OR,Philadelphia PA",
      ],
    ];
    for (const [key, value] of configDefaults) {
      await pool.query(
        `INSERT INTO lead_outreach_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value],
      );
    }
    log("info", "Lead outreach config defaults seeded");
  } catch (err) {
    log("warn", "Failed to seed lead_outreach_config defaults", {
      error: String(err),
    });
  }
}
