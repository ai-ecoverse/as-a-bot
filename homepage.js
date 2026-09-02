/**
 * Apex/www handling for the image serve domain (agentbin.net).
 *
 * The marketing homepage advertised `gh image`, which is retired in favour
 * of gh's native `--attach` (see retired.js). The apex and www hosts now
 * redirect to GitHub's changelog entry; every other subdomain under the
 * serve domain still serves already-uploaded objects
 * (repo--owner.<domain>/<hash>.<ext>).
 */

import { retirementRedirect } from './retired.js';

export function isHomepageHost(hostname, env) {
  const domain = (env.IMAGE_SERVE_DOMAIN || '').toLowerCase();
  if (!domain) {
    return false;
  }
  const host = (hostname || '').toLowerCase();
  return host === domain || host === `www.${domain}`;
}

// Handle GET/HEAD on the apex or www host of the serve domain
export function handleHomepage(request) {
  const { pathname } = new URL(request.url);
  if (pathname !== '/' && pathname !== '/index.html') {
    // HEAD responses carry no body (RFC 9110 §9.3.2)
    return new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404 });
  }
  return retirementRedirect();
}
