/**
 * Router account status: live wiring — SPEC_V2 §28/§29 (Batch 3, S1-3).
 *
 * GET /api/router/account used to return the getAccountStatus() stub
 * unconditionally. It now asks the real provider first (CodexAdapter
 * against codex app-server, mapped onto the §29 shape and injected via
 * overrides.live), and only falls back to the stub — which labels itself
 * STUB — when no honest live status exists (INV-29).
 *
 * All tests inject the live query: they must never depend on a real codex
 * binary or login.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountStatus } from '@ai-factory/model-router';
import {
  handleModelRouterRoutes,
  mapCodexAccountStatus,
  type ModelRouterRouteDeps,
} from '../src/routes/model-router.ts';

function makeCtx() {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      readBody: async () => ({}),
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
        return undefined;
      },
    } as never,
    calls,
  };
}

async function getAccount(deps: ModelRouterRouteDeps) {
  const { ctx, calls } = makeCtx();
  const handled = await handleModelRouterRoutes(
    { method: 'GET' } as never,
    {} as never,
    new URL('http://localhost/api/router/account'),
    ctx,
    deps,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0] as { status: number; body: AccountStatus };
}

const LIVE: AccountStatus = {
  profile: {
    kind: 'chatgpt-oauth',
    account: 'tan@example.com',
    plan: 'ChatGPT plus',
    usageNote: 'Live account status from codex app-server (getAuthStatus + account/read).',
  },
  usage: { usedPct: 42, resetInfo: 'Primary window resets at 2026-10-12T10:00:00.000Z', authenticated: true },
};

describe('GET /api/router/account live wiring (§28/§29, S1-3)', () => {
  it('live query hit → 200 with LIVE source annotation and the live values', async () => {
    const r = await getAccount({ liveAccountQuery: async () => LIVE });
    assert.equal(r.status, 200);
    assert.match(r.body.profile.usageNote ?? '', /LIVE via codex-app-server/);
    assert.equal(r.body.profile.account, 'tan@example.com');
    assert.equal(r.body.usage.usedPct, 42);
    assert.equal(r.body.usage.authenticated, true);
  });

  it('live query returns null (unreachable) → 200 stub, honestly labelled STUB', async () => {
    const r = await getAccount({ liveAccountQuery: async () => null });
    assert.equal(r.status, 200);
    assert.match(r.body.profile.usageNote ?? '', /^STUB:/);
    assert.equal(r.body.usage.authenticated, false);
  });

  it('live query throws → 200 stub fallback, endpoint never fails', async () => {
    const r = await getAccount({
      liveAccountQuery: async () => {
        throw new Error('spawn codex ENOENT');
      },
    });
    assert.equal(r.status, 200);
    assert.match(r.body.profile.usageNote ?? '', /^STUB:/);
  });
});

describe('mapCodexAccountStatus (§28/§29, S1-3)', () => {
  it('unreachable → null (stub fallback, no simulated data)', () => {
    assert.equal(
      mapCodexAccountStatus({
        reachable: false,
        authMethod: null,
        requiresOpenaiAuth: null,
        account: null,
        error: 'spawn failed',
      }),
      null,
    );
  });

  it('reachable but NOT logged in → live status that says so verbatim (INV-29)', () => {
    const s = mapCodexAccountStatus({
      reachable: true,
      authMethod: null,
      requiresOpenaiAuth: true,
      account: null,
    });
    assert.ok(s);
    assert.equal(s.usage.authenticated, false);
    assert.match(s.profile.usageNote ?? '', /authMethod=null/);
    assert.match(s.profile.usageNote ?? '', /requiresOpenaiAuth=true/);
    assert.match(s.profile.usageNote ?? '', /NOT logged in/);
  });

  it('logged in via ChatGPT → account/plan mapped, usedPct from the primary window', () => {
    const s = mapCodexAccountStatus({
      reachable: true,
      authMethod: 'chatgpt',
      requiresOpenaiAuth: true,
      account: { type: 'chatgpt', email: 'tan@example.com', planType: 'plus' },
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1791511200 },
        secondary: null,
      },
    });
    assert.ok(s);
    assert.equal(s.profile.kind, 'chatgpt-oauth');
    assert.equal(s.profile.account, 'tan@example.com');
    assert.equal(s.profile.plan, 'ChatGPT plus');
    assert.equal(s.usage.usedPct, 42);
    assert.equal(s.usage.authenticated, true);
    assert.match(s.usage.resetInfo, /resets at/);
  });

  it('logged in but no rate-limit window reported → usedPct 0 is labelled as no-data', () => {
    const s = mapCodexAccountStatus({
      reachable: true,
      authMethod: 'apikey',
      requiresOpenaiAuth: false,
      account: { type: 'apikey', email: null, planType: null },
    });
    assert.ok(s);
    assert.equal(s.profile.kind, 'api-key');
    assert.equal(s.usage.usedPct, 0);
    assert.match(s.usage.resetInfo, /no window data, not measured usage/);
  });
});
