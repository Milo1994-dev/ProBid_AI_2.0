import React, { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Alert } from "../components/ui/Alert";
import { track, generateEventId } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";

const steps = [
  {
    num: "1",
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
      </svg>
    ),
    title: "Create your account",
    desc: "Just your email — takes 10 seconds. Pick a plan after signup.",
  },
  {
    num: "2",
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} className="w-5 h-5">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    title: "Upload a photo or describe the job",
    desc: "AI analyzes materials, labor, crew size, and regional pricing instantly.",
  },
  {
    num: "3",
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    ),
    title: "Send it and win the job",
    desc: "Professional PDF ready to share. Homeowners see a pro — you close the deal.",
  },
];

export default function SignupPage() {
  const { signup, user, loading } = useAuth();
  const navigate = useNavigate();

  usePageMeta({
    title: "Sign Up | ProBid AI",
    description: "Create your ProBid AI account and start a 7-day free trial of Pro, or grab a single AI-powered estimate for $7.",
    canonical: "https://probidcore.net/signup",
  });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const ref = new URLSearchParams(window.location.search).get("ref") ?? undefined;

  useEffect(() => {
    if (!loading && user) navigate("/app", { replace: true });
  }, [user, loading, navigate]);

  // signup_page_visit is now emitted centrally by App.tsx's PageViewTracker
  // (mapped from path === "/signup"). Removed the duplicate fire here to
  // avoid double-counting the funnel step.

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setEmailError("");
    setPasswordError("");

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) { setEmailError("Email is required"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setEmailError("Please enter a valid email address"); return; }
    if (!password) { setPasswordError("Password is required"); return; }
    if (password.length < 8) { setPasswordError("Password must be at least 8 characters"); return; }

    setSubmitting(true);
    track("signup_start");

    // Generate one event_id and send it to BOTH the browser Pixel
    // (`signup_success`) and the server-side CAPI call (via the API
    // payload). Meta dedupes the pair on identical event_id.
    const metaEventId = generateEventId();
    const result = await signup(trimmed, password, ref, metaEventId);

    if (result.success) {
      track("signup_success", undefined, metaEventId);
      // Fire any pending A/B conversion saved when the user clicked a pricing CTA
      try {
        const pending = localStorage.getItem("pb_ab_pending");
        if (pending) {
          const { visitorId, experimentKey } = JSON.parse(pending);
          if (visitorId && experimentKey) {
            fetch("/api/ab/convert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ visitorId, experimentKey }),
            }).catch(() => undefined);
          }
          localStorage.removeItem("pb_ab_pending");
        }
      } catch {
        // Non-fatal
      }
      navigate("/pricing?welcome=1", { replace: true });
    } else {
      setError(result.error ?? "Signup failed. Please try again.");
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-brand-bg flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-brand-indigo border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-bg flex flex-col items-center justify-center px-4 py-12">
      <Link to="/" className="mb-8">
        <span className="text-brand-green font-black text-2xl">ProBid AI</span>
      </Link>

      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-0 bg-brand-card border border-brand-border rounded-2xl overflow-hidden shadow-2xl shadow-black/20">

        <div className="bg-brand-bg border-b md:border-b-0 md:border-r border-brand-border p-8 flex flex-col justify-center">
          <div className="mb-8">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-green/10 border border-brand-green/20 text-brand-green text-xs font-semibold mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-green animate-ping" />
              Built by a real contractor
            </div>
            <h2 className="text-2xl font-black text-brand-textPrimary leading-tight mb-2">
              Your first estimate is<br/>
              <span className="text-brand-green">30 seconds away.</span>
            </h2>
            <p className="text-brand-textMuted text-sm">
              Here's exactly what happens next:
            </p>
          </div>

          <div className="flex flex-col gap-5">
            {steps.map((step) => (
              <div key={step.num} className="flex items-start gap-4">
                <div className="w-9 h-9 rounded-xl bg-brand-green/10 border border-brand-green/20 flex items-center justify-center text-brand-green shrink-0">
                  {step.icon}
                </div>
                <div>
                  <p className="text-sm font-bold text-brand-textPrimary mb-0.5">{step.title}</p>
                  <p className="text-xs text-brand-textSubtle leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 pt-6 border-t border-brand-border">
            <p className="text-xs text-brand-textSubtle italic">
              "I built ProBid AI because I was sick of losing my evenings to estimates. Now I generate a full quote from a photo on the drive home."
            </p>
            <p className="text-xs text-brand-textSubtle mt-1 font-medium">— Jesse Kirchner, Founder · Kirchner Masonry · Galena, IL</p>
          </div>

          <div className="mt-5 p-3 bg-brand-green/5 border border-brand-green/20 rounded-xl">
            <p className="text-xs text-brand-green font-semibold text-center">
              Materials, labor, regional pricing — all in one PDF
            </p>
          </div>

          <div className="flex items-center gap-4 mt-5 text-[11px] text-brand-textSubtle">
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
              256-bit SSL
            </span>
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
              Data stays private
            </span>
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
              Cancel anytime
            </span>
          </div>
        </div>

        <div className="p-8 flex flex-col justify-center">
          <h1 className="text-2xl font-bold text-brand-textPrimary mb-1">Create your account</h1>
          <p className="text-brand-textMuted text-sm mb-6">
            Pick a plan after signup — 7-day free trial on Pro & Business, or grab a single estimate for $7.
          </p>

          {error && (
            <Alert type="error" className="mb-5" onDismiss={() => setError("")}>
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <Input
              label="Email address"
              type="email"
              placeholder="you@yourcompany.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={emailError}
              autoComplete="email"
              autoFocus
              disabled={submitting}
            />

            <Input
              label="Password"
              type="password"
              placeholder="Create a password (min. 8 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={passwordError}
              autoComplete="new-password"
              disabled={submitting}
            />

            <Button type="submit" fullWidth loading={submitting} size="lg" className="shadow-lg shadow-brand-green/20">
              {submitting ? "Creating account..." : "Create Account & Choose Plan"}
            </Button>
          </form>

          <div className="flex items-center justify-center gap-3 mt-3">
            <span className="text-xs text-brand-textSubtle flex items-center gap-1">
              <svg className="w-3 h-3 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
              7-day free trial
            </span>
            <span className="text-xs text-brand-textSubtle flex items-center gap-1">
              <svg className="w-3 h-3 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
              Cancel anytime
            </span>
            <span className="text-xs text-brand-textSubtle flex items-center gap-1">
              <svg className="w-3 h-3 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
              30 sec setup
            </span>
          </div>

          <p className="text-xs text-brand-textSubtle text-center mt-4">
            By signing up, you agree to our{" "}
            <Link to="/terms" className="text-brand-green hover:underline">Terms of Service</Link>{" "}
            and{" "}
            <Link to="/privacy" className="text-brand-green hover:underline">Privacy Policy</Link>.
          </p>

          <p className="text-center text-sm text-brand-textSubtle mt-6">
            Already have an account?{" "}
            <Link to="/login" className="text-brand-green hover:underline font-medium">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
