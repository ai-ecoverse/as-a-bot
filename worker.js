/**
 * GitHub App Token Broker for ai-aligned-gh
 * 
 * Provides user-to-server GitHub tokens via device flow for proper user attribution.
 * Actions appear as the user (with app badge), not as the bot.
 * 
 * Setup:
 * 1. wrangler secret put GITHUB_CLIENT_ID  # From GitHub App settings
 * 2. wrangler secret put GITHUB_APP_ID      # From GitHub App settings  
 * 3. wrangler secret put GITHUB_APP_PRIVATE_KEY  # From GitHub App settings
 * 4. wrangler deploy
 * 
 * Usage with ai-aligned-gh:
 * The CLI tool will automatically handle the device flow to get user tokens.
 * 
 * Manual testing:
 *    # Start device flow
 *    curl -X POST https://your-worker.workers.dev/user-token/start -d '{"scopes":"repo"}'
 *    # Go to verification_uri and enter user_code
 *    # Poll for token
 *    curl -X POST https://your-worker.workers.dev/user-token/poll -d '{"device_code":"..."}'
 */

import { signJWT } from './jwt-simple.js';








// Handle /user-token/start endpoint
async function handleUserTokenStart(request, env, body) {
  const { scopes, redirect_uri } = body;
  const clientId = env.GITHUB_CLIENT_ID;
  
  if (!clientId) {
    return new Response(JSON.stringify({
      error: 'GitHub Client ID not configured'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // OAuth endpoints are on github.com, not api.github.com
  const url = 'https://github.com/login/device/code';
  
  const params = new URLSearchParams({
    client_id: clientId
  });
  
  // IMPORTANT: For GitHub Apps, we should NOT send scopes
  // GitHub Apps use fine-grained permissions, not OAuth scopes
  // The device flow will create a user-to-server token with the app's permissions
  // Do NOT send scopes parameter - it would break the GitHub App authentication
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error_description || data.error || 'Failed to start device flow');
    }
    
    // Store device code data in KV for polling (if KV is available)
    if (env.DEVICE_CODES) {
      await env.DEVICE_CODES.put(data.device_code, JSON.stringify({
        ...data,
        created_at: Date.now(),
        redirect_uri
      }), {
        expirationTtl: data.expires_in
      });
    } else {
      console.warn('DEVICE_CODES KV namespace not configured - device flow will not persist');
    }
    
    return new Response(JSON.stringify({
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Note: We do NOT exchange user tokens for installation tokens
// User-to-server tokens (ghu_ prefix) maintain user identity with app badge
// Installation tokens (ghs_ prefix) would show actions as from the bot only
// This is intentionally removed to ensure proper user attribution

// Create JWT for GitHub App authentication
async function createAppJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  
  const payload = {
    iat: now - 60,  // Issued 60 seconds ago to account for clock drift
    exp: now + 600, // Expires in 10 minutes
    iss: appId      // Issuer is the app ID
  };
  
  return await signJWT(payload, privateKey);
}

// Handle /user-token/poll endpoint
async function handleUserTokenPoll(request, env, body) {
  const { device_code } = body;
  
  if (!device_code) {
    return new Response(JSON.stringify({
      error: 'device_code is required'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Get device code data from KV (if available)
  if (!env.DEVICE_CODES) {
    return new Response(JSON.stringify({
      error: 'server_error',
      error_description: 'Device flow not configured on this server'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const deviceData = await env.DEVICE_CODES.get(device_code, 'json');
  
  if (!deviceData) {
    return new Response(JSON.stringify({
      error: 'expired_token',
      error_description: 'Device code has expired'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const clientId = env.GITHUB_CLIENT_ID;
  // OAuth endpoints are on github.com, not api.github.com
  const url = 'https://github.com/login/oauth/access_token';
  
  const params = new URLSearchParams({
    client_id: clientId,
    device_code: device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    
    const data = await response.json();
    
    if (data.error) {
      if (data.error === 'authorization_pending') {
        // Still waiting for user authorization
        return new Response(JSON.stringify({
          error: 'authorization_pending',
          error_description: 'User has not yet authorized the request',
          interval: deviceData.interval
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (data.error === 'slow_down') {
        // Client is polling too fast
        return new Response(JSON.stringify({
          error: 'slow_down',
          error_description: 'Polling too frequently',
          interval: deviceData.interval + 5
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Other errors
      return new Response(JSON.stringify({
        error: data.error,
        error_description: data.error_description
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Success - we have a user-to-server token
    // IMPORTANT: Do NOT exchange this for an installation token!
    // User-to-server tokens (ghu_ prefix) maintain user identity with app badge
    // Installation tokens (ghs_ prefix) would lose user attribution
    const finalToken = data.access_token;
    
    // Clean up device code (if KV is available)
    if (env.DEVICE_CODES) {
      await env.DEVICE_CODES.delete(device_code);
    }
    
    // Calculate expiration
    const expiresAt = new Date(Date.now() + (data.expires_in || 28800) * 1000).toISOString();
    const refreshTokenExpiresAt = data.refresh_token_expires_in
      ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
      : null;

    return new Response(JSON.stringify({
      access_token: finalToken,
      token_type: data.token_type || 'bearer',
      expires_at: expiresAt,
      expires_in: data.expires_in || 28800,
      refresh_token: data.refresh_token || null,
      refresh_token_expires_at: refreshTokenExpiresAt,
      scope: data.scope,
      app_attribution: finalToken !== data.access_token // Indicate if we got an installation token
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'server_error',
      error_description: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handle /user-token/refresh endpoint
// GitHub user-to-server tokens expire (8h by default); clients holding the
// refresh token can renew without redoing the device flow.
async function handleUserTokenRefresh(request, env, body) {
  const { refresh_token } = body;

  if (!refresh_token) {
    return new Response(JSON.stringify({
      error: 'refresh_token is required'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({
      error: 'server_error',
      error_description: 'Token refresh not configured on this server'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = 'https://github.com/login/oauth/access_token';

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const data = await response.json();

    if (data.error) {
      return new Response(JSON.stringify({
        error: data.error,
        error_description: data.error_description
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const expiresAt = new Date(Date.now() + (data.expires_in || 28800) * 1000).toISOString();
    const refreshTokenExpiresAt = data.refresh_token_expires_in
      ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
      : null;

    return new Response(JSON.stringify({
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      expires_at: expiresAt,
      expires_in: data.expires_in || 28800,
      // GitHub rotates the refresh token on each use; return the new one.
      refresh_token: data.refresh_token || null,
      refresh_token_expires_at: refreshTokenExpiresAt,
      scope: data.scope
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'server_error',
      error_description: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Import web flow handlers
import webFlow from './worker-web.js';

// Import image upload handlers (gh image)
import { handleImageOffer, handleImageStatus, handleImageServe } from './image-upload.js';

// Import GitHub App webhook handler (auto-installs the image-upload workflow)
import { handleGitHubWebhook } from './app-install.js';

// Main request handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route web flow endpoints to web flow handler
    if (url.pathname.startsWith('/auth/')) {
      return webFlow.fetch(request, env, ctx);
    }

    // Serve uploaded images/videos from R2 (gh image)
    if (url.pathname.startsWith('/i/') && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleImageServe(request, env);
    }

    // Poll endpoint for pending image uploads (gh image)
    if (url.pathname === '/image-upload/status' && request.method === 'GET') {
      return handleImageStatus(request, env);
    }

    // GitHub App webhook (handled before generic body parsing because the
    // signature check needs the raw request body)
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleGitHubWebhook(request, env, ctx);
    }

    // Allow GET for health check
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'GitHub App Token Broker for ai-aligned-gh',
        timestamp: new Date().toISOString(),
        endpoints: {
          '/user-token/start': 'Start device flow (POST)',
          '/user-token/poll': 'Poll device flow (POST)',
          '/user-token/refresh': 'Refresh an expired user token (POST)',
          '/auth/start': 'Start web flow (POST)',
          '/auth/callback': 'OAuth callback (GET)',
          '/auth/poll': 'Poll web flow (POST)',
          '/image-upload/offer': 'Request pre-signed upload URL from workflow (POST, OIDC)',
          '/image-upload/status': 'Poll for pre-signed upload URL (GET)',
          '/i/{owner}/{repo}/{hash}.{ext}': 'Serve uploaded image/video (GET)',
          '/webhook': 'GitHub App webhook: auto-install image-upload workflow (POST)'
        }
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // Only allow POST for other endpoints
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({
        error: 'Method not allowed'
      }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // Parse request body
    let body;
    
    try {
      const rawBody = await request.text();
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'Invalid request body'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // Route requests
    try {
      let response;
      
      switch (url.pathname) {
        case '/user-token/start':
          response = await handleUserTokenStart(request, env, body);
          break;
        
        case '/user-token/poll':
          response = await handleUserTokenPoll(request, env, body);
          break;

        case '/user-token/refresh':
          response = await handleUserTokenRefresh(request, env, body);
          break;

        case '/image-upload/offer':
          response = await handleImageOffer(request, env, body);
          break;

        default:
          response = new Response(JSON.stringify({
            error: 'Not found'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
      }
      
      return response;
    } catch (error) {
      console.error('Request failed:', error);
      return new Response(JSON.stringify({
        error: 'Internal server error'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  }
};