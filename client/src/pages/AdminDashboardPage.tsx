import React, { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { WatchtowerThresholdPanel } from "../components/WatchtowerThresholdPanel";

const SESSION_KEY = "probid_admin_key";

interface SubsystemInfo {
  status: "ok" | "degraded" | "error" | "paused";
  detail?: string;
  lastRun?: { startedAt: number; status: string; items: number } | null;
}

interface SystemStatus {
  timestamp: string;
  uptime: number;
  environment: string;
  database: string;
  subsystems: {
    database: SubsystemInfo;
    scraper: SubsystemInfo;
    outreach: SubsystemInfo;
    emailDrip: SubsystemInfo;
    sms: SubsystemInfo;
    billing: SubsystemInfo;
  };
  metrics: {
    today: { signups: number; estimates: number; emailsSent: number; emailsFailed: number; leadsScraped: number };
    totals: {
      users: number;
      subscribers: number;
      outreachQueuePending: number;
      dripEmailsPending: number;
      homepageLeadsTotal: number;
      // Multi-channel lead metrics (Task #141 — never lose a lead due to missing email)
      leadsTotal?: number;
      leadsWithPhone?: number;
      leadsWithEmail?: number;
      leadsNoEmailButContactable?: number;
      leadsWebsiteOutreachPending?: number;
      leadsContacted?: number;
    };
    revenue: { mrr: number; arr: number; proSubscribers: number; businessSubscribers: number };
  };
  recentJobRuns: Array<{
    id: number;
    jobName: string;
    startedAt: number;
    finishedAt: number | null;
    status: string;
    itemsProcessed: number;
    successCount: number;
    failureCount: number;
    errorSummary: string | null;
  }>;
}

interface FunnelData {
  period: string;
  steps: Array<{ name: string; today_count: number; total_count: number }>;
  rates: Record<string, string>;
  pdfDownloads: { today: number; total30d: number };
}

interface RevenueData {
  subscribers: { free: number; pro: number; business: number; total: number };
  mrr: number;
  arr: number;
  oneTimeRevenue: { lifetime: number; singleEstimate: number };
  recentSignups: Array<{ id: string; email: string; createdAt: number; plan: string; subStatus: string }>;
}

type TabId = "overview" | "funnel" | "revenue" | "sdk" | "partners" | "growth" | "sellability" | "retention" | "guarantees";

interface GuaranteeClaim {
  id: string;
  user_id: string;
  user_email: string;
  guarantee_type: string;
  status: string;
  eligibility_verdict: string;
  resolution: string | null;
  stripe_refund_id: string | null;
  account_credit_cents: number;
  suspicious_flags: string | null;
  admin_override_note: string | null;
  admin_override_by: string | null;
  ip_address: string | null;
  user_agent: string | null;
  requested_at: number;
  resolved_at: number | null;
}

interface GuaranteeDashboard {
  claimStats: Array<{ guarantee_type: string; status: string; count: string; total_credit_cents: string }>;
  abStats: Array<{
    variant: string;
    assigned: number;
    conversions: number;
    paidConversions: number;
    conversionRate: number;
    paidConversionRate: number;
    claimCount: number;
    claimRate: number;
    costPerUserCents: number;
  }>;
  recentClaims: GuaranteeClaim[];
  totals: {
    netFinancialImpactCents: number;
    netFinancialImpactDollars: string;
    stripeRefundCents: number;
    stripeRefundDollars: string;
    balanceCreditCents: number;
    balanceCreditDollars: string;
    stripeRefundCount: number;
  };
}

interface ClaimDetailResponse {
  claim: GuaranteeClaim & { user_created_at: number; eligibility_reasons?: string[] };
  auditTrail: Array<{ id: string; from_status: string; to_status: string; actor: string; note: string | null; metadata: unknown; created_at: number }>;
  context: { otherClaims: Array<{ id: string; guarantee_type: string; status: string; requested_at: number }>; estimateCount: number };
}

async function fetchClaimDetail(adminKey: string, claimId: string): Promise<ClaimDetailResponse> {
  const res = await fetch(`/api/admin/guarantees/claims/${claimId}`, { headers: { "x-admin-key": adminKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await safeJson(res);
  if (body.error) throw new Error(String(body.error));
  return (body as { data: ClaimDetailResponse }).data;
}

async function fetchGuaranteeClaims(adminKey: string, page: number, status: string, type: string) {
  const params = new URLSearchParams({ page: String(page + 1) });
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  const res = await fetch(`/api/admin/guarantees/claims?${params}`, { headers: { "x-admin-key": adminKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await safeJson(res);
  if (body.error) throw new Error(String(body.error));
  return (body as { data: { claims: GuaranteeClaim[]; total: number; page: number; pages: number } }).data;
}

async function fetchGuaranteeDashboard(adminKey: string) {
  const res = await fetch("/api/admin/guarantees/dashboard", { headers: { "x-admin-key": adminKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await safeJson(res);
  if (body.error) throw new Error(String(body.error));
  return (body as { data: GuaranteeDashboard }).data;
}

interface CohortRow {
  cohortStart: string;
  cohortSize: number;
  retainedD7: number | null;
  retainedD30: number | null;
  retainedD60: number | null;
  retainedD90: number | null;
  retainedD180: number | null;
  dataQuality: "complete" | "partial";
}

interface HeadlineStat {
  weighted90DayRetentionPct: number | null;
  customersRetainedAt90Days: number;
  customersEligibleAt90Days: number;
  notEnoughData: boolean;
  proxySourceCount: number;
}

interface RetentionData {
  granularity: "weekly" | "monthly";
  lookback: number;
  cohorts: CohortRow[];
  headline: HeadlineStat;
  generatedAt: string;
}

interface GrowthHealthSubsystem {
  key: string;
  label: string;
  description: string;
  status: "green" | "yellow" | "red" | "unknown" | "paused";
  reasons: string[];
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  throughput24h: number;
  failureCount24h: number;
  failureRate24h: number | null;
  latestError: string | null;
  drilldownPath?: string;
  meta?: Record<string, unknown>;
}

interface GrowthHealthData {
  generatedAt: number;
  overall: "green" | "yellow" | "red" | "unknown" | "paused";
  subsystems: GrowthHealthSubsystem[];
  rules?: Array<{
    key: string;
    label: string;
    staleAfterMinutes: { yellow: number; red: number };
  }>;
}

interface SellabilityRubricFactor {
  score: number;
  maxScore: number;
  label: string;
  notes: string;
}

interface SellabilityData {
  generatedAt: string;
  valuation: {
    low: number;
    mid: number;
    high: number;
    arr: number;
    mrr: number;
    multiplesUsed: { low: number; mid: number; high: number };
    note: string;
  };
  coreSaasMetrics: {
    mrr: number;
    arr: number;
    payingCustomers: number;
    payingCustomerBreakdown: { proMonthly: number; proAnnual: number; bizMonthly: number; bizAnnual: number };
    mrrGrowth: {
      momPct: number | null;
      trailing3MoPct: number | null;
      trailing6MoPct: number | null;
      mrrAtMonthStart: number;
      mrrAt3MoAgo: number;
      mrrAt6MoAgo: number;
      note: string;
    };
    netNewMrrThisMonth: number;
    churnedMrrThisMonth: number;
    churnedMrrLastMonth: number;
    logoChurn: { last30DaysPct: number; last90DaysPct: number; canceled30: number; canceled90: number };
    revChurn: { last30DaysPct: number; last90DaysPct: number };
    arpu: number;
    ltv: number;
    churnNote: string;
  };
  costAndMargin: {
    aiCostPerEstimate: number;
    estimatesThisMonth: number;
    estimatesLastMonth: number;
    aiCostThisMonth: number;
    emailVolumeThisMonth: number;
    estimatedGrossMarginPct: number;
    note: string;
  };
  riskFlags: {
    customerConcentration: { top1Pct: number; top3Pct: number; top5Pct: number; totalPayingCustomers: number };
    vendorConcentration: { aiProvider: string; pct: number };
    openSystemAlerts: number;
    failedJobRuns: { last7Days: number; byJob: Array<{ jobName: string; count: number }> };
    hasBounceWebhook: boolean;
  };
  sellabilityScore: {
    total: number;
    maxTotal: number;
    grade: string;
    rubric: Record<string, SellabilityRubricFactor>;
  };
}

async function safeJson(res: Response): Promise<{ error?: string; [key: string]: unknown }> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status})`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error("Server returned an invalid JSON response.");
  }
}

function statusColor(s: string) {
  if (s === "ok" || s === "completed") return "#22c55e";
  if (s === "degraded" || s === "paused") return "#f59e0b";
  if (s === "error" || s === "failed") return "#ef4444";
  if (s === "running") return "#3b82f6";
  return "#6b7280";
}

function statusBg(s: string) {
  if (s === "ok" || s === "completed") return "rgba(34,197,94,0.12)";
  if (s === "degraded" || s === "paused") return "rgba(245,158,11,0.12)";
  if (s === "error" || s === "failed") return "rgba(239,68,68,0.12)";
  if (s === "running") return "rgba(59,130,246,0.12)";
  return "rgba(107,114,128,0.12)";
}

function Badge({ status }: { status: string }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 99,
      fontSize: 12,
      fontWeight: 600,
      color: statusColor(status),
      background: statusBg(status),
      textTransform: "uppercase",
      letterSpacing: "0.04em",
    }}>
      {status}
    </span>
  );
}

function fmtTime(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function fmtUptime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      background: "#1a1f2e",
      borderRadius: 12,
      padding: "18px 22px",
      flex: "1 1 140px",
      minWidth: 120,
    }}>
      <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "#f9fafb", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function SubsystemCard({ name, info }: { name: string; info: SubsystemInfo }) {
  return (
    <div style={{
      background: "#1a1f2e",
      borderRadius: 12,
      padding: "16px 18px",
      flex: "1 1 200px",
      minWidth: 180,
      borderLeft: `3px solid ${statusColor(info.status)}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, color: "#e5e7eb", fontSize: 14 }}>{name}</span>
        <Badge status={info.status} />
      </div>
      {info.detail && <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: info.lastRun !== undefined ? 6 : 0 }}>{info.detail}</div>}
      {info.lastRun && (
        <div style={{ fontSize: 11, color: "#6b7280" }}>
          Last: {fmtTime(info.lastRun.startedAt)} · {info.lastRun.status} · {info.lastRun.items} items
        </div>
      )}
      {info.lastRun === null && (
        <div style={{ fontSize: 11, color: "#6b7280" }}>No runs recorded yet</div>
      )}
    </div>
  );
}

async function fetchSystemStatus(adminKey: string): Promise<SystemStatus> {
  const res = await fetch("/api/admin/system-status", {
    headers: { "x-admin-key": adminKey },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Invalid admin key");
  }
  const data = await safeJson(res);
  if (data.error) throw new Error(data.error);
  return data as unknown as SystemStatus;
}

async function fetchFunnel(adminKey: string): Promise<FunnelData> {
  const res = await fetch("/api/admin/funnel", { headers: { "x-admin-key": adminKey } });
  if (res.status === 401 || res.status === 403) throw new Error("Invalid admin key");
  const data = await safeJson(res);
  if (data.error) throw new Error(data.error);
  return data as unknown as FunnelData;
}

async function fetchRevenue(adminKey: string): Promise<RevenueData> {
  const res = await fetch("/api/admin/revenue", { headers: { "x-admin-key": adminKey } });
  if (res.status === 401 || res.status === 403) throw new Error("Invalid admin key");
  const data = await safeJson(res);
  if (data.error) throw new Error(data.error);
  return data as unknown as RevenueData;
}

export default function AdminDashboardPage() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem(SESSION_KEY) || "");
  const [inputKey, setInputKey] = useState("");
  const [triggerResults, setTriggerResults] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const qc = useQueryClient();

  const { data: status, isFetching, error, dataUpdatedAt } = useQuery<SystemStatus, Error>({
    queryKey: ["admin-system-status", adminKey],
    queryFn: () => fetchSystemStatus(adminKey),
    enabled: !!adminKey,
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 1,
  });

  const { data: funnel, isFetching: funnelFetching, error: funnelError } = useQuery<FunnelData, Error>({
    queryKey: ["admin-funnel", adminKey],
    queryFn: () => fetchFunnel(adminKey),
    enabled: !!adminKey && activeTab === "funnel",
    staleTime: 60_000,
    retry: 1,
  });

  const { data: revenue, isFetching: revenueFetching, error: revenueError } = useQuery<RevenueData, Error>({
    queryKey: ["admin-revenue", adminKey],
    queryFn: () => fetchRevenue(adminKey),
    enabled: !!adminKey && activeTab === "revenue",
    staleTime: 60_000,
    retry: 1,
  });

  type SdkAllowlistEntry = {
    id: number;
    origin: string;
    kind: "exact" | "wildcard";
    note: string | null;
    createdAt: number;
    createdBy: string | null;
    revokedAt: number | null;
    revokedBy: string | null;
  };
  type SdkAllowlistData = {
    envEntries: Array<{ origin: string; kind: "exact" | "wildcard" }>;
    dbEntries: SdkAllowlistEntry[];
  };

  const { data: sdkData, isFetching: sdkFetching, error: sdkError } = useQuery<SdkAllowlistData, Error>({
    queryKey: ["admin-sdk-allowlist", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/sdk-allowlist", {
        headers: { "x-admin-key": adminKey },
      });
      if (res.status === 401 || res.status === 403) throw new Error("Invalid admin key");
      const body = await safeJson(res);
      if (body.error) throw new Error(String(body.error));
      const dataField = (body as { data?: SdkAllowlistData }).data;
      if (!dataField) throw new Error("Malformed response");
      return dataField;
    },
    enabled: !!adminKey && activeTab === "sdk",
    staleTime: 30_000,
    retry: 1,
  });

  const [sdkOriginInput, setSdkOriginInput] = useState("");
  const [sdkNoteInput, setSdkNoteInput] = useState("");
  const [sdkActionMsg, setSdkActionMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const sdkAddMutation = useMutation({
    mutationFn: async ({ origin, note }: { origin: string; note: string }) => {
      const res = await fetch("/api/admin/sdk-allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ origin, note: note || undefined }),
      });
      const body = await safeJson(res);
      if (!res.ok) throw new Error(String(body.error || `HTTP ${res.status}`));
      return body;
    },
    onSuccess: () => {
      setSdkOriginInput("");
      setSdkNoteInput("");
      setSdkActionMsg({ type: "ok", text: "Origin added" });
      qc.invalidateQueries({ queryKey: ["admin-sdk-allowlist", adminKey] });
    },
    onError: (err) => setSdkActionMsg({ type: "err", text: String(err.message ?? err) }),
  });

  const sdkRevokeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/admin/sdk-allowlist/${id}`, {
        method: "DELETE",
        headers: { "x-admin-key": adminKey },
      });
      const body = await safeJson(res);
      if (!res.ok) throw new Error(String(body.error || `HTTP ${res.status}`));
      return body;
    },
    onSuccess: () => {
      setSdkActionMsg({ type: "ok", text: "Origin revoked" });
      qc.invalidateQueries({ queryKey: ["admin-sdk-allowlist", adminKey] });
    },
    onError: (err) => setSdkActionMsg({ type: "err", text: String(err.message ?? err) }),
  });

  type PartnerRow = {
    id: string;
    companyName: string;
    primaryUserId: string;
    primaryEmail: string | null;
    status: "active" | "suspended";
    rateLimitOverride: number | null;
    createdAt: number;
    keyCount: number;
    thisMonth: { estimatesSdk: number; estimatesApi: number; errors: number };
  };

  type PartnersApiResponse = { data: { partners: PartnerRow[] } };

  const { data: partnersData, isFetching: partnersFetching, refetch: refetchPartners, error: partnersError } = useQuery<{ partners: PartnerRow[] }, Error>({
    queryKey: ["admin-partners", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/partners", { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await safeJson(res)) as unknown as PartnersApiResponse;
      return body.data;
    },
    enabled: !!adminKey && activeTab === "partners",
    staleTime: 30_000,
    retry: 1,
  });

  const { data: growthHealth, isFetching: growthFetching, refetch: refetchGrowth, error: growthError } = useQuery<GrowthHealthData, Error>({
    queryKey: ["admin-growth-health", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/growth-health", { headers: { "x-admin-key": adminKey } });
      if (res.status === 401 || res.status === 403) throw new Error("Invalid admin key");
      const body = await safeJson(res);
      if (body.error) throw new Error(String(body.error));
      const dataField = (body as { data?: GrowthHealthData }).data;
      if (!dataField) throw new Error("Malformed response");
      return dataField;
    },
    enabled: !!adminKey && activeTab === "growth",
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: 1,
  });

  const { data: sellability, isFetching: sellabilityFetching, error: sellabilityError, refetch: refetchSellability } = useQuery<SellabilityData, Error>({
    queryKey: ["admin-sellability", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/sellability", { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await safeJson(res);
      if (body.error) throw new Error(String(body.error));
      return (body as { data: SellabilityData }).data;
    },
    enabled: !!adminKey && activeTab === "sellability",
    staleTime: 60_000,
    retry: 1,
  });

  const [retentionGranularity, setRetentionGranularity] = useState<"weekly" | "monthly">("weekly");
  const [retentionLookback, setRetentionLookback] = useState<12 | 26 | 52>(12);

  const { data: retention, isFetching: retentionFetching, error: retentionError } = useQuery<RetentionData, Error>({
    queryKey: ["admin-retention", adminKey, retentionGranularity, retentionLookback],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/retention/cohorts?granularity=${retentionGranularity}&lookback=${retentionLookback}`,
        { headers: { "x-admin-key": adminKey } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await safeJson(res);
      if (body.error) throw new Error(String(body.error));
      return (body as { data: RetentionData }).data;
    },
    enabled: !!adminKey && activeTab === "retention",
    staleTime: 60_000,
    retry: 1,
  });

  // ── Guarantees tab state ──
  const [guaranteesStatusFilter, setGuaranteesStatusFilter] = useState("");
  const [guaranteesTypeFilter, setGuaranteesTypeFilter] = useState("");
  const [guaranteesPage, setGuaranteesPage] = useState(0);
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);
  const [claimActionNote, setClaimActionNote] = useState<Record<string, string>>({});

  const { data: guaranteesDash, isFetching: guaranteesDashFetching, refetch: refetchGuaranteesDash } = useQuery<GuaranteeDashboard, Error>({
    queryKey: ["admin-guarantees-dashboard", adminKey],
    queryFn: () => fetchGuaranteeDashboard(adminKey),
    enabled: !!adminKey && activeTab === "guarantees",
    staleTime: 30_000,
  });

  const { data: claimsData, isFetching: claimsFetching, refetch: refetchClaims } = useQuery<{ claims: GuaranteeClaim[]; total: number; page: number; pages: number }, Error>({
    queryKey: ["admin-guarantees-claims", adminKey, guaranteesPage, guaranteesStatusFilter, guaranteesTypeFilter],
    queryFn: () => fetchGuaranteeClaims(adminKey, guaranteesPage, guaranteesStatusFilter, guaranteesTypeFilter),
    enabled: !!adminKey && activeTab === "guarantees",
    staleTime: 15_000,
  });

  // Derived pagination flag — server returns page (1-indexed) and pages (total)
  const guaranteesIsLastPage =
    claimsData != null && claimsData.page >= claimsData.pages;

  const approveClaimMut = useMutation({
    mutationFn: async ({ claimId, note }: { claimId: string; note: string }) => {
      const res = await fetch(`/api/admin/guarantees/claims/${claimId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ note }),
      });
      const body = await safeJson(res);
      if (body.error) throw new Error(String(body.error));
      return body;
    },
    onSuccess: () => { refetchClaims(); refetchGuaranteesDash(); },
  });

  const denyClaimMut = useMutation({
    mutationFn: async ({ claimId, note }: { claimId: string; note: string }) => {
      const res = await fetch(`/api/admin/guarantees/claims/${claimId}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ note }),
      });
      const body = await safeJson(res);
      if (body.error) throw new Error(String(body.error));
      return body;
    },
    onSuccess: () => { refetchClaims(); refetchGuaranteesDash(); },
  });

  // Lazy-fetch full claim detail (audit trail + context) when a row is expanded
  const { data: claimDetail, isFetching: claimDetailFetching } = useQuery<ClaimDetailResponse, Error>({
    queryKey: ["admin-guarantee-claim-detail", adminKey, expandedClaim],
    queryFn: () => fetchClaimDetail(adminKey, expandedClaim!),
    enabled: !!adminKey && !!expandedClaim && activeTab === "guarantees",
    staleTime: 60_000,
  });

  const [aiCostInput, setAiCostInput] = useState<string>("");
  const [aiCostMsg, setAiCostMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  type LifetimeCapData = {
    purchased: number;
    cap: number;
    remaining: number;
    soldOut: boolean;
    totalRevenueDollars: number;
    arrOpportunityCostDollars: number;
  };

  const { data: lifetimeCap, refetch: refetchLifetimeCap } = useQuery<LifetimeCapData, Error>({
    queryKey: ["admin-lifetime-cap", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/lifetime-cap", { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await safeJson(res);
      if (body.error) throw new Error(String(body.error));
      return (body as { data: LifetimeCapData }).data;
    },
    enabled: !!adminKey && activeTab === "sellability",
    staleTime: 30_000,
    retry: 1,
  });

  const [lifetimeCapInput, setLifetimeCapInput] = useState<string>("");
  const [lifetimeCapMsg, setLifetimeCapMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const updateLifetimeCapMutation = useMutation({
    mutationFn: async (cap: number) => {
      const res = await fetch("/api/admin/lifetime-cap", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ cap }),
      });
      const body = await safeJson(res);
      if (!res.ok) throw new Error(String(body.error || `HTTP ${res.status}`));
      return body;
    },
    onSuccess: () => {
      setLifetimeCapMsg({ type: "ok", text: "Saved" });
      setLifetimeCapInput("");
      refetchLifetimeCap();
    },
    onError: (err) => setLifetimeCapMsg({ type: "err", text: String((err as Error).message ?? err) }),
  });

  const updateAiCostMutation = useMutation({
    mutationFn: async (cost: number) => {
      const res = await fetch("/api/admin/sellability/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ aiCostPerEstimate: cost }),
      });
      const body = await safeJson(res);
      if (!res.ok) throw new Error(String(body.error || `HTTP ${res.status}`));
      return body;
    },
    onSuccess: () => {
      setAiCostMsg({ type: "ok", text: "Saved" });
      refetchSellability();
    },
    onError: (err) => setAiCostMsg({ type: "err", text: String(err.message ?? err) }),
  });


  const [newPartnerUserId, setNewPartnerUserId] = useState("");
  const [newPartnerCompany, setNewPartnerCompany] = useState("");
  const [newPartnerRateLimit, setNewPartnerRateLimit] = useState("");
  const [partnerMsg, setPartnerMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [editingRateLimit, setEditingRateLimit] = useState<{ id: string; value: string } | null>(null);
  const [expandedPartnerId, setExpandedPartnerId] = useState<string | null>(null);

  type PartnerDetailKey = { id: string; name: string; keyPrefix: string; scopes: string; rateLimit: number; requestCount: number | null; lastUsedAt: number | null; revokedAt: number | null; createdAt: number };
  type PartnerDetailOrigin = { id: number; origin: string; kind: string; note: string | null; revokedAt: number | null };
  type PartnerDetailUsage = { dayKey: string; estimatesSdk: number; estimatesApi: number; errors: number };
  type PartnerDetail = { keys: PartnerDetailKey[]; origins: PartnerDetailOrigin[]; recentUsage: PartnerDetailUsage[] };
  type PartnerDetailApiResponse = { data: { partner: PartnerRow & { primaryEmail: string | null }; keys: PartnerDetailKey[]; origins: PartnerDetailOrigin[]; recentUsage: PartnerDetailUsage[] } };

  const { data: partnerDetail, isFetching: partnerDetailFetching } = useQuery<PartnerDetail, Error>({
    queryKey: ["admin-partner-detail", adminKey, expandedPartnerId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/partners/${expandedPartnerId}`, { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await safeJson(res)) as unknown as PartnerDetailApiResponse;
      return { keys: body.data.keys, origins: body.data.origins, recentUsage: body.data.recentUsage };
    },
    enabled: !!adminKey && !!expandedPartnerId,
    staleTime: 15_000,
  });

  const createPartnerMutation = useMutation({
    mutationFn: async ({ userId, companyName, rateLimitOverride }: { userId: string; companyName: string; rateLimitOverride?: number }) => {
      const res = await fetch("/api/admin/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ userId, companyName, rateLimitOverride }),
      });
      const body = await safeJson(res);
      if (!res.ok) throw new Error(String(body.error || `HTTP ${res.status}`));
      return body;
    },
    onSuccess: () => {
      setNewPartnerUserId("");
      setNewPartnerCompany("");
      setNewPartnerRateLimit("");
      setPartnerMsg({ type: "ok", text: "Partner created" });
      refetchPartners();
    },
    onError: (err) => setPartnerMsg({ type: "err", text: String(err.message ?? err) }),
  });

  const updatePartnerMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const res = await fetch(`/api/admin/partners/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify(patch),
      });
      const body = await safeJson(res);
      if (!res.ok) throw new Error(String(body.error || `HTTP ${res.status}`));
      return body;
    },
    onSuccess: () => refetchPartners(),
    onError: (err) => alert(String(err.message ?? err)),
  });

  const saveKey = useCallback(() => {
    const k = inputKey.trim();
    if (k) {
      sessionStorage.setItem(SESSION_KEY, k);
      setAdminKey(k);
    }
  }, [inputKey]);

  const triggerMutation = useMutation({
    mutationFn: async ({ path, method }: { path: string; method: "GET" | "POST"; jobKey: string }) => {
      const res = await fetch(path, {
        method,
        headers: { "x-cron-key": adminKey, "x-admin-key": adminKey },
      });
      const data = await safeJson(res);
      return data;
    },
    onSuccess: (data, vars) => {
      setTriggerResults(prev => ({ ...prev, [vars.jobKey]: JSON.stringify(data.data ?? data, null, 2) }));
      qc.invalidateQueries({ queryKey: ["admin-system-status", adminKey] });
    },
    onError: (err, vars) => {
      setTriggerResults(prev => ({ ...prev, [vars.jobKey]: String(err) }));
    },
  });

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0f1117",
    color: "#f9fafb",
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: "32px 24px",
    maxWidth: 1100,
    margin: "0 auto",
  };

  const keyModal = !adminKey ? (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: "#1a1f2e", borderRadius: 14, padding: "36px 32px", width: "100%", maxWidth: 420,
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)", border: "1px solid #374151",
      }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", margin: "0 0 6px" }}>ProBid Admin</h2>
        <p style={{ color: "#9ca3af", marginBottom: 22, fontSize: 14 }}>Enter your admin key to access the ops dashboard.</p>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            autoFocus
            type="password"
            value={inputKey}
            onChange={e => setInputKey(e.target.value)}
            onKeyDown={e => e.key === "Enter" && saveKey()}
            placeholder="Admin key"
            style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid #374151",
              background: "#0f1117", color: "#f9fafb", fontSize: 14, outline: "none",
            }}
          />
          <button
            onClick={saveKey}
            style={{
              padding: "10px 20px", borderRadius: 8, background: "#22c55e",
              color: "#fff", fontWeight: 600, border: "none", cursor: "pointer", fontSize: 14,
            }}
          >
            Access
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const tabStyle = (id: TabId): React.CSSProperties => ({
    padding: "8px 18px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    background: activeTab === id ? "#22c55e" : "#1a1f2e",
    color: activeTab === id ? "#fff" : "#9ca3af",
    transition: "background 0.15s, color 0.15s",
  });

  return (
    <div style={containerStyle}>
      {keyModal}
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f9fafb", margin: 0 }}>ProBid Ops Dashboard</h1>
          {dataUpdatedAt > 0 && (
            <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
              Last refreshed {new Date(dataUpdatedAt).toLocaleTimeString()} · auto-polls every 30s
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ["admin-system-status", adminKey] })}
            disabled={isFetching}
            style={{
              padding: "8px 16px", borderRadius: 8, background: "#1a1f2e",
              color: "#e5e7eb", border: "1px solid #374151", cursor: "pointer", fontSize: 13,
            }}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={() => { sessionStorage.removeItem(SESSION_KEY); setAdminKey(""); }}
            style={{
              padding: "8px 16px", borderRadius: 8, background: "#1a1f2e",
              color: "#9ca3af", border: "1px solid #374151", cursor: "pointer", fontSize: 13,
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button style={tabStyle("overview")} onClick={() => setActiveTab("overview")}>Overview</button>
        <button style={tabStyle("funnel")} onClick={() => setActiveTab("funnel")}>Funnel</button>
        <button style={tabStyle("revenue")} onClick={() => setActiveTab("revenue")}>Revenue</button>
        <button style={tabStyle("sdk")} onClick={() => setActiveTab("sdk")}>Partner SDK</button>
        <button style={tabStyle("partners")} onClick={() => setActiveTab("partners")}>Partners</button>
        <button style={tabStyle("growth")} onClick={() => setActiveTab("growth")}>Growth Health</button>
        <button style={tabStyle("sellability")} onClick={() => setActiveTab("sellability")}>Sellability</button>
        <button style={tabStyle("retention")} onClick={() => setActiveTab("retention")}>Retention</button>
        <button style={tabStyle("guarantees")} onClick={() => setActiveTab("guarantees")}>Guarantees</button>
      </div>

      {error && activeTab === "overview" && (
        <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 20, fontSize: 14 }}>
          {error.message}
        </div>
      )}

      {!status && isFetching && activeTab === "overview" && (
        <div style={{ color: "#9ca3af" }}>Loading dashboard…</div>
      )}

      {/* ── Overview Tab ── */}
      {activeTab === "overview" && status && (
        <>
          {/* System overview */}
          <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "14px 18px", marginBottom: 20, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <span style={{ fontSize: 12, color: "#6b7280" }}>Environment: </span>
              <span style={{ fontSize: 13, color: "#e5e7eb", fontWeight: 600 }}>{status.environment}</span>
            </div>
            <div>
              <span style={{ fontSize: 12, color: "#6b7280" }}>Uptime: </span>
              <span style={{ fontSize: 13, color: "#e5e7eb", fontWeight: 600 }}>{fmtUptime(status.uptime)}</span>
            </div>
            <div>
              <span style={{ fontSize: 12, color: "#6b7280" }}>Database: </span>
              <Badge status={status.database === "connected" ? "ok" : "error"} />
            </div>
          </div>

          {/* Revenue metrics */}
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12, marginTop: 0 }}>Revenue</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
            <MetricCard label="MRR" value={`$${status.metrics.revenue.mrr.toLocaleString()}`} sub={`ARR $${status.metrics.revenue.arr.toLocaleString()}`} />
            <MetricCard label="Pro" value={status.metrics.revenue.proSubscribers} sub="subscribers" />
            <MetricCard label="Business" value={status.metrics.revenue.businessSubscribers} sub="subscribers" />
            <MetricCard label="Total Users" value={status.metrics.totals.users.toLocaleString()} />
          </div>

          {/* Today's metrics */}
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Today</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
            <MetricCard label="Signups" value={status.metrics.today.signups} />
            <MetricCard label="Estimates" value={status.metrics.today.estimates} />
            <MetricCard label="Emails Sent" value={status.metrics.today.emailsSent} />
            <MetricCard label="Emails Failed" value={status.metrics.today.emailsFailed} />
            <MetricCard label="Leads Scraped" value={status.metrics.today.leadsScraped} />
          </div>

          {/* Queue metrics */}
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Queues & Leads</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
            <MetricCard label="Outreach Pending" value={status.metrics.totals.outreachQueuePending} />
            <MetricCard label="Drip Emails Pending" value={status.metrics.totals.dripEmailsPending} />
            <MetricCard label="Homepage Leads" value={status.metrics.totals.homepageLeadsTotal} sub="all-time" />
          </div>

          {/* Multi-channel lead breakdown — shows that no-email leads are kept and reachable. */}
          {status.metrics.totals.leadsTotal !== undefined && (
            <>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
                Scraped Leads (multi-channel)
              </h2>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
                <MetricCard
                  label="Total Leads"
                  value={(status.metrics.totals.leadsTotal ?? 0).toLocaleString()}
                  sub="all-time"
                />
                <MetricCard
                  label="With Phone"
                  value={(status.metrics.totals.leadsWithPhone ?? 0).toLocaleString()}
                  sub="SMS-reachable"
                />
                <MetricCard
                  label="With Email"
                  value={(status.metrics.totals.leadsWithEmail ?? 0).toLocaleString()}
                  sub="email-reachable"
                />
                <MetricCard
                  label="No Email, Contactable"
                  value={(status.metrics.totals.leadsNoEmailButContactable ?? 0).toLocaleString()}
                  sub="phone or website"
                />
                <MetricCard
                  label="Website Form Pending"
                  value={(status.metrics.totals.leadsWebsiteOutreachPending ?? 0).toLocaleString()}
                  sub="awaiting form-submit worker"
                />
                <MetricCard
                  label="Contacted"
                  value={(status.metrics.totals.leadsContacted ?? 0).toLocaleString()}
                  sub="SMS or email sent"
                />
              </div>
            </>
          )}

          {/* Subsystems */}
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Subsystems</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
            <SubsystemCard name="Database" info={status.subsystems.database} />
            <SubsystemCard name="Lead Scraper" info={status.subsystems.scraper} />
            <SubsystemCard name="Email Outreach" info={status.subsystems.outreach} />
            <SubsystemCard name="Drip Emails" info={status.subsystems.emailDrip} />
            <SubsystemCard name="SMS / Twilio" info={status.subsystems.sms} />
            <SubsystemCard name="Billing" info={status.subsystems.billing} />
          </div>

          {/* Manual triggers */}
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Manual Triggers</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
            {([
              { label: "Run Scraper", path: "/api/cron/scrape-leads", method: "POST" as const, jobKey: "scraper" },
              { label: "Process Outreach", path: "/api/cron/process-outreach", method: "POST" as const, jobKey: "outreach" },
              { label: "Process Drip Emails", path: "/api/cron/process-drip-emails", method: "POST" as const, jobKey: "drip" },
            ]).map(job => {
              const isRunning = triggerMutation.isPending && triggerMutation.variables?.jobKey === job.jobKey;
              return (
                <div key={job.jobKey} style={{ flex: "1 1 200px", minWidth: 180 }}>
                  <button
                    onClick={() => triggerMutation.mutate({ path: job.path, method: job.method, jobKey: job.jobKey })}
                    disabled={isRunning}
                    style={{
                      width: "100%", padding: "10px 16px", borderRadius: 8,
                      background: isRunning ? "#374151" : "#1e40af",
                      color: "#fff", border: "none", cursor: isRunning ? "not-allowed" : "pointer",
                      fontWeight: 600, fontSize: 13,
                    }}
                  >
                    {isRunning ? "Running…" : job.label}
                  </button>
                  {triggerResults[job.jobKey] && (
                    <pre style={{
                      marginTop: 8, fontSize: 11, color: "#9ca3af", background: "#111827",
                      borderRadius: 6, padding: "8px 10px", overflow: "auto", maxHeight: 120,
                      whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}>
                      {triggerResults[job.jobKey]}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>

          {/* Recent job runs */}
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Recent Job Runs</h2>
          {status.recentJobRuns.length === 0 ? (
            <div style={{ color: "#6b7280", fontSize: 14, marginBottom: 24 }}>No job runs recorded yet. Trigger a job above to start tracking.</div>
          ) : (
            <div style={{ overflowX: "auto", marginBottom: 24 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1f2937" }}>
                    {["ID", "Job", "Started", "Finished", "Status", "Items", "OK", "Fail", "Error"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6b7280", fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {status.recentJobRuns.map(run => (
                    <tr key={run.id} style={{ borderBottom: "1px solid #111827" }}>
                      <td style={{ padding: "8px 12px", color: "#6b7280" }}>{run.id}</td>
                      <td style={{ padding: "8px 12px", color: "#e5e7eb", fontWeight: 500 }}>{run.jobName}</td>
                      <td style={{ padding: "8px 12px", color: "#9ca3af", whiteSpace: "nowrap" }}>{fmtTime(run.startedAt)}</td>
                      <td style={{ padding: "8px 12px", color: "#9ca3af", whiteSpace: "nowrap" }}>
                        {run.finishedAt ? fmtTime(run.finishedAt) : <span style={{ color: "#3b82f6" }}>running…</span>}
                      </td>
                      <td style={{ padding: "8px 12px" }}><Badge status={run.status} /></td>
                      <td style={{ padding: "8px 12px", color: "#9ca3af" }}>{run.itemsProcessed}</td>
                      <td style={{ padding: "8px 12px", color: "#22c55e" }}>{run.successCount}</td>
                      <td style={{ padding: "8px 12px", color: run.failureCount > 0 ? "#ef4444" : "#6b7280" }}>{run.failureCount}</td>
                      <td style={{ padding: "8px 12px", color: "#f59e0b", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={run.errorSummary ?? ""}>
                        {run.errorSummary ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Funnel Tab ── */}
      {activeTab === "funnel" && (
        <>
          {funnelError && (
            <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 20, fontSize: 14 }}>
              {funnelError.message}
            </div>
          )}
          {funnelFetching && !funnel && <div style={{ color: "#9ca3af" }}>Loading funnel data…</div>}
          {funnel && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h2 style={{ fontSize: 17, fontWeight: 700, color: "#f9fafb", margin: 0 }}>Conversion Funnel (last 30 days)</h2>
                <button
                  onClick={() => qc.invalidateQueries({ queryKey: ["admin-funnel", adminKey] })}
                  disabled={funnelFetching}
                  style={{ padding: "7px 14px", borderRadius: 7, background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", cursor: "pointer", fontSize: 12 }}
                >
                  {funnelFetching ? "Refreshing…" : "Refresh"}
                </button>
              </div>

              {/* Step funnel */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 28 }}>
                {funnel.steps.map((step, i) => {
                  const maxCount = funnel.steps[0]?.total_count || 1;
                  const barWidth = maxCount ? Math.max(8, Math.round((step.total_count / maxCount) * 100)) : 8;
                  const rateKey = i > 0 ? `${funnel.steps[i - 1].name} → ${step.name}` : null;
                  const rate = rateKey ? funnel.rates[rateKey] : null;
                  return (
                    <div key={step.name}>
                      <div style={{
                        background: "#1a1f2e", borderRadius: 10, padding: "14px 18px",
                        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
                      }}>
                        <div style={{ width: 26, height: 26, borderRadius: 99, background: "#22c55e22", border: "2px solid #22c55e40", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#22c55e", flexShrink: 0 }}>
                          {i + 1}
                        </div>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "#e5e7eb", marginBottom: 6 }}>{step.name}</div>
                          <div style={{ background: "#111827", borderRadius: 4, height: 8, overflow: "hidden" }}>
                            <div style={{ width: `${barWidth}%`, height: "100%", background: "#22c55e", borderRadius: 4, transition: "width 0.4s" }} />
                          </div>
                        </div>
                        <div style={{ textAlign: "right", minWidth: 110 }}>
                          <div style={{ fontSize: 22, fontWeight: 700, color: "#f9fafb", lineHeight: 1 }}>{step.total_count.toLocaleString()}</div>
                          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>30d · today: {step.today_count}</div>
                        </div>
                        {rate && (
                          <div style={{ background: "#111827", borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 600, color: "#f59e0b", minWidth: 60, textAlign: "center" }}>
                            ↓ {rate}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* PDF downloads */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>PDF Downloads</h2>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
                <MetricCard label="Today" value={funnel.pdfDownloads.today} sub="PDF downloads" />
                <MetricCard label="Last 30 days" value={funnel.pdfDownloads.total30d} sub="PDF downloads" />
              </div>

              {/* Conversion rate summary */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Step Rates</h2>
              <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "16px 20px", marginBottom: 24 }}>
                {Object.entries(funnel.rates).map(([key, rate]) => (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #111827" }}>
                    <span style={{ fontSize: 13, color: "#9ca3af" }}>{key}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: parseFloat(rate) > 20 ? "#22c55e" : parseFloat(rate) > 5 ? "#f59e0b" : "#ef4444" }}>{rate}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ── Revenue Tab ── */}
      {activeTab === "revenue" && (
        <>
          {revenueError && (
            <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 20, fontSize: 14 }}>
              {revenueError.message}
            </div>
          )}
          {revenueFetching && !revenue && <div style={{ color: "#9ca3af" }}>Loading revenue data…</div>}
          {revenue && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h2 style={{ fontSize: 17, fontWeight: 700, color: "#f9fafb", margin: 0 }}>Revenue</h2>
                <button
                  onClick={() => qc.invalidateQueries({ queryKey: ["admin-revenue", adminKey] })}
                  disabled={revenueFetching}
                  style={{ padding: "7px 14px", borderRadius: 7, background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", cursor: "pointer", fontSize: 12 }}
                >
                  {revenueFetching ? "Refreshing…" : "Refresh"}
                </button>
              </div>

              {/* MRR / ARR */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Recurring Revenue</h2>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
                <MetricCard label="MRR" value={`$${revenue.mrr.toLocaleString()}`} sub="monthly recurring" />
                <MetricCard label="ARR" value={`$${revenue.arr.toLocaleString()}`} sub="annual recurring" />
              </div>

              {/* Plan breakdown */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Subscriber Breakdown</h2>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
                <MetricCard label="Free" value={revenue.subscribers.free} sub="users" />
                <MetricCard label="Pro ($25/mo)" value={revenue.subscribers.pro} sub="subscribers" />
                <MetricCard label="Business ($55/mo)" value={revenue.subscribers.business} sub="subscribers" />
                <MetricCard label="Total Users" value={revenue.subscribers.total} />
              </div>

              {/* One-time revenue */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>One-time Purchases</h2>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
                <MetricCard label="Lifetime" value={`$${revenue.oneTimeRevenue.lifetime.toLocaleString()}`} sub="total lifetime revenue" />
                <MetricCard label="Single Estimates" value={`$${revenue.oneTimeRevenue.singleEstimate.toLocaleString()}`} sub="total single estimate revenue" />
              </div>

              {/* Recent signups */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Recent Signups</h2>
              <div style={{ overflowX: "auto", marginBottom: 24 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #1f2937" }}>
                      {["Email", "Plan", "Status", "Joined"].map(h => (
                        <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6b7280", fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {revenue.recentSignups.map(u => (
                      <tr key={u.id} style={{ borderBottom: "1px solid #111827" }}>
                        <td style={{ padding: "8px 12px", color: "#e5e7eb" }}>{u.email}</td>
                        <td style={{ padding: "8px 12px" }}>
                          <span style={{
                            fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
                            background: u.plan === "business" ? "rgba(139,92,246,0.15)" : u.plan === "pro" ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.15)",
                            color: u.plan === "business" ? "#a78bfa" : u.plan === "pro" ? "#22c55e" : "#9ca3af",
                          }}>
                            {u.plan}
                          </span>
                        </td>
                        <td style={{ padding: "8px 12px" }}><Badge status={u.subStatus === "—" ? "free" : u.subStatus} /></td>
                        <td style={{ padding: "8px 12px", color: "#6b7280", whiteSpace: "nowrap" }}>{fmtTime(u.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Partner SDK Tab ── */}
      {activeTab === "sdk" && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: "#f9fafb", margin: 0 }}>Partner SDK Allowlist</h2>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                Origins listed here may load <code>integrate.js</code> and call SDK endpoints. Changes apply within ~30s.
              </p>
            </div>
            <button
              onClick={() => qc.invalidateQueries({ queryKey: ["admin-sdk-allowlist", adminKey] })}
              disabled={sdkFetching}
              style={{ padding: "7px 14px", borderRadius: 7, background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", cursor: "pointer", fontSize: 12 }}
            >
              {sdkFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {sdkError && (
            <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 20, fontSize: 14 }}>
              {sdkError.message}
            </div>
          )}

          {/* Add form */}
          <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "16px 18px", marginBottom: 20 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.4 }}>Add origin</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSdkActionMsg(null);
                const origin = sdkOriginInput.trim();
                if (!origin) {
                  setSdkActionMsg({ type: "err", text: "Origin is required" });
                  return;
                }
                sdkAddMutation.mutate({ origin, note: sdkNoteInput.trim() });
              }}
              style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            >
              <input
                type="text"
                placeholder="https://partner.example.com or *.partner.com"
                value={sdkOriginInput}
                onChange={(e) => setSdkOriginInput(e.target.value)}
                style={{ flex: "2 1 280px", padding: "8px 12px", borderRadius: 7, border: "1px solid #374151", background: "#0f1117", color: "#e5e7eb", fontSize: 13 }}
              />
              <input
                type="text"
                placeholder="Note (optional)"
                value={sdkNoteInput}
                onChange={(e) => setSdkNoteInput(e.target.value)}
                maxLength={500}
                style={{ flex: "1 1 180px", padding: "8px 12px", borderRadius: 7, border: "1px solid #374151", background: "#0f1117", color: "#e5e7eb", fontSize: 13 }}
              />
              <button
                type="submit"
                disabled={sdkAddMutation.isPending}
                style={{ padding: "8px 18px", borderRadius: 7, background: "#22c55e", color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                {sdkAddMutation.isPending ? "Adding…" : "Add"}
              </button>
            </form>
            {sdkActionMsg && (
              <div style={{ marginTop: 10, fontSize: 12, color: sdkActionMsg.type === "ok" ? "#22c55e" : "#f87171" }}>
                {sdkActionMsg.text}
              </div>
            )}
          </div>

          {/* DB-managed entries */}
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.4 }}>Managed origins</h3>
          <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "8px 0", marginBottom: 24, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1f2937" }}>
                  {["Origin", "Type", "Note", "Added", "By", "Status", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6b7280", fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sdkData?.dbEntries.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: "16px 12px", color: "#6b7280", fontStyle: "italic" }}>No managed origins yet.</td></tr>
                )}
                {sdkData?.dbEntries.map((row) => (
                  <tr key={row.id} style={{ borderBottom: "1px solid #111827", opacity: row.revokedAt ? 0.55 : 1 }}>
                    <td style={{ padding: "8px 12px", color: "#e5e7eb", fontFamily: "monospace" }}>{row.origin}</td>
                    <td style={{ padding: "8px 12px", color: "#9ca3af" }}>{row.kind}</td>
                    <td style={{ padding: "8px 12px", color: "#9ca3af", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.note ?? ""}>{row.note ?? "—"}</td>
                    <td style={{ padding: "8px 12px", color: "#6b7280", whiteSpace: "nowrap" }}>{fmtTime(row.createdAt)}</td>
                    <td style={{ padding: "8px 12px", color: "#6b7280", fontFamily: "monospace", fontSize: 11 }}>{row.createdBy ?? "—"}</td>
                    <td style={{ padding: "8px 12px" }}>
                      {row.revokedAt ? (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: "rgba(239,68,68,0.15)", color: "#f87171" }}>
                          revoked {fmtTime(row.revokedAt)}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>active</span>
                      )}
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      {!row.revokedAt && (
                        <button
                          onClick={() => {
                            if (window.confirm(`Revoke ${row.origin}? Partner traffic from this origin will be blocked.`)) {
                              setSdkActionMsg(null);
                              sdkRevokeMutation.mutate(row.id);
                            }
                          }}
                          disabled={sdkRevokeMutation.isPending}
                          style={{ padding: "5px 12px", borderRadius: 6, background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", cursor: "pointer", fontSize: 12 }}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Env-managed entries (read-only) */}
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.4 }}>
            Bootstrap entries (from <code>SDK_ALLOWED_ORIGINS</code>)
          </h3>
          <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "12px 18px", marginBottom: 24 }}>
            {sdkData && sdkData.envEntries.length === 0 && (
              <div style={{ color: "#6b7280", fontSize: 13, fontStyle: "italic" }}>None — set the <code>SDK_ALLOWED_ORIGINS</code> environment variable to add bootstrap entries.</div>
            )}
            {sdkData?.envEntries.map((e) => (
              <div key={e.origin} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #111827" }}>
                <span style={{ fontFamily: "monospace", color: "#e5e7eb", fontSize: 13 }}>{e.origin}</span>
                <span style={{ color: "#6b7280", fontSize: 12 }}>{e.kind} · env-managed</span>
              </div>
            ))}
            <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
              These are read from the server environment and cannot be revoked from the UI.
            </div>
          </div>
        </>
      )}

      {activeTab === "partners" && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: "#f9fafb", margin: 0 }}>Partners</h2>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                Admin-provisioned integration partners. <a href="/partners/docs" target="_blank" rel="noreferrer" style={{ color: "#22c55e" }}>View partner docs</a>
              </p>
            </div>
            <button
              onClick={() => refetchPartners()}
              disabled={partnersFetching}
              style={{ padding: "7px 14px", borderRadius: 7, background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", cursor: "pointer", fontSize: 12 }}
            >
              {partnersFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {partnersError && (
            <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 20, fontSize: 14 }}>
              {partnersError.message}
            </div>
          )}

          {/* Create partner form */}
          <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "16px 18px", marginBottom: 20 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.4 }}>
              Promote user to partner
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setPartnerMsg(null);
                if (!newPartnerUserId.trim() || !newPartnerCompany.trim()) {
                  setPartnerMsg({ type: "err", text: "User ID and company name are required" });
                  return;
                }
                const rl = newPartnerRateLimit.trim() ? parseInt(newPartnerRateLimit.trim(), 10) : undefined;
                if (rl !== undefined && (isNaN(rl) || rl < 1 || rl > 10000)) {
                  setPartnerMsg({ type: "err", text: "Rate limit must be between 1 and 10000" });
                  return;
                }
                createPartnerMutation.mutate({ userId: newPartnerUserId.trim(), companyName: newPartnerCompany.trim(), rateLimitOverride: rl });
              }}
              style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            >
              <input
                type="text"
                placeholder="User ID (UUID)"
                value={newPartnerUserId}
                onChange={(e) => setNewPartnerUserId(e.target.value)}
                style={{ flex: "2 1 220px", padding: "8px 12px", borderRadius: 7, border: "1px solid #374151", background: "#0f1117", color: "#e5e7eb", fontSize: 13 }}
              />
              <input
                type="text"
                placeholder="Company name"
                value={newPartnerCompany}
                onChange={(e) => setNewPartnerCompany(e.target.value)}
                style={{ flex: "2 1 160px", padding: "8px 12px", borderRadius: 7, border: "1px solid #374151", background: "#0f1117", color: "#e5e7eb", fontSize: 13 }}
              />
              <input
                type="number"
                placeholder="Rate limit/min (default 100)"
                value={newPartnerRateLimit}
                onChange={(e) => setNewPartnerRateLimit(e.target.value)}
                min={1}
                max={10000}
                style={{ flex: "1 1 140px", padding: "8px 12px", borderRadius: 7, border: "1px solid #374151", background: "#0f1117", color: "#e5e7eb", fontSize: 13 }}
              />
              <button
                type="submit"
                disabled={createPartnerMutation.isPending}
                style={{ padding: "8px 18px", borderRadius: 7, background: "#22c55e", color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                {createPartnerMutation.isPending ? "Creating…" : "Create"}
              </button>
            </form>
            {partnerMsg && (
              <div style={{ marginTop: 10, fontSize: 12, color: partnerMsg.type === "ok" ? "#22c55e" : "#f87171" }}>
                {partnerMsg.text}
              </div>
            )}
          </div>

          {/* Partners list */}
          <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "8px 0", marginBottom: 24, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1f2937" }}>
                  {["Company", "Email", "Status", "Keys", "SDK (mo)", "API (mo)", "Errors (mo)", "Rate Limit", "Actions"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6b7280", fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!partnersData?.partners?.length && (
                  <tr><td colSpan={9} style={{ padding: "16px 12px", color: "#6b7280", fontStyle: "italic" }}>No partners yet.</td></tr>
                )}
                {partnersData?.partners?.map((p) => (
                  <React.Fragment key={p.id}>
                  <tr style={{ borderBottom: "1px solid #111827" }}>
                    <td style={{ padding: "8px 12px", color: "#e5e7eb", fontWeight: 500 }}>
                      {p.companyName}
                      <span style={{ display: "block", fontSize: 10, color: "#6b7280", fontFamily: "monospace" }}>{p.id.slice(0, 8)}…</span>
                    </td>
                    <td style={{ padding: "8px 12px", color: "#9ca3af", fontSize: 12 }}>{p.primaryEmail ?? "—"}</td>
                    <td style={{ padding: "8px 12px" }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
                        background: p.status === "active" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                        color: p.status === "active" ? "#22c55e" : "#f87171",
                      }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px", color: "#9ca3af" }}>{p.keyCount}</td>
                    <td style={{ padding: "8px 12px", color: "#9ca3af" }}>{p.thisMonth.estimatesSdk}</td>
                    <td style={{ padding: "8px 12px", color: "#9ca3af" }}>{p.thisMonth.estimatesApi}</td>
                    <td style={{ padding: "8px 12px", color: p.thisMonth.errors > 0 ? "#f87171" : "#9ca3af" }}>{p.thisMonth.errors}</td>
                    <td style={{ padding: "8px 12px", color: "#9ca3af" }}>
                      {editingRateLimit?.id === p.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input
                            type="number"
                            value={editingRateLimit.value}
                            min={1}
                            max={10000}
                            onChange={(e) => setEditingRateLimit({ id: p.id, value: e.target.value })}
                            style={{ width: 70, padding: "3px 6px", borderRadius: 5, border: "1px solid #374151", background: "#0f1117", color: "#e5e7eb", fontSize: 12 }}
                          />
                          <button
                            onClick={() => {
                              const v = parseInt(editingRateLimit.value, 10);
                              if (!isNaN(v) && v >= 1 && v <= 10000) {
                                updatePartnerMutation.mutate({ id: p.id, patch: { rateLimitOverride: v } });
                              }
                              setEditingRateLimit(null);
                            }}
                            style={{ fontSize: 11, color: "#22c55e", background: "none", border: "none", cursor: "pointer" }}
                          >Save</button>
                          <button onClick={() => setEditingRateLimit(null)} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}>✕</button>
                        </div>
                      ) : (
                        <span
                          title="Click to edit"
                          style={{ cursor: "pointer", borderBottom: "1px dashed #4b5563" }}
                          onClick={() => setEditingRateLimit({ id: p.id, value: String(p.rateLimitOverride ?? 100) })}
                        >{p.rateLimitOverride ?? 100}/min</span>
                      )}
                    </td>
                    <td style={{ padding: "8px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        onClick={() => setExpandedPartnerId(expandedPartnerId === p.id ? null : p.id)}
                        style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(79,70,229,0.12)", color: "#818cf8", border: "1px solid rgba(79,70,229,0.3)", cursor: "pointer", fontSize: 11 }}
                      >
                        {expandedPartnerId === p.id ? "Collapse" : "Detail"}
                      </button>
                      {p.status === "active" ? (
                        <button
                          onClick={() => {
                            if (window.confirm(`Suspend ${p.companyName}? Their API keys will be blocked.`)) {
                              updatePartnerMutation.mutate({ id: p.id, patch: { status: "suspended" } });
                            }
                          }}
                          style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", cursor: "pointer", fontSize: 11 }}
                        >
                          Suspend
                        </button>
                      ) : (
                        <button
                          onClick={() => updatePartnerMutation.mutate({ id: p.id, patch: { status: "active" } })}
                          style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", fontSize: 11 }}
                        >
                          Activate
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedPartnerId === p.id && (
                    <tr>
                      <td colSpan={9} style={{ padding: "0 12px 16px", background: "#111827" }}>
                        {partnerDetailFetching ? (
                          <div style={{ color: "#6b7280", fontSize: 12, padding: "12px 0" }}>Loading details…</div>
                        ) : partnerDetail ? (
                          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", paddingTop: 12 }}>
                            <div style={{ flex: "1 1 280px" }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", marginBottom: 6 }}>API Keys ({partnerDetail.keys.length})</div>
                              {partnerDetail.keys.length === 0 ? <div style={{ color: "#4b5563", fontSize: 12 }}>No keys</div> : partnerDetail.keys.map((k) => (
                                <div key={k.id} style={{ fontSize: 12, color: k.revokedAt ? "#4b5563" : "#d1d5db", marginBottom: 4 }}>
                                  <span style={{ fontWeight: 500 }}>{k.name}</span>
                                  <span style={{ color: "#6b7280", marginLeft: 6, fontFamily: "monospace" }}>{k.keyPrefix}_••••</span>
                                  <span style={{ marginLeft: 6, color: "#6b7280" }}>{k.scopes}</span>
                                  {k.revokedAt && <span style={{ marginLeft: 6, color: "#f87171" }}>[revoked]</span>}
                                </div>
                              ))}
                            </div>
                            <div style={{ flex: "1 1 200px" }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", marginBottom: 6 }}>Origins ({partnerDetail.origins.length})</div>
                              {partnerDetail.origins.length === 0 ? <div style={{ color: "#4b5563", fontSize: 12 }}>No origins</div> : partnerDetail.origins.map((o) => (
                                <div key={o.id} style={{ fontSize: 12, color: o.revokedAt ? "#4b5563" : "#d1d5db", marginBottom: 4, fontFamily: "monospace" }}>{o.origin}</div>
                              ))}
                            </div>
                            <div style={{ flex: "1 1 260px" }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", marginBottom: 6 }}>Recent Usage (last 7 days)</div>
                              {partnerDetail.recentUsage.length === 0 ? <div style={{ color: "#4b5563", fontSize: 12 }}>No usage</div> : partnerDetail.recentUsage.slice(0, 7).map((u) => (
                                <div key={u.dayKey} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 3 }}>
                                  <span style={{ color: "#d1d5db" }}>{u.dayKey}</span>
                                  <span style={{ marginLeft: 8 }}>SDK: {u.estimatesSdk}</span>
                                  <span style={{ marginLeft: 8 }}>API: {u.estimatesApi}</span>
                                  {u.errors > 0 && <span style={{ marginLeft: 8, color: "#f87171" }}>Err: {u.errors}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === "growth" && (
        <GrowthHealthPanel
          data={growthHealth}
          isFetching={growthFetching}
          error={growthError}
          onRefresh={() => refetchGrowth()}
          adminKey={adminKey}
        />
      )}

      {/* ── Sellability Tab ── */}
      {activeTab === "sellability" && (
        <>
          {sellabilityError && (
            <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 20, fontSize: 14 }}>
              {sellabilityError.message}
            </div>
          )}
          {sellabilityFetching && !sellability && <div style={{ color: "#9ca3af" }}>Loading sellability data…</div>}
          {sellability && (
            <>
              {/* Header + actions */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                <div>
                  <h2 style={{ fontSize: 17, fontWeight: 700, color: "#f9fafb", margin: 0 }}>Sellability</h2>
                  <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                    What a SaaS buyer would see if you listed tomorrow. Generated {new Date(sellability.generatedAt).toLocaleString()}.
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => qc.invalidateQueries({ queryKey: ["admin-sellability", adminKey] })}
                    disabled={sellabilityFetching}
                    style={{ padding: "7px 14px", borderRadius: 7, background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", cursor: "pointer", fontSize: 12 }}
                  >
                    {sellabilityFetching ? "Refreshing…" : "Refresh"}
                  </button>
                  <a
                    href={`/api/admin/sellability/export`}
                    onClick={async (e) => {
                      e.preventDefault();
                      try {
                        const r = await fetch("/api/admin/sellability/export", { headers: { "x-admin-key": adminKey } });
                        if (!r.ok) {
                          let msg = `HTTP ${r.status}`;
                          try {
                            const body = await r.json();
                            if (body?.error) msg = String(body.error);
                          } catch { /* non-json response */ }
                          throw new Error(msg);
                        }
                        const blob = await r.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `sellability-${new Date().toISOString().slice(0, 10)}.json`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                      } catch (err) {
                        alert(`Download failed: ${(err as Error).message ?? err}`);
                      }
                    }}
                    style={{ padding: "7px 14px", borderRadius: 7, background: "#22c55e", color: "#0a0e1a", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-block" }}
                  >
                    Download buyer-ready packet (JSON)
                  </a>
                </div>
              </div>

              {/* Headline valuation */}
              <div style={{ background: "linear-gradient(135deg, #1a1f2e, #1e293b)", borderRadius: 14, padding: "24px 28px", marginBottom: 24, border: "1px solid #334155" }}>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>Estimated valuation range</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>Low (3× ARR)</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#cbd5e1" }}>${Math.round(sellability.valuation.low).toLocaleString()}</div>
                  </div>
                  <div style={{ fontSize: 14, color: "#6b7280" }}>—</div>
                  <div>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>Mid (4× ARR)</div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: "#22c55e" }}>${Math.round(sellability.valuation.mid).toLocaleString()}</div>
                  </div>
                  <div style={{ fontSize: 14, color: "#6b7280" }}>—</div>
                  <div>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>High (5× ARR)</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#cbd5e1" }}>${Math.round(sellability.valuation.high).toLocaleString()}</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>
                  Based on ARR of ${Math.round(sellability.valuation.arr).toLocaleString()}. {sellability.valuation.note}
                </div>
              </div>

              {/* Sellability Score */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Sellability Score</h2>
              <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "20px 24px", marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 18, flexWrap: "wrap" }}>
                  <div style={{
                    width: 84, height: 84, borderRadius: 99,
                    background: sellability.sellabilityScore.total >= 65 ? "rgba(34,197,94,0.15)" : sellability.sellabilityScore.total >= 50 ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)",
                    border: `3px solid ${sellability.sellabilityScore.total >= 65 ? "#22c55e" : sellability.sellabilityScore.total >= 50 ? "#f59e0b" : "#ef4444"}`,
                    display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
                  }}>
                    <div style={{ fontSize: 26, fontWeight: 800, color: "#f9fafb", lineHeight: 1 }}>{sellability.sellabilityScore.total}</div>
                    <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>/ 100</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: sellability.sellabilityScore.total >= 65 ? "#22c55e" : sellability.sellabilityScore.total >= 50 ? "#f59e0b" : "#ef4444" }}>
                      Grade {sellability.sellabilityScore.grade}
                    </div>
                    <div style={{ fontSize: 13, color: "#9ca3af" }}>Transparent rubric — see breakdown below</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                  {Object.values(sellability.sellabilityScore.rubric).map((factor) => (
                    <div key={factor.label} style={{ background: "#0f1117", borderRadius: 10, padding: "14px 16px", border: "1px solid #1f2937" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600 }}>{factor.label}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#f9fafb" }}>{factor.score}/{factor.maxScore}</span>
                      </div>
                      <div style={{ background: "#1f2937", borderRadius: 4, height: 6, overflow: "hidden", marginBottom: 8 }}>
                        <div style={{
                          width: `${(factor.score / factor.maxScore) * 100}%`,
                          height: "100%",
                          background: factor.score / factor.maxScore >= 0.7 ? "#22c55e" : factor.score / factor.maxScore >= 0.4 ? "#f59e0b" : "#ef4444",
                          borderRadius: 4,
                        }} />
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>{factor.notes}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Core SaaS Metrics */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Core SaaS Metrics</h2>
              <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "20px 24px", marginBottom: 24 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  <MetricCard label="MRR" value={`$${sellability.coreSaasMetrics.mrr.toLocaleString()}`} sub="monthly recurring" />
                  <MetricCard label="ARR" value={`$${sellability.coreSaasMetrics.arr.toLocaleString()}`} sub="annual recurring" />
                  <MetricCard label="Paying customers" value={sellability.coreSaasMetrics.payingCustomers} sub={`${sellability.coreSaasMetrics.payingCustomerBreakdown.proMonthly + sellability.coreSaasMetrics.payingCustomerBreakdown.proAnnual} pro · ${sellability.coreSaasMetrics.payingCustomerBreakdown.bizMonthly + sellability.coreSaasMetrics.payingCustomerBreakdown.bizAnnual} biz`} />
                  <MetricCard label="ARPU" value={`$${sellability.coreSaasMetrics.arpu.toFixed(2)}`} sub="avg revenue / user" />
                  <MetricCard label="LTV (estimated)" value={sellability.coreSaasMetrics.ltv > 0 ? `$${sellability.coreSaasMetrics.ltv.toFixed(0)}` : "—"} sub="ARPU ÷ monthly churn" />
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  <MetricCard label="MRR growth (MoM)" value={sellability.coreSaasMetrics.mrrGrowth.momPct === null ? "—" : `${sellability.coreSaasMetrics.mrrGrowth.momPct.toFixed(1)}%`} sub={sellability.coreSaasMetrics.mrrGrowth.momPct === null ? "Not enough history" : `was $${sellability.coreSaasMetrics.mrrGrowth.mrrAtMonthStart.toLocaleString()}`} />
                  <MetricCard label="MRR growth (3-mo)" value={sellability.coreSaasMetrics.mrrGrowth.trailing3MoPct === null ? "—" : `${sellability.coreSaasMetrics.mrrGrowth.trailing3MoPct.toFixed(1)}%`} sub={sellability.coreSaasMetrics.mrrGrowth.trailing3MoPct === null ? "Not enough history" : `was $${sellability.coreSaasMetrics.mrrGrowth.mrrAt3MoAgo.toLocaleString()}`} />
                  <MetricCard label="MRR growth (6-mo)" value={sellability.coreSaasMetrics.mrrGrowth.trailing6MoPct === null ? "—" : `${sellability.coreSaasMetrics.mrrGrowth.trailing6MoPct.toFixed(1)}%`} sub={sellability.coreSaasMetrics.mrrGrowth.trailing6MoPct === null ? "Not enough history" : `was $${sellability.coreSaasMetrics.mrrGrowth.mrrAt6MoAgo.toLocaleString()}`} />
                  <MetricCard label="Net new MRR (this mo)" value={`${sellability.coreSaasMetrics.netNewMrrThisMonth >= 0 ? "+" : ""}$${sellability.coreSaasMetrics.netNewMrrThisMonth.toLocaleString()}`} sub={`churn: $${sellability.coreSaasMetrics.churnedMrrThisMonth}`} />
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <MetricCard label="Logo churn (30d)" value={`${sellability.coreSaasMetrics.logoChurn.last30DaysPct.toFixed(1)}%`} sub={`${sellability.coreSaasMetrics.logoChurn.canceled30} canceled`} />
                  <MetricCard label="Logo churn (90d)" value={`${sellability.coreSaasMetrics.logoChurn.last90DaysPct.toFixed(1)}%`} sub={`${sellability.coreSaasMetrics.logoChurn.canceled90} canceled`} />
                  <MetricCard label="Revenue churn (30d)" value={`${sellability.coreSaasMetrics.revChurn.last30DaysPct.toFixed(1)}%`} sub="approx by ARPU" />
                  <MetricCard label="Revenue churn (90d)" value={`${sellability.coreSaasMetrics.revChurn.last90DaysPct.toFixed(1)}%`} sub="approx by ARPU" />
                </div>
                <p style={{ fontSize: 11, color: "#6b7280", marginTop: 14, marginBottom: 4, fontStyle: "italic" }}>{sellability.coreSaasMetrics.mrrGrowth.note}</p>
                <p style={{ fontSize: 11, color: "#6b7280", margin: 0, fontStyle: "italic" }}>{sellability.coreSaasMetrics.churnNote}</p>
              </div>

              {/* Cost & Margin */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Cost & Margin</h2>
              <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "20px 24px", marginBottom: 24 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  <MetricCard label="Estimates this month" value={sellability.costAndMargin.estimatesThisMonth.toLocaleString()} sub={`vs ${sellability.costAndMargin.estimatesLastMonth.toLocaleString()} last month`} />
                  <MetricCard label="Estimated AI spend" value={`$${sellability.costAndMargin.aiCostThisMonth.toFixed(2)}`} sub="this month" />
                  <MetricCard label="Resend emails sent" value={sellability.costAndMargin.emailVolumeThisMonth.toLocaleString()} sub="this month" />
                  <MetricCard label="Est. gross margin" value={`${sellability.costAndMargin.estimatedGrossMarginPct.toFixed(1)}%`} sub="MRR − AI spend" />
                </div>
                <div style={{ background: "#0f1117", borderRadius: 8, padding: "14px 16px", border: "1px solid #1f2937" }}>
                  <label style={{ display: "block", fontSize: 12, color: "#9ca3af", fontWeight: 600, marginBottom: 8 }}>
                    AI cost per estimate (USD assumption)
                  </label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ color: "#6b7280", fontSize: 14 }}>$</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      max="100"
                      placeholder={String(sellability.costAndMargin.aiCostPerEstimate)}
                      value={aiCostInput}
                      onChange={(e) => { setAiCostInput(e.target.value); setAiCostMsg(null); }}
                      style={{ width: 120, padding: "7px 10px", borderRadius: 6, border: "1px solid #374151", background: "#0a0e1a", color: "#e5e7eb", fontSize: 13 }}
                    />
                    <button
                      onClick={() => {
                        const val = parseFloat(aiCostInput);
                        if (Number.isFinite(val) && val >= 0) {
                          updateAiCostMutation.mutate(val);
                          setAiCostInput("");
                        } else {
                          setAiCostMsg({ type: "err", text: "Enter a valid number" });
                        }
                      }}
                      disabled={updateAiCostMutation.isPending || !aiCostInput}
                      style={{ padding: "7px 14px", borderRadius: 6, background: "#22c55e", color: "#0a0e1a", border: "none", cursor: aiCostInput ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, opacity: aiCostInput ? 1 : 0.5 }}
                    >
                      {updateAiCostMutation.isPending ? "Saving…" : "Save"}
                    </button>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>
                      Currently: ${sellability.costAndMargin.aiCostPerEstimate}/estimate
                    </span>
                    {aiCostMsg && (
                      <span style={{ fontSize: 12, color: aiCostMsg.type === "ok" ? "#22c55e" : "#ef4444", marginLeft: 8 }}>
                        {aiCostMsg.text}
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: "#6b7280", marginTop: 10, marginBottom: 0, fontStyle: "italic" }}>{sellability.costAndMargin.note}</p>
                </div>
              </div>

              {/* Lifetime Tier Status */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Lifetime Tier Status</h2>
              <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "20px 24px", marginBottom: 24, border: "1px solid #334155" }}>
                <p style={{ fontSize: 12, color: "#6b7280", marginTop: 0, marginBottom: 16, fontStyle: "italic" }}>
                  Lifetime tier is a launch promo capped at {lifetimeCap?.cap ?? 100} buyers to protect ARR. Once the cap is hit, only Pro and Business subscriptions are sold. Each lifetime slot sold costs ~$300/yr in recurring revenue opportunity.
                </p>
                {lifetimeCap && (
                  <>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                      <MetricCard
                        label="Slots sold"
                        value={`${lifetimeCap.purchased} / ${lifetimeCap.cap}`}
                        sub={lifetimeCap.soldOut ? "SOLD OUT" : `${lifetimeCap.remaining} remaining`}
                      />
                      <MetricCard
                        label="Total revenue"
                        value={`$${lifetimeCap.totalRevenueDollars.toLocaleString()}`}
                        sub="one-time payments"
                      />
                      <MetricCard
                        label="ARR opportunity cost"
                        value={`$${lifetimeCap.arrOpportunityCostDollars.toLocaleString()}`}
                        sub={`${lifetimeCap.purchased} slots × $300/yr`}
                      />
                      <div style={{
                        background: "#1a1f2e",
                        borderRadius: 12,
                        padding: "18px 22px",
                        flex: "1 1 140px",
                        minWidth: 120,
                        borderLeft: `3px solid ${lifetimeCap.soldOut ? "#ef4444" : "#22c55e"}`,
                      }}>
                        <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 4 }}>Status</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: lifetimeCap.soldOut ? "#ef4444" : "#22c55e" }}>
                          {lifetimeCap.soldOut ? "Sold out" : "Active"}
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                          {lifetimeCap.soldOut ? "Checkout entry point blocked" : "Accepting purchases"}
                        </div>
                      </div>
                    </div>

                    <div style={{ marginTop: 6, marginBottom: 8 }}>
                      <div style={{ background: "#1f2937", borderRadius: 4, height: 8, overflow: "hidden", maxWidth: 320 }}>
                        <div style={{
                          width: `${Math.min(100, (lifetimeCap.purchased / lifetimeCap.cap) * 100)}%`,
                          height: "100%",
                          background: lifetimeCap.soldOut ? "#ef4444" : lifetimeCap.purchased / lifetimeCap.cap > 0.8 ? "#f59e0b" : "#22c55e",
                          borderRadius: 4,
                          transition: "width 0.3s",
                        }} />
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                        {Math.round((lifetimeCap.purchased / lifetimeCap.cap) * 100)}% of cap used
                      </div>
                    </div>
                  </>
                )}

                <div style={{ background: "#0f1117", borderRadius: 8, padding: "14px 16px", border: "1px solid #1f2937", marginTop: 16 }}>
                  <label style={{ display: "block", fontSize: 12, color: "#9ca3af", fontWeight: 600, marginBottom: 8 }}>
                    Adjust cap limit (currently: {lifetimeCap?.cap ?? "—"})
                  </label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      max="10000"
                      placeholder={String(lifetimeCap?.cap ?? 100)}
                      value={lifetimeCapInput}
                      onChange={(e) => { setLifetimeCapInput(e.target.value); setLifetimeCapMsg(null); }}
                      style={{ width: 100, padding: "7px 10px", borderRadius: 6, border: "1px solid #374151", background: "#0a0e1a", color: "#e5e7eb", fontSize: 13 }}
                    />
                    <button
                      onClick={() => {
                        const val = parseInt(lifetimeCapInput, 10);
                        if (Number.isFinite(val) && val >= 1) {
                          updateLifetimeCapMutation.mutate(val);
                        } else {
                          setLifetimeCapMsg({ type: "err", text: "Enter a whole number ≥ 1" });
                        }
                      }}
                      disabled={updateLifetimeCapMutation.isPending || !lifetimeCapInput}
                      style={{ padding: "7px 14px", borderRadius: 6, background: "#22c55e", color: "#0a0e1a", border: "none", cursor: lifetimeCapInput ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, opacity: lifetimeCapInput ? 1 : 0.5 }}
                    >
                      {updateLifetimeCapMutation.isPending ? "Saving…" : "Save cap"}
                    </button>
                    {lifetimeCapMsg && (
                      <span style={{ fontSize: 12, color: lifetimeCapMsg.type === "ok" ? "#22c55e" : "#ef4444", marginLeft: 8 }}>
                        {lifetimeCapMsg.text}
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: "#6b7280", marginTop: 8, marginBottom: 0 }}>
                    Raise to 150 or lower to 50 without redeploying. The checkout entry point checks this value on every request.
                  </p>
                </div>
              </div>

              {/* Risk Flags */}
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>Risk Flags (buyer discount drivers)</h2>
              <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "20px 24px", marginBottom: 24 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  <MetricCard
                    label="Top 1 customer % of MRR"
                    value={sellability.riskFlags.customerConcentration.totalPayingCustomers > 0 ? `${sellability.riskFlags.customerConcentration.top1Pct.toFixed(1)}%` : "—"}
                    sub={sellability.riskFlags.customerConcentration.totalPayingCustomers > 0 ? "Lower is better" : "Not enough data yet"}
                  />
                  <MetricCard
                    label="Top 3 customers"
                    value={sellability.riskFlags.customerConcentration.totalPayingCustomers > 0 ? `${sellability.riskFlags.customerConcentration.top3Pct.toFixed(1)}%` : "—"}
                    sub="Concentration risk"
                  />
                  <MetricCard
                    label="Top 5 customers"
                    value={sellability.riskFlags.customerConcentration.totalPayingCustomers > 0 ? `${sellability.riskFlags.customerConcentration.top5Pct.toFixed(1)}%` : "—"}
                    sub="Concentration risk"
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
                  <div style={{ background: "#0f1117", borderRadius: 8, padding: "14px 16px", borderLeft: "3px solid #f59e0b" }}>
                    <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, marginBottom: 4 }}>Vendor concentration</div>
                    <div style={{ fontSize: 14, color: "#f9fafb" }}>
                      100% of AI = <strong>{sellability.riskFlags.vendorConcentration.aiProvider}</strong>
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>Buyers will discount for single-vendor risk</div>
                  </div>
                  <div style={{ background: "#0f1117", borderRadius: 8, padding: "14px 16px", borderLeft: `3px solid ${sellability.riskFlags.openSystemAlerts === 0 ? "#22c55e" : "#ef4444"}` }}>
                    <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, marginBottom: 4 }}>Open system alerts</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>{sellability.riskFlags.openSystemAlerts}</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>Unresolved alerts in system_alerts</div>
                  </div>
                  <div style={{ background: "#0f1117", borderRadius: 8, padding: "14px 16px", borderLeft: `3px solid ${sellability.riskFlags.failedJobRuns.last7Days === 0 ? "#22c55e" : "#ef4444"}` }}>
                    <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, marginBottom: 4 }}>Failed jobs (7d)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>{sellability.riskFlags.failedJobRuns.last7Days}</div>
                    {sellability.riskFlags.failedJobRuns.byJob.length > 0 ? (
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                        {sellability.riskFlags.failedJobRuns.byJob.map(j => `${j.jobName} (${j.count})`).join(", ")}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>No failures</div>
                    )}
                  </div>
                  <div style={{ background: "#0f1117", borderRadius: 8, padding: "14px 16px", borderLeft: `3px solid ${sellability.riskFlags.hasBounceWebhook ? "#22c55e" : "#f59e0b"}` }}>
                    <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, marginBottom: 4 }}>Bounce / spam webhook</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: sellability.riskFlags.hasBounceWebhook ? "#22c55e" : "#f59e0b" }}>
                      {sellability.riskFlags.hasBounceWebhook ? "Configured" : "Not configured"}
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>Required for sender-domain reputation</div>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Retention Tab ── */}
      {activeTab === "retention" && (
        <>
          {retentionError && (
            <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 20, fontSize: 14 }}>
              {retentionError.message}
            </div>
          )}
          {retentionFetching && !retention && (
            <div style={{ color: "#9ca3af" }}>Loading retention data…</div>
          )}
          {retention && (
            <>
              {/* Controls row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 700, color: "#e5e7eb", margin: 0 }}>Cohort Retention</h2>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                    Generated {new Date(retention.generatedAt).toLocaleTimeString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {/* Granularity toggle */}
                  <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid #374151" }}>
                    {(["weekly", "monthly"] as const).map((g) => (
                      <button
                        key={g}
                        onClick={() => setRetentionGranularity(g)}
                        style={{
                          padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                          background: retentionGranularity === g ? "#22c55e" : "#1a1f2e",
                          color: retentionGranularity === g ? "#fff" : "#9ca3af",
                        }}
                      >
                        {g === "weekly" ? "Weekly" : "Monthly"}
                      </button>
                    ))}
                  </div>
                  {/* Lookback toggle */}
                  <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid #374151" }}>
                    {([12, 26, 52] as const).map((lb) => (
                      <button
                        key={lb}
                        onClick={() => setRetentionLookback(lb)}
                        style={{
                          padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                          background: retentionLookback === lb ? "#22c55e" : "#1a1f2e",
                          color: retentionLookback === lb ? "#fff" : "#9ca3af",
                        }}
                      >
                        {lb} {retentionGranularity === "weekly" ? "wk" : "mo"}
                      </button>
                    ))}
                  </div>
                  {/* CSV export — uses fetch with auth header, never puts key in DOM/URL */}
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch(
                          `/api/admin/retention/cohorts.csv?granularity=${retentionGranularity}&lookback=${retentionLookback}`,
                          { headers: { "x-admin-key": adminKey } },
                        );
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `retention-cohorts-${new Date().toISOString().slice(0, 10)}.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch (err) {
                        alert(`CSV download failed: ${(err as Error).message ?? err}`);
                      }
                    }}
                    style={{ padding: "6px 14px", borderRadius: 8, background: "#1e40af", color: "#fff", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                  >
                    Export CSV
                  </button>
                </div>
              </div>

              {/* Headline 90-day metric */}
              <div style={{ background: "linear-gradient(135deg, #1a1f2e, #1e293b)", borderRadius: 14, padding: "24px 28px", marginBottom: 24, border: "1px solid #334155" }}>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
                  90-Day Retention
                </div>
                {retention.headline.notEnoughData ? (
                  <>
                    <div style={{ fontSize: 28, fontWeight: 800, color: "#6b7280" }}>—</div>
                    <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 8, lineHeight: 1.5 }}>
                      {retention.headline.customersEligibleAt90Days === 0
                        ? "Not enough cohorts have crossed 90 days yet to be meaningful."
                        : `Only ${retention.headline.customersEligibleAt90Days} customer${retention.headline.customersEligibleAt90Days === 1 ? "" : "s"} ha${retention.headline.customersEligibleAt90Days === 1 ? "s" : "ve"} crossed the 90-day mark — need at least 10 for a meaningful number.`}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
                      <div style={{ fontSize: 48, fontWeight: 800, color: retention.headline.weighted90DayRetentionPct! >= 70 ? "#22c55e" : retention.headline.weighted90DayRetentionPct! >= 40 ? "#f59e0b" : "#ef4444", lineHeight: 1 }}>
                        {retention.headline.weighted90DayRetentionPct}%
                      </div>
                      <div style={{ fontSize: 14, color: "#9ca3af" }}>
                        across {retention.headline.customersEligibleAt90Days} customers who have crossed the 90-day mark
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8 }}>
                      {retention.headline.customersRetainedAt90Days} of {retention.headline.customersEligibleAt90Days} customers are still paying after 90 days.
                    </div>
                    <div style={{ fontSize: 13, color: "#9ca3af", background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "10px 14px", lineHeight: 1.6 }}>
                      {retention.headline.weighted90DayRetentionPct! >= 70
                        ? `${retention.headline.customersRetainedAt90Days} of your first ${retention.headline.customersEligibleAt90Days} customers are still paying after 90 days — that's strong retention for early-stage SaaS.`
                        : retention.headline.weighted90DayRetentionPct! >= 40
                          ? `${retention.headline.customersRetainedAt90Days} of ${retention.headline.customersEligibleAt90Days} customers are still paying after 90 days. Retention is moderate — there's room to improve onboarding or re-engagement.`
                          : `90-day retention is below 40%. This is a warning sign — focus on understanding why customers leave in the first 3 months.`}
                    </div>
                  </>
                )}
              </div>

              {/* Empty state */}
              {retention.cohorts.length === 0 ? (
                <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "40px 24px", textAlign: "center", color: "#6b7280" }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "#9ca3af", marginBottom: 8 }}>No paying customers yet</div>
                  <div style={{ fontSize: 13 }}>Retention cohorts will appear here after the first paying signup.</div>
                </div>
              ) : (
                <>
                  {/* Cohort survival table */}
                  <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
                    Cohort Survival Table
                  </h2>
                  <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "4px", marginBottom: 24, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr>
                          {[
                            { label: "Cohort", sub: retentionGranularity === "weekly" ? "week starting" : "month", width: "130px" },
                            { label: "Size", sub: "customers", width: "70px" },
                            { label: "Day 7", sub: "retained", width: "80px" },
                            { label: "Day 30", sub: "retained", width: "80px" },
                            { label: "Day 60", sub: "retained", width: "80px" },
                            { label: "Day 90", sub: "retained", width: "80px" },
                            { label: "Day 180", sub: "retained", width: "80px" },
                          ].map(({ label, sub, width }) => (
                            <th
                              key={label}
                              style={{
                                padding: "12px 10px", textAlign: "left", color: "#9ca3af",
                                fontWeight: 600, fontSize: 11, borderBottom: "1px solid #374151",
                                width, whiteSpace: "nowrap",
                              }}
                            >
                              {label}<br /><span style={{ fontWeight: 400, color: "#6b7280" }}>{sub}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...retention.cohorts].reverse().map((c) => {
                          const cells = [c.retainedD7, c.retainedD30, c.retainedD60, c.retainedD90, c.retainedD180];
                          return (
                            <tr key={c.cohortStart} style={{ borderBottom: "1px solid #1f2937" }}>
                              <td style={{ padding: "10px 10px", color: "#e5e7eb", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
                                {c.cohortStart}
                                {c.dataQuality === "partial" && (
                                  <span title="Paid-start date approximated from subscription row for some customers in this cohort" style={{ marginLeft: 5, color: "#fbbf24", fontSize: 11, cursor: "help" }}>*</span>
                                )}
                              </td>
                              <td style={{ padding: "10px 10px", color: "#e5e7eb", fontWeight: 600 }}>
                                {c.cohortSize}
                              </td>
                              {cells.map((pct, idx) => {
                                if (pct === null) {
                                  return (
                                    <td key={idx} style={{ padding: "10px 10px", color: "#4b5563", textAlign: "center" }}>
                                      —
                                    </td>
                                  );
                                }
                                const bg = pct >= 70
                                  ? "rgba(34,197,94,0.18)"
                                  : pct >= 40
                                    ? "rgba(245,158,11,0.18)"
                                    : "rgba(239,68,68,0.18)";
                                const color = pct >= 70 ? "#4ade80" : pct >= 40 ? "#fbbf24" : "#f87171";
                                return (
                                  <td
                                    key={idx}
                                    style={{
                                      padding: "10px 10px", textAlign: "center",
                                      background: bg, color, fontWeight: 700,
                                      fontVariantNumeric: "tabular-nums",
                                    }}
                                  >
                                    {pct}%
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {retention.headline.proxySourceCount > 0 && (
                <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 12, color: "#fbbf24", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span>⚠</span>
                  <span>
                    <strong>{retention.headline.proxySourceCount} customer{retention.headline.proxySourceCount === 1 ? "" : "s"}</strong> in the cohort table {retention.headline.proxySourceCount === 1 ? "has" : "have"} an approximate paid-start date (marked <strong>*</strong>) because no <code>subscription_updated</code> status-transition event was found for them. These are included in cohort rows but excluded from the 90-day headline metric. They will get a verified timestamp as new billing events accumulate.
                  </span>
                </div>
              )}

              {/* Cohort definition box */}
              <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "18px 22px", marginBottom: 24, border: "1px solid #2d3748" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#9ca3af", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  How cohorts are defined
                </div>
                <ul style={{ margin: 0, padding: "0 0 0 18px", fontSize: 12, color: "#9ca3af", lineHeight: 2 }}>
                  <li>A customer <strong style={{ color: "#e5e7eb" }}>joins a cohort</strong> on the first date their subscription became paid-active, sourced from the earliest <code>subscription_updated</code> (status=active) billing event. When no such event exists, <code>subscriptions.updated_at</code> is used as a proxy (marked <strong style={{ color: "#fbbf24" }}>*</strong>) — this is the same source the Sellability tab uses for current active-subscription state. Lifetime purchasers use their purchase timestamp.</li>
                  <li>A customer is <strong style={{ color: "#e5e7eb" }}>retained at Day N</strong> if the target day falls inside one of their verified paid intervals. Intervals open on <code>subscription_updated</code> (status=active) and close on <code>subscription_updated</code> (status=canceled). A customer who churned before Day N and reactivated after Day N is correctly counted as not retained on that day. Lifetime purchasers are always retained from their purchase date.</li>
                  <li>A day-bucket shows <strong style={{ color: "#e5e7eb" }}>— (not yet)</strong> until every cohort member has individually crossed that milestone. When shown, the denominator equals the full cohort size.</li>
                  <li>The <strong style={{ color: "#e5e7eb" }}>90-day headline</strong> counts only customers whose paid-start date comes from a verified billing event (no proxy). Requires at least 10 such customers who have crossed 90 days.</li>
                  <li>Aggregate churn %, ARPU, and LTV live on the <button onClick={() => setActiveTab("sellability")} style={{ background: "none", border: "none", color: "#60a5fa", cursor: "pointer", padding: 0, fontSize: 12, textDecoration: "underline" }}>Sellability tab</button>.</li>
                </ul>
              </div>

              {/* Color legend */}
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "#9ca3af", marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(34,197,94,0.18)", border: "1px solid #4ade80" }} />
                  <span>≥ 70% — strong</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(245,158,11,0.18)", border: "1px solid #fbbf24" }} />
                  <span>40–70% — moderate</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(239,68,68,0.18)", border: "1px solid #f87171" }} />
                  <span>&lt; 40% — needs attention</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#4b5563", fontWeight: 700, fontSize: 14 }}>—</span>
                  <span>cohort too young for this bucket</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#fbbf24", fontWeight: 700, fontSize: 12 }}>*</span>
                  <span>paid-start date approximated from subscription row (no billing event)</span>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Guarantees Tab ── */}
      {activeTab === "guarantees" && (
        <div>
          {/* A/B Experiment + Financial Summary */}
          {guaranteesDashFetching && !guaranteesDash && (
            <div style={{ color: "#9ca3af", marginBottom: 16 }}>Loading dashboard…</div>
          )}
          {guaranteesDash && (
            <div style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: "#e5e7eb", marginBottom: 14 }}>
                A/B Experiment — Pricing Guarantee Stack
              </h2>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
                {guaranteesDash.abStats.map(v => (
                  <div key={v.variant} style={{ background: "#1a1f2e", borderRadius: 12, padding: "16px 22px", flex: "1 1 200px" }}>
                    <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 4, fontWeight: 600 }}>{v.variant}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#f9fafb", marginBottom: 4 }}>{v.assigned.toLocaleString()} <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 400 }}>assigned</span></div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>Signup CVR: <span style={{ color: "#22c55e" }}>{(v.conversionRate * 100).toFixed(1)}%</span></div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>Paid CVR: <span style={{ color: "#34d399" }}>{(v.paidConversionRate * 100).toFixed(1)}%</span></div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, borderTop: "1px solid #1f2937", paddingTop: 4 }}>
                      Claims: <span style={{ color: "#f59e0b" }}>{v.claimCount}</span>
                      <span style={{ color: "#6b7280" }}> ({(v.claimRate * 100).toFixed(2)}%)</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>Cost/user: <span style={{ color: "#f87171" }}>${(v.costPerUserCents / 100).toFixed(2)}</span></div>
                  </div>
                ))}
                <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "16px 22px", flex: "1 1 200px" }}>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 4, fontWeight: 600 }}>Net Financial Impact</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#f87171" }}>
                    ${guaranteesDash.totals.netFinancialImpactDollars}
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                    {guaranteesDash.totals.stripeRefundCount} Stripe refunds
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>
                    ${guaranteesDash.totals.stripeRefundDollars} refunded · ${guaranteesDash.totals.balanceCreditDollars} credits
                  </div>
                </div>
              </div>
              {/* Net revenue lift summary — guarantee_stack vs control */}
              {(() => {
                const control = guaranteesDash.abStats.find(v => v.variant === "control");
                const stack = guaranteesDash.abStats.find(v => v.variant === "guarantee_stack");
                if (!control || !stack || control.assigned === 0 || stack.assigned === 0) return null;
                const ARPU_CENTS = 2500;
                const paidLiftPct = stack.paidConversionRate - control.paidConversionRate;
                const revenueUpliftPerUser = paidLiftPct * ARPU_CENTS;
                const costDelta = stack.costPerUserCents - control.costPerUserCents;
                const netLiftCents = revenueUpliftPerUser - costDelta;
                const positive = netLiftCents >= 0;
                return (
                  <div style={{ background: "#0f1420", borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 12, color: "#9ca3af" }}>
                    <strong style={{ color: "#e5e7eb" }}>Net revenue lift (guarantee_stack vs control)</strong>
                    <span style={{ marginLeft: 12 }}>
                      Paid CVR uplift: <span style={{ color: paidLiftPct >= 0 ? "#22c55e" : "#f87171" }}>{paidLiftPct >= 0 ? "+" : ""}{(paidLiftPct * 100).toFixed(2)}pp</span>
                      <span style={{ marginLeft: 10 }}>×</span>
                      <span style={{ marginLeft: 6 }}>$25 ARPU</span>
                      <span style={{ marginLeft: 10 }}>−</span>
                      <span style={{ marginLeft: 6 }}>claim cost delta ${(costDelta / 100).toFixed(2)}/user</span>
                      <span style={{ marginLeft: 10 }}>=</span>
                      <span style={{ marginLeft: 6, color: positive ? "#22c55e" : "#f87171", fontWeight: 700 }}>
                        {positive ? "+" : ""}${(netLiftCents / 100).toFixed(2)}/user
                      </span>
                    </span>
                  </div>
                );
              })()}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {guaranteesDash.claimStats.map(r => (
                  <div key={r.guarantee_type + "-" + r.status} style={{ background: "#1a1f2e", borderRadius: 8, padding: "10px 16px", minWidth: 110 }}>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>{r.guarantee_type} / {r.status}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>{r.count}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Claims List */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "#e5e7eb", margin: 0 }}>Claims</h2>
            <select
              value={guaranteesStatusFilter}
              onChange={e => { setGuaranteesStatusFilter(e.target.value); setGuaranteesPage(0); }}
              style={{ background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", borderRadius: 6, padding: "4px 8px", fontSize: 13 }}
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
            </select>
            <select
              value={guaranteesTypeFilter}
              onChange={e => { setGuaranteesTypeFilter(e.target.value); setGuaranteesPage(0); }}
              style={{ background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", borderRadius: 6, padding: "4px 8px", fontSize: 13 }}
            >
              <option value="">All types</option>
              <option value="speed">Speed (60s)</option>
              <option value="win_jobs">Win-Jobs</option>
              <option value="money_back">Money-Back</option>
            </select>
            <button
              onClick={() => { refetchClaims(); refetchGuaranteesDash(); }}
              disabled={claimsFetching}
              style={{ padding: "4px 12px", borderRadius: 6, background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", cursor: "pointer", fontSize: 13 }}
            >
              {claimsFetching ? "Loading…" : "Refresh"}
            </button>
          </div>

          {claimsData && (
            <>
              <div style={{ overflowX: "auto", marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #374151" }}>
                      {["User", "Type", "Status", "Flags", "Credit", "Requested", "Actions"].map(h => (
                        <th key={h} style={{ padding: "7px 10px", color: "#9ca3af", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {claimsData.claims.map((claim: GuaranteeClaim) => (
                      <React.Fragment key={claim.id}>
                        <tr
                          style={{ borderBottom: "1px solid #1f2937", cursor: "pointer" }}
                          onClick={() => setExpandedClaim(expandedClaim === claim.id ? null : claim.id)}
                        >
                          <td style={{ padding: "7px 10px", color: "#d1d5db" }}>{claim.user_email}</td>
                          <td style={{ padding: "7px 10px", color: "#9ca3af" }}>{claim.guarantee_type}</td>
                          <td style={{ padding: "7px 10px" }}><Badge status={claim.status} /></td>
                          <td style={{ padding: "7px 10px", fontSize: 12, color: claim.suspicious_flags ? "#f59e0b" : "#6b7280" }}>
                            {claim.suspicious_flags ? "⚠ Yes" : "—"}
                          </td>
                          <td style={{ padding: "7px 10px", color: "#34d399" }}>
                            {claim.account_credit_cents ? "$" + (claim.account_credit_cents / 100).toFixed(2) : "—"}
                          </td>
                          <td style={{ padding: "7px 10px", color: "#6b7280", whiteSpace: "nowrap" }}>
                            {fmtTime(claim.requested_at)}
                          </td>
                          <td style={{ padding: "7px 10px" }}>
                            {claim.status === "pending" && (
                              <div style={{ display: "flex", gap: 6 }} onClick={e => e.stopPropagation()}>
                                <button
                                  disabled={approveClaimMut.isPending}
                                  onClick={() => approveClaimMut.mutate({ claimId: claim.id, note: claimActionNote[claim.id] || "" })}
                                  style={{ padding: "3px 10px", borderRadius: 5, background: "rgba(34,197,94,0.2)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                                >
                                  Approve
                                </button>
                                <button
                                  disabled={denyClaimMut.isPending}
                                  onClick={() => denyClaimMut.mutate({ claimId: claim.id, note: claimActionNote[claim.id] || "" })}
                                  style={{ padding: "3px 10px", borderRadius: 5, background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                                >
                                  Deny
                                </button>
                              </div>
                            )}
                            {claim.status !== "pending" && (
                              <span style={{ fontSize: 12, color: "#6b7280" }}>{claim.admin_override_by ? "by admin" : "auto"}</span>
                            )}
                          </td>
                        </tr>
                        {expandedClaim === claim.id && (
                          <tr style={{ borderBottom: "1px solid #374151" }}>
                            <td colSpan={7} style={{ padding: "14px 18px", background: "#0a0d18" }}>
                              {claimDetailFetching && <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>Loading detail…</div>}
                              {/* Claim summary */}
                              <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12, fontSize: 12 }}>
                                <div style={{ color: "#9ca3af" }}>
                                  Account age: <strong style={{ color: "#e5e7eb" }}>
                                    {claimDetail ? `${Math.floor((claim.requested_at - Number(claimDetail.claim.user_created_at)) / 86400000)}d` : "…"}
                                  </strong>
                                </div>
                                <div style={{ color: "#9ca3af" }}>
                                  Total estimates: <strong style={{ color: "#e5e7eb" }}>{claimDetail ? claimDetail.context.estimateCount : "…"}</strong>
                                </div>
                                <div style={{ color: "#9ca3af" }}>
                                  Other claims: <strong style={{ color: "#e5e7eb" }}>{claimDetail ? claimDetail.context.otherClaims.length : "…"}</strong>
                                </div>
                                {claim.stripe_refund_id && (
                                  <div style={{ color: "#9ca3af" }}>
                                    Stripe refund: <code style={{ color: "#34d399" }}>{claim.stripe_refund_id}</code>
                                  </div>
                                )}
                              </div>
                              {/* IP + User-Agent context */}
                              {(claim.ip_address || claim.user_agent) && (
                                <div style={{ marginBottom: 10, fontSize: 11, color: "#6b7280", background: "#111827", padding: "6px 10px", borderRadius: 5 }}>
                                  {claim.ip_address && (
                                    <div>IP: <code style={{ color: "#9ca3af" }}>{claim.ip_address}</code></div>
                                  )}
                                  {claim.user_agent && (
                                    <div style={{ marginTop: 2, wordBreak: "break-all" }}>UA: <span style={{ color: "#9ca3af" }}>{claim.user_agent}</span></div>
                                  )}
                                </div>
                              )}
                              {/* Resolution */}
                              {claim.resolution && (
                                <div style={{ fontSize: 13, color: "#d1d5db", marginBottom: 10, background: "#111827", padding: "8px 12px", borderRadius: 6 }}>
                                  <strong style={{ color: "#9ca3af" }}>Resolution: </strong>{claim.resolution}
                                </div>
                              )}
                              {/* Suspicious flags */}
                              {claim.suspicious_flags && (
                                <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 8, background: "rgba(245,158,11,0.08)", padding: "6px 10px", borderRadius: 5 }}>
                                  <strong>Suspicious flags:</strong> {claim.suspicious_flags}
                                </div>
                              )}
                              {/* Admin override note */}
                              {claim.admin_override_note && (
                                <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>
                                  <strong>Admin note:</strong> {claim.admin_override_note}
                                </div>
                              )}
                              {/* Immutable audit trail */}
                              {claimDetail && claimDetail.auditTrail.length > 0 && (
                                <div style={{ marginBottom: 10 }}>
                                  <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Audit Trail</div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    {claimDetail.auditTrail.map(evt => (
                                      <div key={evt.id} style={{ display: "flex", gap: 10, fontSize: 12, color: "#9ca3af", alignItems: "flex-start" }}>
                                        <span style={{ color: "#4b5563", whiteSpace: "nowrap", minWidth: 120 }}>{fmtTime(evt.created_at)}</span>
                                        <span style={{ color: "#6b7280" }}>{evt.from_status}</span>
                                        <span style={{ color: "#4b5563" }}>→</span>
                                        <span style={{ color: "#e5e7eb", fontWeight: 600 }}>{evt.to_status}</span>
                                        <span style={{ color: "#6b7280" }}>by {evt.actor}</span>
                                        {evt.note && <span style={{ color: "#9ca3af" }}>· {evt.note}</span>}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {/* Other claims on this account */}
                              {claimDetail && claimDetail.context.otherClaims.length > 0 && (
                                <div style={{ marginBottom: 10 }}>
                                  <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Other Claims on Account</div>
                                  {claimDetail.context.otherClaims.map(oc => (
                                    <div key={oc.id} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>
                                      {oc.guarantee_type} · <Badge status={oc.status} /> · {fmtTime(oc.requested_at)}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {/* Admin action note input */}
                              {claim.status === "pending" && (
                                <div style={{ marginTop: 10 }}>
                                  <input
                                    placeholder="Optional admin note (required to deny)"
                                    value={claimActionNote[claim.id] || ""}
                                    onChange={e => setClaimActionNote((n: Record<string, string>) => ({ ...n, [claim.id]: e.target.value }))}
                                    style={{ padding: "5px 10px", borderRadius: 6, background: "#1a1f2e", color: "#e5e7eb", border: "1px solid #374151", fontSize: 12, width: 340 }}
                                  />
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "#6b7280" }}>
                <span>{claimsData.total} claim{claimsData.total !== 1 ? "s" : ""} · page {claimsData.page}/{claimsData.pages}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => setGuaranteesPage((p: number) => Math.max(0, p - 1))}
                    disabled={claimsData.page <= 1}
                    style={{ padding: "4px 10px", borderRadius: 6, background: "transparent", border: "1px solid #374151", fontSize: 12, color: claimsData.page <= 1 ? "#374151" : "#9ca3af", cursor: claimsData.page <= 1 ? "not-allowed" : "pointer" }}
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setGuaranteesPage((p: number) => p + 1)}
                    disabled={guaranteesIsLastPage}
                    style={{ padding: "4px 10px", borderRadius: 6, background: "transparent", border: "1px solid #374151", fontSize: 12, color: guaranteesIsLastPage ? "#374151" : "#9ca3af", cursor: guaranteesIsLastPage ? "not-allowed" : "pointer" }}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtAge(ms: number | null): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function stalenessColor(ms: number | null): string {
  if (!ms) return "#4b5563";
  const diff = Date.now() - ms;
  if (diff > 4 * 3_600_000) return "#f87171";
  if (diff > 3_600_000) return "#fbbf24";
  return "#4b5563";
}

interface DupeDealThresholds {
  yellow: number;
  red: number;
  source: "db" | "env";
  envDefaults: { yellow: number; red: number };
}

interface CountThresholds {
  yellow: number;
  red: number;
  source: "db" | "env";
  envDefaults: { yellow: number; red: number };
}

interface WebhookSuccessThresholds {
  yellow: number;
  red: number;
  minVolume: number;
  source: "db" | "env";
  envDefaults: { yellow: number; red: number; minVolume: number };
}

interface LeadScraperThresholds {
  staleYellow: number;
  staleRed: number;
  failRateYellow: number;
  failRateRed: number;
  zeroOutputRunsRed: number;
  source: "db" | "env";
  envDefaults: { staleYellow: number; staleRed: number; failRateYellow: number; failRateRed: number; zeroOutputRunsRed: number };
}

interface OutreachProcessorThresholds {
  staleYellow: number;
  staleRed: number;
  zeroSendYellow: number;
  zeroSendRed: number;
  source: "db" | "env";
  envDefaults: { staleYellow: number; staleRed: number; zeroSendYellow: number; zeroSendRed: number };
}

interface OutreachDeliverabilityThresholds {
  staleYellow: number;
  staleRed: number;
  failRateYellow: number;
  failRateRed: number;
  source: "db" | "env";
  envDefaults: { staleYellow: number; staleRed: number; failRateYellow: number; failRateRed: number };
}

interface StripeWebhookThresholds {
  failRateYellow: number;
  failRateRed: number;
  sigFailsRed: number;
  source: "db" | "env";
  envDefaults: { failRateYellow: number; failRateRed: number; sigFailsRed: number };
}

interface ProcoreSyncThresholds {
  staleYellow: number;
  staleRed: number;
  connStaleYellow: number;
  connStaleRed: number;
  source: "db" | "env";
  envDefaults: { staleYellow: number; staleRed: number; connStaleYellow: number; connStaleRed: number };
}

interface CronSchedulerThresholds {
  staleYellow: number;
  staleRed: number;
  source: "db" | "env";
  envDefaults: { staleYellow: number; staleRed: number };
}

function GrowthHealthPanel({
  data,
  isFetching,
  error,
  onRefresh,
  adminKey,
}: {
  data: GrowthHealthData | undefined;
  isFetching: boolean;
  error: Error | null;
  onRefresh: () => void;
  adminKey: string;
}) {
  const overall = data?.overall ?? "unknown";

  const queryClient = useQueryClient();
  const [pendingResetAll, setPendingResetAll] = useState(false);

  const { mutate: resetAllSubsystems, isPending: resetAllPending } = useMutation<void, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/admin/growth-health/reset-all", {
        method: "POST", headers: { "x-admin-key": adminKey },
      });
      const body = await res.json() as { success: boolean; error?: string };
      if (!body.success) throw new Error(body.error ?? "Failed to reset all thresholds");
    },
    onSuccess: () => {
      const allThresholdKeys = [
        "dupe-deal-thresholds",
        "pool-resets-thresholds",
        "error-rate-thresholds",
        "webhook-success-thresholds",
        "lead-scraper-thresholds",
        "outreach-processor-thresholds",
        "deliverability-thresholds",
        "stripe-webhook-thresholds",
        "procore-sync-thresholds",
        "cron-scheduler-thresholds",
      ];
      for (const key of allThresholdKeys) {
        queryClient.invalidateQueries({ queryKey: [key, adminKey] });
      }
      setPendingResetAll(false);
      onRefresh();
    },
  });
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#e5e7eb", margin: 0 }}>Growth Engine Health</h2>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            Overall: <Badge status={overall === "green" ? "ok" : overall === "red" ? "error" : overall === "yellow" ? "degraded" : "unknown"} />
            {data && (
              <span style={{ marginLeft: 12 }}>Snapshot {fmtAge(data.generatedAt)} · refreshes every 60s</span>
            )}
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={isFetching}
          style={{
            padding: "8px 14px", borderRadius: 8, background: "#1e40af", color: "#fff",
            border: "none", cursor: isFetching ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600,
          }}
        >
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 16px", color: "#f87171", marginBottom: 16, fontSize: 14 }}>
          {error.message}
        </div>
      )}
      {!data && isFetching && <div style={{ color: "#9ca3af" }}>Loading…</div>}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14, marginBottom: 24 }}>
            {data.subsystems.map((sub) => {
              const badge =
                sub.status === "green" ? "ok"
                  : sub.status === "red" ? "error"
                    : sub.status === "yellow" ? "degraded"
                      : sub.status === "paused" ? "paused"
                        : "unknown";
              return (
                <div key={sub.key} style={{
                  background: "#1a1f2e", borderRadius: 12, padding: "16px 18px",
                  borderLeft: `3px solid ${statusColor(badge)}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, color: "#e5e7eb", fontSize: 14 }}>{sub.label}</span>
                    <Badge status={badge} />
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>{sub.description}</div>
                  <div style={{ fontSize: 12, color: "#9ca3af", display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginBottom: 8 }}>
                    <span>Last success</span><span style={{ color: "#e5e7eb" }}>{fmtAge(sub.lastSuccessAt)}</span>
                    <span>Last failure</span><span style={{ color: sub.lastFailureAt ? "#fbbf24" : "#6b7280" }}>{fmtAge(sub.lastFailureAt)}</span>
                    <span>24h throughput</span><span style={{ color: "#e5e7eb" }}>{sub.throughput24h.toLocaleString()}</span>
                    <span>24h failures</span><span style={{ color: sub.failureCount24h > 0 ? "#f87171" : "#6b7280" }}>
                      {sub.failureCount24h}{sub.failureRate24h !== null ? ` (${(sub.failureRate24h * 100).toFixed(1)}%)` : ""}
                    </span>
                  </div>
                  {(() => {
                    const t = sub.meta?.thresholds as { yellow: string; red: string; label?: string; direction?: "ceil" | "floor"; currentValue?: string } | undefined;
                    if (!t || (t.yellow === "—" && t.red === "—")) return null;
                    const sym = t.direction === "floor" ? "<" : "≥";
                    const currentValueColor =
                      sub.status === "red" ? "#f87171"
                        : sub.status === "yellow" ? "#fbbf24"
                          : "#34d399";
                    return (
                      <div style={{ fontSize: 11, marginBottom: 6 }}>
                        {t.currentValue != null && (
                          <div style={{ marginBottom: 4 }}>
                            <span style={{ color: "#4b5563" }}>Current: </span>
                            <span style={{ color: currentValueColor, fontWeight: 700 }}>{t.currentValue}</span>
                            {sub.lastSuccessAt != null && (
                              <span style={{ color: stalenessColor(sub.lastSuccessAt), marginLeft: 6 }}>
                                (measured {fmtAge(sub.lastSuccessAt)})
                              </span>
                            )}
                          </div>
                        )}
                        <div>
                          <span style={{ color: "#4b5563" }}>Thresholds: </span>
                          <span style={{ color: "#d97706" }}>⚠ {sym}{t.yellow}</span>
                          {" / "}
                          <span style={{ color: "#dc2626" }}>🔴 {sym}{t.red}</span>
                          {t.label ? <span style={{ color: "#4b5563" }}> {t.label}</span> : null}
                        </div>
                      </div>
                    );
                  })()}
                  {sub.latestError && (
                    <div style={{ fontSize: 11, color: "#fbbf24", background: "rgba(245,158,11,0.08)", padding: "6px 8px", borderRadius: 6, marginBottom: 8, wordBreak: "break-word" }}>
                      {sub.latestError}
                    </div>
                  )}
                  <ul style={{ fontSize: 11, color: "#9ca3af", margin: "0 0 8px", paddingLeft: 16 }}>
                    {sub.reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                  {sub.drilldownPath && (
                    <a
                      href={sub.drilldownPath}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 11, color: "#60a5fa", textDecoration: "none" }}
                    >
                      Drill into raw data →
                    </a>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{
            background: "#1a1f2e", borderRadius: 12, padding: "16px 20px", marginBottom: 24,
            border: "1px solid rgba(255,255,255,0.06)",
            display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
          }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#e5e7eb" }}>Custom Threshold Overrides</span>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                Individual subsystem thresholds can be overridden below. Use this button to clear all overrides at once and revert every subsystem to its env-var defaults.
              </p>
            </div>
            {!pendingResetAll ? (
              <button
                onClick={() => setPendingResetAll(true)}
                disabled={resetAllPending}
                style={{
                  padding: "7px 14px", borderRadius: 7, background: "transparent", color: "#9ca3af",
                  border: "1px solid rgba(156,163,175,0.3)", cursor: "pointer", fontSize: 12, fontWeight: 500,
                  opacity: resetAllPending ? 0.7 : 1, whiteSpace: "nowrap",
                }}
              >
                {resetAllPending ? "Resetting…" : "Reset all thresholds to defaults"}
              </button>
            ) : (
              <div style={{
                display: "flex", flexDirection: "column", gap: 6,
                background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
                borderRadius: 8, padding: "8px 12px",
              }}>
                <span style={{ fontSize: 12, color: "#fca5a5", fontWeight: 600 }}>
                  This will clear every custom Watchtower threshold across all 10 subsystems.
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => resetAllSubsystems()}
                    disabled={resetAllPending}
                    style={{ padding: "5px 14px", borderRadius: 6, background: "#dc2626", color: "#fff", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: resetAllPending ? 0.7 : 1 }}
                  >
                    {resetAllPending ? "Resetting…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => setPendingResetAll(false)}
                    disabled={resetAllPending}
                    style={{ padding: "5px 14px", borderRadius: 6, background: "transparent", color: "#9ca3af", border: "1px solid rgba(156,163,175,0.3)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <WatchtowerThresholdPanel<DupeDealThresholds>
            title="Duplicate Deal Race Alert Thresholds"
            renderDescription={(d) => (
              <>
                Race counts (23505 conflicts) in the last hour that trip yellow or red.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : `env-var defaults (yellow: ${d.envDefaults.yellow}, red: ${d.envDefaults.red})`}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/dupe-deal-thresholds"
            queryKey={["dupe-deal-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "yellow", label: "Yellow threshold", color: "#fbbf24", border: "rgba(251,191,36,0.4)" },
              { key: "red", label: "Red threshold", color: "#f87171", border: "rgba(248,113,113,0.4)" },
            ]}
            initialValues={(d) => ({ yellow: String(d.yellow), red: String(d.red) })}
            buildPayload={(inp) => ({ yellow: Number(inp.yellow), red: Number(inp.red) })}
            isInvalid={(inp) => {
              const y = Number(inp.yellow); const r = Number(inp.red);
              return !Number.isFinite(y) || y < 0 || !Number.isFinite(r) || r < 0 || y >= r;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<CountThresholds>
            title="Database Pool Reset Alert Thresholds"
            renderDescription={(d) => (
              <>
                Number of pg pool resets in the last hour that trip yellow or red.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : `env-var defaults (yellow: ${d.envDefaults.yellow}, red: ${d.envDefaults.red})`}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/pool-resets-thresholds"
            queryKey={["pool-resets-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "yellow", label: "Yellow threshold", color: "#fbbf24", border: "rgba(251,191,36,0.4)" },
              { key: "red", label: "Red threshold", color: "#f87171", border: "rgba(248,113,113,0.4)" },
            ]}
            initialValues={(d) => ({ yellow: String(d.yellow), red: String(d.red) })}
            buildPayload={(inp) => ({ yellow: Number(inp.yellow), red: Number(inp.red) })}
            isInvalid={(inp) => {
              const y = Number(inp.yellow); const r = Number(inp.red);
              return !Number.isFinite(y) || y < 0 || !Number.isFinite(r) || r < 0 || y >= r;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<CountThresholds>
            title="Application Error Rate Alert Thresholds"
            renderDescription={(d) => (
              <>
                Distinct unresolved error fingerprints in the last hour that trip yellow or red.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : `env-var defaults (yellow: ${d.envDefaults.yellow}, red: ${d.envDefaults.red})`}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/error-rate-thresholds"
            queryKey={["error-rate-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "yellow", label: "Yellow threshold", color: "#fbbf24", border: "rgba(251,191,36,0.4)" },
              { key: "red", label: "Red threshold", color: "#f87171", border: "rgba(248,113,113,0.4)" },
            ]}
            initialValues={(d) => ({ yellow: String(d.yellow), red: String(d.red) })}
            buildPayload={(inp) => ({ yellow: Number(inp.yellow), red: Number(inp.red) })}
            isInvalid={(inp) => {
              const y = Number(inp.yellow); const r = Number(inp.red);
              return !Number.isFinite(y) || y < 0 || !Number.isFinite(r) || r < 0 || y >= r;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<WebhookSuccessThresholds>
            title="Outbound Webhook Success-Rate Alert Thresholds"
            renderDescription={(d) => (
              <>
                1-hour success-rate floor (enter as %). Trips when too many partner endpoints fail. Min volume sets the minimum deliveries required before evaluating.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db"
                      ? "custom DB values"
                      : `env-var defaults (yellow: ${(d.envDefaults.yellow * 100).toFixed(0)}%, red: ${(d.envDefaults.red * 100).toFixed(0)}%, minVol: ${d.envDefaults.minVolume})`}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/webhook-success-thresholds"
            queryKey={["webhook-success-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "yellow", label: "Yellow % (lower = worse)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", max: 100, step: 0.1 },
              { key: "red", label: "Red % (lower = worse)", color: "#f87171", border: "rgba(248,113,113,0.4)", max: 100, step: 0.1 },
              { key: "minVolume", label: "Min volume", color: "#9ca3af", border: "rgba(156,163,175,0.4)", step: 1 },
            ]}
            initialValues={(d) => ({
              yellow: (d.yellow * 100).toFixed(1),
              red: (d.red * 100).toFixed(1),
              minVolume: String(d.minVolume),
            })}
            buildPayload={(inp) => ({
              yellow: Number(inp.yellow) / 100,
              red: Number(inp.red) / 100,
              minVolume: Math.round(Number(inp.minVolume)),
            })}
            isInvalid={(inp) => {
              const y = Number(inp.yellow) / 100; const r = Number(inp.red) / 100;
              const mv = Math.round(Number(inp.minVolume));
              return !Number.isFinite(y) || y < 0 || y > 1 || !Number.isFinite(r) || r < 0 || r > 1 || r >= y || !Number.isFinite(mv) || mv < 0;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<LeadScraperThresholds>
            title="Lead Scraper Alert Thresholds"
            renderDescription={(d) => (
              <>
                Staleness (minutes since last success) and 24h failure rate (%) that trip yellow or red. Zero-output runs red triggers when N consecutive completed runs return 0 leads.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : "env-var defaults"}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/lead-scraper-thresholds"
            queryKey={["lead-scraper-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "staleYellow", label: "Stale yellow (min)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "staleRed", label: "Stale red (min)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
              { key: "failRateYellow", label: "Fail rate yellow (%)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "failRateRed", label: "Fail rate red (%)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
              { key: "zeroOutputRunsRed", label: "Zero-output runs red", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
            ]}
            initialValues={(d) => ({
              staleYellow: String(d.staleYellow),
              staleRed: String(d.staleRed),
              failRateYellow: (d.failRateYellow * 100).toFixed(1),
              failRateRed: (d.failRateRed * 100).toFixed(1),
              zeroOutputRunsRed: String(d.zeroOutputRunsRed),
            })}
            buildPayload={(inp) => ({
              staleYellow: Number(inp.staleYellow),
              staleRed: Number(inp.staleRed),
              failRateYellow: Number(inp.failRateYellow) / 100,
              failRateRed: Number(inp.failRateRed) / 100,
              zeroOutputRunsRed: Math.round(Number(inp.zeroOutputRunsRed)),
            })}
            isInvalid={(inp) => {
              const sy = Number(inp.staleYellow); const sr = Number(inp.staleRed);
              const fry = Number(inp.failRateYellow) / 100; const frr = Number(inp.failRateRed) / 100;
              const zzr = Math.round(Number(inp.zeroOutputRunsRed));
              return !Number.isFinite(sy) || sy < 0 || !Number.isFinite(sr) || sr < 0 || sy >= sr ||
                !Number.isFinite(fry) || fry < 0 || fry > 1 || !Number.isFinite(frr) || frr < 0 || frr > 1 || fry >= frr ||
                !Number.isFinite(zzr) || zzr < 1;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<OutreachProcessorThresholds>
            title="Outreach Processor Alert Thresholds"
            renderDescription={(d) => (
              <>
                Staleness (minutes) before the hourly cron trips yellow or red. Zero-send business hours triggers when no outbound messages are sent during UTC business hours for N consecutive hours.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : "env-var defaults"}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/outreach-processor-thresholds"
            queryKey={["outreach-processor-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "staleYellow", label: "Stale yellow (min)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "staleRed", label: "Stale red (min)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
              { key: "zeroSendYellow", label: "Zero-send yellow (hrs)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "zeroSendRed", label: "Zero-send red (hrs)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
            ]}
            initialValues={(d) => ({
              staleYellow: String(d.staleYellow),
              staleRed: String(d.staleRed),
              zeroSendYellow: String(d.zeroSendYellow),
              zeroSendRed: String(d.zeroSendRed),
            })}
            buildPayload={(inp) => ({
              staleYellow: Number(inp.staleYellow),
              staleRed: Number(inp.staleRed),
              zeroSendYellow: Number(inp.zeroSendYellow),
              zeroSendRed: Number(inp.zeroSendRed),
            })}
            isInvalid={(inp) => {
              const sy = Number(inp.staleYellow); const sr = Number(inp.staleRed);
              const zsy = Number(inp.zeroSendYellow); const zsr = Number(inp.zeroSendRed);
              return !Number.isFinite(sy) || sy < 0 || !Number.isFinite(sr) || sr < 0 || sy >= sr ||
                !Number.isFinite(zsy) || zsy < 0 || !Number.isFinite(zsr) || zsr < 0 || zsy >= zsr;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<OutreachDeliverabilityThresholds>
            title="Outreach Deliverability Alert Thresholds"
            renderDescription={(d) => (
              <>
                Staleness (minutes since last sent email) and 24h bounce+complaint rate (%) that trip yellow or red.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : "env-var defaults"}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/deliverability-thresholds"
            queryKey={["deliverability-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "staleYellow", label: "Stale yellow (min)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "staleRed", label: "Stale red (min)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
              { key: "failRateYellow", label: "Fail rate yellow (%)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "failRateRed", label: "Fail rate red (%)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
            ]}
            initialValues={(d) => ({
              staleYellow: String(d.staleYellow),
              staleRed: String(d.staleRed),
              failRateYellow: (d.failRateYellow * 100).toFixed(1),
              failRateRed: (d.failRateRed * 100).toFixed(1),
            })}
            buildPayload={(inp) => ({
              staleYellow: Number(inp.staleYellow),
              staleRed: Number(inp.staleRed),
              failRateYellow: Number(inp.failRateYellow) / 100,
              failRateRed: Number(inp.failRateRed) / 100,
            })}
            isInvalid={(inp) => {
              const sy = Number(inp.staleYellow); const sr = Number(inp.staleRed);
              const fry = Number(inp.failRateYellow) / 100; const frr = Number(inp.failRateRed) / 100;
              return !Number.isFinite(sy) || sy < 0 || !Number.isFinite(sr) || sr < 0 || sy >= sr ||
                !Number.isFinite(fry) || fry < 0 || fry > 1 || !Number.isFinite(frr) || frr < 0 || frr > 1 || fry >= frr;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<StripeWebhookThresholds>
            title="Stripe Webhook Alert Thresholds"
            renderDescription={(d) => (
              <>
                24h error rate (%) on the Stripe webhook handler. Signature failures last hour instantly trips red when count reaches the threshold.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : "env-var defaults"}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/stripe-webhook-thresholds"
            queryKey={["stripe-webhook-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "failRateYellow", label: "Fail rate yellow (%)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "failRateRed", label: "Fail rate red (%)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
              { key: "sigFailsRed", label: "Sig failures red (count)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
            ]}
            initialValues={(d) => ({
              failRateYellow: (d.failRateYellow * 100).toFixed(1),
              failRateRed: (d.failRateRed * 100).toFixed(1),
              sigFailsRed: String(d.sigFailsRed),
            })}
            buildPayload={(inp) => ({
              failRateYellow: Number(inp.failRateYellow) / 100,
              failRateRed: Number(inp.failRateRed) / 100,
              sigFailsRed: Math.round(Number(inp.sigFailsRed)),
            })}
            isInvalid={(inp) => {
              const fry = Number(inp.failRateYellow) / 100; const frr = Number(inp.failRateRed) / 100;
              const sfr = Math.round(Number(inp.sigFailsRed));
              return !Number.isFinite(fry) || fry < 0 || fry > 1 || !Number.isFinite(frr) || frr < 0 || frr > 1 || fry >= frr || !Number.isFinite(sfr) || sfr < 1;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<ProcoreSyncThresholds>
            title="Procore Sync Alert Thresholds"
            renderDescription={(d) => (
              <>
                Global staleness (minutes since any active connection synced) and per-connection staleness (minutes since each individual connection synced).
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : "env-var defaults"}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/procore-sync-thresholds"
            queryKey={["procore-sync-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "staleYellow", label: "Stale yellow (min)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "staleRed", label: "Stale red (min)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
              { key: "connStaleYellow", label: "Per-conn yellow (min)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "connStaleRed", label: "Per-conn red (min)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
            ]}
            initialValues={(d) => ({
              staleYellow: String(d.staleYellow),
              staleRed: String(d.staleRed),
              connStaleYellow: String(d.connStaleYellow),
              connStaleRed: String(d.connStaleRed),
            })}
            buildPayload={(inp) => ({
              staleYellow: Number(inp.staleYellow),
              staleRed: Number(inp.staleRed),
              connStaleYellow: Number(inp.connStaleYellow),
              connStaleRed: Number(inp.connStaleRed),
            })}
            isInvalid={(inp) => {
              const sy = Number(inp.staleYellow); const sr = Number(inp.staleRed);
              const csy = Number(inp.connStaleYellow); const csr = Number(inp.connStaleRed);
              return !Number.isFinite(sy) || sy < 0 || !Number.isFinite(sr) || sr < 0 || sy >= sr ||
                !Number.isFinite(csy) || csy < 0 || !Number.isFinite(csr) || csr < 0 || csy >= csr;
            }}
            supportsReset
          />

          <WatchtowerThresholdPanel<CronSchedulerThresholds>
            title="Cron Scheduler Alert Thresholds"
            renderDescription={(d) => (
              <>
                Minutes since the last cron heartbeat before the scheduler trips yellow or red.
                {d && (
                  <span style={{ marginLeft: 6, color: d.source === "db" ? "#34d399" : "#9ca3af" }}>
                    Currently using {d.source === "db" ? "custom DB values" : "env-var defaults"}.
                  </span>
                )}
              </>
            )}
            endpoint="/api/admin/growth-health/cron-scheduler-thresholds"
            queryKey={["cron-scheduler-thresholds"]}
            adminKey={adminKey}
            onRefresh={onRefresh}
            fields={[
              { key: "staleYellow", label: "Yellow threshold (min)", color: "#fbbf24", border: "rgba(251,191,36,0.4)", inputWidth: 110 },
              { key: "staleRed", label: "Red threshold (min)", color: "#f87171", border: "rgba(248,113,113,0.4)", inputWidth: 110 },
            ]}
            initialValues={(d) => ({ staleYellow: String(d.staleYellow), staleRed: String(d.staleRed) })}
            buildPayload={(inp) => ({ staleYellow: Number(inp.staleYellow), staleRed: Number(inp.staleRed) })}
            isInvalid={(inp) => {
              const sy = Number(inp.staleYellow); const sr = Number(inp.staleRed);
              return !Number.isFinite(sy) || sy < 0 || !Number.isFinite(sr) || sr < 0 || sy >= sr;
            }}
            supportsReset
          />

          <ThresholdAuditLogPanel adminKey={adminKey} />

          <div style={{ fontSize: 11, color: "#6b7280" }}>
            Rules in <code>server/lib/growth-health-rules.ts</code> · Runbook: <code>documents/runbook-growth-health.md</code>
          </div>
        </>
      )}
    </>
  );
}

interface ThresholdAuditEntry {
  id: number;
  subsystem: string;
  action: string;
  endpoint: string;
  changedBy: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  createdAt: number;
}

const PAGE_SIZE = 25;

const inputStyle: React.CSSProperties = {
  background: "#1a1f2e",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#e5e7eb",
  padding: "6px 10px",
  fontSize: 12,
  outline: "none",
};

function ThresholdAuditLogPanel({ adminKey }: { adminKey: string }) {
  const [expanded, setExpanded] = useState(false);
  const [subsystemFilter, setSubsystemFilter] = useState("");
  const [pendingSubsystem, setPendingSubsystem] = useState("");
  const [pendingSince, setPendingSince] = useState("");
  const [pendingUntil, setPendingUntil] = useState("");
  const [appliedSince, setAppliedSince] = useState("");
  const [appliedUntil, setAppliedUntil] = useState("");
  const [page, setPage] = useState(0);

  const offset = page * PAGE_SIZE;

  const since = appliedSince ? new Date(appliedSince + "T00:00:00Z").getTime() : undefined;
  const until = appliedUntil ? new Date(appliedUntil + "T23:59:59Z").getTime() : undefined;

  const { data: metaData, isError: metaError } = useQuery<{ totalRows: number; lastPrunedAt: number | null; retentionDays: number }>({
    queryKey: ["audit-log-meta", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/growth-health/audit-log-meta", {
        headers: { "x-admin-key": adminKey },
      });
      const body = await res.json() as { success: boolean; data?: { totalRows: number; lastPrunedAt: number | null; retentionDays: number }; error?: string };
      if (!body.success) throw new Error(body.error ?? "Failed to load audit log meta");
      return body.data!;
    },
    enabled: !!adminKey,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const { data, isFetching, error, refetch } = useQuery<{ entries: ThresholdAuditEntry[]; total: number }>({
    queryKey: ["threshold-audit-log", adminKey, subsystemFilter, since, until, page],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (subsystemFilter) params.set("subsystem", subsystemFilter);
      if (since !== undefined) params.set("since", String(since));
      if (until !== undefined) params.set("until", String(until));
      const res = await fetch(`/api/admin/growth-health/threshold-audit-log?${params}`, {
        headers: { "x-admin-key": adminKey },
      });
      const body = await res.json() as { success: boolean; data?: ThresholdAuditEntry[]; total?: number; error?: string };
      if (!body.success) throw new Error(body.error ?? "Failed to load audit log");
      return { entries: body.data ?? [], total: body.total ?? 0 };
    },
    enabled: expanded,
    staleTime: 30_000,
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function applyFilters() {
    setSubsystemFilter(pendingSubsystem);
    setAppliedSince(pendingSince);
    setAppliedUntil(pendingUntil);
    setPage(0);
  }

  function clearFilters() {
    setPendingSubsystem("");
    setPendingSince("");
    setPendingUntil("");
    setSubsystemFilter("");
    setAppliedSince("");
    setAppliedUntil("");
    setPage(0);
  }

  return (
    <div style={{
      background: "#111827",
      border: "1px solid #1f2937",
      borderRadius: 12,
      marginTop: 24,
      overflow: "hidden",
    }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 18px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "#e5e7eb",
          textAlign: "left",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>Threshold Change History</span>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {metaError ? (
            <span style={{
              fontSize: 12,
              color: "#f87171",
              background: "#1a1f2e",
              border: "1px solid #7f1d1d",
              borderRadius: 6,
              padding: "2px 10px",
            }}>
              stats unavailable
            </span>
          ) : metaData ? (
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{
                fontSize: 12,
                color: "#9ca3af",
                background: "#1a1f2e",
                border: "1px solid #374151",
                borderRadius: 6,
                padding: "2px 10px",
              }}>
                {metaData.totalRows.toLocaleString()} entries
              </span>
              <span style={{
                fontSize: 12,
                color: "#9ca3af",
                background: "#1a1f2e",
                border: "1px solid #374151",
                borderRadius: 6,
                padding: "2px 10px",
              }}>
                {metaData.lastPrunedAt
                  ? `Last pruned: ${new Date(metaData.lastPrunedAt).toLocaleString()}`
                  : "Not pruned this session"}
              </span>
              <span style={{
                fontSize: 12,
                color: "#6b7280",
                background: "#1a1f2e",
                border: "1px solid #374151",
                borderRadius: 6,
                padding: "2px 10px",
              }}>
                {metaData.retentionDays}d retention
              </span>
            </div>
          ) : null}
          <span style={{ color: "#6b7280", fontSize: 12 }}>{expanded ? "▲ collapse" : "▼ expand"}</span>
        </div>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid #1f2937", padding: "14px 18px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, marginBottom: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>Subsystem</label>
              <input
                type="text"
                placeholder="e.g. dupe-deal"
                value={pendingSubsystem}
                onChange={(e) => setPendingSubsystem(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyFilters(); }}
                style={{ ...inputStyle, width: 160 }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>From date</label>
              <input
                type="date"
                value={pendingSince}
                onChange={(e) => setPendingSince(e.target.value)}
                style={{ ...inputStyle, width: 140 }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>To date</label>
              <input
                type="date"
                value={pendingUntil}
                onChange={(e) => setPendingUntil(e.target.value)}
                style={{ ...inputStyle, width: 140 }}
              />
            </div>
            <button
              onClick={applyFilters}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                background: "#1e40af",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Apply
            </button>
            <button
              onClick={clearFilters}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                background: "transparent",
                color: "#6b7280",
                border: "1px solid #374151",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Clear
            </button>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                background: "transparent",
                color: isFetching ? "#6b7280" : "#9ca3af",
                border: "1px solid #374151",
                cursor: isFetching ? "not-allowed" : "pointer",
                fontSize: 12,
              }}
            >
              {isFetching ? "Loading…" : "Refresh"}
            </button>
          </div>

          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>
              {(error as Error).message}
            </div>
          )}

          {isFetching && entries.length === 0 && (
            <div style={{ color: "#6b7280", fontSize: 13 }}>Loading…</div>
          )}

          {!isFetching && entries.length === 0 && (
            <div style={{ color: "#6b7280", fontSize: 13 }}>No audit entries found.</div>
          )}

          {entries.length > 0 && (
            <>
              <div style={{ overflowX: "auto" }}>
                <table style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                  color: "#d1d5db",
                }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #374151" }}>
                      {["Subsystem", "Action", "Changed By", "Old Value", "New Value", "Timestamp"].map((h) => (
                        <th key={h} style={{
                          textAlign: "left",
                          padding: "6px 10px",
                          color: "#6b7280",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr
                        key={entry.id}
                        style={{ borderBottom: "1px solid #1f2937" }}
                      >
                        <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                          <span style={{ color: "#93c5fd", fontWeight: 500 }}>{entry.subsystem}</span>
                        </td>
                        <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                          <span style={{
                            color: entry.action === "reset" ? "#fbbf24" : "#34d399",
                            fontWeight: 500,
                          }}>
                            {entry.action === "set" ? "set" : entry.action === "reset" ? "reset" : entry.action}
                          </span>
                        </td>
                        <td style={{ padding: "7px 10px", color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {entry.changedBy ?? "—"}
                        </td>
                        <td style={{ padding: "7px 10px", fontFamily: "monospace", fontSize: 11, color: "#f87171", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={entry.oldValue !== null ? JSON.stringify(entry.oldValue) : undefined}>
                          {entry.oldValue !== null ? JSON.stringify(entry.oldValue) : "—"}
                        </td>
                        <td style={{ padding: "7px 10px", fontFamily: "monospace", fontSize: 11, color: "#34d399", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={entry.newValue !== null ? JSON.stringify(entry.newValue) : undefined}>
                          {entry.newValue !== null ? JSON.stringify(entry.newValue) : "—"}
                        </td>
                        <td style={{ padding: "7px 10px", color: "#6b7280", whiteSpace: "nowrap" }}>
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 12,
                fontSize: 12,
                color: "#6b7280",
              }}>
                <span>
                  {total} record{total !== 1 ? "s" : ""} · page {page + 1} of {totalPages}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0 || isFetching}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: "transparent",
                      color: page === 0 ? "#374151" : "#9ca3af",
                      border: "1px solid #374151",
                      cursor: page === 0 || isFetching ? "not-allowed" : "pointer",
                      fontSize: 12,
                    }}
                  >
                    ← Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1 || isFetching}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: "transparent",
                      color: page >= totalPages - 1 ? "#374151" : "#9ca3af",
                      border: "1px solid #374151",
                      cursor: page >= totalPages - 1 || isFetching ? "not-allowed" : "pointer",
                      fontSize: 12,
                    }}
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
