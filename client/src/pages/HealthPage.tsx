import React, { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";

const SESSION_KEY = "probid_admin_key";

type HealthStatus = "green" | "yellow" | "red" | "unknown" | "paused";

interface Subsystem {
  key: string;
  label: string;
  description: string;
  status: HealthStatus;
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

interface ActiveAlert {
  id: number;
  type: string;
  severity: string;
  message: string;
  createdAt: number;
}

interface HealthData {
  generatedAt: number;
  overall: HealthStatus;
  subsystems: Subsystem[];
  pool: { count: number; total: number; windowMs: number };
  duplicateDealRaces: { count: number; total: number; windowMs: number };
  activeAlerts: ActiveAlert[];
  process: { bootedAt: number; uptimeMs: number; nodeVersion: string };
}

const STATUS_COLOR: Record<HealthStatus, string> = {
  green: "#22c55e",
  yellow: "#f59e0b",
  red: "#ef4444",
  unknown: "#64748b",
  paused: "#a855f7",
};

function fmtAgo(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / 86_400_000).toFixed(1)}d ago`;
}

async function fetchHealth(adminKey: string): Promise<HealthData> {
  const res = await fetch("/api/admin/health", {
    headers: { "x-admin-key": adminKey },
  });
  if (!res.ok) throw new Error(`/api/admin/health → ${res.status}`);
  const body = await res.json();
  return body.data as HealthData;
}

export default function HealthPage() {
  const [adminKey, setAdminKey] = useState(
    () => sessionStorage.getItem(SESSION_KEY) || "",
  );
  const [inputKey, setInputKey] = useState("");
  const [digestStatus, setDigestStatus] = useState<string | null>(null);

  const { data, isFetching, error, dataUpdatedAt, refetch } = useQuery<
    HealthData,
    Error
  >({
    queryKey: ["admin-health", adminKey],
    queryFn: () => fetchHealth(adminKey),
    enabled: !!adminKey,
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 1,
  });

  const sendDigest = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/health/digest-send", {
        method: "POST",
        headers: { "x-admin-key": adminKey },
      });
      const body = await res.json();
      return body;
    },
    onSuccess: (body) => {
      setDigestStatus(
        body.success
          ? "Digest sent."
          : `Skipped: ${body.data?.reason ?? "unknown"}`,
      );
    },
    onError: (err: Error) => setDigestStatus(`Error: ${err.message}`),
  });

  const saveKey = useCallback(() => {
    const k = inputKey.trim();
    if (k) {
      sessionStorage.setItem(SESSION_KEY, k);
      setAdminKey(k);
    }
  }, [inputKey]);

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0f1117",
    color: "#f9fafb",
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: "32px 24px",
    maxWidth: 1100,
    margin: "0 auto",
  };

  if (!adminKey) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            background: "#1a1f2e",
            borderRadius: 14,
            padding: "36px 32px",
            maxWidth: 420,
            margin: "10vh auto 0",
            border: "1px solid #374151",
          }}
        >
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 6px" }}>
            ProBid Admin — Health
          </h2>
          <p style={{ color: "#9ca3af", marginBottom: 22, fontSize: 14 }}>
            Enter your admin key to view the watchtower.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              autoFocus
              type="password"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKey()}
              placeholder="Admin key"
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "#0f1117",
                color: "#f9fafb",
                fontSize: 14,
                outline: "none",
              }}
            />
            <button
              onClick={saveKey}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                background: "#22c55e",
                color: "#fff",
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Access
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>
            Stability Watchtower
          </h1>
          <p style={{ color: "#9ca3af", margin: "4px 0 0", fontSize: 13 }}>
            Live system health · auto-refresh every 30s
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data && (
            <span
              style={{
                padding: "6px 12px",
                borderRadius: 20,
                background: STATUS_COLOR[data.overall],
                color: "#0f1117",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              OVERALL: {data.overall.toUpperCase()}
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "#1a1f2e",
              color: "#f9fafb",
              cursor: "pointer",
              fontSize: 13,
              opacity: isFetching ? 0.6 : 1,
            }}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div
          style={{
            padding: 16,
            background: "#7f1d1d",
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          {error.message}
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
              marginBottom: 16,
              fontSize: 13,
              color: "#9ca3af",
            }}
          >
            <span>
              Booted{" "}
              <strong style={{ color: "#f9fafb" }}>
                {fmtAgo(Date.now() - data.process.bootedAt)}
              </strong>
            </span>
            <span>
              Last refresh{" "}
              <strong style={{ color: "#f9fafb" }}>
                {dataUpdatedAt ? fmtAgo(Date.now() - dataUpdatedAt) : "—"}
              </strong>
            </span>
            <span>
              Pool resets/hr{" "}
              <strong style={{ color: "#f9fafb" }}>{data.pool.count}</strong>
            </span>
            <span>
              Dupe races/hr{" "}
              <strong
                style={{
                  color:
                    data.duplicateDealRaces.count > 0 ? "#f59e0b" : "#f9fafb",
                }}
              >
                {data.duplicateDealRaces.count}
              </strong>
            </span>
            <span>
              Dupe races (all time){" "}
              <strong
                style={{
                  color:
                    data.duplicateDealRaces.total > 0 ? "#f59e0b" : "#f9fafb",
                }}
              >
                {data.duplicateDealRaces.total}
              </strong>
            </span>
          </div>

          {data.activeAlerts.length > 0 && (
            <section
              style={{
                background: "#1a1f2e",
                border: "1px solid #ef4444",
                borderRadius: 12,
                padding: 16,
                marginBottom: 20,
              }}
            >
              <h2
                style={{
                  fontSize: 16,
                  margin: "0 0 12px",
                  color: "#ef4444",
                }}
              >
                {data.activeAlerts.length} active alert
                {data.activeAlerts.length === 1 ? "" : "s"}
              </h2>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.activeAlerts.map((a) => (
                  <li
                    key={a.id}
                    style={{ marginBottom: 6, fontSize: 13 }}
                  >
                    <strong
                      style={{
                        color:
                          a.severity === "critical" ? "#ef4444" : "#f59e0b",
                      }}
                    >
                      [{a.severity.toUpperCase()}]
                    </strong>{" "}
                    {a.type} — {a.message}{" "}
                    <span style={{ color: "#9ca3af" }}>
                      ({fmtAgo(Date.now() - a.createdAt)})
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 12,
              marginBottom: 24,
            }}
          >
            {data.subsystems.map((s) => (
              <div
                key={s.key}
                style={{
                  background: "#1a1f2e",
                  borderRadius: 12,
                  padding: 16,
                  border: `1px solid ${STATUS_COLOR[s.status]}55`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <h3 style={{ fontSize: 15, margin: 0 }}>{s.label}</h3>
                  <span
                    style={{
                      padding: "2px 10px",
                      borderRadius: 12,
                      background: STATUS_COLOR[s.status],
                      color: "#0f1117",
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {s.status.toUpperCase()}
                  </span>
                </div>
                <p
                  style={{
                    color: "#9ca3af",
                    fontSize: 12,
                    margin: "0 0 10px",
                    lineHeight: 1.4,
                  }}
                >
                  {s.description}
                </p>
                <ul
                  style={{
                    margin: "0 0 8px",
                    paddingLeft: 16,
                    color: "#e5e7eb",
                    fontSize: 12,
                  }}
                >
                  {s.reasons.map((r, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>
                      {r}
                    </li>
                  ))}
                </ul>
                <div
                  style={{
                    fontSize: 11,
                    color: "#64748b",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <span>
                    Last success:{" "}
                    {s.lastSuccessAt
                      ? fmtAgo(Date.now() - s.lastSuccessAt)
                      : "—"}
                  </span>
                  <span>24h items: {s.throughput24h}</span>
                  <span>24h failures: {s.failureCount24h}</span>
                </div>
              </div>
            ))}
          </section>

          <section
            style={{
              background: "#1a1f2e",
              borderRadius: 12,
              padding: 16,
              border: "1px solid #374151",
            }}
          >
            <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Daily Digest</h2>
            <p
              style={{
                color: "#9ca3af",
                fontSize: 13,
                margin: "0 0 12px",
              }}
            >
              A rolled-up summary auto-emails to ADMIN_EMAIL every day at
              07:30 UTC. You can preview or send one on demand:
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={() => sendDigest.mutate()}
                disabled={sendDigest.isPending}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: "#22d3ee",
                  color: "#0f1117",
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  opacity: sendDigest.isPending ? 0.6 : 1,
                }}
              >
                {sendDigest.isPending ? "Sending…" : "Send digest now"}
              </button>
              {digestStatus && (
                <span style={{ color: "#9ca3af", fontSize: 13 }}>
                  {digestStatus}
                </span>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
