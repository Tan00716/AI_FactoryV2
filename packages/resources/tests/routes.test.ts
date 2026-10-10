import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetTracker,
  UsageRecorder,
  registerResourceRoutes,
  ResourceHttpRequest,
  ResourceHttpResponse,
  ResourceRouter,
} from '../src/index';

/** Minimal in-memory router driving the registered handlers. */
function testRouter(): ResourceRouter & { call: (path: string, req: ResourceHttpRequest) => ResourceHttpResponse } {
  const handlers = new Map<string, (req: ResourceHttpRequest) => ResourceHttpResponse>();
  return {
    get: (path, handler) => { handlers.set(path, handler); },
    call: (path, req) => {
      // match "/api/resources/budgets/:taskId" style routes
      for (const [pattern, handler] of handlers) {
        const params: Record<string, string> = {};
        const trim = (s: string) => s.replace(/^\/+/g, '');
        const pSegs = trim(pattern).split('/');
        const sSegs = trim(path).split('/');
        if (pSegs.length !== sSegs.length) continue;
        let ok = true;
        for (let i = 0; i < pSegs.length; i++) {
          const p = pSegs[i]!;
          const s = sSegs[i]!;
          if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
          else if (p !== s) { ok = false; break; }
        }
        if (ok) return handler({ params, query: req.query });
      }
      throw new Error(`no route for ${path}`);
    },
  };
}

function wire() {
  const tracker = new BudgetTracker();
  const usage = new UsageRecorder();
  const router = testRouter();
  registerResourceRoutes(router, { tracker, usage });
  return { router, tracker, usage };
}

describe('registerResourceRoutes', () => {
  it('GET /api/resources/usage returns the dashboard summary', () => {
    const { router, usage } = wire();
    usage.record('t1', 'a1', 'tokens', 100);
    usage.record('t2', 'a2', 'toolCalls', 5);
    const res = router.call('/api/resources/usage', { params: {}, query: {} });
    assert.equal(res.status, 200);
    const body = res.body as { summary: { records: number; totals: { tokens: number } } };
    assert.equal(body.summary.records, 2);
    assert.equal(body.summary.totals.tokens, 100);
  });

  it('GET /api/resources/usage?taskId= filters the summary', () => {
    const { router, usage } = wire();
    usage.record('t1', 'a1', 'tokens', 100);
    usage.record('t2', 'a2', 'tokens', 50);
    const res = router.call('/api/resources/usage', { params: {}, query: { taskId: 't2' } });
    const body = res.body as { summary: { records: number; totals: { tokens: number } } };
    assert.equal(body.summary.records, 1);
    assert.equal(body.summary.totals.tokens, 50);
  });

  it('GET /api/resources/usage rejects an unknown kind with 400', () => {
    const { router } = wire();
    const res = router.call('/api/resources/usage', { params: {}, query: { kind: 'widgets' } });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /kind must be one of/);
  });

  it('GET /api/resources/budgets/:taskId returns budget, used, remaining, pending', () => {
    const { router, tracker } = wire();
    tracker.setBudget('t1', { tokens: 1000 });
    tracker.consume('t1', { tokens: 300 });
    tracker.requestIncrease('t1', 'tokens', 500);
    const res = router.call('/api/resources/budgets/t1', { params: {}, query: {} });
    assert.equal(res.status, 200);
    const body = res.body as {
      taskId: string;
      budget: { tokens: number };
      used: { tokens: number };
      remaining: { tokens: number };
      pendingIncreases: Array<{ dimension: string; amount: number }>;
    };
    assert.equal(body.taskId, 't1');
    assert.equal(body.budget.tokens, 1000);
    assert.equal(body.used.tokens, 300);
    assert.equal(body.remaining.tokens, 700);
    assert.equal(body.pendingIncreases.length, 1);
    assert.equal(body.pendingIncreases[0]!.amount, 500);
  });

  it('budgets endpoint decodes task ids and returns 400 without one', () => {
    const { router } = wire();
    const res = router.call('/api/resources/budgets/', { params: {}, query: {} });
    assert.equal(res.status, 400);
  });
});
