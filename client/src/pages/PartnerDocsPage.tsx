export default function PartnerDocsPage() {
  const base = typeof window !== "undefined" ? window.location.origin : "https://probidcore.net";

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white">
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="mb-10">
          <div className="text-green-400 text-sm font-medium mb-2 uppercase tracking-wider">Partner Program</div>
          <h1 className="text-4xl font-bold mb-4">Integration Guide</h1>
          <p className="text-gray-400 text-lg">
            Everything you need to embed ProBid AI estimating into your CRM, marketplace, or platform.
          </p>
        </div>

        <nav className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-8">
          <p className="text-gray-400 text-xs uppercase font-semibold tracking-wider mb-2">On this page</p>
          <ul className="space-y-1 text-sm">
            {[
              ["Getting a Partner Account", "#onboarding"],
              ["Finding Your API Key", "#api-key"],
              ["Integration Path 1: Server-to-Server", "#server-to-server"],
              ["Integration Path 2: In-Page SDK", "#sdk"],
              ["Rate Limits & Usage", "#rate-limits"],
              ["Error Handling", "#errors"],
            ].map(([label, href]) => (
              <li key={href}>
                <a href={href} className="text-gray-300 hover:text-green-400 transition-colors">{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <section id="onboarding" className="mb-10">
          <h2 className="text-2xl font-bold mb-4">Getting a Partner Account</h2>
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5 space-y-3 text-gray-300">
            <p>
              Partner accounts are provisioned by the ProBid team. To get started:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-gray-400">
              <li>Create a regular ProBid account at <a href="/signup" className="text-green-400 hover:underline">probidcore.net/signup</a></li>
              <li>Contact the ProBid team with your company name and integration use case</li>
              <li>Once approved, your account will be upgraded to partner status</li>
              <li>Access the <a href="/app/partner" className="text-green-400 hover:underline">Partner Portal</a> from your dashboard</li>
            </ol>
            <div className="mt-3 bg-blue-900/20 border border-blue-700/50 rounded p-3 text-blue-300 text-sm">
              v1 is admin-provisioned. A self-serve application flow is planned for a future release.
            </div>
          </div>
        </section>

        <section id="api-key" className="mb-10">
          <h2 className="text-2xl font-bold mb-4">Finding Your API Key</h2>
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5 space-y-3 text-gray-300">
            <p>
              After your account is activated as a partner:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-gray-400">
              <li>Log in and navigate to the <a href="/app/partner" className="text-green-400 hover:underline">Partner Portal</a></li>
              <li>Click the <strong>API Keys</strong> tab</li>
              <li>Click <strong>+ New Key</strong>, give it a label, select the scopes you need, and click Create</li>
              <li>Copy the key immediately — it is shown only once</li>
            </ol>
            <p className="text-gray-400 text-sm">
              Keys start with <code className="text-green-400">pbk_</code> and should be stored securely
              as an environment variable — never in source code.
            </p>
          </div>
        </section>

        <section id="server-to-server" className="mb-10">
          <h2 className="text-2xl font-bold mb-4">Integration Path 1: Server-to-Server</h2>
          <p className="text-gray-400 mb-4">
            The recommended approach for most integrations. Your backend calls the ProBid API using
            your <code className="text-green-400">pbk_</code> key. No CORS setup needed.
          </p>

          <div className="space-y-4">
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
              <h3 className="font-semibold mb-3 text-green-400">Create an Estimate</h3>
              <div className="bg-black/60 rounded p-4 overflow-x-auto">
                <pre className="text-sm text-gray-300">{`POST ${base}/api/estimates/send
Authorization: Bearer pbk_your_key_here
Content-Type: application/json

{
  "name": "123 Main St — Roof Replacement",
  "source": "partner_crm",
  "jobType": "roofing",
  "market": "Austin, TX",
  "clientName": "Jane Smith",
  "clientEmail": "jane@example.com",
  "clientPhone": "512-555-0100",
  "lineItems": [
    {
      "description": "Tear-off & disposal",
      "quantity": 1,
      "unitCost": 750,
      "uom": "job"
    },
    {
      "description": "30-year architectural shingles",
      "quantity": 24,
      "unitCost": 180,
      "uom": "sq"
    }
  ]
}`}</pre>
              </div>
              <p className="text-gray-400 text-sm mt-3">Requires the <code className="text-green-400">estimates:write</code> scope.</p>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
              <h3 className="font-semibold mb-3 text-green-400">List Estimates</h3>
              <div className="bg-black/60 rounded p-4 overflow-x-auto">
                <pre className="text-sm text-gray-300">{`GET ${base}/api/v1/estimates?page=1&limit=20
Authorization: Bearer pbk_your_key_here`}</pre>
              </div>
              <p className="text-gray-400 text-sm mt-3">Requires the <code className="text-green-400">estimates:read</code> scope.</p>
            </div>
          </div>
        </section>

        <section id="sdk" className="mb-10">
          <h2 className="text-2xl font-bold mb-4">Integration Path 2: In-Page SDK</h2>
          <p className="text-gray-400 mb-4">
            Embed the ProBid estimator directly in your web app. The SDK authenticates end-users
            on your allowed origin.
          </p>

          <div className="space-y-4">
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
              <h3 className="font-semibold mb-2">Step 1: Add Your Origin</h3>
              <p className="text-gray-400 text-sm mb-3">
                In the Partner Portal &rarr; Origins tab, add the origin where your app runs. For example:
              </p>
              <div className="flex flex-wrap gap-2 text-sm">
                <code className="bg-gray-900 px-2 py-1 rounded text-green-400">https://app.yourcrm.com</code>
                <code className="bg-gray-900 px-2 py-1 rounded text-green-400">*.yourcrm.com</code>
              </div>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
              <h3 className="font-semibold mb-2">Step 2: Embed the Script</h3>
              <div className="bg-black/60 rounded p-4 overflow-x-auto">
                <pre className="text-sm text-gray-300">{`<script src="${base}/integrate.js"></script>
<script>
  ProBidSDK.init({
    apiBase: '${base}',
    onEstimateCreated: function(estimate) {
      console.log('Estimate ID:', estimate.estimateId);
    }
  });
</script>`}</pre>
              </div>
            </div>
          </div>
        </section>

        <section id="rate-limits" className="mb-10">
          <h2 className="text-2xl font-bold mb-4">Rate Limits & Usage</h2>
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5 text-gray-300 space-y-3">
            <p>
              API keys are rate-limited per key per minute. Default limit is <strong>100 requests/minute</strong>.
              Your partner account may have a custom limit configured by the ProBid team.
            </p>
            <p>Rate limit headers are included in every response:</p>
            <div className="bg-black/50 rounded p-3 text-sm">
              <p><code className="text-green-400">RateLimit-Limit</code> — requests allowed per window</p>
              <p><code className="text-green-400">RateLimit-Remaining</code> — requests remaining this window</p>
              <p><code className="text-green-400">RateLimit-Reset</code> — seconds until window resets</p>
            </div>
            <p className="text-gray-400 text-sm">
              Track your daily and monthly usage in the Partner Portal &rarr; Overview tab.
            </p>
          </div>
        </section>

        <section id="errors" className="mb-10">
          <h2 className="text-2xl font-bold mb-4">Error Handling</h2>
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5 space-y-3">
            <div className="bg-black/50 rounded p-4 overflow-x-auto">
              <pre className="text-sm text-gray-300">{`// Error response shape
{
  "error": "unauthorized",
  "message": "Missing or invalid Authorization header"
}

// HTTP status codes:
// 200 OK           — success
// 400 Bad Request  — invalid input
// 401 Unauthorized — missing / invalid API key
// 403 Forbidden    — insufficient scope or suspended account
// 429 Too Many     — rate limit exceeded (retry after RateLimit-Reset)
// 500 Internal     — server error`}</pre>
              </div>
          </div>
        </section>

        <div className="border-t border-gray-700 pt-8 mt-8 flex gap-4">
          <a href="/app/partner" className="bg-green-600 hover:bg-green-700 px-5 py-2.5 rounded-lg text-sm font-medium">
            Open Partner Portal
          </a>
          <a href="/app/developer" className="bg-gray-700 hover:bg-gray-600 px-5 py-2.5 rounded-lg text-sm font-medium">
            Full API Docs
          </a>
        </div>
      </div>
    </div>
  );
}
