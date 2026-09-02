import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { handleGitHubWebhook } from './app-install.js';

const SECRET = 'test-webhook-secret';

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function webhookRequest(event, payload, { signature } = {}) {
  const body = JSON.stringify(payload);
  return new Request('https://worker.example/webhook', {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': signature !== undefined ? signature : sign(body),
      'Content-Type': 'application/json'
    },
    body
  });
}

// The webhook no longer calls GitHub at all (the image-upload workflow it
// used to commit is retired), so we stub global.fetch purely to assert that
// nothing reaches out.
let fetchCalls;
let fetchResponses;
const realFetch = global.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  global.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const next = fetchResponses.shift();
    if (!next) {
      return new Response('{}', { status: 500 });
    }
    return next;
  };
});

afterEach(() => {
  global.fetch = realFetch;
});

const ENV = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'unused',
  GITHUB_API: 'https://api.github.example'
};

describe('handleGitHubWebhook', () => {
  test('returns 503 when the webhook secret is not configured', async () => {
    const response = await handleGitHubWebhook(webhookRequest('ping', {}), {});
    assert.equal(response.status, 503);
  });

  test('rejects invalid signatures', async () => {
    const request = webhookRequest('installation', { action: 'created' }, { signature: 'sha256=' + '0'.repeat(64) });
    const response = await handleGitHubWebhook(request, ENV);
    assert.equal(response.status, 401);
  });

  test('rejects missing signatures', async () => {
    const request = webhookRequest('installation', { action: 'created' }, { signature: '' });
    const response = await handleGitHubWebhook(request, ENV);
    assert.equal(response.status, 401);
  });

  test('ignores unrelated events', async () => {
    const response = await handleGitHubWebhook(webhookRequest('push', { ref: 'refs/heads/main' }), ENV);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ignored');
    assert.equal(fetchCalls.length, 0);
  });

  test('ignores installation deletions', async () => {
    const response = await handleGitHubWebhook(
      webhookRequest('installation', { action: 'deleted', installation: { id: 1 }, repositories: [{ full_name: 'octo/demo' }] }),
      ENV
    );
    const body = await response.json();
    assert.equal(body.status, 'ignored');
    assert.equal(fetchCalls.length, 0);
  });

  test('acknowledges installation created events without committing a workflow', async () => {
    const payload = {
      action: 'created',
      installation: { id: 42 },
      repositories: [{ full_name: 'octo/demo' }, { full_name: 'octo/two' }]
    };
    const response = await handleGitHubWebhook(webhookRequest('installation', payload), ENV);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ignored');
    assert.match(body.reason, /retired/);
    // The auto-install is gone: no installation token, no contents API calls.
    assert.equal(fetchCalls.length, 0);
  });

  test('acknowledges installation_repositories added events without committing a workflow', async () => {
    const payload = {
      action: 'added',
      installation: { id: 42 },
      repositories_added: [{ full_name: 'octo/three' }]
    };
    const response = await handleGitHubWebhook(webhookRequest('installation_repositories', payload), ENV);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ignored');
    assert.equal(fetchCalls.length, 0);
  });
});
