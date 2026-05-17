import { useEffect, useState } from "react";

const DEMO_LINE_ITEMS: Array<{ label: string; price: string }> = [
  { label: "Asphalt shingles (30 sq, architectural)", price: "$4,200" },
  { label: "Synthetic underlayment (8 rolls)", price: "$480" },
  { label: "Drip edge + step flashing", price: "$310" },
  { label: "Ridge vent (40 ft)", price: "$260" },
  { label: "Tear-off + dump (3-layer)", price: "$1,150" },
  { label: "Labor (2-man crew, 2 days)", price: "$2,400" },
];

interface AnimatedDemoProps {
  forcePhase?: number;
  forceRevealedItems?: number;
  /**
   * When true, slows the demo timing so a single full cycle runs ~60 seconds.
   * Used inside the hero "Watch 60-second demo" modal so the experience matches
   * the CTA label until a real recorded video lands.
   */
  longForm?: boolean;
}

export function AnimatedDemo({ forcePhase, forceRevealedItems, longForm = false }: AnimatedDemoProps = {}) {
  const isFrozen = typeof forcePhase === "number" && Number.isFinite(forcePhase);
  const [phase, setPhase] = useState(isFrozen ? forcePhase! : 0);
  const [revealedItems, setRevealedItems] = useState(
    typeof forceRevealedItems === "number"
      ? forceRevealedItems
      : isFrozen
        ? forcePhase! >= 4
          ? DEMO_LINE_ITEMS.length
          : forcePhase! >= 3
            ? Math.min(DEMO_LINE_ITEMS.length, 3)
            : 0
        : 0,
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (isFrozen) return;
    const cycleMs = longForm ? 60000 : 11000;
    const itemRevealStart = longForm ? 14000 : 3000;
    const itemRevealStep = longForm ? 3500 : 550;

    const phase1At = longForm ? 3000 : 600;
    const phase2At = longForm ? 8000 : 1800;
    const phase4At = itemRevealStart + itemRevealStep * DEMO_LINE_ITEMS.length + (longForm ? 1000 : 200);
    const phase5At = itemRevealStart + itemRevealStep * DEMO_LINE_ITEMS.length + (longForm ? 3000 : 1500);

    const schedule = () => {
      setPhase(0);
      setRevealedItems(0);
      const timers: Array<ReturnType<typeof setTimeout>> = [
        setTimeout(() => setPhase(1), phase1At),
        setTimeout(() => setPhase(2), phase2At),
        setTimeout(() => setPhase(3), itemRevealStart),
        setTimeout(() => setPhase(4), phase4At),
        setTimeout(() => setPhase(5), phase5At),
      ];
      DEMO_LINE_ITEMS.forEach((_, idx) => {
        timers.push(
          setTimeout(() => setRevealedItems((n) => Math.max(n, idx + 1)), itemRevealStart + itemRevealStep * idx),
        );
      });
      return timers;
    };

    let timers = schedule();
    const loop = setInterval(() => {
      timers.forEach((t) => clearTimeout(t));
      setTick((t) => t + 1);
      timers = schedule();
    }, cycleMs);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      clearInterval(loop);
    };
  }, [isFrozen]);

  const visibleItemCount = revealedItems;

  return (
    <div key={tick} className="relative w-full h-full bg-brand-bg overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-brand-card via-brand-bg to-brand-card" />
      <div className="absolute inset-0 opacity-30" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, rgba(34,197,94,0.15), transparent 40%), radial-gradient(circle at 80% 80%, rgba(34,197,94,0.08), transparent 50%)" }} />

      <div className="relative w-full h-full flex items-stretch p-3 sm:p-5 gap-3 sm:gap-5">
        <div className="hidden sm:flex flex-col justify-between w-[38%] rounded-xl border border-brand-border bg-brand-bg/60 p-3 overflow-hidden">
          <div className="text-[10px] uppercase tracking-wider text-brand-textMuted font-semibold">Job photo</div>
          <div className="relative flex-1 my-2 rounded-lg overflow-hidden bg-gradient-to-br from-slate-700 to-slate-900">
            <div className="absolute inset-0 opacity-70" style={{ background: "linear-gradient(135deg, #475569 0%, #334155 50%, #1e293b 100%)" }} />
            <svg viewBox="0 0 200 140" className="absolute inset-0 w-full h-full" preserveAspectRatio="xMidYMid slice">
              <polygon points="20,90 100,30 180,90 180,130 20,130" fill="#475569" stroke="#64748b" strokeWidth="1" />
              <polygon points="20,90 100,30 180,90" fill="#334155" />
              <line x1="40" y1="100" x2="160" y2="100" stroke="#1e293b" strokeWidth="0.5" />
              <line x1="40" y1="115" x2="160" y2="115" stroke="#1e293b" strokeWidth="0.5" />
              <rect x="85" y="105" width="14" height="20" fill="#1e293b" />
            </svg>
            <div
              className="absolute left-0 right-0 h-[2px] bg-brand-green shadow-[0_0_12px_rgba(34,197,94,0.9)] transition-all duration-1000 ease-linear"
              style={{
                top: phase >= 1 && phase < 3 ? (phase === 2 ? "55%" : "100%") : "0%",
                opacity: phase >= 1 && phase < 3 ? 1 : 0,
              }}
            />
            {phase >= 2 && phase < 3 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="px-2 py-1 rounded-md bg-brand-bg/80 backdrop-blur text-[10px] font-semibold text-brand-green border border-brand-green/40">
                  AI scanning roof…
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-brand-textSubtle">
            <div className={`w-1.5 h-1.5 rounded-full transition-all ${phase >= 1 ? "bg-brand-green animate-pulse" : "bg-brand-border"}`} />
            <span>{phase === 0 ? "Photo received" : phase < 3 ? "Analyzing materials & pitch" : "Estimate complete"}</span>
          </div>
        </div>

        <div className="flex-1 rounded-xl border border-brand-border bg-brand-card flex flex-col overflow-hidden shadow-xl shadow-brand-green/5">
          <div className="h-1 bg-gradient-to-r from-brand-green via-purple-400 to-brand-green" />
          <div className="px-3 sm:px-4 py-2 sm:py-3 border-b border-brand-border flex items-center justify-between">
            <div>
              <div className="text-[9px] sm:text-[10px] uppercase tracking-widest text-brand-textMuted font-bold">ProBid AI Estimate</div>
              <div className="text-xs sm:text-sm font-bold text-brand-textPrimary">Roof Replacement — Galena, IL</div>
            </div>
            <div className={`w-6 h-6 sm:w-7 sm:h-7 rounded-md flex items-center justify-center transition-all duration-500 ${phase >= 4 ? "bg-brand-green/20 border border-brand-green/40 scale-100" : "bg-brand-border/50 scale-90"}`}>
              <svg className={`w-3 h-3 sm:w-4 sm:h-4 transition-colors ${phase >= 4 ? "text-brand-green" : "text-brand-textMuted"}`} fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>

          <div className="flex-1 px-3 sm:px-4 py-2 sm:py-3 space-y-1.5 sm:space-y-2">
            {DEMO_LINE_ITEMS.map((item, idx) => {
              const visible = idx < visibleItemCount;
              return (
                <div
                  key={idx}
                  className="flex items-center justify-between text-[11px] sm:text-xs transition-all duration-500"
                  style={{
                    opacity: visible ? 1 : 0,
                    transform: visible ? "translateX(0)" : "translateX(-8px)",
                  }}
                >
                  <span className="text-brand-textSecondary truncate pr-2">{item.label}</span>
                  <span className="text-brand-textPrimary font-semibold tabular-nums whitespace-nowrap">{item.price}</span>
                </div>
              );
            })}
          </div>

          <div className="border-t border-brand-border px-3 sm:px-4 py-2 sm:py-3 space-y-1.5">
            <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-brand-textMuted">
              <span>Materials subtotal</span>
              <span className="tabular-nums" style={{ opacity: phase >= 4 ? 1 : 0, transition: "opacity 400ms" }}>$6,400</span>
            </div>
            <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-brand-textMuted">
              <span>Labor subtotal</span>
              <span className="tabular-nums" style={{ opacity: phase >= 4 ? 1 : 0, transition: "opacity 400ms 100ms" }}>$2,400</span>
            </div>
            <div
              className={`flex items-center justify-between rounded-lg px-2 sm:px-3 py-2 sm:py-2.5 mt-1 transition-all duration-700 ${phase >= 4 ? "bg-brand-green/10 border border-brand-green/30 scale-100" : "bg-transparent border border-transparent scale-95 opacity-0"}`}
            >
              <span className="text-xs sm:text-sm font-bold text-brand-green">Total Estimate</span>
              <span className="text-base sm:text-xl font-black text-brand-green tabular-nums">$8,800</span>
            </div>
            <div
              className="text-center text-[9px] sm:text-[10px] text-brand-textSubtle pt-1 transition-opacity duration-500"
              style={{ opacity: phase >= 5 ? 1 : 0 }}
            >
              Generated in 22 seconds · Galena, IL regional pricing
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
