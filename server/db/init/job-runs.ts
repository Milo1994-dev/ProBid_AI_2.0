import { db } from "../../db.js";
import { eq, and, lt } from "drizzle-orm";
import { jobRuns } from "../../../shared/schema.js";
import { log } from "../../lib/logger.js";

export async function cleanupStaleJobRuns(): Promise<void> {
  try {
    const staleThreshold = Date.now() - 2 * 60 * 60 * 1000;
    const stale = await db
      .update(jobRuns)
      .set({
        status: "failed",
        finishedAt: Date.now(),
        errorSummary: "Marked stale at startup (likely crash)",
      })
      .where(
        and(
          eq(jobRuns.status, "running"),
          lt(jobRuns.startedAt, staleThreshold),
        ),
      )
      .returning({ id: jobRuns.id, jobName: jobRuns.jobName });
    if (stale.length > 0) {
      log("warn", "Stale job_runs cleaned up at startup", {
        count: stale.length,
        jobs: stale.map((r) => r.jobName),
      });
    }
  } catch (e) {
    log("warn", "Stale job_runs cleanup failed (non-fatal)", {
      error: String(e),
    });
  }
}
