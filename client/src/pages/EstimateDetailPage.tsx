import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Alert } from "../components/ui/Alert";
import { EstimateBreakdownCard } from "../components/ui/EstimateBreakdownCard";
import { StructuredLineItemsTable } from "../components/ui/StructuredLineItemsTable";
import { ProBidCoreSendButton } from "../components/ui/ProBidCoreSendButton";
import { WonLostPrompt } from "../components/WonLostPrompt";
import { api } from "../api/client";
import { track } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ProcorePushButton({ estimateId }: { estimateId: string }) {
  const [showModal, setShowModal] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const queryClient = useQueryClient();

  const entitlements = useQuery({
    queryKey: ["entitlements"],
    queryFn: () => api.getEntitlements().then((r) => r.data),
    staleTime: 60000,
  });

  const pushStatus = useQuery({
    queryKey: ["procore-push-status", estimateId],
    queryFn: () => api.getProcorePushStatus(estimateId).then((r) => r.data),
    staleTime: 30000,
  });

  const connections = useQuery({
    queryKey: ["procore-connections"],
    queryFn: () => api.getProcoreConnections().then((r) => r.data),
    enabled: entitlements.data?.procore === true,
    staleTime: 60000,
  });

  const projects = useQuery({
    queryKey: ["procore-all-projects"],
    queryFn: () => api.getAllProcoreProjects().then((r) => r.data),
    enabled: showModal && mode === "existing" && (connections.data?.connections?.length ?? 0) > 0,
    staleTime: 30000,
  });

  const pushMutation = useMutation({
    mutationFn: (opts: { createNew: boolean; procoreProjectId?: string }) =>
      api.pushEstimateToProcore(estimateId, opts),
    onSuccess: (res) => {
      track("procore_estimate_pushed", {
        estimateId,
        procoreProjectId: res.data?.procoreProjectId,
        budgetItems: res.data?.budgetItemsPushed,
        pdfUploaded: res.data?.pdfUploaded,
        mode,
      });
      queryClient.invalidateQueries({ queryKey: ["procore-push-status", estimateId] });
      setShowModal(false);
    },
  });

  if (!entitlements.data?.procore) return null;

  const hasConnection = (connections.data?.connections?.length ?? 0) > 0;

  if (pushStatus.data) {
    return (
      <Card className="mt-4 border-brand-green/30 bg-brand-green/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand-green/10 border border-brand-green/20 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-brand-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-brand-textPrimary">Sent to Procore</p>
            <p className="text-xs text-brand-textMuted truncate">
              {pushStatus.data.projectName} — {pushStatus.data.budgetItemsPushed} line items, PDF {pushStatus.data.pdfUploaded ? "attached" : "skipped"}
            </p>
          </div>
          {pushStatus.data.procoreProjectUrl && (
            <a
              href={pushStatus.data.procoreProjectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-brand-green hover:underline shrink-0"
            >
              Open in Procore
            </a>
          )}
        </div>
      </Card>
    );
  }

  if (!hasConnection) {
    return (
      <Card className="mt-4 border-brand-indigo/20 bg-brand-indigo/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand-indigo/10 border border-brand-indigo/20 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-brand-indigo" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-brand-textPrimary">Send to Procore</p>
            <p className="text-xs text-brand-textMuted">Connect your Procore account to push estimates as projects.</p>
          </div>
          <Link to="/app/procore">
            <Button variant="ghost" className="text-xs">Connect</Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        fullWidth
        onClick={() => {
          track("procore_push_modal_opened", { estimateId });
          setShowModal(true);
        }}
        className="border-brand-indigo/30 hover:border-brand-indigo/50 text-brand-indigo"
      >
        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        Send to Procore
      </Button>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-brand-card border border-brand-border rounded-2xl p-6 max-w-md w-full shadow-xl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-brand-textPrimary">Send to Procore</h2>
              <button onClick={() => setShowModal(false)} className="text-brand-textSubtle hover:text-brand-textMuted">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-sm text-brand-textMuted mb-4">
              Push this estimate into Procore as a project with budget line items and the PDF attached.
            </p>

            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setMode("new")}
                className={`flex-1 py-2.5 px-3 rounded-lg text-sm font-medium border transition-colors ${
                  mode === "new"
                    ? "border-brand-green bg-brand-green/10 text-brand-green"
                    : "border-brand-border text-brand-textMuted hover:border-brand-textSubtle"
                }`}
              >
                Create New Project
              </button>
              <button
                onClick={() => setMode("existing")}
                className={`flex-1 py-2.5 px-3 rounded-lg text-sm font-medium border transition-colors ${
                  mode === "existing"
                    ? "border-brand-green bg-brand-green/10 text-brand-green"
                    : "border-brand-border text-brand-textMuted hover:border-brand-textSubtle"
                }`}
              >
                Link to Existing
              </button>
            </div>

            {mode === "new" ? (
              <div className="bg-brand-bg/60 border border-brand-border rounded-lg p-3 mb-4">
                <p className="text-xs text-brand-textMuted">
                  A new project will be created in Procore with the estimate details, budget line items, and PDF.
                </p>
              </div>
            ) : (
              <div className="mb-4">
                {projects.isLoading ? (
                  <div className="animate-pulse h-10 bg-brand-border rounded-lg" />
                ) : (projects.data?.length ?? 0) === 0 ? (
                  <p className="text-xs text-brand-textSubtle">No projects found in your Procore account.</p>
                ) : (
                  <select
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                    className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-sm text-brand-textPrimary focus:outline-none focus:border-brand-green"
                  >
                    <option value="">Select a project...</option>
                    {(projects.data || []).map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name} {p.project_number ? `(${p.project_number})` : ""} — {p.status || "Active"}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {pushMutation.isError && (
              <Alert type="error" className="mb-4 text-xs">
                {(pushMutation.error as any)?.message || "Failed to push estimate. Please try again."}
              </Alert>
            )}

            <div className="flex gap-3">
              <Button
                variant="ghost"
                onClick={() => setShowModal(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (mode === "new") {
                    pushMutation.mutate({ createNew: true });
                  } else {
                    pushMutation.mutate({ createNew: false, procoreProjectId: selectedProjectId });
                  }
                }}
                disabled={pushMutation.isPending || (mode === "existing" && !selectedProjectId)}
                className="flex-1"
              >
                {pushMutation.isPending ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Pushing...
                  </span>
                ) : (
                  "Send to Procore"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function EstimateDetailPage() {
  const { id } = useParams<{ id: string }>();

  usePageMeta({
    title: "Estimate Details | ProBid AI",
    description: "View your saved construction estimate with full cost breakdown and PDF download.",
    canonical: id ? `https://probidcore.net/app/estimates/${id}` : undefined,
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: ["estimate", id],
    queryFn: () => api.getEstimate(id!).then((r) => r.data),
    enabled: !!id,
  });

  const handleDownloadPdf = () => {
    track("pdf_download", { estimateId: id });
    window.open(`/estimate/${id}/pdf`, "_blank");
  };

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <Link
          to="/app/history"
          className="inline-flex items-center gap-1 text-sm text-brand-textSubtle hover:text-brand-textMuted mb-6 transition-colors"
        >
          ← Back to History
        </Link>

        {isLoading ? (
          <div className="flex flex-col gap-4">
            <div className="animate-pulse h-8 w-48 bg-brand-border rounded" />
            <div className="animate-pulse h-4 w-32 bg-brand-border rounded" />
            <Card>
              <div className="animate-pulse space-y-4 p-2">
                <div className="h-4 bg-brand-border rounded" />
                <div className="h-4 bg-brand-border rounded w-3/4" />
                <div className="h-32 bg-brand-border rounded" />
              </div>
            </Card>
          </div>
        ) : isError || !data ? (
          <Alert type="error">
            Estimate not found or you don't have access to it.{" "}
            <Link to="/app/history" className="underline">View history</Link>
          </Alert>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-3xl font-black text-brand-textPrimary capitalize">
                {data.name || data.jobType}
              </h1>
              <p className="text-brand-textSubtle text-sm mt-1">
                {formatDate(data.createdAt)}
                {data.source ? ` · ${data.source}` : ""}
              </p>
            </div>

            {data.lineItems && data.lineItems.length > 0 ? (
              <StructuredLineItemsTable
                lineItems={data.lineItems}
                totals={data.totals ?? undefined}
                jobType={data.jobType}
                market={data.market}
              />
            ) : (
              <EstimateBreakdownCard
                rawText={data.estimateText}
                jobType={data.jobType}
                market={data.market}
              />
            )}

            {(data.clientName || data.clientEmail || data.clientPhone) && (
              <Card className="mt-4">
                <h3 className="text-sm font-semibold text-brand-textMuted mb-3">Client Information</h3>
                <div className="flex flex-col gap-1.5 text-sm text-brand-textMuted">
                  {data.clientName && <p><span className="text-brand-textSubtle">Name:</span> {data.clientName}</p>}
                  {data.clientEmail && <p><span className="text-brand-textSubtle">Email:</span> {data.clientEmail}</p>}
                  {data.clientPhone && <p><span className="text-brand-textSubtle">Phone:</span> {data.clientPhone}</p>}
                </div>
              </Card>
            )}

            {data.details && (
              <Card className="mt-4">
                <h3 className="text-sm font-semibold text-brand-textMuted mb-2">Job Description</h3>
                <p className="text-sm text-brand-textMuted leading-relaxed">{data.details}</p>
              </Card>
            )}

            {id && <ProcorePushButton estimateId={id} />}

            {id && (
              <ProBidCoreSendButton
                estimateId={id}
                estimateName={data.jobType || "Untitled Estimate"}
              />
            )}

            <div className="flex flex-col sm:flex-row gap-3 mt-6">
              <Button variant="primary" onClick={handleDownloadPdf} fullWidth>
                Download PDF
              </Button>
              {data.lineItems && data.lineItems.length > 0 && id && (
                <>
                  <Link to={`/app/estimate/builder?edit=${id}`} className="flex-1">
                    <Button variant="secondary" fullWidth>Edit</Button>
                  </Link>
                  <Link to={`/app/estimate/builder?clone=${id}`} className="flex-1">
                    <Button variant="ghost" fullWidth>Duplicate &amp; Edit</Button>
                  </Link>
                </>
              )}
              <Link to="/app/estimate/new" className="flex-1">
                <Button variant="ghost" fullWidth>New Estimate</Button>
              </Link>
            </div>

            <WonLostPrompt estimateId={id!} initialStatus={data.wonLostStatus ?? null} />

            <Card className="mt-6 bg-gradient-to-r from-brand-green/5 to-brand-indigo/5 border-brand-green/20">
              <div className="text-center">
                <p className="text-sm font-bold text-brand-textPrimary mb-1">Know a contractor who'd find this useful?</p>
                <p className="text-xs text-brand-textMuted mb-3">
                  Earn 20% recurring commission for every contractor you refer to ProBid AI.
                </p>
                <Link to="/app/affiliate">
                  <Button variant="ghost" className="text-sm">
                    Get Your Referral Link
                  </Button>
                </Link>
              </div>
            </Card>
          </>
        )}
      </div>
    </Layout>
  );
}
