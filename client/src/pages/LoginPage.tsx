import React, { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Alert } from "../components/ui/Alert";
import { track } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";

export default function LoginPage() {
  const { login, user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  usePageMeta({
    title: "Log In | ProBid AI",
    description: "Sign in to your ProBid AI account and start generating professional construction estimates in seconds.",
    canonical: "https://probidcore.net/login",
  });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const from = (location.state as { from?: string })?.from ?? "/app";
  const expired = (location.state as { expired?: boolean })?.expired ?? false;
  const ref = new URLSearchParams(window.location.search).get("ref") ?? undefined;

  useEffect(() => {
    if (!loading && user) navigate(from, { replace: true });
  }, [user, loading, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setEmailError("");
    setPasswordError("");

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) { setEmailError("Email is required"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setEmailError("Please enter a valid email address"); return; }
    if (!password) { setPasswordError("Password is required"); return; }

    setSubmitting(true);
    track("login_start");

    const result = await login(trimmed, password, ref);

    if (result.success) {
      track("login_success");
      navigate(from, { replace: true });
    } else {
      setError(result.error ?? "Login failed. Please try again.");
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
          <h2 className="text-2xl font-black text-brand-textPrimary leading-tight mb-3">
            AI-Powered Estimates<br/>
            <span className="text-brand-green">in 30 Seconds</span>
          </h2>
          <p className="text-brand-textMuted text-sm mb-6">
            Upload a photo or describe the job — get a full materials and labor breakdown before you leave the property.
          </p>

          <div className="space-y-4 mb-6">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-brand-green/10 border border-brand-green/20 flex items-center justify-center text-brand-green shrink-0">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} className="w-4 h-4">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-bold text-brand-textPrimary">Instant estimates</p>
                <p className="text-xs text-brand-textSubtle">GPT-4 Vision analyzes photos and generates accurate breakdowns</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-brand-green/10 border border-brand-green/20 flex items-center justify-center text-brand-green shrink-0">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-bold text-brand-textPrimary">Professional PDFs</p>
                <p className="text-xs text-brand-textSubtle">Client-ready reports you can share instantly</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-brand-green/10 border border-brand-green/20 flex items-center justify-center text-brand-green shrink-0">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-bold text-brand-textPrimary">Regional pricing</p>
                <p className="text-xs text-brand-textSubtle">Costs adjusted for your local market automatically</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-brand-border bg-brand-card p-4">
            <div className="flex items-center gap-2 mb-2">
              {[1,2,3,4,5].map((s) => (
                <svg key={s} className="w-3.5 h-3.5 text-yellow-400 fill-current" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
                </svg>
              ))}
            </div>
            <p className="text-xs text-brand-textSubtle italic">
              "I built ProBid AI because I was sick of losing my evenings to estimates. Now I generate a full quote from a photo on the drive home."
            </p>
            <p className="text-xs text-brand-textSubtle mt-1 font-medium">— Jesse Kirchner, Founder · Kirchner Masonry, Galena, IL</p>
          </div>
        </div>

        <div className="p-8 flex flex-col justify-center">
          <h1 className="text-2xl font-bold text-brand-textPrimary mb-2">Welcome back</h1>
          <p className="text-brand-textMuted text-sm mb-8">
            Sign in to access your estimates and start quoting.
          </p>

          {expired && (
            <Alert type="warning" className="mb-6">
              Your session expired. Please sign in again.
            </Alert>
          )}

          {error && (
            <Alert type="error" className="mb-6" onDismiss={() => setError("")}>
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <Input
              label="Email address"
              type="email"
              placeholder="you@example.com"
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
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={passwordError}
              autoComplete="current-password"
              disabled={submitting}
            />

            <Button type="submit" fullWidth loading={submitting} size="lg" className="shadow-lg shadow-brand-green/20">
              {submitting ? "Signing in..." : "Sign In"}
            </Button>
          </form>

          <div className="mt-6 pt-6 border-t border-brand-border">
            <p className="text-center text-sm text-brand-textSubtle">
              Don't have an account?{" "}
              <Link to="/signup" className="text-brand-green hover:underline font-medium">
                Sign up free
              </Link>
            </p>
            <p className="text-center text-xs text-brand-textSubtle mt-2">
              7-day free trial · $7 single estimate
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-4 text-[11px] text-brand-textSubtle">
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
          256-bit SSL
        </span>
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
          Data stays private
        </span>
      </div>
    </div>
  );
}
