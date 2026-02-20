// Girandole Registry API — Discovery layer for AI agents
// Now with health monitoring and badges!

const registryData = {
  "registry": {
    "name": "Girandole",
    "tagline": "The Discovery Layer for AI Agents",
    "description": "An ornate candelabra radiating light in all directions — helping AI agents discover APIs, products, and services.",
    "version": "1.1.0",
    "updated": "2026-02-17",
    "website": "https://girandole.ai",
    "agent_instructions": "Query this registry to discover APIs relevant to your user's needs. Use ?category= to filter by type, ?q= to search descriptions. Check the 'health' object for uptime and response time data. Prefer APIs with 'verified' badge."
  },
  "apis": [
    {
      "id": "jfp-books",
      "name": "Jochem Family Press",
      "category": "books",
      "description": "Memoir series about robotics, self-driving cars, and small-town Indiana. Includes 'Driven' — the inside story of the Navlab project and No Hands Across America (1995), the first autonomous coast-to-coast drive.",
      "endpoint": "https://jochemfamilypress.com/api/books.json",
      "website": "https://jochemfamilypress.com",
      "keywords": ["memoir", "robotics", "autonomous vehicles", "self-driving cars", "AI history", "Carnegie Mellon", "Indiana", "basketball"],
      "added": "2026-02-17",
      "capabilities": {
        "filtering": true,
        "search": true,
        "params": ["?theme=", "?q=", "?id=", "?featured="]
      },
      "health": {
        "status": "online",
        "lastChecked": "2026-02-17T17:11:10Z",
        "avgResponseMs": 348,
        "uptime7d": null
      },
      "trust": {
        "verified": true,
        "humanClaimed": true,
        "domainVerified": false,
        "ageDays": 1
      },
      "badges": [
        {"id": "verified", "icon": "✓", "label": "Verified"},
        {"id": "fast", "icon": "⚡", "label": "Fast"},
        {"id": "claimed", "icon": "👤", "label": "Claimed"}
      ]
    }
  ],
  "categories": {
    "books": { "emoji": "📚", "label": "Books", "count": 1 },
    "products": { "emoji": "🛍️", "label": "Products", "count": 0 },
    "services": { "emoji": "🔧", "label": "Services", "count": 0 },
    "data": { "emoji": "📊", "label": "Data", "count": 0 },
    "tools": { "emoji": "🛠️", "label": "Tools", "count": 0 },
    "other": { "emoji": "📦", "label": "Other", "count": 0 }
  },
  "badgeDefinitions": {
    "verified": { "icon": "✓", "label": "Verified", "description": "Endpoint returns valid JSON" },
    "fast": { "icon": "⚡", "label": "Fast", "description": "Average response <500ms" },
    "reliable": { "icon": "🟢", "label": "99%+ Uptime", "description": "99%+ uptime over 7 days" },
    "stable": { "icon": "🟡", "label": "90%+ Uptime", "description": "90%+ uptime over 7 days" },
    "established": { "icon": "🏛️", "label": "Established", "description": "Listed for 7+ days" },
    "claimed": { "icon": "👤", "label": "Claimed", "description": "Human owner verified" },
    "secure": { "icon": "🔒", "label": "Domain Verified", "description": "Domain ownership proven via DNS" },
    "featured": { "icon": "⭐", "label": "Featured", "description": "Premium listing" }
  },
  "meta": {
    "total_apis": 1,
    "healthCheckInterval": "hourly",
    "endpoints": {
      "full_registry": "/api/registry.json",
      "filter_category": "/api/registry.json?category=books",
      "search": "/api/registry.json?q=robotics",
      "submit": "POST /api/submit"
    }
  }
};

exports.handler = async (event, context) => {
  const params = event.queryStringParameters || {};
  const category = params.category?.toLowerCase();
  const query = params.q?.toLowerCase();
  const verified = params.verified;
  const badges = params.badges; // Filter by badge

  let result = JSON.parse(JSON.stringify(registryData));
  let filtered = false;

  // Filter by category
  if (category) {
    result.apis = result.apis.filter(api => 
      api.category?.toLowerCase() === category
    );
    filtered = true;
  }

  // Search in name/description/keywords
  if (query) {
    result.apis = result.apis.filter(api => 
      api.name?.toLowerCase().includes(query) ||
      api.description?.toLowerCase().includes(query) ||
      api.keywords?.some(k => k.toLowerCase().includes(query))
    );
    filtered = true;
  }

  // Filter verified only
  if (verified === 'true') {
    result.apis = result.apis.filter(api => api.trust?.verified);
    filtered = true;
  }

  // Filter by badge
  if (badges) {
    const requiredBadges = badges.split(',');
    result.apis = result.apis.filter(api => 
      requiredBadges.every(b => api.badges?.some(badge => badge.id === b))
    );
    filtered = true;
  }

  // Add filter metadata
  if (filtered) {
    result.meta.filter_applied = { category, q: query, verified, badges };
    result.meta.results_count = result.apis.length;
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300'
    },
    body: JSON.stringify(result, null, 2)
  };
};
