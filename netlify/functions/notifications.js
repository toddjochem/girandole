// Girandole Notifications API
// Agents poll this endpoint to receive notifications

// Load data files via HTTP (since functions can't access static files directly)
async function loadJSON(filename) {
  try {
    const baseUrl = process.env.URL || 'https://girandole.ai';
    const response = await fetch(`${baseUrl}/data/${filename}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (e) {
    console.error(`Error loading ${filename}:`, e);
    return null;
  }
}

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      },
      body: ''
    };
  }

  // Only allow GET
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, message: 'Method not allowed' })
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const apiKey = params.key;

    // Validate API key format
    if (!apiKey) {
      return {
        statusCode: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          success: false, 
          message: 'Missing API key. Use ?key=YOUR_API_KEY',
          example: 'GET /api/notifications?key=gir_xxxxx'
        })
      };
    }

    if (!apiKey.startsWith('gir_')) {
      return {
        statusCode: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          success: false, 
          message: 'Invalid API key format. Keys start with gir_'
        })
      };
    }

    // Load the data files
    const keysData = await loadJSON('api-keys.json');
    const notifsData = await loadJSON('notifications.json');

    if (!keysData || !notifsData) {
      return {
        statusCode: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          success: false, 
          message: 'Server configuration error' 
        })
      };
    }

    // Check if key exists (optional - we can allow unknown keys to still get broadcasts)
    const keyInfo = keysData.keys[apiKey];
    const isKnownKey = !!keyInfo;

    // Filter notifications for this key
    const now = new Date();
    const notifications = notifsData.notifications.filter(notif => {
      // Check if notification is for this key or is a broadcast (*)
      const isTargeted = notif.targetKey === apiKey || notif.targetKey === '*';
      
      // Check if notification has expired
      const isExpired = notif.expiresAt && new Date(notif.expiresAt) < now;
      
      return isTargeted && !isExpired;
    }).map(notif => ({
      id: notif.id,
      type: notif.type,
      priority: notif.priority,
      title: notif.title,
      message: notif.message,
      data: notif.data,
      createdAt: notif.createdAt,
      expiresAt: notif.expiresAt,
      actionUrl: notif.actionUrl,
      actionLabel: notif.actionLabel
    }));

    // Build response
    const response = {
      success: true,
      apiKey: apiKey.substring(0, 12) + '...', // Masked
      keyStatus: isKnownKey ? 'verified' : 'unregistered',
      notifications,
      unreadCount: notifications.length,
      checkedAt: new Date().toISOString(),
      nextCheck: 'Recommended: once per day or at session start'
    };

    // Add key info if known
    if (isKnownKey) {
      response.listing = {
        name: keyInfo.name,
        endpoint: keyInfo.endpoint,
        tier: keyInfo.tier,
        badges: keyInfo.badges
      };
    }

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: JSON.stringify(response)
    };

  } catch (e) {
    console.error('Notifications error:', e);
    return {
      statusCode: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        success: false, 
        message: 'Server error. Please try again.' 
      })
    };
  }
};
