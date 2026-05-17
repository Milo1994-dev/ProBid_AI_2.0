import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMeta } from "../hooks/usePageMeta";
import { track } from "../analytics";

const COMPANY = "ProBid AI";
const SUPPORT_EMAIL = "support@probidcore.net";
const HELLO_EMAIL = "hello@probidcore.net";

const SUBJECTS = [
  { value: "general", label: "General question" },
  { value: "sales", label: "Sales / pricing" },
  { value: "support", label: "Help with my account" },
  { value: "billing", label: "Billing" },
  { value: "partnership", label: "Partnership" },
  { value: "press", label: "Press / media" },
  { value: "other", label: "Something else" },
];

type Status = "idle" | "submitting" | "success" | "error";

export default function ContactPage() {
  usePageMeta({
    title: "Contact | ProBid AI",
    description: "Get in touch with ProBid AI. We typically reply within 1 business day. Reach the founder directly for sales, support, or partnership questions.",
    canonical: "https://probidcore.net/contact",
  });

  const [csrf, setCsrf] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("general");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/csrf", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.data?.token) setCsrf(data.data.token);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function validate(): string | null {
    if (!name.trim()) return "Please enter your name.";
    if (!email.trim()) return "Please enter your email.";
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email.trim())) return "Please enter a valid email address.";
    if (message.trim().length < 10) return "Please include a short message (at least 10 characters).";
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const v = validate();
    if (v) {
      setErrorMsg(v);
      return;
    }
    if (!csrf) {
      setErrorMsg("Form is still loading. Please try again in a moment.");
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          subject,
          message: message.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setStatus("error");
        setErrorMsg(data?.error || "We couldn't send your message. Please try again.");
        return;
      }
      track("contact_form_submitted", { subject });
      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMsg("Network error. Please try again or email us directly.");
    }
  }

  return (
    <div className="min-h-screen bg-brand-bg">
      <nav className="sticky top-0 z-40 bg-brand-bg/90 backdrop-blur border-b border-brand-border">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="text-brand-green font-black text-lg">ProBid AI</Link>
          <Link to="/signup" className="text-sm text-brand-green hover:underline font-medium">
            Get Started Free →
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-16">
        <h1 className="text-4xl font-black text-brand-textPrimary mb-2">Contact us</h1>
        <p className="text-brand-textSubtle text-sm mb-12">
          Founder reads every message. We usually reply within 1 business day.
        </p>

        {status === "success" ? (
          <div className="rounded-lg border border-brand-green/40 bg-brand-green/10 p-6 text-brand-textPrimary">
            <h2 className="text-xl font-bold mb-2">Thanks — message sent.</h2>
            <p className="text-brand-textMuted">
              We usually reply within 1 business day. Keep an eye on your inbox at{" "}
              <strong className="text-brand-textPrimary">{email}</strong>.
            </p>
            <div className="mt-6">
              <Link to="/" className="text-brand-green hover:underline font-medium">
                ← Back to home
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6 text-brand-textMuted" noValidate>
            <div>
              <label htmlFor="contact-name" className="block text-sm font-semibold text-brand-textPrimary mb-2">
                Name
              </label>
              <input
                id="contact-name"
                name="name"
                type="text"
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg bg-brand-bg border border-brand-border px-4 py-3 text-brand-textPrimary focus:outline-none focus:border-brand-green"
              />
            </div>

            <div>
              <label htmlFor="contact-email" className="block text-sm font-semibold text-brand-textPrimary mb-2">
                Email
              </label>
              <input
                id="contact-email"
                name="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg bg-brand-bg border border-brand-border px-4 py-3 text-brand-textPrimary focus:outline-none focus:border-brand-green"
              />
            </div>

            <div>
              <label htmlFor="contact-subject" className="block text-sm font-semibold text-brand-textPrimary mb-2">
                Subject
              </label>
              <select
                id="contact-subject"
                name="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-lg bg-brand-bg border border-brand-border px-4 py-3 text-brand-textPrimary focus:outline-none focus:border-brand-green"
              >
                {SUBJECTS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="contact-message" className="block text-sm font-semibold text-brand-textPrimary mb-2">
                Message
              </label>
              <textarea
                id="contact-message"
                name="message"
                required
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full rounded-lg bg-brand-bg border border-brand-border px-4 py-3 text-brand-textPrimary focus:outline-none focus:border-brand-green resize-y"
              />
            </div>

            {status === "error" && errorMsg && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
                {errorMsg}{" "}
                <span>
                  You can also email us directly at{" "}
                  <a href={`mailto:${HELLO_EMAIL}`} className="underline font-medium">
                    {HELLO_EMAIL}
                  </a>.
                </span>
              </div>
            )}

            {status !== "error" && errorMsg && (
              <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm text-yellow-200">
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={status === "submitting"}
              className="bg-brand-green text-brand-bg font-bold px-6 py-3 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {status === "submitting" ? "Sending..." : "Send message"}
            </button>
          </form>
        )}

        <section className="mt-16 border-t border-brand-border pt-10">
          <h2 className="text-xl font-bold text-brand-textPrimary mb-4">Other ways to reach us</h2>
          <ul className="space-y-2 text-brand-textMuted">
            <li>
              Support &amp; account help:{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand-green hover:underline">{SUPPORT_EMAIL}</a>
            </li>
            <li>
              General &amp; press:{" "}
              <a href={`mailto:${HELLO_EMAIL}`} className="text-brand-green hover:underline">{HELLO_EMAIL}</a>
            </li>
            <li>
              Want to know more about us first?{" "}
              <Link to="/about" className="text-brand-green hover:underline">Read our About page</Link>.
            </li>
          </ul>
        </section>
      </main>

      <footer className="border-t border-brand-border py-8 text-center text-xs text-brand-textSubtle">
        <div className="flex gap-6 justify-center mb-2 flex-wrap">
          <Link to="/" className="hover:text-brand-textPrimary transition-colors">Home</Link>
          <Link to="/about" className="hover:text-brand-textPrimary transition-colors">About</Link>
          <Link to="/terms" className="hover:text-brand-textPrimary transition-colors">Terms of Service</Link>
          <Link to="/privacy" className="hover:text-brand-textPrimary transition-colors">Privacy Policy</Link>
        </div>
        &copy; {new Date().getFullYear()} {COMPANY}. All rights reserved.
      </footer>
    </div>
  );
}
