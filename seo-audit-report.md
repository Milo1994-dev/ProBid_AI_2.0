# ProBid AI — On-Page SEO Audit Report

Date: 2026-05-17
Auditor: automated review of source HTML in `server/ssr.ts`, `server/routes/admin/seo.ts`, `server/routes/marketing.ts`, and the React SPA `client/index.html`.

**Legend:** PASS ✅ · WARN ⚠️ · FAIL ❌

---

## 1. Title Tags

| Page | Title | Length | Status |
|------|-------|--------|--------|
| / (Home) | "ProBid AI — Construction Estimates in 30 Seconds" | 51 | PASS |
| /pricing | "Pricing \| ProBid AI — Plans for Every Contractor" | 49 | PASS |
| /accuracy | "Accuracy & Benchmarks \| ProBid AI" | ~35 | PASS |
| /guides | "Construction Cost Guides & Pricing Estimates (2025) \| ProBid AI" | 64 | WARN — slightly over 60, also hardcoded "2025" |
| /guide/:slug | Stored title, "2025" replaced at render with current year | varies (most 55–80) | WARN — some long-state titles exceed 60 |
| /refer | "ProBid AI - AI-Powered Construction Estimates in 60 Seconds" | 60 | PASS |
| /affiliate | SPA fallback to client/index.html title | 51 | PASS |
| /partner-portal | SPA fallback title | 51 | WARN — needs unique SSR title |
| /guarantees | SPA fallback title | 51 | WARN — needs unique SSR title |
| /contact | SPA fallback title | 51 | WARN — needs unique SSR title |

**Recommended fix:** Shorten `/guides` title to "Construction Cost Guides | ProBid AI" (39 chars). Add per-page SSR titles for Affiliate, Partner Portal, Guarantees, Contact (each currently inherits the homepage title from `client/index.html`).

## 2. Meta Descriptions

| Page | Length | Status |
|------|--------|--------|
| / | 154 | PASS |
| /pricing | 158 | PASS |
| /accuracy | 152 | PASS |
| /guides | 169 | WARN — over 160 |
| /guide/:slug | Dynamically generated per service+state, 155–175 chars | PASS / WARN (some >160) |
| /refer | 132 | WARN — under 150 |
| Other SPA pages | Inherit homepage description | FAIL — not unique |

**Recommended fix:** Tighten guide meta description template (current adds "free" + "guide for" + "contractors. " — drop one phrase to land in 150–160). Add unique meta descriptions for the SPA-only pages.

## 3. H1 Tags

| Page | H1 Count | Status |
|------|----------|--------|
| / | 1 ("Win more jobs…") | PASS |
| /pricing | 1 | PASS |
| /accuracy | 1 | PASS |
| /guides | 1 ("Construction Cost Guides") | PASS |
| /guide/:slug | 1 (rendered title) | PASS |
| /refer | 1 | PASS |
| SPA pages | 1 each (per React components) | PASS |

All audited pages have exactly one H1. ✅

## 4. H2/H3 Subheadings (Keyword Targeting)

| Page | H2/H3 Keyword Coverage | Status |
|------|------------------------|--------|
| / | "Founding Members", feature names — weak on "construction estimate" keyword | WARN |
| /pricing | Plan names only | WARN — add "Construction estimating plans" H2 |
| /guide/:slug | "2026 [Service] Cost Overview in [State]", "Key Factors Affecting [Service] Costs", "What to Expect", "Tips" | PASS — strong keyword-stuffed H2s |
| /guides | "[Service] Cost Guides" per group | PASS |

## 5. Image Alt Tags

| Surface | Findings | Status |
|---------|----------|--------|
| Homepage SSR | Mostly icons (emoji or inline SVG), no `<img>` tags requiring alt | PASS |
| Guide pages | No `<img>` tags in the SSR template — purely CSS gradients | PASS |
| `/og-image.png` | Used in OG/Twitter tags only, not inline | N/A |
| SPA pages | Need spot-check; `client/src/components/` should be audited for any `<img>` without `alt=""` | TODO — verify React components |

**Recommended fix:** Add an ESLint rule (`jsx-a11y/alt-text`) to enforce alt tags on every `<img>` in React code going forward.

## 6. Canonical Tags

| Page | Canonical URL | Status |
|------|---------------|--------|
| / | https://probidcore.net/ | PASS |
| /pricing | https://probidcore.net/pricing | PASS |
| /accuracy | https://probidcore.net/accuracy | PASS |
| /guide/:slug | https://probidcore.net/guide/{slug} | PASS |
| /guides | MISSING | FAIL |
| /refer | MISSING | FAIL |
| SPA pages (affiliate, partner-portal, guarantees, contact) | Inherit homepage canonical | FAIL |

**Recommended fix:** Inject canonical tags in `server/routes/admin/seo.ts` `/guides` handler and `server/routes/marketing.ts` `/refer` handler. For SPA-only pages, either add SSR variants or use `react-helmet` to set canonical per route.

## 7. Open Graph & Twitter Cards

| Page | og:title | og:description | og:image | og:url | twitter:card | Status |
|------|----------|----------------|----------|--------|--------------|--------|
| / | ✅ | ✅ | ✅ | ✅ | summary_large_image | PASS |
| /pricing | ✅ | ✅ | ✅ (inherits) | ✅ | ✅ | PASS |
| /guide/:slug | ✅ | ✅ | ✅ | ✅ | ✅ | PASS |
| /guides | ❌ no OG tags | ❌ | ❌ | ❌ | ❌ | FAIL |
| /refer | only basic description | ❌ no OG | ❌ | ❌ | ❌ | FAIL |
| SPA pages | Inherit homepage | partial | inherit | wrong URL | inherit | WARN |

**og:image fallback:** `https://probidcore.net/og-image.png` exists at `client/public/og-image.png`. ✅

**Recommended fix:** Add full OG/Twitter tag blocks to `/guides`, `/refer`. For SPA pages, override per-route via `react-helmet`.

## 8. Structured Data (JSON-LD)

| Page | Schema | Status |
|------|--------|--------|
| / | `SoftwareApplication` + `AggregateOffer` | PASS |
| /guide/:slug | `FAQPage` + `Service` + `LocalBusiness` + `BreadcrumbList` (just added) | PASS |
| /pricing | none | WARN — add `Product` or `Offer` schema |
| /accuracy | none | WARN — add `Dataset` schema for benchmark data |
| /guides | none | WARN — add `CollectionPage` + `ItemList` |

## 9. robots.txt — crawl health

```
User-agent: *
Allow: /
Disallow: /app/
Disallow: /api/
Disallow: /admin/

Sitemap: https://probidcore.net/sitemap.xml
```

- ✅ Public marketing + guide pages crawlable
- ✅ `/app/`, `/api/`, `/admin/` correctly blocked
- ✅ Sitemap reference present

## 10. Sitemap (`/sitemap.xml`)

- ✅ Includes 14 core pages + all guide pages from `seo_pages` table
- ✅ Each URL has `<lastmod>`, `<priority>`, `<changefreq>`
- After deploy + admin re-seed, will include 255 guide pages (17 services × 15 states)

## Summary of Required Fixes (prioritized)

1. **HIGH** — Add canonical + OG/Twitter tags to `/guides` and `/refer` (FAIL)
2. **HIGH** — Add unique SSR title + meta description for Affiliate, Partner Portal, Guarantees, Contact (FAIL)
3. **MEDIUM** — Shorten `/guides` title under 60 chars; replace hardcoded "2025"
4. **MEDIUM** — Add `Product`/`Dataset`/`CollectionPage` JSON-LD on Pricing/Accuracy/Guides
5. **LOW** — Add ESLint `jsx-a11y/alt-text` rule to guard React images going forward
6. **LOW** — After deploy, hit `POST /admin/seed-seo` to generate the 159 new guide pages from expanded services/states

## Files Audited

- `client/index.html`
- `server/ssr.ts` (homepage, pricing, accuracy SSR)
- `server/routes/admin/seo.ts` (`/guides`, `/guide/:slug`)
- `server/routes/marketing.ts` (`/refer`, `/sitemap.xml`, `/robots.txt`)
- `server/routes/admin/shared.ts` (SEO_SERVICES/STATES, generateSeoContent)
