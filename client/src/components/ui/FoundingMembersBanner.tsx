import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../contexts/AuthContext";
import { api } from "../../api/client";
import { track } from "../../analytics";

const BANNER_SESSION_KEY = "foundingBannerDismissed";

export function FoundingMembersBanner() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem(BANNER_SESSION_KEY) === "1"
      : false
  );

  const usageQuery = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.getUsage().then((r) => r.data),
    enabled: !!user,
    retry: false,
    staleTime: 60_000,
  });

  const isUnlimited = usageQuery.data?.isUnlimited ?? false;

  if (dismissed || isUnlimited) return null;

  const handleDismiss = () => {
    sessionStorage.setItem(BANNER_SESSION_KEY, "1");
    setDismissed(true);
    track("founding_banner_dismissed", {});
  };

  const handleCta = () => {
    track("founding_banner_cta_click", { loggedIn: !!user });
    handleDismiss();
    if (user) {
      navigate("/app/billing");
    } else {
      navigate("/signup");
    }
  };

  return (
    <div className="relative z-40 bg-gradient-to-r from-brand-indigo/90 via-brand-indigo to-violet-600 text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-center sm:text-left">
        <p className="text-xs sm:text-sm font-semibold leading-snug flex items-center gap-2 flex-wrap justify-center sm:justify-start">
          <span className="text-yellow-300 shrink-0">⚡</span>
          <span>
            <strong>Founding Members: Lifetime access for $199</strong>{" "}
            <span className="opacity-90">(normally $300/yr) — only a few spots left.</span>
          </span>
        </p>
        <button
          onClick={handleCta}
          className="shrink-0 px-4 py-1.5 rounded-full bg-white text-brand-indigo text-xs font-bold hover:bg-white/90 transition-colors whitespace-nowrap"
        >
          Lock In Lifetime Access →
        </button>
      </div>
      <button
        onClick={handleDismiss}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-white transition-colors text-lg leading-none p-1"
        aria-label="Dismiss banner"
      >
        ×
      </button>
    </div>
  );
}
