/*!
 * ProBidCore JavaScript SDK / integrate.js
 *
 * Embed in any web page to send structured estimates programmatically:
 *
 *   <script src="https://probidcore.net/integrate.js"></script>
 *   <script>
 *     await ProBidCore.sendEstimate({
 *       name: "Smith kitchen remodel",
 *       source: "my-partner-site",          // optional, identifies caller
 *       lineItems: [
 *         { description: "Cabinet install", quantity: 12, unitCost: 220, uom: "EA" },
 *         { description: "Tile backsplash",  quantity: 35, unitCost: 14,  uom: "SF" },
 *       ],
 *     });
 *   </script>
 *
 * Authentication:
 *   The SDK relies on the user's existing ProBidCore session cookie. Calls
 *   are made with `credentials: "include"` so cookies ride along on
 *   cross-origin requests. The user must already be signed in to ProBidCore
 *   in the same browser, AND the partner site's origin must be on the
 *   ProBidCore SDK allowlist (server env var `SDK_ALLOWED_ORIGINS`).
 *
 *   Server-issued API keys are tracked separately and will let server-to-
 *   server callers skip the cookie / origin requirement.
 */
(function (global) {
  "use strict";

  // Derive the API origin from the <script src="..."> URL the SDK was
  // loaded from. That way a partner page that simply does
  //   <script src="https://probidcore.net/integrate.js"></script>
  // gets all SDK requests routed to https://probidcore.net automatically,
  // not to the partner's own origin (which is what relative URLs would do).
  // Order of preference: document.currentScript (most reliable, set during
  // script execution) → <script[src*="integrate.js"]> lookup (fallback for
  // edge cases where currentScript is null, e.g. some module loaders) →
  // empty string (last resort, callers can override via configure()).
  function detectScriptOrigin() {
    try {
      var doc = global && global.document;
      if (!doc) return "";
      var scriptEl = doc.currentScript;
      if (!scriptEl || !scriptEl.src) {
        var scripts = doc.getElementsByTagName("script");
        for (var i = scripts.length - 1; i >= 0; i--) {
          var s = scripts[i];
          if (s && s.src && /\/integrate\.js(\?|#|$)/.test(s.src)) {
            scriptEl = s;
            break;
          }
        }
      }
      if (!scriptEl || !scriptEl.src) return "";
      var u = new URL(scriptEl.src, doc.baseURI || undefined);
      return u.origin || "";
    } catch (_e) {
      return "";
    }
  }

  var DEFAULT_BASE_URL = detectScriptOrigin();
  var config = {
    baseUrl: DEFAULT_BASE_URL,
  };
  var csrfTokenCache = null;

  function joinUrl(base, path) {
    if (!base) return path;
    if (base.charAt(base.length - 1) === "/") base = base.slice(0, -1);
    if (path.charAt(0) !== "/") path = "/" + path;
    return base + path;
  }

  function configure(opts) {
    if (!opts || typeof opts !== "object") return;
    if (typeof opts.baseUrl === "string") config.baseUrl = opts.baseUrl;
  }

  // Browsers reject the fetch promise with an opaque TypeError on CORS or
  // network failure (no `res.status === 0` like the old XHR API). Wrap such
  // rejections so partner devs get a deterministic, actionable message.
  function normalizeNetworkError(err, context) {
    if (err && (err.status || err.__pbcNormalized)) return err;
    var wrapped = new Error(
      "Could not reach ProBidCore (" +
        context +
        "): network or CORS error. Ask ProBidCore to add this origin to the SDK allowlist."
    );
    wrapped.__pbcNormalized = true;
    wrapped.cause = err;
    return wrapped;
  }

  function fetchCsrfToken() {
    if (csrfTokenCache) return Promise.resolve(csrfTokenCache);
    return fetch(joinUrl(config.baseUrl, "/api/csrf"), {
      credentials: "include",
    }).catch(function (err) {
      throw normalizeNetworkError(err, "/api/csrf");
    }).then(function (res) {
      if (res.status === 401) {
        var notSignedIn = new Error(
          "Not signed in to ProBidCore. Open probidcore.net and log in first.",
        );
        notSignedIn.status = 401;
        throw notSignedIn;
      }
      if (!res.ok) {
        throw new Error("Could not fetch CSRF token (status " + res.status + ")");
      }
      return res.json();
    }).then(function (json) {
      csrfTokenCache = (json && json.data && json.data.token) || "";
      return csrfTokenCache;
    });
  }

  function clearCsrfToken() {
    csrfTokenCache = null;
  }

  function validateLineItems(lineItems) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      throw new Error("lineItems must be a non-empty array");
    }
    for (var i = 0; i < lineItems.length; i++) {
      var li = lineItems[i];
      if (!li || typeof li !== "object") {
        throw new Error("lineItems[" + i + "] must be an object");
      }
      if (typeof li.description !== "string" || li.description.trim() === "") {
        throw new Error("lineItems[" + i + "].description is required");
      }
      if (typeof li.quantity !== "number" || !isFinite(li.quantity) || li.quantity <= 0) {
        throw new Error("lineItems[" + i + "].quantity must be a positive number");
      }
      if (typeof li.unitCost !== "number" || !isFinite(li.unitCost) || li.unitCost < 0) {
        throw new Error("lineItems[" + i + "].unitCost must be a non-negative number");
      }
    }
  }

  function sendEstimate(payload) {
    return Promise.resolve().then(function () {
      if (!payload || typeof payload !== "object") {
        throw new Error("sendEstimate requires an object: { name, lineItems, source? }");
      }
      if (typeof payload.name !== "string" || payload.name.trim() === "") {
        throw new Error("name is required");
      }
      validateLineItems(payload.lineItems);

      var body = {
        name: payload.name,
        lineItems: payload.lineItems.map(function (li) {
          return {
            description: li.description,
            quantity: li.quantity,
            unitCost: li.unitCost,
            uom: li.uom,
            costType: li.costType,
          };
        }),
      };
      if (payload.source != null) body.source = payload.source;
      if (payload.jobType != null) body.jobType = payload.jobType;
      if (payload.market != null) body.market = payload.market;
      if (payload.details != null) body.details = payload.details;
      if (payload.clientName != null) body.clientName = payload.clientName;
      if (payload.clientEmail != null) body.clientEmail = payload.clientEmail;
      if (payload.clientPhone != null) body.clientPhone = payload.clientPhone;

      return fetchCsrfToken().then(function (token) {
        return fetch(joinUrl(config.baseUrl, "/api/estimates/send"), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token || "",
            "X-ProBidCore-SDK": "integrate.js/1.1",
          },
          body: JSON.stringify(body),
        }).catch(function (err) {
          throw normalizeNetworkError(err, "/api/estimates/send");
        });
      }).then(function (res) {
        return res.json().catch(function () {
          throw new Error("ProBidCore returned an invalid response (status " + res.status + ")");
        }).then(function (json) {
          if (res.status === 401) {
            throw new Error("Not signed in to ProBidCore. Open probidcore.net and log in first.");
          }
          if (res.status === 403) {
            var forbidden = (json && json.error) ||
              "Request blocked. The partner origin may not be on the ProBidCore SDK allowlist.";
            var fErr = new Error(forbidden);
            fErr.status = 403;
            // CSRF tokens may rotate after sign-in; clear our cache so the
            // next call re-fetches before retrying.
            clearCsrfToken();
            throw fErr;
          }
          if (!res.ok || !json || json.success === false) {
            var msg = (json && json.error) || "Request failed (" + res.status + ")";
            var err = new Error(msg);
            err.status = res.status;
            err.upgrade = json && json.upgrade;
            throw err;
          }
          return json.data;
        });
      });
    });
  }

  global.ProBidCore = {
    version: "1.1.0",
    configure: configure,
    sendEstimate: sendEstimate,
    _clearCsrfToken: clearCsrfToken,
  };
})(typeof window !== "undefined" ? window : this);
