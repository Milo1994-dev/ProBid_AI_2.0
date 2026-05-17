import React, { useState, useEffect } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { api } from "../../api/client";
import { track } from "../../analytics";

interface UpgradeModalProps {
  open: boolean;
  onClose: () => void;
}

const PRO_FEATURES = [
  "Unlimited estimates every day",
  "AI photo analysis",
  "Saved history & PDF export",
  "Priority support",
];

const BUSINESS_FEATURES = [
  "Everything in Pro",
  "Team collaboration",
  "Custom branding",
  "Analytics dashboard",
];

function CountdownTimer() {
  const [timeLeft, setTimeLeft] = useState(() => {
    const stored = sessionStorage.getItem("upgradeCountdownEnd");
    if (stored) {
      const remaining = Math.max(0, Math.floor((parseInt(stored) - Date.now()) / 1000));
      return remaining;
    }
    const endTime = Date.now() + 15 * 60 * 1000;
    sessionStorage.setItem("upgradeCountdownEnd", String(endTime));
    return 15 * 60;
  });

  useEffect(() => {
    if (timeLeft <= 0) return;
    const timer = setInterval(() => {
      const stored = sessionStorage.getItem("upgradeCountdownEnd");
      if (!stored) return;
      const remaining = Math.max(0, Math.floor((parseInt(stored) - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft > 0]);

  if (timeLeft <= 0) return null;

  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;

  return (
    <div className="flex items-center justify-center gap-2 mb-4 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30">
      <span className="text-amber-400 text-xs font-semibold">Limited offer expires in</span>
      <span className="font-mono text-sm font-bold text-amber-300">
        {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
      </span>
    </div>
  );
}

export function UpgradeModal({ open, onClose }: UpgradeModalProps) {
  const [loading, setLoading] = useState<"pro" | "business" | null>(null);
  const [error, setError] = useState("");

  const handleUpgrade = async (plan: "pro" | "business") => {
    setError("");
    track("upgrade_modal_cta_clicked", { plan });
    track("upgrade_click", { plan, source: "upgrade_modal" });
    setLoading(plan);
    try {
      const res = await api.createCheckoutSession(plan);
      if (res.success && res.data?.url) {
        window.location.href = res.data.url;
      } else {
        setError("Failed to start checkout. Please try again.");
        setLoading(null);
      }
    } catch {
      setError("Failed to start checkout. Please try again.");
      setLoading(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} className="max-w-2xl">
      <button
        onClick={onClose}
        data-autofocus
        className="absolute top-4 right-4 text-brand-textSubtle hover:text-brand-textPrimary transition-colors text-2xl leading-none z-10"
        aria-label="Close"
      >
        ×
      </button>
      <div className="text-center mb-5">
        <div className="text-5xl mb-3">🔒</div>
        <h2 className="text-2xl font-black text-brand-textPrimary mb-2">
          You've reached your free limit
        </h2>
        <p className="text-brand-textMuted text-sm leading-relaxed">
          You've used your available estimates. Start your 7-day free trial of Pro —
          no charge until after the trial ends, or grab a $7 single estimate.
        </p>
      </div>

      <CountdownTimer />

      <div className="flex items-center justify-center gap-2 mb-4">
        <p className="text-xs text-brand-textSubtle">
          Built by a working contractor — cancel anytime
        </p>
      </div>

      {error && (
        <p className="text-red-400 text-sm text-center mb-4">{error}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="flex flex-col p-5 rounded-2xl border border-brand-border bg-brand-card">
          <p className="text-xs font-semibold text-brand-textSubtle uppercase tracking-wider mb-1">Single Estimate</p>
          <div className="flex items-end gap-1 mb-4">
            <span className="text-3xl font-black text-brand-textPrimary">$7</span>
            <span className="text-brand-textSubtle text-sm mb-1">one-time</span>
          </div>
          <ul className="flex-1 space-y-2 text-sm text-brand-textMuted mb-4">
            <li className="flex items-start gap-2">
              <span className="text-brand-textSubtle mt-0.5 shrink-0">✓</span>
              1 AI-powered estimate
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand-textSubtle mt-0.5 shrink-0">✓</span>
              No subscription required
            </li>
          </ul>
          <Button variant="ghost" disabled fullWidth>
            Pay-as-you-go
          </Button>
        </div>

        <div className="relative flex flex-col p-5 rounded-2xl border border-brand-green bg-gradient-to-b from-brand-green/10 to-brand-card shadow-lg shadow-brand-green/10">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-brand-green text-white text-xs font-bold px-3 py-1 rounded-full">
              Most Popular
            </span>
          </div>
          <p className="text-xs font-semibold text-brand-green uppercase tracking-wider mb-1">Pro</p>
          <div className="flex items-end gap-1 mb-1">
            <span className="text-3xl font-black text-brand-textPrimary">$25</span>
            <span className="text-brand-textSubtle text-sm mb-1">/month</span>
          </div>
          <p className="text-xs text-brand-green mb-3">Less than $1/day — pays for itself with 1 extra job/year</p>
          <ul className="flex-1 space-y-2 text-sm text-brand-textMuted mb-4">
            {PRO_FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2">
                <span className="text-brand-green mt-0.5 shrink-0">✓</span>
                {f}
              </li>
            ))}
          </ul>
          <Button
            variant="primary"
            fullWidth
            loading={loading === "pro"}
            disabled={loading === "business"}
            onClick={() => handleUpgrade("pro")}
          >
            Start 7-Day Free Trial
          </Button>
          <p className="text-center text-[11px] text-brand-textSubtle mt-2">No charge during trial · Cancel anytime</p>
        </div>
      </div>

      <div className="border border-brand-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
        <div>
          <p className="font-bold text-brand-textPrimary text-sm mb-0.5">Business — $55/mo</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {BUSINESS_FEATURES.map((f) => (
              <li key={f} className="text-xs text-brand-textMuted flex items-center gap-1">
                <span className="text-brand-green">✓</span> {f}
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          loading={loading === "business"}
          disabled={loading === "pro"}
          onClick={() => handleUpgrade("business")}
        >
          Start 7-Day Free Trial
        </Button>
      </div>

      <p className="text-center text-xs text-brand-textSubtle mt-4">
        7-day free trial · No charge until after trial · Cancel anytime
      </p>
    </Modal>
  );
}
