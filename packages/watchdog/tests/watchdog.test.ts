import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitOpen,
  DEFAULT_HEARTBEAT_CONFIG,
  PolicyDeniedRecovery,
  Watchdog,
} from '../src/index';

function wd(opts: Record<string, unknown> = {}) {
  let now = 0;
  const w = new Watchdog([], { now: () => now, ...(opts as object) });
  return { w, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('heartbeat → stall (§30 defaults)', () => {
  it('uses the 5s / 3-miss / 60s engineering defaults', () => {
    assert.equal(DEFAULT_HEARTBEAT_CONFIG.intervalMs, 5_000);
    assert.equal(DEFAULT_HEARTBEAT_CONFIG.missLimit, 3);
    assert.equal(DEFAULT_HEARTBEAT_CONFIG.stallAfterMs, 60_000);
  });

  it('3 consecutive misses → SUSPECTED_STALL', () => {
    const { w, advance } = wd();
    w.registerWorker('w1');
    w.heartbeat('w1');
    advance(5_000); w.tick();
    assert.equal(w.getStatus('w1').consecutiveMisses, 1);
    assert.equal(w.getStatus('w1').health, 'HEALTHY');
    advance(10_000); w.tick(); // 15s total → 3 misses
    const s = w.getStatus('w1');
    assert.equal(s.consecutiveMisses, 3);
    assert.equal(s.health, 'SUSPECTED_STALL');
  });

  it('60s silence + unreconnectable → STALLED', () => {
    const { w, advance } = wd();
    w.registerWorker('w1');
    w.heartbeat('w1');
    w.setReconnectable('w1', false);
    advance(61_000);
    w.tick();
    assert.equal(w.getStatus('w1').health, 'STALLED');
    assert.equal(w.getStatus('w1').diagnosis, 'worker-lost');
  });

  it('60s silence but reconnectable → SUSPECTED_STALL, not STALLED', () => {
    const { w, advance } = wd();
    w.registerWorker('w1');
    w.heartbeat('w1');
    advance(61_000);
    w.tick();
    assert.equal(w.getStatus('w1').health, 'SUSPECTED_STALL');
  });

  it('a heartbeat during suspected stall moves to RECOVERING', () => {
    const { w, advance } = wd();
    w.registerWorker('w1');
    w.heartbeat('w1');
    advance(20_000); w.tick();
    assert.equal(w.getStatus('w1').health, 'SUSPECTED_STALL');
    w.heartbeat('w1');
    assert.equal(w.getStatus('w1').health, 'RECOVERING');
  });
});

describe('waiting is not a stall (§30)', () => {
  it('approval-wait stays WAITING despite heartbeat gaps', () => {
    const { w, advance } = wd();
    w.registerWorker('w1');
    w.heartbeat('w1');
    w.reportSignals('w1', { approvalWait: true, explicitState: 'WAITING' });
    advance(120_000);
    w.tick();
    const s = w.getStatus('w1');
    assert.equal(s.health, 'WAITING');
    assert.equal(s.diagnosis, 'approval-wait');
  });

  it('refuses to kill an approval-waiting worker', () => {
    const { w } = wd();
    w.registerWorker('w1');
    w.reportSignals('w1', { approvalWait: true });
    assert.throws(() => w.requestRecovery('w1', 'kill', 'looks stuck'), PolicyDeniedRecovery);
  });
});

describe('diagnosis before recovery (§30)', () => {
  it('distinguishes quota/auth, lock-wait, loop-stagnation, tool-hung', () => {
    const { w, advance } = wd();
    w.registerWorker('w1');
    w.reportSignals('w1', { quotaOrAuthBlocked: true });
    assert.equal(w.diagnose('w1').diagnosis, 'quota-or-auth');

    w.registerWorker('w2');
    w.reportSignals('w2', { lockWait: true });
    assert.equal(w.diagnose('w2').diagnosis, 'lock-or-dependency-wait');

    w.registerWorker('w3');
    w.reportSignals('w3', { loopStagnated: true });
    assert.equal(w.diagnose('w3').diagnosis, 'loop-stagnation');

    w.registerWorker('w4');
    w.heartbeat('w4');
    w.reportSignals('w4', { lastToolActivityAt: 0 });
    advance(61_000);
    assert.equal(w.diagnose('w4').diagnosis, 'tool-hung');
  });
});

describe('recovery discipline (§30)', () => {
  it('kill/restart go through the policy gate', () => {
    const { w } = wd({ policyGate: () => false });
    w.registerWorker('w1');
    assert.throws(() => w.requestRecovery('w1', 'restart', 'stalled'), PolicyDeniedRecovery);
  });

  it('circuit breaker opens after too many restarts', () => {
    const notified: string[] = [];
    const { w, advance } = wd({
      onNotify: (m: string) => notified.push(m),
      maxRestartsPerWindow: 2,
      circuitWindowMs: 300_000,
      recoveryCooldownMs: 0,
    });
    w.registerWorker('w1');
    w.setReconnectable('w1', false);
    w.requestRecovery('w1', 'restart', 'r1');
    advance(1_000);
    w.requestRecovery('w1', 'restart', 'r2');
    advance(1_000);
    assert.throws(() => w.requestRecovery('w1', 'restart', 'r3'), CircuitOpen);
    assert.ok(notified.some((m) => m.includes('circuit open')));
  });

  it('cooldown spaces recovery actions', () => {
    const { w, advance } = wd({ recoveryCooldownMs: 30_000 });
    w.registerWorker('w1');
    w.requestRecovery('w1', 'restart', 'r1');
    advance(5_000);
    assert.throws(() => w.requestRecovery('w1', 'restart', 'r2'), /throttled/);
    advance(30_000);
    w.requestRecovery('w1', 'restart', 'r3'); // ok after cooldown
    assert.equal(w.recoveryHistory().length, 2);
  });

  it('per-tool thresholds are configurable and versioned', () => {
    let now = 0;
    const long = new Watchdog(
      [
        {
          scope: 'tool:pytest',
          config: { intervalMs: 5_000, missLimit: 3, stallAfterMs: 600_000, version: 'pytest-thresholds@2' },
        },
      ],
      { now: () => now },
    );
    long.registerWorker('w-pytest', 'tool:pytest');
    long.heartbeat('w-pytest');
    long.setReconnectable('w-pytest', false);
    now = 61_000; // past the 60s default, inside the 600s pytest override
    long.tick();
    // Still only suspected: the pytest override keeps it out of STALLED.
    assert.equal(long.getStatus('w-pytest').health, 'SUSPECTED_STALL');
    now = 601_000;
    long.tick();
    assert.equal(long.getStatus('w-pytest').health, 'STALLED');
  });

  it('watchdog tracks its own health', () => {
    const { w, advance } = wd();
    assert.equal(w.selfHealth(), 'ok');
    w.tick(); // establish baseline
    advance(25_000); // > 4x the 5s interval without a tick
    w.tick();
    assert.equal(w.selfHealth(), 'degraded');
  });
});
