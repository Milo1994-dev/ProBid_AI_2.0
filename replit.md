# ProBid AI

ProBid AI provides instant, AI-powered construction estimates for small contractors, streamlining their estimation process with a freemium SaaS model.

## Run & Operate

**Run:** `npm run start` (starts the Node.js server)
**Build:**
- Client: `npm run build:client` (from root) or `npm run build` (from `client/`)
- Mobile: `eas build --profile production --platform android` for Android AAB (from `mobile/`)
**Typecheck:** `npx tsc --noEmit`
**Codegen:** `npm run db:generate` (after schema changes in `shared/schema.ts`)
**DB Push:** `npm run db:push` (for local development)

**Required Environment Variables:**
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Long random string for cookie-session encryption
- `STRIPE_SECRET_KEY`: Stripe secret key (`sk_live_...` or `sk_test_...`)
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret (`whsec_...`)
- `STRIPE_PRICE_PRO_MONTHLY`: Stripe Price ID for Pro monthly plan
- `STRIPE_PRICE_BUSINESS_MONTHLY`: Stripe Price ID for Business monthly plan

## Stack

- **Backend:** Node.js with Express.js (TypeScript)
- **Frontend:** React 18 + Vite + Tailwind CSS
- **Mobile:** React Native + Expo
- **Database:** PostgreSQL with Drizzle ORM
- **Validation:** Zod
- **Build Tool:** Vite

## Where things live

- **Backend API:** `server/routes/`
- **Frontend App:** `client/`
- **Mobile App:** `mobile/`
- **Shared Schemas:** `shared/schema.ts` (DB schema, API types)
- **API Client (Web):** `client/src/api/client.ts`
- **API Client (Mobile):** `mobile/src/api/client.ts`
- **AI Logic:** `server/lib/ai.ts`
- **Email Templates:** `server/lib/email-helpers.ts` (for transactional emails), `server/lib/outreach-templates.ts` (for cold outreach)
- **Stripe Integration:** `server/lib/stripe-helpers.ts`
- **Authentication:** `server/routes/auth.ts`, `server/lib/middleware.ts`
- **Deployment Scripts:** `scripts/` (e.g., `scripts/deploy-build.sh`, `scripts/smoke.sh`)
- **Stripe Webhook:** `server/routes/billing.ts`
- **Stripe Checkout Session Creation:** `server/routes/billing.ts`
- **Theme/Styling:** `client/tailwind.config.js`, `mobile/tailwind.config.js`

## Architecture decisions

- **Paid-Only Model (post-2026-05-14):** New signups have no free estimates and are routed straight to `/pricing` after signup. Users created before `FREE_TIER_SIGNUP_CUTOFF_MS` (in `server/lib/user-helpers.ts`) keep their original 3-lifetime-free allowance. Allowance is computed by `getFreeLifetimeAllowance(createdAt)` and enforced server-side via `enforcePaywall` (returns `subscription_required` when allowance is 0).
- **Hybrid Web/Mobile Auth:** Cookie-based sessions with CSRF for web, bearer tokens for mobile (via `X-Platform` header or user-agent detection). `requireApiKeyOrSession` middleware handles both.
- **Resilient Database Migrations:** `drizzle-kit push` removed from deploy; migrations run programmatically at startup (`server/db/migrate.ts`) to avoid interactive prompts and ensure forward-only changes.
- **Outreach Email Isolation:** Cold outreach emails use a dedicated subdomain (`outreach.probidcore.net`) configured in Resend, preventing spam complaints from impacting transactional email deliverability on the main domain.
- **Canonical Domain Redirects:** All SEO authority consolidated to `https://probidcore.net` via 301 redirects for `*.com` and `www.probidcore.net`, preserving original URL paths.
- **Error Tracking & Deduplication:** All 500-level errors captured in `error_logs` table with fingerprinting, occurrences, and timestamps to prevent duplicate alerts.

## Product

- **AI Estimation:** Generates estimates from photos/descriptions using GPT-4o Vision, adjusted for regional pricing, with PDF export.
- **CRM & Leads:** Tracks client info, estimate history, and manages leads with automated email follow-ups.
- **Affiliate System:** Users earn 20% recurring commissions via unique referral codes, integrated with viral marketing through PDF estimates.
- **Team Management:** Business tier supports inviting team members with role management.
- **Pipeline & Automation Engine:** Kanban board for sales pipeline with deal tracking, stages, activities, and behavior-triggered automation rules (e.g., send email after estimate created).
- **Public API & Webhooks:** Developer portal for API key management, programmatic access to estimates and leads, and outbound webhooks for real-time event notifications.
- **Procore Integration:** Business tier exclusive. Generates "shadow estimates" for historical projects and pushes estimates directly into Procore.
- **Autonomous Marketing System:** Includes referral landing pages, automated email drip sequences, and a marketing hub with templates.

## User preferences

I prefer clear and concise communication. Focus on delivering solutions iteratively and explain the rationale behind significant architectural or design decisions. Avoid making major changes without prior discussion and approval. I want the agent to work autonomously but to ask for confirmation before implementing complex features or making large-scale modifications to existing code.

## Gotchas

- **DB Migrations:** Never run `drizzle-kit push --force` in production. Always generate SQL migrations locally via `npm run db:generate` and commit them; the app will apply them on startup.
- **Stale Builds:** If a `drizzle` prompt appears during deploy, it's likely a stale build. Dismiss the prompt and Republish to get a fresh build.
- **SDK Integration:** The `probid_sdk_session` cookie is for cross-origin embedding, requiring `SameSite=None; Secure; HttpOnly`. Ensure `SDK_ALLOWED_ORIGINS` is correctly configured.
- **Admin Key:** Access `/admin` via the `x-admin-key` header or by logging in once via `/admin/login`. URL query params are rejected.
- **Mobile UUID Vulnerability:** `uuid` dependency in `mobile/package.json` was upgraded to `14.0.0` to patch a GHSA. Monitor `eas build` logs after `mobile` dependency changes.

## Pointers

- **Replit Autoscale:** [https://docs.replit.com/hosting/deployments/autoscale](https://docs.replit.com/hosting/deployments/autoscale)
- **Drizzle ORM Documentation:** [https://orm.drizzle.team/](https://orm.drizzle.team/)
- **Stripe API Documentation:** [https://stripe.com/docs/api](https://stripe.com/docs/api)
- **Resend API Documentation:** [https://resend.com/docs](https://resend.com/docs)
- **OpenAI GPT-4o Vision:** [https://openai.com/gpt-4o](https://openai.com/gpt-4o)
- **Google Ads Conversion Tracking:** [https://support.google.com/google-ads/answer/6095821](https://support.google.com/google-ads/answer/6095821)
- **Meta Pixel Standard Events:** [https://www.facebook.com/business/help/402791146561655](https://www.facebook.com/business/help/402791146561655)