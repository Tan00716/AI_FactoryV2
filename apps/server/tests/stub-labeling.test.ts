/**
 * V3R2-#4 honest stub labeling — server-side labels.
 *
 * - GET /api/router/account carries a machine-readable `source` field:
 *   'stub' when no live provider answered, 'live' when one did. The UI
 *   renders a stub badge off this field instead of parsing usageNote
 *   prose (which the old account line dropped entirely).
 * - POST /api/router/route carries `executionMode: 'stub'`: the decision
 *   itself is pure routing, but whatever it picks executes on the
 *   default backend, which today is the scripted stub adapter.
 *
 * These tests import the route module straight from src (dual-mode
 * rule: no new extensionless value imports anywhere in this file's
 * dependency chain — the route module only value-imports node builtins
 * and sibling .ts-suffixed modules).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountStatus } from '@ai-factory/model-router';
import { handleModelRouterRoutes } from '../src/routes/model-router.ts';

function makeCtx() {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      readBody: async () => ({
        taskType: 'coding',
        complexity: 1,
      }),
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
        return undefined;
      },
    } as never,
    calls,
  };
}

async function call(method: string, url: string, deps: unknown) {
  const { ctx, calls } = makeCtx();
  const handled = await handleModelRouterRoutes(
    { method } as never,
    {} as never,
    new URL(url),
    ctx,
    deps as never,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0] as { status: number; body: Record<string, unknown> };
}

const LIVE: AccountStatus = {
  profile: {
    kind: 'chatgpt-oauth',
    account: 'tan@example.com',
    plan: 'ChatGPT plus',
    usageNote: 'Live account status from codex app-server.',
  },
  usage: { usedPct: 42, resetInfo: 'Primary window resets soon', authenticated: true },
};

describe('V3R2-#4 stub labels on model-router surfaces', () => {
  it('account without a live provider answers source=stub (and still labels itself STUB in prose)', async () => {
    const r = await call('GET', 'http://localhost/api/router/account', {
      liveAccountQuery: async () => null,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body['source'], 'stub');
    const profile = r.body['profile'] as { usageNote?: string };
    assert.match(profile.usageNote ?? '', /^STUB:/);
  });

  it('account with a live provider answers source=live and keeps the live values', async () => {
    const r = await call('GET', 'http://localhost/api/router/account', {
      liveAccountQuery: async () => LIVE,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body['source'], 'live');
    const profile = r.body['profile'] as { account?: string };
    assert.equal(profile.account, 'tan@example.com');
  });

  it('route decision carries executionMode=stub alongside the picked models', async () => {
    const r = await call('POST', 'http://localhost/api/router/route', {});
    assert.equal(r.status, 200);
    assert.equal(r.body['executionMode'], 'stub');
    const primary = r.body['primary'] as { model?: string };
    assert.equal(typeof primary.model, 'string');
  });
});
