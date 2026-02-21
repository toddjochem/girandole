// Agent Routes - Registration, Profile, Authentication
import { Router } from 'express';
import { generateApiKey, generateToken, slugify } from '../utils/keys.js';
import { authenticateAgent, requireVerification } from '../middleware/auth.js';

export default function agentsRoutes(db) {
  const router = Router();

  /**
   * POST /api/agents/register
   * Create a new agent account
   */
  router.post('/register', async (req, res) => {
    try {
      const { name, description } = req.body;
      
      if (!name || name.length < 2 || name.length > 100) {
        return res.status(400).json({ error: 'Name must be 2-100 characters' });
      }
      
      const slug = slugify(name);
      
      // Check uniqueness
      const existing = await db.query(
        'SELECT id FROM agents WHERE name = $1 OR slug = $2',
        [name, slug]
      );
      
      if (existing.rows[0]) {
        return res.status(400).json({ error: 'Name already taken' });
      }
      
      // Generate API key
      const { key, hash, prefix } = generateApiKey();
      
      // Create agent
      const result = await db.query(`
        INSERT INTO agents (name, slug, description, api_key_hash, api_key_prefix)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, slug, description, verification_level, trust_score, created_at
      `, [name, slug, description || null, hash, prefix]);
      
      // Log event
      await db.query(`
        INSERT INTO api_key_events (agent_id, event_type, ip_address, user_agent)
        VALUES ($1, 'created', $2, $3)
      `, [result.rows[0].id, req.ip, req.headers['user-agent']]);
      
      res.status(201).json({
        agent: result.rows[0],
        api_key: key,
        message: 'Save this API key securely - it will not be shown again!'
      });
      
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ error: 'Registration failed', details: err.message });
    }
  });

  /**
   * GET /api/agents/me
   * Get current authenticated agent
   */
  router.get('/me', authenticateAgent(db), async (req, res) => {
    const { api_key_hash, email_verification_token, ...agent } = req.agent;
    res.json({ agent });
  });

  /**
   * PATCH /api/agents/me
   * Update current agent profile
   */
  router.patch('/me', authenticateAgent(db), async (req, res) => {
    try {
      const { description, avatar_url, website_url } = req.body;
      
      const result = await db.query(`
        UPDATE agents SET
          description = COALESCE($1, description),
          avatar_url = COALESCE($2, avatar_url),
          website_url = COALESCE($3, website_url),
          updated_at = NOW()
        WHERE id = $4
        RETURNING id, name, slug, description, avatar_url, website_url, verification_level, trust_score, updated_at
      `, [description, avatar_url, website_url, req.agent.id]);
      
      res.json({ agent: result.rows[0] });
      
    } catch (err) {
      console.error('Update error:', err);
      res.status(500).json({ error: 'Update failed' });
    }
  });

  /**
   * POST /api/agents/regenerate-key
   * Generate a new API key (invalidates old one)
   */
  router.post('/regenerate-key', authenticateAgent(db), async (req, res) => {
    try {
      const { key, hash, prefix } = generateApiKey();
      
      await db.query(
        'UPDATE agents SET api_key_hash = $1, api_key_prefix = $2, updated_at = NOW() WHERE id = $3',
        [hash, prefix, req.agent.id]
      );
      
      await db.query(`
        INSERT INTO api_key_events (agent_id, event_type, ip_address, user_agent)
        VALUES ($1, 'regenerated', $2, $3)
      `, [req.agent.id, req.ip, req.headers['user-agent']]);
      
      res.json({
        api_key: key,
        message: 'New API key generated. Old key is now invalid.'
      });
      
    } catch (err) {
      console.error('Regenerate key error:', err);
      res.status(500).json({ error: 'Key regeneration failed' });
    }
  });

  /**
   * POST /api/agents/verify-email
   * Start email verification
   */
  router.post('/verify-email', authenticateAgent(db), async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
      }
      
      // Check if email already used
      const existing = await db.query(
        'SELECT id FROM agents WHERE email = $1 AND email_verified = true AND id != $2',
        [email, req.agent.id]
      );
      
      if (existing.rows[0]) {
        return res.status(400).json({ error: 'Email already verified by another agent' });
      }
      
      const token = generateToken();
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      
      await db.query(`
        UPDATE agents SET
          email = $1,
          email_verification_token = $2,
          email_verification_expires = $3
        WHERE id = $4
      `, [email, token, expires, req.agent.id]);
      
      // In production, send email here
      // For now, return token (dev mode)
      res.json({
        message: 'Verification email sent',
        // DEV ONLY - remove in production:
        dev_token: process.env.NODE_ENV !== 'production' ? token : undefined
      });
      
    } catch (err) {
      console.error('Email verification error:', err);
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  /**
   * POST /api/agents/confirm-email
   * Confirm email with token
   */
  router.post('/confirm-email', async (req, res) => {
    try {
      const { token } = req.body;
      
      if (!token) {
        return res.status(400).json({ error: 'Token required' });
      }
      
      const result = await db.query(`
        UPDATE agents SET
          email_verified = true,
          email_verification_token = NULL,
          email_verification_expires = NULL,
          verification_level = CASE 
            WHEN wallet_address IS NOT NULL THEN 'crypto'
            ELSE 'verified'
          END
        WHERE email_verification_token = $1 
          AND email_verification_expires > NOW()
        RETURNING id, name, verification_level
      `, [token]);
      
      if (!result.rows[0]) {
        return res.status(400).json({ error: 'Invalid or expired token' });
      }
      
      res.json({
        message: 'Email verified successfully',
        agent: result.rows[0]
      });
      
    } catch (err) {
      console.error('Confirm email error:', err);
      res.status(500).json({ error: 'Confirmation failed' });
    }
  });

  /**
   * GET /api/agents/:slug
   * Get public agent profile
   */
  router.get('/:slug', async (req, res) => {
    try {
      const result = await db.query(`
        SELECT 
          id, name, slug, description, avatar_url, website_url,
          verification_level, trust_score, review_count,
          created_at, last_active_at
        FROM agents 
        WHERE slug = $1 AND status = 'active'
      `, [req.params.slug]);
      
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      // Get agent's listings
      const listings = await db.query(`
        SELECT id, type, name, slug, short_description, avg_rating, review_count
        FROM listings
        WHERE owner_agent_id = $1 AND status = 'active'
        ORDER BY avg_rating DESC NULLS LAST
        LIMIT 20
      `, [result.rows[0].id]);
      
      res.json({ 
        agent: result.rows[0],
        listings: listings.rows
      });
      
    } catch (err) {
      console.error('Get agent error:', err);
      res.status(500).json({ error: 'Failed to fetch agent' });
    }
  });

  return router;
}
