import React from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { usePageMeta } from "../hooks/usePageMeta";

export default function NotFoundPage() {
  usePageMeta({
    title: "Page Not Found | ProBid AI",
    description: "The page you're looking for doesn't exist. Return to ProBid AI and start generating professional construction estimates in seconds.",
  });

  return (
    <div className="min-h-screen bg-brand-bg flex flex-col items-center justify-center px-4 text-center">
      <div className="text-6xl mb-6">🔧</div>
      <h1 className="text-4xl font-black text-brand-textPrimary mb-3">Page Not Found</h1>
      <p className="text-brand-textMuted max-w-md mb-8">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div className="flex gap-4">
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
        <Link to="/app">
          <Button variant="ghost">Dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
