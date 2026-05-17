import React from "react";

interface EstimateBreakdownCardProps {
  materials?: number;
  labor?: number;
  total?: number;
  breakdown?: string;
  rawText?: string;
  jobType?: string;
  market?: string;
  isPaid?: boolean;
}

function formatCurrency(n: number | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function parseFromText(text: string): { materials?: number; labor?: number; total?: number; breakdown?: string } {
  const matMatch = text.match(/material[s]?\s*[:\-–]?\s*\$?([\d,]+)/i);
  const laborMatch = text.match(/labor\s*[:\-–]?\s*\$?([\d,]+)/i);
  const totalMatch = text.match(/total\s*[:\-–]?\s*\$?([\d,]+)/i);

  const parse = (s: string | undefined) => {
    if (!s) return undefined;
    return parseInt(s.replace(/,/g, ""), 10);
  };

  return {
    materials: parse(matMatch?.[1]),
    labor: parse(laborMatch?.[1]),
    total: parse(totalMatch?.[1]),
    breakdown: text,
  };
}

export function EstimateBreakdownCard({
  materials,
  labor,
  total,
  breakdown,
  rawText,
  jobType,
  market,
  isPaid = true,
}: EstimateBreakdownCardProps) {
  const parsed = rawText ? parseFromText(rawText) : {};
  const mat = materials ?? parsed.materials;
  const lab = labor ?? parsed.labor;
  const tot = total ?? parsed.total ?? (mat != null && lab != null ? mat + lab : undefined);
  const desc = breakdown ?? parsed.breakdown ?? rawText;

  return (
    <div className="bg-brand-card border border-brand-border rounded-2xl overflow-hidden">
      <div className="px-6 py-5 border-b border-brand-border bg-gradient-to-r from-brand-green/5 to-transparent">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xl font-black text-brand-textPrimary">Professional Estimate</h2>
            </div>
            {jobType && (
              <p className="text-sm text-brand-textMuted capitalize">
                {jobType}
                {market ? ` · ${market}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-brand-green/10 border border-brand-green/30 text-brand-green text-xs font-semibold">
              AI Generated
            </span>
          </div>
        </div>
      </div>

      <div className="p-6">
        {(mat != null || lab != null || tot != null) && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-brand-bg rounded-xl p-4 text-center">
              <p className="text-xs text-brand-textSubtle mb-1 uppercase tracking-wide font-medium">Materials</p>
              <p className="text-lg sm:text-2xl font-black text-brand-textPrimary">{formatCurrency(mat)}</p>
            </div>
            <div className="bg-brand-bg rounded-xl p-4 text-center">
              <p className="text-xs text-brand-textSubtle mb-1 uppercase tracking-wide font-medium">Labor</p>
              <p className="text-lg sm:text-2xl font-black text-brand-textPrimary">{formatCurrency(lab)}</p>
            </div>
            <div className="bg-brand-green/10 border border-brand-green/30 rounded-xl p-4 text-center">
              <p className="text-xs text-brand-textSubtle mb-1 uppercase tracking-wide font-medium">Total</p>
              <p className="text-lg sm:text-2xl font-black text-brand-green">{formatCurrency(tot)}</p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-5">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-indigo/10 border border-brand-indigo/20 text-brand-indigo text-xs font-medium">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            Ready to Share
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-green/10 border border-brand-green/20 text-brand-green text-xs font-medium">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            Contractor-Friendly
          </span>
        </div>

        {desc && (
          <div className="mt-2">
            <h3 className="text-sm font-bold text-brand-textPrimary mb-3">Detailed Breakdown</h3>
            <div className={`bg-brand-bg rounded-xl p-4 text-sm text-brand-textMuted whitespace-pre-wrap leading-relaxed ${isPaid ? "max-h-96" : "max-h-40"} overflow-y-auto scrollbar-thin relative`}>
              {desc}
              {!isPaid && (
                <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-brand-bg to-transparent pointer-events-none" />
              )}
            </div>
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-brand-border/50">
          <p className="text-xs text-brand-textSubtle text-center italic">
            This estimate would normally take hours to create manually.
          </p>
        </div>
      </div>
    </div>
  );
}
