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

function hexToBase64(hex) {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

/**
 * Validate an offer payload. Returns { error } on failure, or the validated
 * { owner, repo, hash, ext, uploadUrl, uploadHeaders, ttl } on success.
 * Exported for tests.
 */
export function validateOfferPayload(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  const { owner, repo, hash, ext, upload_url, upload_headers, expires_in } = body;

  const coordError = validateCoordinates(owner, repo, hash, ext);
  if (coordError) {
    return { error: coordError };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(upload_url);
  } catch {
    return { error: 'upload_url is not a valid URL' };
  }
  if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith(UPLOAD_HOST_SUFFIX)) {
    return { error: `upload_url must be an https URL on *${UPLOAD_HOST_SUFFIX}` };
  }

  if (typeof upload_headers !== 'object' || upload_headers === null || Array.isArray(upload_headers)) {
    return { error: 'upload_headers must be an object' };
  }
  const entries = Object.entries(upload_headers);
  if (entries.length > MAX_UPLOAD_HEADERS) {
    return { error: 'Too many upload_headers' };
  }
  const uploadHeaders = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== 'string') {
      return { error: `Invalid upload header: ${name}` };
    }
    uploadHeaders[name.toLowerCase()] = value;
  }

  // The security model requires every pre-signed URL to be bound to the
  // offered content hash: the uploader must send x-amz-checksum-sha256 with
  // exactly this value, and (because x-amz-* headers must be signed) an URL
  // that was not signed for it will be rejected by R2. Refuse offers that
  // don't carry the binding.
  const expectedChecksum = hexToBase64(hash);
  if (uploadHeaders['x-amz-checksum-sha256'] !== expectedChecksum) {
    return { error: 'upload_headers must include x-amz-checksum-sha256 set to the base64 encoding of hash' };
  }

  let ttl = DEFAULT_OFFER_TTL_S;
  if (expires_in !== undefined) {
    const parsed = Number(expires_in);
    if (!Number.isFinite(parsed)) {
      return { error: 'expires_in must be a number' };
    }
    ttl = Math.min(Math.max(Math.floor(parsed), MIN_OFFER_TTL_S), MAX_OFFER_TTL_S);
  }

  return { owner, repo, hash, ext, uploadUrl: upload_url, uploadHeaders, ttl };
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

  const payload = validateOfferPayload(body);
  if (payload.error) {
    return jsonResponse({ error: 'invalid_request', error_description: payload.error }, 400);
  }
  const { owner, repo, hash, ext, uploadUrl, uploadHeaders, ttl } = payload;

  // The OIDC token proves which repository's workflow is calling; it must
  // match the coordinates it is offering an upload URL for.
  if ((claims.repository || '').toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    return jsonResponse({
      error: 'repository_mismatch',
      error_description: `OIDC token was issued for '${claims.repository}', not '${owner}/${repo}'`
    }, 403);
  }

  const key = objectKey(owner, repo, hash, ext);
  await env.IMAGE_OFFERS.put(`offer:${key}`, JSON.stringify({
    upload_url: uploadUrl,
    upload_headers: uploadHeaders,
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

  // Already uploaded (content-addressed, so this is also the dedupe path).
  // Only counts if the object would actually be served — same checksum rule
  // as the serve path; a re-upload overwrites an unverifiable object.
  if (env.IMAGES) {
    const head = await env.IMAGES.head(key);
    if (head && hasVerifiedChecksum(head, hash)) {
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

// Content-addressed integrity: an object is only serveable when it carries
// the SHA-256 checksum R2 recorded at upload time (bound into the pre-signed
// PUT) and it matches the hash in the key. Objects without a checksum (e.g.
// written out-of-band without ChecksumSHA256) are refused rather than served
// unverified — the immutable-URL guarantee depends on this.
function hasVerifiedChecksum(objectMeta, hash) {
  const stored = objectMeta.checksums && objectMeta.checksums.sha256;
  return Boolean(stored) && bufferToHex(stored) === hash;
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
    if (!hasVerifiedChecksum(head, hash)) {
      return new Response(null, { status: 409 });
    }
    return new Response(null, { status: 200, headers: serveHeaders(head, ext) });
  }

  const object = await env.IMAGES.get(key);
  if (!object) {
    return jsonResponse({ error: 'not_found' }, 404);
  }

  if (!hasVerifiedChecksum(object, hash)) {
    return jsonResponse({
      error: 'checksum_mismatch',
      error_description: 'Stored object does not carry a verified SHA-256 checksum matching its content-addressed key'
    }, 409);
  }

  return new Response(object.body, { status: 200, headers: serveHeaders(object, ext) });
}
