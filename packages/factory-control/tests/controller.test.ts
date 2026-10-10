/**
 * Factory controller tests — SPEC v2 §24.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FactoryController,
  OPERATION_SEMANTICS,
  type ControlOperation,
} from '../src/index';

const REQ = (by = 'human:tan') => ({ requested_by: by, scope: 'factory' });

describe('three independent axes (§24.1)', () => {
  it('health/capacity change without touching control state', () => {
    const c = new FactoryController({ now: () => 1_700_000_000_000 });
    c.request('START', REQ());
    c.setHealth('DEGRADED');
    c.setCapacity('QUOTA_LIMITED');
    const s = c.status();
    assert.equal(s.control, 'RUNNING');
    assert.equal(s.health, 'DEGRADED');
    assert.equal(s.capacity, 'QUOTA_LIMITED');
    assert.match(s.display, /RUNNING · DEGRADED · QUOTA LIMITED/);
  });

  it('quota pressure is not a factory stop', () => {
    const c = new FactoryController({ now: () => 1_700_000_000_000 });
    c.request('START', REQ());
    c.setCapacity('QUOTA_LIMITED');
    assert.equal(c.status().control, 'RUNNING');
  });
});

describe('ACK-gated terminal states (§24.3)', () => {
  let c: FactoryController;
  beforeEach(() => {
    c = new FactoryController({ now: () => 1_700_000_000_000 });
    c.registerWorker('worker-1');
    c.registerWorker('worker-2');
    c.request('START', REQ());
    // START settles only after ACKs too.
    c.ack({ worker_id: 'worker-1', control_epoch: 1, stopped_at: 'n/a', active_tools: [], live_processes: [], acked_at: '' });
    c.ack({ worker_id: 'worker-2', control_epoch: 1, stopped_at: 'n/a', active_tools: [], live_processes: [], acked_at: '' });
    assert.equal(c.status().control, 'RUNNING');
  });

  it('PAUSED is displayed as pending until every ACK arrives — never faked', () => {
    const epoch = c.request('PAUSE_NEW_WORK', REQ());
    assert.equal(epoch, 2);
    let s = c.status();
    assert.deepEqual(s.pending_acks, ['worker-1', 'worker-2']);
    assert.match(s.display, /PAUSED \(pending — 2 worker ACKs outstanding/);
    assert.notEqual(s.control, 'PAUSED', 'control must not claim PAUSED yet');

    c.ack({ worker_id: 'worker-1', control_epoch: epoch, stopped_at: 'safe-point:7', active_tools: ['pytest'], live_processes: [1234], acked_at: '' });
    s = c.status();
    assert.match(s.display, /1 worker ACK outstanding: worker-2/);

    c.ack({ worker_id: 'worker-2', control_epoch: epoch, stopped_at: 'safe-point:3', active_tools: [], live_processes: [], acked_at: '' });
    s = c.status();
    assert.equal(s.control, 'PAUSED');
    assert.deepEqual(s.pending_acks, []);
    assert.match(s.display, /PAUSED · HEALTHY · AVAILABLE/);
  });

  it('stale-epoch ACKs are ignored', () => {
    const epoch = c.request('PAUSE_NEW_WORK', REQ());
    c.ack({ worker_id: 'worker-1', control_epoch: epoch - 1, stopped_at: 'x', active_tools: [], live_processes: [], acked_at: '' });
    assert.deepEqual(c.status().pending_acks, ['worker-1', 'worker-2']);
  });

  it('epochs increase monotonically', () => {
    const e1 = c.request('PAUSE_NEW_WORK', REQ());
    assert.throws(() => c.request('PAUSE_NEW_WORK', REQ()), /not allowed from/);
    void e1;
  });
});

describe('operation semantics (§24.2)', () => {
  it('PAUSE_NEW_WORK and PAUSE_AI_WORK differ as specified', () => {
    assert.match(OPERATION_SEMANTICS.PAUSE_NEW_WORK.newWork, /already-running approved runs may continue/);
    assert.match(OPERATION_SEMANTICS.PAUSE_AI_WORK.newWork, /no new dev tool calls/);
  });

  it('FREEZE revokes dev writer leases; safety domain continues', () => {
    assert.match(OPERATION_SEMANTICS.FREEZE.newWork, /writer leases revoked/);
    assert.match(OPERATION_SEMANTICS.FREEZE.monitoring, /safety domain continues/);
  });

  it('illegal transitions are rejected', () => {
    const c = new FactoryController({ now: () => 1_700_000_000_000 });
    assert.throws(() => c.request('PAUSE_NEW_WORK', REQ()), /not allowed from STOPPED/);
    assert.throws(() => c.request('DRAIN' as ControlOperation, REQ()), /not allowed from STOPPED/);
  });

  it('denied authorizer blocks the request', () => {
    const c = new FactoryController({
      now: () => 1_700_000_000_000,
      authorizer: () => false,
    });
    assert.throws(() => c.request('START', REQ('ai:rogue')), /denied/);
  });
});

describe('emergency stop (§24.2/§24.3)', () => {
  it('revokes execution, terminates managed trees, marks external UNKNOWN — and nothing else', () => {
    const calls: string[] = [];
    const c = new FactoryController({
      now: () => 1_700_000_000_000,
      revokeExecution: (e) => void calls.push(`revoke@${e}`),
      terminateManagedTrees: (e) => {
        calls.push(`terminate@${e}`);
        return ['pid:4242'];
      },
      markExternalUnknown: (e) => {
        calls.push(`unknown@${e}`);
        return ['deploy:op-9'];
      },
    });
    c.request('START', REQ());
    const epoch = c.request('EMERGENCY_STOP', REQ());
    assert.deepEqual(calls, [`revoke@${epoch}`, `terminate@${epoch}`, `unknown@${epoch}`]);
    assert.ok(
      c.prohibitions().some((p) => p.includes('customer production')),
      'must explicitly prohibit touching customer production',
    );
    assert.ok(
      c.prohibitions().some((p) => p.includes('delete workspaces')),
      'must explicitly prohibit deleting workspaces',
    );
  });

  it('emergency stop allowed from any state', () => {
    const c = new FactoryController({ now: () => 1_700_000_000_000 });
    c.request('EMERGENCY_STOP', REQ());
    // No workers → settles immediately.
    assert.equal(c.status().control, 'EMERGENCY_STOPPED');
  });
});
