// Verification Service - Health checks and badge computation
// Run periodically to verify listings

/**
 * Verify an API listing
 */
export async function verifyAPI(listing, metadata) {
  const endpoint = metadata.api_endpoint;
  if (!endpoint) {
    return { success: false, error: 'No endpoint configured' };
  }
  
  const start = Date.now();
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(endpoint, {
      method: metadata.api_method || 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Girandole-Verifier/1.0'
      }
    });
    
    clearTimeout(timeout);
    
    const responseTime = Date.now() - start;
    let isJson = false;
    let sample = null;
    
    try {
      const text = await response.text();
      sample = JSON.parse(text);
      isJson = true;
    } catch {}
    
    return {
      success: response.ok && isJson,
      responseTime,
      statusCode: response.status,
      isJson,
      sample: sample ? JSON.stringify(sample).slice(0, 500) : null
    };
    
  } catch (err) {
    return {
      success: false,
      responseTime: Date.now() - start,
      error: err.message
    };
  }
}

/**
 * Verify an MCP server listing
 */
export async function verifyMCP(listing, metadata) {
  // For MCP servers, we mainly verify the repo/package exists
  // Full MCP handshake would require running the server
  
  if (metadata.mcp_repo_url) {
    try {
      const response = await fetch(metadata.mcp_repo_url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Girandole-Verifier/1.0' }
      });
      
      return {
        success: response.ok,
        verifiedBy: 'repo_exists'
      };
    } catch {
      return { success: false, error: 'Repo not accessible' };
    }
  }
  
  // If npm package, check registry
  if (metadata.mcp_install_command?.includes('npm')) {
    const pkg = metadata.mcp_install_command.replace(/npm install\s+(-g\s+)?/, '').trim();
    try {
      const response = await fetch(`https://registry.npmjs.org/${pkg}`);
      return {
        success: response.ok,
        verifiedBy: 'npm_registry'
      };
    } catch {
      return { success: false, error: 'Package not found' };
    }
  }
  
  return { success: true, verifiedBy: 'manual' };
}

/**
 * Verify a skill listing
 */
export async function verifySkill(listing, metadata) {
  if (!metadata.skill_schema_url) {
    return { success: true, verifiedBy: 'manual' };
  }
  
  try {
    const response = await fetch(metadata.skill_schema_url);
    const content = await response.text();
    
    // Basic validation - has required sections
    const hasUsage = content.includes('## Usage') || content.includes('## Commands');
    const hasTitle = content.startsWith('#');
    
    return {
      success: response.ok && hasTitle,
      hasUsage,
      contentLength: content.length
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Verify a tool listing
 */
export async function verifyTool(listing, metadata) {
  // Check npm registry
  if (metadata.tool_platforms?.includes('npm') && metadata.tool_install_command) {
    const pkg = metadata.tool_install_command.replace(/npm install\s+(-g\s+)?/, '').trim();
    try {
      const response = await fetch(`https://registry.npmjs.org/${pkg}`);
      const data = await response.json();
      
      return {
        success: response.ok,
        latestVersion: data['dist-tags']?.latest,
        verifiedBy: 'npm_registry'
      };
    } catch {
      return { success: false, error: 'Package not found' };
    }
  }
  
  // Check PyPI
  if (metadata.tool_platforms?.includes('pip') && metadata.tool_install_command) {
    const pkg = metadata.tool_install_command.replace('pip install ', '').trim();
    try {
      const response = await fetch(`https://pypi.org/pypi/${pkg}/json`);
      const data = await response.json();
      
      return {
        success: response.ok,
        latestVersion: data.info?.version,
        verifiedBy: 'pypi'
      };
    } catch {
      return { success: false, error: 'Package not found' };
    }
  }
  
  return { success: true, verifiedBy: 'manual' };
}

/**
 * Run verification for a listing
 */
export async function verifyListing(db, listing, metadata) {
  let result;
  
  switch (listing.type) {
    case 'api':
      result = await verifyAPI(listing, metadata);
      break;
    case 'mcp':
      result = await verifyMCP(listing, metadata);
      break;
    case 'skill':
      result = await verifySkill(listing, metadata);
      break;
    case 'tool':
      result = await verifyTool(listing, metadata);
      break;
    default:
      result = { success: true, verifiedBy: 'type_not_checked' };
  }
  
  // Log health check
  await db.query(`
    INSERT INTO health_checks (listing_id, success, response_ms, status_code, error_message, response_sample)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    listing.id,
    result.success,
    result.responseTime || null,
    result.statusCode || null,
    result.error || null,
    result.sample ? JSON.parse(result.sample) : null
  ]);
  
  // Update listing stats
  await updateListingStats(db, listing.id);
  
  return result;
}

/**
 * Update listing stats from health checks
 */
async function updateListingStats(db, listingId) {
  // Calculate uptime and avg response from last 24 hours
  const stats = await db.query(`
    SELECT 
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE success = true)::int as successes,
      AVG(response_ms) FILTER (WHERE success = true)::int as avg_response
    FROM health_checks
    WHERE listing_id = $1 AND checked_at > NOW() - INTERVAL '24 hours'
  `, [listingId]);
  
  const s = stats.rows[0];
  const uptime = s.total > 0 ? (s.successes / s.total) * 100 : null;
  
  // Get current badges
  const listing = await db.query('SELECT badges, created_at FROM listings WHERE id = $1', [listingId]);
  const currentBadges = listing.rows[0]?.badges || [];
  const badges = [...currentBadges];
  
  // Compute badges
  const updateBadge = (badge, condition) => {
    const idx = badges.indexOf(badge);
    if (condition && idx === -1) badges.push(badge);
    if (!condition && idx > -1) badges.splice(idx, 1);
  };
  
  // Verified: at least one successful check
  updateBadge('verified', s.successes > 0);
  
  // Fast: avg response < 500ms
  updateBadge('fast', s.avg_response && s.avg_response < 500);
  
  // Reliable: 99%+ uptime
  updateBadge('reliable', uptime && uptime >= 99);
  
  // Established: 30+ days old
  if (listing.rows[0]?.created_at) {
    const age = Date.now() - new Date(listing.rows[0].created_at).getTime();
    updateBadge('established', age > 30 * 24 * 60 * 60 * 1000);
  }
  
  // Update listing
  await db.query(`
    UPDATE listings SET
      uptime_percent = $1,
      avg_response_ms = $2,
      badges = $3,
      last_check_at = NOW(),
      check_count = check_count + 1,
      status = CASE WHEN $4 > 0 THEN 'active' ELSE status END
    WHERE id = $5
  `, [uptime, s.avg_response, badges, s.successes, listingId]);
}

/**
 * Run verification job for all active listings
 */
export async function runVerificationJob(db, limit = 50) {
  console.log('Running verification job...');
  
  const listings = await db.query(`
    SELECT l.*, m.*
    FROM listings l
    LEFT JOIN listing_metadata m ON l.id = m.listing_id
    WHERE l.status IN ('active', 'pending')
      AND (l.last_check_at IS NULL OR l.last_check_at < NOW() - INTERVAL '1 hour')
    ORDER BY l.last_check_at ASC NULLS FIRST
    LIMIT $1
  `, [limit]);
  
  console.log(`Verifying ${listings.rows.length} listings...`);
  
  let verified = 0;
  let failed = 0;
  
  for (const listing of listings.rows) {
    try {
      const result = await verifyListing(db, listing, listing);
      if (result.success) verified++;
      else failed++;
    } catch (err) {
      console.error(`Error verifying ${listing.id}:`, err.message);
      failed++;
    }
  }
  
  console.log(`Verification complete: ${verified} passed, ${failed} failed`);
  return { verified, failed };
}
