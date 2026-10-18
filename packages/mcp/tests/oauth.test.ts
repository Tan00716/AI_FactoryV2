/**
 * Tests for the OAuth 2.1 client (oauth.ts).
 * Run: node --test dist/tests/oauth.test.js   (after tsc -p tsconfig.json)
 *
 * A fake authorization server (node:http, 127.0.0.1 ephemeral port)
 * serves the RFC 8414 well-known document and a token endpoint that
 * enforces PKCE (code_verifier) and the refresh_token grant.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import {
  generatePkcePair,
  generateState,
  statesEqual,
  buildAuthorizationUrl,
  discoverOAuthMetadata,
  exchangeCodeForToken,
  refreshAccessToken,
  OAuthTokenManager,
  decodeJwtClaims,
  tokenClaimsForGate,
  isTokenExpired,
  validateAuthorizationResponseIss,
  fetchClientIdMetadataDocument,
  resolveClientId,
  oauthStoreKey,
  type OAuthTokenStore,
  type StoredOAuthToken,
} from '../src/index';
import { defaultRuntimePolicy } from '../src/index';

function memoryStore(): OAuthTokenStore & { map: Map<string, StoredOAuthToken> } {
  const map = new Map<string, StoredOAuthToken>();
  return {
    map,
    save: async (k, t) => { map.set(k, t); },
    load: async (k) => map.get(k) ?? null,
    clear: async (k) => { map.delete(k); },
  };
}

async function startFakeOAuth(): Promise<{ base: string; close(): Promise<void> }> {
  let base = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const fail = (desc: string) => {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: desc }));
        };
        if (p.get('grant_type') === 'authorization_code') {
          if (p.get('code') !== 'code-abc') return fail('bad code');
          if (p.get('code_verifier') !== 'verifier-abc') return fail('PKCE verifier mismatch');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'access-1',
              token_type: 'Bearer',
              expires_in: 3600,
              refresh_token: 'refresh-1',
              scope: 'mcp:tools',
            }),
          );
          return;
        }
        if (p.get('grant_type') === 'refresh_token') {
          if (p.get('refresh_token') !== 'refresh-1' && p.get('refresh_token') !== 'refresh-2') {
            return fail('bad refresh token');
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'access-2',
              token_type: 'Bearer',
              expires_in: 3600,
              refresh_token: 'refresh-2',
              scope: 'mcp:tools',
            }),
          );
          return;
        }
        return fail('unsupported grant');
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Build an unsigned test JWT: header.payload. (signature irrelevant — decode only.) */
function testJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('oauth', () => {
  let fake: { base: string; close(): Promise<void> };
  before(async () => {
    fake = await startFakeOAuth();
  });
  after(async () => {
    await fake.close();
  });

  it('PKCE pair: challenge is base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkcePair();
    assert.ok(verifier.length >= 43);
    const expect = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    assert.equal(challenge, expect);
    assert.notEqual(generatePkcePair().verifier, verifier);
  });

  it('state round-trip uses constant-time comparison', () => {
    const s = generateState();
    assert.equal(statesEqual(s, s), true);
    assert.equal(statesEqual(s, s + 'x'), false);
    assert.equal(statesEqual('a', 'b'), false);
  });

  it('buildAuthorizationUrl carries PKCE S256 + state + scopes', () => {
    const url = buildAuthorizationUrl({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:3100/api/mcp/oauth/callback',
      scopes: ['mcp:tools'],
      state: 'st',
      codeChallenge: 'ch',
      resource: 'https://mcp.example.com',
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('code_challenge'), 'ch');
    assert.equal(u.searchParams.get('state'), 'st');
    assert.equal(u.searchParams.get('scope'), 'mcp:tools');
    assert.equal(u.searchParams.get('resource'), 'https://mcp.example.com');
  });

  it('refuses non-TLS authorization endpoints (except loopback)', () => {
    assert.throws(
      () =>
        buildAuthorizationUrl({
          authorizationEndpoint: 'http://auth.example.com/authorize',
          clientId: 'cid',
          redirectUri: 'http://127.0.0.1:1/cb',
          scopes: [],
          state: 's',
          codeChallenge: 'c',
        }),
      /non-TLS/,
    );
  });

  it('discovers RFC 8414 metadata from the issuer', async () => {
    const meta = await discoverOAuthMetadata(fake.base);
    assert.equal(meta.authorizationEndpoint, `${fake.base}/authorize`);
    assert.equal(meta.tokenEndpoint, `${fake.base}/token`);
  });

  it('exchanges a code (PKCE enforced) and refreshes', async () => {
    const meta = await discoverOAuthMetadata(fake.base);
    const first = await exchangeCodeForToken({
      tokenEndpoint: meta.tokenEndpoint,
      code: 'code-abc',
      codeVerifier: 'verifier-abc',
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:1/cb',
    });
    assert.equal(first.accessToken, 'access-1');
    assert.equal(first.refreshToken, 'refresh-1');
    assert.equal(first.expiresIn, 3600);

    await assert.rejects(
      () =>
        exchangeCodeForToken({
          tokenEndpoint: meta.tokenEndpoint,
          code: 'code-abc',
          codeVerifier: 'wrong-verifier',
          clientId: 'cid',
          redirectUri: 'http://127.0.0.1:1/cb',
        }),
      /PKCE verifier mismatch/,
    );

    const second = await refreshAccessToken({
      tokenEndpoint: meta.tokenEndpoint,
      refreshToken: 'refresh-1',
      clientId: 'cid',
    });
    assert.equal(second.accessToken, 'access-2');
  });

  it('OAuthTokenManager refreshes an expired token and persists it', async () => {
    const store = memoryStore();
    const mgr = new OAuthTokenManager();
    const now = Date.now();
    await store.save('srv', {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      obtainedAt: now - 2 * 3600 * 1000,
      expiresIn: 3600,
    });
    const token = await mgr.getValidAccessToken(
      'srv',
      { tokenEndpoint: `${fake.base}/token`, clientId: 'cid' },
      store,
      now,
    );
    assert.equal(token, 'access-2');
    const saved = await store.load('srv');
    assert.equal(saved?.accessToken, 'access-2');
    assert.equal(saved?.refreshToken, 'refresh-2'); // new refresh token kept
  });

  it('OAuthTokenManager returns a fresh token without network', async () => {
    const store = memoryStore();
    const mgr = new OAuthTokenManager();
    await store.save('srv', {
      accessToken: 'fresh',
      tokenType: 'Bearer',
      obtainedAt: Date.now(),
      expiresIn: 3600,
    });
    const token = await mgr.getValidAccessToken('srv', { tokenEndpoint: `${fake.base}/token`, clientId: 'c' }, store);
    assert.equal(token, 'fresh');
  });

  it('OAuthTokenManager throws when nothing is stored', async () => {
    const mgr = new OAuthTokenManager();
    await assert.rejects(
      () => mgr.getValidAccessToken('missing', { tokenEndpoint: `${fake.base}/token`, clientId: 'c' }, memoryStore()),
      /no token stored/,
    );
  });

  it('isTokenExpired honours the 60s skew', () => {
    const now = 1_000_000;
    assert.equal(isTokenExpired({ accessToken: 'a', tokenType: 'B', obtainedAt: now - 3_600_000, expiresIn: 3600 }, now), true);
    assert.equal(isTokenExpired({ accessToken: 'a', tokenType: 'B', obtainedAt: now, expiresIn: 3600 }, now), false);
    assert.equal(isTokenExpired({ accessToken: 'a', tokenType: 'B', obtainedAt: now }, now), false); // no expiry → valid
  });

  it('tokenClaimsForGate enforces real JWT claims against the §34.3 policy', () => {
    const policy = {
      ...defaultRuntimePolicy('http'),
      oauth: { audience: 'mcp-api', requiredScopes: ['mcp:tools'] },
    };
    const good = tokenClaimsForGate(policy, testJwt({ aud: 'mcp-api', scope: 'mcp:tools mcp:read' }));
    assert.equal(good.allowed, true);
    assert.equal(good.claims?.isJwt, true);

    const badAud = tokenClaimsForGate(policy, testJwt({ aud: 'other', scope: 'mcp:tools' }));
    assert.equal(badAud.allowed, false);
    assert.match(badAud.reason, /audience/);

    const missingScope = tokenClaimsForGate(policy, testJwt({ aud: 'mcp-api', scope: 'mcp:read' }));
    assert.equal(missingScope.allowed, false);
    assert.match(missingScope.reason, /missing required scopes/);
  });

  it('tokenClaimsForGate is honest about opaque tokens', () => {
    const policy = { ...defaultRuntimePolicy('http'), oauth: { requiredScopes: ['x'] } };
    const v = tokenClaimsForGate(policy, 'opaque-token-without-dots-at-all');
    assert.equal(v.allowed, true);
    assert.equal(v.claims, null);
    assert.match(v.reason, /opaque/);
  });
});

describe('RFC 9207 iss validation + Client ID Metadata Documents + issuer-scoped keys', () => {
  it('validateAuthorizationResponseIss accepts absent iss and exact matches', () => {
    assert.doesNotThrow(() => validateAuthorizationResponseIss('https://auth.example.com', null));
    assert.doesNotThrow(() => validateAuthorizationResponseIss('https://auth.example.com', ''));
    assert.doesNotThrow(() => validateAuthorizationResponseIss('https://auth.example.com/', 'https://auth.example.com'));
  });

  it('validateAuthorizationResponseIss refuses a mismatched iss', () => {
    assert.throws(
      () => validateAuthorizationResponseIss('https://auth.example.com', 'https://evil.example.com'),
      /iss mismatch \(RFC 9207\)/,
    );
  });

  it('fetchClientIdMetadataDocument validates redirect_uris', async () => {
    const doc = {
      client_name: 'ai-factory',
      redirect_uris: ['http://127.0.0.1:9/cb'],
    };
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${addr.port}/client.json`;
    try {
      const fetched = await fetchClientIdMetadataDocument(url);
      assert.equal(fetched.clientId, url); // the document URL IS the client_id
      assert.deepEqual(fetched.redirectUris, ['http://127.0.0.1:9/cb']);
      // resolveClientId accepts a listed redirect URI…
      const cid = await resolveClientId({ clientId: 'ignored', clientIdMetadataUrl: url }, 'http://127.0.0.1:9/cb');
      assert.equal(cid, url);
      // …and refuses an unlisted one.
      await assert.rejects(
        () => resolveClientId({ clientId: 'ignored', clientIdMetadataUrl: url }, 'http://127.0.0.1:9/other'),
        /not listed in the client ID metadata document/,
      );
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('resolveClientId falls back to the static clientId', async () => {
    assert.equal(await resolveClientId({ clientId: 'static-id' }, 'http://127.0.0.1:9/cb'), 'static-id');
    await assert.rejects(() => resolveClientId({ clientId: '' }, 'http://127.0.0.1:9/cb'), /clientId is required/);
  });

  it('oauthStoreKey isolates credentials per issuer and stays vault-safe', () => {
    const k1 = oauthStoreKey('my-server', '1.0.0', 'https://auth-a.example.com');
    const k2 = oauthStoreKey('my-server', '1.0.0', 'https://auth-b.example.com');
    assert.notEqual(k1, k2); // never shared across issuers
    assert.equal(oauthStoreKey('my-server', '1.0.0', 'https://auth-a.example.com'), k1); // deterministic
    for (const k of [k1, k2]) {
      assert.match(k, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
      assert.doesNotMatch(k, /auth-a|auth-b/); // the raw issuer never lands in the vault name
    }
  });
});
