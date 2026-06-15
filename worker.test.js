import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Mock environment and globals
if (!global.crypto) {
  Object.defineProperty(global, 'crypto', {
    value: crypto.webcrypto,
    writable: true,
    configurable: true
  });
}
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString('ascii');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
global.URL = URL;
global.Headers = class Headers extends Map {
  constructor(init) {
    super();
    if (init instanceof Map) {
      for (const [k, v] of init) {
        this.set(k.toLowerCase(), v);
      }
    } else if (init) {
      Object.entries(init).forEach(([k, v]) => {
        this.set(k.toLowerCase(), v);
      });
    }
  }
  get(name) {
    return super.get(name.toLowerCase());
  }
  set(name, value) {
    return super.set(name.toLowerCase(), value);
  }
};
global.Response = class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.statusText = init.statusText || 'OK';
    
    // Use Headers class for proper header handling
    if (init.headers instanceof global.Headers) {
      this.headers = init.headers;
    } else if (init.headers instanceof Map) {
      this.headers = new global.Headers();
      for (const [k, v] of init.headers) {
        this.headers.set(k, v);
      }
    } else {
      this.headers = new global.Headers(init.headers);
    }
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  async text() { return typeof this.body === 'string' ? this.body : JSON.stringify(this.body); }
  async json() { return JSON.parse(await this.text()); }
};
global.Request = class Request {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method || 'GET';
    this.headers = new Map();
    if (init.headers) {
      Object.entries(init.headers).forEach(([k, v]) => {
        this.headers.set(k, v);
      });
    }
    this.body = init.body;
  }
  async text() { return this.body || ''; }
  async json() { return JSON.parse(await this.text()); }
};

// Import worker after setting up globals
const workerModule = await import('./worker.js');

// Mock createAppJWT to avoid crypto issues in Node tests
const originalFetch = workerModule.default.fetch;
const worker = {
  default: {
    fetch: async (request, env, ctx) => {
      // Override the private key with a mock JWT
      const mockEnv = {
        ...env,
        // Mock JWT creation to bypass crypto issues
        __mockJWT: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE2MzAwMDAwMDAsImV4cCI6MTYzMDAwMDYwMCwiaXNzIjoiMTIzNDU2In0.mock_signature'
      };
      return originalFetch(request, mockEnv, ctx);
    }
  }
};

// Test private key (RSA 2048-bit)
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7mctZggWu2nCu
hKNvIMTHL1oLfKZM7q5qnQi1n0VQnBlVGFvKkpMpoXG2Thqm5qOL8qZVp2nXj9Y3
V0c3Y9B0Gyu7chsYZE5vG/bGKKNlWBTJPJa9gPJbB3BiGJphxF4zzQXdqSIoFzMb
vB7ii8ryCvNvpFJvwjhbJr7TlPIMkhD3JCKmyLBabfGAoGCqLnu3afRCkJkvsBc9
Lg3hw5XoZOqOvTGDZ3NPuAWmjHGQx/cTzMMPXLzH5FRkcqJF3lu+6c3BnxwfuKl5
5PVd7Qt9L7Qm5NL0jj5TDzzCPY1VmJRAVlUKqnZPS6nvXkBFjD1/vwDPLLKUhDHF
7EVQHq2bAgMBAAECggEAAxDxZLzvwCPb25diSPbB0ZG7jnv6fUJqA8cOvR6PqZfU
DKKQWZPvKy5qTlpFmHzE8L8Yp6CugvXnVMSpRVOWJqOlMCQf5SMXg3jLxCj7bVss
VrZLq0XGLqBbOlCHGmJ6x8hM3rQ5bQc5taLtR4nXLbMCQjQxHs4OPrJiTGCnlGkV
0rPaBLHTFDZHEUKDHGKvto+h8pbIbO0HjUrZgjJdRNNA7rFlUj9MEObwN1qKRjxZ
9eIjjYmB8A7sU9WjHJVp+QmQLToIEVNjLTOPYRwUVzfhX9w3km4RP0/SWlCIe5YZ
uFT9VHZLQQSkruMYV0nGZ3N3nR4bCGO3+1xPVg5kQQKBgQDfPDhXXJNKPEp7bvUG
NZ2y7r7cFPGYDqeFRKyhcvtLYDQaMVXacQPfLYLJRvcPdDiPY0N8bhY3W1IUAZ0R
YQCAH3EumynB3vCpnEqj8owXVDvQdOA0A9mDjVccDg3bH7bFgGmfq2t2B9Q8oNMX
6ztyYgsXQT3vwJl6dN1MAUCxmwKBgQDXpLcJv/aLYYquHedFzLbRx/lQQj9VLLcT
c6pLbBhtLpo5LS7fzkVxTNBFF8DzDY0wzTJBj3qFDgcTGPTpYmNCq8cX5bIL2IJZ
V7eZQ4hSZ5MB7iCz0pjCL/wKXW+F7la2AkyfzHEKqUXBkA3cqYPPdLwhBIDtjtsQ
3Do9yJFQgQKBgE5nDteEBh7XlnhemBqPDQPSKpPe8beEAfXvLYRg+5k2r6qQFaeG
VaVP6Omqv+9kek7YDlN8rE8RMo8IkCNVrb0CmJylBDK2Qg+Eyt1qfmfcg7BriddR
9c/FnCpTFtDXXLB8RGYebH8kYX7FkBFJMPxvNQzBm3Sl9YQq5iMVdCMBAoGBAMPr
cZFcJ6nGLtMDf9bFKqgUSjlvMVxCPNcor+NU6yuG8f6N/efivI9CMsIa5B8tbG2A
8VJxPSvNPIXGMO5mjITteQTGMJIFiB1GPDlNIMqQJiYG3d7MLqGBxxlJKqb1Gjso
P0A8C0VGnCB9gVQ3FcJRI9sEONcwOFqBTr9mjvoBAoGAEPZ2dQxqoVDxyF9uNpZT
BX8zDWMx0mMGCdVbTKrwOzrJqCmHBTH7xuFg3KcVX3XJpXVpEfEd8wjVDB5b6dy7
9yA5kTYqoK+fR3V8JDKvNe5Bz+uxH2RYjsFHpCjHkPYRcjqKXMYKJMbEolKtT9cC
k/s1nVBxNlD8sWfs+Ry3vzE=
-----END PRIVATE KEY-----`;

describe('Worker Tests', () => {
  let env;
  let ctx;
  
  beforeEach(() => {
    // Reset environment for each test
    env = {
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      GITHUB_APP_ID: '123456',
      GITHUB_CLIENT_ID: 'Iv1.abc123def456',
      GITHUB_CLIENT_SECRET: 'test_client_secret',
      GITHUB_API: 'https://api.github.com',
      ALLOWED_ORIGINS: 'https://example.com',
      RATE_LIMIT: {
        get: mock.fn(async () => null),
        put: mock.fn(async () => {}),
        delete: mock.fn(async () => {})
      },
      DEVICE_CODES: {
        get: mock.fn(async () => null),
        put: mock.fn(async () => {}),
        delete: mock.fn(async () => {})
      }
    };
    ctx = {};
    
    // Mock fetch for GitHub API calls
    global.fetch = mock.fn(async (url, options) => {
      const urlStr = url.toString();
      
      // Mock GitHub user verification
      if (urlStr.includes('/user')) {
        const authHeader = options?.headers?.['Authorization'];
        if (authHeader === 'Bearer valid_github_token') {
          return new Response(JSON.stringify({ 
            login: 'testuser',
            id: 12345,
            name: 'Test User'
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          return new Response('Unauthorized', { status: 401 });
        }
      }
      
      // Mock repository access check
      if (urlStr.includes('/repos/') && !urlStr.includes('/installation') && !urlStr.includes('/collaborators')) {
        const authHeader = options?.headers?.['Authorization'];
        if (authHeader === 'Bearer valid_github_token') {
          return new Response(JSON.stringify({
            name: 'hello-world',
            owner: { login: 'octocat' },
            private: false
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // Mock collaborator permission check
      if (urlStr.includes('/collaborators/') && urlStr.includes('/permission')) {
        return new Response(JSON.stringify({
          permission: 'write',
          user: { login: 'testuser' }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Mock installation lookup
      if (urlStr.includes('/repos/') && urlStr.includes('/installation')) {
        return new Response(JSON.stringify({ id: 789 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Mock app installation permissions
      if (urlStr.includes('/app/installations/') && !urlStr.includes('/access_tokens')) {
        return new Response(JSON.stringify({
          permissions: { contents: 'read', metadata: 'read' }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Mock installation token creation
      if (urlStr.includes('/app/installations/') && urlStr.includes('/access_tokens')) {
        return new Response(JSON.stringify({
          token: 'ghs_mocktoken123',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { contents: 'read', metadata: 'read' },
          repositories: []
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Mock device flow start
      if (urlStr.includes('/login/device/code')) {
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          async json() {
            return {
              device_code: 'device_abc123',
              user_code: 'ABCD-1234',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 5
            };
          },
          async text() {
            return JSON.stringify({
              device_code: 'device_abc123',
              user_code: 'ABCD-1234',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 5
            });
          }
        };
      }
      
      // Mock device flow poll / token refresh (same GitHub OAuth endpoint).
      // Includes refresh_token so we can assert the broker forwards it.
      if (urlStr.includes('/login/oauth/access_token')) {
        const oauthResponse = {
          access_token: 'ghu_usertoken456',
          token_type: 'bearer',
          expires_in: 28800,
          refresh_token: 'ghr_refreshtoken789',
          refresh_token_expires_in: 15897600,
          scope: 'repo user'
        };
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          async json() {
            return oauthResponse;
          },
          async text() {
            return JSON.stringify(oauthResponse);
          }
        };
      }
      
      return new Response('Not found', { status: 404 });
    });
  });
  
  
  
  
  
  test('/user-token/start endpoint', async () => {
    const body = JSON.stringify({ scopes: 'repo user' });
    
    const request = new Request('https://example.com/user-token/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: body
    });
    
    const response = await worker.default.fetch(request, env, ctx);
    assert.equal(response.status, 200);
    
    const data = await response.json();
    assert.ok(data.device_code);
    assert.ok(data.user_code);
    assert.ok(data.verification_uri);
    assert.ok(data.expires_in);
    assert.ok(data.interval);
  });
  
  test('/user-token/poll endpoint', async () => {
    const body = JSON.stringify({ device_code: 'device_abc123' });
    
    // Store device data first
    env.DEVICE_CODES.get = mock.fn(async () => ({
      device_code: 'device_abc123',
      created_at: Date.now()
    }));
    
    const request = new Request('https://example.com/user-token/poll', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: body
    });
    
    const response = await worker.default.fetch(request, env, ctx);
    assert.equal(response.status, 200);
    
    const data = await response.json();
    assert.ok(data.access_token);
    assert.equal(data.token_type, 'bearer');
    assert.ok(data.expires_at);
    assert.ok(data.scope);
    // The refresh token must be forwarded so the client can renew silently.
    assert.equal(data.refresh_token, 'ghr_refreshtoken789');
    assert.ok(data.refresh_token_expires_at);
  });

  test('/user-token/refresh endpoint', async () => {
    const body = JSON.stringify({ refresh_token: 'ghr_oldrefreshtoken' });

    const request = new Request('https://example.com/user-token/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: body
    });

    const response = await worker.default.fetch(request, env, ctx);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.ok(data.access_token);
    assert.equal(data.token_type, 'bearer');
    assert.ok(data.expires_at);
    // GitHub rotates the refresh token; the new one must come back.
    assert.equal(data.refresh_token, 'ghr_refreshtoken789');
  });

  test('/user-token/refresh requires a refresh_token', async () => {
    const request = new Request('https://example.com/user-token/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    const response = await worker.default.fetch(request, env, ctx);
    assert.equal(response.status, 400);

    const data = await response.json();
    assert.ok(data.error);
  });

});