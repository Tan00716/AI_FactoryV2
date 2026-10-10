/**
 * Tests for registerAutonomyRoutes — GET/PUT /api/autonomy/mode,
 * POST /api/autonomy/verify-prod, against a fake structural router.
 * Run: node --test dist/tests/routes.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomyHandler,
  AutonomyRouter,
  ProjectAutonomyStore,
  RouteError,
  registerAutonomyRoutes,
} from '../src/index';

function fakeRouter(): { router: AutonomyRouter; handlers: Map<string, AutonomyHandler> } {
  const handlers = new Map<string, AutonomyHandler>();
  const router: AutonomyRouter = {
    get: (p, h) => handlers.set(`GET ${p}`, h),
    put: (p, h) => handlers.set(`PUT ${p}`, h),
    post: (p, h) => handlers.set(`POST ${p}`, h),
  };
  return { router, handlers };
}

async function call(
  handlers: Map<string, AutonomyHandler>,
  key: string,
  req: Parameters<AutonomyHandler>[0],
): Promise<unknown> {
  const h = handlers.get(key);
  assert.ok(h, `handler ${key} registered`);
  return h!(req);
}

describe('registerAutonomyRoutes', () => {
  it('registers the three routes', () => {
    const { router, handlers } = fakeRouter();
    registerAutonomyRoutes(router, {});
    assert.ok(handlers.has('GET /api/autonomy/mode'));
    assert.ok(handlers.has('PUT /api/autonomy/mode'));
    assert.ok(handlers.has('POST /api/autonomy/verify-prod'));
  });

  it('GET /api/autonomy/mode returns the current setting (default assisted)', async () => {
    const { router, handlers } = fakeRouter();
    registerAutonomyRoutes(router, { store: new ProjectAutonomyStore(() => 1) });
    const res = (await call(handlers, 'GET /api/autonomy/mode', {
      query: { projectId: 'p-1' },
    })) as { autonomy: { mode: string } };
    assert.equal(res.autonomy.mode, 'assisted');
  });

  it('GET requires projectId', async () => {
    const { router, handlers } = fakeRouter();
    registerAutonomyRoutes(router, {});
    await assert.rejects(
      call(handlers, 'GET /api/autonomy/mode', { query: {} }),
      (e: unknown) => e instanceof RouteError && e.status === 400,
    );
  });

  it('PUT changes the mode', async () => {
    const { router, handlers } = fakeRouter();
    registerAutonomyRoutes(router, { store: new ProjectAutonomyStore(() => 1) });
    const res = (await call(handlers, 'PUT /api/autonomy/mode', {
      query: {},
      body: { projectId: 'p-1', mode: 'full', updatedBy: 'tan' },
    })) as { autonomy: { mode: string; updatedBy: string } };
    assert.equal(res.autonomy.mode, 'full');
    assert.equal(res.autonomy.updatedBy, 'tan');
  });

  it('PUT rejects an invalid mode with 400', async () => {
    const { router, handlers } = fakeRouter();
    registerAutonomyRoutes(router, {});
    await assert.rejects(
      call(handlers, 'PUT /api/autonomy/mode', {
        query: {},
        body: { projectId: 'p-1', mode: 'turbo' },
      }),
      (e: unknown) => e instanceof RouteError && e.status === 400,
    );
  });

  it('POST /api/autonomy/verify-prod blocks when a gate is missing', async () => {
    const { router, handlers } = fakeRouter();
    registerAutonomyRoutes(router, {});
    const evidence = {
      build: { passed: true, evidenceId: 'b1' },
      tests: { passed: true, evidenceId: 't1' },
      security: { passed: true, aiAssertedOnly: true },
      rollback: { passed: true, evidenceId: 'r1' },
      healthCheck: { passed: true, evidenceId: 'h1' },
      artifact: { passed: true, evidenceId: 'a1' },
      environment: { passed: true, evidenceId: 'e1' },
    };
    const res = (await call(handlers, 'POST /api/autonomy/verify-prod', {
      query: {},
      body: { evidence, action: 'deploy-prod', mode: 'full' },
    })) as {
      blocked: boolean;
      verdict: { ready: boolean; missing: string[] };
      decision: { outcome: string; requiresProdVerification: boolean };
    };
    assert.equal(res.blocked, true);
    assert.equal(res.verdict.ready, false);
    assert.deepEqual(res.verdict.missing, ['security']);
    // full mode auto-approves the action itself, verification is what blocks it
    assert.equal(res.decision.outcome, 'auto');
    assert.equal(res.decision.requiresProdVerification, true);
  });

  it('POST /api/autonomy/verify-prod requires evidence', async () => {
    const { router, handlers } = fakeRouter();
    registerAutonomyRoutes(router, {});
    await assert.rejects(
      call(handlers, 'POST /api/autonomy/verify-prod', { query: {}, body: {} }),
      (e: unknown) => e instanceof RouteError && e.status === 400,
    );
  });
});
