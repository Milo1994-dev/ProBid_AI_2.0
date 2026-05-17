import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { Layout } from "../components/layout/Layout";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { StatTile, StatTileSkeleton } from "../components/ui/StatTile";
import { Badge } from "../components/ui/Badge";
import { Alert } from "../components/ui/Alert";
import { UpgradeModal } from "../components/ui/UpgradeModal";
import { api, Estimate } from "../api/client";
import { track } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatCurrency(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  usePageMeta({
    title: "Dashboard | ProBid AI",
    description: "Your ProBid AI dashboard — generate estimates, track usage, and manage your account.",
    canonical: "https://probidcore.net/app",
  });

  const [showUpgradeModal, setShowUpgradeModal] = React.useState(false);

  const usageQuery = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.getUsage().then((r) => r.data),
  });

  const estimatesQuery = useQuery({
    queryKey: ["estimates", 1],
    queryFn: () => api.getEstimates(1).then((r) => r.data),
  });

  const billingQuery = useQuery({
    queryKey: ["billing"],
    queryFn: () => api.getBillingStatus().then((r) => r.data),
  });

  const usage = usageQuery.data;
  const recentEstimates: Estimate[] = estimatesQuery.data?.estimates?.slice(0, 5) ?? [];
  const billing = billingQuery.data;

  const isFree = billing?.plan === "free";
  const usedCount = usage?.used ?? 0;
  const limitCount = usage?.limit ?? 2;
  const pct = usage?.isUnlimited ? 100 : Math.min(100, Math.round((usedCount / limitCount) * 100));
  const allUsed = !usage?.isUnlimited && usedCount >= limitCount;

  const totalEstimates = estimatesQuery.data?.total ?? 0;
  const timeSavedHours = Math.round(totalEstimates * 0.75);
  const laborRate = 65;
  const estimatedValueSaved = timeSavedHours * laborRate;

  return (
    <Layout>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-black text-brand-textPrimary">Dashboard</h1>
          <p className="text-brand-textMuted mt-1 text-sm">{user?.email}</p>
        </div>
        <Button onClick={() => navigate("/app/estimate/new")} size="md">
          + New Estimate
        </Button>
      </div>

      {!estimatesQuery.isLoading && recentEstimates.length === 0 && (
        <div className="mb-8 rounded-2xl border border-brand-green/30 bg-gradient-to-br from-brand-green/10 via-brand-card to-brand-card p-6">
          <div className="flex flex-col sm:flex-row gap-6 items-start sm:items-center">
            <div className="text-4xl shrink-0">🏗️</div>
            <div className="flex-1">
              <h2 className="text-lg font-black text-brand-textPrimary mb-1">Welcome to ProBid AI!</h2>
              <p className="text-sm text-brand-textMuted mb-4">
                Generate your first professional estimate — describe a job or upload a photo and let AI handle the rest.
              </p>
              <Button onClick={() => navigate("/app/estimate/new")} size="sm">
                Create Your First Estimate
              </Button>
            </div>
          </div>
        </div>
      )}

      {isFree && !usageQuery.isLoading && limitCount > 0 && usedCount === limitCount - 1 && (
        <div className="mb-6 flex items-start gap-3 px-5 py-4 rounded-2xl bg-amber-500/10 border border-amber-500/30">
          <span className="text-xl mt-0.5 shrink-0">⚠️</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-amber-400 mb-0.5">You have 1 free estimate left</p>
            <p className="text-xs text-amber-400/80">
              <Link to="/app/billing" className="underline font-semibold hover:no-underline">Upgrade to Pro for unlimited</Link>
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {usageQuery.isLoading ? (
          <><StatTileSkeleton /><StatTileSkeleton /><StatTileSkeleton /><StatTileSkeleton /></>
        ) : usageQuery.isError ? (
          <div className="col-span-4"><Alert type="error">Failed to load usage data.</Alert></div>
        ) : (
          <>
            <StatTile
              label="Estimates"
              value={usage?.isUnlimited ? `${totalEstimates}` : `${usedCount} / ${limitCount}`}
              sub={usage?.isUnlimited ? "Unlimited plan" : "Free lifetime total"}
              icon="📊"
            />
            <StatTile
              label="Current Plan"
              value={(billing?.plan ?? "free").charAt(0).toUpperCase() + (billing?.plan ?? "free").slice(1)}
              sub={billing?.currentPeriodEnd ? `Renews ${formatDate(billing.currentPeriodEnd * 1000)}` : "No active subscription"}
              icon="💳"
              highlight={billing?.plan !== "free"}
            />
            <StatTile
              label="Time Saved"
              value={`${timeSavedHours}h`}
              sub={`${totalEstimates} estimates × 45 min each`}
              icon="⏱️"
              highlight={timeSavedHours > 0}
            />
            <StatTile
              label="Value of Time Saved"
              value={estimatedValueSaved > 0 ? formatCurrency(estimatedValueSaved) : "$0"}
              sub={`${timeSavedHours}h × $${laborRate}/hr labor rate`}
              icon="💰"
              highlight={estimatedValueSaved > 0}
            />
          </>
        )}
      </div>

      {totalEstimates > 0 && timeSavedHours > 0 && (
        <div className="mb-8 rounded-2xl bg-gradient-to-r from-brand-green/10 via-brand-card to-brand-indigo/10 border border-brand-green/20 p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              <p className="text-sm font-bold text-brand-textPrimary mb-1">
                ProBid AI has saved you {timeSavedHours} hours so far
              </p>
              <p className="text-xs text-brand-textMuted">
                That's {Math.round(timeSavedHours / 8)} full work days you spent on the job site instead of behind a desk.
                {isFree && " Upgrade to Pro for unlimited estimates and keep the momentum going."}
              </p>
            </div>
            {isFree ? (
              <Button size="sm" className="shrink-0" onClick={() => { track("roi_banner_upgrade_clicked"); setShowUpgradeModal(true); }}>
                Upgrade to Pro
              </Button>
            ) : (
              <Button size="sm" className="shrink-0" onClick={() => navigate("/app/estimate/new")}>
                Create Estimate
              </Button>
            )}
          </div>
        </div>
      )}

      {isFree && !usageQuery.isLoading && (
        <Card className="mb-8 border-brand-indigo/30">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-semibold text-brand-textPrimary">
                  {usage?.isUnlimited ? "Unlimited estimates" : limitCount > 0 ? `${usedCount} / ${limitCount} free estimates used` : "Pay-as-you-go or upgrade to Pro"}
                </p>
                {!usage?.isUnlimited && (
                  <p className="text-xs text-brand-textSubtle">
                    {allUsed ? "Limit reached" : `${limitCount - usedCount} remaining`}
                  </p>
                )}
              </div>
              {!usage?.isUnlimited && (
                <div className="w-full h-2 bg-brand-border rounded-full overflow-hidden mb-3">
                  <div className={`h-full rounded-full transition-all ${allUsed ? "bg-red-500" : "bg-brand-indigo"}`} style={{ width: `${pct}%` }} />
                </div>
              )}
              <p className="text-xs text-brand-textSubtle">
                Upgrade to Pro — unlimited estimates, PDF export, and priority support.
              </p>
            </div>
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => { track("dashboard_upgrade_cta_clicked", {}); setShowUpgradeModal(true); }}
            >
              Upgrade to Pro
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: "New Estimate", icon: "⚡", href: "/app/estimate/new" },
          { label: "Estimate History", icon: "📜", href: "/app/history" },
          { label: "Billing", icon: "💳", href: "/app/billing" },
          { label: "Referral Program", icon: "🤝", href: "/app/affiliate" },
        ].map((a) => (
          <Link key={a.label} to={a.href}>
            <Card hover padding="sm" className="text-center h-full flex flex-col items-center justify-center gap-2 py-4">
              <span className="text-2xl">{a.icon}</span>
              <span className="text-xs text-brand-textMuted font-medium">{a.label}</span>
            </Card>
          </Link>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-brand-textPrimary">Saved Estimates</h2>
          {recentEstimates.length > 0 && (
            <Link to="/app/history" className="text-sm text-brand-green hover:underline">View all</Link>
          )}
        </div>

        {estimatesQuery.isLoading ? (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} padding="sm">
                <div className="animate-pulse flex gap-4 items-center">
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-brand-border rounded w-2/3" />
                    <div className="h-3 bg-brand-border rounded w-1/3" />
                  </div>
                  <div className="h-8 w-20 bg-brand-border rounded-lg" />
                </div>
              </Card>
            ))}
          </div>
        ) : estimatesQuery.isError ? (
          <Alert type="error">Failed to load estimates.</Alert>
        ) : recentEstimates.length === 0 ? (
          <Card padding="lg" className="text-center">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-brand-textMuted font-medium mb-2">No saved estimates yet</p>
            <p className="text-brand-textSubtle text-sm mb-4">Start your next estimate to see it here. Reuse previous projects anytime.</p>
            <Button onClick={() => navigate("/app/estimate/new")}>Start Your Next Estimate</Button>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {recentEstimates.map((est) => (
              <Link key={est.id} to={`/app/estimates/${est.id}`}>
                <Card hover padding="sm" className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-brand-textPrimary truncate capitalize">
                      {est.jobType}
                    </p>
                    <p className="text-xs text-brand-textSubtle mt-0.5">
                      {formatDate(est.createdAt)} · {est.market}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="indigo">View</Badge>
                  </div>
                </Card>
              </Link>
            ))}
            <div className="pt-2 text-center">
              <Button variant="ghost" size="sm" onClick={() => navigate("/app/estimate/new")}>
                + New Estimate
              </Button>
            </div>
          </div>
        )}
      </div>

      <UpgradeModal open={showUpgradeModal} onClose={() => setShowUpgradeModal(false)} />
    </Layout>
  );
}
