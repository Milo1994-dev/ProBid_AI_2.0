import express from "express";
import crypto from "crypto";
import {
  asyncHandler,
  generateAdminSessionToken,
  stripAdminKeyParam,
  verifyAdminSessionToken,
} from "../../lib/middleware.js";

// Constant-time string comparison; mirrors the helper used in shared.ts
// so we don't re-introduce a timing oracle on the login path.
function safeEq(a: unknown, b: string): boolean {
  if (typeof a !== "string" || !b) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "/admin";
  // Only allow same-origin paths under /admin to prevent open redirects.
  if (!raw.startsWith("/admin")) return "/admin";
  // Strip any smuggled `?key=` so the secret never lands in the form's hidden
  // next field, the post-login Location header, or browser history.
  return stripAdminKeyParam(raw);
}

const LOGIN_HTML = (next: string, error?: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin sign-in — ProBid AI</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0e1a; color:#e5e7eb;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; }
  form { background:#111827; padding:32px; border-radius:12px; min-width:320px;
         border:1px solid #1f2937; }
  h1 { margin:0 0 8px; font-size:18px; font-weight:700; }
  p.sub { margin:0 0 20px; color:#9ca3af; font-size:13px; }
  label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:0.06em;
          color:#9ca3af; margin-bottom:6px; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #374151;
          background:#0f172a; color:#e5e7eb; font-size:14px; }
  input:focus { outline:none; border-color:#3b82f6; }
  button { width:100%; margin-top:16px; padding:10px; border-radius:8px; border:none;
           background:#1d4ed8; color:#fff; font-weight:600; cursor:pointer; font-size:14px; }
  .err { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3);
         color:#f87171; padding:8px 12px; border-radius:8px; font-size:13px; margin-bottom:14px; }
</style>
</head>
<body>
<form method="POST" action="/admin/login" autocomplete="off">
  <h1>Admin sign-in</h1>
  <p class="sub">Paste your <code>ADMIN_KEY</code>. It is sent in the request body and
  never appears in the URL or server access logs.</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  <label for="key">Admin key</label>
  <input id="key" name="key" type="password" required autofocus />
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}" />
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;

export function registerAdminLoginRoutes(app: express.Application): void {
  app.get(
    "/admin/login",
    asyncHandler(async (req, res) => {
      const adminKey = process.env.ADMIN_KEY || "";
      if (!adminKey) return res.status(404).send("Not found");
      // Already signed in? Bounce to next.
      const adminSession = req.session?.adminSession;
      if (adminSession && verifyAdminSessionToken(adminSession)) {
        return res.redirect(safeNext(req.query.next));
      }
      res
        .status(200)
        .set("Cache-Control", "no-store")
        .send(LOGIN_HTML(safeNext(req.query.next)));
    }),
  );

  app.post(
    "/admin/login",
    express.urlencoded({ extended: false }),
    asyncHandler(async (req, res) => {
      const adminKey = process.env.ADMIN_KEY || "";
      if (!adminKey) return res.status(404).send("Not found");
      const submitted = req.body?.key;
      const next = safeNext(req.body?.next);
      if (!safeEq(submitted, adminKey)) {
        return res
          .status(401)
          .set("Cache-Control", "no-store")
          .send(LOGIN_HTML(next, "Invalid admin key."));
      }
      if (!req.session) {
        return res.status(500).send("Session unavailable");
      }
      req.session.adminSession = generateAdminSessionToken();
      res.redirect(303, next);
    }),
  );

  app.post(
    "/admin/logout",
    asyncHandler(async (req, res) => {
      if (req.session) {
        req.session.adminSession = undefined;
      }
      res.redirect(303, "/admin/login");
    }),
  );
}
