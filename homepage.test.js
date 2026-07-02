import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleHomepage, isHomepageHost } from './homepage.js';

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
  test('serves the homepage with links and install instructions', async () => {
    const response = handleHomepage(new Request('https://www.agentbin.net/'));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /github\.com\/ai-ecoverse\/as-a-bot/);
    assert.match(html, /github\.com\/ai-ecoverse\/ai-aligned-gh/);
    assert.match(html, /github\.com\/apps\/as-a-bot/);
    assert.match(html, /"https:\/\/github\.com\/ai-ecoverse"/);
    assert.match(html, /raw\.githubusercontent\.com\/ai-ecoverse\/ai-aligned-gh\/main\/install\.sh/);
    assert.match(html, /gh image screenshot\.png/);
  });

  test('404s other paths', () => {
    const response = handleHomepage(new Request('https://www.agentbin.net/anything'));
    assert.equal(response.status, 404);
  });

  test('answers HEAD without a body', async () => {
    const response = handleHomepage(new Request('https://agentbin.net/', { method: 'HEAD' }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });
});
