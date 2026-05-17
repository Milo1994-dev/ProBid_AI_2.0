import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";

interface ApiKeyData {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string;
  rateLimit: number;
  lastUsedAt: number | null;
  requestCount: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

interface WebhookData {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  enabled: boolean;
  lastStatus: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastDeliveredAt: number | null;
  successCount: number;
  failureCount: number;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export default function DeveloperPage() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKeyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["estimates:read"]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [activeTab, setActiveTab] = useState<"keys" | "webhooks" | "docs">("keys");

  // Webhook state.
  const [webhooks, setWebhooks] = useState<WebhookData[]>([]);
  const [webhooksLoading, setWebhooksLoading] = useState(true);
  const [showWebhookForm, setShowWebhookForm] = useState(false);
  const [creatingWebhook, setCreatingWebhook] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newWebhookDescription, setNewWebhookDescription] = useState("");
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([
    "estimate.created",
  ]);
  const [newWebhookSecret, setNewWebhookSecret] = useState<string | null>(null);
  const [availableEvents, setAvailableEvents] = useState<string[]>([
    "estimate.created",
    "estimate.updated",
    "lead.created",
  ]);
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; status: number | null } | null>(null);

  const availableScopes = [
    { value: "estimates:read", label: "Read Estimates" },
    { value: "estimates:write", label: "Send Estimates" },
    { value: "leads:read", label: "Read Leads" },
    { value: "usage:read", label: "Read Usage" },
  ];

  useEffect(() => {
    fetchKeys();
    fetchWebhooks();
  }, []);

  async function getCsrf(): Promise<string> {
    const res = await fetch("/api/csrf", { credentials: "include" });
    const data = await res.json();
    return data.data?.token ?? "";
  }

  async function fetchKeys() {
    try {
      const res = await fetch("/api/developer/keys", { credentials: "include" });
      const data = await res.json();
      if (data.success) setKeys(data.keys);
    } catch (err) {
      console.error("Failed to fetch keys:", err);
    } finally {
      setLoading(false);
    }
  }

  async function createKey() {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const csrf = await getCsrf();
      const res = await fetch("/api/developer/keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ name: newKeyName, scopes: selectedScopes }),
      });
      const data = await res.json();
      if (data.success) {
        setNewKey(data.key);
        setNewKeyName("");
        setSelectedScopes(["estimates:read"]);
        fetchKeys();
      }
    } catch (err) {
      console.error("Failed to create key:", err);
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Are you sure you want to revoke this API key? This cannot be undone.")) return;
    try {
      const csrf = await getCsrf();
      await fetch(`/api/developer/keys/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "X-CSRF-Token": csrf },
      });
      fetchKeys();
    } catch (err) {
      console.error("Failed to revoke key:", err);
    }
  }

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function fetchWebhooks() {
    try {
      const res = await fetch("/api/developer/webhooks", { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        setWebhooks(data.webhooks);
        if (Array.isArray(data.availableEvents)) {
          setAvailableEvents(data.availableEvents);
        }
      }
    } catch (err) {
      console.error("Failed to fetch webhooks:", err);
    } finally {
      setWebhooksLoading(false);
    }
  }

  function toggleWebhookEvent(event: string) {
    setNewWebhookEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  async function createWebhook() {
    if (!newWebhookUrl.trim() || newWebhookEvents.length === 0) return;
    setCreatingWebhook(true);
    try {
      const csrf = await getCsrf();
      const res = await fetch("/api/developer/webhooks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          url: newWebhookUrl.trim(),
          events: newWebhookEvents,
          description: newWebhookDescription.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setNewWebhookSecret(data.secret);
        setNewWebhookUrl("");
        setNewWebhookDescription("");
        setNewWebhookEvents(["estimate.created"]);
        setShowWebhookForm(false);
        fetchWebhooks();
      } else {
        alert(data.error || "Failed to create webhook");
      }
    } catch (err) {
      console.error("Failed to create webhook:", err);
    } finally {
      setCreatingWebhook(false);
    }
  }

  async function toggleWebhookEnabled(w: WebhookData) {
    try {
      const csrf = await getCsrf();
      await fetch(`/api/developer/webhooks/${w.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ enabled: !w.enabled }),
      });
      fetchWebhooks();
    } catch (err) {
      console.error("Failed to toggle webhook:", err);
    }
  }

  async function revokeWebhook(id: string) {
    if (!confirm("Revoke this webhook? This will stop all future deliveries and cannot be undone.")) {
      return;
    }
    try {
      const csrf = await getCsrf();
      await fetch(`/api/developer/webhooks/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "X-CSRF-Token": csrf },
      });
      fetchWebhooks();
    } catch (err) {
      console.error("Failed to revoke webhook:", err);
    }
  }

  async function testWebhook(id: string) {
    setTestingWebhookId(id);
    setTestResult(null);
    try {
      const csrf = await getCsrf();
      const res = await fetch(`/api/developer/webhooks/${id}/test`, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrf },
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ id, ok: !!data.delivered, status: data.responseStatus ?? null });
      }
      fetchWebhooks();
    } catch (err) {
      console.error("Failed to test webhook:", err);
    } finally {
      setTestingWebhookId(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Developer Portal</h1>
            <p className="text-gray-400 mt-1">Manage API keys and integrate ProBid into your workflow</p>
          </div>
          <a href="/app" className="text-green-400 hover:text-green-300 text-sm">
            &larr; Back to Dashboard
          </a>
        </div>

        <div className="flex gap-1 mb-6 border-b border-gray-700">
          <button
            onClick={() => setActiveTab("keys")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "keys"
                ? "border-green-500 text-green-400"
                : "border-transparent text-gray-400 hover:text-gray-300"
            }`}
          >
            API Keys
          </button>
          <button
            onClick={() => setActiveTab("webhooks")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "webhooks"
                ? "border-green-500 text-green-400"
                : "border-transparent text-gray-400 hover:text-gray-300"
            }`}
          >
            Webhooks
          </button>
          <button
            onClick={() => setActiveTab("docs")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "docs"
                ? "border-green-500 text-green-400"
                : "border-transparent text-gray-400 hover:text-gray-300"
            }`}
          >
            Documentation
          </button>
        </div>

        {activeTab === "keys" && (
          <div className="space-y-6">
            {newKey && (
              <div className="bg-green-900/30 border border-green-600 rounded-lg p-4">
                <p className="text-green-400 font-semibold mb-2">API Key Created Successfully</p>
                <p className="text-gray-300 text-sm mb-3">
                  Copy this key now. It will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="bg-black/50 px-3 py-2 rounded text-green-300 text-sm flex-1 break-all">
                    {newKey}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(newKey);
                    }}
                    className="bg-green-600 hover:bg-green-700 px-3 py-2 rounded text-sm whitespace-nowrap"
                  >
                    Copy
                  </button>
                </div>
                <button
                  onClick={() => setNewKey(null)}
                  className="mt-3 text-gray-400 hover:text-gray-300 text-sm"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Your API Keys</h2>
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-lg text-sm font-medium"
              >
                {showCreateForm ? "Cancel" : "+ Create API Key"}
              </button>
            </div>

            {showCreateForm && (
              <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
                <h3 className="font-semibold mb-4">Create New API Key</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Key Name</label>
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder="e.g., My Integration"
                      className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Permissions</label>
                    <div className="flex flex-wrap gap-2">
                      {availableScopes.map((scope) => (
                        <button
                          key={scope.value}
                          onClick={() => toggleScope(scope.value)}
                          className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                            selectedScopes.includes(scope.value)
                              ? "bg-green-600/20 border-green-600 text-green-400"
                              : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                          }`}
                        >
                          {scope.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={createKey}
                    disabled={creating || !newKeyName.trim() || selectedScopes.length === 0}
                    className="bg-green-600 hover:bg-green-700 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium"
                  >
                    {creating ? "Creating..." : "Create Key"}
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="text-gray-400 text-center py-8">Loading...</div>
            ) : keys.length === 0 ? (
              <div className="text-center py-12 bg-gray-800/30 border border-gray-700 rounded-lg">
                <p className="text-gray-400 mb-2">No API keys yet</p>
                <p className="text-gray-500 text-sm">
                  Create an API key to start integrating with ProBid
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {keys.map((key) => (
                  <div
                    key={key.id}
                    className={`bg-gray-800/50 border rounded-lg p-4 ${
                      key.revokedAt ? "border-red-900/50 opacity-60" : "border-gray-700"
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{key.name}</span>
                          {key.revokedAt && (
                            <span className="text-xs bg-red-900/50 text-red-400 px-2 py-0.5 rounded">
                              Revoked
                            </span>
                          )}
                        </div>
                        <code className="text-gray-500 text-sm mt-1 block">
                          {key.keyPrefix}_••••••••
                        </code>
                        <div className="flex gap-4 mt-2 text-xs text-gray-500">
                          <span>Scopes: {key.scopes}</span>
                          <span>Rate: {key.rateLimit}/min</span>
                          <span>Requests: {key.requestCount || 0}</span>
                          {key.lastUsedAt && (
                            <span>
                              Last used: {new Date(key.lastUsedAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                      {!key.revokedAt && (
                        <button
                          onClick={() => revokeKey(key.id)}
                          className="text-red-400 hover:text-red-300 text-sm"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "webhooks" && (
          <div className="space-y-6">
            {newWebhookSecret && (
              <div className="bg-green-900/30 border border-green-600 rounded-lg p-4">
                <p className="text-green-400 font-semibold mb-2">Webhook Created</p>
                <p className="text-gray-300 text-sm mb-3">
                  Copy this signing secret now — you'll use it to verify the{" "}
                  <code className="text-green-300">X-ProBid-Signature</code> header.
                  It will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="bg-black/50 px-3 py-2 rounded text-green-300 text-sm flex-1 break-all">
                    {newWebhookSecret}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(newWebhookSecret);
                    }}
                    className="bg-green-600 hover:bg-green-700 px-3 py-2 rounded text-sm whitespace-nowrap"
                  >
                    Copy
                  </button>
                </div>
                <button
                  onClick={() => setNewWebhookSecret(null)}
                  className="mt-3 text-gray-400 hover:text-gray-300 text-sm"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-xl font-semibold">Webhook Endpoints</h2>
                <p className="text-gray-400 text-sm mt-1">
                  ProBid will POST signed JSON to your URL whenever the events you select happen.
                </p>
              </div>
              <button
                onClick={() => setShowWebhookForm(!showWebhookForm)}
                className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-lg text-sm font-medium"
              >
                {showWebhookForm ? "Cancel" : "+ Add Webhook"}
              </button>
            </div>

            {showWebhookForm && (
              <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
                <h3 className="font-semibold mb-4">New Webhook Endpoint</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Endpoint URL</label>
                    <input
                      type="url"
                      value={newWebhookUrl}
                      onChange={(e) => setNewWebhookUrl(e.target.value)}
                      placeholder="https://api.your-app.com/probid/webhook"
                      className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Description (optional)</label>
                    <input
                      type="text"
                      value={newWebhookDescription}
                      onChange={(e) => setNewWebhookDescription(e.target.value)}
                      placeholder="e.g., Production CRM sync"
                      className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Events to Subscribe</label>
                    <div className="flex flex-wrap gap-2">
                      {availableEvents.map((event) => (
                        <button
                          key={event}
                          onClick={() => toggleWebhookEvent(event)}
                          className={`px-3 py-1.5 rounded text-sm border font-mono transition-colors ${
                            newWebhookEvents.includes(event)
                              ? "bg-green-600/20 border-green-600 text-green-400"
                              : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                          }`}
                        >
                          {event}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={createWebhook}
                    disabled={creatingWebhook || !newWebhookUrl.trim() || newWebhookEvents.length === 0}
                    className="bg-green-600 hover:bg-green-700 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium"
                  >
                    {creatingWebhook ? "Creating..." : "Create Webhook"}
                  </button>
                </div>
              </div>
            )}

            {webhooksLoading ? (
              <div className="text-gray-400 text-center py-8">Loading...</div>
            ) : webhooks.length === 0 ? (
              <div className="text-center py-12 bg-gray-800/30 border border-gray-700 rounded-lg">
                <p className="text-gray-400 mb-2">No webhook endpoints yet</p>
                <p className="text-gray-500 text-sm">
                  Add an endpoint to receive real-time events from ProBid.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {webhooks.map((w) => (
                  <WebhookRow
                    key={w.id}
                    webhook={w}
                    testing={testingWebhookId === w.id}
                    testResult={testResult && testResult.id === w.id ? testResult : null}
                    onToggle={() => toggleWebhookEnabled(w)}
                    onRevoke={() => revokeWebhook(w.id)}
                    onTest={() => testWebhook(w.id)}
                  />
                ))}
              </div>
            )}

            <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-5 text-sm text-gray-300">
              <h3 className="font-semibold text-gray-200 mb-2">Verifying signatures</h3>
              <p className="mb-3">
                Every delivery includes <code className="text-green-400">X-ProBid-Signature</code>{" "}
                in the form <code>t=&lt;unix_ms&gt;,v1=&lt;hex_hmac&gt;</code>. Recompute the HMAC-SHA256 of{" "}
                <code>{"`${t}.${rawBody}`"}</code> with your endpoint's signing secret and compare in constant time.
              </p>
              <pre className="bg-black/50 rounded p-3 text-xs overflow-x-auto">{`// Node.js example
const crypto = require("crypto");
const sigHeader = req.headers["x-probid-signature"];
const [t, v1] = sigHeader.split(",").map(p => p.split("=")[1]);
const expected = crypto
  .createHmac("sha256", process.env.PROBID_WEBHOOK_SECRET)
  .update(\`\${t}.\${rawBody}\`)
  .digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) {
  return res.status(400).send("invalid signature");
}`}</pre>
            </div>
          </div>
        )}

        {activeTab === "docs" && (
          <div className="space-y-8">
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Getting Started</h2>
              <p className="text-gray-300 mb-4">
                The ProBid API allows you to integrate construction estimating into your own
                applications. All requests require a valid API key.
              </p>
              <div className="bg-black/50 rounded p-4">
                <p className="text-gray-400 text-xs mb-2">Base URL</p>
                <code className="text-green-400">
                  {window.location.origin}/api/v1
                </code>
              </div>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Authentication</h2>
              <p className="text-gray-300 mb-4">
                Include your API key in the Authorization header:
              </p>
              <div className="bg-black/50 rounded p-4 overflow-x-auto">
                <pre className="text-sm text-gray-300">
{`curl ${window.location.origin}/api/v1/estimates \\
  -H "Authorization: Bearer pbk_your_api_key_here"`}
                </pre>
              </div>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Endpoints</h2>
              <div className="space-y-6">
                <EndpointDoc
                  method="GET"
                  path="/api/v1/estimates"
                  description="List your estimates with pagination"
                  params={[
                    { name: "page", type: "number", description: "Page number (default: 1)" },
                    { name: "limit", type: "number", description: "Items per page (max: 100, default: 20)" },
                  ]}
                />
                <EndpointDoc
                  method="GET"
                  path="/api/v1/estimates/:id"
                  description="Get a specific estimate by ID"
                  params={[]}
                />
                <EndpointDoc
                  method="GET"
                  path="/api/v1/usage"
                  description="Get your current usage and subscription status"
                  params={[]}
                />
                <EndpointDoc
                  method="GET"
                  path="/api/v1/leads"
                  description="List your captured leads"
                  params={[
                    { name: "page", type: "number", description: "Page number (default: 1)" },
                    { name: "limit", type: "number", description: "Items per page (max: 100, default: 20)" },
                  ]}
                />
                <EndpointDoc
                  method="GET"
                  path="/api/v1/account"
                  description="Get your account information"
                  params={[]}
                />
                <EndpointDoc
                  method="POST"
                  path="/api/estimates/send"
                  description="Create an estimate programmatically with structured line items. Requires the estimates:write scope. Counts against your plan's estimate quota. Supports the Idempotency-Key header so retries don't double-charge."
                  params={[]}
                />
              </div>
              <div className="mt-6 bg-black/50 rounded p-4 overflow-x-auto">
                <p className="text-gray-400 text-xs mb-2">Example: send an estimate</p>
                <pre className="text-sm text-gray-300">
{`curl -X POST ${window.location.origin}/api/estimates/send \\
  -H "Authorization: Bearer pbk_your_api_key_here" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: 7c1b3e0e-4ad6-4f2e-8a0a-2b1d3f5a6c7d" \\
  -d '{
    "name": "123 Main St — Kitchen Remodel",
    "source": "partner_crm",
    "clientName": "Jane Smith",
    "clientEmail": "jane@example.com",
    "lineItems": [
      { "description": "Demo & disposal", "quantity": 1, "unitCost": 850 },
      { "description": "Cabinet install",  "quantity": 12, "unitCost": 240, "uom": "lf" }
    ]
  }'`}
                </pre>
              </div>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Idempotency</h2>
              <p className="text-gray-300 mb-3">
                Network blips and partner-side retry logic can cause the same{" "}
                <code className="text-green-400">POST /api/estimates/send</code>{" "}
                request to land twice. To make retries safe, send an{" "}
                <code className="text-green-400">Idempotency-Key</code> header
                (or an <code className="text-green-400">idempotencyKey</code> field in the
                JSON body) with each request. We recommend a fresh{" "}
                <strong>UUID v4</strong> per logical estimate.
              </p>
              <ul className="text-gray-300 text-sm list-disc list-inside space-y-1 mb-3">
                <li>
                  A retry with the <em>same</em> key and <em>same</em> body within 24 hours
                  replays the original response — no new estimate, no extra credit consumed,
                  no duplicate webhooks. The replay carries an{" "}
                  <code className="text-green-400">Idempotent-Replayed: true</code> response header.
                </li>
                <li>
                  Reusing the same key with a <em>different</em> body returns{" "}
                  <code className="text-green-400">422 Unprocessable Entity</code>. Generate a new
                  key whenever the payload changes.
                </li>
                <li>
                  Keys are scoped per API key, so different partners can use the same UUID without
                  colliding. Allowed characters: letters, digits, <code className="text-green-400">.</code>,{" "}
                  <code className="text-green-400">_</code>, <code className="text-green-400">:</code>,{" "}
                  <code className="text-green-400">-</code> (max 255 chars).
                </li>
                <li>
                  If a previous request with the same key is still in flight you'll get{" "}
                  <code className="text-green-400">409 Conflict</code>. Retry after a brief backoff.
                </li>
                <li>
                  In the rare case our idempotency store is briefly unavailable you'll get{" "}
                  <code className="text-green-400">503 Service Unavailable</code> instead of a possibly
                  duplicated estimate. Retry safely with the same key.
                </li>
              </ul>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Rate Limits</h2>
              <p className="text-gray-300 mb-3">
                API requests are rate-limited per key. The default limit is 100 requests per minute.
                Rate limit headers are included in every response:
              </p>
              <div className="bg-black/50 rounded p-4 text-sm text-gray-300">
                <p><code className="text-green-400">RateLimit-Limit</code>: Maximum requests per window</p>
                <p><code className="text-green-400">RateLimit-Remaining</code>: Remaining requests in current window</p>
                <p><code className="text-green-400">RateLimit-Reset</code>: Time until window resets (seconds)</p>
              </div>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Error Responses</h2>
              <div className="bg-black/50 rounded p-4 overflow-x-auto">
                <pre className="text-sm text-gray-300">
{`{
  "error": "unauthorized",
  "message": "Missing or invalid Authorization header"
}

// HTTP Status Codes:
// 200 - Success
// 400 - Bad Request
// 401 - Unauthorized
// 403 - Forbidden (insufficient scopes)
// 404 - Not Found
// 429 - Rate Limit Exceeded
// 500 - Internal Server Error`}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EndpointDoc({
  method,
  path,
  description,
  params,
}: {
  method: string;
  path: string;
  description: string;
  params: { name: string; type: string; description: string }[];
}) {
  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-900/50">
        <span className="bg-green-600/20 text-green-400 px-2 py-0.5 rounded text-xs font-mono font-bold">
          {method}
        </span>
        <code className="text-gray-300 text-sm">{path}</code>
      </div>
      <div className="px-4 py-3">
        <p className="text-gray-400 text-sm mb-2">{description}</p>
        {params.length > 0 && (
          <div className="mt-3">
            <p className="text-gray-500 text-xs font-semibold mb-2">QUERY PARAMETERS</p>
            {params.map((p) => (
              <div key={p.name} className="flex gap-2 text-sm py-1">
                <code className="text-indigo-400">{p.name}</code>
                <span className="text-gray-600">({p.type})</span>
                <span className="text-gray-400">— {p.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WebhookRow({
  webhook,
  testing,
  testResult,
  onToggle,
  onRevoke,
  onTest,
}: {
  webhook: WebhookData;
  testing: boolean;
  testResult: { id: string; ok: boolean; status: number | null } | null;
  onToggle: () => void;
  onRevoke: () => void;
  onTest: () => void;
}) {
  const statusBadge = (() => {
    if (webhook.revokedAt) {
      return <span className="text-xs bg-red-900/50 text-red-400 px-2 py-0.5 rounded">Revoked</span>;
    }
    if (!webhook.enabled) {
      return <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded">Disabled</span>;
    }
    if (webhook.lastStatus === "success") {
      return (
        <span className="text-xs bg-green-900/40 text-green-400 px-2 py-0.5 rounded">
          Healthy {webhook.lastStatusCode ? `(${webhook.lastStatusCode})` : ""}
        </span>
      );
    }
    if (webhook.lastStatus === "retrying") {
      return (
        <span className="text-xs bg-yellow-900/40 text-yellow-300 px-2 py-0.5 rounded">
          Retrying
        </span>
      );
    }
    if (webhook.lastStatus === "failed") {
      return (
        <span className="text-xs bg-red-900/40 text-red-400 px-2 py-0.5 rounded">
          Failing {webhook.lastStatusCode ? `(${webhook.lastStatusCode})` : ""}
        </span>
      );
    }
    return <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">No deliveries yet</span>;
  })();

  return (
    <div
      className={`bg-gray-800/50 border rounded-lg p-4 ${
        webhook.revokedAt ? "border-red-900/50 opacity-60" : "border-gray-700"
      }`}
    >
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="font-mono text-sm text-gray-200 break-all">{webhook.url}</code>
            {statusBadge}
          </div>
          {webhook.description && (
            <p className="text-gray-400 text-sm mt-1">{webhook.description}</p>
          )}
          <div className="flex gap-1 mt-2 flex-wrap">
            {webhook.events.map((e) => (
              <span
                key={e}
                className="text-xs bg-indigo-900/30 text-indigo-300 px-2 py-0.5 rounded font-mono"
              >
                {e}
              </span>
            ))}
          </div>
          <div className="flex gap-4 mt-2 text-xs text-gray-500 flex-wrap">
            <span>Delivered: {webhook.successCount}</span>
            <span>Failed: {webhook.failureCount}</span>
            {webhook.lastDeliveredAt && (
              <span>
                Last attempt: {new Date(webhook.lastDeliveredAt).toLocaleString()}
              </span>
            )}
          </div>
          {webhook.lastError && (
            <p className="text-xs text-red-400 mt-2 break-all">
              Last error: {webhook.lastError}
            </p>
          )}
          {testResult && (
            <p
              className={`text-xs mt-2 ${
                testResult.ok ? "text-green-400" : "text-red-400"
              }`}
            >
              Test delivery {testResult.ok ? "succeeded" : "failed"}
              {testResult.status ? ` (HTTP ${testResult.status})` : ""}
            </p>
          )}
        </div>
        {!webhook.revokedAt && (
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={onTest}
              disabled={testing || !webhook.enabled}
              className="text-indigo-400 hover:text-indigo-300 text-sm disabled:opacity-50"
            >
              {testing ? "Testing..." : "Send test"}
            </button>
            <button
              onClick={onToggle}
              className="text-gray-400 hover:text-gray-300 text-sm"
            >
              {webhook.enabled ? "Disable" : "Enable"}
            </button>
            <button
              onClick={onRevoke}
              className="text-red-400 hover:text-red-300 text-sm"
            >
              Revoke
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
