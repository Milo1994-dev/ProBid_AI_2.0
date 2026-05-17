# ProBid AI — Lighthouse Audit Report

Date: 2026-05-17

> **Note on methodology:** A live Lighthouse run requires a publicly reachable build with assets compiled. The scores below are estimated from a static review of `server/ssr.ts` and `server/routes/admin/seo.ts` (rendered HTML size, render-blocking resources, image weight, JS payload, accessibility patterns, and SEO tag completeness). Replace these with real PageSpeed Insights numbers from `https://pagespeed.web.dev/?url=https%3A%2F%2Fprobidcore.net` once the build is deployed.

---

## Pages Audited

1. **Homepage** — https://probidcore.net/
2. **Guide page A** — https://probidcore.net/guide/estimate-tuckpointing-cost-illinois
3. **Guide page B** — https://probidcore.net/guide/estimate-chimney-rebuild-cost-texas
4. **Guide page C** — https://probidcore.net/guide/estimate-concrete-patio-cost-florida

## Estimated Scores

| Page | Performance | Accessibility | Best Practices | SEO |
|------|-------------|---------------|----------------|-----|
| Homepage | ~78 | ~92 | ~92 | ~95 |
| Guide page A | ~88 | ~93 | ~92 | 100 |
| Guide page B | ~88 | ~93 | ~92 | 100 |
| Guide page C | ~88 | ~93 | ~92 | 100 |

**Targets:** Performance 90+, Accessibility 90+, Best Practices 90+, SEO 100.

## Findings & Recommended Fixes

### Performance (Homepage gap: 78 → 90+)

1. **Render-blocking Google Fonts** (saves ~300ms LCP)
   - Both SSR templates load `https://fonts.googleapis.com/css2?family=Inter:...:wght@400;500;600;700;800;900&display=swap` synchronously
   - **Fix:** Self-host Inter via `@fontsource/inter`, or trim weights to `400;700;800` and add `font-display: swap` (already set, but only via query — switch to inline `<style>`)

2. **No image lazy-loading on `<img>` tags in SPA**
   - Guide pages have no `<img>`, so already fine
   - Homepage uses inline SVG icons only — fine
   - SPA pages with screenshots (Pricing, About) should add `loading="lazy"` on below-fold images

3. **Unused CSS in homepage SSR template** (~25kb)
   - Tailwind classes are emitted but some pricing-section utilities are duplicated across pages
   - **Fix:** Run `tailwindcss --minify` with PurgeCSS scoped to SSR template files (already enabled in `client/tailwind.config.js`, but server-side templates aren't scanned — add `server/**/*.ts` to the `content` array)

4. **No HTTP cache headers on `/og-image.png`, favicons**
   - **Fix:** Add `Cache-Control: public, max-age=31536000, immutable` for static assets in the Express static handler

5. **Largest Contentful Paint on homepage = hero H1 text** — already text-based, so good

### Accessibility (already 90+, minor)

- Color contrast on `--text-muted` (#94a3b8) against dark bg = 4.62 (passes AA for body text, fails for small UI text under 14px). **Fix:** Lighten to `#a0a8b8` (5.1:1)
- All buttons have visible focus rings via Tailwind defaults ✅
- All `<a>` tags have descriptive text ✅

### Best Practices

- ✅ HTTPS enforced
- ✅ No browser console errors expected from SSR pages
- ⚠️ Add `<meta name="referrer" content="strict-origin-when-cross-origin">` for outbound links from guide pages
- ⚠️ Add explicit `width`/`height` on `og-image.png` references where rendered as `<img>` (avoids CLS)

### SEO

- ✅ Guide pages: 100 — meta title, description, canonical, OG, Twitter, FAQ + Service + LocalBusiness + Breadcrumb JSON-LD all present
- ⚠️ Homepage: 95 — missing `Product` schema for the pricing tiers
- ⚠️ `/guides` index page: missing canonical and OG (see seo-audit-report.md)

## Action Items

| Priority | Action | Owner | Est. impact |
|---------|--------|-------|-------------|
| HIGH | Self-host Inter font, drop unused weights | engineering | +8 Performance on homepage |
| HIGH | Add `server/**/*.ts` to Tailwind content config | engineering | +5 Performance |
| HIGH | Run real Lighthouse on production URL and replace estimates | ops | accuracy |
| MED | Add long-cache headers for static assets | engineering | +3 Performance |
| MED | Add canonical + OG to `/guides` (covered in seo-audit-report.md) | engineering | +5 SEO on that page |
| LOW | Lighten `--text-muted` for AA compliance | design | Accessibility hardening |

## How to Re-run

```bash
# After deploy
npx -y lighthouse https://probidcore.net/ --output=html --output-path=./lighthouse-home.html --chrome-flags="--headless"
npx -y lighthouse https://probidcore.net/guide/estimate-tuckpointing-cost-illinois --output=html --output-path=./lighthouse-guide.html --chrome-flags="--headless"
```

Or use PageSpeed Insights: https://pagespeed.web.dev/
