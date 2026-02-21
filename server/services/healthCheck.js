// Health Check Runner - Pings endpoints and records uptime
import fetch from 'node-fetch';

/**
 * Run health checks for all active listings with endpoints
 */
export async function runHealthChecks(db) {
  console.log('[HealthCheck] Starting health check run...');
  
  // Get listings with endpoints that need checking
  const listings = await db.query(`
    SELECT l.id, l.name, m.api_endpoint
    FROM listings l
    JOIN listing_metadata m ON l.id = m.listing_id
    WHERE l.status = 'active'
      AND m.api_endpoint IS NOT NULL
      AND (l.last_check_at IS NULL OR l.last_check_at < NOW() - INTERVAL '1 hour')
    LIMIT 50
  `);
  
  console.log(`[HealthCheck] Checking ${listings.rows.length} listings...`);
  
  for (const listing of listings.rows) {
    await checkListing(db, listing);
  }
  
  console.log('[HealthCheck] Health check run complete.');
}

/**
 * Check a single listing's endpoint
 */
async function checkListing(db, listing) {
  const startTime = Date.now();
  let success = false;
  let statusCode = null;
  let responseMs = null;
  let errorMessage = null;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(listing.api_endpoint, {
      method: 'HEAD', // Just check if it responds
      signal: controller.signal,
      headers: {
        'User-Agent': 'Girandole-HealthCheck/1.0'
      }
    });
    
    clearTimeout(timeout);
    
    responseMs = Date.now() - startTime;
    statusCode = response.status;
    success = response.ok || response.status === 401 || response.status === 403; // Auth errors still mean it's up
    
  } catch (err) {
    responseMs = Date.now() - startTime;
    errorMessage = err.message;
    success = false;
  }
  
  // Record the check
  await db.query(`
    INSERT INTO health_checks (listing_id, success, response_ms, status_code, error_message)
    VALUES ($1, $2, $3, $4, $5)
  `, [listing.id, success, responseMs, statusCode, errorMessage]);
  
  // Update listing stats
  await db.query(`
    UPDATE listings SET
      last_check_at = NOW(),
      check_count = check_count + 1
    WHERE id = $1
  `, [listing.id]);
  
  // Recalculate uptime and avg response time
  await updateListingStats(db, listing.id);
  
  console.log(`[HealthCheck] ${listing.name}: ${success ? '✓' : '✗'} ${responseMs}ms`);
}

/**
 * Update listing uptime and response time stats
 */
async function updateListingStats(db, listingId) {
  const stats = await db.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE success = true) as successes,
      AVG(response_ms) FILTER (WHERE success = true) as avg_ms
    FROM health_checks
    WHERE listing_id = $1
      AND checked_at > NOW() - INTERVAL '7 days'
  `, [listingId]);
  
  const { total, successes, avg_ms } = stats.rows[0];
  const uptimePercent = total > 0 ? Math.round((successes / total) * 100) : null;
  const avgResponseMs = avg_ms ? Math.round(avg_ms) : null;
  
  await db.query(`
    UPDATE listings SET
      uptime_percent = $1,
      avg_response_ms = $2
    WHERE id = $3
  `, [uptimePercent, avgResponseMs, listingId]);
}

/**
 * Compute unique agents for all listings (run daily)
 */
export async function computeUniqueAgents(db) {
  console.log('[UniqueAgents] Computing unique agents for last 7 days...');
  
  await db.query(`
    UPDATE listings l SET
      unique_agents_7d = (
        SELECT COUNT(DISTINCT agent_id)
        FROM listing_queries q
        WHERE q.listing_id = l.id
          AND q.agent_id IS NOT NULL
          AND q.queried_at > NOW() - INTERVAL '7 days'
      )
  `);
  
  console.log('[UniqueAgents] Done.');
}

export default { runHealthChecks, computeUniqueAgents };
