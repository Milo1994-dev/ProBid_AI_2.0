import React from "react";
import { Link } from "react-router-dom";
import { usePageMeta } from "../hooks/usePageMeta";

const EFFECTIVE_DATE = "April 1, 2026";
const COMPANY = "ProBid AI";
const EMAIL = "support@probidcore.net";

export default function PrivacyPage() {
  usePageMeta({
    title: "Privacy Policy | ProBid AI",
    description: "Read the ProBid AI Privacy Policy. Learn how we collect, use, and protect your data on our AI-powered construction estimating platform.",
    canonical: "https://probidcore.net/privacy",
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
        <h1 className="text-4xl font-black text-brand-textPrimary mb-2">Privacy Policy</h1>
        <p className="text-brand-textSubtle text-sm mb-12">Effective date: {EFFECTIVE_DATE}</p>

        <div className="space-y-10 text-brand-textMuted leading-relaxed">

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">1. Overview</h2>
            <p>
              {COMPANY} ("we," "us," or "our") is committed to protecting your personal information.
              This Privacy Policy explains what data we collect, how we use it, and your rights
              regarding that data when you use our service at probidcore.net.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">2. Information We Collect</h2>

            <h3 className="text-base font-semibold text-brand-textPrimary mb-2 mt-4">Information you provide directly:</h3>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong className="text-brand-textPrimary">Email address</strong> — required to create an account and receive login links</li>
              <li><strong className="text-brand-textPrimary">Job descriptions and photos</strong> — submitted when generating estimates</li>
              <li><strong className="text-brand-textPrimary">Trade type and project details</strong> — provided in lead capture or estimate forms</li>
            </ul>

            <h3 className="text-base font-semibold text-brand-textPrimary mb-2 mt-4">Information collected automatically:</h3>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong className="text-brand-textPrimary">Usage data</strong> — pages visited, features used, estimate counts, time spent</li>
              <li><strong className="text-brand-textPrimary">Device information</strong> — browser type, operating system, screen size</li>
              <li><strong className="text-brand-textPrimary">IP address</strong> — used for security, abuse prevention, and approximate geolocation</li>
              <li><strong className="text-brand-textPrimary">Session data</strong> — stored via encrypted server-side sessions to keep you logged in</li>
            </ul>

            <h3 className="text-base font-semibold text-brand-textPrimary mb-2 mt-4">Payment information:</h3>
            <p>
              We use Stripe to process payments. We never store your credit card number, CVV, or
              full card details. Stripe's privacy policy applies to payment data:{" "}
              <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer"
                className="text-brand-green hover:underline">stripe.com/privacy</a>
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">3. How We Use Your Information</h2>
            <p>We use the information we collect to:</p>
            <ul className="list-disc pl-6 mt-3 space-y-2">
              <li>Provide, operate, and improve the Service</li>
              <li>Generate AI-powered construction estimates from your inputs</li>
              <li>Send you authentication links and account-related notifications</li>
              <li>Process payments and manage your subscription</li>
              <li>Send transactional and product update emails (you can opt out at any time)</li>
              <li>Analyze usage patterns to improve features and performance</li>
              <li>Detect and prevent fraud, abuse, and security incidents</li>
              <li>Comply with legal obligations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">4. How We Share Your Information</h2>
            <p>We do not sell your personal data. We share data only in these circumstances:</p>
            <ul className="list-disc pl-6 mt-3 space-y-2">
              <li>
                <strong className="text-brand-textPrimary">Service providers:</strong> We use
                third-party services including OpenAI (AI processing), Resend (email delivery),
                Stripe (payments), and our hosting provider. These providers access only the data
                necessary to perform their services and are bound by confidentiality agreements.
              </li>
              <li>
                <strong className="text-brand-textPrimary">Legal requirements:</strong> We may
                disclose information when required by law, subpoena, or to protect the rights
                and safety of our users or the public.
              </li>
              <li>
                <strong className="text-brand-textPrimary">Business transfers:</strong> In the
                event of a merger, acquisition, or sale of assets, your data may be transferred
                as part of that transaction with notice to you.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">5. AI Processing and Your Data</h2>
            <p>
              Job descriptions and photos you submit are processed by OpenAI's API to generate
              estimates. This means your content is transmitted to OpenAI's servers for processing.
              We do not use your submitted content to train {COMPANY}'s own models without your consent.
              OpenAI's data handling practices are governed by their{" "}
              <a href="https://openai.com/privacy" target="_blank" rel="noopener noreferrer"
                className="text-brand-green hover:underline">privacy policy</a>.
            </p>
            <p className="mt-3">
              We recommend not including personally identifiable information about third parties
              in your job descriptions or photos.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">6. Data Retention</h2>
            <p>
              We retain your account data and estimates for as long as your account is active.
              If you delete your account, we will delete or anonymize your personal data within
              30 days, except where retention is required by law (e.g., payment records).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">7. Cookies and Tracking</h2>
            <p>
              We use server-side sessions (stored via encrypted cookies) to maintain your login
              state. We do not use third-party advertising cookies or behavioral tracking pixels.
              Our internal analytics track feature usage to improve the product — this data is
              stored on our own servers and is not shared with advertising networks.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">8. Security</h2>
            <p>
              We implement industry-standard security measures including encryption in transit
              (TLS/HTTPS), encrypted session storage, and access controls on our infrastructure.
              No method of transmission over the Internet is 100% secure. While we strive to
              protect your data, we cannot guarantee absolute security.
            </p>
            <p className="mt-3">
              If you believe your account has been compromised, please contact us immediately at{" "}
              <a href={`mailto:${EMAIL}`} className="text-brand-green hover:underline">{EMAIL}</a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">9. Your Rights</h2>
            <p>Depending on your location, you may have the following rights:</p>
            <ul className="list-disc pl-6 mt-3 space-y-2">
              <li><strong className="text-brand-textPrimary">Access:</strong> Request a copy of the personal data we hold about you</li>
              <li><strong className="text-brand-textPrimary">Correction:</strong> Request correction of inaccurate or incomplete data</li>
              <li><strong className="text-brand-textPrimary">Deletion:</strong> Request deletion of your account and personal data</li>
              <li><strong className="text-brand-textPrimary">Portability:</strong> Request an export of your data in a machine-readable format</li>
              <li><strong className="text-brand-textPrimary">Opt-out:</strong> Unsubscribe from marketing emails at any time via the unsubscribe link in any email</li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, email us at{" "}
              <a href={`mailto:${EMAIL}`} className="text-brand-green hover:underline">{EMAIL}</a>.
              We will respond within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">10. Children's Privacy</h2>
            <p>
              The Service is not directed to individuals under the age of 18. We do not knowingly
              collect personal information from children. If you believe a child has provided us
              with personal information, please contact us and we will delete it promptly.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">11. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of material
              changes by updating the effective date and, where appropriate, by sending an email
              notification. Continued use of the Service after changes take effect constitutes
              your acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-brand-textPrimary mb-3">12. Contact Us</h2>
            <p>
              If you have questions, concerns, or requests regarding this Privacy Policy, please
              contact us at:{" "}
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
          <Link to="/terms" className="hover:text-brand-textPrimary transition-colors">Terms of Service</Link>
          <a href={`mailto:${EMAIL}`} className="hover:text-brand-textPrimary transition-colors">Contact</a>
        </div>
        &copy; {new Date().getFullYear()} {COMPANY}. All rights reserved.
      </footer>
    </div>
  );
}
