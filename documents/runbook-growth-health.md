# Growth Engine Health — Runbook

When you get a `[ProBid AI] Growth Engine YELLOW/RED: <subsystem>` email,
open the Admin Dashboard → **Growth Health** tab and find the matching
card. The card lists `reasons[]` (which threshold tripped) plus
last-success / last-failure timestamps and the latest error string.

## Status meanings

- **green** — within all thresholds
- **yellow** — degraded, action required soon (not bleeding yet)
- **red** — silent failure in progress, fix now
- **paused** — operator-suspended (e.g. outreach paused after a bounce spike)
- **unknown** — no data yet (fresh deploy, or no Procore tenants)

Alerts use **open-incident dedupe**: one email per incident at each
severity. While an unresolved `system_alerts` row exists for a
subsystem, no new email fires at the same severity. Yellow → red flips
resolve the open yellow and send a fresh red email. A `green` or
`paused` recovery resolves all open rows and sends a single recovery
email.

Rules live in `server/lib/growth-health-rules.ts` — edit thresholds there.

---

## lead_scraper

**Source:** `job_runs` rows with `job_name = 'scrape-leads'`.

| Symptom | Likely cause | Fix |
|---|---|---|
| `Last success > 26h ago` | Daily cron skipped, or `GOOGLE_PLACES_API_KEY` missing | Check Replit Secrets; manually trigger from Admin → Manual Triggers → Run Scraper |
| `24h failure rate ≥ 50%` | Google Places quota exhausted, or geocoding failures | Check Google Cloud Console → APIs & Services → Quotas |
| `3 consecutive successful runs returned 0 leads` | Search-radius / category filter too narrow, or all candidate leads already enriched | Re-tune search params in scraper config; expand cities |

## outreach_processor

**Source:** `job_runs` rows with `job_name = 'process-outreach'`.

| Symptom | Likely cause | Fix |
|---|---|---|
| `Last success > 90 min ago` | Hourly cron not running, or all runs erroring | Trigger manually; check `cron_last_outreach` in `lead_outreach_config` |
| `0 outbound messages in last 4h/8h (business hours)` | Queue exhausted, throttler stuck, or sending domain blocked | Check `lead_email_audit_log` for last entry; inspect outreach pause flag and warm-up phase |
| Status `paused` | Bounce-rate or send-error guard tripped | Admin → Outreach Status → Resume after fixing the underlying cause |

## outreach_deliverability

**Source:** `lead_email_audit_log` (`status = 'sent'` vs `bounced_*` / `complained` over last 24h).

| Symptom | Likely cause | Fix |
|---|---|---|
| `failure rate ≥ 5%` (yellow) | List quality drift or DNS/SPF issue on outreach domain | Verify `outreach.probidcore.net` SPF/DKIM/DMARC in Resend |
| `failure rate ≥ 10%` (red) | Spam complaint or ISP block | Pause outreach, audit recent sends, rotate sending IP if needed |

## stripe_webhooks

**Source:** `error_logs` rows with `path = '/api/stripe/webhook'`, plus positive signal from `subscriptions.updated_at` and `purchases.created_at` in the last 24h.

| Symptom | Likely cause | Fix |
|---|---|---|
| `1+ Stripe signature failure(s) in last 60 min` (red) | `STRIPE_WEBHOOK_SECRET` rotated, replay attack, or proxy stripping the body | Update Replit Secret immediately; check the most recent error in `error_logs` |
| `failure rate ≥ 20%` | Handler exceptions on real events | Inspect `/api/admin/errors?path=/api/stripe/webhook` for stack |
| `Last success > 7d ago` | Genuinely no stripe events (low volume) — usually safe | Confirm via Stripe dashboard; thresholds intentionally loose |

## procore_sync

**Source:** `procore_connections` rows with `status = 'active'`, evaluated per connection (so one busy tenant can't mask another stuck tenant).

| Symptom | Likely cause | Fix |
|---|---|---|
| `N active connection(s) stale > 2160 min` (red, 36h) | OAuth token revoked, refresh failing, or that tenant's sync stuck | Inspect that connection in `/api/admin/system-status`; have user reconnect from Settings → Integrations |
| `Last success > 26h ago` (any tenant) | Sync cron not running | Restart workflow; check `cron_last_*` heartbeats |
| Status `unknown` | No active Procore connections | Expected — no alert is raised |

## cron_scheduler

**Source:** `lead_outreach_config` rows whose key starts with `cron_last_`.

| Symptom | Likely cause | Fix |
|---|---|---|
| `Last success > 90 min ago` | node-cron didn't fire (process restart, scheduler skipped at boot) | Restart the `ProBid Core` workflow; check logs for "Scheduler started" |
| `unknown` | Brand-new deploy, no cron has run yet | Trigger any cron once from Admin → Manual Triggers |

---

## Where things live

- Rules / thresholds: `server/lib/growth-health-rules.ts`
- Rollup computer: `server/growth-health.ts`
- Alerter (transitions + recovery + dedup): `server/health-monitor.ts` (`runHealthChecks`)
- API: `GET /api/admin/growth-health` (admin-only) — `server/routes/admin/growth-health.ts`
- UI: Admin Dashboard → **Growth Health** tab
- Persistence: `system_alerts` table — open rows = unresolved alerts; `resolved_at` set on recovery
