/**
 * Factory control demo — SPEC v2 §24.
 *
 *  RUNNING → EMERGENCY_STOP with 2 workers: the display reads
 *  "EMERGENCY_STOPPED (pending — …)" until both ACKs arrive; only then is
 *  the terminal state confirmed. Health/capacity axes move independently.
 *
 * Run after building the package:
 *   npx tsc -p packages/factory-control/tsconfig.json
 *   node packages/factory-control/dist/demo/factory-control.demo.js
 */
import { FactoryController } from '../src/index';

const c = new FactoryController({
  revokeExecution: (e) => console.log(`  [hook] execution permissions revoked @epoch ${e}`),
  terminateManagedTrees: (e) => {
    console.log(`  [hook] factory-managed dev process trees terminated @epoch ${e}`);
    return ['pid:4242'];
  },
  markExternalUnknown: (e) => {
    console.log(`  [hook] in-flight external actions → UNKNOWN, queued for coordination @epoch ${e}`);
    return ['deploy:op-9'];
  },
});

c.registerWorker('worker-1');
c.registerWorker('worker-2');

let epoch = c.request('START', { requested_by: 'human:tan', scope: 'factory' });
for (const w of ['worker-1', 'worker-2']) {
  c.ack({ worker_id: w, control_epoch: epoch, stopped_at: 'n/a', active_tools: [], live_processes: [], acked_at: '' });
}
console.log('after START:', c.status().display);

c.setCapacity('QUOTA_LIMITED');
console.log('quota hit:  ', c.status().display, '(control axis untouched)');

console.log('--- EMERGENCY STOP ---');
epoch = c.request('EMERGENCY_STOP', { requested_by: 'human:tan', scope: 'factory' });
console.log('display:  ', c.status().display);

c.ack({ worker_id: 'worker-1', control_epoch: epoch, stopped_at: 'checkpoint:41', active_tools: [], live_processes: [], acked_at: '' });
console.log('1 ACK:    ', c.status().display);

c.ack({ worker_id: 'worker-2', control_epoch: epoch, stopped_at: 'checkpoint:12', active_tools: ['deploy'], live_processes: [777], acked_at: '' });
console.log('all ACKs: ', c.status().display);
console.log('prohibitions:', c.prohibitions().join(' | '));
console.log('done.');
