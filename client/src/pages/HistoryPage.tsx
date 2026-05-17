import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Alert } from "../components/ui/Alert";
import { Input } from "../components/ui/Input";
import { api, Estimate } from "../api/client";
import { usePageMeta } from "../hooks/usePageMeta";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function HistoryPage() {
  usePageMeta({
    title: "Estimate History | ProBid AI",
    description: "View and manage all your saved construction estimates in one place.",
    canonical: "https://probidcore.net/app/history",
  });

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["estimates", page, search],
    queryFn: () => api.getEstimates(page, search).then((r) => r.data),
  });

  const estimates: Estimate[] = data?.estimates ?? [];
  const total: number = data?.total ?? 0;
  const pages: number = data?.pages ?? 1;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  return (
    <Layout>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-black text-brand-textPrimary">Estimate History</h1>
          <p className="text-brand-textMuted mt-1 text-sm">{total} total estimates</p>
        </div>
        <div className="flex gap-2">
          <Link to="/app/estimate/builder">
            <Button variant="ghost">+ Itemized</Button>
          </Link>
          <Link to="/app/estimate/new">
            <Button>+ New Estimate</Button>
          </Link>
        </div>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-3 mb-6">
        <div className="flex-1">
          <Input
            placeholder="Search by job type or description…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary">Search</Button>
        {search && (
          <Button variant="ghost" onClick={() => { setSearch(""); setSearchInput(""); setPage(1); }}>
            Clear
          </Button>
        )}
      </form>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Card key={i} padding="md">
              <div className="animate-pulse flex gap-4 items-center">
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-brand-border rounded w-1/2" />
                  <div className="h-3 bg-brand-border rounded w-1/4" />
                </div>
                <div className="h-8 w-16 bg-brand-border rounded-lg" />
              </div>
            </Card>
          ))}
        </div>
      ) : isError ? (
        <Alert type="error">Failed to load estimates. Please try again.</Alert>
      ) : estimates.length === 0 ? (
        <Card padding="lg" className="text-center">
          <div className="text-4xl mb-3">{search ? "🔍" : "📋"}</div>
          <p className="text-brand-textMuted font-medium mb-2">
            {search ? "No estimates match your search" : "No estimates yet"}
          </p>
          {!search && (
            <Link to="/app/estimate/new">
              <Button className="mt-2">Create First Estimate</Button>
            </Link>
          )}
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3 mb-6">
            {estimates.map((est) => (
              <Link key={est.id} to={`/app/estimates/${est.id}`}>
                <Card hover padding="md" className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-brand-textPrimary capitalize truncate">
                      {est.jobType}
                    </p>
                    {est.details && (
                      <p className="text-sm text-brand-textSubtle truncate mt-0.5">{est.details}</p>
                    )}
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      <span className="text-xs text-brand-textSubtle">{formatDate(est.createdAt)}</span>
                      <span className="text-xs text-brand-textSubtle">·</span>
                      <span className="text-xs text-brand-textSubtle capitalize">{est.market}</span>
                      {est.clientName && (
                        <>
                          <span className="text-xs text-brand-textSubtle">·</span>
                          <span className="text-xs text-brand-textSubtle">{est.clientName}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Badge variant="indigo">View →</Badge>
                </Card>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {pages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </Button>
              <span className="text-sm text-brand-textMuted">
                Page {page} of {pages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                Next →
              </Button>
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
