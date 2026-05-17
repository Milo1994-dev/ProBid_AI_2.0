---
classification: CONFIDENTIAL — TRADE SECRET
owner: Jesse Kirchner
created: 2026-05-11
last_reviewed: 2026-05-11
revision: 1
intended_repo: probid-core (probidcore.net)
---

# CONFIDENTIAL — TRADE SECRET

# ProBid AI — Estimating Logic

> **Notice.** This document and the information it describes are
> confidential trade secrets of Jesse Kirchner under the Defend Trade
> Secrets Act (18 U.S.C. § 1836) and applicable state law. Disclosure,
> reproduction, or use outside the express written authorization of the
> owner is prohibited. Anyone with access to this document is bound by
> the confidentiality obligations of their NDA, employment agreement, or
> contractor agreement.

---

## 1. What this document covers

This document describes the proprietary logic the ProBid AI product
(`probidcore.net`) uses to convert a contractor-supplied job description
(and optional job-site photos) into a written construction estimate, and
to subsequently extract that estimate into structured line items
(description, quantity, unit cost, unit of measure) suitable for handoff
to ProBidCore (`probidcore.com`) for editing and Procore sync.

It also covers the secondary "shadow estimator" path used to benchmark
ProBid AI's estimating accuracy against closed Procore projects on the
Business tier.

It does **not** cover:

- The handoff format between ProBid AI and ProBidCore — publicly
  documented in `PROBID_AI_INTEGRATION.md` in the ProBidCore repo.
- The downstream Procore sync logic in ProBidCore.
- General industry knowledge about construction estimating practices,
  WBS codes, or unit-cost ranges available in published cost guides
  such as RSMeans.

## 2. The secret — high-level

ProBid AI's value is the combination of three things, none of which is
public:

1. **A specific system prompt** (§4.2) that instructs `gpt-4o` to act
   as an estimator with 25+ years of experience, enforces a fixed
   six-section output format (JOB ANALYSIS / LABOR / MATERIALS /
   ADDITIONAL COSTS / TOTAL / RECOMMENDATIONS), and pins the model to
   2024–2025 market rates for the user's region. The prompt is
   parameterized by job type, region, and ZIP and produces consistent,
   contractor-grade output without few-shot examples.
2. **A proprietary multiplier table** (§4.3 — `tradePresets`) that
   layers on top of the LLM's base estimate. For four trade categories
   (masonry, roofing, concrete, remodeling) it injects a labor-rate
   multiplier (1.10×–1.25×), a default profit margin (18 %–25 %), and
   a curated allowance list directly into the system prompt — biasing
   the model toward realistic crew costs without retraining.
3. **A two-stage pipeline** (free-form text → structured JSON via a
   second deterministic `temperature: 0` call) plus post-processing
   sanity rules (§4.4) that filter hallucinated mega-line-items,
   normalize units to standard construction abbreviations, and bound
   description length. The two-stage approach keeps the contractor-
   facing estimate human-readable while still emitting clean line-item
   data downstream.

## 3. Inputs

### 3.1 HTTP entry point

`POST /api/estimates` (multipart/form-data, session-cookie auth):

| Field | Type | Required | Notes |
|---|---|---|---|
| `jobType` | string | yes | Free-text or one of: `tuckpointing`, `chimney_rebuild`, `retaining_wall`, `concrete_flatwork`, `roof_repair`, `general` |
| `market` | string | yes | One of `midwest`, `south`, `west`, `northeast` |
| `details` | string | no | Free-text scope description |
| `zipCode` | string | no | Injected into the system prompt for regional pricing |
| `clientName` / `clientEmail` / `clientPhone` | string | no | Creates a `Lead` row when present |
| `tradePreset` | string | no | One of `masonry`, `roofing`, `concrete`, `remodeling` |
| `photos` | file[] | no | Up to 5 files; HEIC/HEIF auto-converted to JPEG@90 % via `sharp`; triggers vision path |

### 3.2 Hidden defaults

- `details` omitted → user prompt substitutes `"No specific details
  provided - please provide a general estimate for a typical job of
  this type."`
- `zipCode` omitted → ZIP parenthetical removed from the system prompt
- `tradePreset` omitted → no preset block injected (vanilla prompt)
- `market` is enforced client-side; no server-side default

### 3.3 Paywall gating (pre-LLM)

`enforcePaywall(uid)` blocks the LLM call when a free-tier user has
exceeded `FREE_ESTIMATES_LIFETIME = 2`. Returns HTTP 402 — no API spend
on over-quota requests.

## 4. The algorithm — step by step

### 4.1 Pre-processing

1. Zod schema validation on the multipart body (rejects on type or
   missing required fields → HTTP 400).
2. Paywall check (above).
3. Photo handling (vision path only):
   - Detect HEIC/HEIF by MIME.
   - Re-encode to JPEG @ quality 90 via `sharp`.
   - Base64-encode and wrap as OpenAI `image_url` content block with
     `detail: "high"`.
4. Trade-preset lookup against the `tradePresets` table. Unknown keys
   are dropped silently (no preset block injected).

### 4.2 Primary LLM invocation — `generateAIEstimate()`

**Model config:**

```
model:           gpt-4o
temperature:     0.7
max_tokens:      2000
top_p:           default
response_format: free-form text
retry:           none — empty response throws
```

**System prompt (verbatim, with `{...}` injection points):**

```
You are an expert construction estimator with 25+ years of experience
in {jobLabel}.
You provide accurate, professional contractor estimates based on current
{marketLabel} market rates (ZIP: {zipCode}).

{tradePresetContext}

When analyzing a job:
1. Consider labor hours, crew size, and skill level required
2. Account for materials, equipment rental, and disposal
3. Include overhead (insurance, permits, admin) and profit margin
4. Factor in site conditions, access difficulty, and weather considerations
5. Provide a realistic bid range (low to high)

Format your estimate professionally with clear sections:
- JOB ANALYSIS (what you observe and understand about the scope)
- LABOR ESTIMATE (hours, crew, rates)
- MATERIALS (itemized with costs)
- ADDITIONAL COSTS (permits, equipment, disposal)
- TOTAL ESTIMATE (with low to high range)
- RECOMMENDATIONS (tips for the contractor)

Be specific with dollar amounts. Use current 2024-2025 market rates for
the {marketLabel} region.
IMPORTANT: Add a disclaimer at the very beginning of the estimate stating:
"Disclaimer: This estimate is a starting point and not a final quote.
Actual costs may vary based on detailed on-site assessment and specific
material choices."
```

**User prompt — text-only path (verbatim):**

```
Please provide a detailed contractor estimate for the following job:

Job Type: {jobLabel}
Region: {marketLabel}
Job Details: {details OR "No specific details provided - please provide a general estimate for a typical job of this type."}

Provide a comprehensive contractor estimate with realistic pricing.
```

**User prompt — vision path (verbatim):**

```
Please analyze {N} job site photo(s) and provide a detailed estimate.

Job Type: {jobLabel}
Region: {marketLabel}
Additional Details: {details}

Based on what you see in the photo(s), provide a comprehensive contractor
estimate.
```

**Few-shot examples:** none. The output format is enforced entirely by
the system prompt.

### 4.3 Reference data — proprietary multiplier table

All reference data is embedded as TypeScript constants in
`server/lib/ai.ts`. There are **no external data files, no database
lookups, and no vector indexes** consulted during estimate generation.
This is a deliberate design choice — the moat lives in the prompt and
the multiplier table, both of which are hot-loaded with the application.

**Job-type label table** (raw key → human label injected into prompt):

| Key | Label |
|---|---|
| `tuckpointing` | Tuckpointing / Mortar Repair |
| `chimney_rebuild` | Chimney Rebuild |
| `retaining_wall` | Retaining Wall Construction |
| `concrete_flatwork` | Concrete Flatwork |
| `roof_repair` | Roof Repair |
| `general` | General Construction |
| *(other)* | raw user-submitted string |

**Market label table:**

| Key | Label |
|---|---|
| `midwest` | Midwest US |
| `south` | Southern US |
| `west` | Western US |
| `northeast` | Northeastern US |
| *(other)* | US |

**Trade-preset multiplier table — proprietary:**

| Preset | Labor multiplier | Default margin | Auto-included allowances |
|---|---|---|---|
| `masonry` | 1.15× | 20 % | demo, cleanup, mortar, brick/stone allowance |
| `roofing` | 1.10× | 18 % | tear-off, disposal, underlayment |
| `concrete` | 1.20× | 22 % | forms, rebar, finish work |
| `remodeling` | 1.25× | 25 % | uncertainty buffer |

When a preset is active, the following block is injected into the
system prompt at `{tradePresetContext}`:

```
TRADE PRESET APPLIED: {PRESET_NAME}
- Apply a labor rate multiplier of {laborMultiplier}x to base labor rates
- Use a default profit margin of {defaultMargin}%
- Automatically include allowances for: {includes}
```

**Provenance of multiplier values.** The labor multipliers and default
margins were calibrated by the founder based on direct field experience
with the four trades and were not copied from any published cost guide,
competitor product, or public dataset.

### 4.4 Structured extraction — `extractStructuredLineItems()`

Lazy second LLM call, fired on `GET /api/estimates/:id/line-items`.
Converts the free-form §4.2 output into clean line-item JSON.

**Model config:**

```
model:           gpt-4o
temperature:     0          (deterministic)
max_tokens:      2000
response_format: { type: "json_object" }
```

**System prompt (verbatim):**

```
You are a construction estimate parser. Extract every individual cost
line item from the estimate text into a structured JSON array.

For each line item, extract:
- "description": the item name/description (e.g. "Portland cement Type S
  mortar", "Scaffolding rental")
- "quantity": the numeric quantity (default to 1 if not specified)
- "unitCost": the cost per unit in dollars (if only a total is given and
  quantity > 1, divide to get unit cost)
- "uom": the unit of measure (e.g. "SF", "LF", "EA", "HR", "BAG", "CY",
  "SQ", "GAL", "TON", "DAY"). Use standard construction abbreviations.

Rules:
- Do NOT include subtotals, totals, grand totals, or summary lines
- Do NOT include section headers
- DO include labor lines, material lines, equipment lines, permit fees,
  disposal fees, etc.
- If a line shows a range (e.g. "$500-$800"), use the midpoint
- Return valid JSON only — an array of objects
```

**User message:** the verbatim free-form output of `generateAIEstimate()`.

### 4.5 Post-processing rules

Applied to the parsed JSON before returning to the client:

1. **Root-shape fallback** — accepts `Array.isArray(parsed)` or
   `parsed.lineItems`, `parsed.items`, or `parsed.line_items`.
2. **Validation filter** — drops any item without a non-empty
   `description` string, or whose `unitCost` is non-finite, ≤ 0, or
   ≥ 10,000,000 (sanity cap on hallucinated mega-line-items).
3. **Normalization:**
   - `description` → `trim()` then `slice(0, 200)`
   - `quantity` → finite & > 0 ? `round(value × 100) / 100` : `1`
   - `unitCost` → `round(value × 100) / 100`
   - `uom` → uppercase + trim + `slice(0, 10)`, default `"EA"`

### 4.6 Shadow estimator — `generateShadowEstimate()`

Business-tier-only secondary path (`server/shadow-estimator.ts`) that
generates a "what ProBid AI would have estimated" benchmark for a
closed Procore project, used internally to track estimation accuracy
against actuals.

**Model config:** `gpt-4o`, `temperature: 0.3`, `max_tokens: 500`.

**System prompt:**
```
You are an expert construction cost estimator with deep knowledge of
material costs, labor rates, and regional pricing variations. Always
respond with valid JSON only.
```

**User prompt:** parameterized by the customer's own Procore project
metadata (name, trade, city/state/ZIP, project value, cost-code budget
breakdown). Note: the shadow estimator does **not** use a shared
ProBid reference set — it is enriched only by the customer's own
Procore data pulled via OAuth.

**Output:** `{ low, base, high, details, confidence }` extracted via
`/\{[\s\S]*\}/` regex before `JSON.parse`.

## 5. Outputs

### 5.1 `POST /api/estimates`

```jsonc
{
  "success": true,
  "data": {
    "estimateId": "<uuid>",
    "text": "<full free-form LLM output, prefixed with '📷 AI PHOTO ANALYSIS ESTIMATE…' or '🤖 AI ESTIMATE…'>",
    "tier": "paid" | "free",
    "estimatesRemaining": "<number | null>"
  }
}
```

### 5.2 `GET /api/estimates/:id/line-items`

```jsonc
{
  "success": true,
  "data": {
    "lineItems": [
      {
        "description": "string (≤ 200 chars)",
        "quantity":    "number (2 dp)",
        "unitCost":    "number (2 dp, USD)",
        "uom":         "string (≤ 10 chars, uppercase)"
      }
    ]
  }
}
```

### 5.3 `GET /api/estimates/:id`

Full estimate detail including `id`, `jobType`, `market`, `details`,
`estimateText`, `name`, `source`, client `{Name, Email, Phone}`,
`createdAt`, `wonLostStatus`, `wonLostUpdatedAt`, full `lineItems`
array (with `id`, `sortOrder`, `costType`, `lineTotal`), and totals
`{ subtotal, total, byCostType, itemCount }`.

### 5.4 Comparison vs the public ProBidCore handoff schema

The public schema in `PROBID_AI_INTEGRATION.md` requires:

```
{ name, lineItems: [{ description, quantity, unitCost, uom, wbsCode, costType }] }
```

ProBid AI's structured output **omits `wbsCode`** — the field is not
auto-assigned or stored. Partners must add it themselves before
handing off to Procore. Closing this gap is on the product roadmap as
a future WBS-code dictionary; until then the omission is intentional.

ProBid AI also emits internal-only extras (`lineTotal`,
`totals.byCostType`, `id`, `sortOrder`) that are stripped before
handoff.

## 6. What makes this non-obvious / not readily ascertainable

- **The system prompt is iterated and specific.** A competitor cannot
  reproduce the exact six-section output structure, the disclaimer
  injection, the 2024–2025 rate anchoring, or the multi-clause
  analytical instructions just by reading OpenAI's documentation. The
  prompt is the result of substantial iteration (see §9.2).
- **The trade-preset multiplier table (§4.3) is proprietary.**
  Multiplier values like `masonry: 1.15×, 20 %` and the specific
  allowance lists are not published anywhere by ProBid AI and were
  derived from the founder's direct field experience with the four
  trades.
- **The two-stage extraction pipeline** — free-form contractor estimate
  followed by deterministic `temperature: 0` JSON extraction with a
  separate parser-role prompt — is a non-obvious architectural choice;
  the more obvious path (force structured output on the first call)
  produces measurably worse free-form text for contractors to read.
- **The post-processing sanity rules** (10 M unit-cost cap, uppercase
  UOM normalization, 200-char description truncation, four alternative
  root-shape keys) embody specific failure modes observed in
  production that a competitor would have to rediscover.
- **The output schema was reverse-engineered against ProBidCore's**
  ingest format and the downstream Procore budget endpoint
  requirements through extensive testing.

## 7. Reasonable measures taken to keep this secret

- **7.1 Repo visibility.** The `probid-core` repository is private on
  Replit, confirmed on 2026-05-11.
- **7.2 2FA enforcement.** 2FA is enabled on the founder's Replit
  account, the OpenAI dashboard, the Stripe dashboard, the Resend
  dashboard, and any GitHub mirror. No other accounts have access to
  any of the above.
- **7.3 API key custody.** `AI_INTEGRATIONS_OPENAI_API_KEY` is stored
  exclusively in Replit Secrets. No copies exist in `.env` files,
  password managers, screenshots, Slack DMs, emails, or shared
  documents.
- **7.4 Disclosure history.** The founder is the only person who has
  ever seen the verbatim system prompt or the trade-preset multiplier
  table. No third parties — contractors, employees, advisors,
  investors, customers, or partners — have been shown either.
- **7.5 Marketing leakage.** The public marketing site
  (`probidcore.net`) describes ProBid AI's capabilities and supported
  trades but does not publish the system prompt, the model name
  (`gpt-4o`), the multiplier values, or the full job-type taxonomy in
  reconstructible form.
- **7.6 Public speaking.** The founder has not appeared on any
  podcast, conference panel, YouTube video, or recorded interview
  describing how the estimating algorithm works internally.

## 8. People with current access

| Name | Role | Access medium | Access since | NDA signed? | Still has access? |
|---|---|---|---|---|---|
| Jesse Kirchner | Founder & sole owner | Repo (full read/write), prompts, multiplier table | 2026-01 | N/A (owner) | Yes |

## 9. Provenance / origin

- **9.1 First-version date.** The first working version of the prompt
  and multiplier table was written by the founder in January 2026
  (commit `0d36832` on 2026-01-14, which introduced the `tradePresets`
  multiplier table; the system prompt itself first appeared earlier
  in commit `869e430` on 2025-12-20).
- **9.2 Iteration count.** The current version is the result of
  approximately 5–10 substantive revisions to the system prompt and
  the multiplier table between January 2026 and the date of this
  record, weighted toward the multiplier table rather than the prompt
  text itself (per `git log -S` analysis on `server/lib/ai.ts`).
- **9.3 Originality.** All portions of the algorithm — the system
  prompt, the trade-preset multiplier table, the two-stage extraction
  pipeline, and the post-processing rules — are original work by the
  founder. No portion is copied from any paper, blog post, open-source
  project, competitor product, or third-party cost guide such as
  RSMeans.
- **9.4 Prior disclosures.** None. The algorithm has not been
  described in detail on any public website, blog post, docs page,
  podcast, conference talk, interview, pitch deck, investor memo, or
  press article.
- **9.5 Marketing-page leakage.** The `probidcore.net` marketing
  pages describe the four supported trades by name (masonry, roofing,
  concrete, remodeling) and the four US regions, but do not publish
  the multiplier values, the prompt structure, the model identity,
  or the post-processing rules. The trade and region taxonomies
  themselves are common industry categorizations and are not claimed
  as trade secrets.

## 10. Revision history

| Revision | Date | Author | Change |
|---|---|---|---|
| 1 | 2026-05-11 | Jesse Kirchner | Initial filled-in record. Blocks 1–6 derived from `server/lib/ai.ts`, `server/routes/estimates.ts`, `server/shadow-estimator.ts`. Blocks 7–9 founder-supplied. First-version date and iteration count derived from `git log` analysis on `server/lib/ai.ts`. |

---

**End of confidential document.**
