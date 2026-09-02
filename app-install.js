/**
 * GitHub App installation webhook.
 *
 * This endpoint used to commit the `image-upload.yml` workflow to every
 * repository the as-a-bot app was installed on, so `gh image` worked with
 * zero per-repo setup. That flow is retired — gh 2.99.0 uploads media
 * natively via `--attach` (see retired.js) — so installations no longer get
 * a workflow that talks to a retired endpoint.
 *
 * The endpoint itself stays: it keeps verifying `X-Hub-Signature-256` and
 * answering GitHub, and remains the hook to build on for future
 * installation-time behaviour. Workflows already committed to repositories
 * are deliberately left alone; they are harmless (the offer endpoint answers
 * 410 Gone) and removing files from other people's repos is not this app's
 * business.
 *
 * Requirements on the GitHub App:
 *  - Webhook URL pointing at POST /webhook with GITHUB_WEBHOOK_SECRET set
 */

const encoder = new TextEncoder();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  return timingSafeEqual(`sha256=${bufferToHex(mac)}`, signatureHeader);
}

// Handle POST /webhook (GitHub App webhook endpoint)
export async function handleGitHubWebhook(request, env, ctx) {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return jsonResponse({ error: 'Webhook not configured (GITHUB_WEBHOOK_SECRET missing)' }, 503);
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  if (!(await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature))) {
    return jsonResponse({ error: 'invalid_signature' }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'invalid_payload' }, 400);
  }

  // Installation events are acknowledged but no longer acted on: the
  // image-upload workflow this used to commit is retired.
  const event = request.headers.get('x-github-event');
  const isInstallEvent =
    (event === 'installation' && payload.action === 'created') ||
    (event === 'installation_repositories' && payload.action === 'added');

  if (isInstallEvent) {
    return jsonResponse({
      status: 'ignored',
      reason: 'image-upload workflow retired; use gh --attach (gh >= 2.99.0)'
    });
  }

  return jsonResponse({ status: 'ignored' });
}
