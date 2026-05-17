import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { StatTile } from "../components/ui/StatTile";
import { Modal } from "../components/ui/Modal";
import { api } from "../api/client";

interface AutomationRule {
  id: number;
  name: string;
  description: string | null;
  trigger: string;
  conditions: string | null;
  action: string;
  actionConfig: string;
  enabled: boolean;
  isSystem: boolean;
  cooldownMs: number | null;
  runCount: number;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface AutomationRun {
  id: number;
  ruleId: number;
  triggerEvent: string;
  triggerData: string | null;
  actionResult: string | null;
  status: string;
  error: string | null;
  createdAt: number;
}

const TRIGGER_LABELS: Record<string, string> = {
  signup_no_estimate: "Signed up but no estimate",
  estimate_created: "Estimate created",
  estimate_sent: "Estimate sent to client",
  trial_ending: "Trial ending soon",
  deal_stage_changed: "Deal stage changed",
  deal_created: "New deal created",
  deal_won: "Deal won",
  deal_lost: "Deal lost",
  user_inactive: "User inactive (7+ days)",
  subscription_upgraded: "Subscription upgraded",
  subscription_cancelled: "Subscription cancelled",
};

const ACTION_LABELS: Record<string, string> = {
  send_email: "Send email",
  move_deal_stage: "Move deal to stage",
  create_activity: "Create activity note",
  send_notification: "Send notification",
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function TriggerBadge({ trigger }: { trigger: string }) {
  const colors: Record<string, string> = {
    signup_no_estimate: "bg-yellow-500/20 text-yellow-400",
    estimate_created: "bg-blue-500/20 text-blue-400",
    deal_stage_changed: "bg-purple-500/20 text-purple-400",
    deal_won: "bg-green-500/20 text-green-400",
    deal_lost: "bg-red-500/20 text-red-400",
    user_inactive: "bg-orange-500/20 text-orange-400",
    subscription_upgraded: "bg-emerald-500/20 text-emerald-400",
    subscription_cancelled: "bg-red-500/20 text-red-400",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[trigger] || "bg-gray-500/20 text-gray-400"}`}>
      {TRIGGER_LABELS[trigger] || trigger}
    </span>
  );
}

export default function AutomationPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [selectedRule, setSelectedRule] = useState<AutomationRule | null>(null);
  const [showRuns, setShowRuns] = useState<number | null>(null);

  const { data: rulesData, isLoading } = useQuery({
    queryKey: ["automations"],
    queryFn: () => api.getAutomations(),
  });

  const { data: statsData } = useQuery({
    queryKey: ["automation-stats"],
    queryFn: () => api.getAutomationStats(),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.updateAutomation(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      queryClient.invalidateQueries({ queryKey: ["automation-stats"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteAutomation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      queryClient.invalidateQueries({ queryKey: ["automation-stats"] });
      setSelectedRule(null);
    },
  });

  const rules = (rulesData?.data?.rules || []) as AutomationRule[];
  const stats = (statsData?.data || null) as { activeRules: number; totalRuns: number; recentSuccessRate: number; totalRules: number } | null;

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-brand-textPrimary">Automations</h1>
            <p className="text-sm text-brand-textMuted mt-1">Behavior-triggered actions that run automatically</p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
            + New Rule
          </Button>
        </div>

        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <StatTile label="Active Rules" value={stats.activeRules} />
            <StatTile label="Total Runs" value={stats.totalRuns} />
            <StatTile label="Success Rate" value={`${stats.recentSuccessRate}%`} />
            <StatTile label="Total Rules" value={stats.totalRules} />
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-brand-card border border-brand-border rounded-lg p-4 animate-pulse h-24" />
            ))}
          </div>
        ) : rules.length === 0 ? (
          <Card>
            <div className="text-center py-8">
              <p className="text-brand-textMuted mb-4">No automation rules yet. Create your first rule to start automating.</p>
              <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>Create Rule</Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-3">
            {rules.map(rule => (
              <div key={rule.id} className="bg-brand-card border border-brand-border rounded-lg p-4 hover:border-brand-green/30 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-brand-textPrimary">{rule.name}</h3>
                      {rule.isSystem && <Badge variant="gray">System</Badge>}
                    </div>
                    {rule.description && (
                      <p className="text-xs text-brand-textMuted mb-2">{rule.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <TriggerBadge trigger={rule.trigger} />
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-brand-textMuted">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span className="text-xs text-brand-textMuted">{ACTION_LABELS[rule.action] || rule.action}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-xs text-brand-textMuted">{rule.runCount || 0} runs</p>
                      {rule.lastRunAt && (
                        <p className="text-xs text-brand-textMuted">Last: {formatDate(rule.lastRunAt)}</p>
                      )}
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => toggleMut.mutate({ id: rule.id, enabled: !rule.enabled })}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-brand-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-brand-green"></div>
                    </label>
                    <button
                      onClick={() => setShowRuns(showRuns === rule.id ? null : rule.id)}
                      className="text-xs text-brand-textMuted hover:text-brand-textPrimary"
                    >
                      History
                    </button>
                    {!rule.isSystem && (
                      <button
                        onClick={() => deleteMut.mutate(rule.id)}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {showRuns === rule.id && (
                  <RunHistory ruleId={rule.id} />
                )}
              </div>
            ))}
          </div>
        )}

        {showNew && (
          <NewRuleModal onClose={() => setShowNew(false)} />
        )}
      </div>
    </Layout>
  );
}

function RunHistory({ ruleId }: { ruleId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["automation-runs", ruleId],
    queryFn: () => api.getAutomationRuns(ruleId),
  });

  const runs = (data?.data?.runs || []) as AutomationRun[];

  if (isLoading) return <div className="mt-3 text-xs text-brand-textMuted">Loading...</div>;
  if (runs.length === 0) return <div className="mt-3 text-xs text-brand-textMuted">No runs yet</div>;

  return (
    <div className="mt-3 border-t border-brand-border pt-3">
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {runs.map(run => (
          <div key={run.id} className="flex items-center gap-3 text-xs">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${run.status === "success" ? "bg-green-400" : "bg-red-400"}`} />
            <span className="text-brand-textMuted">{formatDate(run.createdAt)}</span>
            <span className="text-brand-textPrimary">{run.triggerEvent}</span>
            {run.status === "failed" && run.error && (
              <span className="text-red-400 truncate">{run.error}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NewRuleModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    description: "",
    trigger: "estimate_created",
    action: "send_email",
    emailSubject: "",
    emailBody: "",
    targetStageName: "",
    activityDescription: "",
    notificationMessage: "",
  });

  const createMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.createAutomation(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      queryClient.invalidateQueries({ queryKey: ["automation-stats"] });
      onClose();
    },
  });

  const handleSubmit = () => {
    if (!form.name.trim()) return;

    let actionConfig: Record<string, string> = {};
    switch (form.action) {
      case "send_email":
        actionConfig = { emailSubject: form.emailSubject, emailBody: form.emailBody };
        break;
      case "move_deal_stage":
        actionConfig = { targetStageName: form.targetStageName };
        break;
      case "create_activity":
        actionConfig = { activityType: "note", activityDescription: form.activityDescription };
        break;
      case "send_notification":
        actionConfig = { notificationMessage: form.notificationMessage };
        break;
    }

    createMut.mutate({
      name: form.name,
      description: form.description || undefined,
      trigger: form.trigger,
      action: form.action,
      actionConfig,
    });
  };

  return (
    <Modal open={true} title="New Automation Rule" onClose={onClose}>
      <div className="space-y-4">
        <Input label="Rule Name" value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g., Follow up after estimate" />
        <Input label="Description" value={form.description} onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))} placeholder="What does this rule do?" />

        <div>
          <label className="block text-sm font-medium text-brand-textPrimary mb-1">When this happens (Trigger)</label>
          <select
            className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
            value={form.trigger}
            onChange={(e) => setForm(p => ({ ...p, trigger: e.target.value }))}
          >
            {Object.entries(TRIGGER_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-brand-textPrimary mb-1">Do this (Action)</label>
          <select
            className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary"
            value={form.action}
            onChange={(e) => setForm(p => ({ ...p, action: e.target.value }))}
          >
            {Object.entries(ACTION_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        {form.action === "send_email" && (
          <>
            <Input label="Email Subject" value={form.emailSubject} onChange={(e) => setForm(p => ({ ...p, emailSubject: e.target.value }))} placeholder="Subject line (use {{variable}} for dynamic data)" />
            <div>
              <label className="block text-sm font-medium text-brand-textPrimary mb-1">Email Body (HTML)</label>
              <textarea
                className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-textPrimary placeholder-brand-textMuted"
                value={form.emailBody}
                onChange={(e) => setForm(p => ({ ...p, emailBody: e.target.value }))}
                rows={4}
                placeholder="<p>Hello {{clientName}}...</p>"
              />
            </div>
          </>
        )}

        {form.action === "move_deal_stage" && (
          <Input label="Target Stage Name" value={form.targetStageName} onChange={(e) => setForm(p => ({ ...p, targetStageName: e.target.value }))} placeholder="e.g., Won" />
        )}

        {form.action === "create_activity" && (
          <Input label="Activity Description" value={form.activityDescription} onChange={(e) => setForm(p => ({ ...p, activityDescription: e.target.value }))} placeholder="e.g., Automated follow-up sent" />
        )}

        {form.action === "send_notification" && (
          <Input label="Notification Message" value={form.notificationMessage} onChange={(e) => setForm(p => ({ ...p, notificationMessage: e.target.value }))} placeholder="Notification text..." />
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={createMut.isPending || !form.name.trim()}>
            {createMut.isPending ? "Creating..." : "Create Rule"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
