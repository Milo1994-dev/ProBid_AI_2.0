# ProBid AI Accuracy Methodology

## Overview

This document describes how ProBid AI measures and reports its construction estimating accuracy on the public [Accuracy page](https://probidcore.net/accuracy).

---

## Data Source

Accuracy benchmarks are computed from **real closed construction projects** provided by contractors who have connected their Procore accounts to ProBid and opted in to anonymous benchmarking.

- Data is read from Procore via read-only OAuth.
- Only **closed projects** with confirmed actual cost data are included.
- In-progress projects and projects without final actual costs are excluded.
- Participation is strictly **opt-in** (default off). Contractors control this in their Procore connection settings.

---

## The Shadow Estimate Process

For each eligible project, ProBid AI generates a **shadow estimate** — a blind estimate produced without knowing the actual project cost:

1. Project metadata available at bid time is extracted: trade type, location (city/state), project size, and scope.
2. ProBid AI generates a cost estimate (low / base / high range) using only this metadata.
3. The actual cost (`actual_cost_usd` from Procore budget views) is not provided to the AI during this step.
4. After the estimate is generated, it is compared to the actual cost.

This mirrors the real-world scenario where a contractor generates an estimate before knowing the final cost.

---

## Error Calculation

**Estimate Error %** = |ProBid Base Estimate − Actual Cost| ÷ Actual Cost × 100

This is an **absolute, non-directional** percentage error. It measures how far off the estimate was, regardless of whether the estimate was too high or too low.

**Confidence Band Check**: ProBid also generates a low–high range. A project "within band" means the actual cost fell inside that range. The `Within Confidence Band %` metric reports what fraction of projects landed within the predicted range.

---

## Statistical Methodology

We use **percentile-based reporting** rather than arithmetic means, because cost estimation errors tend to be right-skewed (a small number of very large errors can distort means):

| Metric | Description |
|--------|-------------|
| P50 (Median) | Half of estimates have error below this value |
| P80 | 80% of estimates have error below this value |
| Within Band % | Fraction of actuals falling inside the low–high range |

---

## Sample Size Thresholds

Any metric category with fewer than **5 projects** is hidden rather than shown. Small samples produce unreliable statistics, and we prefer to show nothing over showing misleading numbers.

This threshold applies to:
- The overall benchmark
- Per-trade breakdowns
- Per-project-size breakdowns

---

## Trade Breakdowns

Projects are grouped by their `trade` field as recorded in Procore (e.g., Roofing, Masonry, Concrete). Each trade group is computed independently. Trades with insufficient sample size are suppressed.

---

## Project Size Buckets

Projects are bucketed by actual cost:

| Bucket | Range |
|--------|-------|
| Small | Actual cost < $100,000 |
| Mid | Actual cost $100,000 – $1,000,000 |
| Large | Actual cost > $1,000,000 |

---

## Update Frequency

Benchmarks are recomputed daily (07:00 UTC) from all consenting connections. The last-updated timestamp is displayed on the accuracy page.

---

## Privacy

- No project names, company names, or individual line items are shown publicly.
- Only aggregate statistics are published.
- Individual project data remains private to the account owner.
- Opt-in consent can be revoked at any time from the Procore settings page.

---

## Limitations

- **Selection bias**: Contractors who opt in may not be representative of all construction projects.
- **Model versioning**: Shadow estimates use the model version active at generation time; older estimates may use earlier model versions.
- **Metadata quality**: Accuracy depends on the completeness of Procore project metadata at sync time.
- **Sample size**: Early data will have wider confidence intervals; numbers stabilize as the dataset grows.

---

## Questions

For questions about this methodology, contact us at [probidcore.net](https://probidcore.net).
