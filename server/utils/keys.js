// API Key Generation and Validation
import crypto from 'crypto';

/**
 * Generate a new API key
 * Format: girnd_sk_{env}_{64 hex chars}
 */
export function generateApiKey(environment = 'live') {
  const random = crypto.randomBytes(32).toString('hex');
  const key = `girnd_sk_${environment}_${random}`;
  const hash = hashApiKey(key);
  const prefix = key.slice(0, 24) + '...';
  
  return { key, hash, prefix };
}

/**
 * Hash an API key for storage
 */
export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Validate API key format
 */
export function validateKeyFormat(key) {
  if (!key || typeof key !== 'string') return false;
  const regex = /^girnd_sk_(live|test)_[a-f0-9]{64}$/;
  return regex.test(key);
}

/**
 * Generate a random token (for email verification, etc.)
 */
export function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hash an IP address for privacy-preserving storage
 */
export function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + process.env.IP_SALT || 'girandole').digest('hex').slice(0, 16);
}

/**
 * Generate a URL-safe slug from a name
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
