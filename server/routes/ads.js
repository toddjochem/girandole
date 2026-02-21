// Advertising Routes - Sponsored listings, campaigns, billing
import { Router } from 'express';
import { authenticateAgent, requireAdvertiser, requireVerification } from '../middleware/auth.js';
import { hashIP } from '../utils/keys.js';

const VALID_CAMPAIGN_TYPES = ['sponsored_search', 'featured_homepage', 'category_sponsor', 'promoted_badge'];

export default function adsRoutes(db) {
  const router = Router();

  // ==========================================
  // CAMPAIGN MANAGEMENT
  // ==========================================

  /**
   * GET /api/ads/campaigns
   * Get all campaigns for current advertiser
   */
  router.get('/campaigns', authenticateAgent(db), async (req, res) => {
    try {
      const { status } = req.query;
      
      let query = `
        SELECT c.*, l.name as listing_name, l.slug as listing_slug
        FROM ad_campaigns c
        LEFT JOIN listings l ON c.listing_id = l.id
        WHERE c.advertiser_agent_id = $1
      `;
      const params = [req.agent.id];
      
      if (status) {
        query += ' AND c.status = $2';
        params.push(status);
      }
      
      query += ' ORDER BY c.created_at DESC';
      
      const result = await db.query(query, params);
      res.json({ campaigns: result.rows });
      
    } catch (err) {
      console.error('Get campaigns error:', err);
      res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
  });

  /**
   * GET /api/ads/campaigns/:id
   * Get single campaign with stats
   */
  router.get('/campaigns/:id', authenticateAgent(db), async (req, res) => {
    try {
      const campaign = await db.query(`
        SELECT c.*, l.name as listing_name, l.slug as listing_slug
        FROM ad_campaigns c
        LEFT JOIN listings l ON c.listing_id = l.id
        WHERE c.id = $1 AND c.advertiser_agent_id = $2
      `, [req.params.id, req.agent.id]);
      
      if (!campaign.rows[0]) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      // Get stats
      const stats = await getCampaignStats(db, req.params.id, '7d');
      
      res.json({ campaign: campaign.rows[0], stats });
      
    } catch (err) {
      console.error('Get campaign error:', err);
      res.status(500).json({ error: 'Failed to fetch campaign' });
    }
  });

  /**
   * POST /api/ads/campaigns
   * Create a new campaign
   */
  router.post('/campaigns', authenticateAgent(db), requireAdvertiser, async (req, res) => {
    try {
      const {
        name,
        type,
        listing_id,
        target_keywords,
        target_categories,
        daily_budget,
        total_budget,
        max_cpc,
        headline,
        description,
        destination_url,
        start_date,
        end_date
      } = req.body;
      
      // Validate
      if (!name || name.length < 2) {
        return res.status(400).json({ error: 'Campaign name required' });
      }
      if (!type || !VALID_CAMPAIGN_TYPES.includes(type)) {
        return res.status(400).json({ error: 'Valid campaign type required', valid: VALID_CAMPAIGN_TYPES });
      }
      if (!listing_id) {
        return res.status(400).json({ error: 'listing_id required' });
      }
      
      // Verify listing ownership
      const listing = await db.query(
        'SELECT * FROM listings WHERE id = $1 AND owner_agent_id = $2',
        [listing_id, req.agent.id]
      );
      
      if (!listing.rows[0]) {
        return res.status(403).json({ error: 'You can only advertise your own listings' });
      }
      
      // Validate budget
      if (type === 'sponsored_search') {
        if (!total_budget || total_budget < 10) {
          return res.status(400).json({ error: 'Minimum budget is $10' });
        }
        if (!max_cpc || max_cpc < 0.05) {
          return res.status(400).json({ error: 'Minimum CPC is $0.05' });
        }
      }
      
      const result = await db.query(`
        INSERT INTO ad_campaigns (
          advertiser_agent_id, name, type, listing_id,
          target_keywords, target_categories,
          daily_budget, total_budget, max_cpc,
          headline, description, destination_url,
          start_date, end_date, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft')
        RETURNING *
      `, [
        req.agent.id, name, type, listing_id,
        target_keywords || [], target_categories || [],
        daily_budget, total_budget, max_cpc,
        headline, description, destination_url,
        start_date || null, end_date || null
      ]);
      
      res.status(201).json({ campaign: result.rows[0] });
      
    } catch (err) {
      console.error('Create campaign error:', err);
      res.status(500).json({ error: 'Failed to create campaign' });
    }
  });

  /**
   * PATCH /api/ads/campaigns/:id
   * Update a campaign
   */
  router.patch('/campaigns/:id', authenticateAgent(db), async (req, res) => {
    try {
      const existing = await db.query(
        'SELECT * FROM ad_campaigns WHERE id = $1 AND advertiser_agent_id = $2',
        [req.params.id, req.agent.id]
      );
      
      if (!existing.rows[0]) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      const {
        name, daily_budget, total_budget, max_cpc,
        target_keywords, target_categories,
        headline, description, destination_url,
        start_date, end_date
      } = req.body;
      
      const result = await db.query(`
        UPDATE ad_campaigns SET
          name = COALESCE($1, name),
          daily_budget = COALESCE($2, daily_budget),
          total_budget = COALESCE($3, total_budget),
          max_cpc = COALESCE($4, max_cpc),
          target_keywords = COALESCE($5, target_keywords),
          target_categories = COALESCE($6, target_categories),
          headline = COALESCE($7, headline),
          description = COALESCE($8, description),
          destination_url = COALESCE($9, destination_url),
          start_date = COALESCE($10, start_date),
          end_date = COALESCE($11, end_date),
          updated_at = NOW()
        WHERE id = $12
        RETURNING *
      `, [
        name, daily_budget, total_budget, max_cpc,
        target_keywords, target_categories,
        headline, description, destination_url,
        start_date, end_date, req.params.id
      ]);
      
      res.json({ campaign: result.rows[0] });
      
    } catch (err) {
      console.error('Update campaign error:', err);
      res.status(500).json({ error: 'Failed to update campaign' });
    }
  });

  /**
   * POST /api/ads/campaigns/:id/activate
   * Activate a campaign
   */
  router.post('/campaigns/:id/activate', authenticateAgent(db), async (req, res) => {
    try {
      const campaign = await db.query(
        'SELECT * FROM ad_campaigns WHERE id = $1 AND advertiser_agent_id = $2',
        [req.params.id, req.agent.id]
      );
      
      if (!campaign.rows[0]) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      const c = campaign.rows[0];
      
      // Check balance
      const remainingBudget = c.total_budget - c.spent_total;
      if (remainingBudget > req.agent.advertiser_balance) {
        return res.status(400).json({ 
          error: 'Insufficient balance',
          required: remainingBudget,
          available: req.agent.advertiser_balance
        });
      }
      
      await db.query(
        "UPDATE ad_campaigns SET status = 'active', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      
      res.json({ success: true, status: 'active' });
      
    } catch (err) {
      console.error('Activate campaign error:', err);
      res.status(500).json({ error: 'Failed to activate campaign' });
    }
  });

  /**
   * POST /api/ads/campaigns/:id/pause
   * Pause a campaign
   */
  router.post('/campaigns/:id/pause', authenticateAgent(db), async (req, res) => {
    try {
      const result = await db.query(`
        UPDATE ad_campaigns SET status = 'paused', updated_at = NOW()
        WHERE id = $1 AND advertiser_agent_id = $2 AND status = 'active'
        RETURNING *
      `, [req.params.id, req.agent.id]);
      
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Campaign not found or not active' });
      }
      
      res.json({ success: true, status: 'paused' });
      
    } catch (err) {
      console.error('Pause campaign error:', err);
      res.status(500).json({ error: 'Failed to pause campaign' });
    }
  });

  /**
   * GET /api/ads/campaigns/:id/stats
   * Get campaign statistics
   */
  router.get('/campaigns/:id/stats', authenticateAgent(db), async (req, res) => {
    try {
      const { period = '7d' } = req.query;
      
      const campaign = await db.query(
        'SELECT id FROM ad_campaigns WHERE id = $1 AND advertiser_agent_id = $2',
        [req.params.id, req.agent.id]
      );
      
      if (!campaign.rows[0]) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      const stats = await getCampaignStats(db, req.params.id, period);
      res.json(stats);
      
    } catch (err) {
      console.error('Get stats error:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ==========================================
  // AD SERVING (for frontend)
  // ==========================================

  /**
   * GET /api/ads/search
   * Get sponsored search results
   */
  router.get('/search', async (req, res) => {
    try {
      const { q, limit = 2 } = req.query;
      
      if (!q) {
        return res.json({ ads: [] });
      }
      
      const keywords = extractKeywords(q);
      
      // Find matching campaigns
      const campaigns = await db.query(`
        SELECT c.*, l.name, l.slug, l.short_description, l.badges, l.avg_rating, l.is_sample
        FROM ad_campaigns c
        JOIN listings l ON c.listing_id = l.id
        WHERE c.status = 'active'
          AND c.type = 'sponsored_search'
          AND c.spent_today < c.daily_budget
          AND c.spent_total < c.total_budget
          AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
          AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)
          AND (
            c.target_keywords && $1::text[]
            OR cardinality(c.target_keywords) = 0
          )
        ORDER BY c.max_cpc DESC
        LIMIT $2
      `, [keywords, parseInt(limit) || 2]);
      
      // Log impressions and format response
      const ads = [];
      for (let i = 0; i < campaigns.rows.length; i++) {
        const c = campaigns.rows[i];
        
        // Log impression
        await db.query(`
          INSERT INTO ad_impressions (campaign_id, placement, search_query, position)
          VALUES ($1, 'search', $2, $3)
        `, [c.id, q, i + 1]);
        
        // Update campaign impression count
        await db.query(
          'UPDATE ad_campaigns SET impressions = impressions + 1 WHERE id = $1',
          [c.id]
        );
        
        ads.push({
          campaign_id: c.id,
          listing_slug: c.slug,
          name: c.headline || c.name,
          description: c.description || c.short_description,
          badges: c.badges,
          avg_rating: c.avg_rating,
          destination_url: c.destination_url || `/listing/${c.slug}`,
          position: i + 1,
          is_sample: c.is_sample
        });
      }
      
      res.json({ ads });
      
    } catch (err) {
      console.error('Search ads error:', err);
      res.json({ ads: [] });
    }
  });

  /**
   * POST /api/ads/click
   * Record an ad click
   */
  router.post('/click', async (req, res) => {
    try {
      const { campaign_id, position } = req.body;
      
      if (!campaign_id) {
        return res.status(400).json({ error: 'campaign_id required' });
      }
      
      // Get campaign
      const campaign = await db.query(
        'SELECT * FROM ad_campaigns WHERE id = $1',
        [campaign_id]
      );
      
      if (!campaign.rows[0]) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      const c = campaign.rows[0];
      
      // Fraud detection
      const ipHash = hashIP(req.ip);
      const isValid = await validateClick(db, c.id, ipHash, req.agent?.id);
      
      // Calculate CPC (simplified - would be auction-based in production)
      const actualCpc = isValid ? Math.min(c.max_cpc, 0.10) : 0;
      
      // Record click
      await db.query(`
        INSERT INTO ad_clicks (campaign_id, click_cost, clicker_ip_hash, is_valid, fraud_reason)
        VALUES ($1, $2, $3, $4, $5)
      `, [campaign_id, actualCpc, ipHash, isValid, isValid ? null : 'fraud_detected']);
      
      // Update campaign
      if (isValid) {
        await db.query(`
          UPDATE ad_campaigns SET
            clicks = clicks + 1,
            spent_today = spent_today + $1,
            spent_total = spent_total + $1,
            ctr = CASE WHEN impressions > 0 THEN (clicks + 1)::decimal / impressions ELSE 0 END
          WHERE id = $2
        `, [actualCpc, campaign_id]);
        
        // Charge advertiser
        await db.query(
          'UPDATE agents SET advertiser_balance = advertiser_balance - $1 WHERE id = $2',
          [actualCpc, c.advertiser_agent_id]
        );
        
        // Log billing
        await db.query(`
          INSERT INTO ad_billing (advertiser_agent_id, type, amount, campaign_id, description)
          VALUES ($1, 'charge', $2, $3, 'Click charge')
        `, [c.advertiser_agent_id, actualCpc, campaign_id]);
      }
      
      res.json({ success: true, valid: isValid });
      
    } catch (err) {
      console.error('Click error:', err);
      res.status(500).json({ error: 'Failed to record click' });
    }
  });

  // ==========================================
  // BILLING
  // ==========================================

  /**
   * GET /api/ads/balance
   * Get advertiser balance and billing history
   */
  router.get('/balance', authenticateAgent(db), async (req, res) => {
    try {
      const billing = await db.query(`
        SELECT * FROM ad_billing
        WHERE advertiser_agent_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [req.agent.id]);
      
      res.json({
        balance: req.agent.advertiser_balance || 0,
        is_advertiser: req.agent.is_advertiser,
        transactions: billing.rows
      });
      
    } catch (err) {
      console.error('Get balance error:', err);
      res.status(500).json({ error: 'Failed to fetch balance' });
    }
  });

  /**
   * POST /api/ads/deposit
   * Deposit funds (simplified - would integrate Stripe in production)
   */
  router.post('/deposit', authenticateAgent(db), requireVerification('verified'), async (req, res) => {
    try {
      const { amount } = req.body;
      
      if (!amount || amount < 10) {
        return res.status(400).json({ error: 'Minimum deposit is $10' });
      }
      
      // In production, this would:
      // 1. Create Stripe PaymentIntent
      // 2. Return client_secret for frontend
      // 3. Webhook confirms payment and credits balance
      
      // For demo, directly credit
      await db.query(`
        UPDATE agents SET
          advertiser_balance = advertiser_balance + $1,
          is_advertiser = true,
          advertiser_since = COALESCE(advertiser_since, NOW())
        WHERE id = $2
      `, [amount, req.agent.id]);
      
      await db.query(`
        INSERT INTO ad_billing (advertiser_agent_id, type, amount, description, payment_method)
        VALUES ($1, 'deposit', $2, 'Account deposit', 'demo')
      `, [req.agent.id, amount]);
      
      const updated = await db.query(
        'SELECT advertiser_balance FROM agents WHERE id = $1',
        [req.agent.id]
      );
      
      res.json({
        success: true,
        new_balance: updated.rows[0].advertiser_balance,
        message: 'Funds deposited successfully'
      });
      
    } catch (err) {
      console.error('Deposit error:', err);
      res.status(500).json({ error: 'Deposit failed' });
    }
  });

  return router;
}

/**
 * Get campaign statistics
 */
async function getCampaignStats(db, campaignId, period) {
  const interval = period === '30d' ? '30 days' : '7 days';
  
  const summary = await db.query(`
    SELECT 
      COUNT(DISTINCT i.id)::int as impressions,
      COUNT(DISTINCT c.id) FILTER (WHERE c.is_valid)::int as clicks,
      COALESCE(SUM(c.click_cost) FILTER (WHERE c.is_valid), 0)::float as spend
    FROM ad_impressions i
    LEFT JOIN ad_clicks c ON c.campaign_id = i.campaign_id 
      AND c.timestamp >= i.timestamp - INTERVAL '1 minute'
      AND c.timestamp <= i.timestamp + INTERVAL '1 hour'
    WHERE i.campaign_id = $1 AND i.timestamp > NOW() - INTERVAL '${interval}'
  `, [campaignId]);
  
  const s = summary.rows[0];
  const ctr = s.impressions > 0 ? (s.clicks / s.impressions * 100) : 0;
  
  // Daily breakdown
  const daily = await db.query(`
    SELECT 
      DATE(timestamp) as date,
      COUNT(*)::int as impressions
    FROM ad_impressions
    WHERE campaign_id = $1 AND timestamp > NOW() - INTERVAL '${interval}'
    GROUP BY DATE(timestamp)
    ORDER BY date
  `, [campaignId]);
  
  return {
    period,
    impressions: s.impressions,
    clicks: s.clicks,
    spend: s.spend,
    ctr: Math.round(ctr * 100) / 100,
    daily: daily.rows
  };
}

/**
 * Validate click (fraud detection)
 */
async function validateClick(db, campaignId, ipHash, agentId) {
  // Check 1: Too many clicks from same IP
  const recentClicks = await db.query(`
    SELECT COUNT(*)::int as count FROM ad_clicks
    WHERE campaign_id = $1 AND clicker_ip_hash = $2
    AND timestamp > NOW() - INTERVAL '1 hour'
  `, [campaignId, ipHash]);
  
  if (recentClicks.rows[0].count >= 3) {
    return false;
  }
  
  // Check 2: Clicking own ads
  if (agentId) {
    const campaign = await db.query(
      'SELECT advertiser_agent_id FROM ad_campaigns WHERE id = $1',
      [campaignId]
    );
    if (campaign.rows[0]?.advertiser_agent_id === agentId) {
      return false;
    }
  }
  
  return true;
}

/**
 * Extract keywords from search query
 */
function extractKeywords(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 10);
}
