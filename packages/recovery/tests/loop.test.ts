import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  RecoveryLoop,
  SnapshotStore,
  type RecoveryAuditEvent,
} from '../src/index';
import { tempDir, writeTree, cleanup } from './helpers';

describe('RecoveryLoop', () => {
  it('flaky function: fails twice, then succeeds', async () => {
    const events: RecoveryAuditEvent[] = [];
    const loop = new RecoveryLoop({ maxAttempts: 5, audit: (e) => events.push(e) });
    let calls = 0;
    const res = await loop.run(async () => {
      calls++;
      if (calls < 3) throw new Error('3 tests failed: flaky assertion');
      return 'ok';
    });
    assert.equal(res.status, 'success');
    assert.equal(res.attempts, 3);
    assert.equal(res.value, 'ok');
    assert.equal(res.history.length, 2);
    assert.deepEqual(
      res.history.map((h) => h.strategy),
      ['retry', 'retry'],
    );
    assert.deepEqual(
      res.history.map((h) => h.failureType),
      ['TEST_ERROR', 'TEST_ERROR'],
    );
  });

  it('exhausted attempts → aborted with the last failure recorded', async () => {
    const loop = new RecoveryLoop({ maxAttempts: 3 });
    let calls = 0;
    const res = await loop.run(async () => {
      calls++;
      throw new Error('model overloaded, please retry later');
    });
    assert.equal(res.status, 'aborted');
    assert.equal(res.attempts, 3);
    assert.equal(calls, 3);
    assert.equal(res.failure?.type, 'MODEL_ERROR');
  });

  it('ask-human strategy → escalated status', async () => {
    const loop = new RecoveryLoop({ maxAttempts: 5 });
    const res = await loop.run(async () => {
      throw new Error('permission denied: EACCES');
    });
    assert.equal(res.status, 'escalated');
    assert.equal(res.attempts, 1);
    assert.equal(res.failure?.type, 'PERMISSION_ERROR');
    assert.equal(res.history[0]?.strategy, 'ask-human');
  });

  it('a strategy hook can resolve the failure without another attempt', async () => {
    const loop = new RecoveryLoop({
      maxAttempts: 5,
      hooks: {
        'create-specialist': async () => ({ type: 'resolved', value: 'fixed-by-specialist' }),
      },
    });
    let calls = 0;
    const res = await loop.run(async () => {
      calls++;
      if (calls <= 3) throw new Error('tests failed');
      throw new Error('should not reach here');
    });
    assert.equal(res.status, 'success');
    assert.equal(res.value, 'fixed-by-specialist');
    assert.equal(calls, 3); // hook resolved on the 3rd failure (TEST_ERROR attempt 2 → create-specialist)
  });

  it('audit events arrive in lifecycle order', async () => {
    const events: RecoveryAuditEvent[] = [];
    const loop = new RecoveryLoop({
      maxAttempts: 2,
      audit: (e) => events.push(e),
    });
    await loop.run(async () => {
      throw new Error('out of memory: heap exhausted');
    });
    const kinds = events.map((e) => e.event);
    assert.deepEqual(kinds, [
      'run_started',
      'attempt_failed',
      'strategy_selected',
      'strategy_executed',
      'attempt_failed',
      'strategy_selected',
      'strategy_executed',
      'run_aborted',
    ]);
  });

  it('strategy hook receives the classification and recommendation', async () => {
    let seen: unknown = null;
    const loop = new RecoveryLoop({
      maxAttempts: 1,
      hooks: {
        retry: async (ctx) => {
          seen = ctx;
          return { type: 'abort', reason: 'stop' };
        },
      },
    });
    await loop.run(async () => {
      throw new Error('out of memory: heap exhausted');
    });
    const ctx = seen as { strategy: string; attempt: number; failure: { type: string } };
    assert.equal(ctx.strategy, 'retry');
    assert.equal(ctx.attempt, 0);
    assert.equal(ctx.failure.type, 'RESOURCE_LIMIT');
  });

  it('snapshot-restore hook: failed deploy rolls back, then succeeds', async () => {
    const root = tempDir('recovery-store-');
    const ws = tempDir('ws-');
    const store = new SnapshotStore(root);
    writeTree(ws, { 'app.js': 'v1 stable' });
    const snap = store.take(ws, { tag: 'before production deployment' });
    writeFileSync(join(ws, 'app.js'), 'v2 BROKEN {{{');

    const events: RecoveryAuditEvent[] = [];
    let calls = 0;
    const loop = new RecoveryLoop({
      maxAttempts: 4,
      audit: (e) => events.push(e),
      hooks: {
        // §78 'revert-change': roll back the failed deploy to the snapshot.
        'revert-change': async () => {
          store.restore(snap.id, ws);
          return { type: 'retry' };
        },
      },
    });
    try {
      const res = await loop.run(async () => {
        calls++;
        const content = readFileSync(join(ws, 'app.js'), 'utf8');
        if (calls <= 2) throw new Error('build failed: failed to compile app.js');
        if (!content.startsWith('v1 stable')) throw new Error('deploy verification failed');
        return 'deployed';
      });
      assert.equal(res.status, 'success');
      assert.equal(res.value, 'deployed');
      assert.equal(readFileSync(join(ws, 'app.js'), 'utf8'), 'v1 stable');
      assert.ok(
        events.some((e) => e.event === 'strategy_selected' && e.strategy === 'revert-change'),
      );
    } finally {
      cleanup(root, ws);
    }
  });
});
