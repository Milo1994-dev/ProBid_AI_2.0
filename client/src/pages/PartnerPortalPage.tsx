import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";

interface Partner {
  id: string;
  companyName: string;
  primaryUserId: string;
  status: "active" | "suspended";
  rateLimitOverride: number | null;
  notes: string | null;
  createdAt: number;
}

interface ApiKeyData {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string;
  rateLimit: number;
  lastUsedAt: number | null;
  requestCount: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

interface OriginEntry {
  id: number;
  origin: string;
  kind: "exact" | "wildcard";
  note: string | null;
  createdAt: number;
  revokedAt: number | null;
}

interface UsageData {
  today: { estimatesSdk: number; estimatesApi: number; errors: number; rateLimitHits: number };
  thisMonth: { estimatesSdk: number; estimatesApi: number; errors: number; rateLimitHits: number };
  recentDays: Array<{ dayKey: string; apiKeyId: string | null; estimatesSdk: number; estimatesApi: number; errors: number }>;
  keyUsage: Array<{ apiKeyId: string | null; estimatesApi: string | null; errors: string | null }>;
}

type ActiveTab = "overview" | "keys" | "origins" | "docs";

export default function PartnerPortalPage() {
  const { user } = useAuth();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [notPartner, setNotPartner] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");

  const [keys, setKeys] = useState<ApiKeyData[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState(["estimates:read", "estimates:write"]);
  const [creatingKey, setCreatingKey] = useState(false);

  const [origins, setOrigins] = useState<OriginEntry[]>([]);
  const [originsLoading, setOriginsLoading] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");
  const [newOriginNote, setNewOriginNote] = useState("");
  const [addingOrigin, setAddingOrigin] = useState(false);
  const [originMsg, setOriginMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const availableScopes = [
    { value: "estimates:read", label: "Read Estimates" },
    { value: "estimates:write", label: "Send Estimates" },
    { value: "leads:read", label: "Read Leads" },
    { value: "usage:read", label: "Read Usage" },
  ];

  useEffect(() => {
    fetchPartner();
  }, []);

  useEffect(() => {
    if (!partner) return;
    if (activeTab === "keys") fetchKeys();
    if (activeTab === "origins") fetchOrigins();
    if (activeTab === "overview") fetchUsage();
  }, [activeTab, partner]);

  async function getCsrf(): Promise<string> {
    const res = await fetch("/api/csrf", { credentials: "include" });
    const data = await res.json();
    return data.data?.token ?? "";
  }

  async function fetchPartner() {
    try {
      const res = await fetch("/api/partner/me", { credentials: "include" });
      if (res.status === 404 || res.status === 403) { setNotPartner(true); return; }
      const data = await res.json();
      if (data.success) {
        setPartner(data.partner);
        fetchUsage();
      }
    } catch (err) {
      setNotPartner(true);
    } finally {
      setLoading(false);
    }
  }

  async function fetchKeys() {
    setKeysLoading(true);
    try {
      const res = await fetch("/api/partner/keys", { credentials: "include" });
      const data = await res.json();
      if (data.success) setKeys(data.keys);
    } finally {
      setKeysLoading(false);
    }
  }

  async function fetchOrigins() {
    setOriginsLoading(true);
    try {
      const res = await fetch("/api/partner/origins", { credentials: "include" });
      const data = await res.json();
      if (data.success) setOrigins(data.origins);
    } finally {
      setOriginsLoading(false);
    }
  }

  async function fetchUsage() {
    setUsageLoading(true);
    try {
      const res = await fetch("/api/partner/usage", { credentials: "include" });
      const data = await res.json();
      if (data.success) setUsage(data.data);
    } finally {
      setUsageLoading(false);
    }
  }

  async function createKey() {
    if (!newKeyName.trim()) return;
    setCreatingKey(true);
    try {
      const csrf = await getCsrf();
      const res = await fetch("/api/partner/keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ name: newKeyName, scopes: selectedScopes }),
      });
      const data = await res.json();
      if (data.success) {
        setNewKey(data.key);
        setNewKeyName("");
        setSelectedScopes(["estimates:read", "estimates:write"]);
        setShowCreateKey(false);
        fetchKeys();
      } else {
        alert(data.error || "Failed to create key");
      }
    } finally {
      setCreatingKey(false);
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    const csrf = await getCsrf();
    await fetch(`/api/partner/keys/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-CSRF-Token": csrf },
    });
    fetchKeys();
  }

  async function rotateKey(id: string) {
    if (!confirm("Rotate this key? The old key will be revoked immediately and a new key will be issued.")) return;
    const csrf = await getCsrf();
    const res = await fetch(`/api/partner/keys/${id}/rotate`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Token": csrf },
    });
    const data = await res.json();
    if (data.success) {
      setNewKey(data.key);
      fetchKeys();
    } else {
      alert(data.error || "Failed to rotate key");
    }
  }

  async function addOrigin() {
    if (!newOrigin.trim()) return;
    setAddingOrigin(true);
    setOriginMsg(null);
    try {
      const csrf = await getCsrf();
      const res = await fetch("/api/partner/origins", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ origin: newOrigin, note: newOriginNote || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setNewOrigin("");
        setNewOriginNote("");
        setOriginMsg({ type: "ok", text: "Origin added to allowlist" });
        fetchOrigins();
      } else {
        setOriginMsg({ type: "err", text: data.error || `Error ${res.status}` });
      }
    } finally {
      setAddingOrigin(false);
    }
  }

  async function removeOrigin(id: number) {
    if (!confirm("Remove this origin from your allowlist?")) return;
    const csrf = await getCsrf();
    const res = await fetch(`/api/partner/origins/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-CSRF-Token": csrf },
    });
    if (res.ok) fetchOrigins();
  }

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (notPartner) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4">Partner Portal</h1>
          <p className="text-gray-400 mb-4">
            Your account is not linked to a partner organization. To become a ProBid integration
            partner, please contact us.
          </p>
          <a
            href="/app"
            className="text-green-400 hover:text-green-300 text-sm"
          >
            &larr; Back to Dashboard
          </a>
        </div>
      </div>
    );
  }

  if (!partner) return null;

  const tabs: { id: ActiveTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "keys", label: "API Keys" },
    { id: "origins", label: "Origins" },
    { id: "docs", label: "Docs" },
  ];

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-start justify-between mb-8">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-3xl font-bold">Partner Portal</h1>
              <span
                className={`text-xs px-2 py-1 rounded font-medium ${
                  partner.status === "active"
                    ? "bg-green-900/40 text-green-400"
                    : "bg-red-900/40 text-red-400"
                }`}
              >
                {partner.status === "active" ? "Active" : "Suspended"}
              </span>
            </div>
            <p className="text-gray-400">{partner.companyName}</p>
          </div>
          <a href="/app" className="text-green-400 hover:text-green-300 text-sm">
            &larr; Back to Dashboard
          </a>
        </div>

        {partner.status === "suspended" && (
          <div className="mb-6 bg-red-900/30 border border-red-600 rounded-lg p-4 text-red-300">
            Your partner account is suspended. API key creation and origin management are disabled.
            Please contact support.
          </div>
        )}

        <div className="flex gap-1 mb-6 border-b border-gray-700">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-green-500 text-green-400"
                  : "border-transparent text-gray-400 hover:text-gray-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <OverviewTab usage={usage} usageLoading={usageLoading} partner={partner} />
        )}

        {activeTab === "keys" && (
          <KeysTab
            keys={keys}
            loading={keysLoading}
            newKey={newKey}
            setNewKey={setNewKey}
            showCreateKey={showCreateKey}
            setShowCreateKey={setShowCreateKey}
            newKeyName={newKeyName}
            setNewKeyName={setNewKeyName}
            selectedScopes={selectedScopes}
            toggleScope={toggleScope}
            availableScopes={availableScopes}
            creatingKey={creatingKey}
            createKey={createKey}
            revokeKey={revokeKey}
            rotateKey={rotateKey}
          />
        )}

        {activeTab === "origins" && (
          <OriginsTab
            origins={origins}
            loading={originsLoading}
            newOrigin={newOrigin}
            setNewOrigin={setNewOrigin}
            newOriginNote={newOriginNote}
            setNewOriginNote={setNewOriginNote}
            addingOrigin={addingOrigin}
            addOrigin={addOrigin}
            removeOrigin={removeOrigin}
            msg={originMsg}
          />
        )}

        {activeTab === "docs" && <DocsTab />}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
      <p className="text-gray-400 text-sm mb-1">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      {sub && <p className="text-gray-500 text-xs mt-1">{sub}</p>}
    </div>
  );
}

function OverviewTab({ usage, usageLoading, partner }: { usage: UsageData | null; usageLoading: boolean; partner: Partner }) {
  if (usageLoading) return <div className="text-gray-400 text-center py-8">Loading usage...</div>;

  const today = usage?.today;
  const month = usage?.thisMonth;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-3">Today</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="SDK Estimates" value={today?.estimatesSdk ?? 0} />
          <StatCard label="API Estimates" value={today?.estimatesApi ?? 0} />
          <StatCard label="Errors" value={today?.errors ?? 0} />
          <StatCard label="Rate Limit Hits" value={today?.rateLimitHits ?? 0} />
        </div>
      </div>
      <div>
        <h2 className="text-lg font-semibold mb-3">This Month</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="SDK Estimates" value={month?.estimatesSdk ?? 0} />
          <StatCard label="API Estimates" value={month?.estimatesApi ?? 0} />
          <StatCard label="Total Estimates" value={(month?.estimatesSdk ?? 0) + (month?.estimatesApi ?? 0)} />
          <StatCard label="Errors" value={month?.errors ?? 0} />
        </div>
      </div>

      {usage && usage.recentDays.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Recent Activity</h2>
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400 text-xs">
                  <th className="text-left p-3">Date</th>
                  <th className="text-right p-3">SDK</th>
                  <th className="text-right p-3">API</th>
                  <th className="text-right p-3">Errors</th>
                </tr>
              </thead>
              <tbody>
                {usage.recentDays.slice(0, 10).map((row, i) => (
                  <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/20">
                    <td className="p-3 text-gray-300">{row.dayKey}</td>
                    <td className="p-3 text-right text-gray-300">{row.estimatesSdk}</td>
                    <td className="p-3 text-right text-gray-300">{row.estimatesApi}</td>
                    <td className="p-3 text-right text-gray-300">{row.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        <h2 className="font-semibold mb-2">Account Info</h2>
        <div className="space-y-2 text-sm text-gray-400">
          <p><span className="text-gray-500">Partner ID:</span> <code className="text-gray-300">{partner.id}</code></p>
          <p><span className="text-gray-500">Company:</span> <span className="text-gray-300">{partner.companyName}</span></p>
          <p><span className="text-gray-500">Rate Limit:</span> <span className="text-gray-300">{partner.rateLimitOverride ?? 100} req/min</span></p>
          <p><span className="text-gray-500">Member Since:</span> <span className="text-gray-300">{new Date(partner.createdAt).toLocaleDateString()}</span></p>
        </div>
      </div>
    </div>
  );
}

interface KeysTabProps {
  keys: ApiKeyData[];
  loading: boolean;
  newKey: string | null;
  setNewKey: (v: string | null) => void;
  showCreateKey: boolean;
  setShowCreateKey: (v: boolean) => void;
  newKeyName: string;
  setNewKeyName: (v: string) => void;
  selectedScopes: string[];
  toggleScope: (scope: string) => void;
  availableScopes: Array<{ value: string; label: string }>;
  creatingKey: boolean;
  createKey: () => void;
  revokeKey: (id: string) => void;
  rotateKey: (id: string) => void;
}

function KeysTab({
  keys, loading, newKey, setNewKey, showCreateKey, setShowCreateKey,
  newKeyName, setNewKeyName, selectedScopes, toggleScope, availableScopes,
  creatingKey, createKey, revokeKey, rotateKey,
}: KeysTabProps) {
  return (
    <div className="space-y-6">
      {newKey && (
        <div className="bg-green-900/30 border border-green-600 rounded-lg p-4">
          <p className="text-green-400 font-semibold mb-2">API Key Ready</p>
          <p className="text-gray-300 text-sm mb-3">Copy this key now — it will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="bg-black/50 px-3 py-2 rounded text-green-300 text-sm flex-1 break-all">{newKey}</code>
            <button
              onClick={() => navigator.clipboard.writeText(newKey)}
              className="bg-green-600 hover:bg-green-700 px-3 py-2 rounded text-sm whitespace-nowrap"
            >
              Copy
            </button>
          </div>
          <button onClick={() => setNewKey(null)} className="mt-3 text-gray-400 hover:text-gray-300 text-sm">Dismiss</button>
        </div>
      )}

      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">API Keys</h2>
        <button
          onClick={() => setShowCreateKey(!showCreateKey)}
          className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-lg text-sm font-medium"
        >
          {showCreateKey ? "Cancel" : "+ New Key"}
        </button>
      </div>

      {showCreateKey && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
          <h3 className="font-semibold mb-4">Create API Key</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Key Name</label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g., Production CRM Integration"
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Scopes</label>
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
              disabled={creatingKey || !newKeyName.trim() || selectedScopes.length === 0}
              className="bg-green-600 hover:bg-green-700 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium"
            >
              {creatingKey ? "Creating..." : "Create Key"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-gray-400 text-center py-8">Loading...</div>
      ) : keys.length === 0 ? (
        <div className="text-center py-12 bg-gray-800/30 border border-gray-700 rounded-lg">
          <p className="text-gray-400">No API keys yet</p>
          <p className="text-gray-500 text-sm mt-1">Create a key to start integrating with ProBid</p>
        </div>
      ) : (
        <div className="space-y-3">
          {keys.map((key: ApiKeyData) => (
            <div
              key={key.id}
              className={`bg-gray-800/50 border rounded-lg p-4 ${key.revokedAt ? "border-red-900/50 opacity-60" : "border-gray-700"}`}
            >
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{key.name}</span>
                    {key.revokedAt && (
                      <span className="text-xs bg-red-900/50 text-red-400 px-2 py-0.5 rounded">Revoked</span>
                    )}
                  </div>
                  <code className="text-gray-500 text-sm mt-1 block">{key.keyPrefix}_••••••••</code>
                  <div className="flex flex-wrap gap-4 mt-2 text-xs text-gray-500">
                    <span>Scopes: {key.scopes}</span>
                    <span>Rate: {key.rateLimit}/min</span>
                    <span>Requests: {key.requestCount ?? 0}</span>
                    {key.lastUsedAt && <span>Last used: {new Date(key.lastUsedAt).toLocaleDateString()}</span>}
                  </div>
                </div>
                {!key.revokedAt && (
                  <div className="flex items-center gap-2 ml-4">
                    <button
                      onClick={() => rotateKey(key.id)}
                      className="text-blue-400 hover:text-blue-300 text-sm"
                    >
                      Rotate
                    </button>
                    <button
                      onClick={() => revokeKey(key.id)}
                      className="text-red-400 hover:text-red-300 text-sm"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface OriginsTabProps {
  origins: OriginEntry[];
  loading: boolean;
  newOrigin: string;
  setNewOrigin: (v: string) => void;
  newOriginNote: string;
  setNewOriginNote: (v: string) => void;
  addingOrigin: boolean;
  addOrigin: () => void;
  removeOrigin: (id: number) => void;
  msg: { type: "ok" | "err"; text: string } | null;
}

function OriginsTab({
  origins, loading, newOrigin, setNewOrigin, newOriginNote, setNewOriginNote,
  addingOrigin, addOrigin, removeOrigin, msg,
}: OriginsTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Origin Allowlist</h2>
        <p className="text-gray-400 text-sm">
          Add the origins from which your embedded ProBid SDK will load. Use exact origins like{" "}
          <code className="text-green-400">https://app.example.com</code> or wildcard subdomains like{" "}
          <code className="text-green-400">*.example.com</code>.
        </p>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        <h3 className="font-medium mb-3">Add Origin</h3>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            placeholder="https://app.yourcrm.com or *.yourcrm.com"
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          />
          <button
            onClick={addOrigin}
            disabled={addingOrigin || !newOrigin.trim()}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium whitespace-nowrap"
          >
            {addingOrigin ? "Adding..." : "Add"}
          </button>
        </div>
        <input
          type="text"
          value={newOriginNote}
          onChange={(e) => setNewOriginNote(e.target.value)}
          placeholder="Optional note (e.g., Production app)"
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
        />
        {msg && (
          <p className={`mt-2 text-sm ${msg.type === "ok" ? "text-green-400" : "text-red-400"}`}>
            {msg.text}
          </p>
        )}
      </div>

      {loading ? (
        <div className="text-gray-400 text-center py-8">Loading...</div>
      ) : origins.length === 0 ? (
        <div className="text-center py-12 bg-gray-800/30 border border-gray-700 rounded-lg">
          <p className="text-gray-400">No origins added yet</p>
          <p className="text-gray-500 text-sm mt-1">Add an origin to allow the SDK to load from your site</p>
        </div>
      ) : (
        <div className="space-y-2">
          {origins.map((o: OriginEntry) => (
            <div
              key={o.id}
              className={`flex items-center justify-between bg-gray-800/50 border rounded-lg px-4 py-3 ${o.revokedAt ? "border-red-900/50 opacity-60" : "border-gray-700"}`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <code className="text-green-400 text-sm">{o.origin}</code>
                  <span className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">{o.kind}</span>
                  {o.revokedAt && <span className="text-xs bg-red-900/50 text-red-400 px-1.5 py-0.5 rounded">Revoked</span>}
                </div>
                {o.note && <p className="text-gray-500 text-xs mt-0.5">{o.note}</p>}
              </div>
              {!o.revokedAt && (
                <button onClick={() => removeOrigin(o.id)} className="text-red-400 hover:text-red-300 text-sm">Remove</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DocsTab() {
  const base = window.location.origin;
  return (
    <div className="space-y-6">
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Integration Paths</h2>
        <p className="text-gray-300 mb-4">
          ProBid supports two integration paths for partners:
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-gray-900/50 rounded-lg p-4">
            <h3 className="font-medium text-green-400 mb-2">Server-to-Server (API Keys)</h3>
            <p className="text-gray-400 text-sm">
              Use a <code>pbk_</code> API key in the <code>Authorization: Bearer</code> header to call
              ProBid's REST API from your backend. Best for creating estimates programmatically.
            </p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-4">
            <h3 className="font-medium text-blue-400 mb-2">In-Page SDK (Allowlisted Origin)</h3>
            <p className="text-gray-400 text-sm">
              Embed the <code>integrate.js</code> SDK on your page. Add your origin to the allowlist so
              cross-origin requests are accepted. Best for embedding the estimator in your frontend.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Server-to-Server Authentication</h2>
        <p className="text-gray-300 mb-3">Use your API key from the <strong>API Keys</strong> tab:</p>
        <div className="bg-black/50 rounded p-4 overflow-x-auto">
          <pre className="text-sm text-gray-300">{`curl -X POST ${base}/api/estimates/send \\
  -H "Authorization: Bearer pbk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "123 Main St — Roof Replacement",
    "source": "partner_crm",
    "clientName": "Jane Smith",
    "clientEmail": "jane@example.com",
    "lineItems": [
      { "description": "Tear-off", "quantity": 1, "unitCost": 750 },
      { "description": "New shingles", "quantity": 24, "unitCost": 180, "uom": "sq" }
    ]
  }'`}</pre>
        </div>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">In-Page SDK</h2>
        <p className="text-gray-300 mb-3">
          1. Add your origin to the allowlist (Origins tab)<br />
          2. Embed the script and initialize:
        </p>
        <div className="bg-black/50 rounded p-4 overflow-x-auto">
          <pre className="text-sm text-gray-300">{`<script src="${base}/integrate.js"></script>
<script>
  ProBidSDK.init({
    apiBase: '${base}',
    onEstimateCreated: (estimate) => {
      console.log('Estimate created:', estimate);
    }
  });
</script>`}</pre>
        </div>
      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">API Reference</h2>
        <div className="space-y-2 text-sm">
          {[
            { method: "POST", path: "/api/estimates/send", desc: "Create an estimate (requires estimates:write scope)" },
            { method: "GET", path: "/api/v1/estimates", desc: "List estimates (requires estimates:read scope)" },
            { method: "GET", path: "/api/v1/estimates/:id", desc: "Get a specific estimate" },
            { method: "GET", path: "/api/v1/usage", desc: "Get usage stats (requires usage:read scope)" },
            { method: "GET", path: "/api/v1/leads", desc: "List leads (requires leads:read scope)" },
          ].map((ep) => (
            <div key={ep.path} className="flex items-start gap-3 py-2 border-b border-gray-700/50 last:border-0">
              <span className={`shrink-0 text-xs px-2 py-0.5 rounded font-mono font-bold ${ep.method === "POST" ? "bg-orange-600/20 text-orange-400" : "bg-green-600/20 text-green-400"}`}>
                {ep.method}
              </span>
              <code className="text-gray-300 text-sm">{ep.path}</code>
              <span className="text-gray-500 text-sm">{ep.desc}</span>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <a href="/app/developer" className="text-green-400 hover:text-green-300 text-sm">
            Full API documentation &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
