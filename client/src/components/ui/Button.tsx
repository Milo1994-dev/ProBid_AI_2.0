import React from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-brand-green text-gray-900 hover:bg-brand-greenDark focus-visible:ring-brand-green font-semibold",
  secondary:
    "bg-brand-indigo text-white hover:bg-brand-indigoDark focus-visible:ring-brand-indigo font-semibold",
  ghost:
    "bg-transparent text-brand-textMuted hover:bg-brand-cardHover hover:text-brand-textPrimary border border-brand-border focus-visible:ring-brand-indigo",
  destructive:
    "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 font-semibold",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1.5 text-sm rounded-lg min-h-[36px]",
  md: "px-5 py-2.5 text-sm rounded-xl min-h-[44px]",
  lg: "px-8 py-3.5 text-base rounded-xl min-h-[52px]",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  className = "",
  disabled,
  children,
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg disabled:opacity-50 disabled:cursor-not-allowed select-none";

  return (
    <button
      className={`${base} ${variantClasses[variant]} ${sizeClasses[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />
      )}
      {children}
    </button>
  );
}
