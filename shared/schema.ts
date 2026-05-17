import {
  pgTable,
  text,
  integer,
  serial,
  real,
  index,
  uniqueIndex,
  unique,
  timestamp,
  bigint,
  boolean,
} from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").unique(),
    phone: text("phone"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    affiliateCode: text("affiliate_code").unique(),
    referredByCode: text("referred_by_code"),
    referredByUserId: text("referred_by_user_id"),
    commissionRate: real("commission_rate").default(0.2),
    hasSeenOnboarding: boolean("has_seen_onboarding").default(false),
    passwordHash: text("password_hash"),
    role: text("role").default("user"),
    referralBonusEstimates: integer("referral_bonus_estimates").default(0),
    pdfShowGuaranteeBadges: boolean("pdf_show_guarantee_badges").default(true),
  },
  (table) => [index("idx_users_email").on(table.email)],
);

export const stripeCustomers = pgTable("stripe_customers", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  stripeCustomerId: text("stripe_customer_id").notNull(),
});

export const subscriptions = pgTable("subscriptions", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  status: text("status").notNull(),
  priceId: text("price_id"),
  currentPeriodEnd: bigint("current_period_end", { mode: "number" }),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Inbound Stripe webhook events we've already processed. Stripe will retry
// webhook delivery on non-2xx responses (and occasionally re-deliver on 2xx
// network hiccups), so we gate the entire handler on inserting the event id
// here first to make every event_type processing path idempotent.
export const processedStripeEvents = pgTable(
  "processed_stripe_events",
  {
    eventId: text("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_processed_stripe_events_received_at").on(table.receivedAt)],
);

export const usage = pgTable(
  "usage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    dayKey: text("day_key").notNull(),
    estimatesCount: integer("estimates_count").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_usage_day").on(table.dayKey),
    unique("usage_pkey").on(table.userId, table.dayKey),
  ],
);

export const estimates = pgTable(
  "estimates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    jobType: text("job_type").notNull(),
    market: text("market").notNull(),
    details: text("details"),
    estimateText: text("estimate_text").notNull(),
    name: text("name"),
    source: text("source"),
    clientName: text("client_name"),
    clientEmail: text("client_email"),
    clientPhone: text("client_phone"),
    status: text("status"),
    generationStartedAt: bigint("generation_started_at", { mode: "number" }),
    generationCompletedAt: bigint("generation_completed_at", { mode: "number" }),
    wonLostStatus: text("won_lost_status"),
    wonLostUpdatedAt: bigint("won_lost_updated_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_estimates_user").on(table.userId),
    index("idx_estimates_created").on(table.createdAt),
  ],
);

export const estimateLineItems = pgTable(
  "estimate_line_items",
  {
    id: text("id").primaryKey(),
    estimateId: text("estimate_id")
      .notNull()
      .references(() => estimates.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: real("quantity").notNull(),
    unitCost: real("unit_cost").notNull(),
    uom: text("uom"),
    costType: text("cost_type"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_estimate_line_items_estimate").on(table.estimateId)],
);

export const leads = pgTable(
  "leads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    notes: text("notes"),
    status: text("status").default("new"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_leads_user").on(table.userId),
    index("idx_leads_status").on(table.status),
  ],
);

export const analytics = pgTable(
  "analytics",
  {
    id: serial("id").primaryKey(),
    event: text("event").notNull(),
    userId: text("user_id"),
    data: text("data"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_analytics_event").on(table.event),
    index("idx_analytics_created").on(table.createdAt),
  ],
);

// Denormalized projection of "guarantee_badge_click" analytics events.
// Populated alongside the analytics row whenever a homeowner taps a trust
// badge in a PDF estimate. Exists so per-estimate aggregation
// (history page + /estimate/:id) can run as an indexed SQL GROUP BY
// instead of scanning the full analytics table and JSON-parsing in Node.
export const guaranteeBadgeClicks = pgTable(
  "guarantee_badge_clicks",
  {
    id: serial("id").primaryKey(),
    estimateId: text("estimate_id").notNull(),
    utmContent: text("utm_content"),
    userId: text("user_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_guarantee_badge_clicks_estimate").on(table.estimateId),
    index("idx_guarantee_badge_clicks_estimate_utm").on(
      table.estimateId,
      table.utmContent,
    ),
    index("idx_guarantee_badge_clicks_created").on(table.createdAt),
  ],
);

export const affiliateClicks = pgTable(
  "affiliate_clicks",
  {
    id: serial("id").primaryKey(),
    affiliateCode: text("affiliate_code").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_affiliate_clicks_code").on(table.affiliateCode)],
);

export const referrals = pgTable(
  "referrals",
  {
    id: serial("id").primaryKey(),
    referrerUserId: text("referrer_user_id").notNull(),
    referredUserId: text("referred_user_id").notNull(),
    status: text("status").default("signed_up"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_referrals_referrer").on(table.referrerUserId),
    index("idx_referrals_referred").on(table.referredUserId),
    unique("referrals_unique").on(table.referrerUserId, table.referredUserId),
  ],
);

export const affiliateEarnings = pgTable(
  "affiliate_earnings",
  {
    id: serial("id").primaryKey(),
    affiliateUserId: text("affiliate_user_id").notNull(),
    referredUserId: text("referred_user_id").notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").default("usd"),
    status: text("status").default("pending"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_affiliate_earnings_user").on(table.affiliateUserId),
    index("idx_affiliate_earnings_status").on(table.status),
  ],
);

export const seoPages = pgTable(
  "seo_pages",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").unique().notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_seo_pages_slug").on(table.slug)],
);

export const estimateTemplates = pgTable(
  "estimate_templates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    jobType: text("job_type").notNull(),
    market: text("market").notNull(),
    details: text("details"),
    clientName: text("client_name"),
    clientEmail: text("client_email"),
    clientPhone: text("client_phone"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_estimate_templates_user").on(table.userId)],
);

export const savedLineItems = pgTable(
  "saved_line_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    description: text("description").notNull(),
    quantity: real("quantity").notNull(),
    unitCost: real("unit_cost").notNull(),
    uom: text("uom"),
    costType: text("cost_type"),
    tag: text("tag"),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_saved_line_items_user").on(table.userId),
    index("idx_saved_line_items_user_last_used").on(
      table.userId,
      table.lastUsedAt,
    ),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_teams_owner").on(table.ownerUserId)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    invitedBy: text("invited_by"),
    joinedAt: bigint("joined_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_team_members_team").on(table.teamId),
    index("idx_team_members_user").on(table.userId),
  ],
);

export const teamInvites = pgTable(
  "team_invites",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    email: text("email").notNull(),
    inviteCode: text("invite_code").unique().notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_team_invites_team").on(table.teamId),
    index("idx_team_invites_code").on(table.inviteCode),
    index("idx_team_invites_email").on(table.email),
  ],
);

export const purchases = pgTable(
  "purchases",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    amountCents: integer("amount_cents").notNull(),
    creditsRemaining: integer("credits_remaining"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_purchases_user").on(table.userId),
    index("idx_purchases_type").on(table.type),
  ],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  stripeCustomer: one(stripeCustomers),
  subscription: one(subscriptions),
  estimates: many(estimates),
  leads: many(leads),
  estimateTemplates: many(estimateTemplates),
  ownedTeams: many(teams),
  teamMemberships: many(teamMembers),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  owner: one(users, { fields: [teams.ownerUserId], references: [users.id] }),
  members: many(teamMembers),
  invites: many(teamInvites),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));

export const teamInvitesRelations = relations(teamInvites, ({ one }) => ({
  team: one(teams, { fields: [teamInvites.teamId], references: [teams.id] }),
  createdByUser: one(users, {
    fields: [teamInvites.createdBy],
    references: [users.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Estimate = typeof estimates.$inferSelect;
export type InsertEstimate = typeof estimates.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type InsertLead = typeof leads.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type InsertTeam = typeof teams.$inferInsert;

// ============================================================
// REFERRAL LEADS
// ============================================================

export const referralLeads = pgTable(
  "referral_leads",
  {
    id: serial("id").primaryKey(),
    email: text("email").unique().notNull(),
    referralCode: text("referral_code"),
    convertedToUser: boolean("converted_to_user").default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_referral_leads_email").on(table.email),
    index("idx_referral_leads_referral_code").on(table.referralCode),
  ],
);

export type ReferralLead = typeof referralLeads.$inferSelect;
export type InsertReferralLead = typeof referralLeads.$inferInsert;

// ============================================================
// PROCORE TRUST ENGINE SCHEMA
// ============================================================

export const procoreConnections = pgTable(
  "procore_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    procoreCompanyId: text("procore_company_id").notNull(),
    companyName: text("company_name"),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    tokenExpiresAt: bigint("token_expires_at", { mode: "number" }).notNull(),
    scopes: text("scopes"),
    status: text("status").default("active"),
    lastSyncAt: bigint("last_sync_at", { mode: "number" }),
    includeInPublicBenchmarks: integer("include_in_public_benchmarks").default(
      0,
    ),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_procore_connections_user").on(table.userId),
    index("idx_procore_connections_company").on(table.procoreCompanyId),
    unique("procore_connections_user_company").on(
      table.userId,
      table.procoreCompanyId,
    ),
  ],
);

export const procoreProjects = pgTable(
  "procore_projects",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => procoreConnections.id),
    procoreProjectId: text("procore_project_id").notNull(),
    name: text("name").notNull(),
    projectNumber: text("project_number"),
    trade: text("trade"),
    region: text("region"),
    address: text("address"),
    city: text("city"),
    state: text("state"),
    zipCode: text("zip_code"),
    projectValueUsd: real("project_value_usd"),
    status: text("status"),
    startDate: text("start_date"),
    completionDate: text("completion_date"),
    closeDate: text("close_date"),
    originalEstimateUsd: real("original_estimate_usd"),
    actualCostUsd: real("actual_cost_usd"),
    changeOrderCount: integer("change_order_count").default(0),
    changeOrderValueUsd: real("change_order_value_usd").default(0),
    isClosed: integer("is_closed").default(0),
    rawData: text("raw_data"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_procore_projects_connection").on(table.connectionId),
    index("idx_procore_projects_closed").on(table.isClosed),
    index("idx_procore_projects_trade").on(table.trade),
    unique("procore_projects_unique").on(
      table.connectionId,
      table.procoreProjectId,
    ),
  ],
);

export const procoreBudgetItems = pgTable(
  "procore_budget_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => procoreProjects.id),
    costCode: text("cost_code").notNull(),
    costCodeDescription: text("cost_code_description"),
    budgetedAmountUsd: real("budgeted_amount_usd"),
    actualAmountUsd: real("actual_amount_usd"),
    variance: real("variance"),
    rawData: text("raw_data"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_procore_budget_items_project").on(table.projectId),
    index("idx_procore_budget_items_cost_code").on(table.costCode),
  ],
);

export const shadowEstimates = pgTable(
  "shadow_estimates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => procoreProjects.id),
    probidEstimateLow: real("probid_estimate_low"),
    probidEstimateBase: real("probid_estimate_base"),
    probidEstimateHigh: real("probid_estimate_high"),
    estimateDetails: text("estimate_details"),
    generatedAt: bigint("generated_at", { mode: "number" }).notNull(),
    modelVersion: text("model_version"),
    inputHash: text("input_hash"),
  },
  (table) => [index("idx_shadow_estimates_project").on(table.projectId)],
);

export const procoreMetrics = pgTable(
  "procore_metrics",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => procoreConnections.id),
    projectId: text("project_id").references(() => procoreProjects.id),
    metricType: text("metric_type").notNull(),
    value: real("value").notNull(),
    sampleSize: integer("sample_size"),
    percentile: text("percentile"),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    metadata: text("metadata"),
    calculatedAt: bigint("calculated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_procore_metrics_connection").on(table.connectionId),
    index("idx_procore_metrics_project").on(table.projectId),
    index("idx_procore_metrics_type").on(table.metricType),
  ],
);

export const proofAssets = pgTable(
  "proof_assets",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => procoreConnections.id),
    assetType: text("asset_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    filePath: text("file_path"),
    fileUrl: text("file_url"),
    content: text("content"),
    isPublic: integer("is_public").default(0),
    approvedAt: bigint("approved_at", { mode: "number" }),
    approvedBy: text("approved_by"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    metadata: text("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_proof_assets_connection").on(table.connectionId),
    index("idx_proof_assets_type").on(table.assetType),
    index("idx_proof_assets_public").on(table.isPublic),
  ],
);

export const procoreEstimatePushes = pgTable(
  "procore_estimate_pushes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    estimateId: text("estimate_id")
      .notNull()
      .references(() => estimates.id),
    connectionId: text("connection_id")
      .notNull()
      .references(() => procoreConnections.id),
    procoreProjectId: text("procore_project_id").notNull(),
    procoreCompanyId: text("procore_company_id").notNull(),
    projectName: text("project_name"),
    status: text("status").default("pushed"),
    budgetItemsPushed: integer("budget_items_pushed").default(0),
    pdfUploaded: integer("pdf_uploaded").default(0),
    procoreProjectUrl: text("procore_project_url"),
    errorMessage: text("error_message"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_procore_pushes_user").on(table.userId),
    index("idx_procore_pushes_estimate").on(table.estimateId),
    index("idx_procore_pushes_connection").on(table.connectionId),
    unique("procore_pushes_unique").on(table.estimateId, table.connectionId),
  ],
);

export const aggregateBenchmarks = pgTable(
  "aggregate_benchmarks",
  {
    id: text("id").primaryKey(),
    benchmarkType: text("benchmark_type").notNull(),
    trade: text("trade"),
    region: text("region"),
    sampleSize: integer("sample_size").notNull(),
    p25: real("p25"),
    p50: real("p50"),
    p75: real("p75"),
    p90: real("p90"),
    mean: real("mean"),
    metadata: text("metadata"),
    calculatedAt: bigint("calculated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_aggregate_benchmarks_type").on(table.benchmarkType),
    index("idx_aggregate_benchmarks_trade").on(table.trade),
  ],
);

// Procore Relations
export const procoreConnectionsRelations = relations(
  procoreConnections,
  ({ one, many }) => ({
    user: one(users, {
      fields: [procoreConnections.userId],
      references: [users.id],
    }),
    projects: many(procoreProjects),
    metrics: many(procoreMetrics),
    proofAssets: many(proofAssets),
  }),
);

export const procoreProjectsRelations = relations(
  procoreProjects,
  ({ one, many }) => ({
    connection: one(procoreConnections, {
      fields: [procoreProjects.connectionId],
      references: [procoreConnections.id],
    }),
    budgetItems: many(procoreBudgetItems),
    shadowEstimates: many(shadowEstimates),
    metrics: many(procoreMetrics),
  }),
);

export const procoreBudgetItemsRelations = relations(
  procoreBudgetItems,
  ({ one }) => ({
    project: one(procoreProjects, {
      fields: [procoreBudgetItems.projectId],
      references: [procoreProjects.id],
    }),
  }),
);

export const shadowEstimatesRelations = relations(
  shadowEstimates,
  ({ one }) => ({
    project: one(procoreProjects, {
      fields: [shadowEstimates.projectId],
      references: [procoreProjects.id],
    }),
  }),
);

export const procoreMetricsRelations = relations(procoreMetrics, ({ one }) => ({
  connection: one(procoreConnections, {
    fields: [procoreMetrics.connectionId],
    references: [procoreConnections.id],
  }),
  project: one(procoreProjects, {
    fields: [procoreMetrics.projectId],
    references: [procoreProjects.id],
  }),
}));

export const proofAssetsRelations = relations(proofAssets, ({ one }) => ({
  connection: one(procoreConnections, {
    fields: [proofAssets.connectionId],
    references: [procoreConnections.id],
  }),
}));

// Types
export type ProcoreConnection = typeof procoreConnections.$inferSelect;
export type InsertProcoreConnection = typeof procoreConnections.$inferInsert;
export type ProcoreProject = typeof procoreProjects.$inferSelect;
export type InsertProcoreProject = typeof procoreProjects.$inferInsert;
export type ShadowEstimate = typeof shadowEstimates.$inferSelect;
export type InsertShadowEstimate = typeof shadowEstimates.$inferInsert;
export type ProcoreMetric = typeof procoreMetrics.$inferSelect;
export type InsertProcoreMetric = typeof procoreMetrics.$inferInsert;
export type ProofAsset = typeof proofAssets.$inferSelect;
export type InsertProofAsset = typeof proofAssets.$inferInsert;

export const insertUserSchema = createInsertSchema(users);
export const insertEstimateSchema = createInsertSchema(estimates);
export const insertLeadSchema = createInsertSchema(leads);

// ============================================================
// EMAIL DRIP QUEUE SCHEMA
// ============================================================

export const emailDripQueue = pgTable(
  "email_drip_queue",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    userId: text("user_id"),
    templateKey: text("template_key").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    sentAt: text("sent_at"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_email_drip_queue_status").on(table.status),
    index("idx_email_drip_queue_scheduled").on(table.scheduledFor),
    index("idx_email_drip_queue_email").on(table.email),
    unique("uq_email_drip_queue_email_template").on(
      table.email,
      table.templateKey,
    ),
  ],
);

export type EmailDripQueue = typeof emailDripQueue.$inferSelect;
export type InsertEmailDripQueue = typeof emailDripQueue.$inferInsert;

// ============================================================
// DUNNING EVENTS SCHEMA
// ============================================================

export const dunningEvents = pgTable(
  "dunning_events",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    amountDueCents: integer("amount_due_cents").notNull(),
    currency: text("currency").default("usd"),
    firstFailedAt: bigint("first_failed_at", { mode: "number" }).notNull(),
    immediateEmailSentAt: bigint("immediate_email_sent_at", { mode: "number" }),
    day3EmailSentAt: bigint("day3_email_sent_at", { mode: "number" }),
    day7EmailSentAt: bigint("day7_email_sent_at", { mode: "number" }),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    status: text("status").notNull().default("active"),
  },
  (table) => [
    index("idx_dunning_events_user").on(table.userId),
    index("idx_dunning_events_status").on(table.status),
    index("idx_dunning_events_first_failed").on(table.firstFailedAt),
    unique("uq_dunning_events_invoice").on(table.stripeInvoiceId),
  ],
);

export type DunningEvent = typeof dunningEvents.$inferSelect;
export type InsertDunningEvent = typeof dunningEvents.$inferInsert;

// ============================================================
// LAUNCH TASKS SCHEMA
// ============================================================

export const launchTasks = pgTable("launch_tasks", {
  id: serial("id").primaryKey(),
  task: text("task").notNull(),
  done: boolean("done").default(false),
  category: text("category"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type LaunchTask = typeof launchTasks.$inferSelect;
export type InsertLaunchTask = typeof launchTasks.$inferInsert;

// ============================================================
// AI CHAT SCHEMA
// ============================================================

export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_conversations_user").on(table.userId)],
);

// Legacy `messages` table — superseded by `chat_messages` below but still
// present in production with 0 rows. Kept declared here so drizzle-kit's
// pre-flight migration check sees zero diff and never asks "is this a
// rename?" prompts that block non-interactive deploys.
export const legacyMessages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = typeof chatMessages.$inferInsert;

// ============================================================
// LEAD SCRAPING & OUTREACH SCHEMA
// ============================================================

export const scrapedLeads = pgTable(
  "scraped_leads",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    businessType: text("business_type"),
    location: text("location"),
    website: text("website"),
    source: text("source").default("google_places"),
    stage: text("stage").default("new"),
    score: integer("score").default(0),
    doNotContact: boolean("do_not_contact").default(false),
    unsubscribeToken: text("unsubscribe_token").unique(
      "scraped_leads_unsubscribe_token_key",
    ),
    openedAt: bigint("opened_at", { mode: "number" }),
    clickedAt: bigint("clicked_at", { mode: "number" }),
    repliedAt: bigint("replied_at", { mode: "number" }),
    convertedAt: bigint("converted_at", { mode: "number" }),
    smsSentAt: bigint("sms_sent_at", { mode: "number" }),
    // Comma-separated contact channels in priority order.
    // Values from {phone, sms, email, website_form}, e.g. "phone,sms,website_form,email".
    // Null for legacy rows; computed at insert time for new rows.
    contactMethodPriority: text("contact_method_priority"),
    // Contactability bucket — independent of `stage` (which tracks engagement).
    // Values: "fully_contactable" (has email + at least one other), "no_email_but_contactable"
    // (no email but has phone or website), "email_only", "uncontactable" (defensive — should
    // never hit the table because the scraper drops uncontactable candidates).
    leadStatus: text("lead_status").default("fully_contactable"),
    // Timestamp of the most recent successful website-form-outreach attempt
    // (form submission or contact-page scrape). Null until attempted.
    websiteOutreachAt: bigint("website_outreach_at", { mode: "number" }),
    // Legacy column kept to match prod and prevent destructive DROP at deploy
    // pre-flight. Not currently read or written by application code.
    lastOutreachAt: bigint("last_outreach_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_scraped_leads_email").on(table.email),
    index("idx_scraped_leads_phone").on(table.phone),
    index("idx_scraped_leads_dnc").on(table.doNotContact),
    index("idx_scraped_leads_unsubscribe").on(table.unsubscribeToken),
    index("idx_scraped_leads_created").on(table.createdAt),
    index("idx_scraped_leads_stage").on(table.stage),
    index("idx_scraped_leads_score").on(table.score),
    index("idx_scraped_leads_lead_status").on(table.leadStatus),
  ],
);

export const leadOutreachQueue = pgTable(
  "lead_outreach_queue",
  {
    id: serial("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => scrapedLeads.id),
    templateId: text("template_id").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    sentAt: text("sent_at"),
    status: text("status").notNull().default("pending"),
    openToken: text("open_token").unique("lead_outreach_queue_open_token_key"),
    clickToken: text("click_token").unique(
      "lead_outreach_queue_click_token_key",
    ),
    unsubscribeToken: text("unsubscribe_token").unique(
      "lead_outreach_queue_unsubscribe_token_key",
    ),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_loq_lead").on(table.leadId),
    index("idx_loq_status").on(table.status),
    index("idx_loq_scheduled").on(table.scheduledFor),
    index("idx_loq_open_token").on(table.openToken),
    index("idx_loq_click_token").on(table.clickToken),
    index("idx_loq_unsub_token").on(table.unsubscribeToken),
  ],
);

export const leadEmailAuditLog = pgTable(
  "lead_email_audit_log",
  {
    id: serial("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => scrapedLeads.id),
    templateId: text("template_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull(),
    sentAt: text("sent_at").notNull(),
  },
  (table) => [
    index("idx_leal_lead").on(table.leadId),
    index("idx_leal_status").on(table.status),
    index("idx_leal_sent").on(table.sentAt),
  ],
);

export type ScrapedLead = typeof scrapedLeads.$inferSelect;
export type InsertScrapedLead = typeof scrapedLeads.$inferInsert;
export type LeadOutreachQueue = typeof leadOutreachQueue.$inferSelect;
export type InsertLeadOutreachQueue = typeof leadOutreachQueue.$inferInsert;
export type LeadEmailAuditLog = typeof leadEmailAuditLog.$inferSelect;
export type InsertLeadEmailAuditLog = typeof leadEmailAuditLog.$inferInsert;

export const leadOutreachConfig = pgTable("lead_outreach_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type LeadOutreachConfig = typeof leadOutreachConfig.$inferSelect;
export type InsertLeadOutreachConfig = typeof leadOutreachConfig.$inferInsert;

// ============================================================
// ADS CAMPAIGNS SCHEMA
// ============================================================

export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: serial("id").primaryKey(),
    platform: text("platform").notNull(),
    name: text("name").notNull(),
    budget: real("budget").default(0),
    spend: real("spend").default(0),
    clicks: integer("clicks").default(0),
    impressions: integer("impressions").default(0),
    status: text("status").notNull().default("active"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_ad_campaigns_status").on(table.status),
    index("idx_ad_campaigns_platform").on(table.platform),
    index("idx_ad_campaigns_created").on(table.createdAt),
  ],
);

export type AdCampaign = typeof adCampaigns.$inferSelect;
export type InsertAdCampaign = typeof adCampaigns.$inferInsert;

// ============================================================
// SYSTEM ALERTS SCHEMA
// ============================================================

export const systemAlerts = pgTable(
  "system_alerts",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    message: text("message").notNull(),
    severity: text("severity").notNull().default("warning"),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_system_alerts_type").on(table.type),
    index("idx_system_alerts_severity").on(table.severity),
    index("idx_system_alerts_resolved").on(table.resolvedAt),
    index("idx_system_alerts_created").on(table.createdAt),
  ],
);

export type SystemAlert = typeof systemAlerts.$inferSelect;
export type InsertSystemAlert = typeof systemAlerts.$inferInsert;

// ============================================================
// HOMEPAGE LEAD CAPTURE SCHEMA
// ============================================================

export const homepageLeads = pgTable(
  "homepage_leads",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    tradeType: text("trade_type").notNull(),
    projectDescription: text("project_description"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_homepage_leads_email").on(table.email),
    index("idx_homepage_leads_created").on(table.createdAt),
  ],
);

export type HomepageLead = typeof homepageLeads.$inferSelect;
export type InsertHomepageLead = typeof homepageLeads.$inferInsert;

// ============================================================
// JOB RUNS SCHEMA — cron job execution history
// ============================================================

export const jobRuns = pgTable(
  "job_runs",
  {
    id: serial("id").primaryKey(),
    jobName: text("job_name").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    status: text("status").notNull().default("running"),
    itemsProcessed: integer("items_processed").default(0),
    successCount: integer("success_count").default(0),
    failureCount: integer("failure_count").default(0),
    errorSummary: text("error_summary"),
  },
  (table) => [
    index("idx_job_runs_job_name").on(table.jobName),
    index("idx_job_runs_started_at").on(table.startedAt),
    index("idx_job_runs_status").on(table.status),
    uniqueIndex("idx_job_runs_running_unique")
      .on(table.jobName)
      .where(sql`status = 'running'`),
  ],
);

export type JobRun = typeof jobRuns.$inferSelect;
export type InsertJobRun = typeof jobRuns.$inferInsert;

// ============================================================
// VERIFICATION CODES SCHEMA — OTP email verification
// ============================================================

export const verificationCodes = pgTable(
  "verification_codes",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    used: boolean("used").default(false),
    attempts: integer("attempts").default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_verification_codes_email").on(table.email),
    index("idx_verification_codes_expires").on(table.expiresAt),
  ],
);

export type VerificationCode = typeof verificationCodes.$inferSelect;
export type InsertVerificationCode = typeof verificationCodes.$inferInsert;

// ============================================================
// ERROR LOGS SCHEMA — production error tracking
// ============================================================

export const errorLogs = pgTable(
  "error_logs",
  {
    id: serial("id").primaryKey(),
    level: text("level").notNull().default("error"),
    message: text("message").notNull(),
    stack: text("stack"),
    path: text("path"),
    method: text("method"),
    statusCode: integer("status_code"),
    userId: text("user_id"),
    meta: text("meta"),
    fingerprint: text("fingerprint"),
    count: integer("count").default(1),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    resolved: boolean("resolved").default(false),
  },
  (table) => [
    index("idx_error_logs_fingerprint").on(table.fingerprint),
    index("idx_error_logs_last_seen").on(table.lastSeenAt),
    index("idx_error_logs_resolved").on(table.resolved),
  ],
);

export type ErrorLog = typeof errorLogs.$inferSelect;
export type InsertErrorLog = typeof errorLogs.$inferInsert;

// ============================================================
// API KEYS SCHEMA — Public API access management
// ============================================================

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    partnerId: text("partner_id"),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique("api_keys_key_hash_key"),
    keyPrefix: text("key_prefix").notNull(),
    scopes: text("scopes").notNull().default("estimates:read"),
    rateLimit: integer("rate_limit").notNull().default(100),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
    requestCount: bigint("request_count", { mode: "number" }).default(0),
    expiresAt: bigint("expires_at", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_api_keys_user").on(table.userId),
    index("idx_api_keys_hash").on(table.keyHash),
    index("idx_api_keys_prefix").on(table.keyPrefix),
    index("idx_api_keys_partner").on(table.partnerId),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

// ============================================================
// API IDEMPOTENCY KEYS — replay-cache for unattended partner
// retries against /api/estimates/send. Scoped per API key so two
// partners can independently pick the same UUID without colliding.
// `requestHash` is a sha256 of the canonicalized request body so
// we can detect a key being reused with a different payload (and
// reject it with 422 instead of silently returning a stale reply).
// `responseStatus` + `responseBody` cache the original successful
// reply we'll replay on retries within `expiresAt`.
// `status` distinguishes an in-flight claim ("pending") from a
// final cached reply ("completed"); a pending row that's older
// than its expiry is treated as stale and overwritten.
// ============================================================

export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    id: serial("id").primaryKey(),
    apiKeyId: text("api_key_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("pending"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    estimateId: text("estimate_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("api_idempotency_keys_api_key_id_key_uq").on(
      table.apiKeyId,
      table.idempotencyKey,
    ),
    index("idx_api_idempotency_keys_expires_at").on(table.expiresAt),
  ],
);

export type ApiIdempotencyKey = typeof apiIdempotencyKeys.$inferSelect;
export type InsertApiIdempotencyKey = typeof apiIdempotencyKeys.$inferInsert;

// ============================================================
// AUDIT LOGS SCHEMA — Security audit trail
// ============================================================

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    action: text("action").notNull(),
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
    resource: text("resource").notNull(),
    resourceId: text("resource_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    method: text("method"),
    path: text("path"),
    statusCode: integer("status_code"),
    details: text("details"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_audit_logs_user").on(table.userId),
    index("idx_audit_logs_action").on(table.action),
    index("idx_audit_logs_resource").on(table.resource),
    index("idx_audit_logs_api_key").on(table.apiKeyId),
    index("idx_audit_logs_created").on(table.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ============================================================
// WATCHTOWER THRESHOLD AUDIT — immutable record of every POST
// (set) and DELETE (reset) against a threshold endpoint.
// Columns are intentionally denormalised: old/new values are
// stored as serialised JSON so the schema doesn't need to know
// about each subsystem's shape.

export const watchtowerThresholdAudit = pgTable(
  "watchtower_threshold_audit",
  {
    id: serial("id").primaryKey(),
    subsystem: text("subsystem").notNull(),
    action: text("action").notNull(),
    endpoint: text("endpoint").notNull(),
    changedBy: text("changed_by"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_wt_audit_subsystem").on(table.subsystem),
    index("idx_wt_audit_created").on(table.createdAt),
  ],
);

export type WatchtowerThresholdAuditEntry = typeof watchtowerThresholdAudit.$inferSelect;

// ============================================================
// SDK ALLOWED ORIGINS — DB-backed partner allowlist for the
// public integrate.js SDK. Read by server/lib/cors.ts (with a
// short TTL cache) and managed by admins via /api/admin/sdk-allowlist.
// `SDK_ALLOWED_ORIGINS` env stays as a fallback bootstrap source.
// `kind` is "exact" for full origins like "https://partner.example.com"
// and "wildcard" for "*.partner.com" entries.
// Soft-revoke: an origin with `revokedAt != null` is filtered out.
// ============================================================

export const sdkAllowedOrigins = pgTable(
  "sdk_allowed_origins",
  {
    id: serial("id").primaryKey(),
    origin: text("origin").notNull(),
    kind: text("kind").notNull(),
    partnerId: text("partner_id"),
    note: text("note"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    createdBy: text("created_by"),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    index("idx_sdk_allowed_origins_origin").on(table.origin),
    index("idx_sdk_allowed_origins_revoked").on(table.revokedAt),
    index("idx_sdk_allowed_origins_partner").on(table.partnerId),
  ],
);

export type SdkAllowedOrigin = typeof sdkAllowedOrigins.$inferSelect;
export type InsertSdkAllowedOrigin = typeof sdkAllowedOrigins.$inferInsert;

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    token: text("token").notNull(),
    platform: text("platform").notNull(),
    prefEstimateReady: boolean("pref_estimate_ready").default(true),
    prefTrialExpiring: boolean("pref_trial_expiring").default(true),
    prefFailedPayment: boolean("pref_failed_payment").default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_push_tokens_user").on(table.userId),
    uniqueIndex("idx_push_tokens_token").on(table.token),
  ],
);

export type PushToken = typeof pushTokens.$inferSelect;
export type InsertPushToken = typeof pushTokens.$inferInsert;

// ============================================================
// REVIEWS SCHEMA
// ============================================================

export const reviews = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    userName: text("user_name"),
    userTrade: text("user_trade"),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    approved: boolean("approved").default(false),
    hidden: boolean("hidden").default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_reviews_user").on(table.userId),
    index("idx_reviews_approved").on(table.approved),
    index("idx_reviews_created").on(table.createdAt),
    uniqueIndex("idx_reviews_user_unique").on(table.userId),
  ],
);

export type Review = typeof reviews.$inferSelect;
export type InsertReview = typeof reviews.$inferInsert;

// ============================================================
// SALES PIPELINE SCHEMA
// ============================================================

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    position: integer("position").notNull().default(0),
    isDefault: boolean("is_default").default(false),
    isWon: boolean("is_won").default(false),
    isLost: boolean("is_lost").default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_pipeline_stages_user").on(table.userId)],
);

export type PipelineStage = typeof pipelineStages.$inferSelect;

export const pipelineDeals = pgTable(
  "pipeline_deals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    stageId: integer("stage_id")
      .notNull()
      .references(() => pipelineStages.id),
    title: text("title").notNull(),
    value: real("value").default(0),
    clientName: text("client_name"),
    clientEmail: text("client_email"),
    clientPhone: text("client_phone"),
    description: text("description"),
    projectAddress: text("project_address"),
    projectType: text("project_type"),
    priority: text("priority").default("medium"),
    nextAction: text("next_action"),
    expectedStartDate: bigint("expected_start_date", { mode: "number" }),
    followUpDate: bigint("follow_up_date", { mode: "number" }),
    estimateId: text("estimate_id"),
    leadId: text("lead_id"),
    probability: integer("probability").default(50),
    expectedCloseDate: bigint("expected_close_date", { mode: "number" }),
    wonAt: bigint("won_at", { mode: "number" }),
    lostAt: bigint("lost_at", { mode: "number" }),
    lostReason: text("lost_reason"),
    position: integer("position").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_pipeline_deals_user").on(table.userId),
    index("idx_pipeline_deals_stage").on(table.stageId),
    index("idx_pipeline_deals_created").on(table.createdAt),
    index("idx_pipeline_deals_followup").on(table.followUpDate),
    uniqueIndex("idx_pipeline_deals_user_lead_uq")
      .on(table.userId, table.leadId)
      .where(sql`lead_id IS NOT NULL`),
    uniqueIndex("idx_pipeline_deals_user_estimate_uq")
      .on(table.userId, table.estimateId)
      .where(sql`estimate_id IS NOT NULL`),
  ],
);

export type PipelineDeal = typeof pipelineDeals.$inferSelect;

export const pipelineActivities = pgTable(
  "pipeline_activities",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    dealId: text("deal_id")
      .notNull()
      .references(() => pipelineDeals.id),
    type: text("type").notNull(),
    description: text("description").notNull(),
    metadata: text("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_pipeline_activities_deal").on(table.dealId),
    index("idx_pipeline_activities_created").on(table.createdAt),
  ],
);

export type PipelineActivity = typeof pipelineActivities.$inferSelect;

export const pipelineDealAttachments = pgTable(
  "pipeline_deal_attachments",
  {
    id: text("id").primaryKey(),
    dealId: text("deal_id")
      .notNull()
      .references(() => pipelineDeals.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    fileUrl: text("file_url").notNull(),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(),
    sizeBytes: integer("size_bytes").default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_pipeline_attachments_deal").on(table.dealId),
    index("idx_pipeline_attachments_user").on(table.userId),
  ],
);

export type PipelineDealAttachment =
  typeof pipelineDealAttachments.$inferSelect;

// ============================================================
// AUTOMATION ENGINE SCHEMA
// ============================================================

export const automationRules = pgTable(
  "automation_rules",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
    trigger: text("trigger").notNull(),
    conditions: text("conditions"),
    action: text("action").notNull(),
    actionConfig: text("action_config").notNull(),
    enabled: boolean("enabled").default(true),
    isSystem: boolean("is_system").default(false),
    cooldownMs: bigint("cooldown_ms", { mode: "number" }).default(86400000),
    runCount: integer("run_count").default(0),
    lastRunAt: bigint("last_run_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_automation_rules_user").on(table.userId),
    index("idx_automation_rules_trigger").on(table.trigger),
  ],
);

export type AutomationRule = typeof automationRules.$inferSelect;

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: serial("id").primaryKey(),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => automationRules.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    triggerEvent: text("trigger_event").notNull(),
    triggerData: text("trigger_data"),
    actionResult: text("action_result"),
    status: text("status").notNull().default("success"),
    error: text("error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_automation_runs_rule").on(table.ruleId),
    index("idx_automation_runs_user").on(table.userId),
    index("idx_automation_runs_created").on(table.createdAt),
  ],
);

// ============================================================
// WEBHOOKS — Outbound webhook subscriptions for partner integrations.
// Each row is a single endpoint a user has registered. The `secret` is
// the raw HMAC-SHA256 signing key used to sign delivery payloads via the
// `X-ProBid-Signature` header. `events` is a CSV list of event names like
// "estimate.created,estimate.updated". Soft-revoke via `revokedAt`.
// `lastStatus` / `lastError` are last-attempt diagnostics surfaced in the
// Developer Portal so partners can see at a glance whether their endpoint
// is healthy without paging through the deliveries log.
// ============================================================

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: text("events").notNull().default("estimate.created"),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    lastStatus: text("last_status"),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    lastDeliveredAt: bigint("last_delivered_at", { mode: "number" }),
    failureCount: integer("failure_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_webhooks_user").on(table.userId),
    index("idx_webhooks_enabled").on(table.enabled),
  ],
);

export type Webhook = typeof webhooks.$inferSelect;
export type InsertWebhook = typeof webhooks.$inferInsert;

// ============================================================
// WEBHOOK DELIVERIES — Per-attempt log + retry queue.
// One row per (webhook, event) attempt; rows that have failed and are
// still inside the retry budget have `status='pending'` with a future
// `nextAttemptAt`. The scheduler picks them up with exponential backoff.
// `payload` is stored as JSON text so we can replay the exact bytes that
// will be (re)signed and POSTed; the signature is recomputed each attempt
// so secret rotations on the parent webhook take effect on the next retry.
// ============================================================

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    event: text("event").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    error: text("error"),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }),
    lastAttemptAt: bigint("last_attempt_at", { mode: "number" }),
    deliveredAt: bigint("delivered_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_webhook_deliveries_webhook").on(table.webhookId),
    index("idx_webhook_deliveries_user").on(table.userId),
    index("idx_webhook_deliveries_status").on(table.status),
    index("idx_webhook_deliveries_next").on(table.nextAttemptAt),
    index("idx_webhook_deliveries_created").on(table.createdAt),
  ],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type InsertWebhookDelivery = typeof webhookDeliveries.$inferInsert;

// ============================================================
// PARTNERS SCHEMA — Per-partner identity for the Partner Portal
// ============================================================

export const partners = pgTable(
  "partners",
  {
    id: text("id").primaryKey(),
    companyName: text("company_name").notNull(),
    primaryUserId: text("primary_user_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("active"),
    rateLimitOverride: integer("rate_limit_override"),
    notes: text("notes"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    createdBy: text("created_by"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_partners_user").on(table.primaryUserId),
    index("idx_partners_status").on(table.status),
  ],
);

export type Partner = typeof partners.$inferSelect;
export type InsertPartner = typeof partners.$inferInsert;

// ============================================================
// MRR SNAPSHOTS — Daily revenue snapshots for investor metrics
// ============================================================

export const mrrSnapshots = pgTable(
  "mrr_snapshots",
  {
    id: serial("id").primaryKey(),
    dayKey: text("day_key").notNull(),
    mrr: integer("mrr").notNull(),
    arr: integer("arr").notNull(),
    payingCustomers: integer("paying_customers").notNull(),
    proMonthly: integer("pro_monthly").notNull().default(0),
    proAnnual: integer("pro_annual").notNull().default(0),
    bizMonthly: integer("biz_monthly").notNull().default(0),
    bizAnnual: integer("biz_annual").notNull().default(0),
    canceledLast30: integer("canceled_last_30").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_mrr_snapshots_day").on(table.dayKey),
    index("idx_mrr_snapshots_created").on(table.createdAt),
  ],
);

export type MrrSnapshot = typeof mrrSnapshots.$inferSelect;
export type InsertMrrSnapshot = typeof mrrSnapshots.$inferInsert;

// ============================================================
// GUARANTEE CLAIMS SCHEMA — Win-Jobs, Speed, 30-Day Money-Back
// ============================================================

export const guaranteeClaims = pgTable(
  "guarantee_claims",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    guaranteeType: text("guarantee_type").notNull(),
    status: text("status").notNull().default("pending"),
    eligibilityVerdict: text("eligibility_verdict").notNull().default("pending"),
    eligibilityReasons: text("eligibility_reasons"),
    resolution: text("resolution"),
    stripeRefundId: text("stripe_refund_id"),
    accountCreditCents: integer("account_credit_cents").default(0),
    adminOverrideBy: text("admin_override_by"),
    adminOverrideNote: text("admin_override_note"),
    adminOverrideAt: bigint("admin_override_at", { mode: "number" }),
    suspiciousFlags: text("suspicious_flags"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_guarantee_claims_user").on(table.userId),
    index("idx_guarantee_claims_type").on(table.guaranteeType),
    index("idx_guarantee_claims_status").on(table.status),
    index("idx_guarantee_claims_requested").on(table.requestedAt),
    unique("uq_guarantee_claims_user_type").on(table.userId, table.guaranteeType),
  ],
);

export type GuaranteeClaim = typeof guaranteeClaims.$inferSelect;
export type InsertGuaranteeClaim = typeof guaranteeClaims.$inferInsert;

// ============================================================
// A/B EXPERIMENT ASSIGNMENTS — Pricing page guarantee stack test
// ============================================================

export const abExperimentAssignments = pgTable(
  "ab_experiment_assignments",
  {
    id: serial("id").primaryKey(),
    experimentKey: text("experiment_key").notNull(),
    visitorId: text("visitor_id").notNull(),
    variant: text("variant").notNull(),
    userId: text("user_id"),
    converted: boolean("converted").default(false),
    paidConverted: boolean("paid_converted").default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_ab_assignments_experiment").on(table.experimentKey),
    index("idx_ab_assignments_visitor").on(table.visitorId),
    unique("uq_ab_assignments_visitor_exp").on(table.visitorId, table.experimentKey),
  ],
);

export type AbExperimentAssignment = typeof abExperimentAssignments.$inferSelect;
export type InsertAbExperimentAssignment = typeof abExperimentAssignments.$inferInsert;

// ============================================================
// GUARANTEE CLAIM EVENTS — Immutable audit log (append-only)
// ============================================================

export const guaranteeClaimEvents = pgTable(
  "guarantee_claim_events",
  {
    id: serial("id").primaryKey(),
    claimId: text("claim_id").notNull(),
    userId: text("user_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actor: text("actor").notNull(),
    note: text("note"),
    metadata: text("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_guarantee_claim_events_claim").on(table.claimId),
    index("idx_guarantee_claim_events_created").on(table.createdAt),
  ],
);

export type GuaranteeClaimEvent = typeof guaranteeClaimEvents.$inferSelect;

// ============================================================
// PARTNER USAGE — Per-partner / per-key / per-day usage rollup
// ============================================================

export const partnerUsage = pgTable(
  "partner_usage",
  {
    id: serial("id").primaryKey(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id),
    apiKeyId: text("api_key_id"),
    dayKey: text("day_key").notNull(),
    estimatesSdk: integer("estimates_sdk").notNull().default(0),
    estimatesApi: integer("estimates_api").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    rateLimitHits: integer("rate_limit_hits").notNull().default(0),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_partner_usage_partner").on(table.partnerId),
    index("idx_partner_usage_day").on(table.dayKey),
    uniqueIndex("idx_partner_usage_partner_key_day").on(
      table.partnerId,
      table.apiKeyId,
      table.dayKey,
    ),
  ],
);
