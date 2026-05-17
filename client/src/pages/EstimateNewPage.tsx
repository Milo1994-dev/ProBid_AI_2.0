import React, { useState, useRef, useCallback, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Button } from "../components/ui/Button";
import { Textarea } from "../components/ui/Input";
import { Alert } from "../components/ui/Alert";
import { EstimateBreakdownCard } from "../components/ui/EstimateBreakdownCard";
import { UpgradeModal } from "../components/ui/UpgradeModal";
import { ShareToUnlockModal } from "../components/ui/ShareToUnlockModal";
import { ReviewPrompt } from "../components/ui/ReviewPrompt";
import { VoiceDictation } from "../components/ui/VoiceDictation";
import { api, EstimateResult } from "../api/client";
import { track, generateEventId } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";
import { useAuth } from "../contexts/AuthContext";

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const ACCEPTED_ATTR = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
const MAX_SIZE_MB = 10;
const MAX_FILES = 5;

interface FileError { file: string; error: string }

function validateFiles(files: File[]): { valid: File[]; errors: FileError[] } {
  const valid: File[] = [];
  const errors: FileError[] = [];
  for (const file of files) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      errors.push({ file: file.name, error: "Unsupported file type. Use JPG, PNG, WebP, or HEIC." });
      continue;
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      errors.push({ file: file.name, error: `File exceeds ${MAX_SIZE_MB}MB limit.` });
      continue;
    }
    valid.push(file);
  }
  return { valid, errors };
}

const loadingMessages = [
  "Analyzing project...",
  "Calculating materials...",
  "Estimating labor...",
  "Building your estimate...",
];

function LoadingState() {
  const [messageIndex, setMessageIndex] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const msgInterval = setInterval(() => {
      setMessageIndex((i) => (i < loadingMessages.length - 1 ? i + 1 : i));
    }, 4000);
    const progInterval = setInterval(() => {
      setProgress((p) => Math.min(p + Math.random() * 8 + 2, 92));
    }, 600);
    return () => {
      clearInterval(msgInterval);
      clearInterval(progInterval);
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center py-16 gap-6">
      <div className="relative w-20 h-20">
        <div className="absolute inset-0 rounded-full border-4 border-brand-border" />
        <div className="absolute inset-0 rounded-full border-4 border-brand-green border-t-transparent animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl">⚡</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-lg font-bold text-brand-textPrimary mb-2">
          {loadingMessages[messageIndex]}
        </p>
        <p className="text-sm text-brand-textMuted">This usually takes 10–30 seconds</p>
      </div>
      <div className="w-64 h-2 bg-brand-border rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-green rounded-full transition-all duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

interface PaywallProps {
  onSinglePurchase: () => void;
  onSubscribe: () => void;
  singleLoading: boolean;
  subLoading: boolean;
}

function Paywall({ onSinglePurchase, onSubscribe, singleLoading, subLoading }: PaywallProps) {
  return (
    <div className="bg-brand-card border border-brand-green/30 rounded-2xl p-6 sm:p-8">
      <div className="text-center mb-6">
        <div className="text-4xl mb-3">🔓</div>
        <h3 className="text-xl font-black text-brand-textPrimary mb-2">
          Want to unlock this estimate?
        </h3>
        <p className="text-sm text-brand-textMuted max-w-md mx-auto">
          Get full access to download, save, and reuse your professional estimate.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-6 text-sm text-brand-textMuted">
        {[
          "Download as professional PDF",
          "Save and manage jobs",
          "Unlimited estimates",
          "Client-ready reports",
        ].map((b) => (
          <div key={b} className="flex items-center gap-2">
            <svg className="w-4 h-4 text-brand-green shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            <span>{b}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="border border-brand-border rounded-xl p-5 flex flex-col">
          <p className="text-xs font-semibold text-brand-textSubtle uppercase tracking-wider mb-1">One-Time</p>
          <div className="flex items-end gap-1 mb-3">
            <span className="text-3xl font-black text-brand-textPrimary">$7</span>
            <span className="text-brand-textSubtle text-sm mb-1">/ estimate</span>
          </div>
          <p className="text-xs text-brand-textMuted mb-4 flex-1">Unlock this single estimate with full PDF download.</p>
          <Button
            variant="secondary"
            fullWidth
            loading={singleLoading}
            disabled={subLoading}
            onClick={onSinglePurchase}
          >
            Unlock This Estimate
          </Button>
        </div>

        <div className="relative border border-brand-green rounded-xl p-5 flex flex-col bg-gradient-to-b from-brand-green/5 to-transparent">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-brand-green text-gray-900 text-xs font-bold px-3 py-1 rounded-full">Best Value</span>
          </div>
          <p className="text-xs font-semibold text-brand-green uppercase tracking-wider mb-1">Pro</p>
          <div className="flex items-end gap-1 mb-3">
            <span className="text-3xl font-black text-brand-textPrimary">$25</span>
            <span className="text-brand-textSubtle text-sm mb-1">/month</span>
          </div>
          <p className="text-xs text-brand-textMuted mb-4 flex-1">Unlimited estimates, saved history, PDF exports, and client-ready reports.</p>
          <Button
            variant="primary"
            fullWidth
            loading={subLoading}
            disabled={singleLoading}
            onClick={onSubscribe}
          >
            Start Free Trial
          </Button>
        </div>
      </div>

      <p className="text-center text-xs text-brand-textSubtle mt-4">
        7-day free trial on Pro · Cancel anytime · Secure Stripe checkout
      </p>
    </div>
  );
}

export default function EstimateNewPage() {
  usePageMeta({
    title: "New Estimate | ProBid AI",
    description: "Generate an AI-powered construction estimate in seconds.",
    canonical: "https://probidcore.net/app/estimate/new",
  });

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [fileErrors, setFileErrors] = useState<FileError[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareModalContext, setShareModalContext] = useState<"first_estimate" | "limit_reached">("first_estimate");
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const [hasExistingReview, setHasExistingReview] = useState(false);
  const [singleCheckoutLoading, setSingleCheckoutLoading] = useState(false);
  const [subCheckoutLoading, setSubCheckoutLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const usageQuery = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.getUsage().then((r) => r.data),
  });

  const usage = usageQuery.data;
  const isPaid = usage?.isUnlimited === true || (usage?.singleCredits ?? 0) > 0;

  useEffect(() => {
    if (searchParams.get("purchased") === "single") {
      // Re-use the event_id we minted at checkout (round-tripped via
      // success_url) so this browser Pixel `checkout_success` dedupes
      // against the Stripe-webhook server CAPI Purchase event.
      const eid = searchParams.get("meta_event_id") || undefined;
      track("checkout_success", { type: "single_estimate" }, eid);
      queryClient.invalidateQueries({ queryKey: ["usage"] });
    }
  }, [searchParams]);

  useEffect(() => {
    track("estimate_flow_started");
  }, []);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const arr = Array.from(incoming);
    const remaining = MAX_FILES - files.length;
    if (remaining <= 0) {
      setFileErrors([{ file: "", error: `Maximum ${MAX_FILES} images allowed.` }]);
      return;
    }
    const { valid, errors } = validateFiles(arr.slice(0, remaining));
    setFileErrors(errors);
    const newFiles = [...files, ...valid];
    setFiles(newFiles);
    valid.forEach((f) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        setPreviews((prev) => [...prev, e.target?.result as string]);
      };
      reader.readAsDataURL(f);
    });
  }, [files]);

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setPreviews((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError("");
    if (files.length === 0 && !description.trim()) {
      setServerError("Please upload at least one photo or provide a description.");
      return;
    }
    setSubmitting(true);
    track("estimate_submitted", { hasPhotos: files.length > 0, hasDescription: !!description });

    const formData = new FormData();
    formData.append("jobType", description.substring(0, 100) || "General Construction");
    formData.append("market", "midwest");
    if (description) formData.append("details", description);
    files.forEach((f) => formData.append("photos", f));

    try {
      const res = await api.createEstimate(formData);
      track("estimate_completed", { estimateId: res.data?.estimateId });
      track("estimate_created", { estimateId: res.data?.estimateId });
      setResult(res.data ?? null);
      refreshUser().catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["usage"] });
      api.getMyReview().then((r) => {
        if (!r.data) setShowReviewPrompt(true);
        else setHasExistingReview(true);
      }).catch(() => {});
    } catch (err: any) {
      if (err?.status === 402) {
        track("paywall_hit", {});
        setShareModalContext("limit_reached");
        setShowShareModal(true);
      } else if (err?.status === 429) {
        const waitMins = err?.retryAfter ? Math.ceil(err.retryAfter / 60) : null;
        const waitMsg = waitMins ? ` Please wait about ${waitMins} minute${waitMins !== 1 ? "s" : ""}.` : " Please wait a few minutes.";
        setServerError(`Too many requests.${waitMsg}`);
      } else {
        setServerError(err?.apiError ?? err?.message ?? "Failed to generate estimate. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownloadPdf = () => {
    if (!result?.estimateId) return;
    track("pdf_downloaded", { estimateId: result.estimateId });
    window.open(`/estimate/${result.estimateId}/pdf`, "_blank");
  };

  const handleSave = () => {
    if (!result?.estimateId) return;
    track("saved_estimate_created", { estimateId: result.estimateId });
    navigate(`/app/estimates/${result.estimateId}`);
  };

  const handleSinglePurchase = async () => {
    track("single_estimate_clicked");
    setSingleCheckoutLoading(true);
    try {
      // Mint event_id so the webhook Purchase CAPI event dedupes
      // against the success-page browser Pixel `checkout_success`.
      const metaEventId = generateEventId();
      track("checkout_started", { type: "single_estimate" }, metaEventId);
      const res = await api.createSingleEstimateCheckout(metaEventId);
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch {
      setServerError("Failed to start checkout. Please try again.");
    } finally {
      setSingleCheckoutLoading(false);
    }
  };

  const handleSubscribe = async () => {
    track("subscription_clicked");
    setSubCheckoutLoading(true);
    try {
      const metaEventId = generateEventId();
      track("checkout_started", { plan: "pro" }, metaEventId);
      const res = await api.createCheckoutSession("pro", "monthly", metaEventId);
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch {
      setServerError("Failed to start checkout. Please try again.");
    } finally {
      setSubCheckoutLoading(false);
    }
  };

  const showPaywall = result && !isPaid;

  useEffect(() => {
    if (showPaywall) {
      track("paywall_shown", { source: "estimate_result" });
    }
  }, [showPaywall]);

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-black text-brand-textPrimary">New Estimate</h1>
          <p className="text-brand-textMuted mt-2 text-sm">
            Upload photos or describe the job to get an instant AI estimate.
          </p>
          <p className="text-brand-textSubtle mt-2 text-xs">
            Already know the scope?{" "}
            <Link
              to="/app/estimate/builder"
              className="text-brand-green hover:underline font-medium"
            >
              Build an itemized estimate by hand →
            </Link>
          </p>
        </div>

        {submitting ? (
          <LoadingState />
        ) : !result ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-6">
            {/* Option A: Photo Upload */}
            <div>
              <label className="text-sm font-medium text-brand-textPrimary block mb-2">
                Option A: Upload a Job Site Photo
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <button
                  type="button"
                  onClick={() => cameraRef.current?.click()}
                  className="flex items-center justify-center gap-3 rounded-2xl border-2 border-brand-green/40 bg-brand-green/5 hover:bg-brand-green/10 transition-colors p-5 text-center cursor-pointer"
                >
                  <input
                    ref={cameraRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => e.target.files && addFiles(e.target.files)}
                  />
                  <span className="text-3xl">📸</span>
                  <div className="text-left">
                    <p className="text-brand-green font-bold text-sm">Take Photo</p>
                    <p className="text-xs text-brand-textSubtle">Open camera</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="flex items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-brand-border hover:border-brand-indigo/60 bg-brand-card transition-colors p-5 text-center cursor-pointer"
                >
                  <span className="text-3xl">🖼️</span>
                  <div className="text-left">
                    <p className="text-brand-textMuted font-bold text-sm">Choose File</p>
                    <p className="text-xs text-brand-textSubtle">From gallery</p>
                  </div>
                </button>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPTED_ATTR}
                multiple
                className="sr-only"
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
              <div
                className={`
                  relative rounded-2xl border-2 border-dashed transition-colors p-6 text-center cursor-pointer hidden sm:block
                  ${dragging ? "border-brand-green bg-brand-green/5" : "border-brand-border hover:border-brand-indigo/60 bg-brand-card"}
                `}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                role="button"
                aria-label="Upload photos"
              >
                <p className="text-brand-textMuted font-medium text-sm mb-1">
                  Or drag and drop photos here
                </p>
                <p className="text-xs text-brand-textSubtle">
                  Up to {MAX_FILES} photos · JPG, PNG, WebP, HEIC · Max {MAX_SIZE_MB}MB each
                </p>
              </div>

              {previews.length > 0 && (
                <div className="flex flex-wrap gap-3 mt-4">
                  {previews.map((src, i) => (
                    <div key={i} className="relative group">
                      <img src={src} alt={`Preview ${i + 1}`} className="w-20 h-20 sm:w-24 sm:h-24 object-cover rounded-xl border border-brand-border" />
                      <button
                        type="button"
                        onClick={() => removeFile(i)}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-red-600 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={`Remove photo ${i + 1}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {files.length < MAX_FILES && (
                    <button
                      type="button"
                      onClick={() => inputRef.current?.click()}
                      className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl border-2 border-dashed border-brand-border flex items-center justify-center text-brand-textSubtle hover:border-brand-indigo/60 transition-colors text-2xl"
                    >
                      +
                    </button>
                  )}
                </div>
              )}
              {fileErrors.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  {fileErrors.map((e, i) => (
                    <p key={i} className="text-xs text-red-400">{e.file ? `${e.file}: ` : ""}{e.error}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-brand-border" />
              <span className="text-xs text-brand-textSubtle font-medium">OR</span>
              <div className="flex-1 h-px bg-brand-border" />
            </div>

            {/* Option B: Description */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-brand-textPrimary">
                  Option B: Describe the Job
                </label>
                <VoiceDictation
                  onTranscript={(text) => setDescription((prev) => (prev ? prev + " " + text : text))}
                  disabled={submitting}
                />
              </div>
              <Textarea
                placeholder="E.g.: Tuckpointing repair on a 2-story brick building, approximately 800 sq ft of mortar joints need repointing."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                hint="Be specific about materials, dimensions, and location for the best results."
              />
            </div>

            {serverError && (
              <Alert type="error" onDismiss={() => setServerError("")}>
                {serverError}
              </Alert>
            )}

            <Button type="submit" size="lg" fullWidth>
              Generate Estimate
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-6">
            <Alert type="success">
              Your estimate is ready! Review the breakdown below.
            </Alert>

            <EstimateBreakdownCard
              rawText={result.text}
              jobType={description.substring(0, 80) || "Construction Job"}
              isPaid={isPaid}
            />

            {showPaywall ? (
              <>
                <Paywall
                  onSinglePurchase={handleSinglePurchase}
                  onSubscribe={handleSubscribe}
                  singleLoading={singleCheckoutLoading}
                  subLoading={subCheckoutLoading}
                />
                {serverError && (
                  <Alert type="error" onDismiss={() => setServerError("")}>
                    {serverError}
                  </Alert>
                )}
              </>
            ) : (
              <div className="flex flex-col sm:flex-row gap-3">
                <Button variant="primary" onClick={handleDownloadPdf} fullWidth>
                  Download PDF
                </Button>
                <Button variant="secondary" onClick={handleSave} fullWidth>
                  View & Save
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setResult(null);
                    setFiles([]);
                    setPreviews([]);
                    setDescription("");
                  }}
                  fullWidth
                >
                  New Estimate
                </Button>
              </div>
            )}

            {showReviewPrompt && !hasExistingReview && (
              <ReviewPrompt onDismiss={() => setShowReviewPrompt(false)} />
            )}
          </div>
        )}
      </div>

      <UpgradeModal open={showUpgradeModal} onClose={() => setShowUpgradeModal(false)} />
      <ShareToUnlockModal
        open={showShareModal}
        onClose={() => setShowShareModal(false)}
        context={shareModalContext}
      />
    </Layout>
  );
}
