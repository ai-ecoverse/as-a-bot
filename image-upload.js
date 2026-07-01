/**
 * Image/video upload brokering for `gh image`.
 *
 * Flow (see docs/image-upload-design.md):
 *  1. A maintainer runs `gh image <file>`, which dispatches the repo's
 *     image-upload workflow with the file's SHA-256 hash and extension.
 *  2. The workflow pre-signs a checksum-bound R2 PUT URL and registers it
 *     here via POST /image-upload/offer, authenticated with a GitHub
 *     Actions OIDC token whose `repository` claim must match the offer.
 *  3. The client polls GET /image-upload/status until the offer appears,
 *     uploads the file to the pre-signed URL, and embeds the serve URL.
 *  4. GET/HEAD /i/{owner}/{repo}/{hash}.{ext} serves the object from R2
 *     with immutable caching.
 *
 * Bindings: IMAGE_OFFERS (KV, transient offers), IMAGES (R2 bucket).
 */

import { verifyGitHubActionsToken } from './github-oidc.js';

export const IMAGE_CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm'
};

const DEFAULT_OIDC_AUDIENCE = 'as-a-bot-images';
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SERVE_PATH_PATTERN = /^\/i\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([a-f0-9]{64})\.([a-z0-9]+)$/;
// Pre-signed URLs must point at R2's S3 endpoint — never accept an
// arbitrary upload destination from the workflow.
const UPLOAD_HOST_SUFFIX = '.r2.cloudflarestorage.com';
const DEFAULT_OFFER_TTL_S = 900;
const MIN_OFFER_TTL_S = 60; // KV minimum expirationTtl
const MAX_OFFER_TTL_S = 3600;
const MAX_UPLOAD_HEADERS = 8;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function validateCoordinates(owner, repo, hash, ext) {
  if (!owner || !NAME_PATTERN.test(owner)) {
    return 'Invalid or missing owner';
  }
  if (!repo || !NAME_PATTERN.test(repo)) {
    return 'Invalid or missing repo';
  }
  if (!hash || !HASH_PATTERN.test(hash)) {
    return 'Invalid or missing hash (expected 64 lowercase hex chars)';
  }
  if (!ext || !Object.prototype.hasOwnProperty.call(IMAGE_CONTENT_TYPES, ext)) {
    return `Invalid or missing ext (allowed: ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')})`;
  }
  return null;
}

function objectKey(owner, repo, hash, ext) {
  return `${owner}/${repo}/${hash}.${ext}`;
}

function serveUrlFor(request, key) {
  return `${new URL(request.url).origin}/i/${key}`;
}

// Handle POST /image-upload/offer (called by the image-upload workflow)
export async function handleImageOffer(request, env, body) {
  if (!env.IMAGE_OFFERS) {
    return jsonResponse({ error: 'Image upload not configured (IMAGE_OFFERS KV missing)' }, 503);
  }

  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'unauthorized', error_description: 'Missing Bearer token' }, 401);
  }

  let claims;
  try {
    claims = await verifyGitHubActionsToken(
      authHeader.slice('Bearer '.length).trim(),
      env.IMAGE_OIDC_AUDIENCE || DEFAULT_OIDC_AUDIENCE
    );
  } catch (error) {
    return jsonResponse({ error: 'invalid_oidc_token', error_description: error.message }, 401);
  }

  const { owner, repo, hash, ext, upload_url, upload_headers, expires_in } = body;

  const validationError = validateCoordinates(owner, repo, hash, ext);
  if (validationError) {
    return jsonResponse({ error: 'invalid_request', error_description: validationError }, 400);
  }

  // The OIDC token proves which repository's workflow is calling; it must
  // match the coordinates it is offering an upload URL for.
  if ((claims.repository || '').toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    return jsonResponse({
      error: 'repository_mismatch',
      error_description: `OIDC token was issued for '${claims.repository}', not '${owner}/${repo}'`
    }, 403);
  }

  let uploadUrl;
  try {
    uploadUrl = new URL(upload_url);
  } catch {
    return jsonResponse({ error: 'invalid_request', error_description: 'upload_url is not a valid URL' }, 400);
  }
  if (uploadUrl.protocol !== 'https:' || !uploadUrl.hostname.endsWith(UPLOAD_HOST_SUFFIX)) {
    return jsonResponse({
      error: 'invalid_request',
      error_description: `upload_url must be an https URL on *${UPLOAD_HOST_SUFFIX}`
    }, 400);
  }

  const headers = {};
  if (upload_headers !== undefined) {
    if (typeof upload_headers !== 'object' || upload_headers === null || Array.isArray(upload_headers)) {
      return jsonResponse({ error: 'invalid_request', error_description: 'upload_headers must be an object' }, 400);
    }
    const entries = Object.entries(upload_headers);
    if (entries.length > MAX_UPLOAD_HEADERS) {
      return jsonResponse({ error: 'invalid_request', error_description: 'Too many upload_headers' }, 400);
    }
    for (const [name, value] of entries) {
      if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== 'string') {
        return jsonResponse({ error: 'invalid_request', error_description: `Invalid upload header: ${name}` }, 400);
      }
      headers[name.toLowerCase()] = value;
    }
  }

  let ttl = DEFAULT_OFFER_TTL_S;
  if (expires_in !== undefined) {
    const parsed = Number(expires_in);
    if (!Number.isFinite(parsed)) {
      return jsonResponse({ error: 'invalid_request', error_description: 'expires_in must be a number' }, 400);
    }
    ttl = Math.min(Math.max(Math.floor(parsed), MIN_OFFER_TTL_S), MAX_OFFER_TTL_S);
  }

  const key = objectKey(owner, repo, hash, ext);
  await env.IMAGE_OFFERS.put(`offer:${key}`, JSON.stringify({
    upload_url,
    upload_headers: headers,
    created_at: new Date().toISOString(),
    workflow_run_id: claims.run_id
  }), { expirationTtl: ttl });

  return jsonResponse({ status: 'ready', serve_url: serveUrlFor(request, key) }, 201);
}

// Handle GET /image-upload/status?owner=&repo=&hash=&ext= (polled by gh image)
export async function handleImageStatus(request, env) {
  const url = new URL(request.url);
  const owner = url.searchParams.get('owner');
  const repo = url.searchParams.get('repo');
  const hash = url.searchParams.get('hash');
  const ext = url.searchParams.get('ext');

  const validationError = validateCoordinates(owner, repo, hash, ext);
  if (validationError) {
    return jsonResponse({ error: 'invalid_request', error_description: validationError }, 400);
  }

  const key = objectKey(owner, repo, hash, ext);
  const serveUrl = serveUrlFor(request, key);

  // Already uploaded (content-addressed, so this is also the dedupe path)
  if (env.IMAGES) {
    const head = await env.IMAGES.head(key);
    if (head) {
      return jsonResponse({ status: 'uploaded', serve_url: serveUrl });
    }
  }

  if (!env.IMAGE_OFFERS) {
    return jsonResponse({ error: 'Image upload not configured (IMAGE_OFFERS KV missing)' }, 503);
  }

  const offer = await env.IMAGE_OFFERS.get(`offer:${key}`, 'json');
  if (offer) {
    return jsonResponse({
      status: 'ready',
      upload_url: offer.upload_url,
      upload_headers: offer.upload_headers || {},
      serve_url: serveUrl
    });
  }

  return jsonResponse({ status: 'pending' }, 202);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function serveHeaders(object, ext) {
  const headers = {
    'Content-Type': IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    // Defense against active content (mainly SVG): never sniff, never execute
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
  };
  if (object.httpEtag) {
    headers['ETag'] = object.httpEtag;
  }
  return headers;
}

// Handle GET/HEAD /i/{owner}/{repo}/{hash}.{ext}
export async function handleImageServe(request, env) {
  if (!env.IMAGES) {
    return jsonResponse({ error: 'Image serving not configured (IMAGES R2 binding missing)' }, 503);
  }

  const match = new URL(request.url).pathname.match(SERVE_PATH_PATTERN);
  if (!match) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  const [, owner, repo, hash, ext] = match;
  if (!Object.prototype.hasOwnProperty.call(IMAGE_CONTENT_TYPES, ext)) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  const key = objectKey(owner, repo, hash, ext);

  if (request.method === 'HEAD') {
    const head = await env.IMAGES.head(key);
    if (!head) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 200, headers: serveHeaders(head, ext) });
  }

  const object = await env.IMAGES.get(key);
  if (!object) {
    return jsonResponse({ error: 'not_found' }, 404);
  }

  // Content-addressed integrity: the stored SHA-256 checksum (bound into the
  // pre-signed PUT) must match the hash in the key, or we refuse to serve.
  const storedChecksum = object.checksums && object.checksums.sha256;
  if (storedChecksum && bufferToHex(storedChecksum) !== hash) {
    return jsonResponse({
      error: 'checksum_mismatch',
      error_description: 'Stored object does not match its content-addressed key'
    }, 409);
  }

  return new Response(object.body, { status: 200, headers: serveHeaders(object, ext) });
}
