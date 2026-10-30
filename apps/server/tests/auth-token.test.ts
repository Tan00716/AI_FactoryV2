/**
 * V3-#1 per-install API token tests: the explicit open-local opt-in,
 * the token-file reader, and POST /api/auth/rotate (old token dies
 * immediately, new token persisted 0600, audit never carries a value).
 *
 * Imports from src with explicit `.ts` suffix (server-test convention):
 * routes/auth-token.ts imports only node builtins, and auth.ts resolves
 * @ai-factory/security through node_modules like auth.test.ts does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  generateInstallToken,
  readTokenFile,
  resolveAllowOpenLocal,
  startupAuthError,
  startupRbacError,
  resolveApiAuthConfig,
} from '../src/auth.ts';
import { ROTATE_PATH, handleAuthTokenRoutes, type AuthTokenDeps } from '../src/routes/auth-token.ts';

const OLD = 'old-install-token-0123456789abcdef';

function fakeReq(method: string, path: string): IncomingMessage {
  return { method, url: path, headers: {} } as unknown as IncomingMessage;
}

function captureJson(): { json: AuthTokenDeps['json']; calls: Array<{ status: number; body: unknown }> } {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    calls,
    json: (_res: ServerResponse, status: number, body: unknown) => {
      calls.push({ status, body });
    },
  };
}

describe('resolveAllowOpenLocal (exact-"1" opt-in)', () => {
  it('only the exact value "1" (after trimming) enables open local mode', () => {
    assert.equal(resolveAllowOpenLocal({ FACTORY_ALLOW_OPEN_LOCAL: '1' }), true);
    assert.equal(resolveAllowOpenLocal({ FACTORY_ALLOW_OPEN_LOCAL: ' 1 ' }), true);
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      assert.equal(resolveAllowOpenLocal({ FACTORY_ALLOW_OPEN_LOCAL: v }), false, String(v));
    }
  });
});

describe('readTokenFile', () => {
  it('trims, rejects empty files, and never echoes content on error', () => {
    assert.deepEqual(readTokenFile('/x/token', () => '  abc-token-123  \n'), { token: 'abc-token-123' });
    const empty = readTokenFile('/x/token', () => '   \n');
    assert.ok('error' in empty && !empty.error.includes('abc'));
    const missing = readTokenFile('/x/token', () => {
      throw new Error('ENOENT');
    });
    assert.ok('error' in missing);
  });
});

describe('generateInstallToken', () => {
  it('yields 64 hex chars and distinct values', () => {
    const a = generateInstallToken();
    const b = generateInstallToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});

describe('startup policy with the V3-#1 default', () => {
  it('refuses loopback without credentials unless explicitly opted in', () => {
    assert.ok(startupAuthError('127.0.0.1', undefined));
    assert.ok(startupRbacError('127.0.0.1', resolveApiAuthConfig({}).config));
    assert.equal(
      startupRbacError('127.0.0.1', resolveApiAuthConfig({}).config, { allowOpenLocal: true }),
      null,
    );
  });
});

describe('handleAuthTokenRoutes (POST /api/auth/rotate)', () => {
  function setup(tokenFilePath?: string): {
    deps: AuthTokenDeps;
    jsonCalls: Array<{ status: number; body: unknown }>;
    audits: Array<Record<string, unknown>>;
    current: () => string | undefined;
  } {
    let current: string | undefined = OLD;
    const audits: Array<Record<string, unknown>> = [];
    const { json, calls } = captureJson();
    const deps: AuthTokenDeps = {
      getSingleToken: () => current,
      setSingleToken: (t: string) => {
        current = t;
      },
      callerRole: () => 'admin',
      tokenFilePath,
      audit: {
        record: (actor: string, action: string, entityType: string, entityId: string, details?: Record<string, unknown>) => {
          audits.push({ actor, action, entityType, entityId, details });
        },
      },
      json,
    };
    return { deps, jsonCalls: calls, audits, current: () => current };
  }

  it('ignores other paths and methods', () => {
    const { deps } = setup();
    const res = {} as unknown as ServerResponse;
    assert.equal(handleAuthTokenRoutes(fakeReq('GET', ROTATE_PATH), res, deps), false);
    assert.equal(handleAuthTokenRoutes(fakeReq('POST', '/api/auth/whoami'), res, deps), false);
  });

  it('non-admin callers get 403 and the token is untouched', () => {
    const { deps, jsonCalls, current } = setup();
    deps.callerRole = () => 'viewer';
    const res = {} as unknown as ServerResponse;
    assert.equal(handleAuthTokenRoutes(fakeReq('POST', ROTATE_PATH), res, deps), true);
    assert.equal(jsonCalls[0].status, 403);
    assert.equal(current(), OLD);
  });

  it('open mode (no token) gets 409, not a silently minted credential', () => {
    const { deps, jsonCalls } = setup();
    deps.getSingleToken = () => undefined;
    const res = {} as unknown as ServerResponse;
    assert.equal(handleAuthTokenRoutes(fakeReq('POST', ROTATE_PATH), res, deps), true);
    assert.equal(jsonCalls[0].status, 409);
  });

  it('rotates in memory, persists 0600 to the token file, audits without values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aif-token-'));
    const file = join(dir, 'api-token');
    writeFileSync(file, `${OLD}\n`, { mode: 0o600 });
    const { deps, jsonCalls, audits, current } = setup(file);
    const res = {} as unknown as ServerResponse;
    assert.equal(handleAuthTokenRoutes(fakeReq('POST', ROTATE_PATH), res, deps), true);
    assert.equal(jsonCalls[0].status, 200);
    const body = jsonCalls[0].body as { rotated: boolean; token: string };
    assert.equal(body.rotated, true);
    assert.match(body.token, /^[0-9a-f]{64}$/);
    assert.notEqual(body.token, OLD);
    assert.equal(current(), body.token);
    assert.equal(readFileSync(file, 'utf8').trim(), body.token);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'TOKEN_ROTATED');
    assert.ok(!JSON.stringify(audits[0]).includes(OLD));
    assert.ok(!JSON.stringify(audits[0]).includes(body.token));
  });

  it('a failed file write rolls the memory token back and answers 500', () => {
    const { deps, jsonCalls, current } = setup(join(tmpdir(), 'aif-no-such-dir', 'api-token'));
    const res = {} as unknown as ServerResponse;
    assert.equal(handleAuthTokenRoutes(fakeReq('POST', ROTATE_PATH), res, deps), true);
    assert.equal(jsonCalls[0].status, 500);
    assert.equal(current(), OLD);
  });
});
