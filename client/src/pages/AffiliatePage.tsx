import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { StatTile, StatTileSkeleton } from "../components/ui/StatTile";
import { Alert } from "../components/ui/Alert";
import { api, ReferralEntry } from "../api/client";
import { usePageMeta } from "../hooks/usePageMeta";
import { track } from "../analytics";

function statusBadge(status: string) {
  if (status === "converted") return <Badge variant="green">Converted</Badge>;
  if (status === "signed_up") return <Badge variant="indigo">Signed Up</Badge>;
  return <Badge variant="gray">{status}</Badge>;
}

const SHARE_MESSAGES = {
  sms: (link: string) =>
    `Hey, check out ProBid AI — it generates construction estimates in 30 seconds from a photo. Try it free: ${link}`,
  email: (link: string) => ({
    subject: "Tool that saves hours on estimates",
    body: `Hey,\n\nI've been using this tool called ProBid AI that generates construction estimates in about 30 seconds. You upload a photo of the job, describe it, and it gives you a full material + labor breakdown.\n\nYou can try a single estimate for $7, or start a 7-day free trial of Pro: ${link}\n\nThought you might find it useful.`,
  }),
  facebook: (link: string) =>
    `Check out ProBid AI — AI-powered construction estimates in 30 seconds. $7 single estimate or 7-day free trial of Pro: ${link}`,
  twitter: (link: string) =>
    `Just found @ProBidAI — generates construction estimates in 30 seconds from a job photo. Game changer for contractors. Try it free: ${link}`,
};

export default function AffiliatePage() {
  usePageMeta({
    title: "Affiliate Program | ProBid AI",
    description: "Earn commissions by referring contractors to ProBid AI. Share your link and earn 20% recurring revenue.",
    canonical: "https://probidcore.net/app/affiliate",
  });

  const [copied, setCopied] = useState(false);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);

  const { data: affiliate, isLoading, isError } = useQuery({
    queryKey: ["affiliate"],
    queryFn: () => api.getAffiliate().then((r) => r.data),
  });

  const { data: referralsData } = useQuery({
    queryKey: ["referrals"],
    queryFn: () => api.getReferrals().then((r) => r.data),
  });

  const referrals: ReferralEntry[] = referralsData?.referrals ?? [];
  const link = affiliate?.link ?? "";

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const input = document.createElement("input");
      input.value = link;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    track("share_to_unlock_copied", { method: "link" });
    setTimeout(() => setCopied(false), 2500);
  };

  const copyMessage = async (text: string, method: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopiedMsg(method);
    track("share_to_unlock_copied", { method });
    setTimeout(() => setCopiedMsg(null), 2500);
  };

  const shareViaEmail = () => {
    if (!link) return;
    const { subject, body } = SHARE_MESSAGES.email(link);
    window.open(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_blank");
    track("share_to_unlock_shared", { method: "email" });
  };

  const shareViaTwitter = () => {
    if (!link) return;
    const text = SHARE_MESSAGES.twitter(link);
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
    track("share_to_unlock_shared", { method: "twitter" });
  };

  const shareViaFacebook = () => {
    if (!link) return;
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`, "_blank");
    track("share_to_unlock_shared", { method: "facebook" });
  };

  const conversionRate = affiliate && affiliate.clicks > 0
    ? ((affiliate.conversions / affiliate.clicks) * 100).toFixed(1)
    : "0.0";

  const earningsFormatted = `$${((affiliate?.earnings ?? 0) / 100).toFixed(2)}`;
  const projectedMonthly = affiliate?.conversions
    ? `$${((affiliate.conversions * 25 * 0.2 * 12) / 12).toFixed(0)}`
    : "$0";

  return (
    <Layout>
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-black text-brand-textPrimary mb-2">Affiliate Program</h1>
        <p className="text-brand-textMuted mb-8">
          Earn 20% recurring commission on every contractor you refer. That's $5/month per Pro subscriber or $11/month per Business subscriber — for 12 months.
        </p>

        {isError && <Alert type="error" className="mb-6">Failed to load affiliate data.</Alert>}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          {isLoading ? (
            <>
              <StatTileSkeleton />
              <StatTileSkeleton />
              <StatTileSkeleton />
              <StatTileSkeleton />
            </>
          ) : (
            <>
              <StatTile label="Link Clicks" value={affiliate?.clicks ?? 0} icon="👆" />
              <StatTile label="Signups" value={affiliate?.conversions ?? 0} icon="✅" highlight />
              <StatTile label="Earned" value={earningsFormatted} icon="💰" />
              <StatTile label="Conv. Rate" value={`${conversionRate}%`} icon="📊" />
            </>
          )}
        </div>

        {/* Rank */}
        {affiliate?.rank && (
          <Alert type="success" className="mb-6">
            You are ranked <strong>#{affiliate.rank}</strong> on the affiliate leaderboard.{" "}
            <a href="/leaderboard" target="_blank" rel="noopener noreferrer" className="underline font-semibold">
              View leaderboard
            </a>
          </Alert>
        )}

        {/* Referral link */}
        <Card className="mb-6">
          <h2 className="text-base font-bold text-brand-textPrimary mb-3">Your Referral Link</h2>
          {isLoading ? (
            <div className="animate-pulse h-12 bg-brand-border rounded-xl" />
          ) : (
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 bg-brand-bg rounded-xl px-4 py-3 text-sm text-brand-textMuted font-mono break-all select-all">
                {link || "Loading..."}
              </div>
              <Button
                variant={copied ? "ghost" : "primary"}
                onClick={handleCopy}
                className="shrink-0"
              >
                {copied ? "Copied!" : "Copy Link"}
              </Button>
            </div>
          )}
        </Card>

        {/* Share Tools */}
        <Card className="mb-6">
          <h2 className="text-base font-bold text-brand-textPrimary mb-4">Quick Share</h2>
          <p className="text-sm text-brand-textMuted mb-4">
            Use these pre-written messages to share with your network. Each one includes your referral link automatically.
          </p>

          <div className="grid gap-3">
            {/* Direct share buttons */}
            <div className="flex flex-wrap gap-2 mb-3">
              <Button variant="ghost" onClick={shareViaEmail} className="text-sm">
                Email
              </Button>
              <Button variant="ghost" onClick={shareViaTwitter} className="text-sm">
                Twitter/X
              </Button>
              <Button variant="ghost" onClick={shareViaFacebook} className="text-sm">
                Facebook
              </Button>
            </div>

            {/* Copy-paste messages */}
            <div className="space-y-3">
              <div className="p-3 bg-brand-bg rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-brand-textSubtle uppercase tracking-wide">Text / SMS</span>
                  <button
                    onClick={() => copyMessage(SHARE_MESSAGES.sms(link), "sms")}
                    className="text-xs text-brand-green hover:text-brand-green/80 font-semibold"
                  >
                    {copiedMsg === "sms" ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-xs text-brand-textMuted leading-relaxed">{SHARE_MESSAGES.sms(link || "your-link")}</p>
              </div>

              <div className="p-3 bg-brand-bg rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-brand-textSubtle uppercase tracking-wide">Facebook / LinkedIn</span>
                  <button
                    onClick={() => copyMessage(SHARE_MESSAGES.facebook(link), "facebook_msg")}
                    className="text-xs text-brand-green hover:text-brand-green/80 font-semibold"
                  >
                    {copiedMsg === "facebook_msg" ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-xs text-brand-textMuted leading-relaxed">{SHARE_MESSAGES.facebook(link || "your-link")}</p>
              </div>

              <div className="p-3 bg-brand-bg rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-brand-textSubtle uppercase tracking-wide">Twitter / X</span>
                  <button
                    onClick={() => copyMessage(SHARE_MESSAGES.twitter(link), "twitter_msg")}
                    className="text-xs text-brand-green hover:text-brand-green/80 font-semibold"
                  >
                    {copiedMsg === "twitter_msg" ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-xs text-brand-textMuted leading-relaxed">{SHARE_MESSAGES.twitter(link || "your-link")}</p>
              </div>
            </div>
          </div>
        </Card>

        {/* Earnings projection */}
        {!isLoading && (
          <Card className="mb-6 bg-gradient-to-r from-brand-green/5 to-brand-indigo/5">
            <h2 className="text-base font-bold text-brand-textPrimary mb-3">Earnings Potential</h2>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-black text-brand-green">$60</p>
                <p className="text-xs text-brand-textSubtle mt-1">per Pro referral<br />(12 months)</p>
              </div>
              <div>
                <p className="text-2xl font-black text-brand-green">$132</p>
                <p className="text-xs text-brand-textSubtle mt-1">per Business referral<br />(12 months)</p>
              </div>
              <div>
                <p className="text-2xl font-black text-brand-green">{projectedMonthly}/mo</p>
                <p className="text-xs text-brand-textSubtle mt-1">your projected<br />monthly earnings</p>
              </div>
            </div>
          </Card>
        )}

        {/* Referrals list */}
        <div>
          <h2 className="text-lg font-bold text-brand-textPrimary mb-4">Your Referrals</h2>
          {referrals.length === 0 ? (
            <Card padding="lg" className="text-center">
              <div className="text-4xl mb-3">🔗</div>
              <p className="text-brand-textMuted font-medium mb-1">No referrals yet</p>
              <p className="text-brand-textSubtle text-sm mb-4">Share your referral link above to start earning.</p>
              <Button variant="primary" onClick={handleCopy}>
                {copied ? "Link Copied!" : "Copy Your Referral Link"}
              </Button>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {referrals.map((r) => (
                <Card key={r.id} padding="sm" className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-brand-textMuted">
                      {r.referredEmail || "Anonymous"}
                    </p>
                    <p className="text-xs text-brand-textSubtle mt-0.5">
                      {new Date(r.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  </div>
                  {statusBadge(r.status)}
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* How it works */}
        <Card className="mt-8">
          <h3 className="text-sm font-bold text-brand-textPrimary mb-4">How It Works</h3>
          <ol className="flex flex-col gap-3 text-sm text-brand-textMuted">
            {[
              "Share your referral link with contractors, on social media, or in contractor groups.",
              "They sign up through your link and start a 7-day free trial of Pro (or grab a $7 single estimate).",
              "When they subscribe to Pro ($25/mo) or Business ($55/mo), you earn 20% commission.",
              "Commissions are tracked automatically and paid monthly for 12 months per referral.",
              "You also get 3 bonus free estimates for every signup, even before they pay.",
            ].map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 w-5 h-5 rounded-full bg-brand-indigo/20 text-brand-indigo text-xs flex items-center justify-center font-bold">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Card>

        {/* Tips for success */}
        <Card className="mt-4">
          <h3 className="text-sm font-bold text-brand-textPrimary mb-4">Tips for More Referrals</h3>
          <ul className="flex flex-col gap-2 text-sm text-brand-textMuted">
            <li className="flex gap-2"><span className="text-brand-green">1.</span> Post in Facebook contractor groups — mention how it saves time on estimates</li>
            <li className="flex gap-2"><span className="text-brand-green">2.</span> Text the link to contractor friends with the pre-written SMS message above</li>
            <li className="flex gap-2"><span className="text-brand-green">3.</span> Share on LinkedIn with a quick note about how you use ProBid AI</li>
            <li className="flex gap-2"><span className="text-brand-green">4.</span> Add your referral link to your email signature</li>
            <li className="flex gap-2"><span className="text-brand-green">5.</span> Mention it when you're on job sites with other contractors</li>
          </ul>
        </Card>
      </div>
    </Layout>
  );
}
