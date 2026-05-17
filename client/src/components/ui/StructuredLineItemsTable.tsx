import React from "react";
import type { EstimateLineItem, EstimateTotals } from "../../api/client";

interface StructuredLineItemsTableProps {
  lineItems: EstimateLineItem[];
  totals?: EstimateTotals;
  jobType?: string;
  market?: string;
}

function formatCurrency(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function formatQuantity(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function StructuredLineItemsTable({
  lineItems,
  totals,
  jobType,
  market,
}: StructuredLineItemsTableProps) {
  const computedSubtotal =
    totals?.total ?? lineItems.reduce((s, li) => s + li.lineTotal, 0);

  return (
    <div className="bg-brand-card border border-brand-border rounded-2xl overflow-hidden">
      <div className="px-6 py-5 border-b border-brand-border bg-gradient-to-r from-brand-green/5 to-transparent">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-xl font-black text-brand-textPrimary">Estimate Breakdown</h2>
            {jobType && (
              <p className="text-sm text-brand-textMuted capitalize">
                {jobType}
                {market ? ` · ${market}` : ""}
              </p>
            )}
          </div>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-brand-indigo/10 border border-brand-indigo/30 text-brand-indigo text-xs font-semibold">
            Structured
          </span>
        </div>
      </div>

      <div className="p-4 sm:p-6">
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-brand-textSubtle border-b border-brand-border">
                <th className="py-2 px-3 font-medium">Description</th>
                <th className="py-2 px-3 font-medium text-right">Qty</th>
                <th className="py-2 px-3 font-medium">UoM</th>
                <th className="py-2 px-3 font-medium text-right">Unit Cost</th>
                <th className="py-2 px-3 font-medium">Cost Type</th>
                <th className="py-2 px-3 font-medium text-right">Line Total</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li, idx) => (
                <tr
                  key={li.id ?? idx}
                  className="border-b border-brand-border/40 last:border-b-0"
                >
                  <td className="py-2.5 px-3 text-brand-textPrimary">{li.description}</td>
                  <td className="py-2.5 px-3 text-right text-brand-textMuted tabular-nums">
                    {formatQuantity(li.quantity)}
                  </td>
                  <td className="py-2.5 px-3 text-brand-textMuted">{li.uom || "—"}</td>
                  <td className="py-2.5 px-3 text-right text-brand-textMuted tabular-nums">
                    {formatCurrency(li.unitCost)}
                  </td>
                  <td className="py-2.5 px-3 text-brand-textMuted">{li.costType || "—"}</td>
                  <td className="py-2.5 px-3 text-right text-brand-textPrimary font-semibold tabular-nums">
                    {formatCurrency(li.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totals && Object.keys(totals.byCostType).length > 0 && (
          <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Object.entries(totals.byCostType).map(([type, amount]) => (
              <div key={type} className="bg-brand-bg rounded-xl p-3 text-center">
                <p className="text-xs text-brand-textSubtle mb-1 uppercase tracking-wide font-medium">
                  {type}
                </p>
                <p className="text-base font-black text-brand-textPrimary tabular-nums">
                  {formatCurrency(amount)}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-brand-border flex items-center justify-between">
          <span className="text-sm font-semibold text-brand-textMuted uppercase tracking-wide">
            Total
          </span>
          <span className="text-2xl font-black text-brand-green tabular-nums">
            {formatCurrency(computedSubtotal)}
          </span>
        </div>
      </div>
    </div>
  );
}
