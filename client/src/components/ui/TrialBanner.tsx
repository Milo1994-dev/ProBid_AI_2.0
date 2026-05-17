import React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";

function formatTrialEnd(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

export function TrialBanner() {
  const { user } = useAuth();

  const billingQuery = useQuery({
    queryKey: ["billing"],
    queryFn: () => api.getBillingStatus().then((r) => r.data),
    enabled: !!user,
    staleTime: 60_000,
  });

  const billing = billingQuery.data;
  if (!billing || billing.status !== "trialing" || !billing.currentPeriodEnd) {
    return null;
  }

  const trialEndMs = billing.currentPeriodEnd * 1000;
  const msRemaining = trialEndMs - Date.now();
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / 86_400_000));
  const isUrgent = daysRemaining <= 2;

  const colorClasses = isUrgent
    ? "bg-amber-500/10 border-amber-500/30 text-amber-200"
    : "bg-brand-green/10 border-brand-green/30 text-brand-green";
  const dotColor = isUrgent ? "bg-amber-400" : "bg-brand-green";

  const dayLabel = daysRemaining === 1 ? "1 day left" : `${daysRemaining} days left`;
  const subjectMessage = isUrgent
    ? `Your card will be charged on ${formatTrialEnd(billing.currentPeriodEnd)}.`
    : `No charge until ${formatTrialEnd(billing.currentPeriodEnd)}.`;

  return (
    <div className={`border-b ${colorClasses}`}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs sm:text-sm">
        <span className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${dotColor} animate-pulse`} />
          <strong className="font-semibold">Free trial — {dayLabel}.</strong>
          <span className="opacity-90">{subjectMessage}</span>
        </span>
        <Link
          to="/app/billing"
          className="font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity"
        >
          Manage subscription
        </Link>
      </div>
    </div>
  );
}
