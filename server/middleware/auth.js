// Authentication Middleware
import { hashApiKey, validateKeyFormat } from '../utils/keys.js';

/**
 * Require API key authentication
 */
export function authenticateAgent(db) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Missing authorization header',
        hint: 'Include "Authorization: Bearer girnd_sk_..." header'
      });
    }
    
    const apiKey = authHeader.slice(7);
    
    if (!validateKeyFormat(apiKey)) {
      return res.status(401).json({ error: 'Invalid API key format' });
    }
    
    const keyHash = hashApiKey(apiKey);
    
    try {
      const result = await db.query(
        'SELECT * FROM agents WHERE api_key_hash = $1 AND status = $2',
        [keyHash, 'active']
      );
      
      if (!result.rows[0]) {
        return res.status(401).json({ error: 'Invalid or inactive API key' });
      }
      
      // Update last active
      db.query(
        'UPDATE agents SET last_active_at = NOW() WHERE id = $1',
        [result.rows[0].id]
      ).catch(() => {}); // Fire and forget
      
      req.agent = result.rows[0];
      next();
    } catch (err) {
      console.error('Auth error:', err);
      return res.status(500).json({ error: 'Authentication failed' });
    }
  };
}

/**
 * Optional authentication - attaches agent if present, continues otherwise
 */
export function optionalAuth(db) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.agent = null;
      return next();
    }
    
    const apiKey = authHeader.slice(7);
    
    if (!validateKeyFormat(apiKey)) {
      req.agent = null;
      return next();
    }
    
    const keyHash = hashApiKey(apiKey);
    
    try {
      const result = await db.query(
        'SELECT * FROM agents WHERE api_key_hash = $1 AND status = $2',
        [keyHash, 'active']
      );
      
      req.agent = result.rows[0] || null;
      next();
    } catch (err) {
      req.agent = null;
      next();
    }
  };
}

/**
 * Require a specific verification level
 */
export function requireVerification(level) {
  const levels = { basic: 1, verified: 2, crypto: 3 };
  
  return (req, res, next) => {
    if (!req.agent) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const agentLevel = levels[req.agent.verification_level] || 0;
    const requiredLevel = levels[level] || 0;
    
    if (agentLevel < requiredLevel) {
      return res.status(403).json({ 
        error: `Verification level '${level}' required`,
        current: req.agent.verification_level,
        hint: level === 'verified' 
          ? 'Verify your email to unlock this feature'
          : 'Connect a wallet to unlock this feature'
      });
    }
    
    next();
  };
}

/**
 * Require advertiser status
 */
export function requireAdvertiser(req, res, next) {
  if (!req.agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!req.agent.is_advertiser) {
    return res.status(403).json({ 
      error: 'Advertiser account required',
      hint: 'Deposit funds to become an advertiser'
    });
  }
  
  next();
}

/**
 * Simple rate limiting by agent or IP
 */
export function rateLimit(db, { windowMs = 60000, max = 60 } = {}) {
  const requests = new Map();
  
  // Clean up old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of requests) {
      if (now - data.start > windowMs) {
        requests.delete(key);
      }
    }
  }, windowMs);
  
  return (req, res, next) => {
    const key = req.agent?.id || req.ip;
    const now = Date.now();
    
    let data = requests.get(key);
    
    if (!data || now - data.start > windowMs) {
      data = { start: now, count: 0 };
      requests.set(key, data);
    }
    
    data.count++;
    
    if (data.count > max) {
      return res.status(429).json({ 
        error: 'Too many requests',
        retryAfter: Math.ceil((data.start + windowMs - now) / 1000)
      });
    }
    
    next();
  };
}
