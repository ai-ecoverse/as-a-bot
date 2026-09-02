import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Node 18+ provides Request/Response/Headers/URL natively — no polyfills
// needed here (worker.test.js installs its own, which is why the routing
// assertions for the retirement live in this file instead).
import worker from './worker.js';
import { RETIREMENT_URL, retiredUploadResponse } from './retired.js';

const HASH = 'a'.repeat(64);

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

const ENV = {
  IMAGE_SERVE_DOMAIN: 'agentbin.net',
  IMAGES: {
    async head(key) {
      return key === `octo/demo/${HASH}.png`
        ? { size: 10, checksums: { sha256: hexToBuffer(HASH) }, uploaded: new Date() }
        : null;
    },
    async get(key) {
      return key === `octo/demo/${HASH}.png`
        ? { body: 'imagebytes', size: 10, checksums: { sha256: hexToBuffer(HASH) }, uploaded: new Date() }
        : null;
    },
    async delete() {}
  }
};

describe('retiredUploadResponse', () => {
  test('is a 410 that names the replacement and links the announcement', async () => {
    const response = retiredUploadResponse();
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.error, 'gone');
    assert.match(body.error_description, /--attach/);
    assert.match(body.error_description, /2\.99\.0/);
    assert.equal(body.more_info, RETIREMENT_URL);
  });
});

describe('retired upload endpoints', () => {
  test('POST /image-upload/offer answers 410 Gone', async () => {
    const request = new Request('https://worker.example/image-upload/offer', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer some.oidc.token' },
      body: JSON.stringify({ hash: HASH, ext: 'png' })
    });
    const response = await worker.fetch(request, ENV, {});
    assert.equal(response.status, 410);
    assert.match((await response.json()).error_description, /gh image is retired/);
  });

  test('/image-upload/offer answers 410 even with an unparseable body', async () => {
    const request = new Request('https://worker.example/image-upload/offer', {
      method: 'POST',
      body: 'not json'
    });
    const response = await worker.fetch(request, ENV, {});
    assert.equal(response.status, 410);
  });

  test('GET /image-upload/status answers 410 Gone rather than pending', async () => {
    const request = new Request(
      `https://worker.example/image-upload/status?owner=octo&repo=demo&hash=${HASH}&ext=png`
    );
    const response = await worker.fetch(request, ENV, {});
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.status, undefined, 'clients must not see a pollable status');
    assert.equal(body.more_info, RETIREMENT_URL);
  });
});

describe('serving already-uploaded objects', () => {
  test('path-based /i/ URLs still serve', async () => {
    const request = new Request(`https://worker.example/i/octo/demo/${HASH}.png`);
    const response = await worker.fetch(request, ENV, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
  });

  test('wildcard repo--owner hosts still serve', async () => {
    const request = new Request(`https://demo--octo.agentbin.net/${HASH}.png`);
    const response = await worker.fetch(request, ENV, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
  });

  test('HEAD on a wildcard host still works', async () => {
    const request = new Request(`https://demo--octo.agentbin.net/${HASH}.png`, { method: 'HEAD' });
    const response = await worker.fetch(request, ENV, {});
    assert.equal(response.status, 200);
  });
});

describe('serve-domain apex', () => {
  test('redirects to the announcement instead of serving the homepage', async () => {
    const request = new Request('https://agentbin.net/');
    const response = await worker.fetch(request, ENV, {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), RETIREMENT_URL);
  });
});

describe('health endpoint', () => {
  test('no longer advertises the retired upload endpoints', async () => {
    const response = await worker.fetch(new Request('https://worker.example/health'), ENV, {});
    assert.equal(response.status, 200);
    const { endpoints } = await response.json();
    assert.equal(endpoints['/image-upload/offer'], undefined);
    assert.equal(endpoints['/image-upload/status'], undefined);
    assert.ok(endpoints['/i/{owner}/{repo}/{hash}.{ext}'], 'serving stays advertised');
    assert.ok(endpoints['/user-token/start'], 'the token broker stays advertised');
  });
});
