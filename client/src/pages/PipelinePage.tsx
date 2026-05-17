import React, { useState, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { StatTile, StatTileSkeleton } from "../components/ui/StatTile";
import { Modal } from "../components/ui/Modal";
import { api } from "../api/client";

interface PipelineStage {
  id: number;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isWon: boolean;
  isLost: boolean;
}

interface PipelineDeal {
  id: string;
  stageId: number;
  title: string;
  value: number;
  clientName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  description: string | null;
  projectAddress: string | null;
  projectType: string | null;
  priority: "low" | "medium" | "high" | null;
  nextAction: string | null;
  expectedStartDate: number | null;
  followUpDate: number | null;
  estimateId: string | null;
  probability: number;
  expectedCloseDate: number | null;
  wonAt: number | null;
  lostAt: number | null;
  lostReason: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

interface PipelineActivity {
  id: number;
  dealId: string;
  type: string;
  description: string;
  createdAt: number;
}

interface PipelineAttachment {
  id: string;
  dealId: string;
  fileUrl: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  createdAt: number;
}

interface PipelineAnalytics {
  totalDeals: number;
  totalValue: number;
  activeDeals: number;
  activeValue: number;
  wonDeals: number;
  wonValue: number;
  lostDeals: number;
  winRate: number;
  avgDealSize: number;
  monthlyRevenue: number;
  followUpToday: number;
  followUpOverdue: number;
  stageBreakdown: { stageId: number; stageName: string; color: string; dealCount: number; totalValue: number }[];
}

const TRADES = [
  "Roofing", "Masonry", "Concrete", "Remodeling", "Painting",
  "HVAC", "Plumbing", "Electrical", "Landscaping", "Flooring",
  "General Contracting", "Other",
];

const CANONICAL_STAGE_NAMES = [
  "Lead", "Contacted", "Site Visit Scheduled", "Estimate Sent",
  "Negotiation", "Won", "Lost",
];

type FollowUpFilter = "all" | "today" | "overdue";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dateInputValue(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dateInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value + "T12:00:00").getTime();
  return Number.isFinite(ms) ? ms : null;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function followUpStatus(ts: number | null): "overdue" | "today" | "future" | "none" {
  if (!ts) return "none";
  const todayStart = startOfToday();
  const todayEnd = endOfToday();
  if (ts < todayStart) return "overdue";
  if (ts <= todayEnd) return "today";
  return "future";
}

function priorityBadge(priority: string | null) {
  const p = priority || "medium";
  const styles: Record<string, string> = {
    high: "bg-red-500/15 text-red-400 border-red-500/30",
    medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    low: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  };
  return styles[p] || styles.medium;
}

function DealCard({ deal, onClick }: { deal: PipelineDeal; onClick: (deal: PipelineDeal) => void }) {
  const fStatus = followUpStatus(deal.followUpDate);
  const fStyles: Record<string, string> = {
    overdue: "text-red-400",
    today: "text-amber-400",
    future: "text-brand-textMuted",
    none: "text-brand-textMuted",
  };
  return (
    <div
      className="bg-brand-bg border border-brand-border rounded-lg p-3 cursor-pointer hover:border-brand-green/50 transition-colors"
      onClick={() => onClick(deal)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("dealId", deal.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h4 className="text-sm font-medium text-brand-textPrimary truncate flex-1">{deal.title}</h4>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wide font-semibold ${priorityBadge(deal.priority)}`}>
          {(deal.priority || "medium").charAt(0).toUpperCase()}
        </span>
      </div>
      {deal.value > 0 && (
        <div className="text-sm font-semibold text-brand-green mb-1">{formatCurrency(deal.value)}</div>
      )}
      {deal.clientName && (
        <p className="text-xs text-brand-textMuted truncate mb-1">{deal.clientName}</p>
      )}
      {deal.projectType && (
        <span className="inline-block text-[10px] text-brand-textMuted bg-brand-card px-1.5 py-0.5 rounded mb-2">
          {deal.projectType}
        </span>
      )}
      {deal.followUpDate && (
        <p className={`text-xs mb-2 ${fStyles[fStatus]}`}>
          {fStatus === "overdue" ? "Overdue: " : fStatus === "today" ? "Today: " : "Follow-up: "}
          {formatDate(deal.followUpDate)}
        </p>
      )}
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-brand-border rounded-full h-1.5">
          <div className="bg-brand-green h-1.5 rounded-full transition-all" style={{ width: `${deal.probability}%` }} />
        </div>
        <span className="text-xs text-brand-textMuted">{deal.probability}%</span>
      </div>
    </div>
  );
}

function StageColumn({ stage, deals, onMoveDeal, onClickDeal }: {
  stage: PipelineStage;
  deals: PipelineDeal[];
  onMoveDeal: (dealId: string, stageId: number) => void;
  onClickDeal: (deal: PipelineDeal) => void;
}) {
  const stageValue = deals.reduce((sum, d) => sum + (d.value || 0), 0);

  return (
    <div
      className="flex-shrink-0 w-72 flex flex-col"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDrop={(e) => {
        e.preventDefault();
        const dealId = e.dataTransfer.getData("dealId");
        if (dealId) onMoveDeal(dealId, stage.id);
      }}
    >
      <div className="flex items-center gap-2 mb-3 px-1">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
        <h3 className="text-sm font-semibold text-brand-textPrimary">{stage.name}</h3>
        <Badge variant="gray">{deals.length}</Badge>
      </div>
      {stageValue > 0 && (
        <p className="text-xs text-brand-textMuted mb-2 px-1">{formatCurrency(stageValue)}</p>
      )}
      <div className="flex flex-col gap-2 min-h-[100px] p-1 rounded-lg bg-brand-card/30">
        {deals.length === 0 ? (
          <p className="text-xs text-brand-textMuted/60 text-center py-6">No deals</p>
        ) : (
          deals.map(deal => (
            <DealCard key={deal.id} deal={deal} onClick={onClickDeal} />
          ))
        )}
      </div>
    </div>
  );
}

interface DealFormState {
  title: string;
  stageId: string;
  value: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  projectAddress: string;
  projectType: string;
  priority: "low" | "medium" | "high";
  nextAction: string;
  expectedStartDate: string;
  followUpDate: string;
  description: string;
}

function blankDealForm(defaultStageId: number | null): DealFormState {
  return {
    title: "",
    stageId: defaultStageId ? String(defaultStageId) : "",
    value: "",
    clientName: "",
    clientEmail: "",
    clientPhone: "",
    projectAddress: "",
    projectType: "Roofing",
    priority: "medium",
    nextAction: "",
    expectedStartDate: "",
    followUpDate: "",
    description: "",
  };
}

export default function PipelinePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<PipelineDeal | null>(null);
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpFilter>("all");
  const [tab, setTab] = useState<"board" | "analytics">("board");

  const { data: stagesData, isLoading: stagesLoading } = useQuery({
    queryKey: ["pipeline-stages"],
    queryFn: () => api.getPipelineStages(),
  });

  const { data: dealsData, isLoading: dealsLoading } = useQuery({
    queryKey: ["pipeline-deals"],
    queryFn: () => api.getPipelineDeals(),
  });

  const { data: analyticsData } = useQuery({
    queryKey: ["pipeline-analytics"],
    queryFn: () => api.getPipelineAnalytics(),
  });

  const stages = (stagesData?.data?.stages || []) as PipelineStage[];
  const deals = (dealsData?.data?.deals || []) as PipelineDeal[];
  const analytics = (analyticsData?.data || null) as PipelineAnalytics | null;

  const defaultStageId = useMemo(() => {
    const def = stages.find(s => s.isDefault);
    return def?.id ?? stages[0]?.id ?? null;
  }, [stages]);

  const isCanonical = useMemo(() => {
    if (stages.length !== CANONICAL_STAGE_NAMES.length) return false;
    const sorted = [...stages].sort((a, b) => a.position - b.position).map(s => s.name);
    return sorted.every((n, i) => n === CANONICAL_STAGE_NAMES[i]);
  }, [stages]);

  const [newDeal, setNewDeal] = useState<DealFormState>(() => blankDealForm(defaultStageId));

  const createDealMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.createPipelineDeal(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-deals"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-analytics"] });
      setShowNewDeal(false);
      setNewDeal(blankDealForm(defaultStageId));
    },
  });

  const moveDealMut = useMutation({
    mutationFn: ({ dealId, stageId }: { dealId: string; stageId: number }) =>
      api.updatePipelineDeal(dealId, { stageId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-deals"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-analytics"] });
    },
  });

  const deleteDealMut = useMutation({
    mutationFn: (dealId: string) => api.deletePipelineDeal(dealId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-deals"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-analytics"] });
      setSelectedDeal(null);
    },
  });

  const resetStagesMut = useMutation({
    mutationFn: () => api.resetCanonicalStages(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-stages"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-analytics"] });
    },
  });

  const handleMoveDeal = useCallback((dealId: string, stageId: number) => {
    moveDealMut.mutate({ dealId, stageId });
  }, [moveDealMut]);

  const handleCreateDeal = () => {
    if (!newDeal.title.trim() || !newDeal.stageId || !newDeal.projectType || !newDeal.value) return;
    createDealMut.mutate({
      title: newDeal.title,
      stageId: parseInt(newDeal.stageId),
      value: parseFloat(newDeal.value) || 0,
      clientName: newDeal.clientName || undefined,
      clientEmail: newDeal.clientEmail || undefined,
      clientPhone: newDeal.clientPhone || undefined,
      projectAddress: newDeal.projectAddress || undefined,
      projectType: newDeal.projectType || undefined,
      priority: newDeal.priority,
      nextAction: newDeal.nextAction || undefined,
      expectedStartDate: dateInputToMs(newDeal.expectedStartDate) ?? undefined,
      followUpDate: dateInputToMs(newDeal.followUpDate) ?? undefined,
      description: newDeal.description || undefined,
    });
  };

  const openNewDeal = () => {
    setNewDeal(blankDealForm(defaultStageId));
    setShowNewDeal(true);
  };

  const filteredDeals = useMemo(() => {
    if (followUpFilter === "all") return deals;
    const todayStart = startOfToday();
    const todayEnd = endOfToday();
    return deals.filter(d => {
      if (d.wonAt || d.lostAt) return false;
      if (!d.followUpDate) return false;
      if (followUpFilter === "today") return d.followUpDate >= todayStart && d.followUpDate <= todayEnd;
      if (followUpFilter === "overdue") return d.followUpDate < todayStart;
      return true;
    });
  }, [deals, followUpFilter]);

  const isLoading = stagesLoading || dealsLoading;

  return (
    <Layout>
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-brand-textPrimary">Sales Pipeline</h1>
            <p className="text-sm text-brand-textMuted mt-1">Track and manage your deals from lead to close</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex bg-brand-card rounded-lg p-1">
              <button
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${tab === "board" ? "bg-brand-green text-white" : "text-brand-textMuted hover:text-brand-textPrimary"}`}
                onClick={() => setTab("board")}
              >
                Board
              </button>
              <button
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${tab === "analytics" ? "bg-brand-green text-white" : "text-brand-textMuted hover:text-brand-textPrimary"}`}
                onClick={() => setTab("analytics")}
              >
                Analytics
              </button>
            </div>
            <Button variant="primary" size="sm" onClick={openNewDeal}>
              + New Deal
            </Button>
          </div>
        </div>

        {tab === "board" && (
          <>
            {!isCanonical && deals.length === 0 && stages.length > 0 && (
              <div className="mb-4 p-3 bg-brand-card border border-brand-border rounded-lg flex items-center justify-between gap-4 flex-wrap">
                <p className="text-xs text-brand-textMuted">
                  Your stages don't match the canonical 7-stage flow (Lead → Contacted → Site Visit → Estimate Sent → Negotiation → Won → Lost).
                </p>
                <button
                  className="text-xs text-brand-green hover:underline disabled:opacity-50"
                  disabled={resetStagesMut.isPending}
                  onClick={() => {
                    if (window.confirm("Replace your current stages with the canonical 7? Only available because no deals exist.")) {
                      resetStagesMut.mutate();
                    }
                  }}
                >
                  {resetStagesMut.isPending ? "Resetting…" : "Reset to canonical 7"}
                </button>
              </div>
            )}

            {followUpFilter !== "all" && (
              <div className="mb-4 flex items-center gap-3">
                <span className="text-xs text-brand-textMuted">
                  Showing: {followUpFilter === "today" ? "Follow-ups due today" : "Overdue follow-ups"}
                </span>
                <button
                  className="text-xs text-brand-green hover:underline"
                  onClick={() => setFollowUpFilter("all")}
                >
                  Clear filter
                </button>
              </div>
            )}

            {isLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map(i => <StatTileSkeleton key={i} />)}
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-4">
                {stages.sort((a, b) => a.position - b.position).map(stage => (
                  <StageColumn
                    key={stage.id}
                    stage={stage}
                    deals={filteredDeals.filter(d => d.stageId === stage.id)}
                    onMoveDeal={handleMoveDeal}
                    onClickDeal={setSelectedDeal}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === "analytics" && analytics && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              <StatTile label="Total Pipeline Value" value={formatCurrency(analytics.totalValue)} />
              <StatTile label="Active Deals" value={analytics.activeDeals} />
              <StatTile label="Won Deals" value={analytics.wonDeals} />
              <StatTile label="Win Rate" value={`${analytics.winRate}%`} />
              <StatTile label="Avg Deal Size" value={formatCurrency(analytics.avgDealSize)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                className="text-left"
                onClick={() => { setFollowUpFilter("today"); setTab("board"); }}
              >
                <Card className="hover:border-brand-green/50 transition-colors cursor-pointer">
                  <p className="text-xs text-brand-textMuted uppercase tracking-wide">Follow-ups Due Today</p>
                  <p className="text-2xl font-bold text-amber-400 mt-1">{analytics.followUpToday}</p>
                  <p className="text-xs text-brand-textMuted mt-1">Click to filter board</p>
                </Card>
              </button>
              <button
                className="text-left"
                onClick={() => { setFollowUpFilter("overdue"); setTab("board"); }}
              >
                <Card className="hover:border-brand-green/50 transition-colors cursor-pointer">
                  <p className="text-xs text-brand-textMuted uppercase tracking-wide">Overdue Follow-ups</p>
                  <p className="text-2xl font-bold text-red-400 mt-1">{analytics.followUpOverdue}</p>
                  <p className="text-xs text-brand-textMuted mt-1">Click to filter board</p>
                </Card>
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <h3 className="text-lg font-semibold text-brand-textPrimary mb-4">Pipeline by Stage</h3>
                <div className="space-y-3">
                  {analytics.stageBreakdown.map(s => (
                    <div key={s.stageId} className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                      <span className="text-sm text-brand-textPrimary flex-1">{s.stageName}</span>
                      <span className="text-sm font-medium text-brand-textMuted">{s.dealCount} deals</span>
                      <span className="text-sm font-semibold text-brand-green">{formatCurrency(s.totalValue)}</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold text-brand-textPrimary mb-4">Performance</h3>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-brand-textMuted">Total Pipeline Value</span>
                    <span className="text-lg font-bold text-brand-textPrimary">{formatCurrency(analytics.totalValue)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-brand-textMuted">Won Revenue</span>
                    <span className="text-lg font-bold text-brand-green">{formatCurrency(analytics.wonValue)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-brand-textMuted">30-Day Revenue</span>
                    <span className="text-lg font-bold text-brand-textPrimary">{formatCurrency(analytics.monthlyRevenue)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-brand-textMuted">Total Deals</span>
                    <span className="text-sm font-semibold text-brand-textPrimary">{analytics.totalDeals}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-brand-textMuted">Lost Deals</span>
                    <span className="text-sm font-semibold text-red-400">{analytics.lostDeals}</span>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}

        {showNewDeal && (
          <Modal open={showNewDeal} title="New Deal" onClose={() => setShowNewDeal(false)}>
            <div className="space-y-3">
              <Input
                label="Project Title *"
                value={newDeal.title}
                onChange={(e) => setNewDeal(p => ({ ...p, title: e.target.value }))}
                placeholder="e.g., Chimney rebuild — 123 Main St"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Stage *</label>
                  <select
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={newDeal.stageId}
                    onChange={(e) => setNewDeal(p => ({ ...p, stageId: e.target.value }))}
                  >
                    {stages.sort((a, b) => a.position - b.position).map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Project Type *</label>
                  <select
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={newDeal.projectType}
                    onChange={(e) => setNewDeal(p => ({ ...p, projectType: e.target.value }))}
                  >
                    {TRADES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Estimated Value ($) *"
                  type="number"
                  value={newDeal.value}
                  onChange={(e) => setNewDeal(p => ({ ...p, value: e.target.value }))}
                  placeholder="5000"
                />
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Priority</label>
                  <select
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={newDeal.priority}
                    onChange={(e) => setNewDeal(p => ({ ...p, priority: e.target.value as "low" | "medium" | "high" }))}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
              <Input
                label="Client Name"
                value={newDeal.clientName}
                onChange={(e) => setNewDeal(p => ({ ...p, clientName: e.target.value }))}
                placeholder="John Smith"
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Phone"
                  value={newDeal.clientPhone}
                  onChange={(e) => setNewDeal(p => ({ ...p, clientPhone: e.target.value }))}
                  placeholder="(555) 123-4567"
                />
                <Input
                  label="Email"
                  type="email"
                  value={newDeal.clientEmail}
                  onChange={(e) => setNewDeal(p => ({ ...p, clientEmail: e.target.value }))}
                  placeholder="john@example.com"
                />
              </div>
              <Input
                label="Project Address"
                value={newDeal.projectAddress}
                onChange={(e) => setNewDeal(p => ({ ...p, projectAddress: e.target.value }))}
                placeholder="123 Main St, Galena IL"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Expected Start</label>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={newDeal.expectedStartDate}
                    onChange={(e) => setNewDeal(p => ({ ...p, expectedStartDate: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Follow-up Date</label>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={newDeal.followUpDate}
                    onChange={(e) => setNewDeal(p => ({ ...p, followUpDate: e.target.value }))}
                  />
                </div>
              </div>
              <Input
                label="Next Action"
                value={newDeal.nextAction}
                onChange={(e) => setNewDeal(p => ({ ...p, nextAction: e.target.value }))}
                placeholder="Call to schedule site visit"
              />
              <div>
                <label className="block text-sm font-medium text-brand-textPrimary mb-1">Description / Scope</label>
                <textarea
                  className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary placeholder-brand-textMuted focus:outline-none focus:ring-2 focus:ring-brand-green/50"
                  value={newDeal.description}
                  onChange={(e) => setNewDeal(p => ({ ...p, description: e.target.value }))}
                  rows={3}
                  placeholder="Notes about this deal..."
                />
              </div>
              {createDealMut.isError && (
                <p className="text-sm text-red-400">Failed to create deal. Please try again.</p>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="ghost" size="sm" onClick={() => setShowNewDeal(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCreateDeal}
                  disabled={
                    createDealMut.isPending ||
                    !newDeal.title.trim() ||
                    !newDeal.stageId ||
                    !newDeal.projectType ||
                    !newDeal.value
                  }
                >
                  {createDealMut.isPending ? "Creating..." : "Create Deal"}
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {selectedDeal && (
          <DealDetailDrawer
            deal={selectedDeal}
            stages={stages}
            onClose={() => setSelectedDeal(null)}
            onMove={handleMoveDeal}
            onDelete={(id) => {
              if (window.confirm("Delete this deal? This cannot be undone.")) {
                deleteDealMut.mutate(id);
              }
            }}
            onConvert={(id) => navigate(`/app/estimates/${id}`)}
          />
        )}
      </div>
    </Layout>
  );
}

function DealDetailDrawer({ deal, stages, onClose, onMove, onDelete, onConvert }: {
  deal: PipelineDeal;
  stages: PipelineStage[];
  onClose: () => void;
  onMove: (dealId: string, stageId: number) => void;
  onDelete: (dealId: string) => void;
  onConvert: (newEstimateId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({
    title: deal.title,
    value: String(deal.value || ""),
    clientName: deal.clientName || "",
    clientEmail: deal.clientEmail || "",
    clientPhone: deal.clientPhone || "",
    projectAddress: deal.projectAddress || "",
    projectType: deal.projectType || "Roofing",
    priority: (deal.priority || "medium") as "low" | "medium" | "high",
    nextAction: deal.nextAction || "",
    expectedStartDate: dateInputValue(deal.expectedStartDate),
    followUpDate: dateInputValue(deal.followUpDate),
    description: deal.description || "",
  });
  const [noteText, setNoteText] = useState("");
  const [showLostInput, setShowLostInput] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: activitiesData } = useQuery({
    queryKey: ["deal-activities", deal.id],
    queryFn: () => api.getDealActivities(deal.id),
  });

  const { data: attachmentsData } = useQuery({
    queryKey: ["deal-attachments", deal.id],
    queryFn: () => api.getDealAttachments(deal.id),
  });

  const activities = (activitiesData?.data?.activities || []) as PipelineActivity[];
  const attachments = (attachmentsData?.data?.attachments || []) as PipelineAttachment[];
  const currentStage = stages.find(s => s.id === deal.stageId);
  const wonStage = stages.find(s => s.isWon);
  const lostStage = stages.find(s => s.isLost);

  const updateMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.updatePipelineDeal(deal.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-deals"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-analytics"] });
      setEditing(false);
    },
  });

  const noteMut = useMutation({
    mutationFn: (text: string) => api.addDealActivity(deal.id, { type: "note", description: text }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deal-activities", deal.id] });
      setNoteText("");
    },
  });

  const uploadMut = useMutation({
    mutationFn: (file: File) => api.uploadDealAttachment(deal.id, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deal-attachments", deal.id] });
      queryClient.invalidateQueries({ queryKey: ["deal-activities", deal.id] });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const deleteAttachmentMut = useMutation({
    mutationFn: (attachmentId: string) => api.deleteDealAttachment(attachmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deal-attachments", deal.id] });
      queryClient.invalidateQueries({ queryKey: ["deal-activities", deal.id] });
    },
  });

  const convertMut = useMutation({
    mutationFn: () => api.convertDealToEstimate(deal.id),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-deals"] });
      queryClient.invalidateQueries({ queryKey: ["deal-activities", deal.id] });
      const newId = (res as { data?: { estimateId?: string } })?.data?.estimateId;
      if (newId) onConvert(newId);
    },
  });

  const handleSaveEdit = () => {
    updateMut.mutate({
      title: edit.title,
      value: parseFloat(edit.value) || 0,
      clientName: edit.clientName || null,
      clientEmail: edit.clientEmail || null,
      clientPhone: edit.clientPhone || null,
      projectAddress: edit.projectAddress || null,
      projectType: edit.projectType || null,
      priority: edit.priority,
      nextAction: edit.nextAction || null,
      expectedStartDate: dateInputToMs(edit.expectedStartDate),
      followUpDate: dateInputToMs(edit.followUpDate),
      description: edit.description || null,
    });
  };

  const handleMarkWon = () => {
    if (!wonStage) return;
    onMove(deal.id, wonStage.id);
  };

  const handleMarkLost = () => {
    if (!lostStage) return;
    if (!showLostInput) {
      setShowLostInput(true);
      return;
    }
    updateMut.mutate({ stageId: lostStage.id, lostReason: lostReason || undefined });
    setShowLostInput(false);
  };

  const fStatus = followUpStatus(deal.followUpDate);
  const fColor = fStatus === "overdue" ? "text-red-400" : fStatus === "today" ? "text-amber-400" : "text-brand-textPrimary";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-brand-card border-l border-brand-border overflow-y-auto">
        <div className="p-6">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-brand-textPrimary">{deal.title}</h2>
              {deal.value > 0 && (
                <p className="text-lg font-semibold text-brand-green mt-1">{formatCurrency(deal.value)}</p>
              )}
            </div>
            <button onClick={onClose} className="text-brand-textMuted hover:text-brand-textPrimary" aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 4L16 16M16 4L4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </div>

          {!editing ? (
            <div className="space-y-4 mb-6">
              <div>
                <label className="text-xs text-brand-textMuted uppercase tracking-wide">Stage</label>
                <div className="flex items-center gap-2 mt-1">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: currentStage?.color }} />
                  <select
                    className="bg-brand-bg border border-brand-border rounded-lg px-3 py-1.5 text-sm text-brand-textPrimary"
                    value={deal.stageId}
                    onChange={(e) => onMove(deal.id, parseInt(e.target.value))}
                  >
                    {stages.sort((a, b) => a.position - b.position).map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Priority</label>
                  <p className="text-sm text-brand-textPrimary mt-1 capitalize">{deal.priority || "medium"}</p>
                </div>
                {deal.projectType && (
                  <div>
                    <label className="text-xs text-brand-textMuted uppercase tracking-wide">Project Type</label>
                    <p className="text-sm text-brand-textPrimary mt-1">{deal.projectType}</p>
                  </div>
                )}
              </div>

              {deal.clientName && (
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Client</label>
                  <p className="text-sm text-brand-textPrimary mt-1">{deal.clientName}</p>
                </div>
              )}
              {deal.clientPhone && (
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Phone</label>
                  <p className="text-sm text-brand-textPrimary mt-1">{deal.clientPhone}</p>
                </div>
              )}
              {deal.clientEmail && (
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Email</label>
                  <p className="text-sm text-brand-textPrimary mt-1">{deal.clientEmail}</p>
                </div>
              )}
              {deal.projectAddress && (
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Address</label>
                  <p className="text-sm text-brand-textPrimary mt-1">{deal.projectAddress}</p>
                </div>
              )}
              {deal.nextAction && (
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Next Action</label>
                  <p className="text-sm text-brand-textPrimary mt-1">{deal.nextAction}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                {deal.followUpDate && (
                  <div>
                    <label className="text-xs text-brand-textMuted uppercase tracking-wide">Follow-up</label>
                    <p className={`text-sm mt-1 ${fColor}`}>{formatDate(deal.followUpDate)}</p>
                  </div>
                )}
                {deal.expectedStartDate && (
                  <div>
                    <label className="text-xs text-brand-textMuted uppercase tracking-wide">Expected Start</label>
                    <p className="text-sm text-brand-textPrimary mt-1">{formatDate(deal.expectedStartDate)}</p>
                  </div>
                )}
              </div>
              {deal.description && (
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Description</label>
                  <p className="text-sm text-brand-textPrimary mt-1 whitespace-pre-wrap">{deal.description}</p>
                </div>
              )}
              <div className="flex items-center gap-4">
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Probability</label>
                  <p className="text-sm font-semibold text-brand-textPrimary mt-1">{deal.probability}%</p>
                </div>
                <div>
                  <label className="text-xs text-brand-textMuted uppercase tracking-wide">Created</label>
                  <p className="text-sm text-brand-textPrimary mt-1">{formatDate(deal.createdAt)}</p>
                </div>
              </div>

              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit deal</Button>
            </div>
          ) : (
            <div className="space-y-3 mb-6">
              <Input label="Title" value={edit.title} onChange={(e) => setEdit(p => ({ ...p, title: e.target.value }))} />
              <Input label="Value" type="number" value={edit.value} onChange={(e) => setEdit(p => ({ ...p, value: e.target.value }))} />
              <Input label="Client Name" value={edit.clientName} onChange={(e) => setEdit(p => ({ ...p, clientName: e.target.value }))} />
              <Input label="Phone" value={edit.clientPhone} onChange={(e) => setEdit(p => ({ ...p, clientPhone: e.target.value }))} />
              <Input label="Email" value={edit.clientEmail} onChange={(e) => setEdit(p => ({ ...p, clientEmail: e.target.value }))} />
              <Input label="Address" value={edit.projectAddress} onChange={(e) => setEdit(p => ({ ...p, projectAddress: e.target.value }))} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Project Type</label>
                  <select
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={edit.projectType}
                    onChange={(e) => setEdit(p => ({ ...p, projectType: e.target.value }))}
                  >
                    {TRADES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Priority</label>
                  <select
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={edit.priority}
                    onChange={(e) => setEdit(p => ({ ...p, priority: e.target.value as "low" | "medium" | "high" }))}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
              <Input label="Next Action" value={edit.nextAction} onChange={(e) => setEdit(p => ({ ...p, nextAction: e.target.value }))} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Expected Start</label>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={edit.expectedStartDate}
                    onChange={(e) => setEdit(p => ({ ...p, expectedStartDate: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-brand-textPrimary mb-1">Follow-up</label>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                    value={edit.followUpDate}
                    onChange={(e) => setEdit(p => ({ ...p, followUpDate: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-brand-textPrimary mb-1">Description</label>
                <textarea
                  className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
                  value={edit.description}
                  onChange={(e) => setEdit(p => ({ ...p, description: e.target.value }))}
                  rows={3}
                />
              </div>
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={handleSaveEdit} disabled={updateMut.isPending}>
                  {updateMut.isPending ? "Saving…" : "Save"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          {!editing && (
            <div className="border-t border-brand-border pt-4 mb-4 space-y-2">
              <div className="flex gap-2 flex-wrap">
                {wonStage && deal.stageId !== wonStage.id && (
                  <Button variant="primary" size="sm" onClick={handleMarkWon}>Mark Won</Button>
                )}
                {lostStage && deal.stageId !== lostStage.id && (
                  <Button variant="ghost" size="sm" onClick={handleMarkLost} className="text-red-400 hover:text-red-300">
                    {showLostInput ? "Confirm Lost" : "Mark Lost"}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => convertMut.mutate()}
                  disabled={convertMut.isPending || !!deal.estimateId}
                  title={deal.estimateId ? "Already converted" : ""}
                >
                  {convertMut.isPending ? "Converting…" : deal.estimateId ? "Estimate Linked" : "Convert to Estimate"}
                </Button>
              </div>
              {showLostInput && (
                <Input
                  label="Lost reason (optional)"
                  value={lostReason}
                  onChange={(e) => setLostReason(e.target.value)}
                  placeholder="Price, timing, competitor..."
                />
              )}
            </div>
          )}

          {/* Notes */}
          <div className="border-t border-brand-border pt-4 mb-4">
            <h3 className="text-sm font-semibold text-brand-textPrimary mb-2">Add Note</h3>
            <textarea
              className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={2}
              placeholder="Add a quick note..."
            />
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={!noteText.trim() || noteMut.isPending}
              onClick={() => noteMut.mutate(noteText.trim())}
            >
              {noteMut.isPending ? "Adding…" : "Add Note"}
            </Button>
          </div>

          {/* Attachments */}
          <div className="border-t border-brand-border pt-4 mb-4">
            <h3 className="text-sm font-semibold text-brand-textPrimary mb-2">Attachments</h3>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="text-xs text-brand-textMuted file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-brand-card file:text-brand-textPrimary"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadMut.mutate(f);
              }}
              disabled={uploadMut.isPending}
            />
            {uploadMut.isPending && <p className="text-xs text-brand-textMuted mt-1">Uploading…</p>}
            {uploadMut.isError && <p className="text-xs text-red-400 mt-1">Upload failed</p>}
            <div className="mt-3 space-y-2">
              {attachments.length === 0 ? (
                <p className="text-xs text-brand-textMuted">No attachments yet</p>
              ) : (
                attachments.map(att => (
                  <div key={att.id} className="flex items-center gap-2 text-sm">
                    <a
                      href={att.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-green hover:underline truncate flex-1"
                    >
                      {att.fileName}
                    </a>
                    <span className="text-xs text-brand-textMuted">{Math.round(att.sizeBytes / 1024)}kb</span>
                    <button
                      className="text-xs text-red-400 hover:text-red-300"
                      onClick={() => {
                        if (window.confirm(`Delete ${att.fileName}?`)) {
                          deleteAttachmentMut.mutate(att.id);
                        }
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Activity timeline */}
          <div className="border-t border-brand-border pt-4 mb-4">
            <h3 className="text-sm font-semibold text-brand-textPrimary mb-3">Activity Timeline</h3>
            {activities.length === 0 ? (
              <p className="text-sm text-brand-textMuted">No activities yet</p>
            ) : (
              <div className="space-y-3">
                {activities.map(act => (
                  <div key={act.id} className="flex gap-3">
                    <div className="w-2 h-2 rounded-full bg-brand-green mt-1.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-brand-textPrimary whitespace-pre-wrap">{act.description}</p>
                      <p className="text-xs text-brand-textMuted">{formatDate(act.createdAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-brand-border pt-4">
            <Button variant="ghost" size="sm" onClick={() => onDelete(deal.id)} className="text-red-400 hover:text-red-300">
              Delete Deal
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
