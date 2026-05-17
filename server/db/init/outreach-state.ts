import { pool } from "../../db.js";
import { log } from "../../lib/logger.js";
import { setOutreachPaused } from "../../lib/outreach-state.js";
import { getWarmupPhaseForDay, getOutreachDailyLimit } from "../../lib/outreach-helpers.js";

export async function initOutreachState(): Promise<void> {
  // Core lead tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scraped_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      business_type TEXT,
      location TEXT,
      website TEXT,
      source TEXT DEFAULT 'google_places',
      do_not_contact BOOLEAN DEFAULT false,
      unsubscribe_token TEXT UNIQUE,
      opened_at BIGINT,
      clicked_at BIGINT,
      replied_at BIGINT,
      converted_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_email ON scraped_leads(email)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_phone ON scraped_leads(phone)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_dnc ON scraped_leads(do_not_contact)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_unsubscribe ON scraped_leads(unsubscribe_token)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_created ON scraped_leads(created_at)`,
  );
  // Ensure stage and score columns exist (added post-launch)
  await pool.query(
    `ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'new'`,
  );
  await pool.query(
    `ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_stage ON scraped_leads(stage)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_score ON scraped_leads(score DESC)`,
  );
  // Multi-channel contact tracking (Task #141 — never drop a lead just because
  // email is missing). contact_method_priority is a CSV of channels in order
  // of preference (e.g. "phone,sms,website_form,email"); lead_status is a
  // contactability bucket independent of `stage` (which tracks engagement).
  await pool.query(
    `ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS contact_method_priority TEXT`,
  );
  await pool.query(
    `ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS lead_status TEXT DEFAULT 'fully_contactable'`,
  );
  await pool.query(
    `ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS website_outreach_at BIGINT`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scraped_leads_lead_status ON scraped_leads(lead_status)`,
  );
  // Backfill lead_status for legacy rows so dashboard counters reflect reality.
  await pool.query(`
    UPDATE scraped_leads
    SET lead_status = CASE
      WHEN email IS NOT NULL AND (phone IS NOT NULL OR website IS NOT NULL) THEN 'fully_contactable'
      WHEN email IS NOT NULL THEN 'email_only'
      WHEN phone IS NOT NULL OR website IS NOT NULL THEN 'no_email_but_contactable'
      ELSE 'uncontactable'
    END
    WHERE lead_status IS NULL OR lead_status = 'fully_contactable'
  `).catch(err => log("warn", "lead_status backfill skipped", { error: err?.message }));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_outreach_queue (
      id SERIAL PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES scraped_leads(id),
      template_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      open_token TEXT UNIQUE,
      click_token TEXT UNIQUE,
      unsubscribe_token TEXT UNIQUE,
      created_at TEXT NOT NULL
    )
  `);
  await pool.query(
    `ALTER TABLE lead_outreach_queue ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT UNIQUE`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_loq_lead ON lead_outreach_queue(lead_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_loq_status ON lead_outreach_queue(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_loq_scheduled ON lead_outreach_queue(scheduled_for)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_loq_open_token ON lead_outreach_queue(open_token)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_loq_click_token ON lead_outreach_queue(click_token)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_loq_unsub_token ON lead_outreach_queue(unsubscribe_token)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_email_audit_log (
      id SERIAL PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES scraped_leads(id),
      template_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT NOT NULL
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_leal_lead ON lead_email_audit_log(lead_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_leal_status ON lead_email_audit_log(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_leal_sent ON lead_email_audit_log(sent_at)`,
  );

  // Config KV table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_outreach_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const result = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM lead_outreach_config WHERE key IN ('paused', 'pause_reason')`,
  );
  let _paused = false;
  let _reason = "";
  for (const row of result.rows) {
    if (row.key === "paused") _paused = row.value === "true";
    if (row.key === "pause_reason") _reason = row.value;
  }
  setOutreachPaused(_paused, _reason);

  // Add sms_sent_at column (post-launch migration — idempotent)
  await pool.query(
    `ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS sms_sent_at BIGINT`,
  );

  // ── Step A: Restore leads that were over-blocked by the old broad DNC migration.
  // Leads with "business" generic prefixes (info@, contact@, sales@, etc.) were
  // previously marked do_not_contact=true by a migration that was too aggressive.
  // These are real contractor businesses, not automated mailboxes.
  // Safe to restore if: never actually emailed (so no unsubscribe possible) AND
  // no explicit reply/opt-out (replied_at IS NULL).
  {
    const restorePrefixes = [
      "info", "contact", "contactus", "admin", "hello", "sales",
      "marketing", "webmaster", "office", "enquiries", "enquiry",
      "general", "team", "support", "billing", "accounts", "hr",
      "help", "press", "media",
    ];
    const restoreLike = restorePrefixes
      .map((p) => `email LIKE '${p}@%' OR email LIKE '${p}.%@%' OR email LIKE '${p}+%@%'`)
      .join(" OR ");
    const restoreResult = await pool.query(
      `UPDATE scraped_leads
       SET do_not_contact = false, stage = 'contacted', updated_at = $1
       WHERE do_not_contact = true
         AND stage = 'do_not_contact'
         AND replied_at IS NULL
         AND (${restoreLike})
         AND id NOT IN (
           SELECT DISTINCT lead_id FROM lead_email_audit_log WHERE status = 'sent'
         )`,
      [Date.now()],
    );
    if (restoreResult.rowCount && restoreResult.rowCount > 0) {
      log("info", "Restored over-blocked business-prefix leads from do_not_contact", {
        count: restoreResult.rowCount,
      });
      // Re-activate their suppressed queue entries so they can be emailed
      await pool.query(
        `UPDATE lead_outreach_queue
         SET status = 'pending', sent_at = NULL,
             scheduled_for = $1
         WHERE status = 'suppressed'
           AND lead_id IN (
             SELECT id FROM scraped_leads
             WHERE do_not_contact = false AND stage = 'contacted'
               AND (${restoreLike})
           )`,
        [new Date().toISOString()],
      );
    }
  }

  // ── Step B: Mark true system/automated addresses as do_not_contact.
  // Narrowed to addresses that are provably non-human: bounce handlers,
  // no-reply daemons, spam/abuse desks, etc.  Business shared-inbox
  // prefixes (info@, sales@, etc.) are no longer blocked here.
  {
    const systemPrefixes = [
      "noreply", "no-reply", "donotreply", "do-not-reply",
      "unsubscribe", "bounce", "bounces", "postmaster",
      "spam", "abuse", "security", "alerts",
    ];
    const likeConditions = systemPrefixes
      .map((p) => `email LIKE '${p}@%' OR email LIKE '${p}.%@%' OR email LIKE '${p}+%@%'`)
      .join(" OR ");
    const migResult = await pool.query(
      `UPDATE scraped_leads
       SET do_not_contact = true, stage = 'do_not_contact', updated_at = $1
       WHERE do_not_contact = false AND (${likeConditions})`,
      [Date.now()],
    );
    if (migResult.rowCount && migResult.rowCount > 0) {
      log("info", "Marked system-address leads as do_not_contact", {
        count: migResult.rowCount,
      });
      await pool.query(
        `UPDATE lead_outreach_queue SET status = 'suppressed', sent_at = $1
         WHERE status = 'pending' AND lead_id IN (
           SELECT id FROM scraped_leads
           WHERE do_not_contact = true AND stage = 'do_not_contact'
             AND (${likeConditions})
         )`,
        [new Date().toISOString()],
      );
    }
  }

  // Migrate legacy key: if outreach_daily_limit exists but daily_limit does not,
  // copy its value over before the warm-up scheduler reads the limit.
  // `daily_limit` is the single canonical key; if both keys somehow coexist,
  // ON CONFLICT DO NOTHING means `daily_limit` wins (precedence by design).
  // Must run before getOutreachDailyLimit() so the warm-up bump logic sees
  // any manually-set value and does not overwrite it.
  try {
    const migrated = await pool.query(`
      INSERT INTO lead_outreach_config (key, value)
      SELECT 'daily_limit', value FROM lead_outreach_config
      WHERE key = 'outreach_daily_limit'
      ON CONFLICT (key) DO NOTHING
    `);
    const deleted = await pool.query(
      `DELETE FROM lead_outreach_config WHERE key = 'outreach_daily_limit'`,
    );
    if ((deleted.rowCount ?? 0) > 0) {
      log("info", "Migrated legacy outreach_daily_limit key to daily_limit", {
        copied: migrated.rowCount ?? 0,
      });
    }
  } catch {
    /* non-critical */
  }

  // Warm-up auto-scheduler: ensure warmup_started_at is recorded, then
  // bump the daily limit UP (never down) according to the phase schedule.
  {
    const warmupRow = await pool.query<{ value: string }>(
      `SELECT value FROM lead_outreach_config WHERE key = 'warmup_started_at' LIMIT 1`,
    );
    let warmupStartedAt = warmupRow.rows[0]?.value ?? null;
    if (!warmupStartedAt) {
      // Derive from the earliest outreach email in the audit log so that
      // existing deployments compute the correct phase on first boot.
      let derivedFromAudit = false;
      try {
        const auditRow = await pool.query<{ earliest: string | null }>(
          `SELECT MIN(sent_at) AS earliest FROM lead_email_audit_log WHERE status = 'sent'`,
        );
        const earliest = auditRow.rows[0]?.earliest ?? null;
        if (earliest) {
          const parsed = new Date(earliest);
          if (!isNaN(parsed.getTime())) {
            warmupStartedAt = parsed.toISOString().split("T")[0]; // YYYY-MM-DD
            derivedFromAudit = true;
          }
        }
      } catch { /* fall through to today */ }
      if (!warmupStartedAt) {
        warmupStartedAt = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      }
      await pool.query(
        `INSERT INTO lead_outreach_config (key, value) VALUES ('warmup_started_at', $1) ON CONFLICT (key) DO NOTHING`,
        [warmupStartedAt],
      );
      log("info", "Outreach warm-up: warmup_started_at initialized", {
        warmupStartedAt, source: derivedFromAudit ? "audit_log" : "today",
      });
    }
    const daysElapsed = Math.floor(
      (Date.now() - new Date(warmupStartedAt).getTime()) / (1000 * 60 * 60 * 24),
    );
    const { phase, nextPhase, daysUntilNext } = getWarmupPhaseForDay(daysElapsed);
    const scheduledLimit = phase.limit;
    const currentLimit = await getOutreachDailyLimit();
    if (scheduledLimit > currentLimit) {
      await pool.query(
        `INSERT INTO lead_outreach_config (key, value) VALUES ('daily_limit', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(scheduledLimit)],
      );
      log("info", "Outreach warm-up: daily limit auto-bumped", {
        from: currentLimit, to: scheduledLimit, phase: phase.label, daysElapsed,
      });
    } else {
      log("info", "Outreach warm-up status", {
        phase: phase.label, scheduledLimit, currentLimit, daysElapsed,
        nextPhase: nextPhase?.label ?? "complete", daysUntilNext,
      });
    }
  }


  // Warn loudly if OUTREACH_FROM_EMAIL is not configured.
  // Without it, cold outreach emails are suppressed (fail-closed) — no emails sent.
  // getOutreachResendClient() will throw, and the outreach cron bails out early.
  if (!process.env.OUTREACH_FROM_EMAIL) {
    log("warn", "OUTREACH_FROM_EMAIL is not set — cold outreach emails are SUPPRESSED (fail-closed) to protect jesse@probidcore.net. " +
      "No cold emails will be sent until you set this var. " +
      "Action: verify outreach.probidcore.net in Resend (SPF/DKIM/DMARC), " +
      "then set OUTREACH_FROM_EMAIL=ProBid AI <hello@outreach.probidcore.net> in Replit Secrets.");
  }

  log("info", "Lead outreach tables bootstrapped");
}
