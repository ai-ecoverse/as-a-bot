/**
 * Serving for objects uploaded by the retired `gh image` flow.
 *
 * The upload brokering (POST /image-upload/offer, GET /image-upload/status,
 * the pre-signed R2 URLs and the OIDC trust boundary) is retired — gh 2.99.0
 * uploads media natively via `--attach` (see retired.js and
 * docs/image-upload-design.md, kept for historical reference).
 *
 * What remains is the read path, so images already embedded in existing PRs
 * and issues keep resolving until the bucket's 90-day retention lapses:
 *
 *  - GET/HEAD /i/{owner}/{repo}/{hash}.{ext} on the worker host,
 *  - GET/HEAD /{hash}.{ext} on repo--owner.<IMAGE_SERVE_DOMAIN>.
 *
 * Bindings: IMAGES (R2 bucket). Vars: IMAGE_SERVE_DOMAIN.
 */

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

const SERVE_PATH_PATTERN = /^\/i\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([a-f0-9]{64})\.([a-z0-9]+)$/;
// Uploads are kept for 90 days. Enforced here at serve time (expired
// objects are refused and deleted); pair with an R2 lifecycle rule on the
// bucket so storage is reclaimed even if an object is never requested.
export const UPLOAD_TTL_S = 90 * 24 * 60 * 60;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

// Keys are lowercased: GitHub owner/repo names are case-insensitively
// unique, and the wildcard serve hostnames (DNS) are always lowercase.
function objectKey(owner, repo, hash, ext) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}/${hash}.${ext}`;
}

// A hostname label must be [a-z0-9-], no leading/trailing hyphen, <= 63
// chars. GitHub owner names always qualify; repo names may not (dots,
// underscores) — those repos fall back to path-based serve URLs.
const HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True when the request hostname belongs to the configured serve domain
 * (the apex or any subdomain). Used to fence the serve domain off from
 * the API: hosts under it only ever serve images.
 */
export function isImageServeHost(hostname, env) {
  const domain = (env.IMAGE_SERVE_DOMAIN || '').toLowerCase();
  if (!domain) {
    return false;
  }
  const host = (hostname || '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Parse `repo--owner.<domain>` into coordinates. Owner names cannot
 * contain consecutive hyphens (GitHub rule), so the LAST `--` in the
 * label is always the separator even when the repo name contains `--`.
 * Returns { owner, repo } or null.
 */
export function coordinatesFromHost(hostname, env) {
  const domain = (env.IMAGE_SERVE_DOMAIN || '').toLowerCase();
  if (!domain) {
    return null;
  }
  const host = (hostname || '').toLowerCase();
  if (!host.endsWith(`.${domain}`)) {
    return null;
  }
  const label = host.slice(0, -(domain.length + 1));
  // The label must be a single, well-formed DNS hostname label — this is
  // derived from the Host header, so validate before splitting.
  if (!label || label.includes('.') || !HOST_LABEL_PATTERN.test(label)) {
    return null;
  }
  const separator = label.lastIndexOf('--');
  if (separator <= 0 || separator + 2 >= label.length) {
    return null;
  }
  return { owner: label.slice(separator + 2), repo: label.slice(0, separator) };
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

function serveHeaders(object, ext, partial) {
  // Objects are immutable but expire: cap the cache lifetime at whatever
  // is left of the object's 90 days.
  const remaining = Math.max(0, Math.floor(UPLOAD_TTL_S - objectAgeSeconds(object)));
  const headers = {
    'Content-Type': IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': `public, max-age=${remaining}, immutable`,
    // Media players — notably Safari/AVFoundation, which backs <video> on
    // macOS and iOS — refuse a source whose origin does not demonstrably
    // support byte ranges, so this must be advertised on every response.
    'Accept-Ranges': 'bytes',
    // Defense against active content (mainly SVG): never sniff, never execute
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
  };
  if (object.httpEtag) {
    headers['ETag'] = object.httpEtag;
  }
  if (partial) {
    const { offset, length } = partial;
    headers['Content-Length'] = String(length);
    headers['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${object.size}`;
  }
  return headers;
}

// Handle GET/HEAD /i/{owner}/{repo}/{hash}.{ext} on the worker host, and
// GET/HEAD /{hash}.{ext} on the wildcard serve domain (repo--owner.<domain>)
export async function handleImageServe(request, env) {
  if (!env.IMAGES) {
    return jsonResponse({ error: 'Image serving not configured (IMAGES R2 binding missing)' }, 503);
  }

  const url = new URL(request.url);
  let owner, repo, hash, ext;

  const hostCoordinates = coordinatesFromHost(url.hostname, env);
  if (hostCoordinates) {
    const match = url.pathname.match(/^\/([a-f0-9]{64})\.([a-z0-9]+)$/);
    if (!match) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    ({ owner, repo } = hostCoordinates);
    [, hash, ext] = match;
  } else {
    const match = url.pathname.match(SERVE_PATH_PATTERN);
    if (!match) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    [, owner, repo, hash, ext] = match;
  }
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

  // Byte ranges are requested from R2 directly rather than sliced here, so a
  // seek never pulls the whole object out of storage.
  const rangeHeader = request.headers.get('range');
  let object;
  try {
    object = await env.IMAGES.get(key, rangeHeader ? { range: request.headers } : undefined);
  } catch {
    // R2 rejects an unsatisfiable range. Answer per RFC 9110 §15.5.17 rather
    // than surfacing a 500.
    const head = await env.IMAGES.head(key);
    if (!head) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${head.size}`, 'Accept-Ranges': 'bytes' }
    });
  }
  if (!object) {
    return jsonResponse({ error: 'not_found' }, 404);
  }

  if (isExpired(object)) {
    await env.IMAGES.delete(key);
    return jsonResponse({
      error: 'expired',
      error_description: `Uploads were kept for ${UPLOAD_TTL_S / 86400} days and this one has expired. gh image is retired — use gh --attach (gh >= 2.99.0) to attach media directly to GitHub.`
    }, 410);
  }

  if (!hasVerifiedChecksum(object, hash)) {
    return jsonResponse({
      error: 'checksum_mismatch',
      error_description: 'Stored object does not carry a verified SHA-256 checksum matching its content-addressed key'
    }, 409);
  }

  const partial = rangeHeader && object.range ? object.range : null;
  return new Response(object.body, {
    status: partial ? 206 : 200,
    headers: serveHeaders(object, ext, partial)
  });
}
