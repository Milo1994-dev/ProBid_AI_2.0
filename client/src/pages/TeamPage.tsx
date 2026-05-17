import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Alert } from "../components/ui/Alert";
import { Input } from "../components/ui/Input";
import { api } from "../api/client";
import { usePageMeta } from "../hooks/usePageMeta";

function roleLabel(role: string) {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Member";
}

function roleVariant(role: string): "green" | "indigo" | "gray" {
  if (role === "owner") return "green";
  if (role === "admin") return "indigo";
  return "gray";
}

export default function TeamPage() {
  usePageMeta({
    title: "Team | ProBid AI",
    description: "Manage your ProBid AI team — invite members and collaborate on estimates.",
    canonical: "https://probidcore.net/app/team",
  });

  const [searchParams] = useSearchParams();
  const acceptCode = searchParams.get("accept");
  const qc = useQueryClient();

  const [inviteEmail, setInviteEmail] = useState("");
  const [teamName, setTeamName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["team"],
    queryFn: () => api.getTeam().then((r) => r.data),
  });

  const acceptMutation = useMutation({
    mutationFn: (code: string) => api.acceptTeamInvite(code),
    onSuccess: () => {
      setSuccess("You've joined the team!");
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (err: any) => setError(err?.apiError ?? "Failed to accept invite."),
  });

  const inviteMutation = useMutation({
    mutationFn: (email: string) => api.inviteTeamMember(email),
    onSuccess: () => {
      setSuccess(`Invite sent to ${inviteEmail}.`);
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (err: any) => setError(err?.apiError ?? "Failed to send invite."),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => api.removeTeamMember(memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (err: any) => setError(err?.apiError ?? "Failed to remove member."),
  });

  const cancelInviteMutation = useMutation({
    mutationFn: (inviteId: string) => api.cancelTeamInvite(inviteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (err: any) => setError(err?.apiError ?? "Failed to cancel invite."),
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) => api.renameTeam(name),
    onSuccess: () => {
      setSuccess("Team name updated.");
      setEditingName(false);
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (err: any) => setError(err?.apiError ?? "Failed to rename team."),
  });

  React.useEffect(() => {
    if (acceptCode) {
      acceptMutation.mutate(acceptCode);
    }
  }, [acceptCode]);

  React.useEffect(() => {
    if (data?.team?.name) setTeamName(data.team.name);
  }, [data?.team?.name]);

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-black text-brand-textPrimary mb-2">Team</h1>
        <p className="text-brand-textMuted mb-8">Collaborate with your crew on estimates.</p>

        {error && <Alert type="error" className="mb-4" onDismiss={() => setError("")}>{error}</Alert>}
        {success && <Alert type="success" className="mb-4" onDismiss={() => setSuccess("")}>{success}</Alert>}

        {isLoading && (
          <Card className="animate-pulse space-y-3">
            <div className="h-6 w-40 bg-brand-border rounded" />
            <div className="h-4 w-64 bg-brand-border rounded" />
          </Card>
        )}

        {isError && <Alert type="error">Failed to load team information.</Alert>}

        {!isLoading && !isError && data && !data.hasTeam && (
          <Card>
            <div className="text-center py-6">
              <div className="text-4xl mb-4">👥</div>
              <h2 className="text-lg font-bold text-brand-textPrimary mb-2">Business Plan Required</h2>
              <p className="text-brand-textMuted text-sm mb-6">{data.reason}</p>
              <Button onClick={() => window.location.href = "/app/billing"}>
                Upgrade to Business
              </Button>
            </div>
          </Card>
        )}

        {!isLoading && !isError && data?.hasTeam && (
          <div className="space-y-6">
            {/* Team name */}
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-brand-textPrimary">Team Name</h2>
                {!editingName && (
                  <Button variant="ghost" size="sm" onClick={() => setEditingName(true)}>Edit</Button>
                )}
              </div>
              {editingName ? (
                <div className="flex gap-3">
                  <Input
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder="Team name"
                    className="flex-1"
                  />
                  <Button
                    onClick={() => renameMutation.mutate(teamName)}
                    loading={renameMutation.isPending}
                  >
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => { setEditingName(false); setTeamName(data.team?.name ?? ""); }}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <p className="text-brand-textPrimary font-semibold">{data.team?.name}</p>
              )}
            </Card>

            {/* Members */}
            <Card>
              <h2 className="text-lg font-bold text-brand-textPrimary mb-4">
                Members <span className="text-brand-textMuted font-normal text-sm">({data.members?.length ?? 0})</span>
              </h2>
              <div className="space-y-3">
                {data.members?.map((m: any) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-brand-border bg-brand-bg/50">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-brand-indigo/20 flex items-center justify-center text-brand-indigo font-bold text-sm">
                        {m.email?.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-brand-textPrimary">{m.email}</p>
                        <p className="text-xs text-brand-textMuted">
                          Joined {new Date(m.joinedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={roleVariant(m.role)}>{roleLabel(m.role)}</Badge>
                      {m.role !== "owner" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeMutation.mutate(m.id)}
                          loading={removeMutation.isPending}
                          className="text-red-400 hover:text-red-300"
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Pending invites */}
            {(data.invites?.length ?? 0) > 0 && (
              <Card>
                <h2 className="text-lg font-bold text-brand-textPrimary mb-4">Pending Invites</h2>
                <div className="space-y-3">
                  {data.invites?.map((inv: any) => (
                    <div key={inv.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-brand-border bg-brand-bg/50">
                      <div>
                        <p className="text-sm font-semibold text-brand-textPrimary">{inv.email}</p>
                        <p className="text-xs text-brand-textMuted">
                          Expires {new Date(inv.expiresAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="gray">Pending</Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => cancelInviteMutation.mutate(inv.id)}
                          loading={cancelInviteMutation.isPending}
                          className="text-red-400 hover:text-red-300"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Invite form */}
            <Card>
              <h2 className="text-lg font-bold text-brand-textPrimary mb-2">Invite a Member</h2>
              <p className="text-sm text-brand-textMuted mb-4">
                Team members share your Business plan benefits — unlimited estimates, PDF exports, and more.
              </p>
              <div className="flex gap-3">
                <Input
                  type="email"
                  placeholder="colleague@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && inviteEmail) inviteMutation.mutate(inviteEmail);
                  }}
                  className="flex-1"
                />
                <Button
                  onClick={() => inviteMutation.mutate(inviteEmail)}
                  loading={inviteMutation.isPending}
                  disabled={!inviteEmail}
                >
                  Send Invite
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
