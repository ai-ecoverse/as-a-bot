/**
 * Retirement of the `gh image` upload service.
 *
 * gh 2.99.0 added a repeatable `--attach` flag to
 * `gh issue|pr create|edit|comment`, which uploads local images and videos
 * to GitHub natively — the limitation this service worked around
 * (cli/cli#12960) no longer exists. The client side is already gone
 * (ai-ecoverse/ai-aligned-gh#74), so the worker no longer brokers uploads:
 *
 *  - the agentbin.net homepage redirects to GitHub's changelog entry,
 *  - /image-upload/offer and /image-upload/status answer 410 Gone,
 *  - already-uploaded objects keep being served until the 90-day R2
 *    retention lapses (see image-upload.js).
 */

export const RETIREMENT_URL =
  'https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/';

export const RETIREMENT_MESSAGE =
  'gh image is retired. Use `gh pr comment --attach <file>` (or --attach on ' +
  'gh issue/pr create|edit|comment) with gh >= 2.99.0, which uploads media to ' +
  'GitHub natively.';

// 302, not 301: the redirect stays reversible and is not cached permanently.
export function retirementRedirect() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': RETIREMENT_URL,
      'Cache-Control': 'no-store'
    }
  });
}

// 410 Gone for the retired upload endpoints. Clients still polling fail fast
// with an actionable message instead of hanging until their timeout.
export function retiredUploadResponse() {
  return new Response(JSON.stringify({
    error: 'gone',
    error_description: RETIREMENT_MESSAGE,
    replacement: 'gh --attach (gh >= 2.99.0)',
    more_info: RETIREMENT_URL
  }), {
    status: 410,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
