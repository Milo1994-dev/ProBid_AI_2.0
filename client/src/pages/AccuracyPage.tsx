import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const MIN_DISPLAY_SAMPLE = 5;

interface OverallStats {
  p50ErrorPct: number;
  p80ErrorPct: number;
  sampleSize: number;
  withinBandPct: number;
  calculatedAt: number | null;
}

interface TradeRow {
  trade: string;
  p50ErrorPct: number;
  p80ErrorPct: number;
  sampleSize: number;
}

interface SizeRow {
  bucket: string;
  label: string;
  p50ErrorPct: number;
  p80ErrorPct: number;
  sampleSize: number;
}

interface BenchmarkData {
  overall: OverallStats | null;
  byTrade: TradeRow[];
  bySize: SizeRow[];
  lastUpdatedAt: number | null;
}

function fmt1(n: number): string {
  return n.toFixed(1);
}

export default function AccuracyPage() {
  const [data, setData] = useState<BenchmarkData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title =
      "Construction Estimating Accuracy | ProBid AI — Verified on Real Procore Projects";
    fetch("/api/public/benchmarks")
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setData(json.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const hasData =
    data?.overall !== null &&
    data?.overall !== undefined &&
    data.overall.sampleSize >= MIN_DISPLAY_SAMPLE;
  const n = data?.overall?.sampleSize ?? 0;
  const p50 = data?.overall?.p50ErrorPct ?? 0;
  const p80 = data?.overall?.p80ErrorPct ?? 0;
  const withinBand = data?.overall?.withinBandPct ?? 0;

  const lastUpdated = data?.lastUpdatedAt
    ? new Date(data.lastUpdatedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  const qualifyingTrades = (data?.byTrade ?? []).filter(
    (t) => t.sampleSize >= MIN_DISPLAY_SAMPLE
  );
  const qualifyingSizes = (data?.bySize ?? []).filter(
    (s) => s.sampleSize >= MIN_DISPLAY_SAMPLE
  );

  return (
    <div className="min-h-screen bg-brand-bg">
      <nav className="sticky top-0 z-40 bg-brand-bg/90 backdrop-blur border-b border-brand-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link to="/" className="text-brand-green font-black text-lg tracking-tight">
            ProBid AI
          </Link>
          <div className="flex items-center gap-4">
            <Link
              to="/#demo"
              className="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors"
            >
              Demo
            </Link>
            <Link
              to="/pricing"
              className="hidden sm:block text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors"
            >
              Pricing
            </Link>
            <Link
              to="/accuracy"
              className="hidden sm:block text-sm text-brand-textPrimary font-semibold"
            >
              Accuracy
            </Link>
            <Link
              to="/login"
              className="hidden sm:inline-flex px-3 py-1.5 text-sm text-brand-textMuted hover:text-brand-textPrimary"
            >
              Log In
            </Link>
            <Link
              to="/signup"
              className="hidden sm:inline-flex px-4 py-2 rounded-xl bg-brand-green text-brand-bg text-sm font-bold"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      <section className="max-w-4xl mx-auto px-4 sm:px-6 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-brand-indigo/10 border border-brand-indigo/30 text-brand-indigo text-sm font-medium mb-8">
          <svg
            className="w-4 h-4 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          Verified on real closed Procore projects
        </div>
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-black text-brand-textPrimary leading-tight mb-6">
          ProBid AI Accuracy
          <br />
          Measured at{" "}
          {loading ? (
            <span className="text-brand-textMuted">…</span>
          ) : hasData ? (
            <span className="text-brand-green">{fmt1(p50)}%</span>
          ) : (
            <span className="text-brand-textMuted">—</span>
          )}{" "}
          Median Error
        </h1>
        <p className="text-lg sm:text-xl text-brand-textMuted max-w-2xl mx-auto leading-relaxed">
          {loading
            ? "Loading benchmark data…"
            : hasData
            ? `ProBid AI estimates land within ${fmt1(p50)}% of actual closed project cost (median) across ${n.toLocaleString()} real Procore projects. Numbers are computed blind, compared against actual costs only after the project closes.`
            : "Accuracy benchmarks are computed from consenting Procore connections. Data will appear here once enough projects have been analyzed."}
        </p>
        {lastUpdated && (
          <p className="mt-6 text-xs text-brand-textSubtle">
            Last updated: {lastUpdated}
          </p>
        )}
      </section>

      {!loading && (
        <section className="border-y border-brand-border bg-brand-card/50 py-10">
          <div className="max-w-4xl mx-auto px-4 sm:px-6">
            {hasData ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
                <div>
                  <p className="text-4xl sm:text-5xl font-black text-brand-green">
                    {fmt1(p50)}%
                  </p>
                  <p className="text-sm font-semibold text-brand-textPrimary mt-2">
                    Median Error (P50)
                  </p>
                  <p className="text-xs text-brand-textSubtle mt-1">
                    Half of estimates land within this
                  </p>
                  <p className="text-xs text-brand-textSubtle mt-0.5">
                    n = {n.toLocaleString()} projects
                  </p>
                </div>
                <div>
                  <p className="text-4xl sm:text-5xl font-black text-brand-textPrimary">
                    {fmt1(p80)}%
                  </p>
                  <p className="text-sm font-semibold text-brand-textPrimary mt-2">
                    80th-Percentile Error
                  </p>
                  <p className="text-xs text-brand-textSubtle mt-1">
                    80% of estimates land within this
                  </p>
                  <p className="text-xs text-brand-textSubtle mt-0.5">
                    n = {n.toLocaleString()} projects
                  </p>
                </div>
                <div>
                  <p className="text-4xl sm:text-5xl font-black text-brand-textPrimary">
                    {fmt1(withinBand)}%
                  </p>
                  <p className="text-sm font-semibold text-brand-textPrimary mt-2">
                    Within Confidence Band
                  </p>
                  <p className="text-xs text-brand-textSubtle mt-1">
                    Actuals fell inside ProBid's low–high range
                  </p>
                  <p className="text-xs text-brand-textSubtle mt-0.5">
                    n = {n.toLocaleString()} projects
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-center text-brand-textSubtle">
                Aggregate statistics will appear here once enough consenting
                partners have contributed data.
              </p>
            )}
          </div>
        </section>
      )}

      {qualifyingTrades.length > 0 && (
        <section className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
          <h2 className="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-2">
            By Trade
          </h2>
          <p className="text-brand-textMuted text-sm mb-6">
            Trades with fewer than {MIN_DISPLAY_SAMPLE} projects are hidden to
            protect statistical integrity.
          </p>
          <div className="bg-brand-card border border-brand-border rounded-2xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-brand-border bg-brand-bg/50">
                  <th className="py-3 pl-5 pr-6 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">
                    Trade
                  </th>
                  <th className="py-3 pr-6 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">
                    Median Error (P50)
                  </th>
                  <th className="py-3 pr-6 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">
                    P80 Error
                  </th>
                  <th className="py-3 pr-5 text-left text-xs font-semibold text-brand-textSubtle uppercase tracking-wider">
                    Projects
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border/30">
                {qualifyingTrades.map((t) => (
                  <tr
                    key={t.trade}
                    className="border-b border-brand-border/40 last:border-0"
                  >
                    <td className="py-3 pl-5 pr-6 text-sm font-medium text-brand-textPrimary">
                      {t.trade}
                    </td>
                    <td className="py-3 pr-6 text-sm text-brand-textPrimary font-semibold">
                      {fmt1(t.p50ErrorPct)}%
                    </td>
                    <td className="py-3 pr-6 text-sm text-brand-textMuted">
                      {fmt1(t.p80ErrorPct)}%
                    </td>
                    <td className="py-3 pr-5 text-xs text-brand-textSubtle">
                      {t.sampleSize.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <h2 className="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-2">
          By Project Size
        </h2>
        <p className="text-brand-textMuted text-sm mb-2">
          Accuracy varies by project scale. Buckets with fewer than{" "}
          {MIN_DISPLAY_SAMPLE} projects are hidden.
        </p>
        {qualifyingSizes.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mt-6">
            {qualifyingSizes.map((s) => (
              <div
                key={s.bucket}
                className="bg-brand-card border border-brand-border rounded-2xl p-6"
              >
                <p className="text-sm font-semibold text-brand-textSubtle mb-1">
                  {s.label}
                </p>
                <div className="flex items-end gap-1 mb-1">
                  <span className="text-3xl font-black text-brand-textPrimary">
                    {fmt1(s.p50ErrorPct)}%
                  </span>
                  <span className="text-xs text-brand-textSubtle mb-1.5 ml-1">
                    median error
                  </span>
                </div>
                <p className="text-xs text-brand-textMuted">
                  80th percentile: {fmt1(s.p80ErrorPct)}%
                </p>
                <p className="text-xs text-brand-textSubtle mt-1">
                  {s.sampleSize.toLocaleString()} projects
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-6 p-6 bg-brand-card border border-brand-border rounded-2xl text-center">
            <p className="text-sm text-brand-textSubtle italic">
              Not enough data in each size bucket yet.
            </p>
          </div>
        )}
      </section>

      <section
        id="methodology"
        className="max-w-4xl mx-auto px-4 sm:px-6 py-16 border-t border-brand-border"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-12">
          <div className="sm:col-span-2">
            <h2 className="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-6">
              How This Is Measured
            </h2>
            <div className="space-y-5 text-sm text-brand-textMuted leading-relaxed">
              {[
                {
                  title: "1. Source: Real Closed Projects",
                  body: "Numbers come from contractors who have connected their Procore accounts and opted in to anonymous benchmarking. Only closed projects with actual cost data are included — no in-progress projects, no estimates without actuals.",
                },
                {
                  title: "2. Blind Shadow Estimate",
                  body: "Before comparing against actual costs, ProBid AI generates a shadow estimate using only the project metadata available at bid time: trade type, location, scope, and project size. The actual cost is hidden during this step.",
                },
                {
                  title: "3. Error Calculation",
                  body: "Error % = |ProBid Estimate − Actual Cost| ÷ Actual Cost × 100. This is an absolute (non-directional) percentage — it measures how far off the estimate was in either direction.",
                },
                {
                  title: "4. Percentiles, Not Averages",
                  body: "We report P50 (median) and P80 error. Medians are more robust than means for skewed data. A lower number means tighter, more accurate estimates.",
                },
                {
                  title: "5. Minimum Sample Size",
                  body: `Any breakdown category with fewer than ${MIN_DISPLAY_SAMPLE} projects is hidden rather than shown. Small samples produce unreliable statistics. We show nothing rather than mislead.`,
                },
                {
                  title: "6. Privacy",
                  body: "No project names, company names, or individual line items are ever shown publicly. Only aggregate statistics are included. Participation is opt-in; contractors can change their preference any time in their Procore settings.",
                },
              ].map((item) => (
                <div key={item.title}>
                  <h3 className="text-base font-bold text-brand-textPrimary mb-1">
                    {item.title}
                  </h3>
                  <p>{item.body}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="bg-brand-card border border-brand-border rounded-2xl p-5">
              <h3 className="text-sm font-bold text-brand-textPrimary mb-2">
                Data Source
              </h3>
              <p className="text-xs text-brand-textMuted leading-relaxed">
                Procore-connected accounts (read-only OAuth). Actual costs pulled
                from Procore budget views after project close.
              </p>
            </div>
            <div className="bg-brand-card border border-brand-border rounded-2xl p-5">
              <h3 className="text-sm font-bold text-brand-textPrimary mb-2">
                Update Frequency
              </h3>
              <p className="text-xs text-brand-textMuted leading-relaxed">
                Benchmarks are recomputed daily from all consenting connections.
                The last update timestamp is shown above.
              </p>
            </div>
            <div className="bg-brand-card border border-brand-border rounded-2xl p-5">
              <h3 className="text-sm font-bold text-brand-textPrimary mb-2">
                Contribute Your Data
              </h3>
              <p className="text-xs text-brand-textMuted leading-relaxed">
                Business plan subscribers can opt in to anonymous benchmarking in
                their Procore settings. Your data improves the benchmarks for
                everyone.
              </p>
              <Link
                to="/signup"
                className="mt-3 inline-block text-xs font-semibold text-brand-green hover:underline"
              >
                Connect Procore →
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
        <div className="bg-gradient-to-br from-brand-indigo/20 to-brand-green/10 border border-brand-indigo/30 rounded-3xl p-10 sm:p-12 text-center">
          <h2 className="text-2xl sm:text-3xl font-black text-brand-textPrimary mb-3">
            Verify the Numbers Yourself
          </h2>
          <p className="text-brand-textMuted mb-6 max-w-lg mx-auto text-sm leading-relaxed">
            Connect your Procore account and we'll run ProBid's estimates against
            your own closed projects. You get a private accuracy report — and can
            choose whether to contribute anonymized stats to this page.
          </p>
          <Link
            to="/signup"
            className="inline-block px-8 py-3 rounded-xl bg-brand-green text-brand-bg font-bold text-sm"
          >
            Run Your Own Accuracy Test
          </Link>
        </div>
      </section>

      <footer className="border-t border-brand-border py-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 text-center">
          <p className="text-brand-textSubtle text-sm">
            ProBid AI Accuracy Benchmarks —{" "}
            <a
              href="https://probidcore.net"
              className="text-brand-green hover:underline"
            >
              probidcore.net
            </a>
          </p>
          <div className="flex items-center justify-center gap-6 mt-4 text-xs text-brand-textSubtle">
            <Link to="/" className="hover:text-brand-textMuted">
              Home
            </Link>
            <Link to="/pricing" className="hover:text-brand-textMuted">
              Pricing
            </Link>
            <a href="/accuracy#methodology" className="hover:text-brand-textMuted">
              Methodology
            </a>
            <a href="/sitemap.xml" className="hover:text-brand-textMuted">
              Sitemap
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
