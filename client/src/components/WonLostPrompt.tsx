import React, { useState } from "react";

interface WonLostPromptProps {
  estimateId: string;
  initialStatus?: string | null;
}

export function WonLostPrompt({ estimateId, initialStatus }: WonLostPromptProps) {
  const [status, setStatus] = useState<string | null>(initialStatus ?? null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");

  const mark = async (newStatus: "won" | "lost" | "none") => {
    setLoading(newStatus);
    setError("");
    try {
      const res = await fetch(`/api/estimates/${estimateId}/won-lost`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const body = await res.json();
      if (body.success) {
        setStatus(newStatus === "none" ? null : newStatus);
      } else {
        setError(body.error || "Could not update status.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(null);
    }
  };

  if (status === "won") {
    return (
      <div className="mt-4 rounded-xl bg-green-900/25 border border-green-700/40 px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-green-400 text-lg">🏆</span>
          <p className="text-sm font-semibold text-green-300">Job won! Congratulations.</p>
        </div>
        <button
          onClick={() => mark("none")}
          className="text-xs text-slate-500 hover:text-slate-400 underline"
          disabled={loading !== null}
        >
          Undo
        </button>
      </div>
    );
  }

  if (status === "lost") {
    return (
      <div className="mt-4 rounded-xl bg-slate-800/50 border border-slate-700/50 px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-slate-400 text-lg">📋</span>
          <div>
            <p className="text-sm font-semibold text-slate-300">Marked as lost.</p>
            <p className="text-xs text-slate-500">
              Not winning jobs?{" "}
              <a href="/app/guarantees" className="text-brand-green hover:underline">
                Check your Win-Jobs Guarantee →
              </a>
            </p>
          </div>
        </div>
        <button
          onClick={() => mark("none")}
          className="text-xs text-slate-500 hover:text-slate-400 underline"
          disabled={loading !== null}
        >
          Undo
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl bg-slate-800/40 border border-slate-700/50 px-4 py-3">
      <p className="text-sm font-semibold text-slate-300 mb-2">Did you win this job?</p>
      <p className="text-xs text-slate-500 mb-3">
        Track wins to improve your estimates — and unlock the{" "}
        <a href="/app/guarantees" className="text-brand-green hover:underline">
          Win-Jobs Guarantee
        </a>{" "}
        if you need it.
      </p>
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => mark("won")}
          disabled={loading !== null}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-700/30 text-green-300 border border-green-700/40 hover:bg-green-700/50 transition-colors disabled:opacity-50"
        >
          {loading === "won" ? "Saving…" : "✓ Yes, I won it"}
        </button>
        <button
          onClick={() => mark("lost")}
          disabled={loading !== null}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700/30 text-slate-400 border border-slate-600/40 hover:bg-slate-700/50 transition-colors disabled:opacity-50"
        >
          {loading === "lost" ? "Saving…" : "✗ No, lost this one"}
        </button>
      </div>
    </div>
  );
}
