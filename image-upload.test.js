import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleImageServe,
  coordinatesFromHost,
  isImageServeHost,
  IMAGE_CONTENT_TYPES,
  UPLOAD_TTL_S
} from './image-upload.js';

// Node 18+ provides Request/Response/Headers/URL natively — no polyfills needed.

const HASH = 'a'.repeat(64);
const NOW = Date.now();
const EXPIRED_UPLOAD_DATE = new Date(NOW - (UPLOAD_TTL_S + 3600) * 1000);

// Minimal single-range parser, sufficient to exercise the serve path.
function resolveRange(headerValue, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    const length = Math.min(Number(endRaw), size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  const offset = Number(startRaw);
  if (offset >= size) return null;
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
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
    async get(key, options) {
      const obj = objects[key];
      if (!obj) return null;
      const result = {
        body: obj.body,
        size: obj.size,
        httpEtag: obj.httpEtag,
        checksums: obj.checksums,
        uploaded: obj.uploaded
      };
      const rangeHeader = options && options.range ? options.range.get('range') : null;
      if (rangeHeader) {
        // Mirrors R2's behaviour: resolve the range or throw when unsatisfiable.
        const range = resolveRange(rangeHeader, obj.size);
        if (!range) {
          throw new Error('The requested range is not satisfiable');
        }
        result.range = range;
        result.body = String(obj.body).slice(range.offset, range.offset + range.length);
      }
      return result;
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

  const videoUrl = `https://worker.example/i/octo/demo/${HASH}.mp4`;

  function makeVideoR2() {
    return makeR2({
      [`octo/demo/${HASH}.mp4`]: {
        body: '0123456789',
        size: 10,
        httpEtag: '"etag"',
        checksums: { sha256: hexToBuffer(HASH) }
      }
    });
  }

  test('advertises byte ranges on unranged responses', async () => {
    const response = await handleImageServe(new Request(videoUrl), { IMAGES: makeVideoR2() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('Content-Length'), '10');
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  });

  test('answers a ranged GET with 206 and a correct Content-Range', async () => {
    const request = new Request(videoUrl, { headers: { Range: 'bytes=2-5' } });
    const response = await handleImageServe(request, { IMAGES: makeVideoR2() });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 2-5/10');
    assert.equal(response.headers.get('Content-Length'), '4');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(await response.text(), '2345');
  });

  test('handles the open-ended range Safari opens a media source with', async () => {
    const request = new Request(videoUrl, { headers: { Range: 'bytes=0-' } });
    const response = await handleImageServe(request, { IMAGES: makeVideoR2() });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-9/10');
    assert.equal(await response.text(), '0123456789');
  });

  test('handles a suffix range', async () => {
    const request = new Request(videoUrl, { headers: { Range: 'bytes=-3' } });
    const response = await handleImageServe(request, { IMAGES: makeVideoR2() });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 7-9/10');
    assert.equal(await response.text(), '789');
  });

  test('answers an unsatisfiable range with 416', async () => {
    const request = new Request(videoUrl, { headers: { Range: 'bytes=99999-' } });
    const response = await handleImageServe(request, { IMAGES: makeVideoR2() });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
  });

  test('404s a ranged GET for a missing object rather than 416', async () => {
    const request = new Request(videoUrl, { headers: { Range: 'bytes=0-1' } });
    const response = await handleImageServe(request, { IMAGES: makeR2() });
    assert.equal(response.status, 404);
  });

  test('expiry and checksum guards still fire ahead of range handling', async () => {
    const expiredR2 = makeR2({
      [`octo/demo/${HASH}.mp4`]: {
        body: '0123456789',
        size: 10,
        checksums: { sha256: hexToBuffer(HASH) },
        uploaded: EXPIRED_UPLOAD_DATE
      }
    });
    const expired = await handleImageServe(
      new Request(videoUrl, { headers: { Range: 'bytes=0-1' } }),
      { IMAGES: expiredR2 }
    );
    assert.equal(expired.status, 410);

    const tamperedR2 = makeR2({
      [`octo/demo/${HASH}.mp4`]: { body: '0123456789', size: 10 }
    });
    const tampered = await handleImageServe(
      new Request(videoUrl, { headers: { Range: 'bytes=0-1' } }),
      { IMAGES: tamperedR2 }
    );
    assert.equal(tampered.status, 409);
  });

  test('HEAD advertises byte ranges', async () => {
    const response = await handleImageServe(
      new Request(videoUrl, { method: 'HEAD' }),
      { IMAGES: makeVideoR2() }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
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
