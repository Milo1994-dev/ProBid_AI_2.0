import React from "react";

interface GuaranteeBlockProps {
  variant?: "full" | "compact" | "trust-bar";
}

const guarantees = [
  {
    icon: "⚡",
    title: "60-Second Speed Guarantee",
    description: "Your estimate is ready in 60 seconds or we credit your next month. For active paid subscribers.",
    detail: "Every estimate is timed server-side. If any estimate takes longer than 60 seconds, active paid subscribers can file a claim within 30 days — evaluated automatically, usually instant. One claim per account, lifetime.",
  },
  {
    icon: "🏆",
    title: "Win-Jobs Guarantee",
    description: "Active paid subscribers: generate 5+ estimates over 30+ days with no wins yet — get a month free.",
    detail: "Requires an active paid subscription, account age ≥ 30 days, and at least 5 estimates with no estimates marked Won. Mark estimates Won when you land a job — that is how eligibility is verified. One claim per account, lifetime.",
  },
  {
    icon: "↩️",
    title: "30-Day Money-Back",
    description: "Not satisfied within 30 days of your first payment? We'll refund your charge or apply a full credit — one click to claim.",
    detail: "Submit on your Guarantees page. Eligible accounts receive a Stripe charge refund (5–10 days) or, where a direct refund is not available, a full account credit applied automatically to your next invoice. Applies to your first paid subscription period only.",
  },
];

export function GuaranteeBlock({ variant = "full" }: GuaranteeBlockProps) {
  if (variant === "trust-bar") {
    return (
      <div className="flex flex-wrap justify-center gap-4 py-3 px-4 bg-green-950/40 border border-green-700/30 rounded-xl text-sm">
        {guarantees.map((g) => (
          <div key={g.title} className="flex items-center gap-2 text-green-300">
            <span className="text-base">{g.icon}</span>
            <span className="font-medium">{g.title}</span>
          </div>
        ))}
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className="border border-green-700/40 rounded-xl bg-green-950/30 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-green-400 mb-3">
          Protected by Our Triple Guarantee
        </p>
        <div className="space-y-2">
          {guarantees.map((g) => (
            <div key={g.title} className="flex items-start gap-2">
              <span className="text-sm mt-0.5">{g.icon}</span>
              <div>
                <p className="text-sm font-semibold text-white">{g.title}</p>
                <p className="text-xs text-slate-400">{g.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Full variant
  return (
    <section className="py-16 px-4" id="guarantees">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-10">
          <span className="inline-block bg-green-900/50 border border-green-700/40 text-green-400 text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full mb-4">
            Zero Risk
          </span>
          <h2 className="text-3xl font-bold text-white mb-3">
            Our Triple Guarantee — You Can't Lose
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto">
            Contractors are skeptical of new tools. We get it. So we put our money where our
            mouth is with three ironclad promises.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {guarantees.map((g) => (
            <div
              key={g.title}
              className="bg-slate-800/50 border border-slate-700/60 rounded-2xl p-6 flex flex-col gap-3 hover:border-green-700/50 transition-colors"
            >
              <div className="text-4xl">{g.icon}</div>
              <h3 className="text-lg font-bold text-white">{g.title}</h3>
              <p className="text-slate-300 text-sm leading-relaxed">{g.description}</p>
              <p className="text-slate-500 text-xs leading-relaxed border-t border-slate-700/50 pt-3">
                {g.detail}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <p className="text-slate-500 text-xs">
            Each guarantee is claimable once per account, lifetime. Claims are evaluated
            automatically — no support tickets, no waiting.{" "}
            <a href="/app/guarantees" className="text-green-400 underline hover:text-green-300">
              View your claim status →
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
