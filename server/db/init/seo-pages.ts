import { db } from "../../db.js";
import { count } from "drizzle-orm";
import { seoPages } from "../../../shared/schema.js";
import { log } from "../../lib/logger.js";
import { SEO_STATES, SEO_SERVICES, generateSeoContent } from "../../lib/seo-helpers.js";

export async function seedSeoPages(): Promise<void> {
  // We always iterate the full service x state matrix and let the DB
  // dedupe via onConflictDoNothing. This way, when SEO_SERVICES or
  // SEO_STATES are expanded (e.g. adding pennsylvania/georgia/arizona
  // or brick-repair/foundation-repair), the next server boot
  // automatically backfills the missing slugs without an admin click —
  // existing rows are left untouched.
  const beforeResult = await db.select({ c: count() }).from(seoPages);
  const before = beforeResult[0]?.c || 0;

  const createdAt = new Date().toISOString();
  const expectedTotal = SEO_SERVICES.length * SEO_STATES.length;

  for (const service of SEO_SERVICES) {
    for (const state of SEO_STATES) {
      const slug = `estimate-${service.slug}-cost-${state.slug}`;
      const title = `${service.name} Cost in ${state.name} (${new Date().getFullYear()} Pricing Guide + Free Estimate)`;
      const content = generateSeoContent(service.name, state.name);

      await db
        .insert(seoPages)
        .values({
          slug,
          title,
          content,
          createdAt,
        })
        .onConflictDoNothing();
    }
  }

  const afterResult = await db.select({ c: count() }).from(seoPages);
  const after = afterResult[0]?.c || 0;
  const inserted = after - before;

  if (inserted > 0) {
    log("info", "SEO pages backfilled", { inserted, totalNow: after, expected: expectedTotal });
  } else {
    log("info", "SEO pages already up to date", { totalNow: after, expected: expectedTotal });
  }
}
