/**
 * Lead Engine — scoring and stage derivation for scraped leads.
 *
 * Scoring formula (additive, capped 0-100):
 *   +15 email present
 *   +20 phone present
 *   +10 website present
 *   +15 ICP trade match
 *   +20 opened an outreach email
 *   +25 clicked a CTA link
 *   +40 replied to an outreach email
 *    =0 if doNotContact is true (forced to 0)
 *
 * Stage taxonomy (highest priority wins):
 *   do_not_contact — doNotContact=true
 *   subscribed     — convertedAt set
 *   interested     — stage was manually set to 'interested'
 *   replied        — repliedAt set
 *   clicked        — clickedAt set
 *   opened         — openedAt set
 *   contacted      — at least one email sent (contacted=true flag)
 *   new            — no engagement yet
 */

import { db, pool } from "./db.js";
import { scrapedLeads, leadOutreachQueue } from "../shared/schema.js";
import { eq, sql } from "drizzle-orm";

export type LeadStage =
  | "new"
  | "contacted"
  | "opened"
  | "clicked"
  | "replied"
  | "interested"
  | "subscribed"
  | "do_not_contact";

/** Trades considered a perfect ICP match for ProBid AI. */
export const ICP_TRADES = new Set([
  "masonry",
  "roofing",
  "concrete",
  "remodeling",
  "tuckpointing",
  "painting",
  "drywall",
  "plumbing",
  "electrical",
  "landscaping",
  "hvac",
  "flooring",
]);

export interface LeadSignals {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  businessType?: string | null;
  openedAt?: number | null;
  clickedAt?: number | null;
  repliedAt?: number | null;
  convertedAt?: number | null;
  doNotContact?: boolean | null;
  /** Whether at least one outreach email has been sent (resolved from queue). */
  contacted?: boolean;
  /** Preserved when stage is already 'interested' (manually set). */
  currentStage?: string | null;
}

/** Compute an integer engagement score 0-100. Returns 0 if doNotContact. */
export function computeScore(lead: LeadSignals): number {
  if (lead.doNotContact) return 0;
  let score = 0;
  if (lead.email) score += 15;
  if (lead.phone) score += 20;
  if (lead.website) score += 10;
  if (lead.businessType && ICP_TRADES.has(lead.businessType.toLowerCase())) score += 15;
  if (lead.openedAt) score += 20;
  if (lead.clickedAt) score += 25;
  if (lead.repliedAt) score += 40;
  return Math.min(score, 100);
}

/** Derive the highest-priority stage from lead signals. */
export function deriveStage(lead: LeadSignals): LeadStage {
  if (lead.doNotContact) return "do_not_contact";
  if (lead.convertedAt) return "subscribed";
  if (lead.currentStage === "interested") return "interested";
  if (lead.repliedAt) return "replied";
  if (lead.clickedAt) return "clicked";
  if (lead.openedAt) return "opened";
  if (lead.contacted) return "contacted";
  return "new";
}

/**
 * Batch-recompute score and stage for all scraped leads.
 * Joins with leadOutreachQueue to detect "contacted" status.
 * Preserves stage='interested' (manually set).
 * Processes in database-side pages to avoid loading all rows into memory.
 */
export async function scoreAndStageAllLeads(): Promise<void> {
  const PAGE_SIZE = 200;

  try {
    // Get set of lead IDs that have had at least one email sent
    const contactedRows = await pool.query<{ lead_id: string }>(
      `SELECT DISTINCT lead_id FROM lead_outreach_queue WHERE status IN ('sent')`,
    );
    const contactedSet = new Set(contactedRows.rows.map((r) => r.lead_id));

    // Paginate through leads using LIMIT/OFFSET so we never load the full
    // table into memory — safe at any scale.
    let offset = 0;
    while (true) {
      const page = await db
        .select()
        .from(scrapedLeads)
        .limit(PAGE_SIZE)
        .offset(offset);

      if (page.length === 0) break;

      await Promise.all(
        page.map(async (lead) => {
          const signals: LeadSignals = {
            ...lead,
            contacted: contactedSet.has(lead.id),
            currentStage: lead.stage,
          };
          const score = computeScore(signals);
          const stage = deriveStage(signals);
          if (score !== (lead.score ?? 0) || stage !== (lead.stage ?? "new")) {
            await db
              .update(scrapedLeads)
              .set({ score, stage, updatedAt: Date.now() })
              .where(eq(scrapedLeads.id, lead.id));
          }
        }),
      );

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  } catch (err) {
    console.error("[lead-engine] scoreAndStageAllLeads error:", err);
  }
}
