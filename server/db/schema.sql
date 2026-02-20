-- Girandole Database Schema
-- The Agent Economy Platform

-- ============================================
-- AGENTS (Authentication & Identity)
-- ============================================

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Identity
  name VARCHAR(100) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  avatar_url TEXT,
  website_url TEXT,
  
  -- Authentication
  api_key_hash VARCHAR(64) NOT NULL UNIQUE,
  api_key_prefix VARCHAR(25) NOT NULL,
  wallet_address VARCHAR(42),
  
  -- Verification
  email VARCHAR(255),
  email_verified BOOLEAN DEFAULT FALSE,
  email_verification_token VARCHAR(64),
  email_verification_expires TIMESTAMP,
  verification_level VARCHAR(20) DEFAULT 'basic',
  
  -- Advertiser
  is_advertiser BOOLEAN DEFAULT FALSE,
  advertiser_balance DECIMAL(12,2) DEFAULT 0,
  advertiser_since TIMESTAMP,
  
  -- Trust & Reputation
  trust_score INTEGER DEFAULT 50,
  trust_score_updated_at TIMESTAMP,
  transaction_count INTEGER DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  
  -- Status
  status VARCHAR(20) DEFAULT 'active',
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_active_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_agents_api_key_hash ON agents(api_key_hash);
CREATE INDEX idx_agents_wallet ON agents(wallet_address);
CREATE INDEX idx_agents_slug ON agents(slug);
CREATE INDEX idx_agents_status ON agents(status);

-- API Key Events (Audit Log)
CREATE TABLE IF NOT EXISTS api_key_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_key_events_agent ON api_key_events(agent_id, created_at DESC);

-- ============================================
-- LISTINGS (Multi-type Directory)
-- ============================================

CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Core
  type VARCHAR(20) NOT NULL CHECK (type IN ('api', 'mcp', 'skill', 'agent', 'data', 'tool')),
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(150) NOT NULL UNIQUE,
  description TEXT,
  short_description VARCHAR(300),
  
  -- Categorization
  category VARCHAR(50),
  tags TEXT[] DEFAULT '{}',
  
  -- Owner
  owner_agent_id UUID REFERENCES agents(id),
  claimed BOOLEAN DEFAULT FALSE,
  claimed_at TIMESTAMP,
  
  -- Pricing
  pricing_model VARCHAR(30) DEFAULT 'free',
  price_amount DECIMAL(12,2),
  price_currency VARCHAR(10) DEFAULT 'USD',
  price_unit VARCHAR(50),
  
  -- Status
  status VARCHAR(20) DEFAULT 'pending',
  verified_at TIMESTAMP,
  last_check_at TIMESTAMP,
  check_count INTEGER DEFAULT 0,
  
  -- Metrics (computed)
  uptime_percent DECIMAL(5,2),
  avg_response_ms INTEGER,
  
  -- Trust Badges (computed)
  badges TEXT[] DEFAULT '{}',
  
  -- Ratings (computed from reviews)
  avg_rating DECIMAL(3,2),
  weighted_rating DECIMAL(3,2),
  review_count INTEGER DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_listings_type ON listings(type);
CREATE INDEX idx_listings_category ON listings(category);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_owner ON listings(owner_agent_id);
CREATE INDEX idx_listings_slug ON listings(slug);
CREATE INDEX idx_listings_tags ON listings USING GIN(tags);
CREATE INDEX idx_listings_badges ON listings USING GIN(badges);

-- Listing Metadata (type-specific fields)
CREATE TABLE IF NOT EXISTS listing_metadata (
  listing_id UUID PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  
  -- API-specific
  api_endpoint TEXT,
  api_method VARCHAR(10),
  api_auth_type VARCHAR(50),
  api_auth_header VARCHAR(100),
  api_docs_url TEXT,
  api_sample_request JSONB,
  api_sample_response JSONB,
  
  -- MCP-specific
  mcp_transport VARCHAR(20),
  mcp_capabilities TEXT[],
  mcp_install_command TEXT,
  mcp_repo_url TEXT,
  mcp_config_schema JSONB,
  
  -- Skill-specific
  skill_schema_url TEXT,
  skill_checksum VARCHAR(64),
  skill_version VARCHAR(20),
  skill_repo_url TEXT,
  skill_dependencies TEXT[],
  
  -- Agent-specific
  agent_agent_id UUID REFERENCES agents(id),
  agent_wallet_address VARCHAR(42),
  agent_capabilities TEXT[],
  agent_response_time VARCHAR(50),
  agent_availability TEXT,
  agent_languages TEXT[],
  
  -- Data-specific
  data_format VARCHAR(50),
  data_update_frequency VARCHAR(50),
  data_sample_url TEXT,
  data_size_estimate VARCHAR(50),
  data_license VARCHAR(100),
  
  -- Tool-specific
  tool_platforms TEXT[],
  tool_install_command TEXT,
  tool_version VARCHAR(20),
  tool_docs_url TEXT,
  tool_repo_url TEXT
);

-- Health Checks
CREATE TABLE IF NOT EXISTS health_checks (
  id BIGSERIAL PRIMARY KEY,
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  
  success BOOLEAN NOT NULL,
  response_ms INTEGER,
  status_code INTEGER,
  error_message TEXT,
  response_sample JSONB,
  
  checked_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_health_checks_listing ON health_checks(listing_id, checked_at DESC);

-- ============================================
-- REVIEWS (Trust-Weighted Ratings)
-- ============================================

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Relationships
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reviewer_agent_id UUID NOT NULL REFERENCES agents(id),
  
  -- Scores (1-5)
  overall_rating DECIMAL(2,1) NOT NULL CHECK (overall_rating >= 1 AND overall_rating <= 5),
  reliability_rating DECIMAL(2,1) CHECK (reliability_rating >= 1 AND reliability_rating <= 5),
  speed_rating DECIMAL(2,1) CHECK (speed_rating >= 1 AND speed_rating <= 5),
  accuracy_rating DECIMAL(2,1) CHECK (accuracy_rating >= 1 AND accuracy_rating <= 5),
  value_rating DECIMAL(2,1) CHECK (value_rating >= 1 AND value_rating <= 5),
  
  -- Content
  title VARCHAR(200),
  comment TEXT NOT NULL,
  usage_context TEXT,
  
  -- Weighting
  reviewer_trust_score INTEGER,
  weighted_rating DECIMAL(4,2),
  
  -- Moderation
  status VARCHAR(20) DEFAULT 'published',
  flag_count INTEGER DEFAULT 0,
  
  -- Helpfulness
  helpful_count INTEGER DEFAULT 0,
  unhelpful_count INTEGER DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(listing_id, reviewer_agent_id)
);

CREATE INDEX idx_reviews_listing ON reviews(listing_id, status);
CREATE INDEX idx_reviews_reviewer ON reviews(reviewer_agent_id);
CREATE INDEX idx_reviews_rating ON reviews(overall_rating);
CREATE INDEX idx_reviews_created ON reviews(created_at DESC);

-- Review Votes
CREATE TABLE IF NOT EXISTS review_votes (
  id SERIAL PRIMARY KEY,
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  voter_agent_id UUID REFERENCES agents(id),
  vote_type VARCHAR(10) CHECK (vote_type IN ('helpful', 'unhelpful')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(review_id, voter_agent_id)
);

-- Review Flags
CREATE TABLE IF NOT EXISTS review_flags (
  id SERIAL PRIMARY KEY,
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  flagger_agent_id UUID REFERENCES agents(id),
  reason VARCHAR(50),
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(review_id, flagger_agent_id)
);

-- ============================================
-- ADVERTISING
-- ============================================

-- Ad Campaigns
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Owner
  advertiser_agent_id UUID NOT NULL REFERENCES agents(id),
  
  -- Campaign details
  name VARCHAR(200) NOT NULL,
  type VARCHAR(30) NOT NULL CHECK (type IN ('sponsored_search', 'featured_homepage', 'category_sponsor', 'promoted_badge')),
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended', 'rejected')),
  
  -- Targeting
  listing_id UUID REFERENCES listings(id),
  target_keywords TEXT[],
  target_categories TEXT[],
  target_listing_types TEXT[],
  
  -- Budget
  daily_budget DECIMAL(10,2),
  total_budget DECIMAL(10,2),
  spent_total DECIMAL(10,2) DEFAULT 0,
  spent_today DECIMAL(10,2) DEFAULT 0,
  
  -- Bidding (for CPC)
  max_cpc DECIMAL(6,2),
  
  -- For fixed-price placements
  fixed_price DECIMAL(10,2),
  billing_period VARCHAR(20),
  
  -- Schedule
  start_date DATE,
  end_date DATE,
  
  -- Creative
  headline VARCHAR(100),
  description VARCHAR(250),
  display_url VARCHAR(100),
  destination_url TEXT,
  
  -- Performance (cached)
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  ctr DECIMAL(5,4) DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_campaigns_advertiser ON ad_campaigns(advertiser_agent_id, status);
CREATE INDEX idx_campaigns_status ON ad_campaigns(status, type);
CREATE INDEX idx_campaigns_listing ON ad_campaigns(listing_id);

-- Ad Impressions
CREATE TABLE IF NOT EXISTS ad_impressions (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  
  placement VARCHAR(50),
  search_query TEXT,
  page_url TEXT,
  position INTEGER,
  
  viewer_agent_id UUID REFERENCES agents(id),
  viewer_ip_hash VARCHAR(64),
  
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_impressions_campaign ON ad_impressions(campaign_id, timestamp DESC);
CREATE INDEX idx_impressions_time ON ad_impressions(timestamp DESC);

-- Ad Clicks
CREATE TABLE IF NOT EXISTS ad_clicks (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  impression_id BIGINT REFERENCES ad_impressions(id),
  
  click_cost DECIMAL(6,2),
  
  clicker_agent_id UUID REFERENCES agents(id),
  clicker_ip_hash VARCHAR(64),
  
  is_valid BOOLEAN DEFAULT TRUE,
  fraud_reason TEXT,
  
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_clicks_campaign ON ad_clicks(campaign_id, timestamp DESC);
CREATE INDEX idx_clicks_time ON ad_clicks(timestamp DESC);

-- Ad Billing
CREATE TABLE IF NOT EXISTS ad_billing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_agent_id UUID REFERENCES agents(id),
  
  type VARCHAR(20) CHECK (type IN ('deposit', 'charge', 'refund')),
  amount DECIMAL(10,2) NOT NULL,
  description TEXT,
  
  campaign_id UUID REFERENCES ad_campaigns(id),
  
  payment_method VARCHAR(50),
  payment_reference TEXT,
  stripe_payment_id TEXT,
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_billing_agent ON ad_billing(advertiser_agent_id, created_at DESC);

-- ============================================
-- UTILITY TABLES
-- ============================================

-- Listing Interactions (for review eligibility)
CREATE TABLE IF NOT EXISTS listing_interactions (
  id BIGSERIAL PRIMARY KEY,
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id),
  interaction_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_interactions_listing ON listing_interactions(listing_id, agent_id);

-- Used Nonces (for wallet signature replay protection)
CREATE TABLE IF NOT EXISTS used_nonces (
  id SERIAL PRIMARY KEY,
  agent_id UUID REFERENCES agents(id),
  nonce BIGINT NOT NULL,
  used_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(agent_id, nonce)
);

-- ============================================
-- INITIAL DATA
-- ============================================

-- Categories
-- (These are soft-coded, stored in listings.category)
-- commerce, data, communication, utilities, ai, finance, media, developer

-- Listing types are enforced by CHECK constraint:
-- api, mcp, skill, agent, data, tool
