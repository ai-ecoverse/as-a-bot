import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleImageOffer, handleImageStatus, handleImageServe, validateOfferPayload, IMAGE_CONTENT_TYPES } from './image-upload.js';

// Node 18+ provides Request/Response/Headers/URL natively — no polyfills needed.

const HASH = 'a'.repeat(64);
const HASH_B64 = Buffer.from(HASH, 'hex').toString('base64');

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
    async head(key) {
      const obj = objects[key];
      return obj ? { size: obj.size, httpEtag: obj.httpEtag, checksums: obj.checksums } : null;
    },
    async get(key) {
      const obj = objects[key];
      return obj
        ? { body: obj.body, size: obj.size, httpEtag: obj.httpEtag, checksums: obj.checksums }
        : null;
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

describe('handleImageOffer', () => {
  test('rejects requests without a Bearer token', async () => {
    const request = new Request('https://worker.example/image-upload/offer', { method: 'POST' });
    const response = await handleImageOffer(request, { IMAGE_OFFERS: makeKV() }, {});
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'unauthorized');
  });

  test('rejects malformed OIDC tokens', async () => {
    const request = new Request('https://worker.example/image-upload/offer', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-jwt' }
    });
    const response = await handleImageOffer(request, { IMAGE_OFFERS: makeKV() }, {});
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'invalid_oidc_token');
  });

  test('returns 503 when the KV binding is missing', async () => {
    const request = new Request('https://worker.example/image-upload/offer', { method: 'POST' });
    const response = await handleImageOffer(request, {}, {});
    assert.equal(response.status, 503);
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
});

describe('validateOfferPayload', () => {
  const validPayload = () => ({
    owner: 'octo',
    repo: 'demo',
    hash: HASH,
    ext: 'png',
    upload_url: `https://acc.r2.cloudflarestorage.com/bucket/octo/demo/${HASH}.png?sig=1`,
    upload_headers: { 'x-amz-checksum-sha256': HASH_B64 },
    expires_in: 900
  });

  test('accepts a valid payload', () => {
    const result = validateOfferPayload(validPayload());
    assert.equal(result.error, undefined);
    assert.equal(result.owner, 'octo');
    assert.equal(result.ttl, 900);
    assert.equal(result.uploadHeaders['x-amz-checksum-sha256'], HASH_B64);
  });

  test('rejects non-object bodies', () => {
    assert.ok(validateOfferPayload(null).error);
    assert.ok(validateOfferPayload([]).error);
    assert.ok(validateOfferPayload('str').error);
  });

  test('rejects upload URLs outside R2', () => {
    const payload = { ...validPayload(), upload_url: 'https://evil.example/steal' };
    assert.match(validateOfferPayload(payload).error, /upload_url/);
  });

  test('rejects offers without the checksum binding header', () => {
    const payload = { ...validPayload(), upload_headers: {} };
    assert.match(validateOfferPayload(payload).error, /x-amz-checksum-sha256/);
  });

  test('rejects offers whose checksum header does not match the hash', () => {
    const payload = {
      ...validPayload(),
      upload_headers: { 'x-amz-checksum-sha256': Buffer.from('b'.repeat(64), 'hex').toString('base64') }
    };
    assert.match(validateOfferPayload(payload).error, /x-amz-checksum-sha256/);
  });

  test('clamps expires_in into the allowed TTL range', () => {
    assert.equal(validateOfferPayload({ ...validPayload(), expires_in: 5 }).ttl, 60);
    assert.equal(validateOfferPayload({ ...validPayload(), expires_in: 99999 }).ttl, 3600);
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

  test('serves objects with immutable caching and the right content type', async () => {
    const r2 = makeR2({
      [`octo/demo/${HASH}.png`]: {
        body: 'imagebytes',
        size: 10,
        httpEtag: '"etag"',
        checksums: { sha256: hexToBuffer(HASH) }
      }
    });
    const response = await handleImageServe(new Request(serveUrl), { IMAGES: r2 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
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

  test('HEAD 404s on missing objects', async () => {
    const response = await handleImageServe(new Request(serveUrl, { method: 'HEAD' }), { IMAGES: makeR2() });
    assert.equal(response.status, 404);
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
