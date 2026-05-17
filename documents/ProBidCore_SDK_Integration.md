# ProBidCore JavaScript SDK (`integrate.js`)

A tiny embed script that lets external apps and partner websites send
structured estimates into ProBidCore without writing raw HTTP code.

## Install

```html
<script src="https://probidcore.net/integrate.js"></script>
```

The script attaches a single global: `window.ProBidCore`. The script asset
itself is served with `Access-Control-Allow-Origin: *` and a permissive
`Cross-Origin-Resource-Policy: cross-origin` header, so a `<script src>` tag
will load successfully from any partner domain.

## Send an estimate

```html
<script>
  ProBidCore.sendEstimate({
    name: "Smith kitchen remodel",
    source: "my-partner-site",       // optional, identifies the calling app
    market: "residential",           // optional
    details: "Pulled from CRM #482", // optional, free-form
    lineItems: [
      { description: "Cabinet install",  quantity: 12, unitCost: 220, uom: "EA" },
      { description: "Tile backsplash",  quantity: 35, unitCost: 14,  uom: "SF" },
      { description: "Disposal fee",     quantity: 1,  unitCost: 150, uom: "EA" },
    ],
  })
    .then(function (result) {
      console.log("Created estimate", result.estimateId, "subtotal", result.totals.subtotal);
    })
    .catch(function (err) {
      console.error("Send failed:", err.message);
    });
</script>
```

### Arguments

| Field        | Type                | Required | Notes |
|--------------|---------------------|----------|-------|
| `name`        | `string`     | yes      | Project / job name shown in ProBidCore. |
| `lineItems`   | `LineItem[]` | yes      | 1–500 entries. Each requires `description`, `quantity` (positive number), and `unitCost` (≥ 0). Optional: `uom`, `costType`. |
| `source`      | `string`     | no       | Identifier for your app (e.g. `"hubspot-widget"`). |
| `jobType`     | `string`     | no       | Job category label. |
| `market`      | `string`     | no       | Optional market label. |
| `details`     | `string`     | no       | Free-form notes. |
| `clientName`  | `string`     | no       | Customer name (also creates a CRM lead). |
| `clientEmail` | `string`     | no       | Customer email. |
| `clientPhone` | `string`     | no       | Customer phone. |

### Response

```ts
{
  estimateId: string;   // UUID of the new estimate
  name: string;
  source: string | null;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitCost: number;
    uom: string | null;
    costType: string | null;
    lineTotal: number;
    sortOrder: number;
  }>;
  totals: { subtotal: number; /* ... */ };
  createdAt: number;    // ms epoch
}
```

## Authentication & cross-origin embedding

The SDK uses the user's **ProBidCore session**. The visitor must already
be signed in to ProBidCore (probidcore.net) in the same browser. Login
issues two cookies:

| Cookie                | `SameSite` | Used by                                                                 |
|-----------------------|------------|-------------------------------------------------------------------------|
| `probid_session`      | `Lax`      | Every first-party page on `probidcore.net` (the dashboard, billing, etc.) |
| `probid_sdk_session`  | `None`     | **Only** the SDK endpoints (`/api/csrf`, `/api/me`, `/api/estimates/send`) |

Splitting the auth into two cookies is deliberate: the main session cookie
stays `Lax`, which preserves the browser's built-in CSRF protection for
all the other session-protected routes in the app (billing, team admin,
etc.). The dedicated SDK cookie is `SameSite=None; Secure; HttpOnly`, is
HMAC-signed with `SESSION_SECRET`, and is only ever consumed by the small,
explicitly-allow-listed SDK endpoint set.

The SDK then transparently handles two extra steps for you:

1. Fetches a CSRF token from `/api/csrf` (derived statelessly from the
   SDK cookie's signature, single round trip, cached in memory for the
   page lifetime).
2. Sends the token in the `X-CSRF-Token` header on every `sendEstimate`
   call so the server knows the request is coming from a page that the
   user — and not just an attacker who happens to ride the cookie — is
   actively interacting with.

For partner sites on a different domain than `probidcore.net` the browser
will only allow this when **all** of the following are true:

- The partner's origin is on the ProBidCore SDK allowlist, configured via
  the server-side env var `SDK_ALLOWED_ORIGINS` (see below). Without an
  entry on the allowlist the browser blocks the response with a CORS
  error and `sendEstimate` rejects with a "Request blocked" message.
- The user has a current ProBidCore session in the same browser
  (third-party cookie restrictions in Safari / Brave / Firefox strict
  mode may block cross-site cookies entirely; in those cases the user
  must visit `probidcore.net` first or the partner should switch to the
  forthcoming API-key auth path).

### Origin allowlist (admin UI + `SDK_ALLOWED_ORIGINS`)

The set of origins that are allowed to call the SDK endpoints
(`/api/csrf`, `/api/me`, `/api/estimates/send`) with credentials is the
union of two sources:

1. **Admin UI** — `Admin → Partner SDK` tab on the ops dashboard. Add or
   revoke partner origins at runtime. The CORS layer caches the merged
   allowlist for ~30 seconds and any admin mutation immediately invalidates
   that cache, so changes take effect on the next request cycle (the very
   first request after a mutation may briefly fall back to env-only while
   the background refresh from the database completes — typically a few
   milliseconds — and the second request onward sees the new state).
   Every add/revoke is recorded in the `audit_logs` table under the
   `sdk_allowlist:add`, `sdk_allowlist:resurrect`, and
   `sdk_allowlist:revoke` actions. Resurrecting a previously revoked
   origin preserves the original `created_at` / `created_by` so the
   row's first-added timestamp stays accurate; reactivation history
   lives in the audit log.
2. **`SDK_ALLOWED_ORIGINS` env var** — comma-separated bootstrap list.
   Useful for local dev and so the very first deploy boots with at least
   one partner already allowed before the admin UI is reachable. Env
   entries cannot be revoked from the UI; they appear there as
   read-only "bootstrap entries."

Examples for the env var:

```bash
# Single partner
SDK_ALLOWED_ORIGINS=https://partner.example.com

# Multiple partners + a wildcard subdomain
SDK_ALLOWED_ORIGINS=https://partner.example.com,https://app.contractorsoft.io,*.dispatch-pro.com
```

Notes (apply identically to both sources):

- Use the full origin, including scheme. `https://partner.com` is **not**
  the same as `http://partner.com`. Exact entries are normalised to
  `${scheme}//${host}` before storage, so trailing paths or query strings
  are stripped.
- Wildcards are **strict subdomain-only** and must start with `*.`
  (e.g. `*.contractorsoft.io`). The matcher enforces a real dot boundary,
  so `*.contractorsoft.io` matches `app.contractorsoft.io` but **not**
  the apex `contractorsoft.io` and **not** look-alike hosts like
  `evilcontractorsoft.io`. To allow the apex domain too, add it
  separately (e.g. `https://contractorsoft.io` plus `*.contractorsoft.io`).
- Wildcards too broad to be safe — bare `*`, `*.com`, `*.` — are rejected
  by both the admin UI (HTTP 400 with the reason) and at env-load time
  (warning + ignored). Wildcard + credentialed CORS would let any site
  read the user's data, and that combination is never enabled.
- Origins not on the list get no `Access-Control-Allow-Origin` header
  back, so the browser blocks the response. A clear 403 is returned for
  preflights.
- Revoking from the UI is a soft-delete: the row stays in
  `sdk_allowed_origins` with `revoked_at` set, so audit history is
  preserved. Re-adding a previously revoked origin "resurrects" the same
  row.

### Why this is safe

The combination of the allowlist, the existing CSRF token, and the
`X-ProBidCore-SDK` header gives us defence in depth:

| Threat | Mitigation |
|---|---|
| Random site triggers `sendEstimate` while user is signed in | Browser blocks the response (no `Allow-Origin` header), and the cross-site page also can't read `/api/csrf` to obtain a token, so the POST is rejected with HTTP 403. |
| Allowlisted partner is XSS'd | Same blast radius as the partner having a real ProBidCore-issued API key. The CSRF token still requires the page to do an explicit fetch — purely passive `<img>` / `<form>` cross-site abuse is blocked. |
| Cookies leak via TLS downgrade | `Secure` flag forces HTTPS-only transport; HSTS is preloaded. |

## Configure a custom base URL

By default the SDK auto-detects ProBidCore's origin from its own
`<script src="...">` URL — so a partner page that includes
`<script src="https://probidcore.net/integrate.js">` will route every
SDK call to `https://probidcore.net` automatically, with no extra
configuration. You only need `configure()` to override that, e.g. for
local development or if you proxy the script through your own CDN:

```js
ProBidCore.configure({ baseUrl: "http://localhost:5000" });
```

## Errors

`sendEstimate` rejects with an `Error` whose `.message` is human-readable.
Common cases:

- `Not signed in to ProBidCore.` — no active session cookie (HTTP 401).
- `Request blocked. The partner origin may not be on the ProBidCore SDK allowlist.`
  — the partner domain is missing from `SDK_ALLOWED_ORIGINS` (HTTP 403,
  also surfaces as `err.status === 403`). Ask ProBidCore support to add
  the origin.
- `Missing or invalid CSRF token.` — the `/api/csrf` warm-up did not run
  (e.g. the user signed out mid-session). The SDK clears the cached
  token automatically so a retry will re-fetch.
- `Free estimate limit reached. Upgrade to Pro for unlimited estimates.` —
  the user has hit their plan quota (HTTP 402, `err.upgrade === true`).
- Validation messages (e.g. `name is required`) — invalid payload (HTTP 400).
- `Could not reach ProBidCore (… ): network or CORS error.` — the browser
  rejected the request before it reached ProBidCore (DNS/network failure
  or the partner origin isn't on the SDK allowlist). The SDK normalises
  the otherwise-opaque `TypeError: Failed to fetch` browsers raise, so
  partner devs always get this deterministic message instead.

## Rollout note for existing users

The cross-origin SDK is authenticated by a dedicated cookie
(`probid_sdk_session`) issued at login alongside the normal session
cookie. Users who were already signed in to probidcore.net before this
change rolled out will not have that cookie yet, so the first SDK call
from a partner site will fail with HTTP 401 ("Not signed in to
ProBidCore."). Asking those users to sign in once on probidcore.net
issues the new cookie and unblocks the SDK on every allowlisted partner
domain. New sign-ups and anyone who logs in after the rollout get the
cookie automatically — no further action required.
