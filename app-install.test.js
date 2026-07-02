import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { handleGitHubWebhook, installWorkflowInRepo } from './app-install.js';
import { IMAGE_UPLOAD_WORKFLOW_PATH } from './workflow-template.js';

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

// A well-formed but worthless RSA key is overkill for these tests: token
// creation is exercised through a stubbed fetch, and the JWT signing path
// is short-circuited by making the token request the first fetch failure
// where needed. We stub global.fetch and record calls.
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
  // Tests never reach real JWT signing unless noted; see stubs
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

  test('accepts installation created events and reports repo count', async () => {
    // Token creation fails fast in this test (empty fetch queue → 500),
    // which exercises the accepted-response path without real GitHub calls.
    const payload = {
      action: 'created',
      installation: { id: 42 },
      repositories: [{ full_name: 'octo/demo' }, { full_name: 'octo/two' }]
    };
    const response = await handleGitHubWebhook(webhookRequest('installation', payload), ENV);
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, 'accepted');
    assert.equal(body.repositories, 2);
  });

  test('accepts installation_repositories added events', async () => {
    const payload = {
      action: 'added',
      installation: { id: 42 },
      repositories_added: [{ full_name: 'octo/three' }]
    };
    const response = await handleGitHubWebhook(webhookRequest('installation_repositories', payload), ENV);
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.repositories, 1);
  });
});

describe('installWorkflowInRepo', () => {
  test('commits the workflow when the repo does not have one', async () => {
    fetchResponses.push(new Response('{}', { status: 404 })); // existence check
    fetchResponses.push(new Response('{}', { status: 201 })); // PUT contents

    const result = await installWorkflowInRepo(ENV, 'ghs_token', 'octo/demo');
    assert.equal(result, 'installed');
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0].url.endsWith(`/repos/octo/demo/contents/${IMAGE_UPLOAD_WORKFLOW_PATH}`));
    assert.equal(fetchCalls[1].method, 'PUT');
    const putBody = JSON.parse(fetchCalls[1].body);
    assert.match(putBody.message, /image-upload workflow/);
    const committed = Buffer.from(putBody.content, 'base64').toString();
    assert.match(committed, /workflow_dispatch/);
    assert.match(committed, /id-token: write/);
  });

  test('skips repos that already have the workflow', async () => {
    fetchResponses.push(new Response('{}', { status: 200 }));
    const result = await installWorkflowInRepo(ENV, 'ghs_token', 'octo/demo');
    assert.equal(result, 'exists');
    assert.equal(fetchCalls.length, 1);
  });

  test('reports errors without throwing', async () => {
    fetchResponses.push(new Response('{}', { status: 403 }));
    const result = await installWorkflowInRepo(ENV, 'ghs_token', 'octo/demo');
    assert.equal(result, 'error');
  });
});
