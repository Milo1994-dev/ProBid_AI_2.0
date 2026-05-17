import React from "react";

type AlertType = "info" | "warning" | "error" | "success";

interface AlertProps {
  type?: AlertType;
  title?: string;
  children: React.ReactNode;
  className?: string;
  onDismiss?: () => void;
}

const alertConfig: Record<AlertType, { border: string; bg: string; icon: string; titleColor: string; textColor: string }> = {
  info: {
    border: "border-brand-indigo/40",
    bg: "bg-brand-indigo/10",
    icon: "ℹ",
    titleColor: "text-indigo-300",
    textColor: "text-indigo-200",
  },
  warning: {
    border: "border-yellow-500/40",
    bg: "bg-yellow-500/10",
    icon: "⚠",
    titleColor: "text-yellow-300",
    textColor: "text-yellow-200",
  },
  error: {
    border: "border-red-500/40",
    bg: "bg-red-500/10",
    icon: "✕",
    titleColor: "text-red-300",
    textColor: "text-red-200",
  },
  success: {
    border: "border-brand-green/40",
    bg: "bg-brand-green/10",
    icon: "✓",
    titleColor: "text-green-300",
    textColor: "text-green-200",
  },
};

export function Alert({ type = "info", title, children, className = "", onDismiss }: AlertProps) {
  const cfg = alertConfig[type];
  return (
    <div
      className={`flex gap-3 p-4 rounded-xl border ${cfg.border} ${cfg.bg} ${className}`}
      role="alert"
    >
      <span className={`text-sm font-bold shrink-0 mt-0.5 ${cfg.titleColor}`}>{cfg.icon}</span>
      <div className="flex-1 min-w-0">
        {title && <p className={`text-sm font-semibold mb-1 ${cfg.titleColor}`}>{title}</p>}
        <div className={`text-sm ${cfg.textColor}`}>{children}</div>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className={`shrink-0 text-sm ${cfg.titleColor} hover:opacity-70`}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
