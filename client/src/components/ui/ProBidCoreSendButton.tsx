import React, { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "./Button";
import { Card } from "./Card";
import { api } from "../../api/client";
import { track } from "../../analytics";

declare global {
  interface Window {
    ProBidCore?: {
      sendEstimate: (data: {
        name: string;
        source: string;
        lineItems: Array<{ description: string; quantity: number; unitCost: number; uom: string }>;
      }) => void;
    };
  }
}

type SendStatus = "idle" | "loading" | "preview" | "sent";

const SENT_STORAGE_KEY = "probidcore_sent_estimates";

function getSentEstimates(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SENT_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function markEstimateSent(estimateId: string) {
  const sent = getSentEstimates();
  sent[estimateId] = Date.now();
  localStorage.setItem(SENT_STORAGE_KEY, JSON.stringify(sent));
}

function wasEstimateSent(estimateId: string): boolean {
  return !!getSentEstimates()[estimateId];
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function useProBidCoreScript() {
  const [loaded, setLoaded] = useState(!!window.ProBidCore);

  useEffect(() => {
    if (window.ProBidCore) {
      setLoaded(true);
      return;
    }

    const existing = document.querySelector('script[src="https://probidcore.com/integrate.js"]');
    if (existing) {
      existing.addEventListener("load", () => setLoaded(true));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://probidcore.com/integrate.js";
    script.async = true;
    script.onload = () => setLoaded(true);
    script.onerror = () => setLoaded(false);
    document.body.appendChild(script);

    return () => {
      // Keep script loaded
    };
  }, []);

  return loaded;
}

interface Props {
  estimateId: string;
  estimateName: string;
}

export function ProBidCoreSendButton({ estimateId, estimateName }: Props) {
  const [status, setStatus] = useState<SendStatus>(() =>
    wasEstimateSent(estimateId) ? "sent" : "idle"
  );
  const [isSending, setIsSending] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const scriptLoaded = useProBidCoreScript();

  const lineItemsQuery = useQuery({
    queryKey: ["estimate-line-items", estimateId],
    queryFn: () => api.getEstimateLineItems(estimateId).then((r) => r.data),
    enabled: status === "loading" || status === "preview",
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
  });

  useEffect(() => {
    if (status === "loading" && lineItemsQuery.data) {
      if (lineItemsQuery.data.lineItems.length === 0) {
        setStatus("idle");
        showToast("error", "No line items could be extracted from this estimate.");
        track("probidcore_send_estimate_empty", { estimateId });
      } else {
        setStatus("preview");
      }
    }
    if (status === "loading" && lineItemsQuery.isError) {
      setStatus("idle");
      showToast("error", "Failed to extract line items. Please try again.");
      track("probidcore_line_items_error", { estimateId });
    }
  }, [status, lineItemsQuery.data, lineItemsQuery.isError, estimateId]);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleInitiateSend = () => {
    if (!scriptLoaded) {
      showToast("error", "ProBid Core is loading. Please try again in a moment.");
      return;
    }
    setStatus("loading");
    track("probidcore_send_initiated", { estimateId });
  };

  const handleConfirmSend = () => {
    if (!window.ProBidCore) {
      showToast("error", "ProBid Core SDK is not available. Please reload the page and try again.");
      setStatus("idle");
      return;
    }
    if (!lineItemsQuery.data || lineItemsQuery.data.lineItems.length === 0) {
      showToast("error", "No line items available to send.");
      setStatus("idle");
      return;
    }

    setIsSending(true);
    try {
      window.ProBidCore.sendEstimate({
        name: estimateName,
        source: "ProBid AI",
        lineItems: lineItemsQuery.data.lineItems,
      });
      markEstimateSent(estimateId);
      setIsSending(false);
      setStatus("sent");
      showToast("success", "Estimate sent to ProBid Core successfully!");
      track("probidcore_send_estimate", {
        estimateId,
        lineItemCount: lineItemsQuery.data.lineItems.length,
        totalValue: lineItemsQuery.data.lineItems.reduce((sum, li) => sum + li.quantity * li.unitCost, 0),
      });
    } catch (err) {
      setIsSending(false);
      setStatus("idle");
      showToast("error", "Failed to send estimate. Please try again.");
      track("probidcore_send_estimate_error", { estimateId, error: String(err) });
    }
  };

  if (status === "sent") {
    const lineItems = lineItemsQuery.data?.lineItems || [];
    const totalValue = lineItems.reduce((sum, li) => sum + li.quantity * li.unitCost, 0);
    return (
      <Card className="mt-4 border-brand-green/30 bg-brand-green/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand-green/10 border border-brand-green/20 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-brand-textPrimary">Sent to ProBid Core</p>
            <p className="text-xs text-brand-textMuted truncate">
              {lineItems.length} line item{lineItems.length !== 1 ? "s" : ""}
              {totalValue > 0 ? ` — ${formatCurrency(totalValue)}` : ""}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      {toast && (
        <div className={`fixed top-4 right-4 z-[60] max-w-sm px-4 py-3 rounded-xl shadow-lg border backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-300 ${
          toast.type === "success"
            ? "bg-brand-green/10 border-brand-green/30 text-brand-green"
            : "bg-red-500/10 border-red-500/30 text-red-400"
        }`}>
          <div className="flex items-center gap-2">
            {toast.type === "success" ? (
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            )}
            <p className="text-sm font-medium">{toast.message}</p>
          </div>
        </div>
      )}

      <Button
        variant="ghost"
        fullWidth
        onClick={handleInitiateSend}
        disabled={status === "loading"}
        className="border-brand-indigo/30 hover:border-brand-indigo/50 text-brand-indigo"
      >
        {status === "loading" ? (
          <span className="flex items-center gap-2">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Extracting line items...
          </span>
        ) : (
          <>
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Send to ProBid Core
          </>
        )}
      </Button>

      {status === "preview" && lineItemsQuery.data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-brand-card border border-brand-border rounded-2xl max-w-lg w-full shadow-xl max-h-[85vh] flex flex-col">
            <div className="px-6 py-5 border-b border-brand-border flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-lg font-bold text-brand-textPrimary">Send to ProBid Core</h2>
                <p className="text-xs text-brand-textMuted mt-0.5">Review line items before sending</p>
              </div>
              <button
                onClick={() => setStatus("idle")}
                className="text-brand-textSubtle hover:text-brand-textMuted p-1"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-4 overflow-y-auto flex-1 scrollbar-thin">
              <div className="bg-brand-bg rounded-xl border border-brand-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-brand-border bg-brand-bg/80">
                      <th className="text-left px-3 py-2 text-xs font-semibold text-brand-textSubtle uppercase tracking-wide">Item</th>
                      <th className="text-right px-3 py-2 text-xs font-semibold text-brand-textSubtle uppercase tracking-wide w-14">Qty</th>
                      <th className="text-right px-3 py-2 text-xs font-semibold text-brand-textSubtle uppercase tracking-wide w-16">UOM</th>
                      <th className="text-right px-3 py-2 text-xs font-semibold text-brand-textSubtle uppercase tracking-wide w-24">Unit Cost</th>
                      <th className="text-right px-3 py-2 text-xs font-semibold text-brand-textSubtle uppercase tracking-wide w-24">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItemsQuery.data.lineItems.map((item, i) => (
                      <tr key={i} className="border-b border-brand-border/50 last:border-0">
                        <td className="px-3 py-2 text-brand-textMuted">{item.description}</td>
                        <td className="px-3 py-2 text-right text-brand-textMuted">{item.quantity}</td>
                        <td className="px-3 py-2 text-right text-brand-textSubtle text-xs">{item.uom}</td>
                        <td className="px-3 py-2 text-right text-brand-textMuted">{formatCurrency(item.unitCost)}</td>
                        <td className="px-3 py-2 text-right font-medium text-brand-textPrimary">{formatCurrency(item.quantity * item.unitCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex items-center justify-between px-1">
                <span className="text-xs text-brand-textSubtle">
                  {lineItemsQuery.data.lineItems.length} line item{lineItemsQuery.data.lineItems.length !== 1 ? "s" : ""}
                </span>
                <span className="text-sm font-bold text-brand-green">
                  {formatCurrency(lineItemsQuery.data.lineItems.reduce((sum, li) => sum + li.quantity * li.unitCost, 0))}
                </span>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-brand-border flex gap-3 shrink-0">
              <Button variant="ghost" onClick={() => setStatus("idle")} className="flex-1">
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleConfirmSend}
                disabled={isSending}
                className="flex-1"
              >
                {isSending ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Sending...
                  </span>
                ) : (
                  "Confirm & Send"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
