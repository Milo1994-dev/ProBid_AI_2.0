import React, { useState, useCallback, useEffect } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { api } from "../../api/client";
import { track } from "../../analytics";
import { useNavigate } from "react-router-dom";

interface ShareToUnlockModalProps {
  open: boolean;
  onClose: () => void;
  context: "first_estimate" | "limit_reached";
}

export function ShareToUnlockModal({ open, onClose, context }: ShareToUnlockModalProps) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [referralLink, setReferralLink] = useState<string | null>(null);
  const [loadingLink, setLoadingLink] = useState(false);

  // Fetch (and generate if needed) the affiliate link when modal opens
  useEffect(() => {
    if (!open || referralLink) return;
    setLoadingLink(true);
    api.getAffiliate()
      .then((res) => {
        if (res.success && res.data?.link) {
          setReferralLink(res.data.link);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingLink(false));
  }, [open, referralLink]);

  const handleCopy = useCallback(async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
    } catch {
      const el = document.createElement("textarea");
      el.value = referralLink;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    track("share_to_unlock_copied", { context });
    setTimeout(() => setCopied(false), 2500);
  }, [referralLink, context]);

  const handleShare = useCallback(async () => {
    if (!referralLink) return;
    track("share_to_unlock_shared", { context });
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Get free AI-powered construction estimates",
          text: "I've been using ProBid AI to generate pro estimates in seconds. Try it free:",
          url: referralLink,
        });
        return;
      } catch {
        // fall through to copy
      }
    }
    handleCopy();
  }, [referralLink, handleCopy, context]);

  const handleUpgrade = () => {
    track("share_to_unlock_upgrade_clicked", { context });
    onClose();
    navigate("/app/billing");
  };

  const isLimitReached = context === "limit_reached";

  return (
    <Modal open={open} onClose={onClose} className="max-w-lg">
      <button
        onClick={onClose}
        data-autofocus
        className="absolute top-4 right-4 text-brand-textSubtle hover:text-brand-textPrimary transition-colors text-2xl leading-none z-10"
        aria-label="Close"
      >
        ×
      </button>

      {/* Header */}
      <div className="text-center mb-6">
        <div className="text-5xl mb-3">{isLimitReached ? "🔗" : "🎉"}</div>
        <h2 className="text-2xl font-black text-brand-textPrimary mb-2">
          {isLimitReached
            ? "Want 3 More FREE Estimates?"
            : "Share & Unlock 3 More Free Estimates"}
        </h2>
        <p className="text-brand-textMuted text-sm leading-relaxed">
          {isLimitReached
            ? "You've reached your free limit — but you can unlock more. Share your unique link. When just 1 contractor signs up, you instantly get +3 more free estimates."
            : "Refer one contractor and unlock +3 more free estimates. It only takes 30 seconds."}
        </p>
      </div>

      {/* How it works */}
      <div className="flex items-start gap-4 sm:gap-6 bg-brand-bg rounded-2xl px-5 py-4 mb-5 border border-brand-border">
        {[
          { step: "1", text: "Copy your link below" },
          { step: "2", text: "Send it to a contractor friend" },
          { step: "3", text: "They sign up → you get +3 estimates" },
        ].map(({ step, text }) => (
          <div key={step} className="flex-1 text-center">
            <div className="w-7 h-7 rounded-full bg-brand-green/20 border border-brand-green/40 text-brand-green text-xs font-black flex items-center justify-center mx-auto mb-1.5">
              {step}
            </div>
            <p className="text-xs text-brand-textMuted leading-snug">{text}</p>
          </div>
        ))}
      </div>

      {/* Referral link */}
      <div className="mb-5">
        <label className="block text-xs font-semibold text-brand-textMuted mb-1.5">
          Your Referral Link
        </label>
        {loadingLink ? (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-brand-bg border border-brand-border text-brand-textSubtle text-xs">
            <span className="w-3 h-3 border-2 border-brand-indigo border-t-transparent rounded-full animate-spin shrink-0" />
            Generating your link…
          </div>
        ) : referralLink ? (
          <div className="flex gap-2">
            <input
              readOnly
              value={referralLink}
              className="flex-1 min-w-0 px-3 py-2.5 rounded-xl bg-brand-bg border border-brand-border text-brand-textPrimary text-xs font-mono focus:outline-none focus:border-brand-green transition-colors"
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={handleCopy}
              className={`shrink-0 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${
                copied
                  ? "bg-brand-green/20 text-brand-green border border-brand-green/40"
                  : "bg-brand-card border border-brand-border text-brand-textPrimary hover:border-brand-green/60"
              }`}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        ) : (
          <div className="px-4 py-3 rounded-xl bg-brand-bg border border-brand-border text-brand-textSubtle text-sm text-center">
            Could not load referral link. Please refresh and try again.
          </div>
        )}
      </div>

      {/* Share button */}
      <Button
        variant="primary"
        fullWidth
        onClick={handleShare}
        disabled={!referralLink || loadingLink}
        className="mb-3"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mr-2"
        >
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        Share & Unlock 3 More Estimates
      </Button>

      {/* Upgrade instead */}
      <div className="text-center">
        <button
          onClick={handleUpgrade}
          className="text-xs text-brand-textSubtle hover:text-brand-textMuted transition-colors underline"
        >
          Upgrade to Pro for unlimited estimates — $25/mo
        </button>
      </div>
    </Modal>
  );
}
