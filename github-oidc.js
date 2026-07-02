/**
 * GitHub Actions OIDC token verification.
 *
 * Workflows request an ID token (permissions: id-token: write) and present it
 * as a Bearer token. We verify the RS256 signature against GitHub's published
 * JWKS, then check issuer, audience, and expiry. The caller inspects the
 * returned claims (notably `repository`) to authorize the request.
 *
 * See: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
 */

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
// Tolerated clock skew between GitHub and the Worker, in seconds
const CLOCK_SKEW_S = 60;

let jwksCache = { keys: null, fetchedAt: 0 };

function base64UrlDecode(input) {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJsonSegment(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

async function getSigningKeys(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && jwksCache.keys && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(JWKS_URL, {
    headers: { 'Accept': 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub JWKS (status ${response.status})`);
  }
  const data = await response.json();
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw new Error('GitHub JWKS response contained no keys');
  }
  jwksCache = { keys: data.keys, fetchedAt: now };
  return jwksCache.keys;
}

// Exposed for tests only
export function resetJwksCache() {
  jwksCache = { keys: null, fetchedAt: 0 };
}

/**
 * Verify a GitHub Actions OIDC token and return its claims.
 *
 * @param {string} token - Compact JWT from the workflow's ID token request
 * @param {string} expectedAudience - Audience the token must carry
 * @returns {Promise<object>} verified claims
 * @throws {Error} if the token is malformed, unsigned by GitHub, or its
 *   issuer/audience/validity window checks fail
 */
export async function verifyGitHubActionsToken(token, expectedAudience) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }

  let header, claims;
  try {
    header = decodeJsonSegment(parts[0]);
    claims = decodeJsonSegment(parts[1]);
  } catch {
    throw new Error('Malformed JWT');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unexpected JWT algorithm: ${header.alg}`);
  }

  let keys = await getSigningKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation: refresh the JWKS once before giving up
    keys = await getSigningKeys(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    throw new Error('JWT signed with unknown key');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedData);
  if (!valid) {
    throw new Error('Invalid JWT signature');
  }

  if (claims.iss !== GITHUB_OIDC_ISSUER) {
    throw new Error(`Unexpected JWT issuer: ${claims.iss}`);
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedAudience)) {
    throw new Error('JWT audience mismatch');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_SKEW_S) {
    throw new Error('JWT has expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_S) {
    throw new Error('JWT not yet valid');
  }

  return claims;
}
