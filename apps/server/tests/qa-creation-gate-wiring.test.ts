/**
 * QA creation gate wiring — INV-08 / Batch 66-d.
 *
 * The QaCreationGate mechanism (packages/qa, Batch 64) is now wired into
 * the server path: routes/qa.ts passes a gate read from the server's
 * FactoryPolicyStore (RouteContext.factoryPolicyStore, constructed in
 * index.ts) on both auto-creation sites — GET /api/qa/org (ensureQaLead)
 * and POST /api/qa/specialists (createQaSpecialist). A denied policy
 * throws GovernanceError → 403 {governance: true}, and nothing is
 * registered.
 *
 * Handler-level test against the compiled route (dual-mode: dist only,
 * node builtins). The ctx is hand-built: a real AgentRegistry, a real
 * FactoryPolicyStore, captured json output.
 *
 * Honest boundary: the DEFAULT policy (QA_CREATION_POLICY) is
 * intentionally permissive for the existing QA flow (filesystem tool,
 * default model, 16 children headroom) — the gate enforces whatever
 * policy is configured; tightening values is a per-deployment product
 * decision, and the store is the seam for it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'http';
import { AgentRegistry } from '@ai-factory/core';
import {
  FactoryPolicyStore,
  QA_CREATION_POLICY,
} from '@ai-factory/employee-factory';
import { handleQaRoutes } from '../dist/routes/qa.js';
import type { RouteContext } from '../dist/routes/context.js';

function makeCtx(store: FactoryPolicyStore, body: Record<string, unknown> = {}) {
  const seen: Array<{ status: number; body: unknown }> = [];
  const ctx = {
    agents: new AgentRegistry(),
    audit: { record: () => undefined },
    json: (_res: ServerResponse, status: number, payload: unknown) => {
      seen.push({ status, body: payload });
    },
    readBody: async (_req: IncomingMessage) => body,
    factoryPolicyStore: store,
  } as unknown as RouteContext;
  return { ctx, seen };
}

const req = { method: 'POST' } as unknown as IncomingMessage;
const res = {} as unknown as ServerResponse;

describe('QA creation gate wiring (INV-08 / Batch 66-d)', () => {
  it('default policy: POST /api/qa/specialists creates (201)', async () => {
    const { ctx, seen } = makeCtx(new FactoryPolicyStore(), { kind: 'API' });
    const handled = await handleQaRoutes(
      req,
      res,
      new URL('http://x/api/qa/specialists'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 201);
    const payload = seen[0].body as { specialist: { name: string } };
    assert.equal(payload.specialist.name, 'qa-api');
  });

  it('restrictive policy: creation denied with 403 and zero registration', async () => {
    const store = new FactoryPolicyStore();
    store.setProjectPolicy('default', { ...QA_CREATION_POLICY, allowedRoles: ['engineer'] });
    const { ctx, seen } = makeCtx(store, { kind: 'API' });
    const handled = await handleQaRoutes(
      req,
      res,
      new URL('http://x/api/qa/specialists'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 403);
    const payload = seen[0].body as { governance: boolean; error: string };
    assert.equal(payload.governance, true);
    assert.match(payload.error, /Governance denied/);
    assert.equal(ctx.agents.list().length, 0, 'denied creation must register nothing');
  });

  it('restrictive policy: GET /api/qa/org is gated too (ensureQaLead)', async () => {
    const store = new FactoryPolicyStore();
    store.setProjectPolicy('default', { ...QA_CREATION_POLICY, allowedRoles: ['engineer'] });
    const { ctx, seen } = makeCtx(store);
    const handled = await handleQaRoutes(
      { method: 'GET' } as unknown as IncomingMessage,
      res,
      new URL('http://x/api/qa/org'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(seen[0].status, 403);
    assert.equal((seen[0].body as { governance: boolean }).governance, true);
  });

  it('unwired store: falls back to QA_CREATION_POLICY defaults (behavior unchanged)', async () => {
    const seen: Array<{ status: number; body: unknown }> = [];
    const ctx = {
      agents: new AgentRegistry(),
      audit: { record: () => undefined },
      json: (_res: ServerResponse, status: number, payload: unknown) => {
        seen.push({ status, body: payload });
      },
      readBody: async () => ({ kind: 'Smoke' }),
      // factoryPolicyStore omitted — embedder without the store
    } as unknown as RouteContext;
    const handled = await handleQaRoutes(
      req,
      res,
      new URL('http://x/api/qa/specialists'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(seen[0].status, 201);
  });

  it('FactoryPolicyStore: unknown project falls back to the default policy', () => {
    const store = new FactoryPolicyStore();
    assert.deepEqual(store.forProject('no-such-project'), QA_CREATION_POLICY);
    store.setProjectPolicy('proj-9', { ...QA_CREATION_POLICY, maxChildren: 2 });
    assert.equal(store.forProject('proj-9').maxChildren, 2);
    assert.equal(store.forProject('other').maxChildren, QA_CREATION_POLICY.maxChildren);
    store.clear();
    assert.equal(store.forProject('proj-9').maxChildren, QA_CREATION_POLICY.maxChildren);
  });
});
