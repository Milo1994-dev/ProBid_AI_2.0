import React from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { api, ProcoreConnection, ProcoreCompany, ProcoreProject, ProcoreMetrics, Entitlements } from "../api/client";
import { usePageMeta } from "../hooks/usePageMeta";
import { track } from "../analytics";
import { useAuth } from "../contexts/AuthContext";

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "Never";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatUSD(val: number | null | undefined): string {
  if (val == null) return "—";
  return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function MetricCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl p-5 border ${highlight ? "border-brand-green/40 bg-brand-green/5" : "border-brand-border bg-brand-card"}`}>
      <p className="text-xs text-brand-textSubtle mb-1">{label}</p>
      <p className={`text-2xl font-black ${highlight ? "text-brand-green" : "text-brand-textPrimary"}`}>{value}</p>
      {sub && <p className="text-xs text-brand-textMuted mt-1">{sub}</p>}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-64 bg-brand-border rounded-xl" />
      <div className="h-48 w-full bg-brand-border rounded-2xl" />
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-brand-border rounded-2xl" />)}
      </div>
    </div>
  );
}

function getAbVariant(userId?: string): "A" | "B" {
  if (!userId) return "A";
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2 === 0 ? "A" : "B";
}

const AB_VARIANTS = {
  A: {
    headline: "Business Plan Required",
    description:
      "The Procore Trust Engine is an exclusive Business-tier feature. Upgrade to connect your Procore account, validate your estimate accuracy against real project data, and generate proof reports for your clients.",
    cta: "Upgrade to Business — $55/mo",
    subtext: "Includes team seats, Procore integration, and priority support",
  },
  B: {
    headline: "Prove Your Accuracy. Win More Jobs.",
    description:
      "Verify your estimates against your own Procore project history. The Trust Engine generates shadow estimates from past jobs and produces proof reports you can hand to clients alongside every bid.",
    cta: "Start 7-Day Free Trial",
    subtext: "No charge for 7 days — cancel anytime. Includes full Procore integration.",
  },
};

function BusinessTierGate({ currentPlan, userId }: { currentPlan?: string; userId?: string }) {
  const navigate = useNavigate();
  const tracked = React.useRef(false);
  const variant = getAbVariant(userId);
  const copy = AB_VARIANTS[variant];

  React.useEffect(() => {
    if (!tracked.current) {
      track("procore_gate_shown", { currentPlan: currentPlan ?? "unknown", variant });
      tracked.current = true;
    }
  }, [currentPlan, variant]);

  const handleUpgradeClick = () => {
    track("procore_gate_upgrade_clicked", { currentPlan: currentPlan ?? "unknown", variant });
    navigate("/app/billing");
  };

  return (
    <div className="space-y-8">
      <div className="rounded-2xl border border-brand-indigo/30 bg-gradient-to-br from-brand-indigo/10 via-brand-card to-brand-card p-8 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-2xl font-black text-brand-textPrimary mb-3">{copy.headline}</h2>
        <p className="text-brand-textMuted text-sm max-w-lg mx-auto mb-6">{copy.description}</p>
        <Button onClick={handleUpgradeClick} size="md">
          {copy.cta}
        </Button>
        <p className="text-xs text-brand-textSubtle mt-3">{copy.subtext}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            icon: "🧪",
            title: "Shadow Backtesting",
            desc: "ProBid AI estimates your closed jobs without seeing the actual costs, then we compare.",
          },
          {
            icon: "📊",
            title: "Accuracy Reports",
            desc: "See your median error rate, confidence calibration, and time saved — verified by Procore data.",
          },
          {
            icon: "📄",
            title: "Proof Assets",
            desc: "Download a branded PDF proof you can share with clients to demonstrate estimate accuracy.",
          },
        ].map((f) => (
          <Card key={f.title} padding="sm" className="text-center opacity-60">
            <div className="text-3xl mb-3">{f.icon}</div>
            <h3 className="text-sm font-bold text-brand-textPrimary mb-2">{f.title}</h3>
            <p className="text-xs text-brand-textMuted">{f.desc}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

function NotConfiguredState() {
  return (
    <Card className="text-center py-12">
      <div className="text-4xl mb-4">⚙️</div>
      <h2 className="text-xl font-bold text-brand-textPrimary mb-3">Procore Integration Not Configured</h2>
      <p className="text-brand-textMuted text-sm max-w-md mx-auto mb-6">
        The Trust Engine requires Procore API credentials. Set <code className="bg-brand-border px-1 rounded text-xs">PROCORE_CLIENT_ID</code> and <code className="bg-brand-border px-1 rounded text-xs">PROCORE_CLIENT_SECRET</code> environment variables to enable this feature.
      </p>
      <p className="text-brand-textSubtle text-xs">Contact your administrator or refer to the deployment documentation.</p>
    </Card>
  );
}

function NotConnectedState({ onConnect, connecting }: { onConnect: () => void; connecting: boolean }) {
  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="rounded-2xl border border-brand-indigo/30 bg-gradient-to-br from-brand-indigo/10 via-brand-card to-brand-card p-8 text-center">
        <div className="text-5xl mb-4">🔗</div>
        <h2 className="text-2xl font-black text-brand-textPrimary mb-3">Connect Your Procore Account</h2>
        <p className="text-brand-textMuted text-sm max-w-lg mx-auto mb-6">
          The Trust Engine connects to your Procore account (read-only) and runs ProBid AI against your closed projects —
          generating a verified accuracy report backed by your own historical job data.
        </p>
        <Button onClick={onConnect} disabled={connecting} size="md">
          {connecting ? "Redirecting to Procore…" : "Connect Procore"}
        </Button>
        <p className="text-xs text-brand-textSubtle mt-3">Read-only access · No data is modified in Procore</p>
      </div>

      {/* Feature cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            icon: "🧪",
            title: "Shadow Backtesting",
            desc: "ProBid AI estimates your closed jobs without seeing the actual costs, then we compare.",
          },
          {
            icon: "📊",
            title: "Accuracy Reports",
            desc: "See your median error rate, confidence calibration, and time saved — verified by Procore data.",
          },
          {
            icon: "📄",
            title: "Proof Assets",
            desc: "Download a branded PDF proof you can share with clients to demonstrate estimate accuracy.",
          },
        ].map((f) => (
          <Card key={f.title} padding="sm" className="text-center">
            <div className="text-3xl mb-3">{f.icon}</div>
            <h3 className="text-sm font-bold text-brand-textPrimary mb-2">{f.title}</h3>
            <p className="text-xs text-brand-textMuted">{f.desc}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

function SelectingState({ connectionId }: { connectionId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedCompany, setSelectedCompany] = React.useState<ProcoreCompany | null>(null);
  const [selectError, setSelectError] = React.useState("");

  const companiesQuery = useQuery({
    queryKey: ["procore-companies", connectionId],
    queryFn: () => api.getProcoreCompanies(connectionId).then((r) => r.data),
    retry: 1,
  });

  const selectMutation = useMutation({
    mutationFn: (company: ProcoreCompany) =>
      api.selectProcoreCompany(connectionId, String(company.id), company.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["procore-connections"] });
      navigate("/app/procore?connected=1", { replace: true });
    },
    onError: (err: Error) => {
      setSelectError(err.message ?? "Failed to connect company");
    },
  });

  return (
    <Card className="max-w-lg mx-auto">
      <h2 className="text-xl font-bold text-brand-textPrimary mb-2">Select Your Procore Company</h2>
      <p className="text-brand-textMuted text-sm mb-6">Choose the company you want to analyze.</p>

      {companiesQuery.isLoading && (
        <div className="space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-brand-border rounded-xl" />)}
        </div>
      )}

      {companiesQuery.isError && (
        <Alert type="error">Failed to load companies. Please go back and try again.</Alert>
      )}

      {companiesQuery.data?.companies && companiesQuery.data.companies.length === 0 && (
        <Alert type="warning">No companies found in your Procore account.</Alert>
      )}

      {companiesQuery.data?.companies && companiesQuery.data.companies.length > 0 && (
        <div className="space-y-3 mb-6">
          {companiesQuery.data.companies.map((company) => (
            <button
              key={company.id}
              onClick={() => setSelectedCompany(company)}
              className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                selectedCompany?.id === company.id
                  ? "border-brand-green bg-brand-green/10 text-brand-textPrimary"
                  : "border-brand-border bg-brand-card text-brand-textMuted hover:border-brand-green/50 hover:bg-brand-green/5"
              }`}
            >
              <span className="font-semibold text-sm">{company.name}</span>
              {!company.is_active && (
                <span className="ml-2 text-xs text-brand-textSubtle">(inactive)</span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectError && <Alert type="error" className="mb-4">{selectError}</Alert>}

      <div className="flex gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/app/procore", { replace: true })}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!selectedCompany || selectMutation.isPending}
          onClick={() => selectedCompany && selectMutation.mutate(selectedCompany)}
        >
          {selectMutation.isPending ? "Connecting…" : "Connect Company"}
        </Button>
      </div>
    </Card>
  );
}

function ProjectsTable({ projects }: { projects: ProcoreProject[] }) {
  if (projects.length === 0) {
    return (
      <div className="text-center py-8 text-brand-textMuted text-sm">
        No closed projects synced yet. Click "Sync Projects" to import your Procore data.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-brand-border">
            <th className="text-left py-2 pr-4 text-xs font-semibold text-brand-textSubtle">Project</th>
            <th className="text-left py-2 pr-4 text-xs font-semibold text-brand-textSubtle">Location</th>
            <th className="text-left py-2 pr-4 text-xs font-semibold text-brand-textSubtle">Sync Status</th>
            <th className="text-right py-2 pr-4 text-xs font-semibold text-brand-textSubtle">Budget</th>
            <th className="text-right py-2 text-xs font-semibold text-brand-textSubtle">Actual</th>
          </tr>
        </thead>
        <tbody>
          {projects.slice(0, 20).map((p) => (
            <tr key={p.id} className="border-b border-brand-border/50 last:border-0">
              <td className="py-2.5 pr-4 text-brand-textPrimary font-medium max-w-[180px] truncate">{p.name}</td>
              <td className="py-2.5 pr-4 text-brand-textMuted text-xs">
                {[p.city, p.state].filter(Boolean).join(", ") || "—"}
              </td>
              <td className="py-2.5 pr-4">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  p.status === "synced" ? "bg-green-900/40 text-green-300" :
                  p.status === "estimated" ? "bg-indigo-900/40 text-indigo-300" :
                  "bg-brand-border text-brand-textSubtle"
                }`}>
                  {p.status || "pending"}
                </span>
              </td>
              <td className="py-2.5 pr-4 text-right text-brand-textMuted text-xs">{formatUSD(p.originalEstimateUsd)}</td>
              <td className="py-2.5 text-right text-brand-textMuted text-xs">{formatUSD(p.actualCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {projects.length > 20 && (
        <p className="text-xs text-brand-textSubtle mt-2 text-center">
          Showing 20 of {projects.length} projects
        </p>
      )}
    </div>
  );
}

function ConnectedState({ connection }: { connection: ProcoreConnection }) {
  const queryClient = useQueryClient();
  const [actionMsg, setActionMsg] = React.useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showDisconnect, setShowDisconnect] = React.useState(false);

  const projectsQuery = useQuery({
    queryKey: ["procore-projects", connection.id],
    queryFn: () => api.getProcoreProjects(connection.id).then((r) => r.data),
  });

  const metricsQuery = useQuery({
    queryKey: ["procore-metrics", connection.id],
    queryFn: () => api.getProcoreMetrics(connection.id).then((r) => r.data),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncProcoreProjects(connection.id),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["procore-projects", connection.id] });
      queryClient.invalidateQueries({ queryKey: ["procore-connections"] });
      setActionMsg({ type: "success", text: `Synced ${res.data?.syncedProjects ?? 0} projects.` });
    },
    onError: (err: Error) => setActionMsg({ type: "error", text: err.message }),
  });

  const shadowMutation = useMutation({
    mutationFn: () => api.runShadowEstimates(connection.id),
    onSuccess: (res) => {
      setActionMsg({ type: "success", text: `Generated ${res.data?.processed ?? 0} shadow estimates.` });
    },
    onError: (err: Error) => setActionMsg({ type: "error", text: err.message }),
  });

  const metricsMutation = useMutation({
    mutationFn: () => api.calculateProcoreMetrics(connection.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["procore-metrics", connection.id] });
      setActionMsg({ type: "success", text: "Metrics calculated successfully." });
    },
    onError: (err: Error) => setActionMsg({ type: "error", text: err.message }),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.disconnectProcore(connection.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["procore-connections"] });
    },
    onError: (err: Error) => setActionMsg({ type: "error", text: err.message }),
  });

  const [consentOptimistic, setConsentOptimistic] = React.useState<boolean | null>(null);

  const consentMutation = useMutation({
    mutationFn: (include: boolean) => api.updateBenchmarkConsent(connection.id, include),
    onMutate: (include) => setConsentOptimistic(include),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["procore-connections"] });
    },
    onError: (err: Error) => {
      setConsentOptimistic(null);
      setActionMsg({ type: "error", text: err.message });
    },
    onSettled: () => setConsentOptimistic(null),
  });

  const metrics: ProcoreMetrics = metricsQuery.data?.metrics ?? {};
  const hasMetrics = !!(metrics.accuracy_error_pct || metrics.confidence_calibration);
  const isWorking = syncMutation.isPending || shadowMutation.isPending || metricsMutation.isPending;
  const consentEnabled = consentOptimistic !== null ? consentOptimistic : connection.includeInPublicBenchmarks === 1;

  return (
    <div className="space-y-6">
      {/* Connection status */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-green/10 flex items-center justify-center text-xl">🔗</div>
            <div>
              <p className="font-bold text-brand-textPrimary">{connection.companyName ?? "Procore Company"}</p>
              <p className="text-xs text-brand-textSubtle">
                Last sync: {formatDate(connection.lastSyncAt)} · {projectsQuery.data?.projects?.length ?? 0} projects
              </p>
            </div>
          </div>
          <Badge variant="green">Connected</Badge>
        </div>
      </Card>

      {/* Action message */}
      {actionMsg && (
        <Alert type={actionMsg.type} onDismiss={() => setActionMsg(null)}>
          {actionMsg.text}
        </Alert>
      )}

      {/* Metrics */}
      {hasMetrics && (
        <div>
          <h2 className="text-base font-bold text-brand-textPrimary mb-3">Accuracy Results</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard
              label="Median Estimate Error"
              value={metrics.accuracy_error_pct ? `${metrics.accuracy_error_pct.value.toFixed(1)}%` : "—"}
              sub={`${metrics.accuracy_error_pct?.sampleSize ?? 0} projects`}
              highlight
            />
            <MetricCard
              label="Within Confidence Band"
              value={metrics.confidence_calibration ? `${metrics.confidence_calibration.value.toFixed(0)}%` : "—"}
              sub="of actuals within band"
            />
            <MetricCard
              label="Time Saved / Estimate"
              value={metrics.time_saved_hours ? `${metrics.time_saved_hours.value.toFixed(1)}h` : "—"}
              sub="vs. manual estimation"
            />
            <MetricCard
              label="P50 Error (Median)"
              value={
                metrics.accuracy_error_pct?.metadata?.p50 != null
                  ? `${metrics.accuracy_error_pct.metadata.p50.toFixed(1)}%`
                  : "—"
              }
              sub="50th percentile"
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <Card>
        <h2 className="text-base font-bold text-brand-textPrimary mb-4">Run Analysis</h2>
        <div className="flex flex-wrap gap-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={isWorking}
            onClick={() => syncMutation.mutate()}
          >
            {syncMutation.isPending ? "Syncing…" : "Sync Projects"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isWorking || (projectsQuery.data?.projects?.length ?? 0) === 0}
            onClick={() => shadowMutation.mutate()}
          >
            {shadowMutation.isPending ? "Generating… (may take a minute)" : "Run Shadow Estimates"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isWorking}
            onClick={() => metricsMutation.mutate()}
          >
            {metricsMutation.isPending ? "Calculating…" : "Calculate Metrics"}
          </Button>
        </div>
        <p className="text-xs text-brand-textSubtle mt-3">
          Run in order: Sync → Shadow Estimates → Calculate Metrics → Download Report
        </p>
      </Card>

      {/* Download reports */}
      <Card>
        <h2 className="text-base font-bold text-brand-textPrimary mb-4">Download Reports</h2>
        <div className="flex flex-wrap gap-3">
          <a
            href={`/api/procore/report/pdf?connection=${encodeURIComponent(connection.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl bg-brand-green text-brand-bg hover:bg-brand-green/90 transition-colors"
          >
            📄 Download PDF Report
          </a>
          <a
            href={`/api/procore/report/csv?connection=${encodeURIComponent(connection.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl border border-brand-border bg-brand-card text-brand-textMuted hover:bg-brand-border/50 transition-colors"
          >
            📊 Export CSV
          </a>
        </div>
        <p className="text-xs text-brand-textSubtle mt-3">
          PDF report requires shadow estimates and metrics to be generated first.
        </p>
      </Card>

      {/* Projects table */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-brand-textPrimary">Synced Projects</h2>
          {projectsQuery.isLoading && <div className="w-4 h-4 border-2 border-brand-indigo border-t-transparent rounded-full animate-spin" />}
        </div>
        {projectsQuery.isError ? (
          <Alert type="error">Failed to load projects.</Alert>
        ) : (
          <ProjectsTable projects={projectsQuery.data?.projects ?? []} />
        )}
      </Card>

      {/* Anonymous benchmark opt-in */}
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-base font-bold text-brand-textPrimary mb-1">Contribute to Public Accuracy Benchmarks</h2>
            <p className="text-xs text-brand-textMuted leading-relaxed max-w-lg">
              Allow ProBid AI to include your closed project data — anonymized and aggregated — in the{" "}
              <a href="/accuracy" target="_blank" rel="noopener noreferrer" className="text-brand-green hover:underline">
                public accuracy benchmarks
              </a>
              . No project names, company names, or individual costs are ever shown publicly.
              Only aggregate statistics (median error, sample size) are published.
              You can opt out at any time.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={consentEnabled}
            disabled={consentMutation.isPending}
            onClick={() => consentMutation.mutate(!consentEnabled)}
            className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-green/50 disabled:opacity-50 ${
              consentEnabled ? "bg-brand-green" : "bg-brand-border"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                consentEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        {consentEnabled && (
          <p className="mt-3 text-xs text-brand-green font-medium">
            ✓ Opted in — your closed project outcomes contribute to the public benchmark dataset
          </p>
        )}
      </Card>

      {/* Disconnect */}
      <div className="pt-2">
        {!showDisconnect ? (
          <button
            onClick={() => setShowDisconnect(true)}
            className="text-xs text-brand-textSubtle hover:text-red-400 transition-colors"
          >
            Disconnect Procore account
          </button>
        ) : (
          <Card className="border-red-500/30 bg-red-500/5">
            <p className="text-sm font-semibold text-brand-textPrimary mb-2">Disconnect Procore?</p>
            <p className="text-xs text-brand-textMuted mb-4">
              Your synced projects and reports will remain, but the live connection will be removed.
            </p>
            <div className="flex gap-3">
              <Button size="sm" variant="ghost" onClick={() => setShowDisconnect(false)}>Cancel</Button>
              <button
                disabled={disconnectMutation.isPending}
                onClick={() => disconnectMutation.mutate()}
                className="text-sm font-semibold px-4 py-2 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
              >
                {disconnectMutation.isPending ? "Disconnecting…" : "Yes, Disconnect"}
              </button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function ProcorePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [connectError, setConnectError] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);
  const { user } = useAuth();

  usePageMeta({
    title: "Trust Engine | ProBid AI",
    description: "Connect your Procore account to verify ProBid AI accuracy against your historical job data.",
    canonical: "https://probidcore.net/app/procore",
  });

  const urlError = searchParams.get("error");
  const selectingId = searchParams.get("selecting");
  const justConnected = searchParams.get("connected") === "1";

  const entitlementsQuery = useQuery({
    queryKey: ["entitlements"],
    queryFn: () => api.getEntitlements().then((r) => r.data),
  });

  const hasProcoreAccess = entitlementsQuery.data?.procore === true;

  const configQuery = useQuery({
    queryKey: ["procore-config"],
    queryFn: () => api.getProcoreConfig().then((r) => r.data),
    enabled: hasProcoreAccess,
  });

  const connectionsQuery = useQuery({
    queryKey: ["procore-connections"],
    queryFn: () => api.getProcoreConnections().then((r) => r.data),
    enabled: hasProcoreAccess && configQuery.data?.configured === true,
  });

  const handleConnect = async () => {
    setConnecting(true);
    setConnectError("");
    try {
      const res = await api.startProcoreAuth();
      if (res.data?.authUrl) {
        window.location.href = res.data.authUrl;
      } else {
        setConnectError("Failed to start Procore authorization.");
        setConnecting(false);
      }
    } catch (err) {
      setConnectError((err as Error).message ?? "Failed to connect to Procore.");
      setConnecting(false);
    }
  };

  const activeConnections = connectionsQuery.data?.connections?.filter(
    (c) => c.status === "active"
  ) ?? [];
  const expiredConnections = connectionsQuery.data?.connections?.filter(
    (c) => c.status === "expired"
  ) ?? [];

  const urlReason = searchParams.get("reason");

  const tokenExchangeReasonMessages: Record<string, string> = {
    invalid_client: "Procore rejected the app credentials. Please contact your administrator to verify the Client ID and Secret are correct.",
    redirect_uri_mismatch: "The redirect URI does not match what is configured in the Procore Developer Portal. Please contact your administrator to correct the redirect URI settings.",
    expired_code: "The authorization code has expired. Please try connecting again.",
  };

  const errorMessages: Record<string, string> = {
    oauth_denied: "Procore authorization was denied. Please try again.",
    invalid_callback: "Invalid OAuth callback. Please try again.",
    invalid_state: "Session expired during OAuth. Please try again.",
    token_exchange_failed:
      (urlReason && tokenExchangeReasonMessages[urlReason]) ||
      "Failed to exchange authorization code. Please try again.",
    missing_connection: "Missing connection ID. Please try again.",
    invalid_connection: "Invalid connection. Please try again.",
  };

  return (
    <Layout>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link to="/app" className="text-xs text-brand-textSubtle hover:text-brand-textMuted transition-colors">
              Dashboard
            </Link>
            <span className="text-brand-textSubtle text-xs">›</span>
            <span className="text-xs text-brand-textPrimary">Trust Engine</span>
          </div>
          <h1 className="text-3xl font-black text-brand-textPrimary">Procore Trust Engine</h1>
          <p className="text-brand-textMuted mt-1 text-sm">
            Verify ProBid AI accuracy against your real job history
          </p>
        </div>
      </div>

      {/* URL error banner */}
      {urlError && (
        <Alert type="error" className="mb-6">
          {errorMessages[urlError] ?? `Error: ${urlError}`}
        </Alert>
      )}

      {/* Connection success banner */}
      {justConnected && !urlError && (
        <Alert type="success" className="mb-6">
          Procore connected successfully! Sync your projects to get started.
        </Alert>
      )}

      {/* Connect error */}
      {connectError && (
        <Alert type="error" className="mb-6">{connectError}</Alert>
      )}

      {/* Main content */}
      {entitlementsQuery.isLoading ? (
        <LoadingSkeleton />
      ) : entitlementsQuery.isError ? (
        <Alert type="error">Failed to load your subscription status. Please refresh the page and try again.</Alert>
      ) : !hasProcoreAccess ? (
        <BusinessTierGate currentPlan={entitlementsQuery.data?.plan} userId={user?.email} />
      ) : configQuery.isLoading || connectionsQuery.isLoading ? (
        <LoadingSkeleton />
      ) : configQuery.isError ? (
        <Alert type="error">Failed to load Procore configuration.</Alert>
      ) : !configQuery.data?.configured ? (
        <NotConfiguredState />
      ) : selectingId ? (
        <SelectingState connectionId={selectingId} />
      ) : activeConnections.length > 0 ? (
        <ConnectedState connection={activeConnections[0]} />
      ) : expiredConnections.length > 0 ? (
        <div className="space-y-6">
          <Alert type="warning">
            Your Procore connection has expired. Please reconnect to continue using the Trust Engine.
          </Alert>
          <NotConnectedState onConnect={handleConnect} connecting={connecting} />
        </div>
      ) : (
        <NotConnectedState onConnect={handleConnect} connecting={connecting} />
      )}
    </Layout>
  );
}
