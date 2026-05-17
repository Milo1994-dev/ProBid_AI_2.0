// Barrel: re-exports the DB init/seed functions from focused submodules.
// The original ~450-line init.ts was split into per-concern files under
// ./init/ as part of task #95. Function signatures and call order in
// server.ts are unchanged — only the file layout changed.
export { migrateReviewsTable } from "./init/reviews.js";
export { cleanupStaleJobRuns } from "./init/job-runs.js";
export { seedSeoPages } from "./init/seo-pages.js";
export { seedOutreachConfig } from "./init/outreach-config.js";
export { initOutreachState } from "./init/outreach-state.js";
export { initSdkAllowlistTable } from "./init/sdk-allowlist.js";
export { initPartnersSchema } from "./init/partners.js";
