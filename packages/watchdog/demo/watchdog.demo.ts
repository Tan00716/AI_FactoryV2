/**
 * Watchdog demo — SPEC v2 §30.
 *
 *  worker-a : healthy, heartbeating.
 *  worker-b : goes silent → SUSPECTED_STALL → (unreconnectable) STALLED →
 *             diagnosed worker-lost → policy-approved restart.
 *  worker-c : waiting on a human approval — stays WAITING, never "recovered".
 *  worker-d : restart storm → circuit breaker opens, supervisor notified.
 *
 * Run after building the package:
 *   npx tsc -p packages/watchdog/tsconfig.json
 *   node packages/watchdog/dist/demo/watchdog.demo.js
 */
import { Watchdog } from '../src/index';

let now = 0;
const notifications: string[] = [];
const wd = new Watchdog([], {
  now: () => now,
  policyGate: (action, workerId, reason) => {
    console.log(`[policy] allow ${action} ${workerId}: ${reason}`);
    return true;
  },
  onNotify: (m) => notifications.push(m),
  maxRestartsPerWindow: 2,
  recoveryCooldownMs: 0,
});

for (const id of ['worker-a', 'worker-b', 'worker-c', 'worker-d']) wd.registerWorker(id);
for (const id of ['worker-a', 'worker-b', 'worker-c', 'worker-d']) wd.heartbeat(id);
wd.reportSignals('worker-c', { approvalWait: true, explicitState: 'WAITING' });

const show = (label: string) => {
  console.log(`--- t=${now}ms ${label} ---`);
  for (const s of wd.tick()) {
    console.log(`  ${s.workerId}: ${s.health} (${s.diagnosis})`);
  }
};

now = 1_000;
wd.heartbeat('worker-a'); // only a keeps beating
show('a alive, others silent');

now = 16_000;
wd.heartbeat('worker-a');
show('15s silence: b/d suspected; c still WAITING (approval, not a stall)');

now = 70_000;
wd.setReconnectable('worker-b', false);
wd.heartbeat('worker-a');
show('b unreconnectable → STALLED/worker-lost');

const rec = wd.requestRecovery('worker-b', 'restart', 'worker-lost, host confirms dead');
console.log(`recovery: ${rec.action} ${rec.workerId} (diagnosis=${rec.diagnosis})`);

try {
  wd.requestRecovery('worker-c', 'kill', 'looks stuck');
  console.log('ERROR: approval-waiter was killed');
} catch (err) {
  console.log(`guard held: ${(err as Error).message.slice(0, 60)}…`);
}

console.log('--- restart storm on worker-d ---');
for (let i = 0; i < 3; i += 1) {
  try {
    wd.requestRecovery('worker-d', 'restart', `storm ${i}`);
    console.log(`  restart ${i} ok`);
  } catch (err) {
    console.log(`  restart ${i} refused: ${(err as Error).message.slice(0, 70)}…`);
  }
}
console.log('notifications:', notifications);
console.log('watchdog self-health:', wd.selfHealth());
console.log('done.');
