/**
 * API token authentication tests — sellable checklist B (src/auth.ts).
 *
 * The middleware is tested three ways: the pure predicates (token parsing,
 * loopback check, startup policy, Bearer matching, the gate decision), the
 * enforceApiAuth middleware against fake req/res (401 shape + AUTH_DENIED
 * audit, no token leakage), and a real node:http server wrapping the
 * middleware (health exempt, protected path 401/401/200, open mode).
 *
 * Imports from src: auth.ts depends only on node: builtins, so Node's
 * type-stripping loader handles it like the other src-importing tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  AUTH_DENIED_ACTION,
  bearerTokenMatches,
  enforceApiAuth,
  evaluateApiAuth,
  isLoopbackHost,
  resolveApiToken,
  startupAuthError,
} from '../src/auth.ts';

const TOKEN = 'test-operator-token-0123456789';

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

describe('resolveApiToken', () => {
  it('unset / empty / whitespace-only all mean "authentication disabled"', () => {
    assert.equal(resolveApiToken({}), undefined);
    assert.equal(resolveApiToken({ FACTORY_API_TOKEN: '' }), undefined);
    assert.equal(resolveApiToken({ FACTORY_API_TOKEN: '   ' }), undefined);
  });

  it('returns the trimmed token', () => {
    assert.equal(resolveApiToken({ FACTORY_API_TOKEN: `  ${TOKEN} ` }), TOKEN);
  });
});

describe('isLoopbackHost / startupAuthError (fail-closed startup policy)', () => {
  it('recognizes loopback hosts', () => {
    for (const h of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '']) {
      assert.equal(isLoopbackHost(h), false, h);
    }
  });

  it('no token + loopback → startup allowed (open local mode)', () => {
    assert.equal(startupAuthError('127.0.0.1', undefined), null);
    assert.equal(startupAuthError('localhost', undefined), null);
  });

  it('no token + non-loopback → startup refused with a clear message', () => {
    const err = startupAuthError('0.0.0.0', undefined);
    assert.ok(err);
    assert.match(err!, /refusing to start/);
    assert.match(err!, /FACTORY_API_TOKEN/);
  });

  it('token set → startup allowed on any host', () => {
    assert.equal(startupAuthError('0.0.0.0', TOKEN), null);
    assert.equal(startupAuthError('192.168.1.10', TOKEN), null);
  });
});

describe('bearerTokenMatches (constant-time, Bearer scheme only)', () => {
  it('accepts the exact token', () => {
    assert.equal(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(bearerTokenMatches(`bearer ${TOKEN}`, TOKEN), true);
  });

  it('rejects wrong tokens of same and different length', () => {
    assert.equal(bearerTokenMatches('Bearer test-operator-token-9876543210', TOKEN), false);
    assert.equal(bearerTokenMatches('Bearer short', TOKEN), false);
    assert.equal(bearerTokenMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  });

  it('rejects missing / malformed headers', () => {
    assert.equal(bearerTokenMatches(undefined, TOKEN), false);
    assert.equal(bearerTokenMatches('', TOKEN), false);
    assert.equal(bearerTokenMatches(`Basic ${TOKEN}`, TOKEN), false);
    assert.equal(bearerTokenMatches('Bearer ', TOKEN), false);
    assert.equal(bearerTokenMatches([`Bearer ${TOKEN}`], TOKEN), false);
  });
});

describe('evaluateApiAuth (the gate decision)', () => {
  const base = { method: 'GET', path: '/api/projects', authorization: undefined as string | undefined };

  it('open mode (no token configured) allows everything', () => {
    assert.equal(evaluateApiAuth({ ...base, token: undefined }), 'allow');
  });

  it('health endpoint is exempt when a token is configured', () => {
    assert.equal(
      evaluateApiAuth({ method: 'GET', path: '/api/health', authorization: undefined, token: TOKEN }),
      'allow',
    );
  });

  it('non-/api paths are outside the gate', () => {
    assert.equal(evaluateApiAuth({ ...base, path: '/', token: TOKEN }), 'allow');
    assert.equal(evaluateApiAuth({ ...base, path: '/favicon.ico', token: TOKEN }), 'allow');
  });

  it('protected /api paths require the matching Bearer token', () => {
    assert.equal(evaluateApiAuth({ ...base, token: TOKEN }), 'deny');
    assert.equal(evaluateApiAuth({ ...base, authorization: 'Bearer nope', token: TOKEN }), 'deny');
    assert.equal(
      evaluateApiAuth({ ...base, authorization: `Bearer ${TOKEN}`, token: TOKEN }),
      'allow',
    );
  });
});

describe('enforceApiAuth (middleware: uniform 401 + AUTH_DENIED audit)', () => {
  interface AuditCall {
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  }

  function runMiddleware(authorization: string | undefined, token: string | undefined) {
    const auditCalls: AuditCall[] = [];
    const responses: Array<{ status: number; body: unknown }> = [];
    const req = {
      method: 'POST',
      url: '/api/tasks?projectId=p1',
      headers: authorization === undefined ? {} : { authorization },
      socket: { remoteAddress: '203.0.113.9' },
    };
    const allowed = enforceApiAuth(req as never, {} as never, {
      token,
      audit: {
        record: (actor, action, entityType, entityId, details) => {
          auditCalls.push({ actor, action, entityType, entityId, details });
        },
      },
      json: (_res, status, body) => {
        responses.push({ status, body });
      },
    });
    return { allowed, auditCalls, responses };
  }

  it('correct token → proceeds, no response written, no audit', () => {
    const r = runMiddleware(`Bearer ${TOKEN}`, TOKEN);
    assert.equal(r.allowed, true);
    assert.equal(r.responses.length, 0);
    assert.equal(r.auditCalls.length, 0);
  });

  it('open mode → proceeds even without a header', () => {
    const r = runMiddleware(undefined, undefined);
    assert.equal(r.allowed, true);
    assert.equal(r.auditCalls.length, 0);
  });

  it('missing token → 401 + AUTH_DENIED audit with path and source', () => {
    const r = runMiddleware(undefined, TOKEN);
    assert.equal(r.allowed, false);
    assert.equal(r.responses.length, 1);
    assert.equal(r.responses[0].status, 401);
    assert.deepEqual(r.responses[0].body, { error: 'Unauthorized' });
    assert.equal(r.auditCalls.length, 1);
    const a = r.auditCalls[0];
    assert.equal(a.action, AUTH_DENIED_ACTION);
    assert.equal(a.entityId, '/api/tasks');
    assert.equal(a.details?.method, 'POST');
    assert.equal(a.details?.path, '/api/tasks');
    assert.equal(a.details?.remoteAddress, '203.0.113.9');
  });

  it('wrong token → identical 401 body as missing token (no oracle)', () => {
    const missing = runMiddleware(undefined, TOKEN);
    const wrong = runMiddleware('Bearer wrong-token-value', TOKEN);
    assert.equal(wrong.allowed, false);
    assert.deepEqual(wrong.responses, missing.responses);
  });

  it('neither the configured nor the presented token leaks into audit or response', () => {
    const r = runMiddleware('Bearer wrong-token-value', TOKEN);
    const surface = JSON.stringify({ audit: r.auditCalls, responses: r.responses });
    assert.ok(!surface.includes(TOKEN), 'configured token leaked');
    assert.ok(!surface.includes('wrong-token-value'), 'presented token leaked');
  });
});

describe('enforceApiAuth over real HTTP', () => {
  interface AuditCall {
    action: string;
    entityId: string;
  }

  async function startServer(token: string | undefined, auditCalls: AuditCall[]) {
    const server: Server = createServer((req, res) => {
      const audit = {
        record: (_actor: string, action: string, _t: string, entityId: string) => {
          auditCalls.push({ action, entityId });
        },
      };
      if (!enforceApiAuth(req, res, { token, audit, json: writeJson })) return;
      writeJson(res, 200, { ok: true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    return { server, base: `http://127.0.0.1:${addr.port}` };
  }

  async function stopServer(server: Server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  it('token set: health open, protected path 401 without / 401 wrong / 200 correct', async () => {
    const auditCalls: AuditCall[] = [];
    const { server, base } = await startServer(TOKEN, auditCalls);
    try {
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);

      const noHeader = await fetch(`${base}/api/projects`);
      assert.equal(noHeader.status, 401);
      assert.deepEqual(await noHeader.json(), { error: 'Unauthorized' });

      const wrong = await fetch(`${base}/api/projects`, {
        headers: { Authorization: 'Bearer nope' },
      });
      assert.equal(wrong.status, 401);

      const ok = await fetch(`${base}/api/projects`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true });

      assert.equal(auditCalls.length, 2);
      assert.ok(auditCalls.every((c) => c.action === AUTH_DENIED_ACTION));
      assert.ok(auditCalls.every((c) => c.entityId === '/api/projects'));
    } finally {
      await stopServer(server);
    }
  });

  it('no token configured: old open behavior is unchanged', async () => {
    const auditCalls: AuditCall[] = [];
    const { server, base } = await startServer(undefined, auditCalls);
    try {
      const res = await fetch(`${base}/api/projects`);
      assert.equal(res.status, 200);
      assert.equal(auditCalls.length, 0);
    } finally {
      await stopServer(server);
    }
  });
});
