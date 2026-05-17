# Scheduled Deployments — Runbook

The primary deployment is **Autoscale**, which spins workers up and down on
request. Anything scheduled via `node-cron` inside that process will only fire
while a worker happens to be alive, which is why outreach + scraping go quiet
between bursts of traffic. The fix is to add lightweight **Scheduled
Deployments** that hit our existing cron endpoints on a fixed schedule.

## What to create

In the Replit UI: **Deployments → New deployment → Scheduled**.

Create one scheduled deployment per cron endpoint below. Each one is a tiny
`curl` that runs and exits — no servers, no build needed.

| Name              | Schedule (cron)   | Command                                                                                                                            |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Outreach Processor| `*/15 * * * *`    | `curl -fsS -X POST -H "x-admin-key: $ADMIN_KEY" https://probidcore.net/api/cron/process-outreach`                                  |
| Lead Scraper      | `0 */6 * * *`     | `curl -fsS -X POST -H "x-admin-key: $ADMIN_KEY" https://probidcore.net/api/cron/scrape-leads`                                      |
| Daily Digest      | `0 14 * * *`      | `curl -fsS -X POST -H "x-admin-key: $ADMIN_KEY" https://probidcore.net/api/admin/health/digest-send`                               |

Notes:

- `ADMIN_KEY` is the same secret used elsewhere — set it in the scheduled
  deployment's env vars.
- `curl -f` makes the deployment exit non-zero on HTTP ≥ 400 so failures show
  up in the Replit deployments UI.
- The endpoints are idempotent and safe to retry. The in-process node-cron
  remains as a belt-and-braces fallback for when an Autoscale worker happens
  to be warm.

## How to verify

After creating each scheduled deployment, open `/admin/health` and watch the
"Cron Heartbeats" card. Within one schedule interval the timestamps should go
from `Xh ago` to under one interval old. Subsystem traffic lights will return
to green automatically as the health monitor sees fresh runs.

## Gotchas

- The Replit `.replit` file does **not** declare scheduled deployments — they
  are created in the dashboard. Do not try to add them via `[[deployment]]`
  blocks.
- If a scheduled deployment shows "no logs", the curl probably succeeded with
  a 2xx and exited cleanly. Look at server logs for the actual cron run.
- If `outreach_processor` keeps tripping yellow even after the scheduled
  deployment is wired up, check `/admin/health` for the Resend webhook card —
  zero engagement (0 opens after 150 sends) auto-pauses outreach as a safety
  net.
