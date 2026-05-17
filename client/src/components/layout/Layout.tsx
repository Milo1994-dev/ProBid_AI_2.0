import React from "react";
import { Link } from "react-router-dom";
import { Navbar } from "./Navbar";
import { FoundingMembersBanner } from "../ui/FoundingMembersBanner";
import { TrialBanner } from "../ui/TrialBanner";

interface LayoutProps {
  children: React.ReactNode;
  showNav?: boolean;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "full";
}

const maxWidthClasses = {
  sm: "max-w-2xl",
  md: "max-w-3xl",
  lg: "max-w-5xl",
  xl: "max-w-6xl",
  full: "max-w-full",
};

export function Layout({ children, showNav = true, maxWidth = "xl" }: LayoutProps) {
  return (
    <div className="min-h-screen bg-brand-bg">
      <FoundingMembersBanner />
      <TrialBanner />
      {showNav && <Navbar />}
      <main className={`${maxWidthClasses[maxWidth]} mx-auto px-4 sm:px-6 py-8 sm:py-12`}>
        {children}
      </main>
      <footer className="mt-auto border-t border-brand-border py-6 text-center text-xs text-brand-textSubtle space-y-2">
        <div className="flex flex-wrap gap-x-6 gap-y-1 justify-center">
          <Link to="/" className="hover:text-brand-textPrimary transition-colors">Home</Link>
          <Link to="/about" className="hover:text-brand-textPrimary transition-colors">About</Link>
          <a href="/guarantees" className="hover:text-brand-textPrimary transition-colors">Guarantees</a>
          <Link to="/contact" className="hover:text-brand-textPrimary transition-colors">Contact</Link>
          <Link to="/terms" className="hover:text-brand-textPrimary transition-colors">Terms of Service</Link>
          <Link to="/privacy" className="hover:text-brand-textPrimary transition-colors">Privacy Policy</Link>
          <a href="mailto:support@probidcore.net" className="hover:text-brand-textPrimary transition-colors">Support</a>
        </div>
        <div>
          &copy; {new Date().getFullYear()} ProBid AI — Start your 7-day free trial at{" "}
          <a href="https://probidcore.net" className="text-brand-green hover:underline">
            probidcore.net
          </a>
        </div>
      </footer>
    </div>
  );
}
