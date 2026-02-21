// Girandole Server - The Agent Economy Platform
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import agentsRoutes from './routes/agents.js';
import listingsRoutes from './routes/listings.js';
import reviewsRoutes from './routes/reviews.js';
import adsRoutes from './routes/ads.js';
import { rateLimit } from './middleware/auth.js';
import { runHealthChecks, computeUniqueAgents } from './services/healthCheck.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

// Configuration
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/girandole';

// Database connection
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Track database status
let dbConnected = false;

// Test database connection (don't exit on failure - allows healthcheck to pass)
db.query('SELECT NOW()')
  .then(() => {
    console.log('✓ Database connected');
    dbConnected = true;
  })
  .catch(err => {
    console.error('✗ Database connection failed:', err.message);
    console.log('Server will continue running - database may connect later');
  });

// Express app
const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow embedding
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit(db, { windowMs: 60000, max: 100 }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production' || duration > 1000) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    database: dbConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString() 
  });
});

// API Routes
app.use('/api/agents', agentsRoutes(db));
app.use('/api/listings', listingsRoutes(db));
app.use('/api/reviews', reviewsRoutes(db));
app.use('/api/ads', adsRoutes(db));

// Legacy registry endpoint (backwards compatible)
app.get('/api/registry.json', async (req, res) => {
  try {
    const { category, q } = req.query;
    
    let query = `
      SELECT 
        l.id, l.type, l.name, l.slug, l.description, l.short_description,
        l.category, l.tags, l.badges, l.pricing_model, l.avg_rating, l.review_count,
        l.uptime_percent, l.avg_response_ms,
        m.api_endpoint, m.api_method, m.api_docs_url
      FROM listings l
      LEFT JOIN listing_metadata m ON l.id = m.listing_id
      WHERE l.status = 'active'
    `;
    const params = [];
    
    if (category) {
      params.push(category);
      query += ` AND l.category = $${params.length}`;
    }
    
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (l.name ILIKE $${params.length} OR l.description ILIKE $${params.length})`;
    }
    
    query += ' ORDER BY l.avg_rating DESC NULLS LAST, l.review_count DESC LIMIT 100';
    
    const result = await db.query(query, params);
    
    // Format for backwards compatibility
    const listings = result.rows.map(l => ({
      id: l.id,
      name: l.name,
      slug: l.slug,
      description: l.description || l.short_description,
      category: l.category,
      type: l.type,
      endpoint: l.api_endpoint,
      method: l.api_method,
      docs: l.api_docs_url,
      badges: l.badges || [],
      rating: l.avg_rating,
      reviews: l.review_count,
      uptime: l.uptime_percent,
      responseTime: l.avg_response_ms,
      pricing: l.pricing_model
    }));
    
    res.json({
      count: listings.length,
      listings,
      updated: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('Registry error:', err);
    res.status(500).json({ error: 'Failed to fetch registry' });
  }
});

// Static files (frontend)
const publicPath = join(__dirname, '..', 'public');
app.use(express.static(publicPath));

// SPA fallback - serve index.html for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(join(publicPath, 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🕯️  Girandole - The Agent Economy Platform          ║
║                                                       ║
║   Server running on http://localhost:${PORT}            ║
║                                                       ║
║   Endpoints:                                          ║
║   • GET  /health              Health check            ║
║   • POST /api/agents/register Create agent            ║
║   • GET  /api/listings        Search listings         ║
║   • POST /api/reviews         Submit review           ║
║   • GET  /api/ads/search      Get sponsored results   ║
║   • GET  /api/registry.json   Legacy registry         ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);
  
  // Start background jobs (only if database connected)
  if (dbConnected) {
    startBackgroundJobs();
  } else {
    // Wait for DB and then start
    const waitForDb = setInterval(() => {
      if (dbConnected) {
        clearInterval(waitForDb);
        startBackgroundJobs();
      }
    }, 5000);
  }
});

// Background jobs
function startBackgroundJobs() {
  console.log('Starting background jobs...');
  
  // Health checks every hour
  setInterval(() => {
    runHealthChecks(db).catch(err => console.error('Health check error:', err));
  }, 60 * 60 * 1000);
  
  // Unique agents computation daily at midnight
  setInterval(() => {
    computeUniqueAgents(db).catch(err => console.error('Unique agents error:', err));
  }, 24 * 60 * 60 * 1000);
  
  // Run immediately on startup
  setTimeout(() => {
    runHealthChecks(db).catch(err => console.error('Health check error:', err));
    computeUniqueAgents(db).catch(err => console.error('Unique agents error:', err));
  }, 10000); // 10 second delay to let things settle
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await db.end();
  process.exit(0);
});

export default app;
