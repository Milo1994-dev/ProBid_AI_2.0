import express from "express";
import crypto from "crypto";
import { verifyAdminSessionToken } from "../../lib/middleware.js";
export { hasResendCredentials } from "../../lib/config.js";

export function hasEnv(name: string): boolean {
  return Boolean(process.env[name]);
}

export const ADMIN_KEY = process.env.ADMIN_KEY || "";
export const PRICE_PRO = process.env.STRIPE_PRICE_PRO_MONTHLY || "";
export const PRICE_BIZ = process.env.STRIPE_PRICE_BUSINESS_MONTHLY || "";
export const PRICE_PRO_ANNUAL = process.env.STRIPE_PRICE_PRO_ANNUAL ?? "";
export const PRICE_BIZ_ANNUAL = process.env.STRIPE_PRICE_BUSINESS_ANNUAL ?? "";

/**
 * Constant-time string comparison. Returns false for any non-string input or
 * length mismatch without leaking timing information about which character
 * differed. Used to compare the admin key from request headers/query against
 * the env-supplied secret.
 */
export function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Admin auth — header or session cookie ONLY. Query-string `?key=` is
// rejected: it gets logged by proxies, saved in browser history, and
// leaked via Referer headers from any outbound link on an admin page.
// We hard-fail when ANY `?key=` is present in the URL — even if a valid
// header or session cookie also accompanies the request — so leaked
// URLs cannot be paired with a legitimate session to silently succeed.
export function isAdminRequest(req: express.Request): boolean {
  if (typeof req.query?.key !== "undefined") return false;
  if (req.session?.userRole === "admin") return true;
  if (!ADMIN_KEY) {
    const adminSession = req.session?.adminSession;
    if (adminSession && verifyAdminSessionToken(adminSession)) return true;
    return false;
  }
  if (safeEqual(req.headers["x-admin-key"], ADMIN_KEY)) return true;
  if (safeEqual(req.headers["x-cron-key"], ADMIN_KEY)) return true;
  const adminSession = req.session?.adminSession;
  if (adminSession && verifyAdminSessionToken(adminSession)) return true;
  return false;
}

export const SEO_STATES = [
  { slug: "illinois", name: "Illinois" },
  { slug: "wisconsin", name: "Wisconsin" },
  { slug: "iowa", name: "Iowa" },
  { slug: "minnesota", name: "Minnesota" },
  { slug: "missouri", name: "Missouri" },
  { slug: "indiana", name: "Indiana" },
  { slug: "michigan", name: "Michigan" },
  { slug: "ohio", name: "Ohio" },
  { slug: "texas", name: "Texas" },
  { slug: "florida", name: "Florida" },
  { slug: "california", name: "California" },
  { slug: "new-york", name: "New York" },
  { slug: "pennsylvania", name: "Pennsylvania" },
  { slug: "georgia", name: "Georgia" },
  { slug: "arizona", name: "Arizona" },
];

export const SEO_SERVICES = [
  { slug: "retaining-wall", name: "Retaining wall" },
  { slug: "chimney-rebuild", name: "Chimney rebuild" },
  { slug: "chimney-restoration", name: "Chimney restoration" },
  { slug: "tuckpointing", name: "Tuckpointing" },
  { slug: "repointing", name: "Repointing" },
  { slug: "brick-repair", name: "Brick repair" },
  { slug: "foundation-repair", name: "Foundation repair" },
  { slug: "stone-veneer", name: "Stone veneer" },
  { slug: "concrete-repair", name: "Concrete repair" },
  { slug: "concrete-patio", name: "Concrete patio" },
  { slug: "masonry-waterproofing", name: "Masonry waterproofing" },
  { slug: "parging", name: "Parging" },
  { slug: "lintel-replacement", name: "Lintel replacement" },
  { slug: "roof-repair", name: "Roof repair" },
  { slug: "siding-repair", name: "Siding repair" },
  { slug: "bath-remodel", name: "Bathroom remodel" },
  { slug: "kitchen-remodel", name: "Kitchen remodel" },
];

export function generateSeoContent(serviceName: string, stateName: string): string {
  const priceRanges: Record<string, { low: string; high: string; unit: string }> = {
    "Retaining wall": { low: "$25", high: "$75", unit: "per sq ft" },
    "Chimney rebuild": { low: "$1,500", high: "$15,000", unit: "total" },
    "Chimney restoration": { low: "$1,200", high: "$12,000", unit: "total" },
    Tuckpointing: { low: "$5", high: "$25", unit: "per sq ft" },
    Repointing: { low: "$5", high: "$25", unit: "per sq ft" },
    "Brick repair": { low: "$10", high: "$35", unit: "per sq ft" },
    "Foundation repair": { low: "$2,000", high: "$25,000", unit: "total" },
    "Stone veneer": { low: "$15", high: "$45", unit: "per sq ft" },
    "Concrete repair": { low: "$4", high: "$18", unit: "per sq ft" },
    "Concrete patio": { low: "$6", high: "$20", unit: "per sq ft" },
    "Masonry waterproofing": { low: "$3", high: "$10", unit: "per sq ft" },
    Parging: { low: "$5", high: "$15", unit: "per sq ft" },
    "Lintel replacement": { low: "$400", high: "$2,500", unit: "per lintel" },
    "Roof repair": { low: "$300", high: "$5,000", unit: "total" },
    "Siding repair": { low: "$200", high: "$8,000", unit: "total" },
    "Bathroom remodel": { low: "$10,000", high: "$35,000", unit: "total" },
    "Kitchen remodel": { low: "$15,000", high: "$75,000", unit: "total" },
  };

  const prices = priceRanges[serviceName] || { low: "$500", high: "$10,000", unit: "total" };

  return `
    <div class="seo-content">
      <section class="intro">
        <p>Looking for accurate <strong>${serviceName.toLowerCase()}</strong> pricing in <strong>${stateName}</strong>? You've come to the right place. Whether you're a homeowner planning a renovation or a contractor preparing a bid, understanding current market rates is essential for making informed decisions.</p>
      </section>
      <section class="pricing-overview">
        <h2>2025 ${serviceName} Cost Overview in ${stateName}</h2>
        <div class="price-card">
          <div class="price-range">
            <span class="low">${prices.low}</span>
            <span class="separator">to</span>
            <span class="high">${prices.high}</span>
            <span class="unit">${prices.unit}</span>
          </div>
          <p class="price-note">Prices vary based on project scope, materials, and local labor rates.</p>
        </div>
      </section>
      <section class="factors">
        <h2>Key Factors Affecting ${serviceName} Costs</h2>
        <ul>
          <li><strong>Project Size & Scope:</strong> Larger projects often have lower per-unit costs due to economies of scale.</li>
          <li><strong>Material Quality:</strong> Premium materials cost more upfront but often provide better durability and aesthetics.</li>
          <li><strong>Labor Rates:</strong> ${stateName} labor costs vary by region and contractor experience level.</li>
          <li><strong>Site Conditions:</strong> Accessibility, existing damage, and preparation work can impact final pricing.</li>
          <li><strong>Permits & Inspections:</strong> Local building codes in ${stateName} may require permits that add to project costs.</li>
          <li><strong>Seasonal Demand:</strong> Prices may fluctuate based on time of year and contractor availability.</li>
        </ul>
      </section>
      <section class="what-to-expect">
        <h2>What to Expect During Your Project</h2>
        <p>A typical ${serviceName.toLowerCase()} project in ${stateName} involves several phases:</p>
        <ol>
          <li><strong>Initial Assessment:</strong> A contractor will evaluate your property and discuss your goals.</li>
          <li><strong>Detailed Estimate:</strong> You'll receive a comprehensive breakdown of labor, materials, and timeline.</li>
          <li><strong>Permits & Prep:</strong> Any necessary permits will be obtained and the work area prepared.</li>
          <li><strong>Construction:</strong> The main work is completed according to the agreed schedule.</li>
          <li><strong>Final Inspection:</strong> A walkthrough ensures everything meets your expectations and local codes.</li>
        </ol>
      </section>
      <section class="tips">
        <h2>Tips for Getting the Best Value</h2>
        <ul>
          <li>Get multiple quotes from licensed contractors in ${stateName}.</li>
          <li>Check references and verify insurance coverage.</li>
          <li>Ask about warranties on materials and workmanship.</li>
          <li>Consider timing your project during off-peak seasons for potential savings.</li>
          <li>Be clear about your budget and priorities upfront.</li>
        </ul>
      </section>
      <section class="cta-section">
        <h2>Get Your Free Instant Estimate</h2>
        <p>Ready to get started? ProBid AI uses advanced technology to generate accurate ${serviceName.toLowerCase()} estimates in seconds. Simply describe your project and get a professional estimate instantly - no waiting, no phone calls, no obligation.</p>
        <a href="/signup" class="cta-button">Get Free Estimate Now</a>
      </section>
      <section class="related-guides">
        <h2>More Cost Guides</h2>
        <p>Browse our other free pricing guides for ${stateName}:</p>
        <ul>
          ${SEO_SERVICES
            .filter(s => s.name !== serviceName)
            .slice(0, 4)
            .map(s => {
              const stateSlug = stateName.toLowerCase().replace(/\s+/g, "-");
              return `<li><a href="/guide/estimate-${s.slug}-cost-${stateSlug}">${s.name} costs in ${stateName}</a></li>`;
            })
            .join("\n          ")}
        </ul>
        <p style="margin-top:16px;"><a href="/guides">View all construction cost guides &rarr;</a></p>
      </section>
    </div>
  `;
}
