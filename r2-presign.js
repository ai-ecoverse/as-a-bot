/**
 * AWS Signature Version 4 query-string presigning, implemented with
 * WebCrypto and no dependencies. Used to mint pre-signed R2 PUT URLs so
 * that R2 credentials only ever live as Worker secrets — participating
 * repositories need no secrets at all.
 *
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */

const encoder = new TextEncoder();

function rfc3986Encode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data) {
  return bufferToHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

async function hmac(keyData, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(data));
}

function toAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function canonicalizePath(path) {
  return path.split('/').map(rfc3986Encode).join('/');
}

/**
 * Generate a SigV4 pre-signed URL.
 *
 * @param {object} options
 * @param {string} options.method - HTTP method the URL is valid for
 * @param {string} options.host - Request host
 * @param {string} options.path - Absolute path (starting with '/')
 * @param {string} options.region - Signing region (R2 uses 'auto')
 * @param {string} [options.service] - Signing service (default 's3')
 * @param {string} options.accessKeyId
 * @param {string} options.secretAccessKey
 * @param {number} options.expiresIn - Validity in seconds
 * @param {object} [options.headers] - Extra headers the requester MUST send;
 *   they become part of the signature (host is always included)
 * @param {Date} [options.date] - Signing time (defaults to now; injectable for tests)
 * @returns {Promise<string>} the pre-signed URL
 */
export async function presignUrl({
  method,
  host,
  path,
  region,
  service = 's3',
  accessKeyId,
  secretAccessKey,
  expiresIn,
  headers = {},
  date = new Date()
}) {
  const amzDate = toAmzDate(date);
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${region}/${service}/aws4_request`;

  const allHeaders = { host, ...headers };
  const headerNames = Object.keys(allHeaders).map((n) => n.toLowerCase()).sort();
  const signedHeaders = headerNames.join(';');
  const canonicalHeaders = headerNames
    .map((name) => {
      const value = Object.entries(allHeaders).find(([k]) => k.toLowerCase() === name)[1];
      return `${name}:${String(value).trim()}\n`;
    })
    .join('');

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders
  };
  const canonicalQuery = Object.entries(queryParams)
    .map(([name, value]) => [rfc3986Encode(name), rfc3986Encode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalPath = canonicalizePath(path);
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  let signingKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), shortDate);
  signingKey = await hmac(signingKey, region);
  signingKey = await hmac(signingKey, service);
  signingKey = await hmac(signingKey, 'aws4_request');
  const signature = bufferToHex(await hmac(signingKey, stringToSign));

  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Mint a pre-signed R2 PUT URL for an image object, with the SHA-256
 * checksum bound into the signature: the uploader must send
 * `x-amz-checksum-sha256: <checksumSha256B64>` and R2 will reject any body
 * that does not match it.
 */
export async function presignR2ImagePut(env, key, checksumSha256B64, expiresIn) {
  return presignUrl({
    method: 'PUT',
    host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    path: `/${env.R2_BUCKET}/${key}`,
    region: 'auto',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    expiresIn,
    headers: { 'x-amz-checksum-sha256': checksumSha256B64 }
  });
}
