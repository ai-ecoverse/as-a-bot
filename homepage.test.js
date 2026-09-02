import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleHomepage, isHomepageHost } from './homepage.js';
import { RETIREMENT_URL } from './retired.js';

const ENV = { IMAGE_SERVE_DOMAIN: 'agentbin.net' };

describe('isHomepageHost', () => {
  test('matches the apex and www hosts only', () => {
    assert.equal(isHomepageHost('agentbin.net', ENV), true);
    assert.equal(isHomepageHost('www.agentbin.net', ENV), true);
    assert.equal(isHomepageHost('WWW.AGENTBIN.NET', ENV), true);
    assert.equal(isHomepageHost('repo--owner.agentbin.net', ENV), false);
    assert.equal(isHomepageHost('agentbin.net', {}), false);
  });
});

describe('handleHomepage', () => {
  test('redirects to the gh --attach announcement', async () => {
    const response = handleHomepage(new Request('https://www.agentbin.net/'));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), RETIREMENT_URL);
    assert.equal(await response.text(), '');
  });

  test('redirects with 302 so it stays reversible and uncached', () => {
    const response = handleHomepage(new Request('https://agentbin.net/index.html'));
    assert.equal(response.status, 302);
    assert.notEqual(response.status, 301);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });

  test('404s other paths', () => {
    const response = handleHomepage(new Request('https://www.agentbin.net/anything'));
    assert.equal(response.status, 404);
  });

  test('redirects HEAD as well', () => {
    const response = handleHomepage(new Request('https://agentbin.net/', { method: 'HEAD' }));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), RETIREMENT_URL);
  });
});
