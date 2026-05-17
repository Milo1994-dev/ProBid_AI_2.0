import React from "react";
import { Link } from "react-router-dom";
import { usePageMeta } from "../hooks/usePageMeta";

const EFFECTIVE_DATE = "April 1, 2026";
const COMPANY = "ProBid AI";
const DOMAIN = "probidcore.net";
const EMAIL = "support@probidcore.net";

export default function TermsPage() {
  usePageMeta({
    title: "Terms of Service | ProBid AI",
    description: "Read the ProBid AI Terms of Service. Learn about your rights and responsibilities when using our AI-powered construction estimating platform.",
    canonical: "https://probidcore.net/terms",
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
        <h1 className="text-4xl font-black text-brand-textPrimary mb-2">Terms of Service</h1>
        <p className="text-brand-textSubtle text-sm mb-12">Effective date: {EFFECTIVE_DATE}</p>

        <div className="prose prose-invert max-w-none space-y-10 text-brand-textMuted leading-relaxed">

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using {COMPANY} at {DOMAIN} (the "Service"), you agree to be bound
              by these Terms of Service ("Terms"). If you do not agree to these Terms, do not use the
              Service. These Terms apply to all visitors, users, and others who access or use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">2. Description of Service</h2>
            <p>
              {COMPANY} provides an AI-powered construction estimation tool that allows contractors
              and construction professionals to generate cost estimates from job descriptions and photos.
              Estimates are generated using artificial intelligence and are provided for informational
              and planning purposes only.
            </p>
            <p className="mt-3">
              <strong className="text-brand-textPrimary">Important:</strong> Estimates produced by
              {COMPANY} are AI-generated approximations. They do not constitute professional engineering,
              architectural, or licensed contractor advice. You are solely responsible for verifying
              all estimates before using them in bids, contracts, or financial decisions.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">3. Accounts and Registration</h2>
            <p>
              To use certain features of the Service, you must register for an account. You agree to:
            </p>
            <ul className="list-disc pl-6 mt-3 space-y-2">
              <li>Provide accurate, current, and complete information during registration</li>
              <li>Maintain and promptly update your account information</li>
              <li>Keep your login credentials secure and confidential</li>
              <li>Notify us immediately of any unauthorized use of your account</li>
              <li>Accept responsibility for all activities that occur under your account</li>
            </ul>
            <p className="mt-3">
              You must be at least 18 years old to use this Service. By registering, you represent
              that you are at least 18 years of age.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">4. Pricing and Paid Plans</h2>
            <p>
              {COMPANY} offers paid plans, a 7-day free trial of Pro, and a one-time $7 single-estimate option.
              Earlier accounts may retain a small lifetime allowance of free estimates as originally provided.
              Pricing, plan features, and trial terms are subject to change at any time with reasonable notice
              and are described on our pricing page.
            </p>
            <p className="mt-3">
              Paid subscriptions are billed on a recurring basis (monthly or annually as selected).
              You may cancel your subscription at any time through the billing portal. Cancellation
              takes effect at the end of the current billing period. No partial refunds are provided
              for unused portions of a subscription period unless required by applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">5. Prohibited Uses</h2>
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc pl-6 mt-3 space-y-2">
              <li>Violate any applicable laws or regulations</li>
              <li>Submit fraudulent, false, or misleading information</li>
              <li>Attempt to reverse engineer, decompile, or extract the underlying AI models</li>
              <li>Scrape, crawl, or programmatically access the Service without authorization</li>
              <li>Resell or redistribute access to the Service without written permission</li>
              <li>Upload content that infringes any third-party intellectual property rights</li>
              <li>Attempt to gain unauthorized access to any part of the Service or its infrastructure</li>
              <li>Transmit malicious code, viruses, or other harmful software</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">6. Intellectual Property</h2>
            <p>
              The Service and its original content, features, and functionality are and will remain
              the exclusive property of {COMPANY} and its licensors. Our trademarks and trade dress
              may not be used in connection with any product or service without prior written consent.
            </p>
            <p className="mt-3">
              You retain ownership of content you submit (job descriptions, photos). By submitting
              content, you grant {COMPANY} a limited, non-exclusive, royalty-free license to use,
              store, and process that content solely to provide the Service to you. We do not sell
              your content or use it to train public AI models without your consent.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">7. Accuracy of Estimates</h2>
            <p>
              AI-generated estimates are approximations based on publicly available pricing data,
              regional market inputs, and machine learning models. {COMPANY} does not guarantee
              the accuracy, completeness, or fitness of any estimate for any specific purpose.
              Actual project costs may vary significantly based on local conditions, material
              availability, labor markets, permits, and other factors outside our control.
            </p>
            <p className="mt-3">
              You agree to independently verify all estimates before using them in any commercial,
              contractual, or financial context.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">8. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, {COMPANY} and its officers, directors,
              employees, and agents shall not be liable for any indirect, incidental, special,
              consequential, or punitive damages, including but not limited to loss of profits,
              data, or business opportunities, arising out of or related to your use of the Service.
            </p>
            <p className="mt-3">
              Our total liability to you for any claims arising from these Terms or the Service
              shall not exceed the amount you paid to {COMPANY} in the twelve (12) months
              preceding the claim.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">9. Disclaimer of Warranties</h2>
            <p>
              The Service is provided "as is" and "as available" without warranties of any kind,
              either express or implied, including but not limited to implied warranties of
              merchantability, fitness for a particular purpose, or non-infringement. We do not
              warrant that the Service will be uninterrupted, error-free, or free of harmful components.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">10. Privacy</h2>
            <p>
              Your use of the Service is also governed by our{" "}
              <Link to="/privacy" className="text-brand-green hover:underline">Privacy Policy</Link>,
              which is incorporated into these Terms by reference.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">11. Termination</h2>
            <p>
              We may terminate or suspend your account and access to the Service immediately,
              without prior notice, if you breach these Terms. Upon termination, your right to
              use the Service will immediately cease. All provisions of these Terms that by their
              nature should survive termination shall survive, including ownership, warranty
              disclaimers, indemnity, and limitations of liability.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">12. Governing Law</h2>
            <p>
              These Terms shall be governed by the laws of the State of Illinois, without regard
              to its conflict of law provisions. Any disputes arising under these Terms shall be
              subject to the exclusive jurisdiction of the courts located in Cook County, Illinois.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">13. Changes to Terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. We will provide notice of
              significant changes by updating the effective date at the top of this page and, where
              appropriate, notifying you by email. Your continued use of the Service after changes
              become effective constitutes your acceptance of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">14. Contact</h2>
            <p>
              Questions about these Terms should be directed to:{" "}
              <a href={`mailto:${EMAIL}`} className="text-brand-green hover:underline">
                {EMAIL}
              </a>
            </p>
          </section>

        </div>
      </main>

      <footer className="border-t border-brand-border py-8 text-center text-xs text-brand-textSubtle">
        <div className="flex gap-6 justify-center mb-2">
          <Link to="/" className="hover:text-brand-textPrimary transition-colors">Home</Link>
          <Link to="/privacy" className="hover:text-brand-textPrimary transition-colors">Privacy Policy</Link>
          <a href={`mailto:${EMAIL}`} className="hover:text-brand-textPrimary transition-colors">Contact</a>
        </div>
        &copy; {new Date().getFullYear()} {COMPANY}. All rights reserved.
      </footer>
    </div>
  );
}
