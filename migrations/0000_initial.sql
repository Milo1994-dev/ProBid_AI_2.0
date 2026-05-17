CREATE TABLE "ad_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"budget" real DEFAULT 0,
	"spend" real DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"impressions" integer DEFAULT 0,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_clicks" (
	"id" serial PRIMARY KEY NOT NULL,
	"affiliate_code" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"affiliate_user_id" text NOT NULL,
	"referred_user_id" text NOT NULL,
	"stripe_invoice_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd',
	"status" text DEFAULT 'pending',
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aggregate_benchmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"benchmark_type" text NOT NULL,
	"trade" text,
	"region" text,
	"sample_size" integer NOT NULL,
	"p25" real,
	"p50" real,
	"p75" real,
	"p90" real,
	"mean" real,
	"metadata" text,
	"calculated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics" (
	"id" serial PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"user_id" text,
	"data" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text DEFAULT 'estimates:read' NOT NULL,
	"rate_limit" integer DEFAULT 100 NOT NULL,
	"last_used_at" bigint,
	"request_count" bigint DEFAULT 0,
	"expires_at" bigint,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"user_id" text,
	"api_key_id" text,
	"resource" text NOT NULL,
	"resource_id" text,
	"ip_address" text,
	"user_agent" text,
	"method" text,
	"path" text,
	"status_code" integer,
	"details" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger" text NOT NULL,
	"conditions" text,
	"action" text NOT NULL,
	"action_config" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"is_system" boolean DEFAULT false,
	"cooldown_ms" bigint DEFAULT 86400000,
	"run_count" integer DEFAULT 0,
	"last_run_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"trigger_event" text NOT NULL,
	"trigger_data" text,
	"action_result" text,
	"status" text DEFAULT 'success' NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dunning_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"amount_due_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd',
	"first_failed_at" bigint NOT NULL,
	"immediate_email_sent_at" bigint,
	"day3_email_sent_at" bigint,
	"day7_email_sent_at" bigint,
	"resolved_at" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "uq_dunning_events_invoice" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "email_drip_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"user_id" text,
	"template_key" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"sent_at" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "uq_email_drip_queue_email_template" UNIQUE("email","template_key")
);
--> statement-breakpoint
CREATE TABLE "error_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" text DEFAULT 'error' NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"path" text,
	"method" text,
	"status_code" integer,
	"user_id" text,
	"meta" text,
	"fingerprint" text,
	"count" integer DEFAULT 1,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"resolved" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "estimate_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"estimate_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" real NOT NULL,
	"unit_cost" real NOT NULL,
	"uom" text,
	"cost_type" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"job_type" text NOT NULL,
	"market" text NOT NULL,
	"details" text,
	"client_name" text,
	"client_email" text,
	"client_phone" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_type" text NOT NULL,
	"market" text NOT NULL,
	"details" text,
	"estimate_text" text NOT NULL,
	"name" text,
	"source" text,
	"client_name" text,
	"client_email" text,
	"client_phone" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "homepage_leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"trade_type" text NOT NULL,
	"project_description" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"status" text DEFAULT 'running' NOT NULL,
	"items_processed" integer DEFAULT 0,
	"success_count" integer DEFAULT 0,
	"failure_count" integer DEFAULT 0,
	"error_summary" text
);
--> statement-breakpoint
CREATE TABLE "launch_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"done" boolean DEFAULT false,
	"category" text,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lead_email_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"template_id" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"sent_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_outreach_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_outreach_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"template_id" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"sent_at" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"open_token" text,
	"click_token" text,
	"unsubscribe_token" text,
	"created_at" text NOT NULL,
	CONSTRAINT "lead_outreach_queue_open_token_key" UNIQUE("open_token"),
	CONSTRAINT "lead_outreach_queue_click_token_key" UNIQUE("click_token"),
	CONSTRAINT "lead_outreach_queue_unsubscribe_token_key" UNIQUE("unsubscribe_token")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"notes" text,
	"status" text DEFAULT 'new',
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"metadata" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_deal_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"user_id" text NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"file_type" text NOT NULL,
	"size_bytes" integer DEFAULT 0,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_deals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"stage_id" integer NOT NULL,
	"title" text NOT NULL,
	"value" real DEFAULT 0,
	"client_name" text,
	"client_email" text,
	"client_phone" text,
	"description" text,
	"project_address" text,
	"project_type" text,
	"priority" text DEFAULT 'medium',
	"next_action" text,
	"expected_start_date" bigint,
	"follow_up_date" bigint,
	"estimate_id" text,
	"lead_id" text,
	"probability" integer DEFAULT 50,
	"expected_close_date" bigint,
	"won_at" bigint,
	"lost_at" bigint,
	"lost_reason" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false,
	"is_won" boolean DEFAULT false,
	"is_lost" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procore_budget_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"cost_code" text NOT NULL,
	"cost_code_description" text,
	"budgeted_amount_usd" real,
	"actual_amount_usd" real,
	"variance" real,
	"raw_data" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procore_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"procore_company_id" text NOT NULL,
	"company_name" text,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expires_at" bigint NOT NULL,
	"scopes" text,
	"status" text DEFAULT 'active',
	"last_sync_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "procore_connections_user_company" UNIQUE("user_id","procore_company_id")
);
--> statement-breakpoint
CREATE TABLE "procore_estimate_pushes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"estimate_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"procore_project_id" text NOT NULL,
	"procore_company_id" text NOT NULL,
	"project_name" text,
	"status" text DEFAULT 'pushed',
	"budget_items_pushed" integer DEFAULT 0,
	"pdf_uploaded" integer DEFAULT 0,
	"procore_project_url" text,
	"error_message" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "procore_pushes_unique" UNIQUE("estimate_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "procore_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text,
	"metric_type" text NOT NULL,
	"value" real NOT NULL,
	"sample_size" integer,
	"percentile" text,
	"period_start" text,
	"period_end" text,
	"metadata" text,
	"calculated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procore_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"procore_project_id" text NOT NULL,
	"name" text NOT NULL,
	"project_number" text,
	"trade" text,
	"region" text,
	"address" text,
	"city" text,
	"state" text,
	"zip_code" text,
	"project_value_usd" real,
	"status" text,
	"start_date" text,
	"completion_date" text,
	"close_date" text,
	"original_estimate_usd" real,
	"actual_cost_usd" real,
	"change_order_count" integer DEFAULT 0,
	"change_order_value_usd" real DEFAULT 0,
	"is_closed" integer DEFAULT 0,
	"raw_data" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "procore_projects_unique" UNIQUE("connection_id","procore_project_id")
);
--> statement-breakpoint
CREATE TABLE "proof_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"asset_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"file_path" text,
	"file_url" text,
	"content" text,
	"is_public" integer DEFAULT 0,
	"approved_at" bigint,
	"approved_by" text,
	"expires_at" bigint,
	"metadata" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"stripe_payment_intent_id" text,
	"amount_cents" integer NOT NULL,
	"credits_remaining" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"pref_estimate_ready" boolean DEFAULT true,
	"pref_trial_expiring" boolean DEFAULT true,
	"pref_failed_payment" boolean DEFAULT true,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"referral_code" text,
	"converted_to_user" boolean DEFAULT false,
	"created_at" text NOT NULL,
	CONSTRAINT "referral_leads_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_user_id" text NOT NULL,
	"referred_user_id" text NOT NULL,
	"status" text DEFAULT 'signed_up',
	"created_at" text NOT NULL,
	CONSTRAINT "referrals_unique" UNIQUE("referrer_user_id","referred_user_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text,
	"user_trade" text,
	"rating" integer NOT NULL,
	"comment" text,
	"approved" boolean DEFAULT false,
	"hidden" boolean DEFAULT false,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" real NOT NULL,
	"unit_cost" real NOT NULL,
	"uom" text,
	"cost_type" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraped_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"business_type" text,
	"location" text,
	"website" text,
	"source" text DEFAULT 'google_places',
	"stage" text DEFAULT 'new',
	"score" integer DEFAULT 0,
	"do_not_contact" boolean DEFAULT false,
	"unsubscribe_token" text,
	"opened_at" bigint,
	"clicked_at" bigint,
	"replied_at" bigint,
	"converted_at" bigint,
	"sms_sent_at" bigint,
	"contact_method_priority" text,
	"lead_status" text DEFAULT 'fully_contactable',
	"website_outreach_at" bigint,
	"last_outreach_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "scraped_leads_unsubscribe_token_key" UNIQUE("unsubscribe_token")
);
--> statement-breakpoint
CREATE TABLE "sdk_allowed_origins" (
	"id" serial PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"created_at" bigint NOT NULL,
	"created_by" text,
	"revoked_at" bigint,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "seo_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "seo_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "shadow_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"probid_estimate_low" real,
	"probid_estimate_base" real,
	"probid_estimate_high" real,
	"estimate_details" text,
	"generated_at" bigint NOT NULL,
	"model_version" text,
	"input_hash" text
);
--> statement-breakpoint
CREATE TABLE "stripe_customers" (
	"user_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"price_id" text,
	"current_period_end" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"email" text NOT NULL,
	"invite_code" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "team_invites_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text,
	"joined_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"user_id" text NOT NULL,
	"day_key" text NOT NULL,
	"estimates_count" integer NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "usage_pkey" UNIQUE("user_id","day_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"created_at" bigint NOT NULL,
	"affiliate_code" text,
	"referred_by_code" text,
	"referred_by_user_id" text,
	"commission_rate" real DEFAULT 0.2,
	"has_seen_onboarding" boolean DEFAULT false,
	"password_hash" text,
	"role" text DEFAULT 'user',
	"referral_bonus_estimates" integer DEFAULT 0,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_affiliate_code_unique" UNIQUE("affiliate_code")
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used" boolean DEFAULT false,
	"attempts" integer DEFAULT 0,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_templates" ADD CONSTRAINT "estimate_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_email_audit_log" ADD CONSTRAINT "lead_email_audit_log_lead_id_scraped_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."scraped_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_outreach_queue" ADD CONSTRAINT "lead_outreach_queue_lead_id_scraped_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."scraped_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_activities" ADD CONSTRAINT "pipeline_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_activities" ADD CONSTRAINT "pipeline_activities_deal_id_pipeline_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."pipeline_deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_deal_attachments" ADD CONSTRAINT "pipeline_deal_attachments_deal_id_pipeline_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."pipeline_deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_deal_attachments" ADD CONSTRAINT "pipeline_deal_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_deals" ADD CONSTRAINT "pipeline_deals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_deals" ADD CONSTRAINT "pipeline_deals_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_budget_items" ADD CONSTRAINT "procore_budget_items_project_id_procore_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."procore_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_connections" ADD CONSTRAINT "procore_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_estimate_pushes" ADD CONSTRAINT "procore_estimate_pushes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_estimate_pushes" ADD CONSTRAINT "procore_estimate_pushes_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_estimate_pushes" ADD CONSTRAINT "procore_estimate_pushes_connection_id_procore_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."procore_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_metrics" ADD CONSTRAINT "procore_metrics_connection_id_procore_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."procore_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_metrics" ADD CONSTRAINT "procore_metrics_project_id_procore_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."procore_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procore_projects" ADD CONSTRAINT "procore_projects_connection_id_procore_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."procore_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_assets" ADD CONSTRAINT "proof_assets_connection_id_procore_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."procore_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_line_items" ADD CONSTRAINT "saved_line_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_estimates" ADD CONSTRAINT "shadow_estimates_project_id_procore_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."procore_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ad_campaigns_status" ON "ad_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ad_campaigns_platform" ON "ad_campaigns" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "idx_ad_campaigns_created" ON "ad_campaigns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_affiliate_clicks_code" ON "affiliate_clicks" USING btree ("affiliate_code");--> statement-breakpoint
CREATE INDEX "idx_affiliate_earnings_user" ON "affiliate_earnings" USING btree ("affiliate_user_id");--> statement-breakpoint
CREATE INDEX "idx_affiliate_earnings_status" ON "affiliate_earnings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_aggregate_benchmarks_type" ON "aggregate_benchmarks" USING btree ("benchmark_type");--> statement-breakpoint
CREATE INDEX "idx_aggregate_benchmarks_trade" ON "aggregate_benchmarks" USING btree ("trade");--> statement-breakpoint
CREATE INDEX "idx_analytics_event" ON "analytics" USING btree ("event");--> statement-breakpoint
CREATE INDEX "idx_analytics_created" ON "analytics" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_api_keys_user" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_prefix" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_user" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_api_key" ON "audit_logs" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_automation_rules_user" ON "automation_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_automation_rules_trigger" ON "automation_rules" USING btree ("trigger");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_rule" ON "automation_runs" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_user" ON "automation_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_created" ON "automation_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_user" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_dunning_events_user" ON "dunning_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_dunning_events_status" ON "dunning_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_dunning_events_first_failed" ON "dunning_events" USING btree ("first_failed_at");--> statement-breakpoint
CREATE INDEX "idx_email_drip_queue_status" ON "email_drip_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_email_drip_queue_scheduled" ON "email_drip_queue" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_email_drip_queue_email" ON "email_drip_queue" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_error_logs_fingerprint" ON "error_logs" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "idx_error_logs_last_seen" ON "error_logs" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_error_logs_resolved" ON "error_logs" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX "idx_estimate_line_items_estimate" ON "estimate_line_items" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "idx_estimate_templates_user" ON "estimate_templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_estimates_user" ON "estimates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_estimates_created" ON "estimates" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_homepage_leads_email" ON "homepage_leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_homepage_leads_created" ON "homepage_leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_job_runs_job_name" ON "job_runs" USING btree ("job_name");--> statement-breakpoint
CREATE INDEX "idx_job_runs_started_at" ON "job_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_job_runs_status" ON "job_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_job_runs_running_unique" ON "job_runs" USING btree ("job_name") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "idx_leal_lead" ON "lead_email_audit_log" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_leal_status" ON "lead_email_audit_log" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_leal_sent" ON "lead_email_audit_log" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "idx_loq_lead" ON "lead_outreach_queue" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_loq_status" ON "lead_outreach_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_loq_scheduled" ON "lead_outreach_queue" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_loq_open_token" ON "lead_outreach_queue" USING btree ("open_token");--> statement-breakpoint
CREATE INDEX "idx_loq_click_token" ON "lead_outreach_queue" USING btree ("click_token");--> statement-breakpoint
CREATE INDEX "idx_loq_unsub_token" ON "lead_outreach_queue" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX "idx_leads_user" ON "leads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_leads_status" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pipeline_activities_deal" ON "pipeline_activities" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_activities_created" ON "pipeline_activities" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_pipeline_attachments_deal" ON "pipeline_deal_attachments" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_attachments_user" ON "pipeline_deal_attachments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_deals_user" ON "pipeline_deals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_deals_stage" ON "pipeline_deals" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_deals_created" ON "pipeline_deals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_pipeline_deals_followup" ON "pipeline_deals" USING btree ("follow_up_date");--> statement-breakpoint
CREATE INDEX "idx_pipeline_stages_user" ON "pipeline_stages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_procore_budget_items_project" ON "procore_budget_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_procore_budget_items_cost_code" ON "procore_budget_items" USING btree ("cost_code");--> statement-breakpoint
CREATE INDEX "idx_procore_connections_user" ON "procore_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_procore_connections_company" ON "procore_connections" USING btree ("procore_company_id");--> statement-breakpoint
CREATE INDEX "idx_procore_pushes_user" ON "procore_estimate_pushes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_procore_pushes_estimate" ON "procore_estimate_pushes" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "idx_procore_pushes_connection" ON "procore_estimate_pushes" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_procore_metrics_connection" ON "procore_metrics" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_procore_metrics_project" ON "procore_metrics" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_procore_metrics_type" ON "procore_metrics" USING btree ("metric_type");--> statement-breakpoint
CREATE INDEX "idx_procore_projects_connection" ON "procore_projects" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_procore_projects_closed" ON "procore_projects" USING btree ("is_closed");--> statement-breakpoint
CREATE INDEX "idx_procore_projects_trade" ON "procore_projects" USING btree ("trade");--> statement-breakpoint
CREATE INDEX "idx_proof_assets_connection" ON "proof_assets" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_proof_assets_type" ON "proof_assets" USING btree ("asset_type");--> statement-breakpoint
CREATE INDEX "idx_proof_assets_public" ON "proof_assets" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "idx_purchases_user" ON "purchases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_purchases_type" ON "purchases" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_push_tokens_user" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_tokens_token" ON "push_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_referral_leads_email" ON "referral_leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_referral_leads_referral_code" ON "referral_leads" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "idx_referrals_referrer" ON "referrals" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "idx_referrals_referred" ON "referrals" USING btree ("referred_user_id");--> statement-breakpoint
CREATE INDEX "idx_reviews_user" ON "reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_reviews_approved" ON "reviews" USING btree ("approved");--> statement-breakpoint
CREATE INDEX "idx_reviews_created" ON "reviews" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reviews_user_unique" ON "reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_saved_line_items_user" ON "saved_line_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_email" ON "scraped_leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_phone" ON "scraped_leads" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_dnc" ON "scraped_leads" USING btree ("do_not_contact");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_unsubscribe" ON "scraped_leads" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_created" ON "scraped_leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_stage" ON "scraped_leads" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_score" ON "scraped_leads" USING btree ("score");--> statement-breakpoint
CREATE INDEX "idx_scraped_leads_lead_status" ON "scraped_leads" USING btree ("lead_status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sdk_allowed_origins_origin" ON "sdk_allowed_origins" USING btree ("origin");--> statement-breakpoint
CREATE INDEX "idx_sdk_allowed_origins_revoked" ON "sdk_allowed_origins" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "idx_seo_pages_slug" ON "seo_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_shadow_estimates_project" ON "shadow_estimates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_system_alerts_type" ON "system_alerts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_system_alerts_severity" ON "system_alerts" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_system_alerts_resolved" ON "system_alerts" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "idx_system_alerts_created" ON "system_alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_team_invites_team" ON "team_invites" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_team_invites_code" ON "team_invites" USING btree ("invite_code");--> statement-breakpoint
CREATE INDEX "idx_team_invites_email" ON "team_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_team_members_team" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_team_members_user" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_teams_owner" ON "teams" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_day" ON "usage" USING btree ("day_key");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_verification_codes_email" ON "verification_codes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_verification_codes_expires" ON "verification_codes" USING btree ("expires_at");