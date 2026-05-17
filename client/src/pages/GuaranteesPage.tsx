import React, { useEffect, useState } from "react";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { usePageMeta } from "../hooks/usePageMeta";
import { api } from "../api/client";

type GuaranteeType = "speed" | "win_jobs" | "money_back";

interface EligibilityEntry {
  eligible: boolean;
  reasons: string[];
  alreadyClaimed: boolean;
  info: {
    title: string;
    description: string;
    terms: string;
    claimWindow: string;
  };
}

interface ClaimRecord {
  id: string;
  guarantee_type: string;
  status: string;
  eligibility_verdict: string;
  resolution: string | null;
  account_credit_cents: number;
  stripe_refund_id: string | null;
  requested_at: number;
  resolved_at: number | null;
}

const TYPE_LABELS: Record<string, string> = {
  speed: "60-Second Speed Guarantee",
  win_jobs: "Win-Jobs Guarantee",
  money_back: "30-Day Money-Back",
};

const TYPE_ICONS: Record<string, string> = {
  speed: "⚡",
  win_jobs: "🏆",
  money_back: "↩️",
};

const STATUS_COLORS: Record<string, "green" | "yellow" | "red" | "blue"> = {
  approved: "green",
  pending: "yellow",
  denied: "red",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "blue";
  const labels: Record<string, string> = { approved: "Approved", pending: "Under Review", denied: "Denied" };
  return <Badge variant={color}>{labels[status] ?? status}</Badge>;
}

export default function GuaranteesPage() {
  usePageMeta({
    title: "My Guarantees | ProBid AI",
    description: "Check your eligibility and submit claims for ProBid's three ironclad guarantees.",
    canonical: "https://probidcore.net/app/guarantees",
  });

  const [eligibility, setEligibility] = useState<Record<GuaranteeType, EligibilityEntry> | null>(null);
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<GuaranteeType | null>(null);
  const [claimResult, setClaimResult] = useState<{ type: GuaranteeType; success: boolean; message: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/guarantees/eligibility").then(r => r.json()),
      fetch("/api/guarantees/claims").then(r => r.json()),
    ])
      .then(([elig, claimsRes]) => {
        if (elig.success) setEligibility(elig.data);
        if (claimsRes.success) setClaims(claimsRes.data.claims);
      })
      .catch(() => setError("Failed to load guarantee data. Please refresh."))
      .finally(() => setLoading(false));
  }, []);

  const handleClaim = async (type: GuaranteeType) => {
    setClaiming(type);
    setClaimResult(null);
    setError("");
    try {
      const res = await fetch("/api/guarantees/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const body = await res.json();
      if (body.success) {
        const statusMsg =
          body.data.status === "approved"
            ? `Claim approved! ${body.data.resolution}`
            : body.data.status === "pending"
              ? "Your claim is under review. We'll email you within 1 business day."
              : `Claim could not be approved: ${body.data.resolution}`;
        setClaimResult({ type, success: body.data.status !== "denied", message: statusMsg });
        // Refresh data
        const [elig, claimsRes] = await Promise.all([
          fetch("/api/guarantees/eligibility").then(r => r.json()),
          fetch("/api/guarantees/claims").then(r => r.json()),
        ]);
        if (elig.success) setEligibility(elig.data);
        if (claimsRes.success) setClaims(claimsRes.data.claims);
      } else {
        setClaimResult({ type, success: false, message: body.error || "Something went wrong." });
      }
    } catch {
      setClaimResult({ type, success: false, message: "Network error. Please try again." });
    } finally {
      setClaiming(null);
    }
  };

  const guaranteeTypes: GuaranteeType[] = ["speed", "win_jobs", "money_back"];

  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">My Guarantees</h1>
          <p className="text-slate-400 text-sm">
            ProBid backs every subscription with three ironclad guarantees. Check your eligibility and submit a claim below.
          </p>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-700/40 text-red-300 rounded-xl px-4 py-3 text-sm">{error}</div>
        )}

        {claimResult && (
          <div
            className={`rounded-xl px-4 py-3 text-sm border ${
              claimResult.success
                ? "bg-green-900/30 border-green-700/40 text-green-300"
                : "bg-red-900/30 border-red-700/40 text-red-300"
            }`}
          >
            {claimResult.message}
          </div>
        )}

        {/* Past claims */}
        {claims.length > 0 && (
          <Card className="p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white">Your Claims</h2>
            <div className="divide-y divide-slate-700/40">
              {claims.map(claim => (
                <div key={claim.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-lg flex-shrink-0">{TYPE_ICONS[claim.guarantee_type] ?? "📋"}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {TYPE_LABELS[claim.guarantee_type] ?? claim.guarantee_type}
                      </p>
                      {claim.resolution && (
                        <p className="text-xs text-slate-400 truncate">{claim.resolution}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <StatusBadge status={claim.status} />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Eligibility cards */}
        {loading ? (
          <div className="text-slate-500 text-sm text-center py-10">Loading eligibility…</div>
        ) : (
          <div className="space-y-4">
            {guaranteeTypes.map(type => {
              const entry = eligibility?.[type];
              const existingClaim = claims.find(c => c.guarantee_type === type);
              return (
                <Card key={type} className="p-5">
                  <div className="flex items-start gap-3">
                    <span className="text-3xl flex-shrink-0 mt-0.5">{TYPE_ICONS[type]}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-base font-bold text-white">{entry?.info.title ?? TYPE_LABELS[type]}</h3>
                        {existingClaim && <StatusBadge status={existingClaim.status} />}
                        {!existingClaim && entry?.eligible && (
                          <span className="text-xs font-semibold bg-green-900/50 text-green-400 border border-green-700/40 px-2 py-0.5 rounded-full">
                            Eligible
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-300 mb-2">{entry?.info.description}</p>
                      <p className="text-xs text-slate-500 mb-3 leading-relaxed">{entry?.info.terms}</p>

                      {!existingClaim && entry && !entry.eligible && entry.reasons.length > 0 && (
                        <ul className="text-xs text-slate-400 space-y-1 mb-3">
                          {entry.reasons.map((r, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <span className="text-slate-600 mt-0.5">•</span>
                              <span>{r}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {existingClaim ? (
                        <p className="text-xs text-slate-500">
                          Submitted {new Date(existingClaim.requested_at).toLocaleDateString()}
                          {existingClaim.account_credit_cents > 0 &&
                            ` · $${(existingClaim.account_credit_cents / 100).toFixed(2)} credit issued`}
                          {existingClaim.stripe_refund_id && ` · Refund: ${existingClaim.stripe_refund_id}`}
                        </p>
                      ) : (
                        <Button
                          size="sm"
                          variant={entry?.eligible ? "primary" : "ghost"}
                          disabled={!entry?.eligible || claiming !== null}
                          loading={claiming === type}
                          onClick={() => handleClaim(type)}
                        >
                          {entry?.eligible ? "Submit Claim" : "Not Yet Eligible"}
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <p className="text-xs text-slate-600 text-center">
          Each guarantee is claimable once per account, lifetime. Claims auto-evaluate in seconds.
          Questions?{" "}
          <a href="/contact" className="text-brand-green hover:underline">
            Contact support
          </a>
          .
        </p>
      </div>
    </Layout>
  );
}
