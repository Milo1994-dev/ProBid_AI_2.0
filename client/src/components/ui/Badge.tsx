import React from "react";

type BadgeVariant = "green" | "indigo" | "yellow" | "red" | "gray" | "blue";

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  green: "bg-green-900/40 text-green-300 border border-green-700/30",
  indigo: "bg-indigo-900/40 text-indigo-300 border border-indigo-700/30",
  yellow: "bg-yellow-900/40 text-yellow-300 border border-yellow-700/30",
  red: "bg-red-900/40 text-red-300 border border-red-700/30",
  gray: "bg-gray-800/60 text-gray-400 border border-gray-700/30",
  blue: "bg-blue-900/40 text-blue-300 border border-blue-700/30",
};

export function Badge({ variant = "gray", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
