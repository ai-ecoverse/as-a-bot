import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleImageOffer,
  handleImageStatus,
  handleImageServe,
  validateOfferPayload,
  coordinatesFromHost,
  isImageServeHost,
  IMAGE_CONTENT_TYPES,
  UPLOAD_TTL_S
} from './image-upload.js';

// Node 18+ provides Request/Response/Headers/URL natively — no polyfills needed.

const HASH = 'a'.repeat(64);
const NOW = Date.now();
const EXPIRED_UPLOAD_DATE = new Date(NOW - (UPLOAD_TTL_S + 3600) * 1000);

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, options) {
      store.set(key, value);
      this.lastPutOptions = options;
    }
  };
}

function makeR2(objects = {}) {
  return {
    objects,
    deleted: [],
    async head(key) {
      const obj = objects[key];
      return obj
        ? { size: obj.size, httpEtag: obj.httpEtag, checksums: obj.checksums, uploaded: obj.uploaded }
        : null;
    },
    async get(key) {
      const obj = objects[key];
      return obj
        ? { body: obj.body, size: obj.size, httpEtag: obj.httpEtag, checksums: obj.checksums, uploaded: obj.uploaded }
        : null;
    },
    async delete(key) {
      this.deleted.push(key);
      delete objects[key];
    }
  };
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_BUCKET: 'as-a-bot-images',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret'
};

describe('handleImageOffer', () => {
  test('rejects requests without a Bearer token', async () => {
    const request = new Request('https://worker.example/image-upload/offer', { method: 'POST' });
    const response = await handleImageOffer(request, { IMAGE_OFFERS: makeKV(), ...R2_ENV }, {});
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'unauthorized');
  });

  test('rejects malformed OIDC tokens', async () => {
    const request = new Request('https://worker.example/image-upload/offer', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-jwt' }
    });
    const response = await handleImageOffer(request, { IMAGE_OFFERS: makeKV(), ...R2_ENV }, {});
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'invalid_oidc_token');
  });

  test('returns 503 when the KV binding is missing', async () => {
    const request = new Request('https://worker.example/image-upload/offer', { method: 'POST' });
    const response = await handleImageOffer(request, { ...R2_ENV }, {});
    assert.equal(response.status, 503);
  });

  test('returns 503 when R2 credentials are missing', async () => {
    const request = new Request('https://worker.example/image-upload/offer', { method: 'POST' });
    const response = await handleImageOffer(request, { IMAGE_OFFERS: makeKV() }, {});
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /R2 credentials/);
  });
});

describe('validateOfferPayload', () => {
  test('accepts a valid payload', () => {
    const result = validateOfferPayload({ hash: HASH, ext: 'png', expires_in: 900 });
    assert.equal(result.error, undefined);
    assert.equal(result.hash, HASH);
    assert.equal(result.ext, 'png');
    assert.equal(result.ttl, 900);
  });

  test('rejects non-object bodies', () => {
    assert.ok(validateOfferPayload(null).error);
    assert.ok(validateOfferPayload([]).error);
    assert.ok(validateOfferPayload('str').error);
  });

  test('rejects bad hashes and extensions', () => {
    assert.match(validateOfferPayload({ hash: 'short', ext: 'png' }).error, /hash/);
    assert.match(validateOfferPayload({ hash: HASH.toUpperCase(), ext: 'png' }).error, /hash/);
    assert.match(validateOfferPayload({ hash: HASH, ext: 'exe' }).error, /ext/);
  });

  test('clamps expires_in into the allowed TTL range', () => {
    assert.equal(validateOfferPayload({ hash: HASH, ext: 'png', expires_in: 5 }).ttl, 60);
    assert.equal(validateOfferPayload({ hash: HASH, ext: 'png', expires_in: 99999 }).ttl, 3600);
    assert.ok(validateOfferPayload({ hash: HASH, ext: 'png', expires_in: 'soon' }).error);
  });
});

describe('handleImageStatus', () => {
  const baseUrl = 'https://worker.example/image-upload/status';
  const params = `owner=octo&repo=demo&hash=${HASH}&ext=png`;

  test('validates coordinates', async () => {
    const request = new Request(`${baseUrl}?owner=octo&repo=demo&hash=nope&ext=png`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: makeR2() });
    assert.equal(response.status, 400);
  });

  test('rejects disallowed extensions', async () => {
    const request = new Request(`${baseUrl}?owner=octo&repo=demo&hash=${HASH}&ext=exe`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: makeR2() });
    assert.equal(response.status, 400);
  });

  test('returns pending when no offer exists', async () => {
    const request = new Request(`${baseUrl}?${params}`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: makeR2() });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, 'pending');
  });

  test('returns the offer when one is registered', async () => {
    const offer = {
      upload_url: 'https://acc.r2.cloudflarestorage.com/bucket/octo/demo/x.png?sig=1',
      upload_headers: { 'x-amz-checksum-sha256': 'abc=' }
    };
    const kv = makeKV({ [`offer:octo/demo/${HASH}.png`]: JSON.stringify(offer) });
    const request = new Request(`${baseUrl}?${params}`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: kv, IMAGES: makeR2() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.upload_url, offer.upload_url);
    assert.deepEqual(body.upload_headers, offer.upload_headers);
    assert.equal(body.serve_url, `https://worker.example/i/octo/demo/${HASH}.png`);
  });

  test('reports uploaded when a checksum-verified object exists in R2', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: { size: 3, body: 'abc', checksums: { sha256: hexToBuffer(HASH) } }
    });
    const request = new Request(`${baseUrl}?${params}`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: r2 });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'uploaded');
    assert.equal(body.serve_url, `https://worker.example/i/octo/demo/${HASH}.png`);
  });

  test('does not report uploaded for objects without a verifiable checksum', async () => {
    const r2 = makeR2({ [`octo/demo/${HASH}.png`]: { size: 3, body: 'abc' } });
    const request = new Request(`${baseUrl}?${params}`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: r2 });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, 'pending');
  });

  test('does not report uploaded for expired objects', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        size: 3,
        body: 'abc',
        checksums: { sha256: hexToBuffer(HASH) },
        uploaded: EXPIRED_UPLOAD_DATE
      }
    });
    const request = new Request(`${baseUrl}?${params}`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: r2 });
    assert.equal(response.status, 202);
  });
});

describe('handleImageServe', () => {
  const serveUrl = `https://worker.example/i/octo/demo/${HASH}.png`;

  test('404s on malformed paths', async () => {
    const request = new Request('https://worker.example/i/octo/demo/short.png');
    const response = await handleImageServe(request, { IMAGES: makeR2() });
    assert.equal(response.status, 404);
  });

  test('404s on missing objects', async () => {
    const response = await handleImageServe(new Request(serveUrl), { IMAGES: makeR2() });
    assert.equal(response.status, 404);
  });

  test('serves objects with capped immutable caching and the right content type', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'imagebytes',
        size: 10,
        httpEtag: '"etag"',
        checksums: { sha256: hexToBuffer(HASH) },
        uploaded: new Date(NOW - 3600 * 1000)
      }
    });
    const response = await handleImageServe(new Request(serveUrl), { IMAGES: r2 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    const cacheControl = response.headers.get('Cache-Control');
    assert.match(cacheControl, /^public, max-age=\d+, immutable$/);
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)[1]);
    assert.ok(maxAge <= UPLOAD_TTL_S - 3500, `max-age ${maxAge} should be capped below the remaining TTL`);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(await response.text(), 'imagebytes');
  });

  test('refuses to serve objects whose checksum does not match the key', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'tampered',
        size: 8,
        checksums: { sha256: hexToBuffer('b'.repeat(64)) }
      }
    });
    const response = await handleImageServe(new Request(serveUrl), { IMAGES: r2 });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'checksum_mismatch');
  });

  test('refuses to serve objects without a stored checksum', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: { body: 'unverified', size: 10 }
    });
    const response = await handleImageServe(new Request(serveUrl), { IMAGES: r2 });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'checksum_mismatch');
  });

  test('deletes and refuses objects older than the 90-day TTL', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'old',
        size: 3,
        checksums: { sha256: hexToBuffer(HASH) },
        uploaded: EXPIRED_UPLOAD_DATE
      }
    });
    const response = await handleImageServe(new Request(serveUrl), { IMAGES: r2 });
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.error, 'expired');
    assert.deepEqual(r2.deleted, [`octo/demo/${HASH}.png`]);
  });

  test('answers HEAD without a body', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'imagebytes',
        size: 10,
        httpEtag: '"etag"',
        checksums: { sha256: hexToBuffer(HASH) }
      }
    });
    const response = await handleImageServe(new Request(serveUrl, { method: 'HEAD' }), { IMAGES: r2 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), '10');
  });

  test('HEAD refuses unverifiable objects', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: { body: 'unverified', size: 10 }
    });
    const response = await handleImageServe(new Request(serveUrl, { method: 'HEAD' }), { IMAGES: r2 });
    assert.equal(response.status, 409);
  });

  test('HEAD expires old objects', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'old',
        size: 3,
        checksums: { sha256: hexToBuffer(HASH) },
        uploaded: EXPIRED_UPLOAD_DATE
      }
    });
    const response = await handleImageServe(new Request(serveUrl, { method: 'HEAD' }), { IMAGES: r2 });
    assert.equal(response.status, 410);
    assert.deepEqual(r2.deleted, [`octo/demo/${HASH}.png`]);
  });

  test('HEAD 404s on missing objects', async () => {
    const response = await handleImageServe(new Request(serveUrl, { method: 'HEAD' }), { IMAGES: makeR2() });
    assert.equal(response.status, 404);
  });
});

describe('wildcard serve domain', () => {
  const DOMAIN_ENV = { IMAGE_SERVE_DOMAIN: 'img.example.com' };

  test('coordinatesFromHost parses repo--owner labels', () => {
    assert.deepEqual(
      coordinatesFromHost('ai-aligned-gh--ai-ecoverse.img.example.com', DOMAIN_ENV),
      { owner: 'ai-ecoverse', repo: 'ai-aligned-gh' }
    );
    // The LAST -- separates: repos may contain --, owners cannot
    assert.deepEqual(
      coordinatesFromHost('my--repo--octo.img.example.com', DOMAIN_ENV),
      { owner: 'octo', repo: 'my--repo' }
    );
  });

  test('coordinatesFromHost rejects non-matching hosts', () => {
    assert.equal(coordinatesFromHost('worker.example.dev', DOMAIN_ENV), null);
    assert.equal(coordinatesFromHost('img.example.com', DOMAIN_ENV), null);
    assert.equal(coordinatesFromHost('no-separator.img.example.com', DOMAIN_ENV), null);
    assert.equal(coordinatesFromHost('a.b.img.example.com', DOMAIN_ENV), null);
    assert.equal(coordinatesFromHost('repo--owner.img.example.com', {}), null);
  });

  test('coordinatesFromHost rejects malformed hostname labels', () => {
    assert.equal(coordinatesFromHost('repo_x--owner.img.example.com', DOMAIN_ENV), null);
    assert.equal(coordinatesFromHost('-repo--owner.img.example.com', DOMAIN_ENV), null);
    assert.equal(coordinatesFromHost('repo--owner-.img.example.com', DOMAIN_ENV), null);
    const tooLong = `${'a'.repeat(70)}--owner.img.example.com`;
    assert.equal(coordinatesFromHost(tooLong, DOMAIN_ENV), null);
  });

  test('isImageServeHost fences the whole serve domain', () => {
    assert.equal(isImageServeHost('repo--owner.img.example.com', DOMAIN_ENV), true);
    assert.equal(isImageServeHost('anything.img.example.com', DOMAIN_ENV), true);
    assert.equal(isImageServeHost('img.example.com', DOMAIN_ENV), true);
    assert.equal(isImageServeHost('worker.example.dev', DOMAIN_ENV), false);
    assert.equal(isImageServeHost('evil-img.example.com', DOMAIN_ENV), false);
    assert.equal(isImageServeHost('repo--owner.img.example.com', {}), false);
  });

  test('status returns wildcard serve URLs when the domain is configured', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: { size: 3, body: 'abc', checksums: { sha256: hexToBuffer(HASH) } }
    });
    const request = new Request(`https://worker.example/image-upload/status?owner=Octo&repo=Demo&hash=${HASH}&ext=png`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: r2, ...DOMAIN_ENV });
    const body = await response.json();
    assert.equal(body.status, 'uploaded');
    assert.equal(body.serve_url, `https://demo--octo.img.example.com/${HASH}.png`);
  });

  test('falls back to path URLs for repos that are not hostname-safe', async () => {
    const r2 = makeR2({
      [`octo/my.dotted.repo/${HASH}.png`]: { size: 3, body: 'abc', checksums: { sha256: hexToBuffer(HASH) } }
    });
    const request = new Request(`https://worker.example/image-upload/status?owner=octo&repo=my.dotted.repo&hash=${HASH}&ext=png`);
    const response = await handleImageStatus(request, { IMAGE_OFFERS: makeKV(), IMAGES: r2, ...DOMAIN_ENV });
    const body = await response.json();
    assert.equal(body.serve_url, `https://worker.example/i/octo/my.dotted.repo/${HASH}.png`);
  });

  test('serves objects addressed by wildcard hostname', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'imagebytes',
        size: 10,
        checksums: { sha256: hexToBuffer(HASH) }
      }
    });
    const request = new Request(`https://demo--octo.img.example.com/${HASH}.png`);
    const response = await handleImageServe(request, { IMAGES: r2, ...DOMAIN_ENV });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.equal(await response.text(), 'imagebytes');
  });

  test('404s wildcard-host paths that are not a bare hash', async () => {
    const r2 = makeR2({});
    const request = new Request('https://demo--octo.img.example.com/health');
    const response = await handleImageServe(request, { IMAGES: r2, ...DOMAIN_ENV });
    assert.equal(response.status, 404);
  });

  test('path-based serving still works when the domain is configured', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'imagebytes',
        size: 10,
        checksums: { sha256: hexToBuffer(HASH) }
      }
    });
    const request = new Request(`https://worker.example/i/Octo/Demo/${HASH}.png`);
    const response = await handleImageServe(request, { IMAGES: r2, ...DOMAIN_ENV });
    assert.equal(response.status, 200);
  });
});

describe('IMAGE_CONTENT_TYPES', () => {
  test('covers the documented allowlist', () => {
    assert.deepEqual(
      Object.keys(IMAGE_CONTENT_TYPES).sort(),
      ['avif', 'gif', 'jpeg', 'jpg', 'mov', 'mp4', 'png', 'svg', 'webm', 'webp'].sort()
    );
  });
});
