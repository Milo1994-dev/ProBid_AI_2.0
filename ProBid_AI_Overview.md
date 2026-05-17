# ProBid AI — Company & Product Overview

**For Professional Evaluation, Rating & Valuation**
**Prepared April 2026**

---

## 1. Company Identity

| | |
|---|---|
| **Product name** | ProBid AI |
| **Tagline** | "Construction Estimates in 30 Seconds" |
| **Founder & CEO** | Jesse Kirchner — Galena, Illinois |
| **Website** | probidcore.net |
| **Category** | Vertical SaaS — AI-powered estimating for small construction contractors |
| **Stage** | Live, revenue-generating, deployed on auto-scaling cloud infrastructure |

---

## 2. What It Does

ProBid AI lets a contractor generate a professional, itemized cost estimate in 30 seconds. The contractor uploads one or more job-site photos and/or types a brief description of the work. The AI (GPT-4o Vision) reads the photos, identifies the scope, and produces a structured estimate broken into materials, labor, markup, and recommendations — calibrated to regional market rates by ZIP code. The contractor receives a downloadable PDF they can send directly to the homeowner, complete with a referral QR code.

Beyond estimates, the platform delivers a full contractor back-office: a sales pipeline, client CRM, automated email sequences, team management, outbound lead generation, an affiliate program, and a public API so construction-tech partners can embed ProBid's estimating engine into their own products.

---

## 3. Business Model

### Revenue Streams

| Stream | Price | Notes |
|---|---|---|
| Free tier | $0 | 2 lifetime estimates per account — conversion funnel entry |
| Single estimate | $7 one-time | Stripe Checkout, no subscription required |
| Pro subscription | $25 / month | Unlimited estimates; monthly or annual billing |
| Business subscription | $55 / month | Pro + team seats + Procore integration + API access; monthly or annual |
| Lifetime Access | $199 one-time | Full Business-tier access forever; "Founding Members" positioning |
| Affiliate commissions | 20% recurring | Contractors earn recurring commissions for every referral who subscribes |

### Revenue Architecture

- **Freemium funnel**: 2 free estimates capture genuine intent; paywall then offers $7 (low-friction) or $25/month (high-LTV path) directly on the result page.
- **$7 → Pro drip**: A 3-email automated upgrade sequence fires automatically after every single-estimate purchase.
- **Win-back drip**: 4-email sequence with escalating discounts automatically targets churned subscribers.
- **Dunning**: Automated retry logic and push notifications handle failed payments without manual intervention.
- **Dashboard ROI reinforcement**: Users see estimated hours saved and dollar value (benchmarked at $65/hr labor rate) every time they log in, supporting renewal decisions.
- **Viral loop**: Every PDF estimate includes a referral QR code — the product markets itself with every deliverable.

---

## 4. Full Feature Map

### Core AI Estimating Engine

- GPT-4o Vision analyzes multiple job-site photos simultaneously
- Seven supported trade verticals: Tuckpointing / Masonry, Chimney Rebuild, Retaining Walls, Concrete Flatwork, Roofing, Remodeling, General Construction
- Per-trade labor multipliers and default margin presets (e.g., Roofing: 1.1× labor / 18% margin; Concrete: 1.2× / 22%)
- ZIP-code-level regional pricing calibration
- Structured line-item extraction: description, quantity, unit cost, unit of measure
- Professional PDF export with referral QR code and contractor branding
- Estimate templates: save and reuse job configurations
- Saved line-item library: per-user preset library searchable by tag or cost type, sorted by most recently used
- Manual estimate builder: itemized entry with clone-to-edit workflow

### Sales Pipeline & CRM

- Kanban board with 7 canonical stages: Lead → Contacted → Site Visit Scheduled → Estimate Sent → Negotiation → Won / Lost
- Drag-and-drop deal movement between stages
- Full deal model: project address, project type, priority (low/medium/high), next action, expected start date, follow-up date, win probability
- Deal detail panel: view and edit modes, notes, file attachments (images and PDFs), Mark Won / Mark Lost with optional lost reason, Convert to Estimate, Delete
- Deal auto-population: new leads automatically create deals in the Lead stage; new estimates automatically promote existing deals to Estimate Sent — no duplicate rows
- Bidirectional sync: accepted/rejected estimates flip the linked deal to Won/Lost and vice versa
- Activity timeline per deal: auto-logged and manual notes
- Follow-up filter: toggle board to show only deals with follow-ups due today or overdue
- Pipeline analytics: win rate, total deal value, stage breakdown, 30-day revenue, overdue follow-up count

### Automation Engine

Seven behavior-triggered event types:

| Trigger | When It Fires |
|---|---|
| `signup_no_estimate` | User signed up but no estimate after 24h |
| `estimate_created` | New estimate generated |
| `deal_stage_changed` | Deal moved between pipeline stages |
| `deal_won` / `deal_lost` | Deal outcome recorded |
| `user_inactive` | No activity for 7+ days |
| `subscription_upgraded` / `subscription_cancelled` | Billing lifecycle change |
| `trial_ending` | Trial period ending soon |

Four action types: send email (with variable interpolation), auto-move deal stage, log activity note, send push notification.

- Per-rule cooldown / idempotency protection (configurable; default 24h)
- Condition matching with operators (equals, not equals, greater than, less than, contains, true/false)
- Full run history with success / failure logging per rule
- 4 pre-seeded default rules for common contractor workflows; fully customizable

### Automated Email Flows (via Resend)

All sequences run without any manual intervention:

- Welcome email on signup
- Estimate follow-up 15 minutes after generation (encourages client outreach while the homeowner is still engaged)
- 6–7 email drip sequence per funnel stage
- Win-back sequence for churned subscribers: 4 emails with escalating discount offers
- Single-estimate → Pro upgrade nudge: 3 emails after a $7 purchase
- Weekly recap email (Mondays 10:00 UTC)
- Dormant user re-engagement (Wednesdays 14:00 UTC)
- Trial-expiring push notifications (09:00 UTC daily)
- Daily admin health digest (07:30 UTC) — system status summary to the founder

### Lead Generation System

- Google Places API scraper runs daily at 08:00 UTC, pulling local contractor listings by trade and city
- 4-phase email warm-up ramp protecting sender domain reputation
- 3-touch cold outreach email sequence per lead (fully configurable)
- SMS outreach path for leads without email (phone number present)
- Website-form outreach path (identified and queued; automated submission in roadmap)
- Lead scoring model (0–100 points): email present (+10), phone (+10), website (+10), opened email (+20), clicked link (+20), replied (+30)
- Stage tracking: new → opened → clicked → replied → converted
- Resend webhook integration: bounce suppression, complaint suppression (auto do-not-contact), open and click tracking
- Deliverability dashboard: bounce rate, failure rate, queue pending count, pause status, daily breakdown

### Procore Trust Engine *(Business tier / Lifetime exclusive)*

Procore is the dominant project management platform in commercial construction (~$1B+ ARR, 1M+ projects tracked).

- OAuth 2.0 integration with the contractor's own Procore account (read-only)
- Pulls historical project data and generates "shadow estimates" — ProBid's AI estimates what those past jobs should have cost
- Calculates accuracy benchmarks: shadow estimate vs. actual project outcome
- Produces a verifiable, contractor-specific accuracy score — a proprietary, non-transferable switching cost unique to each customer's project history
- Pushes new ProBid estimates directly into Procore as full projects with budget line items and PDF attachments
- A/B-tested upgrade gate: variant A (direct pricing copy) vs. variant B (ROI-focused copy), with deterministic user-hash assignment and full event tracking

### Partner / Developer Platform

- Public REST API (v1) with Bearer token API keys (`pbk_*` prefix)
- Four permission scopes: `estimates:read`, `estimates:write`, `leads:read`, `usage:read`
- Per-key configurable rate limiting (10–1,000 req/min)
- Idempotency keys for safe partner-side retries (24-hour TTL — same key + same body = original response replayed, no double-charge)
- Outbound webhooks: partners subscribe to `estimate.created`, `estimate.updated`, `lead.created`
- Stripe-style webhook signatures (HMAC-SHA256 with timing-safe comparison)
- Exponential retry: up to 6 delivery attempts, capped at 1-hour backoff
- Embeddable JS SDK (`integrate.js`): partners embed ProBid's entire estimating flow on their own domain via a single `<script>` tag — cross-origin auth handled transparently via dedicated SDK session cookie + origin allowlist
- Developer Portal at `/app/developer`: API key management, webhook management, delivery history, interactive documentation, signature verification example
- SSRF protection on all outbound webhook URLs: RFC-1918 denylist, cloud metadata IP block (`169.254.169.254`), DNS validation before every delivery attempt

### Team Management *(Business tier)*

- Business subscribers invite team members with role-based management
- Team members inherit owner's full subscription entitlements
- Entitlement system: explicit per-user boolean feature flags (`procore`, `teams`, `unlimited_estimates`, `api_access`) returned by a rate-limited entitlements API

### Affiliate Program

- Every user receives a unique referral link on signup
- 20% recurring commission on each referred subscriber
- Tracked clicks, conversions, and earnings dashboard
- Viral built-in: PDF estimates embed referral QR codes, putting the affiliate loop into every deliverable

### SEO / Marketing Engine

- 96 dynamically generated SEO landing pages (service type × US state combinations)
- Auto-generated sitemap.xml and robots.txt
- Server-side rendering with full structured data: Organization, SoftwareApplication, FAQPage, BreadcrumbList (JSON-LD)
- Live Google Ads account: 633-006-4439 / tag ID `AW-633006439`
- Meta Pixel + Meta Conversions API with browser/server event deduplication (shared `event_id` round-tripped through Stripe metadata to survive the checkout redirect)
- GA4 full-funnel tracking: 11+ custom event types from page view through PDF download
- Conversion events wired: signup, lead captured, estimate generated, checkout started, purchase completed

---

## 5. Mobile Application

A full native mobile app (React Native + Expo) exists alongside the web app, with feature parity:

- Camera integration and photo library picker for job-site photo capture
- Photo annotation before AI analysis: freehand drawing, circles, arrows, text labels
- Biometric unlock: Face ID and fingerprint (stored in device secure enclave)
- Haptic feedback on key interactions
- Offline mode: caches the last 20 estimates, queues new submissions, auto-retries on reconnect
- Push notifications: estimate ready, trial expiring, failed payment
- In-app PDF viewer and native share sheet
- Saved line-item library with inline preset saving
- EAS Build configured: production `.aab` for Google Play Store, TestFlight for iOS

---

## 6. Admin Operations Dashboard

The founder has a full real-time back-office view:

| Panel | What It Shows |
|---|---|
| MRR Dashboard | Real-time Monthly Recurring Revenue by tier (Free / Pro / Business); progress toward revenue milestones; one-time purchase totals |
| Cohort Retention | Interval-based retention analysis: 30/60/90-day paid retention by signup cohort, verified vs. proxy billing events, weighted headline stat |
| User Analytics | Signups, active users, conversion rates |
| Revenue Analytics | MRR, ARR, subscriber counts by tier |
| Affiliate Management | Earnings, referred user list, payout history |
| Lead Management | Paginated scraped-lead table with stage filter, score, source, per-row actions |
| Error Monitoring | Fingerprinted 500-level error log with occurrence counts and resolve workflow |
| Outreach Deliverability | Bounce rate, failure rate, open/click rates, pause status, daily breakdown |
| System Health | Live `/admin/health` page — green/yellow/red per subsystem, polled every 30 seconds |
| Launch Checklist | Task tracking for go-to-market milestones |

---

## 7. Infrastructure & Engineering Quality

### Technology Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js (TypeScript) |
| Frontend web | React 18 + Vite + Tailwind CSS (dark theme) |
| Mobile | React Native + Expo (iOS and Android) |
| Database | PostgreSQL — managed with Drizzle ORM, additive-only migrations |
| AI | OpenAI GPT-4o Vision |
| Payments | Stripe (subscriptions, one-time, checkout sessions, webhooks) |
| Email | Resend (transactional + cold outreach, separate sending domains) |
| Deployment | Replit Autoscale (auto-scaling cloud, zero-downtime deploy) |
| Auth | Email + password (bcrypt, 12 rounds); CSRF-protected cookie sessions (web); bearer tokens (mobile); SDK session cookie for cross-origin partners |

### Reliability & Security Indicators

- **0 high / 0 moderate vulnerabilities** across all three dependency trees (root, client, mobile) — enforced as a hard gate on every code merge
- **295-test automated suite** (Vitest) covering auth, billing, pipeline, outreach, error tracking, migrations, and entitlements
- **Post-merge smoke gate**: 5 automated checks run after every merge (install, typecheck, full test suite, boot check, critical-endpoint smoke)
- **Stability Watchtower**: 5-minute health monitor covering lead scraper, email deliverability, Stripe webhooks, Procore sync, cron heartbeat, DB pool resets, error rate, and outbound webhook delivery rate — with email alert to founder on any threshold breach
- **Daily admin digest email**: 07:30 UTC summary of all subsystem health, so silence ≠ system down
- **HSTS** enforced with `includeSubDomains; preload`
- **Security headers**: Permissions-Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- **Audit log**: All security-sensitive actions recorded (API key creation/revocation, admin access, security events)
- **CSRF protection** on all state-changing endpoints
- **SSRF protection** on all outbound partner webhook deliveries (RFC-1918 + cloud metadata denylist + DNS validation)
- **DB connection pool**: max 20 connections, min 2, with transient-reset tracking
- **In-memory caching layer**: 5-minute and 30-second TTL groups for expensive queries
- **Gzip response compression** (level 6, 1KB threshold)
- **Additive-only database migrations**: schema changes never destructive; programmatic runner at startup (no interactive prompts during deploy)

---

## 8. Competitive Differentiation

| Advantage | Detail |
|---|---|
| Speed | 30-second AI estimate vs. hours of manual calculation |
| Photo-driven UX | Contractor photographs the job site — no spreadsheet required |
| Procore integration | Only AI estimator with verifiable accuracy proof tied to the contractor's own historical project data — unique, non-transferable switching cost per customer |
| Full back-office included | Pipeline, CRM, automation engine, affiliate system — not sold as separate add-ons |
| Partner API | Other construction-tech companies can white-label or embed ProBid's estimating engine via a JS SDK or REST API |
| Built-in lead generation | Scrapes, scores, sequences, and tracks contractor leads automatically — the platform grows its own customer funnel |
| Viral PDF loop | Every estimate sent to a homeowner includes a referral QR code — each deliverable is also a marketing asset |
| SEO moat | 96 city × trade landing pages already indexed, driving organic search traffic without ad spend |
| Mobile-native | Full iOS/Android app with offline mode, biometrics, and camera integration — not a mobile-adapted web view |

---

## 9. Market Opportunity

| | |
|---|---|
| Licensed contractors in the US | ~3.7 million (NAHB) |
| Primary target | Small-to-mid specialty trades: masonry, roofing, concrete, remodeling — typically 1–10 employees |
| Estimating software spend | ~$15 billion annually across construction tech (market research) |
| Pricing gap | Enterprise estimating tools (Buildxact, Clear Estimates, Stack) charge $100–$400/month and are designed for large general contractors. ProBid's $25–$55/month captures the underserved small-trade segment. |
| Entry point | $7 single estimate removes all friction for trial — no credit card commitment to validate the product |

---

## 10. Key Metrics Available for Due Diligence

| Metric | Source |
|---|---|
| MRR / ARR | Stripe Dashboard + `/api/admin/mrr` |
| Subscriber count by tier | Stripe Dashboard |
| Cohort 30/60/90-day retention | `/api/admin/retention/cohorts` |
| Total estimates generated | PostgreSQL `estimates` table |
| Affiliate-driven signups | `referrals` table |
| Lead scrape → paid conversion rate | `scraped_leads` joined to `users` |
| Outreach open / click / reply rates | `scraped_leads` aggregates |
| API partner usage | `api_keys.request_count` |
| Email deliverability health | `/api/admin/deliverability` |
| Error rate and system health | `/api/admin/health` + `error_logs` |

---

## 11. Intellectual Property

- Proprietary AI prompting layer calibrated per trade type and regional market
- Procore shadow-estimation accuracy engine — benchmarks ProBid estimates against real historical project outcomes, creating a unique, contractor-specific proof asset
- 4-phase email warm-up and outreach scoring system
- Embeddable JS SDK with cross-origin authentication architecture
- 96-page SEO content factory for construction trades across US markets
- Automation engine with event-driven rule system and cooldown/idempotency guarantees

---

## 12. Roadmap Indicators (Features Queued)

- Website-form outreach automation for leads with no email or phone (scraper already identifies these leads)
- SMS outreach automation (infrastructure already in place; volume scaling in progress)
- Duplicate-deal race alert notifications to founder (counter and logging already built)
- Pre-deploy migration safety check with blast-radius reporting
- Additional partner integrations beyond Procore

---

## 13. Summary

ProBid AI is a fully operational, revenue-generating vertical SaaS product with a clear wedge (30-second AI estimates), a defensible moat (Procore accuracy data per contractor), a viral growth loop (referral QR on every PDF), a built-in customer acquisition engine (automated lead scraping and outreach), and a partner platform that lets other construction-tech companies embed its core functionality. The product is built on a modern, well-tested, production-hardened stack with strong security posture and zero current vulnerabilities.

---

*For access to live revenue data, subscriber counts, cohort retention numbers, or a product demonstration, contact Jesse Kirchner directly.*
