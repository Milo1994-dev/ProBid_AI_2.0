/**
 * Centralized API client for all backend requests.
 * Handles CSRF token injection, error normalization, and 401 redirect.
 */

let csrfToken: string | null = null;

/** Fetch and cache the CSRF token from the server */
async function ensureCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch("/api/csrf", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch CSRF token");
  const data = await res.json();
  csrfToken = data.data?.token ?? "";
  return csrfToken!;
}

/** Clear the cached CSRF token (call after logout) */
export function clearCsrfToken() {
  csrfToken = null;
}

/** Standard API response shape */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  retryAfter?: number;
}

/** Make a JSON API request */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isMultipart?: boolean
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};

  if (!isMultipart) {
    headers["Content-Type"] = "application/json";
  }

  // Include CSRF token for state-changing requests
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    try {
      const token = await ensureCsrfToken();
      headers["X-CSRF-Token"] = token;
    } catch {
      // proceed without CSRF (server will reject if needed)
    }
  }

  const init: RequestInit = {
    method,
    headers,
    credentials: "include",
  };

  if (body !== undefined) {
    if (isMultipart && body instanceof FormData) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }

  const res = await fetch(path, init);

  // Handle 401 by broadcasting session expiry
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("auth:expired"));
    return { success: false, error: "Session expired. Please log in again." };
  }

  let json: ApiResponse<T>;
  try {
    json = await res.json();
  } catch {
    throw new Error("Server returned an invalid response.");
  }

  if (!res.ok || json.success === false) {
    const msg = json.error ?? `Request failed (${res.status})`;
    const extra = json as unknown as { code?: string; portal_url?: string; next_action?: string };
    throw Object.assign(new Error(msg), {
      status: res.status,
      apiError: msg,
      retryAfter: json.retryAfter,
      code: extra.code,
      portalUrl: extra.portal_url,
      nextAction: extra.next_action,
    });
  }

  return json;
}

// ---- API methods ----

export const api = {
  /** GET /api/me — current session user */
  getMe: () => request<{ id: string; email: string; affiliateCode: string | null; hasSeenOnboarding: boolean | null; pdfShowGuaranteeBadges: boolean | null } | null>("GET", "/api/me"),

  /** PUT /api/me/pdf-settings — toggle the guarantee trust bar on exported estimate PDFs */
  updatePdfSettings: (pdfShowGuaranteeBadges: boolean) =>
    request<{ pdfShowGuaranteeBadges: boolean }>("PUT", "/api/me/pdf-settings", { pdfShowGuaranteeBadges }),

  /** GET /api/usage — estimates used/limit */
  getUsage: () =>
    request<{ used: number; limit: number | null; plan: string; isUnlimited: boolean; singleCredits?: number }>("GET", "/api/usage"),

  /** GET /api/estimates — paginated estimate list */
  getEstimates: (page = 1, search = "") =>
    request<{ estimates: Estimate[]; total: number; page: number; pages: number }>(
      "GET",
      `/api/estimates?page=${page}&search=${encodeURIComponent(search)}`
    ),

  /** GET /api/estimates/:id — single estimate */
  getEstimate: (id: string) => request<Estimate>("GET", `/api/estimates/${id}`),

  /** GET /api/estimates/:id/line-items — AI-extracted structured line items */
  getEstimateLineItems: (id: string) =>
    request<{ lineItems: Array<{ description: string; quantity: number; unitCost: number; uom: string }> }>(
      "GET",
      `/api/estimates/${id}/line-items`
    ),

  /** POST /api/estimates — create estimate (multipart) */
  createEstimate: (formData: FormData) =>
    request<EstimateResult>("POST", "/api/estimates", formData, true),

  /** POST /api/estimates/send — programmatic estimate with structured line items */
  sendEstimate: (payload: SendEstimateRequest) =>
    request<SendEstimateResponse>("POST", "/api/estimates/send", payload),

  /** PATCH /api/estimates/:id — in-place edit of an estimate's line items + metadata.
   *  Does not consume a paywall credit and preserves the original createdAt. */
  updateEstimateLineItems: (id: string, payload: SendEstimateRequest) =>
    request<SendEstimateResponse>("PATCH", `/api/estimates/${id}`, payload),

  /** GET /api/saved-line-items — list user's saved line-item presets.
   *  Server returns the full filtered list, a `recent` slice (top N most
   *  recently used), and the user's distinct tag list for filter chips. */
  getSavedLineItems: (params?: { q?: string; tag?: string; costType?: string }) => {
    const search = new URLSearchParams();
    if (params?.q) search.set("q", params.q);
    if (params?.tag) search.set("tag", params.tag);
    if (params?.costType) search.set("costType", params.costType);
    const qs = search.toString();
    return request<{
      presets: SavedLineItemPreset[];
      recent: SavedLineItemPreset[];
      tags: string[];
    }>("GET", `/api/saved-line-items${qs ? `?${qs}` : ""}`);
  },

  /** POST /api/saved-line-items — save a line item as a reusable preset */
  createSavedLineItem: (payload: {
    description: string;
    quantity: number;
    unitCost: number;
    uom?: string;
    costType?: string;
    tag?: string;
  }) =>
    request<{ preset: SavedLineItemPreset }>("POST", "/api/saved-line-items", payload),

  /** POST /api/saved-line-items/:id/use — bump the preset's lastUsedAt timestamp */
  markSavedLineItemUsed: (id: string) =>
    request<{ lastUsedAt: number }>("POST", `/api/saved-line-items/${id}/use`),

  /** DELETE /api/saved-line-items/:id — delete a saved preset */
  deleteSavedLineItem: (id: string) =>
    request<null>("DELETE", `/api/saved-line-items/${id}`),

  /** POST /api/transcribe — speech to text */
  transcribe: async (audio: string, format: string = "webm") => {
    const res = await request<{ transcript: string }>("POST", "/api/transcribe", { audio, format });
    return res.data ?? { transcript: "" };
  },

  /** POST /api/login */
  login: (email: string, password: string, ref?: string) =>
    request<{ id: string; email: string }>("POST", "/api/login", { email, password, ref }),

  /** POST /api/signup */
  signup: (email: string, password: string, ref?: string, metaEventId?: string) =>
    request<{ id: string; email: string }>("POST", "/api/signup", { email, password, ref, meta_event_id: metaEventId }),

  /** POST /api/verify */
  verify: (email: string, code: string, mode: "login" | "signup", ref?: string, metaEventId?: string) =>
    request<{ id: string; email: string }>("POST", "/api/verify", { email, code, mode, ref, meta_event_id: metaEventId }),

  /** POST /api/resend-code */
  resendCode: (email: string) =>
    request<{ sent: boolean }>("POST", "/api/resend-code", { email }),

  /** POST /api/logout */
  logout: () => request<null>("POST", "/api/logout"),

  /** GET /api/billing/status */
  getBillingStatus: () =>
    request<BillingStatus>("GET", "/api/billing/status"),

  /** GET /api/entitlements */
  getEntitlements: () =>
    request<Entitlements>("GET", "/api/entitlements"),

  /** POST /api/billing/create-checkout-session */
  getBillingPrices: () => request<{
    proMonthly: { amount: number | null; currency: string | null; interval: string | null };
    proAnnual: { amount: number | null; currency: string | null; interval: string | null };
    businessMonthly: { amount: number | null; currency: string | null; interval: string | null };
    businessAnnual: { amount: number | null; currency: string | null; interval: string | null };
  }>("GET", "/api/billing/prices"),
  createCheckoutSession: async (
    plan: "pro" | "business",
    interval: "monthly" | "annual" = "monthly",
    metaEventId?: string,
    visitorId?: string,
  ) => {
    try {
      return await request<{ url: string }>("POST", "/api/billing/create-checkout-session", { plan, interval, meta_event_id: metaEventId, visitor_id: visitorId });
    } catch (err) {
      const e = err as { status?: number; nextAction?: string; portalUrl?: string };
      // User already has an active subscription — send them to the Customer Portal
      // to upgrade/downgrade/reactivate instead of creating a parallel subscription.
      if (e?.status === 409 && e?.nextAction === "customer_portal" && e?.portalUrl) {
        window.location.href = e.portalUrl;
        return { success: true, data: { url: e.portalUrl } } as ApiResponse<{ url: string }>;
      }
      throw err;
    }
  },

  /** POST /api/billing/single-estimate-checkout */
  createSingleEstimateCheckout: (metaEventId?: string) =>
    request<{ url: string }>("POST", "/api/billing/single-estimate-checkout", { meta_event_id: metaEventId }),

  /** GET /api/affiliate */
  getAffiliate: () =>
    request<AffiliateData>("GET", "/api/affiliate"),

  /** GET /api/referrals */
  getReferrals: () =>
    request<{ referrals: ReferralEntry[] }>("GET", "/api/referrals"),

  /** POST /api/analytics/event */
  trackEvent: (event: string, properties?: Record<string, unknown>) =>
    request<null>("POST", "/api/analytics/event", { event, properties }),

  // ---- Procore Trust Engine ----

  /** GET /api/procore/config */
  getProcoreConfig: () =>
    request<{ configured: boolean }>("GET", "/api/procore/config"),

  /** GET /api/procore/connections */
  getProcoreConnections: () =>
    request<{ connections: ProcoreConnection[] }>("GET", "/api/procore/connections"),

  /** GET /api/procore/auth/start */
  startProcoreAuth: () =>
    request<{ authUrl: string }>("GET", "/api/procore/auth/start"),

  /** GET /api/procore/companies?connection= */
  getProcoreCompanies: (connectionId: string) =>
    request<{ companies: ProcoreCompany[] }>("GET", `/api/procore/companies?connection=${encodeURIComponent(connectionId)}`),

  /** POST /api/procore/select-company */
  selectProcoreCompany: (connectionId: string, companyId: string, companyName: string) =>
    request<{ success: boolean; connectionId: string }>("POST", "/api/procore/select-company", { connectionId, companyId, companyName }),

  /** POST /api/procore/sync */
  syncProcoreProjects: (connectionId: string) =>
    request<{ success: boolean; syncedProjects: number }>("POST", "/api/procore/sync", { connectionId }),

  /** GET /api/procore/projects?connection= */
  getProcoreProjects: (connectionId: string) =>
    request<{ projects: ProcoreProject[] }>("GET", `/api/procore/projects?connection=${encodeURIComponent(connectionId)}`),

  /** POST /api/procore/shadow-estimates */
  runShadowEstimates: (connectionId: string) =>
    request<{ success: boolean; processed: number; errors: number }>("POST", "/api/procore/shadow-estimates", { connectionId }),

  /** POST /api/procore/calculate-metrics */
  calculateProcoreMetrics: (connectionId: string) =>
    request<{ success: boolean; metrics: ProcoreMetrics }>("POST", "/api/procore/calculate-metrics", { connectionId }),

  /** GET /api/procore/metrics?connection= */
  getProcoreMetrics: (connectionId: string) =>
    request<{ metrics: ProcoreMetrics }>("GET", `/api/procore/metrics?connection=${encodeURIComponent(connectionId)}`),

  /** GET /api/procore/all-projects — all projects (not just closed) */
  getAllProcoreProjects: () =>
    request<Array<{ id: number; name: string; project_number: string; status: string; address: string; city: string; state_code: string }>>("GET", "/api/procore/all-projects"),

  /** POST /api/procore/push-estimate — push estimate to Procore */
  pushEstimateToProcore: (estimateId: string, opts: { createNew: boolean; procoreProjectId?: string }) =>
    request<{ pushId: string; procoreProjectId: number; procoreProjectUrl: string; projectName: string; budgetItemsPushed: number; pdfUploaded: number; totalLineItems: number }>(
      "POST", "/api/procore/push-estimate", { estimateId, ...opts }
    ),

  /** GET /api/procore/push-status/:estimateId — check if estimate was pushed */
  getProcorePushStatus: (estimateId: string) =>
    request<{ id: string; procoreProjectUrl: string; projectName: string; budgetItemsPushed: number; pdfUploaded: number; status: string; createdAt: number } | null>("GET", `/api/procore/push-status/${estimateId}`),

  /** POST /api/procore/disconnect */
  disconnectProcore: (connectionId: string) =>
    request<{ success: boolean }>("POST", "/api/procore/disconnect", { connectionId }),

  /** PATCH /api/procore/connections/:connectionId/benchmark-consent */
  updateBenchmarkConsent: (connectionId: string, include: boolean) =>
    request<{ connectionId: string; includeInPublicBenchmarks: boolean }>(
      "PATCH",
      `/api/procore/connections/${connectionId}/benchmark-consent`,
      { includeInPublicBenchmarks: include }
    ),

  // ---- Team ----

  /** GET /api/team */
  getTeam: () =>
    request<TeamData>("GET", "/api/team"),

  /** POST /api/team/invite */
  inviteTeamMember: (email: string) =>
    request<{ inviteCode: string; expiresAt: number }>("POST", "/api/team/invite", { email }),

  /** POST /api/team/accept */
  acceptTeamInvite: (code: string) =>
    request<null>("POST", "/api/team/accept", { code }),

  /** DELETE /api/team/members/:memberId */
  removeTeamMember: (memberId: string) =>
    request<null>("DELETE", `/api/team/members/${memberId}`),

  /** DELETE /api/team/invites/:inviteId */
  cancelTeamInvite: (inviteId: string) =>
    request<null>("DELETE", `/api/team/invites/${inviteId}`),

  /** POST /api/team/rename */
  renameTeam: (name: string) =>
    request<null>("POST", "/api/team/rename", { name }),

  // ---- Social content ----

  /** POST /api/social/generate */
  generateSocialPosts: (opts: { trade: string; city?: string }) =>
    request<{ posts: SocialPost[] }>("POST", "/api/social/generate", opts),

  // ---- Reviews ----

  getReviews: () =>
    request<{ reviews: ReviewData[]; aggregate: { avgRating: number; totalCount: number } }>("GET", "/api/reviews"),

  getMyReview: () =>
    request<{ id: number; rating: number; comment: string | null; approved: boolean; createdAt: number } | null>("GET", "/api/reviews/mine"),

  submitReview: (data: { rating: number; comment?: string; userName?: string; userTrade?: string }) =>
    request<{ id: number }>("POST", "/api/reviews", data),

  getPipelineStages: () => request<{ stages: unknown[] }>("GET", "/api/pipeline/stages"),
  getPipelineDeals: () => request<{ deals: unknown[] }>("GET", "/api/pipeline/deals"),
  getPipelineAnalytics: () => request<unknown>("GET", "/api/pipeline/analytics"),
  createPipelineDeal: (data: Record<string, unknown>) => request<{ deal: unknown }>("POST", "/api/pipeline/deals", data),
  updatePipelineDeal: (id: string, data: Record<string, unknown>) => request<{ deal: unknown }>("PATCH", `/api/pipeline/deals/${id}`, data),
  deletePipelineDeal: (id: string) => request<null>("DELETE", `/api/pipeline/deals/${id}`),
  getDealActivities: (dealId: string) => request<{ activities: unknown[] }>("GET", `/api/pipeline/deals/${dealId}/activities`),
  addDealActivity: (dealId: string, data: { type: string; description: string }) => request<{ activity: unknown }>("POST", `/api/pipeline/deals/${dealId}/activities`, data),
  getDealAttachments: (dealId: string) => request<{ attachments: unknown[] }>("GET", `/api/pipeline/deals/${dealId}/attachments`),
  uploadDealAttachment: (dealId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ attachment: unknown }>("POST", `/api/pipeline/deals/${dealId}/attachments`, fd, true);
  },
  deleteDealAttachment: (attachmentId: string) => request<null>("DELETE", `/api/pipeline/attachments/${attachmentId}`),
  convertDealToEstimate: (dealId: string) => request<{ estimateId: string }>("POST", `/api/pipeline/deals/${dealId}/convert-to-estimate`),
  resetCanonicalStages: () => request<{ stages: unknown[] }>("POST", "/api/pipeline/stages/reset-canonical"),

  getAutomations: () => request<{ rules: unknown[] }>("GET", "/api/automations"),
  getAutomationStats: () => request<unknown>("GET", "/api/automations/stats"),
  createAutomation: (data: Record<string, unknown>) => request<{ rule: unknown }>("POST", "/api/automations", data),
  updateAutomation: (id: number, data: Record<string, unknown>) => request<{ rule: unknown }>("PATCH", `/api/automations/${id}`, data),
  deleteAutomation: (id: number) => request<null>("DELETE", `/api/automations/${id}`),
  getAutomationRuns: (ruleId: number) => request<{ runs: unknown[] }>("GET", `/api/automations/${ruleId}/runs`),
};

// ---- Type definitions ----

export interface SavedLineItemPreset {
  id: string;
  description: string;
  quantity: number;
  unitCost: number;
  uom: string | null;
  costType: string | null;
  tag: string | null;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface EstimateLineItem {
  id?: string;
  description: string;
  quantity: number;
  unitCost: number;
  uom?: string | null;
  costType?: string | null;
  lineTotal: number;
  sortOrder?: number;
}

export interface EstimateTotals {
  subtotal: number;
  total: number;
  byCostType: Record<string, number>;
  itemCount: number;
}

export interface Estimate {
  id: string;
  jobType: string;
  market: string;
  details?: string;
  estimateText: string;
  name?: string | null;
  source?: string | null;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  createdAt: number;
  lineItems?: EstimateLineItem[];
  totals?: EstimateTotals | null;
  wonLostStatus?: string | null;
  wonLostUpdatedAt?: number | null;
}

export interface SendEstimateRequest {
  name: string;
  source?: string;
  jobType?: string;
  market?: string;
  details?: string;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitCost: number;
    uom?: string;
    costType?: string;
  }>;
}

export interface SendEstimateResponse {
  estimateId: string;
  name: string;
  source: string | null;
  lineItems: EstimateLineItem[];
  totals: EstimateTotals;
  createdAt: number;
}

export interface EstimateResult {
  estimateId: string;
  text: string;
  materials?: number;
  labor?: number;
  total?: number;
  breakdown?: string;
  tier: string;
  estimatesRemaining?: number | null;
}

export interface BillingStatus {
  plan: "free" | "pro" | "business" | "lifetime";
  status: string;
  currentPeriodEnd?: number;
  priceId?: string;
  interval?: "monthly" | "annual";
}

export interface Entitlements {
  plan: "free" | "pro" | "business" | "lifetime";
  procore: boolean;
  teams: boolean;
  unlimited_estimates: boolean;
  api_access: boolean;
  custom_branding: boolean;
  analytics_dashboard: boolean;
  priority_support: boolean;
}

export interface AffiliateData {
  code: string;
  link: string;
  clicks: number;
  conversions: number;
  earnings: number;
  rank?: number;
}

export interface ReferralEntry {
  id: number;
  referredEmail: string;
  status: string;
  createdAt: string;
}

export interface ProcoreConnection {
  id: string;
  procoreCompanyId: string;
  companyName: string | null;
  status: string;
  lastSyncAt: number | null;
  createdAt: number;
  includeInPublicBenchmarks: number;
}

export interface ProcoreCompany {
  id: number;
  name: string;
  is_active: boolean;
}

export interface ProcoreProject {
  id: string;
  name: string;
  city: string;
  state: string;
  status: string;
  originalEstimateUsd: number | null;
  actualCostUsd: number | null;
  changeOrderCount: number;
  closeDate: string | null;
  isClosed: number;
}

export interface ProcoreMetricEntry {
  value: number;
  sampleSize: number;
  metadata: Record<string, number> | null;
  calculatedAt: number;
}

export interface ProcoreMetrics {
  accuracy_error_pct?: ProcoreMetricEntry;
  confidence_calibration?: ProcoreMetricEntry;
  time_saved_hours?: ProcoreMetricEntry;
  margin_delta?: ProcoreMetricEntry;
  change_order_rate?: ProcoreMetricEntry;
}

export interface TeamMember {
  id: string;
  userId: string;
  role: string;
  joinedAt: number;
  email: string;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  email: string;
  inviteCode: string;
  createdAt: number;
  expiresAt: number;
}

export interface TeamData {
  hasTeam: boolean;
  reason?: string;
  team?: { id: string; name: string; ownerUserId: string; createdAt: number };
  members?: TeamMember[];
  invites?: TeamInvite[];
}

export interface SocialPost {
  platform: string;
  title?: string;
  body: string;
  tip: string;
}

export interface ReviewData {
  id: number;
  userName: string | null;
  userTrade: string | null;
  rating: number;
  comment: string | null;
  createdAt: number;
}
