import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input, Textarea } from "../components/ui/Input";
import { Alert } from "../components/ui/Alert";
import { Modal } from "../components/ui/Modal";
import { api } from "../api/client";
import type { Estimate, SavedLineItemPreset, SendEstimateRequest } from "../api/client";
import { track } from "../analytics";
import { usePageMeta } from "../hooks/usePageMeta";
import { useAuth } from "../contexts/AuthContext";

interface LineItemDraft {
  description: string;
  quantity: string;
  unitCost: string;
  uom: string;
  costType: string;
}

interface RowError {
  description?: string;
  quantity?: string;
  unitCost?: string;
  uom?: string;
  costType?: string;
}

interface FieldErrors {
  source?: string;
  jobType?: string;
  market?: string;
}

const COST_TYPE_OPTIONS = [
  "",
  "Materials",
  "Labor",
  "Equipment",
  "Subcontractor",
  "Permit",
  "Overhead",
  "Other",
];

const UOM_SUGGESTIONS = ["ea", "hr", "sq ft", "lin ft", "yd³", "ton", "lb", "gal", "lot"];

// Mirrors server-side sendEstimateSchema in server/routes/estimates.ts.
const MAX_NAME = 255;
const MAX_SOURCE = 64;
const MAX_JOB_TYPE = 120;
const MAX_MARKET = 120;
const MAX_UOM = 32;
const MAX_COST_TYPE = 64;
const MAX_LINE_ITEMS = 500;
const MAX_DESCRIPTION_HINT = "Describe what this line covers (required)";

function emptyRow(): LineItemDraft {
  return {
    description: "",
    quantity: "1",
    unitCost: "",
    uom: "",
    costType: "",
  };
}

function formatCurrency(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function parseNumber(value: string): number {
  if (typeof value !== "string") return NaN;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (cleaned === "") return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function rowLineTotal(row: LineItemDraft): number {
  const q = parseNumber(row.quantity);
  const u = parseNumber(row.unitCost);
  if (!Number.isFinite(q) || !Number.isFinite(u)) return 0;
  return Math.round(q * u * 100) / 100;
}

export default function EstimateBuilderPage() {
  const [searchParams] = useSearchParams();
  const cloneId = searchParams.get("clone");
  const editId = searchParams.get("edit");
  const mode: "edit" | "clone" | "new" = editId ? "edit" : cloneId ? "clone" : "new";
  const sourceId = editId || cloneId;

  usePageMeta({
    title:
      mode === "edit"
        ? "Edit Estimate | ProBid AI"
        : mode === "clone"
          ? "Duplicate Estimate | ProBid AI"
          : "New Itemized Estimate | ProBid AI",
    description:
      "Build a structured construction estimate by hand — add line items, quantities, unit costs, and cost types.",
    canonical: "https://probidcore.net/app/estimate/builder",
  });

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refreshUser } = useAuth();

  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [jobType, setJobType] = useState("");
  const [market, setMarket] = useState("");
  const [details, setDetails] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [rows, setRows] = useState<LineItemDraft[]>([emptyRow()]);

  const [nameError, setNameError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const [formError, setFormError] = useState("");
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [presetActionError, setPresetActionError] = useState("");
  const [presetSavedToast, setPresetSavedToast] = useState("");
  const [savingPresetIdx, setSavingPresetIdx] = useState<number | null>(null);
  const [deletingPresetId, setDeletingPresetId] = useState<string | null>(null);
  const [presetSearch, setPresetSearch] = useState("");
  const [presetCostTypeFilter, setPresetCostTypeFilter] = useState<string>("");

  const presetsQuery = useQuery({
    queryKey: ["saved-line-items"],
    queryFn: () => api.getSavedLineItems().then((r) => r.data),
  });
  const presets: SavedLineItemPreset[] = presetsQuery.data?.presets ?? [];
  const recentPresets: SavedLineItemPreset[] = presetsQuery.data?.recent ?? [];

  const presetCostTypeChips = useMemo(() => {
    const seen = new Set<string>();
    for (const p of presets) {
      const ct = (p.costType ?? "").trim();
      if (ct) seen.add(ct);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [presets]);

  const visibleRecentPresets = useMemo(() => {
    // Hide the "Recently used" rail when the user is actively searching/
    // filtering — the filtered list already contains what they want and a
    // duplicate rail just adds noise.
    if (presetSearch.trim() || presetCostTypeFilter) return [];
    return recentPresets;
  }, [recentPresets, presetSearch, presetCostTypeFilter]);

  const filteredPresets = useMemo(() => {
    const needle = presetSearch.trim().toLowerCase();
    const recentIds = new Set(visibleRecentPresets.map((p) => p.id));
    return presets.filter((p) => {
      // Avoid showing the same preset twice when the "Recently used" rail is
      // visible — those rows are already at the top of the picker.
      if (recentIds.has(p.id)) return false;
      if (presetCostTypeFilter && (p.costType ?? "") !== presetCostTypeFilter) {
        return false;
      }
      if (needle && !p.description.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [presets, presetSearch, presetCostTypeFilter, visibleRecentPresets]);

  const sourceQuery = useQuery({
    queryKey: ["estimate", sourceId, mode === "edit" ? "for-edit" : "for-clone"],
    queryFn: () => api.getEstimate(sourceId!).then((r) => r.data),
    enabled: !!sourceId,
  });

  useEffect(() => {
    if (!sourceId || prefilled) return;
    const data = sourceQuery.data;
    if (!data) return;
    prefillFromEstimate(data, mode === "edit");
    setPrefilled(true);
    if (mode === "edit") {
      track("itemized_estimate_edit_loaded", { sourceEstimateId: sourceId });
    } else {
      track("itemized_estimate_clone_loaded", { sourceEstimateId: sourceId });
    }
  }, [sourceId, sourceQuery.data, prefilled, mode]);

  useEffect(() => {
    track("itemized_estimate_builder_opened", { mode });
  }, [mode]);

  function prefillFromEstimate(data: Estimate, isEdit: boolean) {
    const baseName = data.name || data.jobType || "";
    setName(isEdit ? baseName : baseName ? `${baseName} (copy)` : "");
    setJobType(data.jobType || "");
    setMarket(data.market && data.market !== "N/A" ? data.market : "");
    setDetails(data.details || "");
    setClientName(data.clientName || "");
    setClientEmail(data.clientEmail || "");
    setClientPhone(data.clientPhone || "");
    setSource(data.source || "");
    if (data.lineItems && data.lineItems.length > 0) {
      setRows(
        data.lineItems.map((li) => ({
          description: li.description || "",
          quantity: String(li.quantity ?? ""),
          unitCost: String(li.unitCost ?? ""),
          uom: li.uom || "",
          costType: li.costType || "",
        })),
      );
    }
  }

  const totals = useMemo(() => {
    const lineTotals = rows.map(rowLineTotal);
    const subtotal = lineTotals.reduce((s, n) => s + n, 0);
    const byCostType: Record<string, number> = {};
    for (let i = 0; i < rows.length; i++) {
      const key = rows[i].costType.trim() || "Uncategorized";
      byCostType[key] = (byCostType[key] || 0) + lineTotals[i];
    }
    return {
      lineTotals,
      subtotal: Math.round(subtotal * 100) / 100,
      byCostType,
    };
  }, [rows]);

  function updateRow(idx: number, patch: Partial<LineItemDraft>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    if (rowErrors[idx]) {
      setRowErrors((prev) => prev.map((e, i) => (i === idx ? {} : e)));
    }
  }

  function addRow() {
    if (rows.length >= MAX_LINE_ITEMS) {
      setFormError(`You can add up to ${MAX_LINE_ITEMS} line items.`);
      return;
    }
    setRows((prev) => [...prev, emptyRow()]);
    setFormError("");
  }

  function removeRow(idx: number) {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)));
    setRowErrors((prev) => prev.filter((_, i) => i !== idx));
  }

  function rowToPresetPayload(row: LineItemDraft): {
    ok: boolean;
    error?: string;
    payload?: {
      description: string;
      quantity: number;
      unitCost: number;
      uom?: string;
      costType?: string;
    };
  } {
    const description = row.description.trim();
    if (!description) return { ok: false, error: "Add a description before saving as a preset." };
    const q = parseNumber(row.quantity);
    if (!Number.isFinite(q) || q <= 0) return { ok: false, error: "Quantity must be greater than zero to save a preset." };
    const u = parseNumber(row.unitCost);
    if (!Number.isFinite(u) || u < 0) return { ok: false, error: "Unit cost must be a number ≥ 0 to save a preset." };
    const payload: {
      description: string;
      quantity: number;
      unitCost: number;
      uom?: string;
      costType?: string;
    } = { description, quantity: q, unitCost: u };
    if (row.uom.trim()) payload.uom = row.uom.trim();
    if (row.costType.trim()) payload.costType = row.costType.trim();
    return { ok: true, payload };
  }

  async function saveRowAsPreset(idx: number) {
    setPresetActionError("");
    setPresetSavedToast("");
    const row = rows[idx];
    const { ok, error, payload } = rowToPresetPayload(row);
    if (!ok || !payload) {
      setPresetActionError(error || "Could not save preset.");
      return;
    }
    setSavingPresetIdx(idx);
    try {
      await api.createSavedLineItem(payload);
      track("saved_line_item_created", {
        hasUom: !!payload.uom,
        hasCostType: !!payload.costType,
      });
      await queryClient.invalidateQueries({ queryKey: ["saved-line-items"] });
      setPresetSavedToast(`Saved "${payload.description}" to your library.`);
    } catch (err: any) {
      setPresetActionError(err?.apiError ?? err?.message ?? "Failed to save preset.");
    } finally {
      setSavingPresetIdx(null);
    }
  }

  function insertPreset(preset: SavedLineItemPreset) {
    setPresetActionError("");
    setPresetSavedToast("");
    if (rows.length >= MAX_LINE_ITEMS) {
      setFormError(`You can add up to ${MAX_LINE_ITEMS} line items.`);
      setPresetPickerOpen(false);
      return;
    }
    const newRow: LineItemDraft = {
      description: preset.description,
      quantity: String(preset.quantity),
      unitCost: String(preset.unitCost),
      uom: preset.uom ?? "",
      costType: preset.costType ?? "",
    };
    setRows((prev) => {
      // If the only existing row is empty/blank, replace it instead of appending.
      if (
        prev.length === 1 &&
        !prev[0].description.trim() &&
        !prev[0].unitCost.trim()
      ) {
        return [newRow];
      }
      return [...prev, newRow];
    });
    setFormError("");
    track("saved_line_item_inserted", { presetId: preset.id });
    setPresetPickerOpen(false);
    setPresetSearch("");
    setPresetCostTypeFilter("");

    // Best-effort: bump lastUsedAt server-side so future picker opens surface
    // this preset in the "Recently used" rail. Failure is non-fatal — the row
    // is already inserted into the form.
    api
      .markSavedLineItemUsed(preset.id)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["saved-line-items"] });
      })
      .catch(() => {
        // Swallow — we don't want to surface a noisy error for a usage ping.
      });
  }

  async function handleDeletePreset(presetId: string) {
    if (!window.confirm("Delete this saved line item? This cannot be undone.")) return;
    setPresetActionError("");
    setDeletingPresetId(presetId);
    try {
      await api.deleteSavedLineItem(presetId);
      track("saved_line_item_deleted", { presetId });
      await queryClient.invalidateQueries({ queryKey: ["saved-line-items"] });
    } catch (err: any) {
      setPresetActionError(err?.apiError ?? err?.message ?? "Failed to delete preset.");
    } finally {
      setDeletingPresetId(null);
    }
  }

  function validate(): {
    ok: boolean;
    payload?: SendEstimateRequest;
  } {
    let ok = true;
    setNameError("");
    setEmailError("");
    setFieldErrors({});
    setFormError("");
    setServerError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Name is required");
      ok = false;
    } else if (trimmedName.length > MAX_NAME) {
      setNameError(`Name must be ${MAX_NAME} characters or fewer`);
      ok = false;
    }

    const trimmedEmail = clientEmail.trim();
    if (trimmedEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
      setEmailError("Enter a valid email address");
      ok = false;
    }

    const fErrs: FieldErrors = {};
    if (source.trim().length > MAX_SOURCE) {
      fErrs.source = `Source must be ${MAX_SOURCE} characters or fewer`;
      ok = false;
    }
    if (jobType.trim().length > MAX_JOB_TYPE) {
      fErrs.jobType = `Job type must be ${MAX_JOB_TYPE} characters or fewer`;
      ok = false;
    }
    if (market.trim().length > MAX_MARKET) {
      fErrs.market = `Market must be ${MAX_MARKET} characters or fewer`;
      ok = false;
    }
    setFieldErrors(fErrs);

    const errs: RowError[] = rows.map(() => ({}));
    rows.forEach((row, idx) => {
      const e: RowError = {};
      if (!row.description.trim()) {
        e.description = "Description required";
      }
      const q = parseNumber(row.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        e.quantity = "Must be > 0";
      }
      const u = parseNumber(row.unitCost);
      if (!Number.isFinite(u) || u < 0) {
        e.unitCost = "Must be ≥ 0";
      }
      if (row.uom.trim().length > MAX_UOM) {
        e.uom = `Max ${MAX_UOM} chars`;
      }
      if (row.costType.trim().length > MAX_COST_TYPE) {
        e.costType = `Max ${MAX_COST_TYPE} chars`;
      }
      if (Object.keys(e).length > 0) {
        ok = false;
        errs[idx] = e;
      }
    });
    setRowErrors(errs);

    if (rows.length === 0) {
      setFormError("Add at least one line item.");
      ok = false;
    }

    if (!ok) return { ok };

    const payload: SendEstimateRequest = {
      name: trimmedName,
      lineItems: rows.map((row) => {
        const item: SendEstimateRequest["lineItems"][number] = {
          description: row.description.trim(),
          quantity: parseNumber(row.quantity),
          unitCost: parseNumber(row.unitCost),
        };
        if (row.uom.trim()) item.uom = row.uom.trim();
        if (row.costType.trim()) item.costType = row.costType.trim();
        return item;
      }),
    };
    if (source.trim()) payload.source = source.trim();
    if (jobType.trim()) payload.jobType = jobType.trim();
    if (market.trim()) payload.market = market.trim();
    if (details.trim()) payload.details = details.trim();
    if (clientName.trim()) payload.clientName = clientName.trim();
    if (trimmedEmail) payload.clientEmail = trimmedEmail;
    if (clientPhone.trim()) payload.clientPhone = clientPhone.trim();

    return { ok: true, payload };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, payload } = validate();
    if (!ok || !payload) {
      setFormError(formError || "Please fix the highlighted fields and try again.");
      return;
    }
    setSubmitting(true);
    setServerError("");
    track("itemized_estimate_submitted", {
      mode,
      lineItems: payload.lineItems.length,
      total: totals.subtotal,
    });
    try {
      if (mode === "edit" && editId) {
        const res = await api.updateEstimateLineItems(editId, payload);
        const updatedId = res.data?.estimateId ?? editId;
        track("itemized_estimate_updated", { estimateId: updatedId });
        queryClient.invalidateQueries({ queryKey: ["estimates"] });
        queryClient.invalidateQueries({ queryKey: ["estimate", updatedId] });
        navigate(`/app/estimates/${updatedId}`);
      } else {
        const res = await api.sendEstimate(payload);
        const newId = res.data?.estimateId;
        track("itemized_estimate_created", { estimateId: newId });
        queryClient.invalidateQueries({ queryKey: ["usage"] });
        queryClient.invalidateQueries({ queryKey: ["estimates"] });
        refreshUser().catch(() => {});
        if (newId) {
          navigate(`/app/estimates/${newId}`);
        } else {
          navigate("/app/history");
        }
      }
    } catch (err: any) {
      if (err?.status === 402) {
        setServerError(
          err?.apiError ||
            "Estimate limit reached. Upgrade to Pro or buy a $7 single estimate to continue.",
        );
      } else if (err?.status === 404 && mode === "edit") {
        setServerError("This estimate no longer exists or you don't have access to it.");
      } else if (err?.status === 429) {
        const waitMins = err?.retryAfter ? Math.ceil(err.retryAfter / 60) : null;
        const waitMsg = waitMins
          ? ` Please wait about ${waitMins} minute${waitMins !== 1 ? "s" : ""}.`
          : " Please wait a few minutes.";
        setServerError(`Too many requests.${waitMsg}`);
      } else {
        setServerError(
          err?.apiError ??
            err?.message ??
            (mode === "edit"
              ? "Failed to save your changes. Please try again."
              : "Failed to create the estimate. Please try again."),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  const sourceLoading = !!sourceId && sourceQuery.isLoading;
  const sourceError = !!sourceId && sourceQuery.isError;

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <Link
          to={sourceId ? `/app/estimates/${sourceId}` : "/app/history"}
          className="inline-flex items-center gap-1 text-sm text-brand-textSubtle hover:text-brand-textMuted mb-6 transition-colors"
        >
          ← {sourceId ? "Back to estimate" : "Back to history"}
        </Link>

        <div className="mb-6">
          <h1 className="text-3xl font-black text-brand-textPrimary">
            {mode === "edit"
              ? "Edit Estimate"
              : mode === "clone"
                ? "Duplicate Estimate"
                : "New Itemized Estimate"}
          </h1>
          <p className="text-brand-textMuted mt-2 text-sm">
            {mode === "edit"
              ? "Update the line items below — your changes save in place without using a new estimate credit."
              : mode === "clone"
                ? "Edit the line items below and save as a brand-new estimate."
                : "Build a structured estimate by adding line items by hand. Great for non-photo jobs or when you already know the scope."}
          </p>
        </div>

        {sourceLoading && (
          <Card className="mb-6">
            <div className="animate-pulse space-y-3">
              <div className="h-4 w-32 bg-brand-border rounded" />
              <div className="h-4 w-3/4 bg-brand-border rounded" />
              <div className="h-24 bg-brand-border rounded" />
            </div>
          </Card>
        )}
        {sourceError && (
          <Alert type="error" className="mb-6">
            {mode === "edit"
              ? "We couldn't load that estimate to edit. Please go back and try again."
              : "We couldn't load that estimate to duplicate. Starting with a blank form."}
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <Card>
            <h2 className="text-sm font-semibold text-brand-textMuted uppercase tracking-wide mb-4">
              Estimate details
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <Input
                  label="Estimate name *"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={MAX_NAME}
                  placeholder="E.g. Smith Tuckpointing — 1242 Oak St"
                  error={nameError}
                  hint="Shown in your history and on the PDF."
                />
              </div>
              <Input
                label="Job type"
                value={jobType}
                onChange={(e) => setJobType(e.target.value)}
                maxLength={MAX_JOB_TYPE}
                placeholder="Tuckpointing, Chimney rebuild, etc."
                error={fieldErrors.jobType}
              />
              <Input
                label="Market / region"
                value={market}
                onChange={(e) => setMarket(e.target.value)}
                maxLength={MAX_MARKET}
                placeholder="Chicago, IL"
                error={fieldErrors.market}
              />
              <Input
                label="Source (optional)"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                maxLength={MAX_SOURCE}
                placeholder="manual, referral, partner..."
                error={fieldErrors.source}
              />
              <div />
              <div className="sm:col-span-2">
                <Textarea
                  label="Job description"
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  rows={3}
                  placeholder="Notes about the scope, site conditions, or anything the client should see."
                />
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-brand-textMuted uppercase tracking-wide mb-4">
              Client (optional)
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Input
                label="Client name"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="John Smith"
              />
              <Input
                label="Client email"
                type="email"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
                placeholder="client@example.com"
                error={emailError}
              />
              <Input
                label="Client phone"
                value={clientPhone}
                onChange={(e) => setClientPhone(e.target.value)}
                placeholder="(555) 123-4567"
              />
            </div>
          </Card>

          <Card padding="none">
            <div className="px-6 py-5 border-b border-brand-border flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-brand-textMuted uppercase tracking-wide">
                  Line items
                </h2>
                <p className="text-xs text-brand-textSubtle mt-1">
                  {rows.length} of {MAX_LINE_ITEMS}
                  {presets.length > 0 && (
                    <> · {presets.length} saved preset{presets.length === 1 ? "" : "s"}</>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPresetActionError("");
                    setPresetSavedToast("");
                    setPresetPickerOpen(true);
                    track("saved_line_item_picker_opened", { presetCount: presets.length });
                  }}
                >
                  Insert from library
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={addRow}>
                  + Add row
                </Button>
              </div>
            </div>

            {(presetSavedToast || presetActionError) && (
              <div className="px-6 pt-4">
                {presetSavedToast && (
                  <Alert type="success" onDismiss={() => setPresetSavedToast("")}>
                    {presetSavedToast}
                  </Alert>
                )}
                {presetActionError && (
                  <Alert type="error" onDismiss={() => setPresetActionError("")}>
                    {presetActionError}
                  </Alert>
                )}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[820px]">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-brand-textSubtle border-b border-brand-border">
                    <th className="py-2 px-3 font-medium" style={{ width: "30%" }}>
                      Description
                    </th>
                    <th className="py-2 px-3 font-medium text-right" style={{ width: "10%" }}>
                      Qty
                    </th>
                    <th className="py-2 px-3 font-medium" style={{ width: "10%" }}>
                      UoM
                    </th>
                    <th className="py-2 px-3 font-medium text-right" style={{ width: "14%" }}>
                      Unit cost
                    </th>
                    <th className="py-2 px-3 font-medium" style={{ width: "16%" }}>
                      Cost type
                    </th>
                    <th className="py-2 px-3 font-medium text-right" style={{ width: "14%" }}>
                      Line total
                    </th>
                    <th className="py-2 px-3" style={{ width: "6%" }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const err = rowErrors[idx] || {};
                    return (
                      <tr
                        key={idx}
                        className="border-b border-brand-border/40 last:border-b-0 align-top"
                      >
                        <td className="py-2 px-3">
                          <input
                            value={row.description}
                            onChange={(e) =>
                              updateRow(idx, { description: e.target.value })
                            }
                            placeholder={MAX_DESCRIPTION_HINT}
                            aria-label={`Line item ${idx + 1} description`}
                            className={`w-full px-2.5 py-2 rounded-lg bg-brand-bg border text-brand-textPrimary text-sm placeholder-brand-textSubtle focus:outline-none focus:ring-2 focus:ring-brand-indigo focus:border-transparent ${
                              err.description ? "border-red-500" : "border-brand-border"
                            }`}
                          />
                          {err.description && (
                            <p className="text-xs text-red-400 mt-1">{err.description}</p>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <input
                            value={row.quantity}
                            onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                            inputMode="decimal"
                            aria-label={`Line item ${idx + 1} quantity`}
                            className={`w-full px-2.5 py-2 rounded-lg bg-brand-bg border text-brand-textPrimary text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-indigo focus:border-transparent ${
                              err.quantity ? "border-red-500" : "border-brand-border"
                            }`}
                          />
                          {err.quantity && (
                            <p className="text-xs text-red-400 mt-1">{err.quantity}</p>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <input
                            value={row.uom}
                            onChange={(e) => updateRow(idx, { uom: e.target.value })}
                            list="uom-suggestions"
                            maxLength={MAX_UOM}
                            placeholder="ea"
                            aria-label={`Line item ${idx + 1} unit of measure`}
                            className={`w-full px-2.5 py-2 rounded-lg bg-brand-bg border text-brand-textPrimary text-sm placeholder-brand-textSubtle focus:outline-none focus:ring-2 focus:ring-brand-indigo focus:border-transparent ${
                              err.uom ? "border-red-500" : "border-brand-border"
                            }`}
                          />
                          {err.uom && (
                            <p className="text-xs text-red-400 mt-1">{err.uom}</p>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <input
                            value={row.unitCost}
                            onChange={(e) => updateRow(idx, { unitCost: e.target.value })}
                            inputMode="decimal"
                            placeholder="0.00"
                            aria-label={`Line item ${idx + 1} unit cost`}
                            className={`w-full px-2.5 py-2 rounded-lg bg-brand-bg border text-brand-textPrimary text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-indigo focus:border-transparent ${
                              err.unitCost ? "border-red-500" : "border-brand-border"
                            }`}
                          />
                          {err.unitCost && (
                            <p className="text-xs text-red-400 mt-1">{err.unitCost}</p>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <select
                            value={row.costType}
                            onChange={(e) => updateRow(idx, { costType: e.target.value })}
                            aria-label={`Line item ${idx + 1} cost type`}
                            className="w-full px-2.5 py-2 rounded-lg bg-brand-bg border border-brand-border text-brand-textPrimary text-sm focus:outline-none focus:ring-2 focus:ring-brand-indigo focus:border-transparent"
                          >
                            {COST_TYPE_OPTIONS.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt || "—"}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 px-3 text-right text-brand-textPrimary font-semibold tabular-nums">
                          {formatCurrency(totals.lineTotals[idx] || 0)}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => saveRowAsPreset(idx)}
                              disabled={savingPresetIdx === idx}
                              aria-label={`Save line item ${idx + 1} as preset`}
                              title="Save row as preset"
                              className="text-brand-textSubtle hover:text-brand-green disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none px-1"
                            >
                              {savingPresetIdx === idx ? "…" : "★"}
                            </button>
                            <button
                              type="button"
                              onClick={() => removeRow(idx)}
                              disabled={rows.length === 1}
                              aria-label={`Remove line item ${idx + 1}`}
                              title="Remove row"
                              className="text-brand-textSubtle hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none px-1"
                            >
                              ×
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <datalist id="uom-suggestions">
                {UOM_SUGGESTIONS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>

            <div className="px-6 py-5 border-t border-brand-border">
              <div className="flex justify-end mb-4">
                <Button type="button" variant="ghost" size="sm" onClick={addRow}>
                  + Add another row
                </Button>
              </div>

              {Object.keys(totals.byCostType).length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                  {Object.entries(totals.byCostType).map(([type, amount]) => (
                    <div key={type} className="bg-brand-bg rounded-xl p-3 text-center">
                      <p className="text-xs text-brand-textSubtle mb-1 uppercase tracking-wide font-medium">
                        {type}
                      </p>
                      <p className="text-base font-black text-brand-textPrimary tabular-nums">
                        {formatCurrency(amount)}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between pt-4 border-t border-brand-border">
                <span className="text-sm font-semibold text-brand-textMuted uppercase tracking-wide">
                  Total
                </span>
                <span className="text-2xl font-black text-brand-green tabular-nums">
                  {formatCurrency(totals.subtotal)}
                </span>
              </div>
            </div>
          </Card>

          {formError && <Alert type="warning" onDismiss={() => setFormError("")}>{formError}</Alert>}
          {serverError && <Alert type="error" onDismiss={() => setServerError("")}>{serverError}</Alert>}

          <div className="flex flex-col sm:flex-row gap-3">
            <Button type="submit" size="lg" fullWidth loading={submitting}>
              {mode === "edit"
                ? "Save changes"
                : mode === "clone"
                  ? "Save as new estimate"
                  : "Create estimate"}
            </Button>
            <Link to="/app/history" className="sm:w-auto">
              <Button type="button" variant="ghost" size="lg" fullWidth>
                Cancel
              </Button>
            </Link>
          </div>
        </form>
      </div>

      <Modal
        open={presetPickerOpen}
        onClose={() => {
          setPresetPickerOpen(false);
          setPresetSearch("");
          setPresetCostTypeFilter("");
        }}
        title="Insert from your library"
      >
        {presetsQuery.isLoading ? (
          <div className="py-8 text-center text-sm text-brand-textSubtle">Loading presets…</div>
        ) : presetsQuery.isError ? (
          <Alert type="error">Couldn't load your saved presets. Please try again.</Alert>
        ) : presets.length === 0 ? (
          <div className="py-6 text-center text-sm text-brand-textMuted">
            <p>You haven't saved any line items yet.</p>
            <p className="mt-2 text-xs text-brand-textSubtle">
              Click the ★ next to any row to save it for next time.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label htmlFor="preset-search" className="sr-only">
                Search saved line items
              </label>
              <input
                id="preset-search"
                type="search"
                value={presetSearch}
                onChange={(e) => setPresetSearch(e.target.value)}
                placeholder="Search by description…"
                aria-label="Search saved line items"
                className="w-full px-3 py-2 rounded-lg bg-brand-bg border border-brand-border text-brand-textPrimary text-sm placeholder-brand-textSubtle focus:outline-none focus:ring-2 focus:ring-brand-indigo focus:border-transparent"
              />
            </div>

            {presetCostTypeChips.length > 0 && (
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Filter saved line items by cost type"
              >
                <button
                  type="button"
                  onClick={() => setPresetCostTypeFilter("")}
                  aria-pressed={presetCostTypeFilter === ""}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    presetCostTypeFilter === ""
                      ? "bg-brand-indigo text-white border-brand-indigo"
                      : "bg-brand-bg text-brand-textMuted border-brand-border hover:border-brand-indigo/60"
                  }`}
                >
                  All
                </button>
                {presetCostTypeChips.map((ct) => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() =>
                      setPresetCostTypeFilter((prev) => (prev === ct ? "" : ct))
                    }
                    aria-pressed={presetCostTypeFilter === ct}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      presetCostTypeFilter === ct
                        ? "bg-brand-indigo text-white border-brand-indigo"
                        : "bg-brand-bg text-brand-textMuted border-brand-border hover:border-brand-indigo/60"
                    }`}
                  >
                    {ct}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto pr-1">
              {visibleRecentPresets.length > 0 && (
                <section aria-labelledby="preset-recent-heading">
                  <h3
                    id="preset-recent-heading"
                    className="text-xs font-semibold text-brand-textSubtle uppercase tracking-wide mb-2"
                  >
                    Recently used
                  </h3>
                  <div className="flex flex-col gap-2">
                    {visibleRecentPresets.map((p) => (
                      <PresetRow
                        key={`recent-${p.id}`}
                        preset={p}
                        deleting={deletingPresetId === p.id}
                        onInsert={insertPreset}
                        onDelete={handleDeletePreset}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section aria-labelledby="preset-all-heading">
                {visibleRecentPresets.length > 0 && (
                  <h3
                    id="preset-all-heading"
                    className="text-xs font-semibold text-brand-textSubtle uppercase tracking-wide mb-2"
                  >
                    All saved presets
                  </h3>
                )}
                {filteredPresets.length === 0 ? (
                  <p className="text-sm text-brand-textMuted py-4 text-center">
                    No presets match your search or filter.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {filteredPresets.map((p) => (
                      <PresetRow
                        key={p.id}
                        preset={p}
                        deleting={deletingPresetId === p.id}
                        onInsert={insertPreset}
                        onDelete={handleDeletePreset}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setPresetPickerOpen(false);
              setPresetSearch("");
              setPresetCostTypeFilter("");
            }}
          >
            Close
          </Button>
        </div>
      </Modal>
    </Layout>
  );
}

interface PresetRowProps {
  preset: SavedLineItemPreset;
  deleting: boolean;
  onInsert: (p: SavedLineItemPreset) => void;
  onDelete: (id: string) => void;
}

function PresetRow({ preset, deleting, onInsert, onDelete }: PresetRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 rounded-xl border border-brand-border bg-brand-bg hover:border-brand-indigo/60 transition-colors">
      <button
        type="button"
        onClick={() => onInsert(preset)}
        className="flex-1 text-left"
      >
        <div className="text-sm font-medium text-brand-textPrimary">{preset.description}</div>
        <div className="mt-1 text-xs text-brand-textSubtle tabular-nums">
          {preset.quantity} {preset.uom || "ea"} · {formatCurrency(preset.unitCost)}
          {preset.costType ? ` · ${preset.costType}` : ""}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onDelete(preset.id)}
        disabled={deleting}
        aria-label={`Delete preset ${preset.description}`}
        className="text-brand-textSubtle hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none px-2 py-1"
        title="Delete preset"
      >
        {deleting ? "…" : "×"}
      </button>
    </div>
  );
}
