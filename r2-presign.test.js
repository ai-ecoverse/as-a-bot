import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { presignUrl, presignR2ImagePut } from './r2-presign.js';

describe('presignUrl', () => {
  test('reproduces the documented AWS SigV4 query-auth example', async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    // GET test.txt from examplebucket, us-east-1, 20130524T000000Z, 86400s
    const url = await presignUrl({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresIn: 86400,
      date: new Date('2013-05-24T00:00:00Z')
    });

    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(
      parsed.searchParams.get('X-Amz-Credential'),
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request'
    );
    assert.equal(parsed.searchParams.get('X-Amz-Date'), '20130524T000000Z');
    assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
    // The known-good signature from the AWS documentation
    assert.equal(
      parsed.searchParams.get('X-Amz-Signature'),
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  test('includes extra headers in the signed header list', async () => {
    const url = await presignUrl({
      method: 'PUT',
      host: 'acc.r2.cloudflarestorage.com',
      path: '/bucket/owner/repo/abc.png',
      region: 'auto',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      expiresIn: 900,
      headers: { 'x-amz-checksum-sha256': 'Zm9v' },
      date: new Date('2026-01-01T00:00:00Z')
    });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host;x-amz-checksum-sha256');
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '900');
    assert.match(parsed.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
  });
});

describe('presignR2ImagePut', () => {
  test('builds a path-style R2 URL with the checksum signed in', async () => {
    const env = {
      R2_ACCOUNT_ID: 'acct123',
      R2_BUCKET: 'as-a-bot-images',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret'
    };
    const hash = 'a'.repeat(64);
    const url = await presignR2ImagePut(env, `octo/demo/${hash}.png`, 'checksumB64=', 900);
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'acct123.r2.cloudflarestorage.com');
    assert.equal(parsed.pathname, `/as-a-bot-images/octo/demo/${hash}.png`);
    assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host;x-amz-checksum-sha256');
    assert.ok(parsed.searchParams.get('X-Amz-Credential').startsWith('key/'));
    assert.ok(parsed.searchParams.get('X-Amz-Credential').includes('/auto/s3/aws4_request'));
  });
});
