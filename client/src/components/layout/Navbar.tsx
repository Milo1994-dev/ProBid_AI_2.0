import React, { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../contexts/AuthContext";
import { api } from "../../api/client";
import { Button } from "../ui/Button";

export function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm transition-colors ${isActive ? "text-brand-green font-semibold" : "text-brand-textMuted hover:text-brand-textPrimary"}`;

  const billingQuery = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => api.getBillingStatus().then((r) => r.data),
    enabled: !!user,
    staleTime: 60_000,
  });
  const plan = billingQuery.data?.plan;
  const showGuarantees = plan === "pro" || plan === "business" || plan === "lifetime";

  const guaranteesEligibilityQuery = useQuery<{
    success: boolean;
    data?: Record<string, { eligible: boolean; alreadyClaimed: boolean }>;
  }>({
    queryKey: ["guarantees-eligibility-nav"],
    queryFn: () => fetch("/api/guarantees/eligibility").then((r) => r.json()),
    enabled: !!user && showGuarantees,
    staleTime: 60_000,
  });
  const hasClaimable = !!(
    guaranteesEligibilityQuery.data?.success &&
    guaranteesEligibilityQuery.data.data &&
    Object.values(guaranteesEligibilityQuery.data.data).some(
      (e) => e.eligible && !e.alreadyClaimed,
    )
  );

  const guaranteesLabel = (
    <span className="inline-flex items-center gap-1.5">
      <span>Guarantees</span>
      {hasClaimable && (
        <span
          className="inline-block h-2 w-2 rounded-full bg-brand-green"
          aria-label="Claim available"
          title="You have a guarantee available to claim"
        />
      )}
    </span>
  );

  return (
    <nav className="sticky top-0 z-40 bg-brand-bg/90 backdrop-blur border-b border-brand-border">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 shrink-0">
          <span className="text-brand-green font-black text-lg tracking-tight">ProBid AI</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden sm:flex items-center gap-6">
          {user ? (
            <>
              <NavLink to="/app" className={navLinkClass}>Dashboard</NavLink>
              <NavLink to="/app/chat" className={navLinkClass}>Chat</NavLink>
              <NavLink to="/app/history" className={navLinkClass}>History</NavLink>
              <NavLink to="/app/procore" className={navLinkClass}>Trust Engine</NavLink>
              <NavLink to="/app/team" className={navLinkClass}>Team</NavLink>
              <NavLink to="/app/pipeline" className={navLinkClass}>Pipeline</NavLink>
              <NavLink to="/app/automations" className={navLinkClass}>Automations</NavLink>
              <NavLink to="/app/affiliate" className={navLinkClass}>Affiliate</NavLink>
              {showGuarantees && (
                <NavLink to="/app/guarantees" className={navLinkClass}>{guaranteesLabel}</NavLink>
              )}
              <NavLink to="/app/billing" className={navLinkClass}>Billing</NavLink>
            </>
          ) : (
            <>
              <a href="#features" className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Features</a>
              <a href="#pricing" className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors">Pricing</a>
            </>
          )}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={() => navigate("/app/estimate/new")}
                className="hidden sm:inline-flex"
              >
                New Estimate
              </Button>
              <Button variant="ghost" size="sm" onClick={logout}>
                Sign Out
              </Button>
            </>
          ) : (
            <>
              <Link to="/login">
                <Button variant="ghost" size="sm">Log In</Button>
              </Link>
              <Link to="/signup">
                <Button variant="primary" size="sm">Get Started</Button>
              </Link>
            </>
          )}

          {/* Mobile menu toggle — shown for all users */}
          <button
            className="sm:hidden text-brand-textMuted hover:text-brand-textPrimary p-1"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Toggle menu"
          >
            {menuOpen ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4L16 16M16 4L4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="sm:hidden border-t border-brand-border bg-brand-card px-4 py-4 flex flex-col gap-4">
          {user ? (
            <>
              <NavLink to="/app" className={navLinkClass} onClick={() => setMenuOpen(false)}>Dashboard</NavLink>
              <NavLink to="/app/estimate/new" className={navLinkClass} onClick={() => setMenuOpen(false)}>New Estimate</NavLink>
              <NavLink to="/app/chat" className={navLinkClass} onClick={() => setMenuOpen(false)}>Chat</NavLink>
              <NavLink to="/app/history" className={navLinkClass} onClick={() => setMenuOpen(false)}>History</NavLink>
              <NavLink to="/app/procore" className={navLinkClass} onClick={() => setMenuOpen(false)}>Trust Engine</NavLink>
              <NavLink to="/app/team" className={navLinkClass} onClick={() => setMenuOpen(false)}>Team</NavLink>
              <NavLink to="/app/pipeline" className={navLinkClass} onClick={() => setMenuOpen(false)}>Pipeline</NavLink>
              <NavLink to="/app/automations" className={navLinkClass} onClick={() => setMenuOpen(false)}>Automations</NavLink>
              <NavLink to="/app/affiliate" className={navLinkClass} onClick={() => setMenuOpen(false)}>Affiliate</NavLink>
              {showGuarantees && (
                <NavLink to="/app/guarantees" className={navLinkClass} onClick={() => setMenuOpen(false)}>{guaranteesLabel}</NavLink>
              )}
              <NavLink to="/app/billing" className={navLinkClass} onClick={() => setMenuOpen(false)}>Billing</NavLink>
            </>
          ) : (
            <>
              <a href="#demo" className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors" onClick={() => setMenuOpen(false)}>Demo</a>
              <a href="#features" className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors" onClick={() => setMenuOpen(false)}>Features</a>
              <a href="#pricing" className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors" onClick={() => setMenuOpen(false)}>Pricing</a>
              <div className="pt-2 border-t border-brand-border flex flex-col gap-2">
                <NavLink to="/login" className="text-sm text-brand-textMuted hover:text-brand-textPrimary transition-colors" onClick={() => setMenuOpen(false)}>Log In</NavLink>
                <NavLink to="/signup" className="text-sm font-bold text-brand-green hover:underline" onClick={() => setMenuOpen(false)}>Start Free Trial →</NavLink>
              </div>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
