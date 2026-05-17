import React from "react";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { track } from "../../analytics";

interface PricingCardProps {
  name: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  cta: string;
  onCta: () => void;
  popular?: boolean;
  loading?: boolean;
  disabled?: boolean;
  trialDays?: number;
}

export function PricingCard({
  name,
  price,
  period = "/month",
  description,
  features,
  cta,
  onCta,
  popular = false,
  loading = false,
  disabled = false,
  trialDays,
}: PricingCardProps) {
  const handleCta = () => {
    track("upgrade_clicked", { plan: name });
    onCta();
  };

  return (
    <div
      className={`
        relative flex flex-col p-6 sm:p-8 rounded-2xl border transition-all duration-300 hover:-translate-y-1
        ${
          popular
            ? "border-brand-green bg-gradient-to-b from-brand-green/10 to-brand-card shadow-lg shadow-brand-green/10 scale-[1.02]"
            : "border-brand-border bg-brand-card hover:border-brand-green/20"
        }
      `}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <Badge variant="green">Most Popular</Badge>
        </div>
      )}

      <div className="mb-6">
        <h3 className="text-lg font-bold text-brand-textPrimary mb-1">{name}</h3>
        <p className="text-brand-textSubtle text-sm mb-4">{description}</p>
        <div className="flex items-end gap-1">
          <span className="text-4xl font-black text-brand-textPrimary">{price}</span>
          {period && <span className="text-brand-textSubtle text-sm mb-1">{period}</span>}
        </div>
        {trialDays && (
          <div className="mt-2 inline-flex items-center gap-1.5 bg-brand-green/10 border border-brand-green/30 text-brand-green text-xs font-semibold px-2.5 py-1 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-green" />
            <span>{trialDays}-day free trial — no card required</span>
          </div>
        )}
      </div>

      <ul className="flex-1 space-y-3 mb-8">
        {features.map((f, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm text-brand-textMuted">
            <svg className="w-4 h-4 text-brand-green mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            {f}
          </li>
        ))}
      </ul>

      <Button
        variant={popular ? "primary" : "secondary"}
        fullWidth
        loading={loading}
        disabled={disabled}
        onClick={handleCta}
        className={popular ? "shadow-lg shadow-brand-green/20" : ""}
      >
        {cta}
      </Button>
    </div>
  );
}
