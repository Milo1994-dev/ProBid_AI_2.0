import React, { useState, useEffect, useRef } from "react";
import { PricingCard } from "../components/ui/PricingCard";
import { track } from "../analytics";
import type { ReviewData } from "../api/client";

// ── Types ────────────────────────────────────────────────────────────────────

interface MarketingStats {
  estimatesGenerated: number | null;
  contractorsServed: number | null;
  regionsActive: number | null;
  photoAssistedEstimates: number | null;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useMarketingStats(): MarketingStats {
  const [stats, setStats] = useState<MarketingStats>({
    estimatesGenerated: null,
    contractorsServed: null,
    regionsActive: null,
    photoAssistedEstimates: null,
  });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/marketing/stats", { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((j) => {
        if (cancelled) return;
        const pick = (v: unknown): number | null => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        setStats({
          estimatesGenerated: pick(j?.data?.estimatesGenerated),
          contractorsServed: pick(j?.data?.contractorsServed),
          regionsActive: pick(j?.data?.regionsActive),
          photoAssistedEstimates: pick(j?.data?.photoAssistedEstimates),
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return stats;
}

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

// ── FadeIn ────────────────────────────────────────────────────────────────────

function FadeIn({ children, className = "", delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const { ref, inView } = useInView(0.1);
  const reducedMotion = usePrefersReducedMotion();
  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${className}`}
      style={{
        opacity: (inView || reducedMotion) ? 1 : 0,
        transform: (inView || reducedMotion) ? "translateY(0)" : "translateY(20px)",
        transitionDelay: reducedMotion ? "0ms" : `${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ── FAQ Item ──────────────────────────────────────────────────────────────────

function FaqItem({ question, answer, id }: { question: string; answer: string; id: string }) {
  const [open, setOpen] = useState(false);
  const panelId = `faq-panel-${id}`;
  return (
    <div className="border border-brand-border rounded-2xl overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-4 px-6 py-4 text-left bg-brand-card/30 hover:bg-brand-card/60 transition-colors"
        onClick={() => { setOpen((o) => !o); if (!open) track("faq_opened", { question }); }}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="text-sm font-semibold text-brand-textPrimary">{question}</span>
        <span className={`shrink-0 text-brand-green transition-transform duration-200 ${open ? "rotate-45" : ""}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </span>
      </button>
      {open && (
        <div id={panelId} role="region" className="px-6 py-4 text-sm text-brand-textMuted leading-relaxed border-t border-brand-border bg-brand-bg">
          {answer}
        </div>
      )}
    </div>
  );
}

// ── Interactive Demo ──────────────────────────────────────────────────────────

const demoJobs = [
  {
    id: "chimney",
    label: "Chimney Rebuild",
    icon: "🧱",
    description: "Full chimney tear-down and rebuild, 20ft, firebrick, new flue liner and cap, scaffolding, 2-man crew.",
    steps: ["Analyzing masonry scope...", "Pulling firebrick pricing (OH region)...", "Calculating labor for 2-man crew...", "Building itemized breakdown..."],
    lines: [
      { item: "Firebrick (500 ct)", cost: "$1,875" },
      { item: "Mortar mix (Type S, 40 bags)", cost: "$480" },
      { item: "Flue liner + cap", cost: "$620" },
      { item: "Scaffolding rental (3 days)", cost: "$450" },
    ],
    materials: "$3,425",
    labor: "$2,275",
    total: "$5,700",
    time: "28",
  },
  {
    id: "patio",
    label: "Stamped Patio",
    icon: "🏗️",
    description: "400 sq ft stamped concrete patio with border, 4\" slab, wire mesh, decorative stamp pattern, sealant.",
    steps: ["Measuring concrete volume...", "Checking aggregate pricing (IL region)...", "Estimating pour crew & finishing...", "Adding stamp pattern costs..."],
    lines: [
      { item: "Ready-mix concrete (5 yds)", cost: "$875" },
      { item: "Wire mesh & rebar", cost: "$320" },
      { item: "Stamp rental + release agent", cost: "$285" },
      { item: "Sealant (2 coats)", cost: "$180" },
    ],
    materials: "$1,660",
    labor: "$3,200",
    total: "$4,860",
    time: "24",
  },
  {
    id: "roof",
    label: "Roof Tear-Off",
    icon: "🏠",
    description: "30-square asphalt shingle tear-off and re-roof. New ice & water shield, drip edge, ridge vent.",
    steps: ["Calculating shingle squares...", "Pulling roofing material costs (MI)...", "Estimating crew for 2-day install...", "Adding disposal & permits..."],
    lines: [
      { item: "Architectural shingles (30 sq)", cost: "$3,600" },
      { item: "Underlayment + ice shield", cost: "$890" },
      { item: "Drip edge, vents, flashing", cost: "$420" },
      { item: "Dumpster + disposal", cost: "$650" },
    ],
    materials: "$5,560",
    labor: "$5,940",
    total: "$11,500",
    time: "31",
  },
];

function InteractiveDemo({ onCta, autoStart = false }: { onCta: () => void; autoStart?: boolean }) {
  const [selectedJob, setSelectedJob] = useState(0);
  const [phase, setPhase] = useState<"idle" | "analyzing" | "done">("idle");
  const [stepIndex, setStepIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const autoStarted = useRef(false);
  const job = demoJobs[selectedJob];

  const runDemo = () => {
    setPhase("analyzing");
    setStepIndex(0);
    setLineIndex(0);
  };

  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    const t = setTimeout(() => runDemo(), 1500);
    return () => clearTimeout(t);
  }, [autoStart]);

  useEffect(() => {
    if (phase !== "analyzing") return;
    if (stepIndex < job.steps.length) {
      const t = setTimeout(() => setStepIndex((i) => i + 1), reducedMotion ? 100 : 600);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => { setPhase("done"); setLineIndex(0); }, reducedMotion ? 50 : 300);
      return () => clearTimeout(t);
    }
  }, [phase, stepIndex, job.steps.length, reducedMotion]);

  useEffect(() => {
    if (phase !== "done") return;
    if (lineIndex < job.lines.length + 2) {
      const t = setTimeout(() => setLineIndex((i) => i + 1), reducedMotion ? 50 : 200);
      return () => clearTimeout(t);
    }
  }, [phase, lineIndex, job.lines.length, reducedMotion]);

  const handleJobChange = (i: number) => {
    setSelectedJob(i);
    setPhase("idle");
    setStepIndex(0);
    setLineIndex(0);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
      <div>
        <div className="flex flex-wrap gap-2 mb-5" role="tablist" aria-label="Demo job types">
          {demoJobs.map((j, i) => (
            <button
              key={j.id}
              type="button"
              role="tab"
              aria-selected={selectedJob === i}
              aria-controls="demo-estimate-panel"
              onClick={() => handleJobChange(i)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                selectedJob === i
                  ? "bg-brand-green text-gray-900 shadow-lg shadow-brand-green/20"
                  : "bg-brand-card border border-brand-border text-brand-textMuted hover:border-brand-green/30 hover:text-brand-textPrimary"
              }`}
            >
              <span className="mr-1.5" aria-hidden="true">{j.icon}</span>{j.label}
            </button>
          ))}
        </div>
        <div className="bg-brand-card border border-brand-border rounded-2xl p-5 mb-4">
          <p className="text-xs text-brand-textSubtle uppercase tracking-wider font-semibold mb-2">Job Description</p>
          <div className="bg-brand-bg rounded-xl border border-brand-border p-4 text-sm text-brand-textMuted leading-relaxed italic min-h-[80px]">
            "{job.description}"
          </div>
          <div className="flex items-center gap-3 mt-3">
            <div className="flex items-center gap-1.5 text-xs text-brand-textSubtle">
              <svg className="w-4 h-4 text-brand-green/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
              Or upload a photo
            </div>
            <div className="flex items-center gap-1.5 text-xs text-brand-textSubtle">
              <svg className="w-4 h-4 text-brand-indigo/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
              Voice dictation supported
            </div>
          </div>
          {phase === "idle" && (
            <button type="button" onClick={runDemo} className="w-full mt-4 bg-brand-green text-gray-900 font-bold rounded-xl py-2.5 text-sm hover:brightness-110 transition-all">
              Generate Estimate ▸
            </button>
          )}
          {phase === "analyzing" && (
            <div className="mt-4 space-y-2 text-xs text-brand-textMuted" aria-live="polite">
              {job.steps.slice(0, stepIndex + 1).map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-brand-green animate-pulse" aria-hidden="true">▸</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          )}
          {phase === "done" && (
            <button type="button" onClick={() => runDemo()} className="w-full mt-4 text-xs text-brand-textSubtle hover:text-brand-textMuted underline-offset-2 hover:underline">
              Run again
            </button>
          )}
        </div>
      </div>

      <div className="bg-brand-card border border-brand-border rounded-2xl p-5 sm:p-7" id="demo-estimate-panel" role="tabpanel">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-bold text-brand-green uppercase tracking-wider">AI Generated Estimate</span>
          {phase === "done" && <span className="text-[10px] font-semibold bg-brand-green/10 text-brand-green px-2 py-0.5 rounded-full">{job.time}s</span>}
        </div>
        {phase !== "done" ? (
          <div className="text-center py-12 text-brand-textSubtle text-sm">
            {phase === "analyzing" ? "Generating..." : "Click \"Generate Estimate\" to see the AI build a real estimate."}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {job.lines.slice(0, lineIndex).map((l, i) => (
              <div key={i} className="flex items-center justify-between text-brand-textMuted">
                <span>{l.item}</span>
                <span className="font-semibold text-brand-textPrimary">{l.cost}</span>
              </div>
            ))}
            {lineIndex >= job.lines.length && (
              <>
                <div className="h-px bg-brand-border my-3" />
                <div className="flex items-center justify-between">
                  <span className="text-brand-textMuted">Materials</span>
                  <span className="font-bold text-brand-textPrimary">{job.materials}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-brand-textMuted">Labor</span>
                  <span className="font-bold text-brand-textPrimary">{job.labor}</span>
                </div>
              </>
            )}
            {lineIndex >= job.lines.length + 1 && (
              <>
                <div className="flex items-center justify-between text-base bg-brand-green/10 border border-brand-green/30 rounded-xl px-3 py-2 mt-3">
                  <span className="font-bold text-brand-textPrimary">Total</span>
                  <span className="font-black text-brand-green text-lg">{job.total}</span>
                </div>
                <button
                  type="button"
                  onClick={onCta}
                  className="w-full mt-4 bg-brand-green text-gray-900 font-bold rounded-xl py-2.5 text-sm hover:brightness-110 transition-all"
                >
                  Try It On Your Own Job ▸
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── How It Works ──────────────────────────────────────────────────────────────

function HowItWorksSection() {
  const steps = [
    {
      num: "1",
      color: "green",
      icon: (
        <svg className="w-6 h-6 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      title: "Upload or Describe the Job",
      body: "Snap a photo on-site or type a quick description. Voice dictation works right from your phone.",
    },
    {
      num: "2",
      color: "indigo",
      icon: (
        <svg className="w-6 h-6 text-brand-indigo" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
        </svg>
      ),
      title: "AI Builds Your Estimate",
      body: "GPT-4 analyzes the scope, pulls current regional material prices, and calculates labor — in about 30 seconds.",
    },
    {
      num: "3",
      color: "green",
      icon: (
        <svg className="w-6 h-6 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      ),
      title: "Download & Send",
      body: "Get a professional PDF with line items, totals, and your contact info. Send it to the homeowner before your competitor even gets home.",
    },
  ];

  return (
    <section id="how-it-works" className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
      <div className="text-center mb-12">
        <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-3">How It Works</h2>
        <p className="text-brand-textMuted max-w-lg mx-auto text-sm">Three steps. No spreadsheet. No guesswork.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
        {steps.map((s, idx) => (
          <div key={idx} className="relative text-center group">
            {idx < steps.length - 1 && (
              <div className="hidden sm:block absolute top-8 left-[55%] w-[90%] h-px bg-gradient-to-r from-brand-border to-transparent" />
            )}
            <div className={`inline-flex items-center justify-center w-14 h-14 rounded-2xl ${s.color === "green" ? "bg-brand-green/10 border border-brand-green/20" : "bg-brand-indigo/10 border border-brand-indigo/20"} mb-4 group-hover:scale-110 transition-transform`}>
              {s.icon}
            </div>
            <div className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${s.color === "green" ? "bg-brand-green/20 text-brand-green" : "bg-brand-indigo/20 text-brand-indigo"} text-xs font-black mb-3 mx-auto`}>{s.num}</div>
            <h3 className="text-base font-bold text-brand-textPrimary mb-2">{s.title}</h3>
            <p className="text-sm text-brand-textMuted leading-relaxed max-w-xs mx-auto">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── ROI / Pain Section ────────────────────────────────────────────────────────

function RoiSection() {
  const pains = [
    {
      before: "2–4 hours per estimate, every night after work",
      after: "Under a minute, done before you drive home",
    },
    {
      before: "Guessing at material prices — and eating the difference",
      after: "Live regional pricing built into every line item",
    },
    {
      before: "Losing jobs to contractors who quote faster",
      after: "Send a professional PDF while you're still on-site",
    },
    {
      before: "Embarrassing handwritten quotes or messy spreadsheets",
      after: "Branded, itemized PDF that makes you look like a $10M company",
    },
  ];

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
      <div className="text-center mb-12">
        <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-3">
          Stop Losing Money From Bad Estimates
        </h2>
        <p className="text-brand-textMuted max-w-xl mx-auto text-sm leading-relaxed">
          Most contractors waste evenings on paperwork and lose jobs to whoever quotes first. ProBid AI fixes both.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {pains.map(({ before, after }, i) => (
          <div key={i} className="rounded-2xl border border-brand-border bg-brand-card/50 p-6 hover:border-brand-green/30 transition-all">
            <div className="flex items-start gap-3 mb-3">
              <div className="mt-0.5 w-5 h-5 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
                <svg className="w-3 h-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
              </div>
              <p className="text-sm text-brand-textSubtle leading-snug">{before}</p>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 w-5 h-5 rounded-full bg-brand-green/15 border border-brand-green/30 flex items-center justify-center shrink-0">
                <svg className="w-3 h-3 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
              </div>
              <p className="text-sm text-brand-textPrimary font-medium leading-snug">{after}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Trade Focus Cards ─────────────────────────────────────────────────────────

function TradeSection() {
  const trades = [
    {
      icon: "🏠",
      name: "Roofing",
      desc: "Square footage, tear-off, shingles, underlayment, ridge vents, disposal — all priced by region.",
    },
    {
      icon: "🧱",
      name: "Masonry",
      desc: "Brick and block by unit, mortar mix types, tuckpointing vs. full rebuild scope, scaffolding.",
    },
    {
      icon: "🏗️",
      name: "Concrete",
      desc: "Slabs, footings, stamped patios, driveways — mix volume, rebar, pump trucks, finishing labor.",
    },
    {
      icon: "🔨",
      name: "Remodeling",
      desc: "Demo, framing, drywall, trim, paint — full interior remodel cost breakdowns.",
    },
    {
      icon: "🪟",
      name: "Windows & Doors",
      desc: "Opening modification, unit cost by size, installation labor, finish trim work.",
    },
    {
      icon: "🛠️",
      name: "General Construction",
      desc: "Foundations, additions, garages, decks — multi-trade scope, materials, crew hours.",
    },
  ];

  return (
    <section className="bg-brand-card/30 border-y border-brand-border py-16 sm:py-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-10">
          <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-3">
            Built for Every Trade
          </h2>
          <p className="text-brand-textMuted max-w-lg mx-auto text-sm">
            ProBid AI knows what materials your trade uses, what it costs in your region, and how long it takes.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {trades.map(({ icon, name, desc }) => (
            <div key={name} className="rounded-2xl bg-brand-card border border-brand-border p-6 hover:border-brand-green/30 hover:-translate-y-1 transition-all duration-300">
              <span className="text-2xl mb-3 block">{icon}</span>
              <h3 className="font-bold text-brand-textPrimary text-sm mb-1.5">{name}</h3>
              <p className="text-xs text-brand-textMuted leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
        <p className="text-center text-xs text-brand-textSubtle mt-6">
          Also supported: Chimney repair, painting, flooring, HVAC, plumbing, electrical, landscaping, and more.
        </p>
      </div>
    </section>
  );
}

// ── Stats + Testimonials ──────────────────────────────────────────────────────

function SocialProofSection({ stats, reviewsData }: {
  stats: MarketingStats;
  reviewsData: { reviews: ReviewData[]; aggregate: { avgRating: number; totalCount: number } } | null;
}) {
  const realReviews = reviewsData?.reviews ?? [];
  const showReviews = realReviews.length >= 3;
  const displayReviews = realReviews.slice(0, 3);

  const statItems = [
    {
      label: "Estimates generated",
      value: stats.estimatesGenerated != null ? stats.estimatesGenerated.toLocaleString() + "+" : "Thousands",
      sub: "and growing every day",
    },
    {
      label: "Contractors served",
      value: stats.contractorsServed != null ? stats.contractorsServed.toLocaleString() + "+" : "500+",
      sub: "across the US",
    },
    {
      label: "Time saved per estimate",
      value: "2–3 hrs",
      sub: "vs. manual quoting",
    },
    {
      label: "Estimate delivery",
      value: "< 60s",
      sub: "from job description to PDF",
    },
  ];

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
      <div className="text-center mb-10">
        <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-3">
          Contractors Are Winning More Jobs
        </h2>
        <p className="text-brand-textMuted max-w-lg mx-auto text-sm">Real usage numbers from the ProBid AI platform.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-14">
        {statItems.map(({ label, value, sub }) => (
          <div key={label} className="bg-brand-card border border-brand-border rounded-2xl p-5 text-center">
            <p className="text-2xl font-black text-brand-green mb-1">{value}</p>
            <p className="text-xs font-semibold text-brand-textPrimary mb-0.5">{label}</p>
            <p className="text-[10px] text-brand-textSubtle">{sub}</p>
          </div>
        ))}
      </div>

      {showReviews && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {displayReviews.map((t, i) => {
            const name = t.userName ?? "Contractor";
            const quote = t.comment ?? "";
            const role = t.userTrade ?? "";
            const initials = name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
            if (!quote) return null;
            return (
              <div key={i} className="bg-brand-card border border-brand-border rounded-2xl p-6 flex flex-col gap-4 hover:border-brand-green/20 transition-colors">
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <svg key={s} width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-yellow-400">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                  ))}
                </div>
                <p className="text-brand-textMuted text-sm leading-relaxed flex-1">"{quote}"</p>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-brand-indigo/20 flex items-center justify-center text-brand-indigo text-xs font-bold shrink-0">
                    {initials}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-brand-textPrimary">{name}</p>
                    <p className="text-xs text-brand-textSubtle">{role}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Pricing Section ───────────────────────────────────────────────────────────

function PricingSection({
  handlePricingCta,
  setPricingNode,
  checkoutLoading,
  checkoutError,
}: {
  handlePricingCta: (plan: "free" | "pro" | "business") => void | Promise<void>;
  setPricingNode: (node: HTMLElement | null) => void;
  checkoutLoading: string | null;
  checkoutError: string;
}) {
  return (
    <section
      id="pricing"
      ref={setPricingNode as React.RefCallback<HTMLElement>}
      className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-20"
    >
      <div className="text-center mb-4">
        <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-3">
          Simple, Transparent Pricing
        </h2>
        <p className="text-brand-textMuted max-w-lg mx-auto text-sm">
          Start free. Upgrade when it's making you money.
        </p>
        <p className="text-brand-green text-sm font-bold mt-2">
          Close one extra job and ProBid pays for itself.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4 mb-10 mt-6">
        {[
          { icon: "🔒", label: "Secure Stripe checkout" },
          { icon: "↩️", label: "7-day money-back guarantee" },
          { icon: "✅", label: "Cancel anytime" },
        ].map(({ icon, label }) => (
          <span key={label} className="flex items-center gap-2 text-xs text-brand-textSubtle">
            <span>{icon}</span> {label}
          </span>
        ))}
      </div>

      {checkoutError && (
        <p className="text-red-400 text-sm text-center bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2 mb-6 max-w-xl mx-auto">
          {checkoutError}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl mx-auto">
        <PricingCard
          name="Single Estimate"
          price="$7"
          period=""
          description="Try it on a real job"
          features={[
            "1 AI-powered estimate",
            "Materials + labor breakdown",
            "Regional pricing included",
            "PDF download & send",
          ]}
          cta="Get One Estimate — $7"
          onCta={() => handlePricingCta("free")}
        />
        <PricingCard
          name="Pro"
          price="$25"
          description="For solo contractors"
          features={[
            "Unlimited estimates",
            "Photo analysis (GPT-4 Vision)",
            "PDF export & saved history",
            "Client-ready branded reports",
            "Estimate templates",
            "Priority support",
          ]}
          cta="Start 7-Day Free Trial"
          onCta={() => handlePricingCta("pro")}
          loading={checkoutLoading === "pro"}
          popular
          trialDays={7}
        />
        <PricingCard
          name="Business"
          price="$55"
          description="For teams and growing companies"
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
    </section>
  );
}

// ── FAQ Section ───────────────────────────────────────────────────────────────

function FaqSection() {
  const faqs = [
    {
      id: "how-fast",
      question: "How fast does it actually generate an estimate?",
      answer: "Most estimates are done in under 60 seconds. You describe the job (or upload a photo), and ProBid AI returns a full itemized breakdown with materials, labor, and totals. The more detail you give, the sharper the output.",
    },
    {
      id: "trades",
      question: "What trades does ProBid AI support?",
      answer: "Roofing, masonry, concrete, chimney repair, remodeling, windows & doors, painting, flooring, HVAC, plumbing, electrical, landscaping, demolition, and general construction. The AI understands trade-specific materials, crew sizes, and regional labor rates.",
    },
    {
      id: "accuracy",
      question: "How accurate are the estimates?",
      answer: "ProBid AI pulls current regional material pricing and standard labor rates verified against real Procore project data. Estimates are designed as a solid starting point — review the line items against your own knowledge before sending to a client. More detail in = more accurate output.",
    },
    {
      id: "mobile",
      question: "Can I use it on my phone at the job site?",
      answer: "Absolutely. ProBid AI is fully mobile-optimized. Snap photos from your camera, use voice dictation to describe the job, and generate estimates on the spot — before you even leave the property.",
    },
    {
      id: "pdf",
      question: "What does the PDF look like?",
      answer: "Clean, professional, client-ready. Every estimate generates a branded PDF with itemized materials, labor costs, and totals. Homeowners see it and think you're a $10M operation.",
    },
    {
      id: "subscription",
      question: "Do I need a subscription?",
      answer: "You can grab a single estimate for $7 to try it, or start a 7-day free trial of Pro at $25/month for unlimited estimates, saved history, and templates. No charge during the trial — cancel any time. The Pro plan pays for itself with one extra closed job.",
    },
    {
      id: "guarantee",
      question: "What if it doesn't work for my trade?",
      answer: "We offer a 7-day free trial on Pro and a 30-day money-back guarantee on your first paid month. If ProBid doesn't save you time and win you more jobs, you pay nothing. Cancel any time from your dashboard.",
    },
  ];

  return (
    <section id="faq" className="bg-brand-card/40 border-y border-brand-border py-16 sm:py-20">
      <div className="max-w-2xl mx-auto px-4 sm:px-6">
        <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary text-center mb-10">
          Frequently Asked Questions
        </h2>
        <div className="flex flex-col gap-3">
          {faqs.map(({ id, question, answer }) => (
            <FaqItem key={id} id={id} question={question} answer={answer} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Props & Export ─────────────────────────────────────────────────────────────

export interface BelowFoldProps {
  handleCta: (location: string) => void;
  handlePricingCta: (plan: "free" | "pro" | "business") => void | Promise<void>;
  setPricingNode: (node: HTMLElement | null) => void;
  checkoutLoading: string | null;
  checkoutError: string;
  reviewsData: { reviews: ReviewData[]; aggregate: { avgRating: number; totalCount: number } } | null;
}

export default function BelowFold({
  handleCta,
  handlePricingCta,
  setPricingNode,
  checkoutLoading,
  checkoutError,
  reviewsData,
}: BelowFoldProps) {
  const stats = useMarketingStats();

  return (
    <>
      {/* Interactive Live Demo */}
      <FadeIn>
        <section id="demo" className="bg-brand-card/30 border-y border-brand-border py-16 sm:py-20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-black text-brand-textPrimary mb-3">
                Watch It Build a Real Estimate
              </h2>
              <p className="text-brand-textMuted max-w-lg mx-auto text-sm">
                No signup needed. Pick a job type and watch ProBid AI build a live estimate in real time.
              </p>
            </div>
            <InteractiveDemo
              autoStart
              onCta={() => {
                track("demo_section_cta_click", { location: "demo_section" });
                handleCta("demo_section");
              }}
            />
          </div>
        </section>
      </FadeIn>

      {/* How It Works */}
      <FadeIn>
        <HowItWorksSection />
      </FadeIn>

      {/* ROI / Pain */}
      <FadeIn>
        <div className="bg-brand-card/20 border-y border-brand-border">
          <RoiSection />
        </div>
      </FadeIn>

      {/* Trade Focus */}
      <FadeIn>
        <TradeSection />
      </FadeIn>

      {/* Social Proof + Stats */}
      <FadeIn>
        <SocialProofSection stats={stats} reviewsData={reviewsData} />
      </FadeIn>

      {/* Pricing */}
      <FadeIn>
        <div className="bg-brand-card/20 border-y border-brand-border">
          <PricingSection
            handlePricingCta={handlePricingCta}
            setPricingNode={setPricingNode}
            checkoutLoading={checkoutLoading}
            checkoutError={checkoutError}
          />
        </div>
      </FadeIn>

      {/* FAQ */}
      <FadeIn>
        <FaqSection />
      </FadeIn>
    </>
  );
}
