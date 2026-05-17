import React from "react";
import { Card } from "./Card";

interface StatTileProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  highlight?: boolean;
}

export function StatTile({ label, value, sub, icon, highlight = false }: StatTileProps) {
  return (
    <Card className={highlight ? "border-brand-green/40" : ""}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-brand-textSubtle mb-1 truncate">{label}</p>
          <p
            className={`text-2xl sm:text-3xl font-bold truncate ${
              highlight ? "text-brand-green" : "text-brand-textPrimary"
            }`}
          >
            {value}
          </p>
          {sub && <p className="text-xs text-brand-textSubtle mt-1 truncate">{sub}</p>}
        </div>
        {icon && (
          <div className="shrink-0 w-10 h-10 rounded-xl bg-brand-indigo/20 flex items-center justify-center text-brand-indigo text-lg">
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Skeleton placeholder while data loads */
export function StatTileSkeleton() {
  return (
    <Card>
      <div className="animate-pulse">
        <div className="h-4 w-24 bg-brand-border rounded mb-3" />
        <div className="h-8 w-16 bg-brand-border rounded mb-2" />
        <div className="h-3 w-20 bg-brand-border rounded" />
      </div>
    </Card>
  );
}
