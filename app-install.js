/**
 * GitHub App installation webhook: when as-a-bot is installed on a
 * repository (or added to more repositories), commit the image-upload
 * workflow to each repo automatically so `gh image` works with zero
 * per-repo setup — no secrets, no manual workflow copying.
 *
 * Requirements on the GitHub App:
 *  - Webhook URL pointing at POST /webhook with GITHUB_WEBHOOK_SECRET set
 *  - Subscribed to "Installation" events
 *  - Repository permissions: Contents (read & write), Workflows (read & write)
 */

import { signJWT } from './jwt-simple.js';
import { IMAGE_UPLOAD_WORKFLOW_PATH, IMAGE_UPLOAD_WORKFLOW_YAML } from './workflow-template.js';

const encoder = new TextEncoder();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// btoa only accepts Latin-1; encode UTF-8 text (the workflow YAML contains
// non-ASCII characters) via its bytes.
function base64EncodeUtf8(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  return timingSafeEqual(`sha256=${bufferToHex(mac)}`, signatureHeader);
}

async function createAppJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ iat: now - 60, exp: now + 600, iss: appId }, privateKey);
}

function githubHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'as-a-bot-worker'
  };
}

async function createInstallationToken(env, installationId) {
  const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const apiBase = env.GITHUB_API || 'https://api.github.com';
  const response = await fetch(`${apiBase}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(jwt)
  });
  if (!response.ok) {
    throw new Error(`Failed to create installation token (status ${response.status})`);
  }
  const data = await response.json();
  return data.token;
}

/**
 * Commit the image-upload workflow to a repository unless it already has
 * one. Returns 'installed', 'exists', or 'error'.
 */
export async function installWorkflowInRepo(env, token, fullName) {
  const apiBase = env.GITHUB_API || 'https://api.github.com';
  const contentsUrl = `${apiBase}/repos/${fullName}/contents/${IMAGE_UPLOAD_WORKFLOW_PATH}`;

  try {
    const existing = await fetch(contentsUrl, { headers: githubHeaders(token) });
    if (existing.status === 200) {
      return 'exists';
    }
    if (existing.status !== 404) {
      throw new Error(`Unexpected status checking for existing workflow: ${existing.status}`);
    }

    const put = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Add image-upload workflow for gh image\n\nInstalled automatically by the as-a-bot app.',
        content: base64EncodeUtf8(IMAGE_UPLOAD_WORKFLOW_YAML)
      })
    });
    if (!put.ok) {
      throw new Error(`Failed to commit workflow (status ${put.status})`);
    }
    return 'installed';
  } catch (error) {
    console.error(`Workflow install failed for ${fullName}: ${error.message}`);
    return 'error';
  }
}

async function installWorkflowInRepos(env, installationId, repositories) {
  let token;
  try {
    token = await createInstallationToken(env, installationId);
  } catch (error) {
    console.error(`Could not create installation token: ${error.message}`);
    return;
  }
  for (const repo of repositories) {
    if (repo && repo.full_name) {
      const result = await installWorkflowInRepo(env, token, repo.full_name);
      console.log(`image-upload workflow for ${repo.full_name}: ${result}`);
    }
  }
}

// Handle POST /webhook (GitHub App webhook endpoint)
export async function handleGitHubWebhook(request, env, ctx) {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return jsonResponse({ error: 'Webhook not configured (GITHUB_WEBHOOK_SECRET missing)' }, 503);
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  if (!(await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature))) {
    return jsonResponse({ error: 'invalid_signature' }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'invalid_payload' }, 400);
  }

  const event = request.headers.get('x-github-event');
  let repositories = [];
  if (event === 'installation' && payload.action === 'created') {
    repositories = payload.repositories || [];
  } else if (event === 'installation_repositories' && payload.action === 'added') {
    repositories = payload.repositories_added || [];
  } else {
    return jsonResponse({ status: 'ignored' });
  }

  const installationId = payload.installation && payload.installation.id;
  if (!installationId || repositories.length === 0) {
    return jsonResponse({ status: 'ignored' });
  }

  const work = installWorkflowInRepos(env, installationId, repositories);
  if (ctx && typeof ctx.waitUntil === 'function') {
    // Respond to GitHub immediately; the commits happen in the background
    ctx.waitUntil(work);
  } else {
    await work;
  }

  return jsonResponse({ status: 'accepted', repositories: repositories.length }, 202);
}
