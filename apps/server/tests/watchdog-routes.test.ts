/**
 * Watchdog route tests — SPEC v2 §30.
 *
 * The route's policyGate must be fail-closed: without a policy engine in the
 * route context, kill/restart recovery is denied (403) rather than allowed
 * by an always-true stub.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  denyWatchdogRecovery,
  handleWatchdogRoutes,
} from '../src/routes/watchdog.ts';

function makeCtx(body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      readBody: async () => body,
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
      audit: { record: () => {} },
    } as never,
    calls,
  };
}

async function post(path: string, body: Record<string, unknown>) {
  const { ctx, calls } = makeCtx(body);
  const handled = await handleWatchdogRoutes(
    { method: 'POST' } as never,
    {} as never,
    new URL(`http://localhost${path}`),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

describe('watchdog route policy gate (§30)', () => {
  it('denyWatchdogRecovery is fail-closed', () => {
    assert.equal(denyWatchdogRecovery(), false);
  });

  it('recover (kill/restart) is denied 403 without a policy engine', async () => {
    const reg = await post('/api/watchdog/workers', { worker_id: 'w-gate-test' });
    assert.equal(reg.status, 201);

    const rec = await post('/api/watchdog/workers/w-gate-test/recover', {
      action: 'kill',
      reason: 'looks stuck',
    });
    assert.equal(rec.status, 403);
    assert.match(
      (rec.body as { error: string }).error,
      /no policy engine is wired in — refused fail-closed/,
    );
  });
});
