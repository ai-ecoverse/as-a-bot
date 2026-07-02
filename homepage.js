/**
 * Homepage for the image serve domain (agentbin.net).
 *
 * Served on the apex and www hosts of IMAGE_SERVE_DOMAIN; every other
 * subdomain under the serve domain is content-addressed image serving
 * (repo--owner.<domain>/<hash>.<ext>).
 */

export function isHomepageHost(hostname, env) {
  const domain = (env.IMAGE_SERVE_DOMAIN || '').toLowerCase();
  if (!domain) {
    return false;
  }
  const host = (hostname || '').toLowerCase();
  return host === domain || host === `www.${domain}`;
}

const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agentbin — image uploads for coding agents</title>
  <meta name="description" content="Content-addressed image and video hosting for gh image: attach screenshots and recordings to GitHub PRs and issues from the command line.">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 2rem 1rem;
      line-height: 1.6;
    }
    main {
      max-width: 40rem;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 2.5rem;
    }
    h1 { font-size: 1.7rem; margin-bottom: .4rem; }
    h1 .tld { color: #8b949e; font-weight: 400; }
    h2 { font-size: 1.1rem; margin-bottom: .8rem; }
    ol.steps { margin: 0 0 1.6rem 1.2rem; }
    ol.steps li { margin-bottom: .8rem; }
    ol.steps pre { margin: .5rem 0 0 0; }
    a { color: #58a6ff; }
    .tagline { color: #8b949e; margin-bottom: 1.6rem; }
    p { margin-bottom: 1rem; }
    pre {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: .9rem 1.1rem;
      overflow-x: auto;
      font-size: .85rem;
      margin-bottom: 1.6rem;
    }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .links { display: flex; flex-wrap: wrap; gap: .6rem; margin-bottom: 1.6rem; }
    .links a {
      display: inline-block;
      padding: .45rem .9rem;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #58a6ff;
      text-decoration: none;
      font-size: .9rem;
    }
    .links a:hover { background: #21262d; border-color: #8b949e; }
    .fine { color: #8b949e; font-size: .8rem; }
    .fine code { color: #c9d1d9; }
  </style>
</head>
<body>
  <main>
    <h1>agentbin<span class="tld">.net</span></h1>
    <p class="tagline">Content-addressed image &amp; video hosting for coding agents.</p>
    <p>
      <code>gh</code> can't attach images to pull requests or issues — a real
      limitation for coding agents that want to show a screenshot or screen
      recording. <code>gh image</code> fixes that:
    </p>
    <pre><code>$ gh pr comment 42 --body "Before/after: $(gh image --markdown shot.png)"</code></pre>
    <p>
      Uploads are gated on repository write access via a GitHub Actions
      workflow the <strong>as-a-bot</strong> app installs automatically, bound
      to their SHA-256 content hash end to end, and served immutably from
      <code>&lt;repo&gt;--&lt;owner&gt;.agentbin.net</code> for 90 days.
    </p>
    <h2>Get started</h2>
    <ol class="steps">
      <li>
        Install the <a href="https://github.com/ai-ecoverse/ai-aligned-gh">ai-aligned-gh</a>
        wrapper (it provides the <code>gh image</code> command):
        <pre><code>curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/ai-aligned-gh/main/install.sh | sh</code></pre>
      </li>
      <li>
        Install the <a href="https://github.com/apps/as-a-bot">as-a-bot GitHub App</a>
        on your repositories — it commits the upload workflow automatically;
        no secrets or other configuration needed.
      </li>
      <li>
        Upload away:
        <pre><code>gh image screenshot.png</code></pre>
      </li>
    </ol>
    <div class="links">
      <a href="https://github.com/ai-ecoverse/as-a-bot">as-a-bot</a>
      <a href="https://github.com/ai-ecoverse/ai-aligned-gh">ai-aligned-gh</a>
      <a href="https://github.com/apps/as-a-bot">Install the app</a>
      <a href="https://github.com/ai-ecoverse">ai-ecoverse org</a>
    </div>
    <p class="fine">
      Serve URLs look like
      <code>https://&lt;repo&gt;--&lt;owner&gt;.agentbin.net/&lt;sha256&gt;.&lt;ext&gt;</code>
      — the same file always gets the same URL, and a URL can never change
      content. Part of the AI Ecoverse.
    </p>
  </main>
</body>
</html>
`;

// Handle GET/HEAD on the apex or www host of the serve domain
export function handleHomepage(request) {
  const { pathname } = new URL(request.url);
  if (pathname !== '/' && pathname !== '/index.html') {
    return new Response('Not found', { status: 404 });
  }
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600'
  };
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(HOMEPAGE_HTML, { status: 200, headers });
}
