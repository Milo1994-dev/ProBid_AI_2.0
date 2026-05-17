import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Alert } from "../components/ui/Alert";
import { api } from "../api/client";
import { track, generateEventId } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";
import { GuaranteeBlock } from "../components/GuaranteeBlock";
import { useAuth } from "../contexts/AuthContext";

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function planLabel(plan: string): string {
  const labels: Record<string, string> = { free: "Free", pro: "Pro", business: "Business", lifetime: "Lifetime" };
  return labels[plan] ?? plan;
}

export default function BillingPage() {
  const { user, refreshUser } = useAuth();
  const [pdfBadgesSaving, setPdfBadgesSaving] = useState(false);
  const [pdfBadgesError, setPdfBadgesError] = useState("");
  const pdfBadgesEnabled = user?.pdfShowGuaranteeBadges !== false;

  const togglePdfBadges = async (next: boolean) => {
    setPdfBadgesError("");
    setPdfBadgesSaving(true);
    try {
      const res = await api.updatePdfSettings(next);
      if (!res.success) {
        setPdfBadgesError(res.error ?? "Could not update PDF settings.");
      } else {
        await refreshUser();
      }
    } catch (err: any) {
      setPdfBadgesError(err?.apiError ?? err?.message ?? "Could not update PDF settings.");
    } finally {
      setPdfBadgesSaving(false);
    }
  };

  usePageMeta({
    title: "Billing & Plans | ProBid AI",
    description: "Manage your ProBid AI subscription — upgrade to Pro or Business for unlimited estimates.",
    canonical: "https://probidcore.net/app/billing",
  });

  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState("");
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">("monthly");
  const [successPlan] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("success") === "1") {
      const p = params.get("plan") || "pro";
      // Fire the browser-side Purchase Pixel event using the same
      // event_id that the Stripe webhook will replay through CAPI, so
      // Meta dedupes the pair instead of double-counting.
      const eid = params.get("meta_event_id") || undefined;
      track("checkout_success", { plan: p }, eid);
      // Fire any pending A/B conversion (conversion = user reached billing success).
      // paid_converted is handled server-side by the Stripe webhook; this records
      // the signup/intent conversion for experiment-level funnel analysis.
      try {
        const pending = localStorage.getItem("pb_ab_pending");
        if (pending) {
          const { visitorId, experimentKey } = JSON.parse(pending);
          if (visitorId && experimentKey) {
            fetch("/api/ab/convert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ visitorId, experimentKey }),
            }).catch(() => undefined);
          }
          localStorage.removeItem("pb_ab_pending");
        }
      } catch {
        // Non-fatal
      }
      window.history.replaceState({}, "", window.location.pathname);
      return p;
    }
    return null;
  });

  const { data: billing, isLoading, isError } = useQuery({
    queryKey: ["billing"],
    queryFn: () => api.getBillingStatus().then((r) => r.data),
  });

  const handleUpgrade = async (plan: "pro" | "business") => {
    setError("");
    // Mint event_id once, send it to the Pixel `checkout_started` event
    // AND stash it in Stripe metadata via the API call. The webhook will
    // later use the same event_id for the Purchase CAPI event so Meta
    // dedupes browser + server signals.
    const metaEventId = generateEventId();
    track("checkout_started", { plan, interval: billingInterval }, metaEventId);
    track("upgrade_click", { plan, source: "billing_page" });
    setCheckoutLoading(plan);
    try {
      const res = await api.createCheckoutSession(plan, billingInterval, metaEventId);
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else {
        setError("Failed to start checkout. Please try again.");
      }
    } catch (err: any) {
      setError(err?.apiError ?? err?.message ?? "Failed to start checkout. Please try again.");
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handlePortal = async () => {
    setError("");
    setPortalLoading(true);
    window.location.href = "/billing/portal";
  };

  const isPaid = billing?.plan && billing.plan !== "free";
  const isAnnualSubscriber = billing?.interval === "annual";

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-black text-brand-textPrimary mb-2">Billing</h1>
        <p className="text-brand-textMuted mb-8">Manage your subscription and billing.</p>

        {successPlan && isPaid && (
          <div className="mb-6 rounded-2xl border border-brand-green/40 bg-brand-green/10 p-6 text-center">
            <div className="text-4xl mb-3">🎉</div>
            <h2 className="text-xl font-black text-brand-green mb-2">
              Welcome to ProBid AI {successPlan === "business" ? "Business" : "Pro"}!
            </h2>
            <p className="text-brand-textMuted">Your trial is active — you now have unlimited estimates. Go win some jobs!</p>
            <Button className="mt-4" onClick={() => { window.location.href = "/app/estimate/new"; }}>
              Generate Your First Estimate
            </Button>
          </div>
        )}

        {error && <Alert type="error" className="mb-6" onDismiss={() => setError("")}>{error}</Alert>}

        {/* Current Plan */}
        <Card className="mb-6">
          <h2 className="text-lg font-bold text-brand-textPrimary mb-4">Current Plan</h2>
          {isLoading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-6 w-24 bg-brand-border rounded" />
              <div className="h-4 w-40 bg-brand-border rounded" />
            </div>
          ) : isError ? (
            <Alert type="error">Failed to load billing information.</Alert>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-2xl font-black text-brand-textPrimary capitalize">
                    {planLabel(billing?.plan ?? "free")}
                  </span>
                  <Badge variant={isPaid ? "green" : "gray"}>
                    {billing?.status === "active" ? "Active" : billing?.status ?? "Free"}
                  </Badge>
                  {isAnnualSubscriber && (
                    <Badge variant="indigo">Annual</Badge>
                  )}
                </div>
                {billing?.currentPeriodEnd && (
                  <p className="text-sm text-brand-textSubtle">
                    Renews {formatDate(billing.currentPeriodEnd)}
                  </p>
                )}
                {!isPaid && (
                  <p className="text-sm text-brand-textSubtle">Start your 7-day free trial — no charge during trial</p>
                )}
              </div>
              {isPaid && (
                <Button variant="ghost" onClick={handlePortal} loading={portalLoading}>
                  Manage Billing
                </Button>
              )}
            </div>
          )}
        </Card>

        {/* Upgrade options for free users */}
        {!isLoading && !isPaid && (
          <div className="flex flex-col gap-4">
            {/* Social proof strip */}
            <div className="rounded-2xl border border-brand-border bg-brand-card px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex items-center gap-3 flex-1">
                <div className="flex -space-x-2">
                  {["🧱", "🔨", "🪚"].map((icon, i) => (
                    <div
                      key={i}
                      className="w-8 h-8 rounded-full bg-brand-indigo/20 border border-brand-border flex items-center justify-center text-base"
                    >
                      {icon}
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-sm font-bold text-brand-textPrimary">Built by a working contractor</p>
                  <p className="text-xs text-brand-textSubtle">Designed to save evenings on estimates</p>
                </div>
              </div>
              <blockquote className="text-xs text-brand-textMuted italic border-l-2 border-brand-green/40 pl-3 max-w-xs">
                "I built ProBid AI because I was sick of losing my evenings to estimates. Now I generate a full quote from a photo on the drive home."
                <span className="not-italic font-semibold text-brand-textPrimary block mt-1">— Jesse Kirchner, Founder · Kirchner Masonry, Galena, IL</span>
              </blockquote>
            </div>

            <div className="flex items-center justify-between mt-2">
              <h2 className="text-lg font-bold text-brand-textPrimary">Upgrade Your Plan</h2>

              {/* Monthly / Annual toggle */}
              <div className="flex items-center gap-1 bg-brand-card border border-brand-border rounded-lg p-1">
                <button
                  onClick={() => setBillingInterval("monthly")}
                  className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                    billingInterval === "monthly"
                      ? "bg-brand-indigo text-white"
                      : "text-brand-textMuted hover:text-brand-textPrimary"
                  }`}
                >
                  Monthly
                </button>
                <button
                  onClick={() => setBillingInterval("annual")}
                  className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors flex items-center gap-1.5 ${
                    billingInterval === "annual"
                      ? "bg-brand-indigo text-white"
                      : "text-brand-textMuted hover:text-brand-textPrimary"
                  }`}
                >
                  Annual
                  <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${
                    billingInterval === "annual"
                      ? "bg-white/20 text-white"
                      : "bg-brand-green/20 text-brand-green"
                  }`}>
                    Save 20%
                  </span>
                </button>
              </div>
            </div>

            {/* Pro */}
            <Card className="border-brand-indigo/40 relative overflow-hidden">
              <div className="absolute top-0 right-0 bg-brand-green text-brand-bg text-xs font-black px-3 py-1 rounded-bl-xl">
                7-Day Free Trial
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold text-brand-textPrimary">Pro</h3>
                    {billingInterval === "annual" ? (
                      <>
                        <Badge variant="indigo">$240/yr</Badge>
                        <span className="text-xs text-brand-green font-semibold">Save $60</span>
                      </>
                    ) : (
                      <Badge variant="indigo">$25/mo</Badge>
                    )}
                  </div>
                  {billingInterval === "annual" && (
                    <p className="text-xs text-brand-textSubtle mb-2">$20/mo billed annually</p>
                  )}
                  <ul className="text-sm text-brand-textMuted space-y-1">
                    <li>✓ Unlimited estimates</li>
                    <li>✓ Photo analysis</li>
                    <li>✓ Saved history & PDF export</li>
                    <li>✓ Priority support</li>
                  </ul>
                  <p className="text-xs text-brand-green mt-2 font-semibold">
                    Try free for 7 days — no charge until after trial
                  </p>
                </div>
                <Button
                  onClick={() => handleUpgrade("pro")}
                  loading={checkoutLoading === "pro"}
                  className="shrink-0"
                >
                  Start 7-Day Free Trial
                </Button>
              </div>
            </Card>

            {/* Business */}
            <Card className="relative overflow-hidden">
              <div className="absolute top-0 right-0 bg-brand-indigo text-white text-xs font-black px-3 py-1 rounded-bl-xl">
                7-Day Free Trial
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold text-brand-textPrimary">Business</h3>
                    {billingInterval === "annual" ? (
                      <>
                        <Badge variant="green">$948/yr</Badge>
                        <span className="text-xs text-brand-green font-semibold">Save ~$420</span>
                      </>
                    ) : (
                      <Badge variant="green">$55/mo</Badge>
                    )}
                  </div>
                  {billingInterval === "annual" && (
                    <p className="text-xs text-brand-textSubtle mb-2">$79/mo billed annually</p>
                  )}
                  <ul className="text-sm text-brand-textMuted space-y-1">
                    <li>✓ Everything in Pro</li>
                    <li>✓ Team collaboration</li>
                    <li>✓ Procore Trust Engine</li>
                    <li>✓ Custom branding</li>
                    <li>✓ Analytics dashboard</li>
                  </ul>
                  <p className="text-xs text-brand-textSubtle mt-2 font-semibold">
                    Try free for 7 days — no charge until after trial
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => handleUpgrade("business")}
                  loading={checkoutLoading === "business"}
                  className="shrink-0"
                >
                  Start 7-Day Free Trial
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* Paid user - manage */}
        {!isLoading && isPaid && (
          <Alert type="success">
            You're on the {planLabel(billing?.plan ?? "")}{isAnnualSubscriber ? " Annual" : ""} plan. Enjoy unlimited estimates!
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={handlePortal} loading={portalLoading}>
                Manage Subscription & Invoices
              </Button>
            </div>
          </Alert>
        )}

        <div className="mt-8">
          <GuaranteeBlock variant="compact" />
          <p className="text-xs text-slate-500 text-center mt-2">
            <a href="/app/guarantees" className="text-brand-green hover:underline">
              View your guarantee claim status →
            </a>
          </p>
        </div>

        {isPaid && (
          <Card className="mt-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Show guarantee badges on estimate PDFs
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Adds a "Backed by ProBid's Triple Guarantee" trust bar to every estimate PDF you export.
                  Helps clients see the speed, win-jobs, and money-back promises behind your estimate.
                </p>
                {pdfBadgesError && (
                  <p className="text-xs text-red-600 mt-2">{pdfBadgesError}</p>
                )}
              </div>
              <label className="inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={pdfBadgesEnabled}
                  disabled={pdfBadgesSaving}
                  onChange={(e) => togglePdfBadges(e.target.checked)}
                />
                <div className="w-11 h-6 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all relative peer-checked:bg-brand-green" />
              </label>
            </div>
          </Card>
        )}
      </div>
    </Layout>
  );
}
