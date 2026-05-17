import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type WatchtowerFieldConfig = {
  key: string;
  label: string;
  color: string;
  border: string;
  min?: number;
  max?: number;
  step?: number;
  inputWidth?: number;
};

export type WatchtowerThresholdPanelProps<T extends { source: "db" | "env" }> = {
  title: string;
  renderDescription: (data: T | undefined) => React.ReactNode;
  endpoint: string;
  queryKey: string[];
  adminKey: string;
  onRefresh: () => void;
  fields: WatchtowerFieldConfig[];
  initialValues: (data: T) => Record<string, string>;
  buildPayload: (inputs: Record<string, string>) => Record<string, unknown>;
  isInvalid: (inputs: Record<string, string>) => boolean;
  supportsReset?: boolean;
};

export function WatchtowerThresholdPanel<T extends { source: "db" | "env" }>({
  title,
  renderDescription,
  endpoint,
  queryKey,
  adminKey,
  onRefresh,
  fields,
  initialValues,
  buildPayload,
  isInvalid,
  supportsReset,
}: WatchtowerThresholdPanelProps<T>) {
  const queryClient = useQueryClient();

  const fullQueryKey = React.useMemo(() => [...queryKey, adminKey], [queryKey, adminKey]);

  const { data, isFetching } = useQuery<T, Error>({
    queryKey: fullQueryKey,
    queryFn: async () => {
      const res = await fetch(endpoint, { headers: { "x-admin-key": adminKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { data: T }).data;
    },
    enabled: !!adminKey,
    staleTime: 60_000,
    retry: 1,
  });

  const emptyInputs = React.useMemo(
    () => fields.reduce<Record<string, string>>((acc, f) => ({ ...acc, [f.key]: "" }), {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [inputs, setInputs] = useState<Record<string, string>>(emptyInputs);
  const [dirty, setDirty] = useState(false);

  const initialValuesRef = React.useRef(initialValues);
  initialValuesRef.current = initialValues;

  React.useEffect(() => {
    if (data && !dirty) {
      setInputs(initialValuesRef.current(data));
    }
  }, [data, dirty]);

  const { mutate: save, isPending: saving, error: saveError, isSuccess: saved } = useMutation<T, Error, Record<string, unknown>>({
    mutationFn: async (payload) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify(payload),
      });
      const body = await res.json() as { success: boolean; error?: string; data: T };
      if (!body.success) throw new Error(body.error ?? "Failed to save");
      return body.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fullQueryKey });
      setDirty(false);
      onRefresh();
    },
  });

  const [pendingReset, setPendingReset] = useState(false);
  const { mutate: doReset, isPending: resetting } = useMutation<void, Error, void>({
    mutationFn: async () => {
      const res = await fetch(endpoint, { method: "DELETE", headers: { "x-admin-key": adminKey } });
      const body = await res.json() as { success: boolean; error?: string };
      if (!body.success) throw new Error(body.error ?? "Failed to reset");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fullQueryKey });
      setDirty(false);
      setPendingReset(false);
      onRefresh();
    },
  });

  const handleSave = () => {
    if (isInvalid(inputs)) return;
    save(buildPayload(inputs));
  };

  return (
    <div style={{ background: "#1a1f2e", borderRadius: 12, padding: "18px 20px", marginBottom: 24, border: "1px solid rgba(255,255,255,0.06)" }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: "#e5e7eb", margin: "0 0 4px" }}>{title}</h3>
      <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 14px" }}>
        {renderDescription(data)}
      </p>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        {fields.map((f) => (
          <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: f.color, fontWeight: 600 }}>{f.label}</span>
            <input
              type="number"
              min={f.min ?? 0}
              max={f.max}
              step={f.step}
              value={inputs[f.key] ?? ""}
              onChange={(e) => { setInputs((prev) => ({ ...prev, [f.key]: e.target.value })); setDirty(true); }}
              disabled={isFetching || saving}
              style={{
                width: f.inputWidth ?? 90,
                padding: "7px 10px", borderRadius: 7, background: "#0f1623",
                border: `1px solid ${f.border}`, color: f.color, fontSize: 14, fontWeight: 600, outline: "none",
              }}
            />
          </label>
        ))}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "transparent" }}>.</span>
          <button
            onClick={handleSave}
            disabled={saving || isFetching || isInvalid(inputs)}
            style={{ padding: "7px 18px", borderRadius: 7, background: "#1e40af", color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, opacity: saving ? 0.7 : 1 }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {saved && !saving && (
          <span style={{ fontSize: 12, color: "#34d399", alignSelf: "flex-end", paddingBottom: 8 }}>Saved</span>
        )}
        {saveError && (
          <span style={{ fontSize: 12, color: "#f87171", alignSelf: "flex-end", paddingBottom: 8 }}>{saveError.message}</span>
        )}
        {supportsReset && data?.source === "db" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "transparent" }}>.</span>
            {!pendingReset ? (
              <button
                onClick={() => setPendingReset(true)}
                disabled={resetting || isFetching}
                style={{ padding: "7px 14px", borderRadius: 7, background: "transparent", color: "#9ca3af", border: "1px solid rgba(156,163,175,0.3)", cursor: "pointer", fontSize: 12, fontWeight: 500, opacity: (resetting || isFetching) ? 0.7 : 1 }}
              >
                {resetting ? "Resetting…" : "Reset to defaults"}
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, padding: "8px 12px" }}>
                <span style={{ fontSize: 12, color: "#fca5a5", fontWeight: 600 }}>Are you sure? This will revert to env-var defaults.</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => doReset()}
                    disabled={resetting || isFetching}
                    style={{ padding: "5px 14px", borderRadius: 6, background: "#dc2626", color: "#fff", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: (resetting || isFetching) ? 0.7 : 1 }}
                  >
                    {resetting ? "Resetting…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => setPendingReset(false)}
                    disabled={resetting || isFetching}
                    style={{ padding: "5px 14px", borderRadius: 6, background: "transparent", color: "#9ca3af", border: "1px solid rgba(156,163,175,0.3)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
