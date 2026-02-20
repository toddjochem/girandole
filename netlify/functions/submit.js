// Girandole Submit API — Auto-verify, generate API key, queue new APIs
const crypto = require('crypto');

// Generate a unique API key
function generateApiKey() {
  const prefix = 'gir_'; // Girandole prefix
  const random = crypto.randomBytes(24).toString('base64url');
  return prefix + random;
}

exports.handler = async (event, context) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, message: 'Method not allowed' })
    };
  }

  try {
    const data = JSON.parse(event.body);
    const { name, endpoint, category, description, contact, webhookUrl } = data;

    // Validate required fields
    if (!name || !endpoint || !category || !description || !contact) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          success: false, 
          message: 'Missing required fields' 
        })
      };
    }

    // Validate endpoint URL
    let url;
    try {
      url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch (e) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          success: false, 
          message: 'Invalid endpoint URL. Must be a valid HTTP/HTTPS URL.' 
        })
      };
    }

    // Validate optional webhook URL
    if (webhookUrl) {
      try {
        const wh = new URL(webhookUrl);
        if (!['http:', 'https:'].includes(wh.protocol)) {
          throw new Error('Invalid protocol');
        }
      } catch (e) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            success: false, 
            message: 'Invalid webhook URL. Must be a valid HTTP/HTTPS URL.' 
          })
        };
      }
    }

    // Auto-verify: Fetch the endpoint and check if it returns valid JSON
    let verified = false;
    let verifyError = null;
    let responseTime = null;
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
      
      const startTime = Date.now();
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { 
          'User-Agent': 'Girandole-Verifier/1.0 (https://girandole.ai)',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      responseTime = Date.now() - startTime;
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        verifyError = `Endpoint returned HTTP ${response.status}`;
      } else {
        const text = await response.text();
        try {
          JSON.parse(text);
          verified = true;
        } catch (e) {
          verifyError = 'Endpoint did not return valid JSON';
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        verifyError = 'Endpoint timed out (>10s)';
      } else {
        verifyError = `Could not reach endpoint: ${e.message}`;
      }
    }

    if (!verified) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          success: false, 
          message: `Verification failed: ${verifyError}. Please ensure your endpoint returns valid JSON.`
        })
      };
    }

    // Generate API key for this submission
    const apiKey = generateApiKey();

    // Notify via webhook (sends to Google Sheet + stores API key)
    const submissionWebhookUrl = process.env.SUBMISSION_WEBHOOK_URL;
    if (submissionWebhookUrl) {
      try {
        await fetch(submissionWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'new_submission',
            timestamp: new Date().toISOString(),
            data: {
              name,
              endpoint,
              category,
              description,
              contact,
              webhookUrl: webhookUrl || '',
              apiKey, // Store the API key
              verified: true,
              responseTime,
              ip: event.headers['x-forwarded-for'] || 'unknown'
            }
          })
        });
      } catch (e) {
        console.error('Webhook notification failed:', e);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: true, 
        message: 'Endpoint verified! Your API has been submitted and will be listed shortly.',
        verified: true,
        apiKey, // Return the API key to the submitter
        data: { name, endpoint, category },
        instructions: {
          checkNotifications: 'GET https://girandole.ai/api/notifications?key=YOUR_API_KEY',
          editListing: 'Coming soon',
          viewAnalytics: 'Coming soon (Pro tier)'
        }
      })
    };

  } catch (e) {
    console.error('Submit error:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        success: false, 
        message: 'Server error. Please try again.' 
      })
    };
  }
};
