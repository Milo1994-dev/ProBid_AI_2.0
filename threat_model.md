# Threat Model

## Project Overview

ProBid AI is a production web application for construction estimates, lead outreach, billing, team collaboration, API access, and Procore-backed accuracy reporting. The production entry point is the Node/Express TypeScript backend (`server.ts`, deployed as `node --enable-source-maps dist/server.js`) serving a React/Vite SPA, authenticated JSON APIs, public marketing pages, admin tools, cron endpoints, and third-party webhooks. The project also contains an Expo mobile app and development/mockup artifacts; production security analysis should focus on code reachable through the deployed Express server and shared libraries.

The application stores data in PostgreSQL through Drizzle, uses cookie-session for first-party sessions, API keys for programmatic access, Stripe for payments, Resend for email and webhooks, OpenAI for estimate and analysis features, Procore OAuth/API integrations, and scheduled lead scraping/outreach jobs.

## Assets

- **User accounts and sessions** -- email addresses, password hashes, session cookies, CSRF tokens, and account state. Compromise allows impersonation, estimate access, billing changes, or unauthorized team membership.
- **Subscription and entitlement state** -- Stripe customer IDs, subscriptions, purchases, team-derived effective subscriptions, and feature gates. Tampering or missing server-side checks can grant paid Business capabilities without authorization.
- **API keys** -- programmatic bearer tokens, hashed key records, scopes, rate limits, and usage metadata. Leaked or over-issued keys can access estimate, lead, usage, and account APIs outside the browser session.
- **Estimate and project data** -- job details, line items, generated estimates, photos, PDFs, Procore projects, budgets, change orders, metrics, and reports. This information is customer business-sensitive and may contain client PII.
- **Lead and outreach data** -- scraped lead names, emails, phones, business metadata, unsubscribe tokens, reply/conversion status, and outreach queue entries. This data must not be exposed outside authorized admin/operator surfaces.
- **Application and integration secrets** -- `SESSION_SECRET`, `DATABASE_URL`, `ADMIN_KEY`, Stripe keys/webhook secret, Resend keys/webhook secret, Procore OAuth credentials, OpenAI keys, Google Places credentials, and other environment secrets.
- **Admin and cron authority** -- admin dashboards, outreach controls, review moderation, cron endpoints, and daily reports. These surfaces can read or mutate global business data and must be protected from normal users.

## Trust Boundaries

- **Browser/mobile client to Express API** -- all client-controlled requests cross this boundary. The server must authenticate, authorize, validate, rate-limit, and enforce paid feature gates regardless of React UI state.
- **Public to authenticated boundary** -- marketing, signup/login, public SDK script loading, webhooks, and public pages are unauthenticated; estimates, teams, billing, Procore, saved items, notifications, API key management, and user data require authenticated identity.
- **Authenticated user to team/business entitlement boundary** -- team membership can cause a user to inherit the owner's subscription through `getEffectiveSub`; invite acceptance and team-management routes must prevent unauthorized membership or feature inheritance.
- **Free/Pro/Business entitlement boundary** -- paid features such as Business teams, Procore, API access, custom branding, analytics, and priority support must be enforced server-side, not only hidden in the frontend.
- **API key boundary** -- bearer API requests should be scoped to the owning user and declared key scopes, should not create browser sessions, and should not bypass subscription/entitlement checks for gated features.
- **User/admin boundary** -- admin and cron routes protected by `ADMIN_KEY`, admin sessions, or user role must never be reachable by regular authenticated users or public requests. Admin keys in URLs should be treated as highly sensitive.
- **Express to PostgreSQL boundary** -- application code has broad database access. Queries must remain parameterized, and user IDs/tenant IDs must be included in authorization-sensitive queries.
- **Express to third-party services** -- Stripe, Resend, Procore, OpenAI, Google Places, and external lead websites are less-trusted network boundaries. Webhooks/callbacks require signature or state validation; outgoing requests must not leak unnecessary sensitive data.
- **Production to development/mockup boundary** -- mockup sandbox, development-only scripts, and legacy/dev entry points are out of production scope unless reachable from `server.ts` under `NODE_ENV=production` and the deployment command.

## Scan Anchors

- **Production entry point:** `server.ts` registers middleware, sessions, rate limits, JSON parsing, webhooks, all API route modules, static SPA serving, and schedulers.
- **Highest-risk server routes:** `server/routes/auth.ts`, `server/routes/estimates.ts`, `server/routes/billing.ts`, `server/routes/teams.ts`, `server/routes/api-keys.ts`, `server/routes/api-v1.ts`, `server/routes/procore.ts`, `server/routes/leads.ts`, `server/routes/outreach/*`, and `server/routes/admin/*`.
- **Shared authorization helpers:** `server/lib/middleware.ts`, `server/lib/api-key-auth.ts`, `server/lib/team-helpers.ts`, `server/routes/admin/shared.ts`, `server/lib/sdk-session.ts`, and `server/lib/cors.ts`.
- **Sensitive background jobs:** `server/jobs/scheduler.ts`, `server/lead-scraper.ts`, `server/shadow-estimator.ts`, and outreach cron/webhook handlers.
- **Frontend trust model:** React pages in `client/src/pages/*` and API wrappers in `client/src/api/client.ts` are untrusted UX gates; feature access must be enforced by backend route handlers.
- **Dev-only/out-of-scope by default:** mockup sandbox code, local-only scripts, historical built output under `dist/` unless verifying deployed compilation, and `main.py` unless the deployment process is changed to run it.
- **Platform assumptions:** production runs with `NODE_ENV=production`; deployed traffic is protected by platform-managed TLS; certificate management is handled by the platform.

## Threat Categories

### Spoofing

Users authenticate through first-party sessions and API clients authenticate through bearer API keys. Session cookies must remain unpredictable, signed, `HttpOnly`, `Secure`, and scoped so API key authentication cannot bootstrap a normal browser session. Stripe and Resend webhooks must verify provider signatures in production, and Procore OAuth callbacks must validate opaque state before storing tokens. Invite codes, password reset or verification tokens, CSRF tokens, and admin keys must be treated as bearer secrets.

### Tampering

The client can submit arbitrary request bodies, query parameters, file metadata, selected Procore company IDs, API key scopes, billing plan choices, and team invite codes. The server must validate schemas, calculate prices and quotas server-side, use Stripe-created checkout metadata only after webhook signature verification, enforce CSRF protections for cookie-authenticated state changes, and never rely on frontend hiding of paid features.

### Repudiation

Sensitive actions such as API key creation/revocation, billing events, admin changes, team membership changes, outreach mutations, and Procore sync/report generation should retain enough audit context to identify the actor, timestamp, resource, and source IP where appropriate. Logs must avoid exposing bearer secrets or unnecessary PII while still supporting incident response.

### Information Disclosure

Estimate details, lead emails/phones, Procore project data, team membership, API keys, Stripe customer identifiers, and admin dashboard data must only be returned to authorized users. Logs, emails, webhook diagnostics, errors, and analytics calls must not leak secrets, raw API keys, invite codes, unsubscribe tokens, or unnecessary PII. External services such as OpenAI should receive only the data required for their feature.

### Denial of Service

Public and authenticated endpoints that trigger expensive operations -- login/signup, estimate generation, file upload/photo analysis, Procore sync, OpenAI calls, lead scraping, outreach, and API-key endpoints -- require rate limits, bounded request sizes, input limits, and job controls. Background schedulers must not run unbounded scraping or sync loops.

### Elevation of Privilege

Every route that reads or mutates user, team, billing, Procore, lead, or admin data must perform server-side authorization using the authenticated user or validated API key owner. Team invites must bind acceptance to the intended recipient; team-derived subscriptions must not grant Business features to unintended users. Business-only functionality, including Procore and developer API access, must be enforced by backend entitlement checks rather than client-side UI state.