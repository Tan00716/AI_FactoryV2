/**
 * Authority conflict HTTP surface — spec §8.1, INV-31 (Batch 32-2).
 *
 * Exercises the real route handler (no server boot):
 *  - two different principals issue conflicting directives on the same run
 *    → AUTHORITY_CONFLICT opened, target paused, both directives recorded;
 *  - GET /api/authority/targets/:kind/:id reports paused;
 *  - a strictly higher-ranked human resolves → pause lifted;
 *  - every step lands in the audit log.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleAuthorityRoutes } from '../src/routes/authority.ts';

function makeCtx(body: unknown) {
  const jsonCalls: Array<{ status: number; body: unknown }> = [];
  const auditCalls: Array<{ action: string; details: Record<string, unknown> }> = [];
  const ctx = {
    audit: {
      record: (_a: string, action: string, _t: string, _e: string, details: Record<string, unknown>) => {
        auditCalls.push({ action, details });
      },
    },
    json: (_res: unknown, status: number, b: unknown) => {
      jsonCalls.push({ status, body: b });
    },
    readBody: async () => body,
  } as never;
  return { ctx, jsonCalls, auditCalls };
}

async function call(method: string, path: string, body: unknown = {}) {
  const { ctx, jsonCalls, auditCalls } = makeCtx(body);
  const handled = await handleAuthorityRoutes(
    { method, headers: {} } as never,
    {} as never,
    new URL(`http://localhost${path}`),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(jsonCalls.length, 1);
  return { status: jsonCalls[0].status, body: jsonCalls[0].body as Record<string, unknown>, auditCalls };
}

const TARGET = `run-ac-${Date.now()}`;

describe('POST /api/authority/directives — conflict flow', () => {
  it('two principals, conflicting directives → paused + audited', async () => {
    const r1 = await call('POST', '/api/authority/directives', {
      principalId: 'mgr-a', authorityLevel: 'manager',
      targetKind: 'run', targetId: TARGET, effect: 'ALLOW', instruction: 'proceed',
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body['conflict'], null);

    const r2 = await call('POST', '/api/authority/directives', {
      principalId: 'mgr-b', authorityLevel: 'manager',
      targetKind: 'run', targetId: TARGET, effect: 'BLOCK', instruction: 'hold for review',
    });
    assert.equal(r2.status, 200);
    const conflict = r2.body['conflict'] as Record<string, unknown>;
    assert.ok(conflict);
    assert.equal(conflict['status'], 'OPEN');
    assert.equal(r2.body['paused'], true);
    assert.equal((conflict['directiveIds'] as string[]).length, 2);
    const actions = r2.auditCalls.map((a) => a.action);
    assert.ok(actions.includes('AUTHORITY_DIRECTIVE_REGISTERED'));
    assert.ok(actions.includes('AUTHORITY_CONFLICT_DETECTED'));
  });

  it('GET targets/:kind/:id reports paused while open', async () => {
    const r = await call('GET', `/api/authority/targets/run/${TARGET}`);
    assert.equal(r.status, 200);
    assert.equal(r.body['paused'], true);
    assert.ok(r.body['openConflict']);
    assert.equal((r.body['directives'] as unknown[]).length, 2);
  });

  it('spec explicit case: security_authority BLOCK over manager ALLOW auto-resolves', async () => {
    const t = `${TARGET}-sec`;
    await call('POST', '/api/authority/directives', {
      principalId: 'mgr-c', authorityLevel: 'manager',
      targetKind: 'run', targetId: t, effect: 'ALLOW', instruction: 'go',
    });
    const r = await call('POST', '/api/authority/directives', {
      principalId: 'sec-1', authorityLevel: 'security_authority',
      targetKind: 'run', targetId: t, effect: 'BLOCK', instruction: 'security hold',
    });
    const conflict = r.body['conflict'] as Record<string, unknown>;
    assert.equal(conflict['status'], 'RESOLVED');
    assert.equal((conflict['resolution'] as Record<string, unknown>)['rule'], 'higher-authority-wins');
    assert.equal(r.body['paused'], false);
    assert.ok(r.auditCalls.some((a) => a.action === 'AUTHORITY_CONFLICT_AUTO_RESOLVED'));
  });

  it('human escalation resolves: owner decides, pause lifted, audited', async () => {
    const t = `${TARGET}-esc`;
    await call('POST', '/api/authority/directives', {
      principalId: 'mgr-d', authorityLevel: 'manager',
      targetKind: 'run', targetId: t, effect: 'ALLOW', instruction: 'go',
    });
    const c = await call('POST', '/api/authority/directives', {
      principalId: 'mgr-e', authorityLevel: 'manager',
      targetKind: 'run', targetId: t, effect: 'BLOCK', instruction: 'hold',
    });
    const conflict = c.body['conflict'] as Record<string, unknown>;
    const cid = conflict['conflictId'] as string;
    const winner = (conflict['directiveIds'] as string[])[0];

    // Sideways decider refused.
    const bad = await call('POST', `/api/authority/conflicts/${cid}/resolve`, {
      decidedByPrincipalId: 'mgr-f', decidedByLevel: 'manager',
      winningDirectiveId: winner, rationale: 'i say so',
    });
    assert.equal(bad.status, 400);

    const good = await call('POST', `/api/authority/conflicts/${cid}/resolve`, {
      decidedByPrincipalId: 'owner-1', decidedByLevel: 'owner',
      winningDirectiveId: winner, rationale: 'business priority',
    });
    assert.equal(good.status, 200);
    const resolved = good.body['conflict'] as Record<string, unknown>;
    assert.equal(resolved['status'], 'RESOLVED');
    assert.equal((resolved['resolution'] as Record<string, unknown>)['mode'], 'human');
    assert.ok(good.auditCalls.some((a) => a.action === 'AUTHORITY_CONFLICT_HUMAN_RESOLVED'));

    const probe = await call('GET', `/api/authority/targets/run/${t}`);
    assert.equal(probe.body['paused'], false);
  });

  it('GET conflicts lists; GET conflicts/:id shows directives', async () => {
    const list = await call('GET', '/api/authority/conflicts?status=OPEN');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body['conflicts']));
    assert.ok((list.body['conflicts'] as unknown[]).length >= 1);

    const open = (list.body['conflicts'] as Array<Record<string, unknown>>)[0];
    const one = await call('GET', `/api/authority/conflicts/${open['conflictId']}`);
    assert.equal(one.status, 200);
    assert.equal((one.body['directives'] as unknown[]).length, (open['directiveIds'] as unknown[]).length);
  });

  it('validation: unknown level is a 400, not a crash', async () => {
    const r = await call('POST', '/api/authority/directives', {
      principalId: 'x', authorityLevel: 'czar',
      targetKind: 'run', targetId: `${TARGET}-bad`, effect: 'ALLOW', instruction: '',
    });
    assert.equal(r.status, 400);
  });
});
