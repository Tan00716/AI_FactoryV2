/**
 * Demo: two coders editing the same file get detected and serialized.
 *
 * Scenario (§62 pipeline):
 *   coder-a edits src/payment/service.ts + src/payment/util.ts
 *   coder-b edits src/payment/service.ts + src/ui/checkout.tsx
 *
 * 1. detectOverlap finds the same-file overlap on service.ts.
 * 2. resolveOverlap('warn') → coordinate → serialize plan (never silently
 *    overwrite).
 * 3. File locks (§63) make the serialization concrete: coder-b's lock
 *    request is rejected/queued until coder-a releases.
 * 4. mergeCheck gates the merge on the test hook.
 *
 * Run after building the package:
 *   npx tsc -p packages/coordination/tsconfig.json
 *   node packages/coordination/dist/demo/parallel-conflict.demo.js
 */
import {
  detectOverlap,
  LockManager,
  mergeCheck,
  resolveOverlap,
} from '../src/index';

function log(...parts: unknown[]): void {
  console.log(...parts);
}

const coderAFiles = ['src/payment/service.ts', 'src/payment/util.ts'];
const coderBFiles = ['src/payment/service.ts', 'src/ui/checkout.tsx'];

log('coder-a changes:', coderAFiles.join(', '));
log('coder-b changes:', coderBFiles.join(', '));
log('');

// 1. Detect.
const report = detectOverlap(coderAFiles, coderBFiles);
log(`overlap detected: ${report.hasOverlap}`);
for (const o of report.overlaps) {
  log(`  - ${o.kind}: "${o.pathA}" vs "${o.pathB}"`);
}
log('');

// 2. Warn → coordinate → serialize.
const plan = resolveOverlap(report, 'warn');
log(`decision: ${plan.decision}`);
for (const w of plan.warnings) log(`  WARN: ${w}`);
for (const s of plan.steps) log(`  ${s}`);
log('');

// 3. Serialization enforced with file locks.
const locks = new LockManager({
  audit: (e) => log(`  [audit] ${e.type} ${e.kind}:${e.key} holder=${e.holder}`),
});
const lockA = locks.acquire('file', 'src/payment/service.ts', 'coder-a', 60_000);
log(`coder-a locks service.ts: granted=${lockA.granted}`);
const lockB = locks.acquire('file', 'src/payment/service.ts', 'coder-b', 60_000);
log(`coder-b locks service.ts: granted=${lockB.granted} queued=${lockB.queued} heldBy=${lockB.heldBy}`);
locks.release(lockA.token!); // coder-a finishes; FIFO waiter auto-granted
log(`coder-a done → coder-b now holds lock: ${locks.isHeldBy('file', 'src/payment/service.ts', 'coder-b')}`);
log('');

// 4. Merge gate: tests must pass before overlapped files are released.
const blocked = mergeCheck(report);
log(`merge without tests: allowed=${blocked.allowed} (${blocked.reason})`);
const released = mergeCheck(report, () => {
  log('  running test suite… all green');
  return true;
});
log(`merge after tests: allowed=${released.allowed} (${released.reason})`);
