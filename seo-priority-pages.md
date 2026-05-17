# ProBid AI — SEO Priority Pages & Directory Backlink Tracker

Last updated: 2026-05-17

This document tracks (1) the top 20 highest-value guide pages to push for indexing and (2) the directories where ProBid should be submitted for backlinks and citation authority.

---

## Part 1 — Top 20 Priority Guide Pages

Priority is a 1–100 composite score that weights:
- Estimated monthly search volume for `[service] cost [state]` queries (40%)
- Commercial intent / contractor purchase-readiness (30%)
- Match to ProBid's masonry/restoration core ICP (30%)

Target states (priority order): Illinois, Texas, Florida, California, New York, Ohio, Pennsylvania, Michigan, Georgia, Arizona.
Target services (priority order): brick repair, tuckpointing, chimney restoration, foundation repair, stone veneer, concrete repair, masonry waterproofing, parging, lintel replacement, repointing.

| # | Page URL | Service | State | Priority Score | Status |
|---|----------|---------|-------|----------------|--------|
| 1 | https://probidcore.net/guide/estimate-tuckpointing-cost-illinois | Tuckpointing | Illinois | 98 | LIVE — request indexing |
| 2 | https://probidcore.net/guide/estimate-brick-repair-cost-texas | Brick repair | Texas | 96 | NEEDS RE-SEED (new service) — request indexing after seed |
| 3 | https://probidcore.net/guide/estimate-foundation-repair-cost-texas | Foundation repair | Texas | 95 | NEEDS RE-SEED |
| 4 | https://probidcore.net/guide/estimate-chimney-restoration-cost-florida | Chimney restoration | Florida | 94 | NEEDS RE-SEED |
| 5 | https://probidcore.net/guide/estimate-foundation-repair-cost-california | Foundation repair | California | 93 | NEEDS RE-SEED |
| 6 | https://probidcore.net/guide/estimate-tuckpointing-cost-new-york | Tuckpointing | New York | 92 | LIVE — request indexing |
| 7 | https://probidcore.net/guide/estimate-brick-repair-cost-illinois | Brick repair | Illinois | 91 | NEEDS RE-SEED |
| 8 | https://probidcore.net/guide/estimate-chimney-restoration-cost-pennsylvania | Chimney restoration | Pennsylvania | 90 | NEEDS RE-SEED |
| 9 | https://probidcore.net/guide/estimate-stone-veneer-cost-california | Stone veneer | California | 89 | NEEDS RE-SEED |
| 10 | https://probidcore.net/guide/estimate-concrete-repair-cost-ohio | Concrete repair | Ohio | 88 | NEEDS RE-SEED |
| 11 | https://probidcore.net/guide/estimate-tuckpointing-cost-michigan | Tuckpointing | Michigan | 87 | LIVE — request indexing |
| 12 | https://probidcore.net/guide/estimate-masonry-waterproofing-cost-florida | Masonry waterproofing | Florida | 86 | NEEDS RE-SEED |
| 13 | https://probidcore.net/guide/estimate-repointing-cost-pennsylvania | Repointing | Pennsylvania | 85 | NEEDS RE-SEED |
| 14 | https://probidcore.net/guide/estimate-foundation-repair-cost-georgia | Foundation repair | Georgia | 84 | NEEDS RE-SEED |
| 15 | https://probidcore.net/guide/estimate-parging-cost-michigan | Parging | Michigan | 82 | NEEDS RE-SEED |
| 16 | https://probidcore.net/guide/estimate-lintel-replacement-cost-new-york | Lintel replacement | New York | 81 | NEEDS RE-SEED |
| 17 | https://probidcore.net/guide/estimate-chimney-rebuild-cost-ohio | Chimney rebuild | Ohio | 80 | LIVE — request indexing |
| 18 | https://probidcore.net/guide/estimate-brick-repair-cost-arizona | Brick repair | Arizona | 79 | NEEDS RE-SEED |
| 19 | https://probidcore.net/guide/estimate-stone-veneer-cost-georgia | Stone veneer | Georgia | 78 | NEEDS RE-SEED |
| 20 | https://probidcore.net/guide/estimate-concrete-repair-cost-arizona | Concrete repair | Arizona | 77 | NEEDS RE-SEED |

**How to request indexing manually:** In Google Search Console → URL Inspection → paste each URL → "Request Indexing." Do all 20 across two sessions (GSC throttles to ~10/day).

**"NEEDS RE-SEED" note:** The expanded service + state lists in `server/routes/admin/shared.ts` mean these slugs don't exist in the `seo_pages` DB table yet. After deploy, an admin must hit `POST /admin/seed-seo` to generate them (the seeder is idempotent and only inserts missing slugs).

---

## Part 2 — Directory Backlink Tracker

Submit ProBid AI to these 20 directories. Most are free; G2/Capterra/GetApp may require a vendor profile and verification call.

| # | Directory | URL | Submission Link | Status |
|---|-----------|-----|------------------|--------|
| 1  | Houzz | https://www.houzz.com | https://www.houzz.com/pro/signup | TODO |
| 2  | Angi (Angie's List) | https://www.angi.com | https://pro.angi.com/sign-up | TODO |
| 3  | BuildZoom | https://www.buildzoom.com | https://www.buildzoom.com/contractor-signup | TODO |
| 4  | ContractorNation | https://www.contractornation.com | https://www.contractornation.com/join | TODO |
| 5  | Thumbtack | https://www.thumbtack.com | https://www.thumbtack.com/pro | TODO |
| 6  | HomeAdvisor | https://www.homeadvisor.com | https://pro.homeadvisor.com/sign-up | TODO |
| 7  | Porch | https://porch.com | https://pro.porch.com/sign-up | TODO |
| 8  | Yelp for Business | https://biz.yelp.com | https://biz.yelp.com/signup | TODO |
| 9  | Better Business Bureau (BBB) | https://www.bbb.org | https://www.bbb.org/get-accredited | TODO |
| 10 | G2 | https://www.g2.com | https://sell.g2.com/get-listed | TODO |
| 11 | Capterra | https://www.capterra.com | https://www.capterra.com/vendors/sign-up | TODO |
| 12 | Software Advice | https://www.softwareadvice.com | https://www.softwareadvice.com/vendors/ | TODO |
| 13 | GetApp | https://www.getapp.com | https://www.getapp.com/vendors/sign-up | TODO |
| 14 | Clutch | https://clutch.co | https://clutch.co/get-listed | TODO |
| 15 | FinancesOnline | https://financesonline.com | https://financesonline.com/submit-product/ | TODO |
| 16 | SaaSHub | https://www.saashub.com | https://www.saashub.com/submit | TODO |
| 17 | AlternativeTo | https://alternativeto.net | https://alternativeto.net/about/submit-app/ | TODO |
| 18 | Product Hunt | https://www.producthunt.com | https://www.producthunt.com/posts/new | TODO |
| 19 | BetaList | https://betalist.com | https://betalist.com/submit | TODO |
| 20 | Indie Hackers | https://www.indiehackers.com | https://www.indiehackers.com/products | TODO |

**Submission notes:**
- Use the same NAP (name/address/phone) and the canonical URL `https://probidcore.net` on every listing — citation consistency is a local-SEO ranking factor.
- For directory-specific descriptions, write 2 variants (50-word and 150-word) so listings aren't 100% duplicate copy.
- Track responses in a separate spreadsheet column for "Approved date" and "Link type (dofollow/nofollow)."
