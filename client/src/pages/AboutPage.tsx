import React from "react";
import { Link } from "react-router-dom";
import { usePageMeta } from "../hooks/usePageMeta";

const COMPANY = "ProBid AI";
const EMAIL = "support@probidcore.net";

export default function AboutPage() {
  usePageMeta({
    title: "About | ProBid AI",
    description: "ProBid AI is built by a real contractor for contractors. Learn who we are, what we build, and why thousands of trades use ProBid for fast, accurate construction estimates.",
    canonical: "https://probidcore.net/about",
  });

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
        <h1 className="text-4xl font-black text-brand-textPrimary mb-2">About {COMPANY}</h1>
        <p className="text-brand-textSubtle text-sm mb-12">Built by a real contractor, for real contractors.</p>

        <div className="space-y-10 text-brand-textMuted leading-relaxed">

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">Who builds ProBid AI</h2>
            <p>
              ProBid AI was built by <strong className="text-brand-textPrimary">Jesse Kirchner</strong>, a working
              contractor who got tired of losing nights and weekends to writing bids. After years of running jobs in the
              field — masonry, tuckpointing, chimneys, retaining walls, concrete flatwork — he kept hitting the same
              wall every contractor knows: the work that wins jobs (the estimate) is the work nobody pays you for.
              ProBid AI is the tool he built to fix that. Every feature on this site exists because a contractor in
              the field asked for it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">What it does and the problem it solves</h2>
            <p>
              {COMPANY} turns a job description and a few photos into a clean, itemized estimate in under 60 seconds.
              No spreadsheets, no copy-pasting from old bids, no guessing material counts at 11pm. You get a
              line-item breakdown — labor, materials, contingency — that you can edit, brand, save, and send as a
              PDF. The same estimate that used to take two hours now takes about as long as a coffee break.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">What we stand for</h2>
            <ul className="list-disc pl-6 space-y-3">
              <li>
                <strong className="text-brand-textPrimary">Real contractor-built.</strong> Every prompt, line item,
                and unit price was tuned by someone who has actually swung a hammer for a living.
              </li>
              <li>
                <strong className="text-brand-textPrimary">94% accuracy benchmark.</strong> We continuously
                benchmark estimates against real, closed jobs from working trades. Our public accuracy target is
                ±6% on labor + materials.
              </li>
              <li>
                <strong className="text-brand-textPrimary">Transparent pricing.</strong> Try a single estimate
                for $7 or start a 7-day free trial of Pro. Paid plans are a flat monthly fee — no per-estimate
                gotchas, no surprise add-ons.
              </li>
              <li>
                <strong className="text-brand-textPrimary">Your data is yours.</strong> We don't sell your job
                photos or descriptions, and we never use them to train public AI models without your consent. See
                the <Link to="/privacy" className="text-brand-green hover:underline">Privacy Policy</Link> for
                detail.
              </li>
              <li>
                <strong className="text-brand-textPrimary">Built to be useful, not impressive.</strong> No 14-step
                onboarding, no "AI workspace dashboards." Type the job, get the bid, send it.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">How to reach us</h2>
            <p>
              The fastest way to get a human is the <Link to="/contact" className="text-brand-green hover:underline">contact
              form</Link>, or you can email{" "}
              <a href={`mailto:${EMAIL}`} className="text-brand-green hover:underline">{EMAIL}</a> directly. Founder
              replies within one business day, usually faster.
            </p>
          </section>

          <section className="border-t border-brand-border pt-10 mt-10">
            <h2 className="text-2xl font-bold text-brand-textPrimary mb-4">Try it risk-free</h2>
            <p className="mb-6">
              Grab a single estimate for $7, or start a 7-day free trial of Pro for unlimited estimates. No charge
              during the trial — cancel any time.
            </p>
            <Link
              to="/"
              className="inline-block bg-brand-green text-brand-bg font-bold px-6 py-3 rounded-lg hover:opacity-90 transition-opacity"
            >
              Try ProBid free →
            </Link>
          </section>

        </div>
      </main>

      <footer className="border-t border-brand-border py-8 text-center text-xs text-brand-textSubtle">
        <div className="flex gap-6 justify-center mb-2 flex-wrap">
          <Link to="/" className="hover:text-brand-textPrimary transition-colors">Home</Link>
          <Link to="/contact" className="hover:text-brand-textPrimary transition-colors">Contact</Link>
          <Link to="/terms" className="hover:text-brand-textPrimary transition-colors">Terms of Service</Link>
          <Link to="/privacy" className="hover:text-brand-textPrimary transition-colors">Privacy Policy</Link>
        </div>
        &copy; {new Date().getFullYear()} {COMPANY}. All rights reserved.
      </footer>
    </div>
  );
}
