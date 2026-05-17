import { useEffect, useRef, lazy, Suspense, ComponentType, ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { ProtectedRoute } from "./router/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";

// `/` hydrates eager (no Suspense flash); everything else is lazy.
import HomePage from "./pages/HomePage";

// QueryProvider is lazy — only mounted under routes that use react-query.
const QueryProvider = lazy(() => import("./providers/QueryProvider"));

const PricingPage = lazy(() => import("./pages/PricingPage"));
const AccuracyPage = lazy(() => import("./pages/AccuracyPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const ContactPage = lazy(() => import("./pages/ContactPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const SignupPage = lazy(() => import("./pages/SignupPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const VideoTemplate = lazy(() => import("./VideoTemplate"));
const DemoPreviewPage = lazy(() => import("./pages/DemoPreviewPage"));

// Partner docs is public, no react-query.
const PartnerDocsPage = lazy(() => import("./pages/PartnerDocsPage"));

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const EstimateNewPage = lazy(() => import("./pages/EstimateNewPage"));
const EstimateBuilderPage = lazy(() => import("./pages/EstimateBuilderPage"));
const EstimateDetailPage = lazy(() => import("./pages/EstimateDetailPage"));
const BillingPage = lazy(() => import("./pages/BillingPage"));
const AffiliatePage = lazy(() => import("./pages/AffiliatePage"));
const AdminDashboardPage = lazy(() => import("./pages/AdminDashboardPage"));
const HealthPage = lazy(() => import("./pages/HealthPage"));
const ProcorePage = lazy(() => import("./pages/ProcorePage"));
const TeamPage = lazy(() => import("./pages/TeamPage"));
const SocialPage = lazy(() => import("./pages/SocialPage"));
const DeveloperPage = lazy(() => import("./pages/DeveloperPage"));
const PipelinePage = lazy(() => import("./pages/PipelinePage"));
const AutomationPage = lazy(() => import("./pages/AutomationPage"));
const ChatPage = lazy(() => import("./pages/ChatPage"));
const PartnerPortalPage = lazy(() => import("./pages/PartnerPortalPage"));
const GuaranteesPage = lazy(() => import("./pages/GuaranteesPage"));

// Map specific paths to the legacy analytics event names that downstream
// funnels (admin dashboard, marketing-stats) already aggregate on. Anything
// else gets a generic `page_view` row keyed by `properties.path`.
const PATH_EVENT_MAP: Record<string, string> = {
  "/": "homepage_visit",
  "/pricing": "pricing_visit",
  "/signup": "signup_page_visit",
};

// Allowlist of query params that are safe to persist with a page-view.
// Everything else (notably `email`, `name`, `phone`, `password`, `token`,
// password reset / verification tokens, etc.) is dropped before the row is
// written so the analytics table never becomes a PII reservoir. The Home →
// Signup hand-off in particular forwards `?email=…&name=…&trade=…`, which
// must not land in `analytics.data`.
const SAFE_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
  "gclid",
  "fbclid",
  "plan",
  "interval",
]);

function sanitizeSearch(search: string): string | undefined {
  if (!search) return undefined;
  const params = new URLSearchParams(search);
  const safe = new URLSearchParams();
  for (const [k, v] of params) {
    if (SAFE_QUERY_PARAMS.has(k.toLowerCase())) safe.set(k, v);
  }
  const out = safe.toString();
  return out ? `?${out}` : undefined;
}

function PageViewTracker() {
  const location = useLocation();
  const isFirstGtagFire = useRef(true);
  useEffect(() => {
    const path = location.pathname;
    const safeSearch = sanitizeSearch(location.search);

    // Internal analytics — fire on every route change including first render.
    // Previously this hook delegated tracking to per-page `track("homepage_visit")`
    // calls in HomePage/PricingPage/SignupPage. Those calls were accidentally
    // removed in the Apr 30 landing-page redesign (commit eb7c1db), causing the
    // `analytics` table to flatline while GA continued recording 279 sessions.
    // Centralizing here means a future page redesign can never drop tracking again.
    const event = PATH_EVENT_MAP[path] ?? "page_view";
    fetch("/api/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify({
        event,
        properties: {
          path,
          search: safeSearch,
          referrer: document.referrer || undefined,
          title: document.title,
        },
      }),
    }).catch(() => {});

    // GA — skip the first render because gtag's `config` snippet already
    // fires the initial page_view automatically on script load.
    if (isFirstGtagFire.current) {
      isFirstGtagFire.current = false;
      return;
    }
    const w = window as unknown as { gtag?: (...args: unknown[]) => void };
    if (typeof w.gtag === "function") {
      w.gtag("event", "page_view", {
        // Strip raw query string from the GA page_path too — Home → Signup
        // forwards email/name/trade in the URL and GA's "remove URL query
        // parameters" setting would otherwise need separate configuration.
        page_path: path + (safeSearch ?? ""),
        page_location: window.location.origin + path + (safeSearch ?? ""),
        page_title: document.title,
      });
    }
  }, [location.pathname, location.search]);
  return null;
}

function RouteFallback() {
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#6b7280",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: "0.95rem",
      }}
      aria-live="polite"
      aria-busy="true"
    >
      Loading…
    </div>
  );
}

// Lazy page, no QueryProvider.
function L({ C }: { C: ComponentType }) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <C />
    </Suspense>
  );
}

// Lazy page wrapped in QueryProvider.
function Q({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <QueryProvider>{children}</QueryProvider>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <PageViewTracker />
          <Routes>
            <Route path="/" element={<HomePage />} />

            <Route path="/pricing" element={<L C={PricingPage} />} />
            <Route path="/accuracy" element={<L C={AccuracyPage} />} />
            <Route path="/about" element={<L C={AboutPage} />} />
            <Route path="/contact" element={<L C={ContactPage} />} />
            <Route path="/terms" element={<L C={TermsPage} />} />
            <Route path="/privacy" element={<L C={PrivacyPage} />} />
            <Route path="/login" element={<L C={LoginPage} />} />
            <Route path="/signup" element={<L C={SignupPage} />} />
            <Route path="/video" element={<L C={VideoTemplate} />} />
            <Route path="/preview/demo" element={<L C={DemoPreviewPage} />} />

            {/* Public partner docs — no auth, no react-query. */}
            <Route path="/partners/docs" element={<L C={PartnerDocsPage} />} />

            <Route path="/success" element={<Navigate to="/app/billing" replace />} />
            <Route path="/billing" element={<Navigate to="/app/billing" replace />} />
            <Route path="/checkout" element={<Navigate to="/app/billing" replace />} />
            <Route path="/checkout/*" element={<Navigate to="/app/billing" replace />} />
            <Route path="/marketing-kit" element={<Navigate to="/" replace />} />
            <Route path="/templates" element={<Navigate to="/" replace />} />
            <Route path="/affiliate" element={<Navigate to="/app/affiliate" replace />} />
            <Route path="/app/dashboard" element={<Navigate to="/app" replace />} />

            <Route
              path="/estimate/new"
              element={
                <Q>
                  <ProtectedRoute>
                    <EstimateNewPage />
                  </ProtectedRoute>
                </Q>
              }
            />

            <Route
              path="/app/*"
              element={
                <Q>
                  <Routes>
                    <Route
                      path=""
                      element={
                        <ProtectedRoute>
                          <DashboardPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="estimate/new"
                      element={
                        <ProtectedRoute>
                          <EstimateNewPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="estimate/builder"
                      element={
                        <ProtectedRoute>
                          <EstimateBuilderPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="history"
                      element={
                        <ProtectedRoute>
                          <HistoryPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="estimates/:id"
                      element={
                        <ProtectedRoute>
                          <EstimateDetailPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="billing"
                      element={
                        <ProtectedRoute>
                          <BillingPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="affiliate"
                      element={
                        <ProtectedRoute>
                          <AffiliatePage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="procore"
                      element={
                        <ProtectedRoute>
                          <ProcorePage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="team"
                      element={
                        <ProtectedRoute>
                          <TeamPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="social"
                      element={
                        <ProtectedRoute>
                          <SocialPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="developer"
                      element={
                        <ProtectedRoute>
                          <DeveloperPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="pipeline"
                      element={
                        <ProtectedRoute>
                          <PipelinePage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="automations"
                      element={
                        <ProtectedRoute>
                          <AutomationPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="chat"
                      element={
                        <ProtectedRoute>
                          <ChatPage />
                        </ProtectedRoute>
                      }
                    />
                    {/* Partner Portal — protected. */}
                    <Route
                      path="partner"
                      element={
                        <ProtectedRoute>
                          <PartnerPortalPage />
                        </ProtectedRoute>
                      }
                    />
                    {/* Guarantees — claim status page. */}
                    <Route
                      path="guarantees"
                      element={
                        <ProtectedRoute>
                          <L C={GuaranteesPage} />
                        </ProtectedRoute>
                      }
                    />
                    {/* Admin dashboard (key-guarded). */}
                    <Route path="admin" element={<AdminDashboardPage />} />
                    {/* Stability watchtower — admin key-guarded (Task #140). */}
                    <Route path="admin/health" element={<L C={HealthPage} />} />
                  </Routes>
                </Q>
              }
            />

            {/* 404 */}
            <Route path="*" element={<L C={NotFoundPage} />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
