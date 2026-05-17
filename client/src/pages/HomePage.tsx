import React, { useState, useEffect, useRef, memo, lazy, Suspense } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Button } from "../components/ui/Button";
import { api, ReviewData } from "../api/client";
import { track, generateEventId } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";
import { GuaranteeBlock } from "../components/GuaranteeBlock";

const HomeBelowFold = lazy(() => import("./HomeBelowFold"));

// ── Utilities ────────────────────────────────────────────────────────────────

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function useInView(threshold = 0.2) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { threshold }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function useAnimatedCounter(end: number, duration: number = 2000, start: boolean = true) {
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (reduced) { setCount(end); return; }
    let startTime: number | null = null;
    let raf: number;
    const step = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * end));
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [end, duration, start, reduced]);
  return count;
}

type MarketingStats = { estimatesGenerated: number; contractorsServed: number };

function useMarketingStats() {
  const [data, setData] = useState<MarketingStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/marketing/stats", { credentials: "omit" })
      .then(r => r.ok ? r.json() : null)
      .then(json => { if (!cancelled && json?.data) setData(json.data as MarketingStats); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return data;
}

// ── Lead Capture Modal ───────────────────────────────────────────────────────

const TRADES = [
  "Roofing",
  "Masonry / Tuckpointing",
  "Concrete",
  "Chimney Repair / Rebuild",
  "Remodeling",
  "General Construction",
  "Other",
];

interface LeadForm {
  name: string;
  email: string;
  phone: string;
  zip: string;
  tradeType: string;
  description: string;
}

function LeadCaptureModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (email: string, name: string, trade: string) => void;
}) {
  const [form, setForm] = useState<LeadForm>({ name: "", email: "", phone: "", zip: "", tradeType: "", description: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setError("");
      setTimeout(() => firstFieldRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const set = (k: keyof LeadForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.tradeType) {
      setError("Please fill in your name, email, and trade type.");
      return;
    }
    setError("");
    setSubmitting(true);
    track("lead_form_submitted", { tradeType: form.tradeType });
    try {
      const metaEventId = generateEventId();
      track("lead_captured", { tradeType: form.tradeType }, metaEventId);
      await fetch("/api/leads/homepage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          tradeType: form.tradeType,
          description: form.description.trim() || undefined,
          meta_event_id: metaEventId,
        }),
      });
    } catch {
      // Fire-and-forget; don't block the user flow on save failure
    }
    setSubmitting(false);
    onSuccess(form.email.trim(), form.name.trim(), form.tradeType);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      aria-modal="true"
      role="dialog"
      aria-label="Get your free estimate"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-brand-card border border-brand-border rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 sm:p-8">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-brand-textSubtle hover:text-brand-textMuted transition-colors p-1 rounded-lg hover:bg-brand-bg/50"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-8 h-8 rounded-lg bg-brand-green/15 border border-brand-green/30 flex items-center justify-center">
                <svg className="w-4 h-4 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
              <span className="text-xs font-semibold text-brand-green uppercase tracking-wider">Free Estimate</span>
            </div>
            <h2 className="text-2xl font-black text-brand-textPrimary leading-tight">
              Generate My Free Estimate
            </h2>
            <p className="text-sm text-brand-textMuted mt-1">
              Tell us about the job — ProBid AI builds the estimate in 30 seconds.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-brand-textMuted mb-1.5">Your Name <span className="text-brand-green">*</span></label>
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={form.name}
                  onChange={set("name")}
                  placeholder="Jesse Kirchner"
                  required
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-sm text-brand-textPrimary placeholder-brand-textSubtle focus:outline-none focus:border-brand-green/50 focus:ring-1 focus:ring-brand-green/30 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-brand-textMuted mb-1.5">Email <span className="text-brand-green">*</span></label>
                <input
                  type="email"
                  value={form.email}
                  onChange={set("email")}
                  placeholder="jesse@example.com"
                  required
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-sm text-brand-textPrimary placeholder-brand-textSubtle focus:outline-none focus:border-brand-green/50 focus:ring-1 focus:ring-brand-green/30 transition-colors"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-brand-textMuted mb-1.5">Phone</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={set("phone")}
                  placeholder="(815) 281-1757"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-sm text-brand-textPrimary placeholder-brand-textSubtle focus:outline-none focus:border-brand-green/50 focus:ring-1 focus:ring-brand-green/30 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-brand-textMuted mb-1.5">ZIP Code</label>
                <input
                  type="text"
                  value={form.zip}
                  onChange={set("zip")}
                  placeholder="61036"
                  maxLength={10}
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-sm text-brand-textPrimary placeholder-brand-textSubtle focus:outline-none focus:border-brand-green/50 focus:ring-1 focus:ring-brand-green/30 transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-brand-textMuted mb-1.5">Trade Type <span className="text-brand-green">*</span></label>
              <select
                value={form.tradeType}
                onChange={set("tradeType")}
                required
                className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-sm text-brand-textPrimary focus:outline-none focus:border-brand-green/50 focus:ring-1 focus:ring-brand-green/30 transition-colors"
              >
                <option value="" disabled>Select your trade...</option>
                {TRADES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-brand-textMuted mb-1.5">Describe the Job</label>
              <textarea
                value={form.description}
                onChange={set("description")}
                placeholder="e.g. 3 car garage roof tear-off, 24 squares, hip roof, replace with 30yr architectural shingles..."
                rows={3}
                className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-sm text-brand-textPrimary placeholder-brand-textSubtle focus:outline-none focus:border-brand-green/50 focus:ring-1 focus:ring-brand-green/30 transition-colors resize-none"
              />
            </div>
            <p className="text-xs text-brand-textSubtle">
              You can also upload job photos after creating your free account.
            </p>

            {error && (
              <p className="text-sm text-brand-error bg-brand-error/10 border border-brand-error/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <Button type="submit" fullWidth size="lg" disabled={submitting} className="mt-2">
              {submitting ? "Saving your info..." : "Generate My Free Estimate →"}
            </Button>
            <p className="text-center text-xs text-brand-textSubtle">
              No credit card &middot; Takes 30 seconds &middot; Built for contractors
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Exit Intent Popup ────────────────────────────────────────────────────────

function ExitIntentPopup({ onGetEstimate, onDismiss }: { onGetEstimate: () => void; onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Wait — get a free estimate">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onDismiss} />
      <div className="relative w-full max-w-md bg-brand-card border border-brand-green/40 rounded-2xl shadow-2xl p-8 text-center">
        <button onClick={onDismiss} className="absolute top-4 right-4 text-brand-textSubtle hover:text-brand-textMuted p-1" aria-label="Dismiss">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <div className="w-14 h-14 rounded-2xl bg-brand-green/15 border border-brand-green/30 flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h3 className="text-2xl font-black text-brand-textPrimary mb-2">Wait — before you go</h3>
        <p className="text-brand-textMuted mb-6 text-sm leading-relaxed">
          Get one free estimate before you leave. Takes 30 seconds. No credit card required.
        </p>
        <Button size="lg" fullWidth onClick={onGetEstimate} className="mb-3">
          Get My Free Estimate
        </Button>
        <button onClick={onDismiss} className="text-xs text-brand-textSubtle hover:text-brand-textMuted transition-colors">
          No thanks, I'll keep doing estimates by hand
        </button>
      </div>
    </div>
  );
}

// ── Mock Estimate Card ───────────────────────────────────────────────────────

const EstimateCard = memo(function EstimateCard() {
  return (
    <div className="w-full max-w-sm rounded-2xl border border-brand-green/30 bg-brand-card shadow-xl shadow-brand-green/10 overflow-hidden">
      <div className="bg-gradient-to-br from-brand-green/20 to-brand-indigo/10 px-5 py-4 border-b border-brand-border">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-brand-green uppercase tracking-wide">AI Estimate</span>
          <span className="text-xs bg-brand-green/20 text-brand-green px-2 py-0.5 rounded-full font-medium">Ready in 30s</span>
        </div>
        <h3 className="text-sm font-bold text-brand-textPrimary">Chimney Rebuild — 2-story brick</h3>
        <p className="text-xs text-brand-textSubtle mt-0.5">123 Oak St, Chicago IL 60601</p>
      </div>
      <div className="p-5 space-y-3">
        <div className="space-y-2">
          {[
            { label: "Materials (brick, mortar, flashing)", value: "$3,200" },
            { label: "Labor (3-4 days, 2 crew)", value: "$2,800" },
            { label: "Equipment & overhead", value: "$640" },
            { label: "Profit margin (18%)", value: "$1,188" },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between text-xs">
              <span className="text-brand-textMuted">{label}</span>
              <span className="font-semibold text-brand-textPrimary">{value}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-brand-border pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-brand-textPrimary">Range</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[{ label: "Low", value: "$6,800", muted: true }, { label: "Standard", value: "$7,828", highlight: true }, { label: "Premium", value: "$9,200", muted: true }].map(opt => (
              <div key={opt.label} className={`text-center rounded-lg py-2 px-1 border ${opt.highlight ? "border-brand-green/50 bg-brand-green/10" : "border-brand-border bg-brand-bg/50"}`}>
                <p className={`text-[10px] font-medium ${opt.highlight ? "text-brand-green" : "text-brand-textSubtle"}`}>{opt.label}</p>
                <p className={`text-sm font-black ${opt.highlight ? "text-brand-green" : "text-brand-textMuted"}`}>{opt.value}</p>
              </div>
            ))}
          </div>
        </div>
        <button className="w-full flex items-center justify-center gap-2 text-xs font-semibold text-brand-green border border-brand-green/30 rounded-lg py-2 hover:bg-brand-green/5 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
          Download PDF
        </button>
      </div>
    </div>
  );
});

// ── Trust Badges ─────────────────────────────────────────────────────────────

const TRUST_ITEMS = [
  { icon: "🤖", label: "AI-powered estimates" },
  { icon: "🏠", label: "Built for roofers, masons, concrete, remodeling" },
  { icon: "📄", label: "PDF-ready proposals" },
];

// ── Animated Stat ─────────────────────────────────────────────────────────────

const AnimatedStat = memo(function AnimatedStat({ end, duration, start, label, suffix = "+" }: { end: number; duration: number; start: boolean; label: string; suffix?: string }) {
  const count = useAnimatedCounter(end, duration, start);
  return (
    <div className="text-center">
      <p className="text-2xl sm:text-3xl font-black text-brand-green">{count.toLocaleString()}{suffix}</p>
      <p className="text-xs text-brand-textSubtle mt-1">{label}</p>
    </div>
  );
});

// ── Live Counter Bar ──────────────────────────────────────────────────────────

function LiveCounterBar() {
  const stats = useMarketingStats();
  const { ref, inView } = useInView(0.3);

  if (!stats || (stats.estimatesGenerated < 10 && stats.contractorsServed < 10)) return null;

  return (
    <section ref={ref} className="border-y border-brand-border bg-brand-card/40 py-6">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-16">
          {stats.estimatesGenerated >= 10 && (
            <AnimatedStat end={stats.estimatesGenerated} duration={1800} start={inView} label="Estimates generated" />
          )}
          {stats.contractorsServed >= 10 && (
            <AnimatedStat end={stats.contractorsServed} duration={1600} start={inView} label="Contractors helped" />
          )}
          <AnimatedStat end={3} duration={1400} start={inView} label="Avg. hours saved per estimate" suffix="hrs" />
          <AnimatedStat end={100} duration={2000} start={inView} label="Free to get started" suffix="%" />
        </div>
      </div>
    </section>
  );
}

// ── Sticky Mobile CTA ─────────────────────────────────────────────────────────

function StickyMobileCta({ onClick }: { onClick: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 500);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!visible) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 sm:hidden bg-brand-card/95 backdrop-blur border-t border-brand-border px-4 py-3">
      <Button fullWidth size="lg" onClick={() => { track("sticky_mobile_cta_click"); onClick(); }}>
        Generate Free Estimate
      </Button>
    </div>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav({ onCta, user }: { onCta: () => void; user: any }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks = [
    { label: "How It Works", href: "#how-it-works" },
    { label: "Pricing", href: "#pricing" },
    { label: "FAQ", href: "#faq" },
  ];

  return (
    <nav className="sticky top-0 z-40 bg-brand-bg/90 backdrop-blur border-b border-brand-border">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 text-brand-green font-black text-lg tracking-tight">
          <svg className="w-7 h-7" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="currentColor" fillOpacity="0.15"/>
            <path d="M8 22V10l8 6-8 6z" fill="currentColor"/>
            <rect x="18" y="10" width="6" height="12" rx="1" fill="currentColor" fillOpacity="0.6"/>
          </svg>
          ProBid AI
        </Link>

        <div className="hidden sm:flex items-center gap-6">
          {navLinks.map(l => (
            <a key={l.label} href={l.href} className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">
              {l.label}
            </a>
          ))}
          {user ? (
            <Link to="/app"><Button size="sm">Dashboard</Button></Link>
          ) : (
            <>
              <Link to="/login"><Button variant="ghost" size="sm">Log In</Button></Link>
              <Button size="sm" onClick={onCta}>Get Started Free</Button>
            </>
          )}
        </div>

        <button
          className="sm:hidden text-brand-textMuted hover:text-brand-textPrimary p-1"
          onClick={() => setMobileOpen(o => !o)}
          aria-label="Toggle menu"
        >
          {mobileOpen ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
          )}
        </button>
      </div>

      {mobileOpen && (
        <div className="sm:hidden border-t border-brand-border bg-brand-card px-4 py-4 flex flex-col gap-3">
          {navLinks.map(l => (
            <a key={l.label} href={l.href} className="text-sm text-brand-textMuted hover:text-brand-textPrimary" onClick={() => setMobileOpen(false)}>{l.label}</a>
          ))}
          <div className="border-t border-brand-border pt-3 flex flex-col gap-2">
            {user ? (
              <Link to="/app" onClick={() => setMobileOpen(false)}><Button size="sm" fullWidth>Dashboard</Button></Link>
            ) : (
              <>
                <Link to="/login" onClick={() => setMobileOpen(false)}><Button variant="ghost" size="sm" fullWidth>Log In</Button></Link>
                <Button size="sm" fullWidth onClick={() => { setMobileOpen(false); onCta(); }}>Get Started Free</Button>
              </>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}

// ── Hero Section ──────────────────────────────────────────────────────────────

function Hero({ onCta, user }: { onCta: (location: string) => void; user: any }) {
  return (
    <section className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-14 sm:pt-20 pb-12 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-[500px] h-[500px] bg-brand-green/6 rounded-full blur-3xl" />
        <div className="absolute -top-20 right-0 w-80 h-80 bg-brand-indigo/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full h-px bg-gradient-to-r from-transparent via-brand-green/20 to-transparent" />
      </div>

      <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        {/* Left column */}
        <div className="text-center lg:text-left">
          <p className="inline-flex items-center gap-2 text-xs font-semibold text-brand-green uppercase tracking-wider mb-4 bg-brand-green/10 border border-brand-green/20 rounded-full px-3 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-green animate-pulse" />
            AI-powered • Built for contractors
          </p>

          <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-black text-brand-textPrimary leading-[1.1] mb-5">
            Get a Professional{" "}
            <span className="text-brand-green">Construction Estimate</span>{" "}
            in 30 Seconds
          </h1>

          <p className="text-base sm:text-lg text-brand-textMuted max-w-xl mx-auto lg:mx-0 mb-7 leading-relaxed">
            Upload a photo or describe the job — ProBid AI generates a full estimate with labor, materials, markup, profit, and customer-ready pricing built in.
          </p>

          <div className="flex flex-col sm:flex-row items-center lg:items-start justify-center lg:justify-start gap-3 mb-4">
            <Button
              size="lg"
              onClick={() => { track("cta_click", { location: "hero_primary" }); onCta("hero_primary"); }}
              className="text-base px-8 py-4 shadow-lg shadow-brand-green/20 hover:shadow-brand-green/40 transition-shadow w-full sm:w-auto"
            >
              Generate My Free Estimate
            </Button>
            <a
              href="#demo"
              className="inline-flex items-center gap-2 text-sm font-semibold text-brand-textMuted hover:text-brand-textPrimary border border-brand-border hover:border-brand-green/40 rounded-full px-5 py-3 transition-all"
              onClick={() => track("cta_click", { location: "hero_secondary" })}
            >
              <svg className="w-4 h-4 text-brand-green" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              See Example Estimate
            </a>
          </div>

          <p className="text-sm text-brand-textSubtle font-medium mb-5">
            No credit card &middot; Takes 30 seconds &middot; Built for contractors
          </p>

          {/* Trust badges */}
          <div className="flex flex-wrap justify-center lg:justify-start gap-2">
            {TRUST_ITEMS.map(({ icon, label }) => (
              <span key={label} className="flex items-center gap-1.5 text-xs text-brand-textMuted bg-brand-card/60 border border-brand-border rounded-full px-3 py-1.5">
                <span>{icon}</span>
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Right column — mock estimate card */}
        <div className="flex justify-center lg:justify-end">
          <EstimateCard />
        </div>
      </div>
    </section>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [leadModalOpen, setLeadModalOpen] = useState(false);
  const [exitPopupOpen, setExitPopupOpen] = useState(false);
  const [exitPopupDismissed, setExitPopupDismissed] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const [reviewsData, setReviewsData] = useState<{ reviews: ReviewData[]; aggregate: { avgRating: number; totalCount: number } } | null>(null);
  const [showBelowFold, setShowBelowFold] = useState(false);
  const pricingNodeRef = useRef<HTMLElement | null>(null);

  usePageMeta({
    title: "ProBid AI — Construction Estimates in 30 Seconds",
    description:
      "Generate professional construction estimates from a photo or job description in seconds. Built for roofers, masons, concrete contractors, remodelers, and small construction businesses.",
    canonical: "https://probidcore.net/",
  });

  // Lazy-load below fold after hero renders
  useEffect(() => {
    const timer = setTimeout(() => setShowBelowFold(true), 50);
    return () => clearTimeout(timer);
  }, []);

  // Exit-intent detection
  useEffect(() => {
    if (exitPopupDismissed || user) return;
    const handler = (e: MouseEvent) => {
      if (e.clientY < 20 && !leadModalOpen) {
        track("exit_intent_triggered");
        setExitPopupOpen(true);
        setExitPopupDismissed(true);
      }
    };
    document.addEventListener("mouseleave", handler);
    return () => document.removeEventListener("mouseleave", handler);
  }, [exitPopupDismissed, user, leadModalOpen]);

  // Fetch reviews
  useEffect(() => {
    api.getReviews()
      .then(r => { if (r.data) setReviewsData(r.data as any); })
      .catch(() => {});
  }, []);

  const openLeadModal = (location: string) => {
    track("estimate_form_started", { location });
    if (user) {
      navigate("/app/estimate/new");
    } else {
      setLeadModalOpen(true);
    }
  };

  const handleLeadSuccess = (email: string, name: string, trade: string) => {
    setLeadModalOpen(false);
    track("lead_captured_redirect", { trade });
    const params = new URLSearchParams({ email, name, trade });
    navigate(`/signup?${params.toString()}`);
  };

  const handlePricingCta = async (plan: "free" | "pro" | "business") => {
    track("pricing_cta_click", { plan });
    if (plan === "free") {
      openLeadModal("pricing");
      return;
    }
    if (!user) {
      navigate("/signup");
      return;
    }
    const metaEventId = generateEventId();
    track("checkout_started", { plan }, metaEventId);
    setCheckoutError("");
    setCheckoutLoading(plan);
    try {
      const res = await api.createCheckoutSession(plan, "monthly", metaEventId);
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else {
        setCheckoutError("Failed to start checkout. Please try again.");
      }
    } catch (err: any) {
      setCheckoutError(err?.apiError ?? err?.message ?? "Failed to start checkout.");
    } finally {
      setCheckoutLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-brand-bg">
      <Nav onCta={() => openLeadModal("nav")} user={user} />

      <Hero onCta={openLeadModal} user={user} />

      <LiveCounterBar />

      <Suspense fallback={null}>
        {showBelowFold && (
          <HomeBelowFold
            handleCta={openLeadModal}
            handlePricingCta={handlePricingCta}
            setPricingNode={(n) => { pricingNodeRef.current = n; }}
            checkoutLoading={checkoutLoading}
            checkoutError={checkoutError}
            reviewsData={reviewsData}
          />
        )}
      </Suspense>

      {/* Guarantee stack */}
      <GuaranteeBlock variant="full" />

      {/* Final CTA */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center">
        <div className="relative rounded-2xl overflow-hidden border border-brand-green/30 bg-gradient-to-br from-brand-green/10 via-brand-card to-brand-indigo/10 p-10 sm:p-14">
          <div className="absolute inset-0 bg-grid-pattern opacity-20 pointer-events-none" />
          <div className="relative">
            <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-4">
              Your Next Estimate Takes 30 Seconds
            </h2>
            <p className="text-brand-textMuted mb-8 max-w-lg mx-auto leading-relaxed">
              Try ProBid AI free and see how fast you can turn a job photo into a professional estimate.
            </p>
            <Button size="lg" onClick={() => { track("cta_click", { location: "bottom_cta" }); openLeadModal("bottom_cta"); }} className="text-base px-10 py-4 shadow-lg shadow-brand-green/20 hover:shadow-brand-green/40 transition-shadow">
              Generate My Free Estimate
            </Button>
            <p className="text-sm text-brand-textSubtle mt-4">7-day free trial &middot; $7 single estimate &middot; Cancel anytime</p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-brand-border py-8 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-brand-textSubtle">
          <span className="flex items-center gap-2 font-bold text-brand-green">
            <svg className="w-5 h-5" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="currentColor" fillOpacity="0.15"/>
              <path d="M8 22V10l8 6-8 6z" fill="currentColor"/>
              <rect x="18" y="10" width="6" height="12" rx="1" fill="currentColor" fillOpacity="0.6"/>
            </svg>
            ProBid AI
          </span>
          <div className="flex flex-wrap justify-center gap-4">
            <Link to="/pricing" className="hover:text-brand-textMuted transition-colors">Pricing</Link>
            <Link to="/about" className="hover:text-brand-textMuted transition-colors">About</Link>
            <Link to="/contact" className="hover:text-brand-textMuted transition-colors">Contact</Link>
            <Link to="/login" className="hover:text-brand-textMuted transition-colors">Log In</Link>
            <Link to="/signup" className="hover:text-brand-textMuted transition-colors">Sign Up</Link>
          </div>
          <span>© {new Date().getFullYear()} ProBid AI · Built for contractors</span>
        </div>
      </footer>

      {/* Modals */}
      <LeadCaptureModal
        open={leadModalOpen}
        onClose={() => setLeadModalOpen(false)}
        onSuccess={handleLeadSuccess}
      />

      {exitPopupOpen && (
        <ExitIntentPopup
          onGetEstimate={() => { setExitPopupOpen(false); track("exit_intent_cta_click"); openLeadModal("exit_intent"); }}
          onDismiss={() => { setExitPopupOpen(false); track("exit_intent_dismissed"); }}
        />
      )}

      <StickyMobileCta onClick={() => openLeadModal("sticky_mobile")} />
    </div>
  );
}
