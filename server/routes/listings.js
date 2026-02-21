// Listings Routes - CRUD for all listing types
import { Router } from 'express';
import crypto from 'crypto';
import { slugify } from '../utils/keys.js';
import { authenticateAgent, optionalAuth } from '../middleware/auth.js';

const VALID_TYPES = ['api', 'mcp', 'skill', 'agent', 'data', 'tool'];
const VALID_CATEGORIES = ['commerce', 'data', 'communication', 'utilities', 'ai', 'finance', 'media', 'developer'];

export default function listingsRoutes(db) {
  const router = Router();

  /**
   * GET /api/listings
   * Search and filter listings
   */
  router.get('/', optionalAuth(db), async (req, res) => {
    try {
      const { 
        q,           // Search query
        type,        // Listing type
        category,    // Category filter
        badge,       // Has specific badge
        sort = 'relevance',  // relevance, rating, newest, popular
        limit = 20, 
        offset = 0 
      } = req.query;
      
      let query = `
        SELECT 
          l.id, l.type, l.name, l.slug, l.short_description, l.description,
          l.category, l.tags, l.pricing_model, l.price_amount, l.price_currency,
          l.status, l.badges, l.avg_rating, l.review_count,
          l.uptime_percent, l.avg_response_ms, l.created_at,
          l.query_count, l.unique_agents_7d, l.is_sample,
          COALESCE(a.trust_score, 50) as owner_trust_score
        FROM listings l
        LEFT JOIN agents a ON l.owner_agent_id = a.id
        WHERE l.status = 'active'
      `;
      const params = [];
      let paramIdx = 0;
      
      // Search
      if (q) {
        paramIdx++;
        query += ` AND (
          l.name ILIKE $${paramIdx} OR 
          l.description ILIKE $${paramIdx} OR
          l.short_description ILIKE $${paramIdx} OR
          $${paramIdx} = ANY(l.tags)
        )`;
        params.push(`%${q}%`);
      }
      
      // Type filter
      if (type && VALID_TYPES.includes(type)) {
        paramIdx++;
        query += ` AND l.type = $${paramIdx}`;
        params.push(type);
      }
      
      // Category filter
      if (category && VALID_CATEGORIES.includes(category)) {
        paramIdx++;
        query += ` AND l.category = $${paramIdx}`;
        params.push(category);
      }
      
      // Badge filter
      if (badge) {
        paramIdx++;
        query += ` AND $${paramIdx} = ANY(l.badges)`;
        params.push(badge);
      }
      
      // Sorting - trust score factors into all rankings
      switch (sort) {
        case 'rating':
          query += ` ORDER BY l.avg_rating DESC NULLS LAST, COALESCE(a.trust_score, 50) DESC, l.review_count DESC`;
          break;
        case 'newest':
          query += ` ORDER BY l.created_at DESC`;
          break;
        case 'popular':
          query += ` ORDER BY l.review_count DESC, COALESCE(a.trust_score, 50) DESC, l.avg_rating DESC NULLS LAST`;
          break;
        case 'trust':
          query += ` ORDER BY COALESCE(a.trust_score, 50) DESC, l.avg_rating DESC NULLS LAST`;
          break;
        case 'relevance':
        default:
          if (q) {
            // Prioritize: name match, then trust score, then rating
            paramIdx++;
            query += ` ORDER BY 
              CASE WHEN l.name ILIKE $${paramIdx} THEN 0 ELSE 1 END,
              COALESCE(a.trust_score, 50) DESC,
              l.avg_rating DESC NULLS LAST, l.review_count DESC`;
            params.push(`%${q}%`);
          } else {
            // Default: trust score then rating
            query += ` ORDER BY COALESCE(a.trust_score, 50) DESC, l.avg_rating DESC NULLS LAST, l.review_count DESC`;
          }
      }
      
      // Pagination
      paramIdx++;
      query += ` LIMIT $${paramIdx}`;
      params.push(Math.min(parseInt(limit) || 20, 100));
      
      paramIdx++;
      query += ` OFFSET $${paramIdx}`;
      params.push(parseInt(offset) || 0);
      
      const result = await db.query(query, params);
      
      // Get total count
      let countQuery = `SELECT COUNT(*) FROM listings l WHERE l.status = 'active'`;
      const countParams = [];
      let countIdx = 0;
      
      if (q) {
        countIdx++;
        countQuery += ` AND (l.name ILIKE $${countIdx} OR l.description ILIKE $${countIdx})`;
        countParams.push(`%${q}%`);
      }
      if (type && VALID_TYPES.includes(type)) {
        countIdx++;
        countQuery += ` AND l.type = $${countIdx}`;
        countParams.push(type);
      }
      if (category && VALID_CATEGORIES.includes(category)) {
        countIdx++;
        countQuery += ` AND l.category = $${countIdx}`;
        countParams.push(category);
      }
      
      const countResult = await db.query(countQuery, countParams);
      
      res.json({
        listings: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
      
    } catch (err) {
      console.error('Search error:', err);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  /**
   * GET /api/listings/:slug
   * Get single listing with full details
   */
  router.get('/:slug', optionalAuth(db), async (req, res) => {
    try {
      const result = await db.query(`
        SELECT 
          l.*,
          m.*,
          a.name as owner_name,
          a.slug as owner_slug,
          a.avatar_url as owner_avatar,
          a.verification_level as owner_verification
        FROM listings l
        LEFT JOIN listing_metadata m ON l.id = m.listing_id
        LEFT JOIN agents a ON l.owner_agent_id = a.id
        WHERE l.slug = $1
      `, [req.params.slug]);
      
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Listing not found' });
      }
      
      // Get recent health checks
      const healthChecks = await db.query(`
        SELECT success, response_ms, status_code, checked_at
        FROM health_checks
        WHERE listing_id = $1
        ORDER BY checked_at DESC
        LIMIT 24
      `, [result.rows[0].id]);
      
      // Log usage (for "verified usage" trust metric)
      const ipHash = req.ip ? crypto.createHash('sha256').update(req.ip).digest('hex').slice(0, 16) : null;
      db.query(`
        INSERT INTO listing_queries (listing_id, agent_id, ip_hash)
        VALUES ($1, $2, $3)
      `, [result.rows[0].id, req.agent?.id || null, ipHash]).catch(() => {});
      
      // Update query count (fire and forget)
      db.query(`
        UPDATE listings SET 
          query_count = query_count + 1,
          last_queried_at = NOW()
        WHERE id = $1
      `, [result.rows[0].id]).catch(() => {});
      
      res.json({
        listing: result.rows[0],
        healthChecks: healthChecks.rows
      });
      
    } catch (err) {
      console.error('Get listing error:', err);
      res.status(500).json({ error: 'Failed to fetch listing' });
    }
  });

  /**
   * POST /api/listings
   * Create a new listing
   */
  router.post('/', authenticateAgent(db), async (req, res) => {
    try {
      const {
        type,
        name,
        description,
        short_description,
        category,
        tags,
        pricing_model,
        price_amount,
        price_currency,
        price_unit,
        // Type-specific metadata
        ...metadata
      } = req.body;
      
      // Validate required fields
      if (!type || !VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: 'Valid type required', valid_types: VALID_TYPES });
      }
      if (!name || name.length < 2 || name.length > 150) {
        return res.status(400).json({ error: 'Name must be 2-150 characters' });
      }
      if (category && !VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Invalid category', valid_categories: VALID_CATEGORIES });
      }
      
      const slug = slugify(name);
      
      // Check uniqueness
      const existing = await db.query('SELECT id FROM listings WHERE slug = $1', [slug]);
      if (existing.rows[0]) {
        return res.status(400).json({ error: 'A listing with this name already exists' });
      }
      
      // Create listing
      const listing = await db.query(`
        INSERT INTO listings (
          type, name, slug, description, short_description,
          category, tags, pricing_model, price_amount, price_currency, price_unit,
          owner_agent_id, claimed, claimed_at, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, NOW(), 'pending')
        RETURNING *
      `, [
        type, name, slug, description || null, short_description || null,
        category || null, tags || [], pricing_model || 'free', 
        price_amount || null, price_currency || 'USD', price_unit || null,
        req.agent.id
      ]);
      
      // Create metadata
      const metadataFields = getMetadataFields(type, metadata);
      if (Object.keys(metadataFields).length > 0) {
        const fields = Object.keys(metadataFields);
        const values = Object.values(metadataFields);
        const placeholders = fields.map((_, i) => `$${i + 2}`).join(', ');
        
        await db.query(`
          INSERT INTO listing_metadata (listing_id, ${fields.join(', ')})
          VALUES ($1, ${placeholders})
        `, [listing.rows[0].id, ...values]);
      }
      
      res.status(201).json({ 
        listing: listing.rows[0],
        message: 'Listing created. It will be active after verification.'
      });
      
    } catch (err) {
      console.error('Create listing error:', err);
      res.status(500).json({ error: 'Failed to create listing' });
    }
  });

  /**
   * PATCH /api/listings/:slug
   * Update a listing (owner only)
   */
  router.patch('/:slug', authenticateAgent(db), async (req, res) => {
    try {
      // Verify ownership
      const existing = await db.query(
        'SELECT * FROM listings WHERE slug = $1',
        [req.params.slug]
      );
      
      if (!existing.rows[0]) {
        return res.status(404).json({ error: 'Listing not found' });
      }
      
      if (existing.rows[0].owner_agent_id !== req.agent.id) {
        return res.status(403).json({ error: 'Not your listing' });
      }
      
      const {
        description,
        short_description,
        category,
        tags,
        pricing_model,
        price_amount,
        price_currency,
        price_unit,
        ...metadata
      } = req.body;
      
      // Update listing
      const result = await db.query(`
        UPDATE listings SET
          description = COALESCE($1, description),
          short_description = COALESCE($2, short_description),
          category = COALESCE($3, category),
          tags = COALESCE($4, tags),
          pricing_model = COALESCE($5, pricing_model),
          price_amount = COALESCE($6, price_amount),
          price_currency = COALESCE($7, price_currency),
          price_unit = COALESCE($8, price_unit),
          updated_at = NOW()
        WHERE id = $9
        RETURNING *
      `, [
        description, short_description, category, tags,
        pricing_model, price_amount, price_currency, price_unit,
        existing.rows[0].id
      ]);
      
      res.json({ listing: result.rows[0] });
      
    } catch (err) {
      console.error('Update listing error:', err);
      res.status(500).json({ error: 'Failed to update listing' });
    }
  });

  /**
   * DELETE /api/listings/:slug
   * Delete a listing (owner only)
   */
  router.delete('/:slug', authenticateAgent(db), async (req, res) => {
    try {
      const result = await db.query(
        'DELETE FROM listings WHERE slug = $1 AND owner_agent_id = $2 RETURNING id',
        [req.params.slug, req.agent.id]
      );
      
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Listing not found or not yours' });
      }
      
      res.json({ message: 'Listing deleted' });
      
    } catch (err) {
      console.error('Delete listing error:', err);
      res.status(500).json({ error: 'Failed to delete listing' });
    }
  });

  return router;
}

/**
 * Extract type-specific metadata fields
 */
function getMetadataFields(type, metadata) {
  const fields = {};
  const prefix = type === 'agent' ? 'agent_' : type + '_';
  
  const allowedFields = {
    api: ['endpoint', 'method', 'auth_type', 'auth_header', 'docs_url', 'sample_request', 'sample_response'],
    mcp: ['transport', 'capabilities', 'install_command', 'repo_url', 'config_schema'],
    skill: ['schema_url', 'checksum', 'version', 'repo_url', 'dependencies'],
    agent: ['agent_id', 'wallet_address', 'capabilities', 'response_time', 'availability', 'languages'],
    data: ['format', 'update_frequency', 'sample_url', 'size_estimate', 'license'],
    tool: ['platforms', 'install_command', 'version', 'docs_url', 'repo_url']
  };
  
  const allowed = allowedFields[type] || [];
  
  for (const field of allowed) {
    const inputKey = field;
    const dbKey = prefix + field;
    
    if (metadata[inputKey] !== undefined) {
      fields[dbKey] = typeof metadata[inputKey] === 'object' 
        ? JSON.stringify(metadata[inputKey])
        : metadata[inputKey];
    }
  }
  
  return fields;
}
