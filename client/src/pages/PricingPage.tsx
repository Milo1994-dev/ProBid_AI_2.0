import React, { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PricingCard } from "../components/ui/PricingCard";
import { useAuth } from "../contexts/AuthContext";
import { api } from "../api/client";
import { track, generateEventId } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";
import { GuaranteeBlock } from "../components/GuaranteeBlock";

type Interval = "monthly" | "annual";
type StripePriceInfo = { amount: number | null; currency: string | null; interval: string | null };

function formatStripePrice(p: StripePriceInfo | null | undefined, fallback: string): string {
  if (!p || p.amount == null) return fallback;
  const dollars = p.amount / 100;
  const cents = dollars % 1 !== 0 ? dollars.toFixed(2) : String(Math.floor(dollars));
  const symbol = p.currency?.toLowerCase() === "usd" ? "$" : (p.currency ? p.currency.toUpperCase() + " " : "$");
  return `${symbol}${cents}`;
}

function annualSavingsPct(monthly: StripePriceInfo | null | undefined, annual: StripePriceInfo | null | undefined): number | null {
  if (!monthly?.amount || !annual?.amount) return null;
  const monthlyYearly = monthly.amount * 12;
  const pct = Math.round(((monthlyYearly - annual.amount) / monthlyYearly) * 100);
  return pct > 0 ? pct : null;
}

interface LifetimeStatusData {
  remaining: number;
  cap: number;
  soldOut: boolean;
  purchased: number;
}

const AB_EXPERIMENT = "pricing_guarantee_stack";

function getOrCreateVisitorId(): string {
  const KEY = "pb_vid";
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return "anon";
  }
}

export default function PricingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const [interval, setInterval] = useState<Interval>("monthly");
  const [prices, setPrices] = useState<{
    proMonthly: StripePriceInfo | null;
    proAnnual: StripePriceInfo | null;
    businessMonthly: StripePriceInfo | null;
    businessAnnual: StripePriceInfo | null;
  }>({ proMonthly: null, proAnnual: null, businessMonthly: null, businessAnnual: null });
  const [lifetimeStatus, setLifetimeStatus] = useState<LifetimeStatusData | null>(null);
  const [soldOutBannerDismissed, setSoldOutBannerDismissed] = useState(false);
  const [abVariant, setAbVariant] = useState<"control" | "guarantee_stack" | null>(null);
  const [visitorId, setVisitorId] = useState<string>("");

  const showSoldOutBanner = searchParams.get("lifetime_sold_out") === "1" && !soldOutBannerDismissed;
  const showWelcomeBanner = searchParams.get("welcome") === "1";

  useEffect(() => {
    api.getBillingPrices().then(res => {
      if (res.success && res.data) setPrices(res.data);
    }).catch(() => undefined);

    fetch("/api/billing/lifetime-status")
      .then(r => r.json())
      .then(body => { if (body?.success && body?.data) setLifetimeStatus(body.data as LifetimeStatusData); })
      .catch(() => undefined);

    // A/B experiment assignment — deterministic by visitorId
    const vid = getOrCreateVisitorId();
    setVisitorId(vid);
    fetch("/api/ab/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId: vid, experimentKey: AB_EXPERIMENT }),
    })
      .then(r => r.json())
      .then(body => {
        if (body.success) setAbVariant(body.data.variant as "control" | "guarantee_stack");
      })
      .catch(() => {
        // Fallback: render guarantee block for all users if experiment endpoint is down
        setAbVariant("guarantee_stack");
      });
  }, []);

  // Save a pending A/B conversion marker to localStorage so that signup completion
  // (in SignupPage) or billing success (in BillingPage) can fire the conversion
  // event after the user has actually completed the intended action.
  const savePendingAbConversion = () => {
    if (!visitorId) return;
    try {
      localStorage.setItem("pb_ab_pending", JSON.stringify({ visitorId, experimentKey: AB_EXPERIMENT }));
    } catch {
      // Non-fatal
    }
  };

  usePageMeta({
    title: "Pricing | ProBid AI — Plans for Every Contractor",
    description: "Simple pricing for AI-powered construction estimates. Try a Single Estimate for $7, or upgrade to Pro for $25/mo or Business for $55/mo. 7-day free trial on subscriptions.",
    canonical: "https://probidcore.net/pricing",
  });

  const handlePricingCta = async (plan: string) => {
    track("pricing_cta_click", { plan, source: "pricing_page", ab_variant: abVariant });

    if (plan === "free") {
      if (!user) {
        savePendingAbConversion(); // conversion fires after signup completes
        navigate("/signup");
      } else {
        try {
          setCheckoutLoading("free");
          const metaEventId = generateEventId();
          track("checkout_started", { plan: "single_estimate", source: "pricing_page" }, metaEventId);
          const res = await api.createSingleEstimateCheckout(metaEventId);
          if (res.data?.url) window.location.href = res.data.url;
        } catch {
          setCheckoutError("Could not start checkout. Please try again.");
        } finally {
          setCheckoutLoading(null);
        }
      }
      return;
    }

    if (!user) {
      savePendingAbConversion(); // conversion fires after signup completes
      navigate("/signup");
      return;
    }

    setCheckoutError("");
    setCheckoutLoading(plan);
    // paid_converted is set exclusively by the Stripe webhook; no client-side paid flag here.
    try {
      const metaEventId = generateEventId();
      track("checkout_started", { plan, interval, source: "pricing_page", ab_variant: abVariant }, metaEventId);
      const res = await api.createCheckoutSession(plan as "pro" | "business", interval, metaEventId, visitorId || undefined);
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else {
        setCheckoutError("Could not start checkout. Please try again.");
      }
    } catch {
      setCheckoutError("Could not start checkout. Please try again.");
    } finally {
      setCheckoutLoading(null);
    }
  };

  const faqs = [
    {
      q: "How accurate are the estimates?",
      a: "ProBid uses GPT-4 Vision to analyze photos and job descriptions, then applies regional pricing data. Treat the result as a strong starting point — review the line items against your own knowledge of the job before sending it to a client.",
    },
    {
      q: "Do I have to pay to try ProBid?",
      a: "You can buy a single estimate for $7 to try it out, or start a 7-day free trial of Pro ($25/mo) for unlimited estimates. No charge during the trial — cancel any time.",
    },
    {
      q: "Can I cancel anytime?",
      a: "Yes. Cancel with one click from your billing dashboard. No contracts, no cancellation fees. If you cancel during your trial, you won't be charged at all.",
    },
    {
      q: "What is the 30-Day Money-Back Guarantee?",
      a: "If you subscribe to a paid plan and are unsatisfied for any reason within 30 days of your first payment, contact us and we will issue a full refund. The guarantee applies to your first paid subscription period only and requires a verified purchase on your account.",
    },
    {
      q: "What is the 60-Second Speed Guarantee?",
      a: "If any of your estimates takes longer than 60 seconds to generate, you are eligible for a $25 account credit on your next invoice. Active paid subscribers can file a claim from the app within 30 days of the slow estimate.",
    },
    {
      q: "What is the Win-Jobs Guarantee?",
      a: "Active paid subscribers who have generated 5 or more estimates over at least 30 days of use, and have not yet marked any estimate as Won, are eligible for a $25 account credit. Mark estimates as Won whenever you land a job — that is how we verify eligibility. One claim per account, lifetime.",
    },
    {
      q: "How do I file a guarantee claim?",
      a: "Log in, go to Settings → Guarantees (or click the guarantee badge on any estimate), select the guarantee type, and follow the prompts. Eligible claims are processed automatically within one business day; complex cases are reviewed by our team.",
    },
    {
      q: "What job types does ProBid support?",
      a: "Masonry, roofing, concrete, remodeling, tuckpointing, chimney rebuilds, retaining walls, and more. The AI adapts to any contractor trade.",
    },
    {
      q: "Do I need to upload photos?",
      a: "No. You can describe the job in text and the AI will generate an estimate. Photos give more accurate results, but they're optional.",
    },
  ];

  return (
    <div className="min-h-screen bg-brand-bg">
      <nav className="w-full border-b border-brand-border bg-brand-bg/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link to="/" className="text-brand-green font-black text-xl flex items-center gap-2">
            <span className="bg-brand-green/10 border border-brand-green/30 rounded-lg w-8 h-8 flex items-center justify-center text-brand-green text-sm font-black">P</span>
            ProBid AI
          </Link>
          <div className="flex items-center gap-4">
            {user ? (
              <Link to="/app" className="text-sm font-medium text-brand-green hover:underline">Dashboard</Link>
            ) : (
              <>
                <Link to="/login" className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Log In</Link>
                <Link to="/signup" className="text-sm font-semibold bg-brand-green text-brand-bg px-4 py-2 rounded-xl hover:bg-brand-green/90 transition-colors">
                  Start 7-Day Free Trial
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-4xl mx-auto text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-black text-brand-textPrimary mb-4">
            Simple pricing.<br/>
            <span className="text-brand-green">Try risk-free.</span>
          </h1>
          <p className="text-lg text-brand-textMuted max-w-2xl mx-auto">
            Try a Single Estimate for $7, or start a 7-day free trial of Pro or Business. Cancel anytime — no charge during the trial.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4 mb-8">
          <div className="flex items-center gap-2 text-xs text-brand-textSubtle">
            <svg className="w-4 h-4 text-brand-green shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            No charge during trial
          </div>
          <div className="flex items-center gap-2 text-xs text-brand-textSubtle">
            <svg className="w-4 h-4 text-brand-green shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
            30-day money-back guarantee
          </div>
          <div className="flex items-center gap-2 text-xs text-brand-textSubtle">
            <svg className="w-4 h-4 text-brand-green shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            Cancel anytime
          </div>
        </div>

        {showWelcomeBanner && (
          <div className="max-w-3xl mx-auto mb-6 px-4">
            <div className="flex items-start gap-3 bg-brand-green/10 border border-brand-green/30 rounded-xl px-4 py-3">
              <span className="text-brand-green text-base mt-0.5 shrink-0">✓</span>
              <p className="text-brand-green text-sm flex-1">
                <strong>You're in.</strong> Pick a plan to start your <strong>7-day free trial</strong>. We'll collect a card to keep your account active, but <strong>you won't be charged today</strong> — cancel anytime before the trial ends.
              </p>
            </div>
          </div>
        )}

        {showSoldOutBanner && (
          <div className="max-w-3xl mx-auto mb-6 px-4">
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
              <span className="text-amber-400 text-base mt-0.5 shrink-0">⚠</span>
              <p className="text-amber-300 text-sm flex-1">
                The $199 lifetime offer has sold out — Pro and Business plans are still available below.
              </p>
              <button
                type="button"
                onClick={() => setSoldOutBannerDismissed(true)}
                className="text-amber-500 hover:text-amber-300 text-lg leading-none shrink-0 ml-2"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {checkoutError && (
          <div className="max-w-3xl mx-auto mb-6 px-4">
            <p className="text-red-400 text-sm text-center bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{checkoutError}</p>
          </div>
        )}

        {lifetimeStatus && (
          <div className="max-w-3xl mx-auto mb-6 px-4">
            {lifetimeStatus.soldOut ? (
              <div className="text-center px-4 py-3 rounded-xl bg-brand-card border border-brand-border">
                <span className="inline-block text-xs font-semibold uppercase tracking-widest text-brand-textSubtle bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-1 rounded-full">
                  Lifetime offer — sold out
                </span>
                <p className="text-xs text-brand-textMuted mt-2">Pro and Business plans are still available below.</p>
              </div>
            ) : (
              <div className="text-center px-4 py-3 rounded-xl bg-brand-green/5 border border-brand-green/20">
                <span className="inline-block text-xs font-bold text-brand-green">
                  Limited launch offer — Only {lifetimeStatus.remaining} of {lifetimeStatus.cap} lifetime spots left at $199 forever
                </span>
                <div className="mt-2 w-full max-w-xs mx-auto h-1.5 rounded-full bg-brand-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand-green transition-all"
                    style={{ width: `${Math.min(100, (lifetimeStatus.purchased / lifetimeStatus.cap) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-brand-textSubtle mt-2">
                  <a href={user ? "/checkout/lifetime" : "/login?redirect=/checkout/lifetime"} className="text-brand-green hover:underline font-semibold">
                    Claim a lifetime spot →
                  </a>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Monthly / Annual toggle */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex bg-brand-card border border-brand-border rounded-full p-1">
            <button
              type="button"
              onClick={() => setInterval("monthly")}
              className={`px-4 py-1.5 text-sm font-semibold rounded-full transition-colors ${interval === "monthly" ? "bg-brand-green text-white" : "text-brand-textMuted hover:text-brand-textPrimary"}`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setInterval("annual")}
              className={`px-4 py-1.5 text-sm font-semibold rounded-full transition-colors flex items-center gap-2 ${interval === "annual" ? "bg-brand-green text-white" : "text-brand-textMuted hover:text-brand-textPrimary"}`}
            >
              Annual
              {(() => {
                const proPct = annualSavingsPct(prices.proMonthly, prices.proAnnual);
                const bizPct = annualSavingsPct(prices.businessMonthly, prices.businessAnnual);
                const best = Math.max(proPct ?? 0, bizPct ?? 0);
                return best > 0 ? (
                  <span className="text-[10px] bg-brand-green/20 text-brand-green px-1.5 py-0.5 rounded-full">
                    Save {best}%
                  </span>
                ) : null;
              })()}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl mx-auto">
          <PricingCard
            name="Single Estimate"
            price="$7"
            period=""
            description="Try it risk-free"
            features={[
              "1 AI-powered estimate",
              "Materials + labor breakdown",
              "PDF download",
              "Regional pricing included",
            ]}
            cta="Get One Estimate — $7"
            onCta={() => handlePricingCta("free")}
            loading={checkoutLoading === "free"}
          />
          <PricingCard
            name="Pro"
            price={interval === "monthly"
              ? formatStripePrice(prices.proMonthly, "$25")
              : formatStripePrice(prices.proAnnual, "$250")}
            period={interval === "monthly" ? "/mo" : "/yr"}
            description={interval === "annual" ? "Billed annually" : "For contractors who quote daily"}
            features={[
              "Unlimited estimates",
              "Photo analysis (GPT-4 Vision)",
              "PDF export & saved history",
              "Client-ready branded reports",
              "Priority support",
              "Estimate templates",
            ]}
            cta="Start 7-Day Free Trial"
            onCta={() => handlePricingCta("pro")}
            loading={checkoutLoading === "pro"}
            popular
            trialDays={7}
          />
          <PricingCard
            name="Business"
            price={interval === "monthly"
              ? formatStripePrice(prices.businessMonthly, "$55")
              : formatStripePrice(prices.businessAnnual, "$550")}
            period={interval === "monthly" ? "/mo" : "/yr"}
            description={interval === "annual" ? "Billed annually" : "For crews and agencies"}
            features={[
              "Everything in Pro",
              "Team collaboration (5 seats)",
              "Procore Trust Engine",
              "Custom branding on PDFs",
              "Analytics dashboard",
              "API access",
              "Dedicated account support",
            ]}
            cta="Start 7-Day Free Trial"
            onCta={() => handlePricingCta("business")}
            loading={checkoutLoading === "business"}
            trialDays={7}
          />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-6 mt-8 text-brand-textSubtle text-xs">
          <span className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
            Secure Stripe checkout
          </span>
          <span className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            Cancel anytime
          </span>
          <span className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            No charge during trial
          </span>
        </div>

        {/* Trust bar — only shown to guarantee_stack variant (adjacent to checkout CTAs) */}
        {abVariant === "guarantee_stack" && (
          <div className="max-w-4xl mx-auto mt-6 px-4">
            <GuaranteeBlock variant="trust-bar" />
          </div>
        )}
      </section>

      <section className="py-16 border-t border-brand-border">
        <div className="max-w-4xl mx-auto px-4">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-black text-brand-textPrimary mb-2">Compare Plans</h2>
            <p className="text-brand-textMuted text-sm">See exactly what you get with each plan</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-border">
                  <th className="text-left py-4 pr-4 text-brand-textMuted font-medium">Feature</th>
                  <th className="text-center py-4 px-4 text-brand-textPrimary font-bold">Single Estimate</th>
                  <th className="text-center py-4 px-4 text-brand-green font-bold">Pro</th>
                  <th className="text-center py-4 px-4 text-brand-textPrimary font-bold">Business</th>
                </tr>
              </thead>
              <tbody className="text-brand-textMuted">
                {[
                  ["AI estimates", "1 estimate", "Unlimited", "Unlimited"],
                  ["Photo analysis", true, true, true],
                  ["PDF export", true, true, true],
                  ["Regional pricing", true, true, true],
                  ["Saved history", false, true, true],
                  ["Estimate templates", false, true, true],
                  ["Priority support", false, true, true],
                  ["Team seats", false, false, "5 included"],
                  ["Custom branding", false, false, true],
                  ["Procore integration", false, false, true],
                  ["API access", false, false, true],
                  ["Analytics dashboard", false, false, true],
                ].map(([feature, single, pro, biz], i) => (
                  <tr key={i} className="border-b border-brand-border/50">
                    <td className="py-3 pr-4 text-brand-textMuted">{feature as string}</td>
                    {[single, pro, biz].map((val, j) => (
                      <td key={j} className="text-center py-3 px-4">
                        {val === true ? (
                          <svg className="w-5 h-5 text-brand-green mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                        ) : val === false ? (
                          <span className="text-brand-textSubtle">—</span>
                        ) : (
                          <span className="text-brand-textPrimary text-xs font-medium">{val as string}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="py-16 border-t border-brand-border">
        <div className="max-w-3xl mx-auto px-4">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-black text-brand-textPrimary mb-2">Frequently Asked Questions</h2>
          </div>

          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <div key={i} className="rounded-xl border border-brand-border bg-brand-card p-5">
                <h3 className="text-sm font-bold text-brand-textPrimary mb-2">{faq.q}</h3>
                <p className="text-sm text-brand-textMuted leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Full guarantee section — only visible to guarantee_stack variant */}
      {abVariant === "guarantee_stack" && <GuaranteeBlock variant="full" />}

      <section className="py-16 border-t border-brand-border">
        <div className="max-w-2xl mx-auto px-4 text-center">
          <h2 className="text-3xl font-black text-brand-textPrimary mb-4">
            Ready to win more jobs?
          </h2>
          <p className="text-brand-textMuted mb-6">
            Snap a photo, get a professional estimate in about a minute, and send the PDF before you leave the driveway.
          </p>
          <Link
            to="/signup"
            className="inline-block bg-brand-green text-brand-bg font-bold px-8 py-4 rounded-2xl text-lg hover:bg-brand-green/90 transition-colors shadow-lg shadow-brand-green/20"
          >
            Start 7-Day Free Trial
          </Link>
          <p className="text-xs text-brand-textSubtle mt-3">No charge during trial · Cancel anytime</p>
        </div>
      </section>

      <footer className="border-t border-brand-border py-8 px-4">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-brand-textSubtle">
          <span>&copy; {new Date().getFullYear()} ProBid AI. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <Link to="/terms" className="hover:text-brand-textPrimary transition-colors">Terms</Link>
            <Link to="/privacy" className="hover:text-brand-textPrimary transition-colors">Privacy</Link>
            <Link to="/" className="hover:text-brand-textPrimary transition-colors">Home</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
