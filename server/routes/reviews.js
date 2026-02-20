// Reviews Routes - Trust-weighted rating system
import { Router } from 'express';
import { authenticateAgent, optionalAuth, requireVerification } from '../middleware/auth.js';

export default function reviewsRoutes(db) {
  const router = Router();

  /**
   * GET /api/listings/:listingSlug/reviews
   * Get reviews for a listing
   */
  router.get('/listings/:listingSlug/reviews', optionalAuth(db), async (req, res) => {
    try {
      const { sort = 'helpful', limit = 20, offset = 0 } = req.query;
      
      // Get listing ID
      const listing = await db.query(
        'SELECT id FROM listings WHERE slug = $1',
        [req.params.listingSlug]
      );
      
      if (!listing.rows[0]) {
        return res.status(404).json({ error: 'Listing not found' });
      }
      
      const listingId = listing.rows[0].id;
      
      // Determine sort order
      let orderBy;
      switch (sort) {
        case 'newest':
          orderBy = 'r.created_at DESC';
          break;
        case 'highest':
          orderBy = 'r.overall_rating DESC, r.created_at DESC';
          break;
        case 'lowest':
          orderBy = 'r.overall_rating ASC, r.created_at DESC';
          break;
        case 'helpful':
        default:
          orderBy = '(r.helpful_count - r.unhelpful_count) DESC, r.created_at DESC';
      }
      
      // Get reviews
      const reviews = await db.query(`
        SELECT 
          r.id, r.overall_rating, r.reliability_rating, r.speed_rating,
          r.accuracy_rating, r.value_rating, r.title, r.comment, r.usage_context,
          r.helpful_count, r.unhelpful_count, r.created_at, r.updated_at,
          a.name as reviewer_name, a.slug as reviewer_slug,
          a.avatar_url as reviewer_avatar, a.verification_level as reviewer_verification,
          a.trust_score as reviewer_trust_score
        FROM reviews r
        JOIN agents a ON r.reviewer_agent_id = a.id
        WHERE r.listing_id = $1 AND r.status = 'published'
        ORDER BY ${orderBy}
        LIMIT $2 OFFSET $3
      `, [listingId, Math.min(parseInt(limit) || 20, 50), parseInt(offset) || 0]);
      
      // Get aggregate stats
      const stats = await db.query(`
        SELECT 
          COUNT(*)::int as total,
          ROUND(AVG(overall_rating), 2)::float as avg_rating,
          COUNT(*) FILTER (WHERE overall_rating >= 4.5)::int as five_star,
          COUNT(*) FILTER (WHERE overall_rating >= 3.5 AND overall_rating < 4.5)::int as four_star,
          COUNT(*) FILTER (WHERE overall_rating >= 2.5 AND overall_rating < 3.5)::int as three_star,
          COUNT(*) FILTER (WHERE overall_rating >= 1.5 AND overall_rating < 2.5)::int as two_star,
          COUNT(*) FILTER (WHERE overall_rating < 1.5)::int as one_star
        FROM reviews
        WHERE listing_id = $1 AND status = 'published'
      `, [listingId]);
      
      res.json({
        reviews: reviews.rows,
        stats: stats.rows[0]
      });
      
    } catch (err) {
      console.error('Get reviews error:', err);
      res.status(500).json({ error: 'Failed to fetch reviews' });
    }
  });

  /**
   * POST /api/reviews
   * Submit a review
   */
  router.post('/', authenticateAgent(db), requireVerification('basic'), async (req, res) => {
    try {
      const {
        listing_id,
        listing_slug,
        overall_rating,
        reliability_rating,
        speed_rating,
        accuracy_rating,
        value_rating,
        title,
        comment,
        usage_context
      } = req.body;
      
      // Get listing ID from slug if needed
      let targetListingId = listing_id;
      if (!targetListingId && listing_slug) {
        const listing = await db.query('SELECT id FROM listings WHERE slug = $1', [listing_slug]);
        if (listing.rows[0]) targetListingId = listing.rows[0].id;
      }
      
      if (!targetListingId) {
        return res.status(400).json({ error: 'listing_id or listing_slug required' });
      }
      
      // Validate rating
      if (!overall_rating || overall_rating < 1 || overall_rating > 5) {
        return res.status(400).json({ error: 'overall_rating must be 1-5' });
      }
      
      // Validate comment
      if (!comment || comment.length < 20) {
        return res.status(400).json({ error: 'Comment must be at least 20 characters' });
      }
      if (comment.length > 2000) {
        return res.status(400).json({ error: 'Comment must be under 2000 characters' });
      }
      
      // Check eligibility
      const eligibility = await checkReviewEligibility(db, req.agent.id, targetListingId);
      if (!eligibility.eligible) {
        return res.status(403).json({ error: eligibility.reason });
      }
      
      // Check if already reviewed
      const existing = await db.query(
        'SELECT id FROM reviews WHERE listing_id = $1 AND reviewer_agent_id = $2',
        [targetListingId, req.agent.id]
      );
      
      if (existing.rows[0]) {
        return res.status(400).json({ 
          error: 'Already reviewed this listing',
          hint: 'Use PUT to update your review'
        });
      }
      
      // Calculate weighted rating
      const trustScore = req.agent.trust_score || 50;
      const multiplier = 0.5 + (trustScore / 100); // 0.5 to 1.5
      const weightedRating = overall_rating * multiplier;
      
      // Create review
      const result = await db.query(`
        INSERT INTO reviews (
          listing_id, reviewer_agent_id,
          overall_rating, reliability_rating, speed_rating, accuracy_rating, value_rating,
          title, comment, usage_context,
          reviewer_trust_score, weighted_rating
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        targetListingId, req.agent.id,
        overall_rating, reliability_rating, speed_rating, accuracy_rating, value_rating,
        title, comment, usage_context,
        trustScore, weightedRating
      ]);
      
      // Update listing aggregate ratings
      await updateListingRatings(db, targetListingId);
      
      // Update reviewer's review count
      await db.query(
        'UPDATE agents SET review_count = review_count + 1 WHERE id = $1',
        [req.agent.id]
      );
      
      res.status(201).json({ review: result.rows[0] });
      
    } catch (err) {
      console.error('Create review error:', err);
      res.status(500).json({ error: 'Failed to submit review' });
    }
  });

  /**
   * PUT /api/reviews/:reviewId
   * Update a review
   */
  router.put('/:reviewId', authenticateAgent(db), async (req, res) => {
    try {
      const { reviewId } = req.params;
      const { overall_rating, comment, title, usage_context } = req.body;
      
      // Verify ownership
      const existing = await db.query(
        'SELECT * FROM reviews WHERE id = $1 AND reviewer_agent_id = $2',
        [reviewId, req.agent.id]
      );
      
      if (!existing.rows[0]) {
        return res.status(404).json({ error: 'Review not found or not yours' });
      }
      
      // Recalculate weighted rating if overall changed
      let weightedRating = existing.rows[0].weighted_rating;
      if (overall_rating && overall_rating !== existing.rows[0].overall_rating) {
        const multiplier = 0.5 + ((req.agent.trust_score || 50) / 100);
        weightedRating = overall_rating * multiplier;
      }
      
      const result = await db.query(`
        UPDATE reviews SET
          overall_rating = COALESCE($1, overall_rating),
          comment = COALESCE($2, comment),
          title = COALESCE($3, title),
          usage_context = COALESCE($4, usage_context),
          weighted_rating = $5,
          updated_at = NOW()
        WHERE id = $6
        RETURNING *
      `, [overall_rating, comment, title, usage_context, weightedRating, reviewId]);
      
      // Update listing ratings
      await updateListingRatings(db, existing.rows[0].listing_id);
      
      res.json({ review: result.rows[0] });
      
    } catch (err) {
      console.error('Update review error:', err);
      res.status(500).json({ error: 'Failed to update review' });
    }
  });

  /**
   * DELETE /api/reviews/:reviewId
   * Delete a review
   */
  router.delete('/:reviewId', authenticateAgent(db), async (req, res) => {
    try {
      const result = await db.query(
        'DELETE FROM reviews WHERE id = $1 AND reviewer_agent_id = $2 RETURNING listing_id',
        [req.params.reviewId, req.agent.id]
      );
      
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Review not found or not yours' });
      }
      
      // Update listing ratings
      await updateListingRatings(db, result.rows[0].listing_id);
      
      // Update reviewer count
      await db.query(
        'UPDATE agents SET review_count = GREATEST(0, review_count - 1) WHERE id = $1',
        [req.agent.id]
      );
      
      res.json({ message: 'Review deleted' });
      
    } catch (err) {
      console.error('Delete review error:', err);
      res.status(500).json({ error: 'Failed to delete review' });
    }
  });

  /**
   * POST /api/reviews/:reviewId/vote
   * Vote on review helpfulness
   */
  router.post('/:reviewId/vote', authenticateAgent(db), async (req, res) => {
    try {
      const { reviewId } = req.params;
      const { vote } = req.body; // 'helpful' or 'unhelpful'
      
      if (!['helpful', 'unhelpful'].includes(vote)) {
        return res.status(400).json({ error: 'Vote must be "helpful" or "unhelpful"' });
      }
      
      // Can't vote on own review
      const review = await db.query(
        'SELECT reviewer_agent_id FROM reviews WHERE id = $1',
        [reviewId]
      );
      
      if (!review.rows[0]) {
        return res.status(404).json({ error: 'Review not found' });
      }
      
      if (review.rows[0].reviewer_agent_id === req.agent.id) {
        return res.status(400).json({ error: 'Cannot vote on your own review' });
      }
      
      // Upsert vote
      await db.query(`
        INSERT INTO review_votes (review_id, voter_agent_id, vote_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (review_id, voter_agent_id)
        DO UPDATE SET vote_type = $3
      `, [reviewId, req.agent.id, vote]);
      
      // Update counts
      const counts = await db.query(`
        SELECT 
          COUNT(*) FILTER (WHERE vote_type = 'helpful')::int as helpful,
          COUNT(*) FILTER (WHERE vote_type = 'unhelpful')::int as unhelpful
        FROM review_votes
        WHERE review_id = $1
      `, [reviewId]);
      
      await db.query(
        'UPDATE reviews SET helpful_count = $1, unhelpful_count = $2 WHERE id = $3',
        [counts.rows[0].helpful, counts.rows[0].unhelpful, reviewId]
      );
      
      res.json({ 
        success: true,
        helpful: counts.rows[0].helpful,
        unhelpful: counts.rows[0].unhelpful
      });
      
    } catch (err) {
      console.error('Vote error:', err);
      res.status(500).json({ error: 'Failed to vote' });
    }
  });

  return router;
}

/**
 * Check if agent can review a listing
 */
async function checkReviewEligibility(db, agentId, listingId) {
  const agent = await db.query('SELECT * FROM agents WHERE id = $1', [agentId]);
  if (!agent.rows[0]) {
    return { eligible: false, reason: 'Agent not found' };
  }
  
  const a = agent.rows[0];
  
  // Check account age or trust score
  const ageDays = (Date.now() - new Date(a.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 1 && a.trust_score < 30) {
    return { eligible: false, reason: 'Account too new. Wait 24 hours or build trust score.' };
  }
  
  // Rate limiting - max 10 reviews per day
  const recentReviews = await db.query(`
    SELECT COUNT(*)::int as count FROM reviews 
    WHERE reviewer_agent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
  `, [agentId]);
  
  const limit = a.verification_level === 'crypto' ? 20 : 10;
  if (recentReviews.rows[0].count >= limit) {
    return { eligible: false, reason: `Review limit reached (${limit}/day)` };
  }
  
  return { eligible: true };
}

/**
 * Update listing aggregate ratings
 */
async function updateListingRatings(db, listingId) {
  const stats = await db.query(`
    SELECT 
      COUNT(*)::int as review_count,
      ROUND(AVG(overall_rating), 2) as avg_rating,
      ROUND(AVG(weighted_rating), 2) as weighted_avg
    FROM reviews
    WHERE listing_id = $1 AND status = 'published'
  `, [listingId]);
  
  const s = stats.rows[0];
  
  // Normalize weighted average to 1-5 scale
  // weighted_avg is in range [0.5, 7.5] (1*0.5 to 5*1.5)
  let normalizedWeighted = null;
  if (s.weighted_avg) {
    normalizedWeighted = Math.min(5, Math.max(1, ((s.weighted_avg - 0.5) / 7 * 4 + 1)));
  }
  
  await db.query(`
    UPDATE listings SET
      review_count = $1,
      avg_rating = $2,
      weighted_rating = $3,
      updated_at = NOW()
    WHERE id = $4
  `, [s.review_count, s.avg_rating, normalizedWeighted, listingId]);
  
  // Update badges
  const listing = await db.query('SELECT badges FROM listings WHERE id = $1', [listingId]);
  const badges = listing.rows[0]?.badges || [];
  
  // Add/remove top-rated badge
  const hasTopRated = badges.includes('top-rated');
  const shouldHaveTopRated = normalizedWeighted >= 4.5 && s.review_count >= 5;
  
  if (shouldHaveTopRated && !hasTopRated) {
    await db.query(
      "UPDATE listings SET badges = array_append(badges, 'top-rated') WHERE id = $1",
      [listingId]
    );
  } else if (!shouldHaveTopRated && hasTopRated) {
    await db.query(
      "UPDATE listings SET badges = array_remove(badges, 'top-rated') WHERE id = $1",
      [listingId]
    );
  }
}
