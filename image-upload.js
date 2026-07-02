/**
 * Image/video upload brokering for `gh image`.
 *
 * Flow (see docs/image-upload-design.md):
 *  1. A maintainer runs `gh image <file>`, which dispatches the repo's
 *     image-upload workflow with the file's SHA-256 hash and extension.
 *     The workflow is committed automatically when the as-a-bot app is
 *     installed (see app-install.js) and holds no secrets.
 *  2. The workflow calls POST /image-upload/offer with just {hash, ext},
 *     authenticated by a GitHub Actions OIDC token. The worker derives
 *     owner/repo from the token's `repository` claim and mints a
 *     checksum-bound pre-signed R2 PUT URL itself (r2-presign.js) using
 *     R2 credentials that live only as Worker secrets.
 *  3. The client polls GET /image-upload/status until the offer appears,
 *     uploads the file to the pre-signed URL, and embeds the serve URL.
 *  4. GET/HEAD /i/{owner}/{repo}/{hash}.{ext} serves the object from R2
 *     with immutable caching. Uploads expire after 90 days; re-uploading
 *     the same file renews them at the same URL.
 *
 * Bindings: IMAGE_OFFERS (KV, transient offers), IMAGES (R2 bucket).
 * Secrets: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
 * Vars: R2_ACCOUNT_ID, R2_BUCKET, IMAGE_OIDC_AUDIENCE.
 */

import { verifyGitHubActionsToken } from './github-oidc.js';
import { presignR2ImagePut } from './r2-presign.js';

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
const DEFAULT_OFFER_TTL_S = 900;
const MIN_OFFER_TTL_S = 60; // KV minimum expirationTtl
const MAX_OFFER_TTL_S = 3600;
// Uploads are kept for 90 days. Enforced here at serve time (expired
// objects are refused and deleted); pair with an R2 lifecycle rule on the
// bucket so storage is reclaimed even if an object is never requested.
export const UPLOAD_TTL_S = 90 * 24 * 60 * 60;

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
  return validateHashExt(hash, ext);
}

function validateHashExt(hash, ext) {
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
 * Validate an offer payload ({hash, ext, expires_in?}). Returns { error }
 * on failure, or the validated { hash, ext, ttl } on success.
 * Exported for tests.
 */
export function validateOfferPayload(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  const { hash, ext, expires_in } = body;

  const hashExtError = validateHashExt(hash, ext);
  if (hashExtError) {
    return { error: hashExtError };
  }

  let ttl = DEFAULT_OFFER_TTL_S;
  if (expires_in !== undefined) {
    const parsed = Number(expires_in);
    if (!Number.isFinite(parsed)) {
      return { error: 'expires_in must be a number' };
    }
    ttl = Math.min(Math.max(Math.floor(parsed), MIN_OFFER_TTL_S), MAX_OFFER_TTL_S);
  }

  return { hash, ext, ttl };
}

// Handle POST /image-upload/offer (called by the image-upload workflow)
export async function handleImageOffer(request, env, body) {
  if (!env.IMAGE_OFFERS) {
    return jsonResponse({ error: 'Image upload not configured (IMAGE_OFFERS KV missing)' }, 503);
  }
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID || !env.R2_BUCKET) {
    return jsonResponse({ error: 'Image upload not configured (R2 credentials missing)' }, 503);
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
  const { hash, ext, ttl } = payload;

  // The OIDC token is the sole source of truth for which repository is
  // asking — coordinates cannot be spoofed by the request body.
  const repository = claims.repository || '';
  const [owner, repo] = repository.split('/');
  const coordError = validateCoordinates(owner, repo, hash, ext);
  if (coordError) {
    return jsonResponse({
      error: 'invalid_repository_claim',
      error_description: `OIDC repository claim '${repository}' is not usable: ${coordError}`
    }, 403);
  }

  // Mint the pre-signed PUT URL. The checksum is part of the signature, so
  // this URL can only ever upload content whose SHA-256 matches `hash`.
  const key = objectKey(owner, repo, hash, ext);
  const checksumB64 = hexToBase64(hash);
  const uploadUrl = await presignR2ImagePut(env, key, checksumB64, ttl);

  await env.IMAGE_OFFERS.put(`offer:${key}`, JSON.stringify({
    upload_url: uploadUrl,
    upload_headers: { 'x-amz-checksum-sha256': checksumB64 },
    created_at: new Date().toISOString(),
    workflow_run_id: claims.run_id
  }), { expirationTtl: ttl });

  // Only the serve URL goes back to the workflow: the workflow's run logs
  // are readable by anyone with repo read access, so the pre-signed URL
  // must never appear there. The client fetches it from /image-upload/status.
  return jsonResponse({ status: 'ready', serve_url: serveUrlFor(request, key) }, 201);
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

function objectAgeSeconds(objectMeta) {
  if (!objectMeta.uploaded) {
    return 0;
  }
  return (Date.now() - new Date(objectMeta.uploaded).getTime()) / 1000;
}

function isExpired(objectMeta) {
  return objectAgeSeconds(objectMeta) > UPLOAD_TTL_S;
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
  // Only counts if the object would actually be served — same checksum and
  // expiry rules as the serve path; a re-upload overwrites and renews it.
  if (env.IMAGES) {
    const head = await env.IMAGES.head(key);
    if (head && hasVerifiedChecksum(head, hash) && !isExpired(head)) {
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

function serveHeaders(object, ext) {
  // Objects are immutable but expire: cap the cache lifetime at whatever
  // is left of the object's 90 days.
  const remaining = Math.max(0, Math.floor(UPLOAD_TTL_S - objectAgeSeconds(object)));
  const headers = {
    'Content-Type': IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': `public, max-age=${remaining}, immutable`,
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
    if (isExpired(head)) {
      await env.IMAGES.delete(key);
      return new Response(null, { status: 410 });
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

  if (isExpired(object)) {
    await env.IMAGES.delete(key);
    return jsonResponse({
      error: 'expired',
      error_description: `Uploads are kept for ${UPLOAD_TTL_S / 86400} days; re-run gh image to renew this file at the same URL`
    }, 410);
  }

  if (!hasVerifiedChecksum(object, hash)) {
    return jsonResponse({
      error: 'checksum_mismatch',
      error_description: 'Stored object does not carry a verified SHA-256 checksum matching its content-addressed key'
    }, 409);
  }

  return new Response(object.body, { status: 200, headers: serveHeaders(object, ext) });
}
