-- Database Indexes for ProBid AI 2.0
-- Critical performance optimization: 10-100x speedup for common queries

-- AUTHENTICATION & USERS
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);

-- ESTIMATES (Core business logic)
CREATE INDEX IF NOT EXISTS idx_estimates_user_id ON estimates(user_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status_created ON estimates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimates_user_status ON estimates(user_id, status);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);

-- SALES PIPELINE (Kanban board)
CREATE INDEX IF NOT EXISTS idx_deals_user_id_stage ON deals(user_id, pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_deals_follow_up_date ON deals(follow_up_date);
CREATE INDEX IF NOT EXISTS idx_deals_estimate_id ON deals(estimate_id);

-- LEADS (Scraping & outreach)
CREATE INDEX IF NOT EXISTS idx_scraped_leads_user_stage ON scraped_leads(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_scraped_leads_score ON scraped_leads(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_scraped_leads_email_status ON scraped_leads(email, outreach_status);

-- NOTIFICATIONS & ACTIVITY
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities(deal_id);

-- SUBSCRIPTIONS & BILLING
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_stripe_events_event_id ON stripe_events(event_id);

-- AUTOMATIONS & JOBS
CREATE INDEX IF NOT EXISTS idx_automation_rules_user_active ON automation_rules(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status, updated_at);

-- AFFILIATE & REFERRALS
CREATE INDEX IF NOT EXISTS idx_referrals_affiliate_id ON referrals(affiliate_id);

-- TEMPLATES & SAVED ITEMS
CREATE INDEX IF NOT EXISTS idx_saved_line_items_user_id ON saved_line_items(user_id);

-- COMPOSITE INDEXES FOR COMMON QUERIES
CREATE INDEX IF NOT EXISTS idx_estimates_user_status_created ON estimates(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_stage_priority ON deals(pipeline_stage, priority);

-- ANALYZE TABLES FOR QUERY PLANNER
ANALYZE users;
ANALYZE estimates;
ANALYZE deals;
ANALYZE scraped_leads;
ANALYZE notifications;
ANALYZE subscriptions;
ANALYZE automation_rules;
ANALYZE referrals;
ANALYZE saved_line_items;
