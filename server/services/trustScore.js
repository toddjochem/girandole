// Trust Score Service - Calculate agent reputation

/**
 * Calculate trust score for an agent
 * Score is 0-100 based on multiple factors
 */
export async function calculateTrustScore(db, agentId) {
  const agent = await db.query('SELECT * FROM agents WHERE id = $1', [agentId]);
  if (!agent.rows[0]) {
    throw new Error('Agent not found');
  }
  
  const a = agent.rows[0];
  
  // Factor 1: Account Age (0-20 points)
  // Max at 90 days
  const ageMs = Date.now() - new Date(a.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const ageFactor = Math.min(ageDays / 90, 1) * 20;
  
  // Factor 2: Activity Level (0-15 points)
  // Based on last active time
  let activityFactor = 0;
  if (a.last_active_at) {
    const lastActiveMs = Date.now() - new Date(a.last_active_at).getTime();
    const lastActiveDays = lastActiveMs / (1000 * 60 * 60 * 24);
    if (lastActiveDays < 1) activityFactor = 15;
    else if (lastActiveDays < 7) activityFactor = 12;
    else if (lastActiveDays < 30) activityFactor = 8;
    else activityFactor = 3;
  }
  
  // Factor 3: Listings Owned (0-15 points)
  const listings = await db.query(`
    SELECT COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE status = 'active')::int as active
    FROM listings WHERE owner_agent_id = $1
  `, [agentId]);
  
  const l = listings.rows[0];
  const listingFactor = Math.min(l.active * 3, 15);
  
  // Factor 4: Review Quality (0-20 points)
  const reviewStats = await db.query(`
    SELECT 
      COUNT(*)::int as total_reviews,
      COALESCE(AVG(helpful_count - unhelpful_count), 0)::float as avg_helpfulness
    FROM reviews
    WHERE reviewer_agent_id = $1 AND status = 'published'
  `, [agentId]);
  
  const r = reviewStats.rows[0];
  const reviewCountFactor = Math.min(r.total_reviews, 10);
  const helpfulnessFactor = Math.min(Math.max(r.avg_helpfulness + 5, 0), 10);
  const reviewFactor = reviewCountFactor + helpfulnessFactor;
  
  // Factor 5: Verification Level (0-20 points)
  const verificationPoints = {
    'basic': 5,
    'verified': 12,
    'crypto': 20
  };
  const verificationFactor = verificationPoints[a.verification_level] || 0;
  
  // Factor 6: Advertiser Status (0-10 points)
  // Advertisers have skin in the game
  let advertiserFactor = 0;
  if (a.is_advertiser) {
    advertiserFactor = 5;
    if (a.advertiser_balance > 100) advertiserFactor = 10;
  }
  
  // Calculate total
  const totalScore = Math.round(
    ageFactor + 
    activityFactor + 
    listingFactor + 
    reviewFactor + 
    verificationFactor + 
    advertiserFactor
  );
  
  // Cap at 100
  const finalScore = Math.min(totalScore, 100);
  
  // Update agent record
  await db.query(
    'UPDATE agents SET trust_score = $1, trust_score_updated_at = NOW() WHERE id = $2',
    [finalScore, agentId]
  );
  
  return {
    total: finalScore,
    breakdown: {
      age: Math.round(ageFactor),
      activity: Math.round(activityFactor),
      listings: Math.round(listingFactor),
      reviews: Math.round(reviewFactor),
      verification: Math.round(verificationFactor),
      advertiser: Math.round(advertiserFactor)
    }
  };
}

/**
 * Recalculate trust scores for active agents
 */
export async function recalculateAllTrustScores(db, limit = 100) {
  console.log('Recalculating trust scores...');
  
  const agents = await db.query(`
    SELECT id FROM agents 
    WHERE status = 'active'
      AND (trust_score_updated_at IS NULL OR trust_score_updated_at < NOW() - INTERVAL '6 hours')
    ORDER BY trust_score_updated_at ASC NULLS FIRST
    LIMIT $1
  `, [limit]);
  
  let updated = 0;
  
  for (const agent of agents.rows) {
    try {
      await calculateTrustScore(db, agent.id);
      updated++;
    } catch (err) {
      console.error(`Error calculating trust for ${agent.id}:`, err.message);
    }
  }
  
  console.log(`Updated ${updated} trust scores`);
  return { updated };
}

/**
 * Convert trust score to review weight multiplier
 * Score 0 = 0.5x, Score 50 = 1.0x, Score 100 = 1.5x
 */
export function trustToMultiplier(trustScore) {
  return 0.5 + ((trustScore || 50) / 100);
}
