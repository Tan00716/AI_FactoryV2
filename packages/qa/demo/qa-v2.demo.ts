/**
 * QA v2 hardening demo — SPEC v2 §38.2–§38.4.
 *
 *  1. Machine-readable report: skipped mandatory test → gate BLOCKED.
 *  2. Runner errors (timeout) → FAIL, never PASS.
 *  3. Flaky test quarantine: anonymous/open-ended refused; valid quarantine
 *     keeps attempts; mandatory quarantine still BLOCKED.
 *  4. Repair: same fingerprint 3x without progress → STAGNATION;
 *     unreviewed test change → refused.
 *  5. UAT: AI-evaluated human-judgment AC → WAITING, never faked PASS.
 *
 * Run: npm run build -w @ai-factory/qa && node packages/qa/dist/demo/qa-v2.demo.js
 */
import {
  FlakeQuarantine,
  RepairTracker,
  StagnationError,
  UatManager,
  buildTestReport,
  reportGateVerdict,
} from '../src/index';

console.log('1. mandatory skipped test → gate BLOCKED');
const report = buildTestReport({
  categories: [
    { category: 'unit', verdict: 'PASS', total: 10, passed: 9, failed: 0, skipped: 1, durationMs: 50 },
  ],
  exitCode: 0,
  mandatorySkipped: ['unit:login-mandatory'],
});
console.log('   verdict:', reportGateVerdict(report), '(expected BLOCKED)');

console.log('2. runner timeout error → FAIL');
const bad = buildTestReport({
  categories: [
    { category: 'e2e', verdict: 'FAIL', total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 120000 },
  ],
  errors: 1,
  exitCode: 124,
});
console.log('   verdict:', reportGateVerdict(bad), '(expected FAIL)');

console.log('3. flake quarantine discipline');
const flaky = new FlakeQuarantine();
try {
  flaky.quarantine({ testId: 't-1', owner: '', expiresAt: '2030-01-01T00:00:00.000Z', policyRef: 'P', reason: 'r', quarantinedBy: 'qa' });
  console.log('   ERROR: anonymous quarantine allowed');
} catch {
  console.log('   anonymous quarantine refused: true');
}
flaky.recordAttempt('t-flaky', false);
flaky.recordAttempt('t-flaky', true);
flaky.quarantine({ testId: 't-flaky', owner: 'qa-lead', expiresAt: '2030-01-01T00:00:00.000Z', policyRef: 'FLAKE-POLICY-1', reason: 'infra flake', quarantinedBy: 'qa-lead' });
console.log('   attempts retained:', flaky.getAttempts('t-flaky').length, '| quarantined:', flaky.isQuarantined('t-flaky'));

console.log('4. repair stagnation');
const tracker = new RepairTracker({ maxAttempts: 10 });
const msg = 'AssertionError: expected 200 to be 201';
tracker.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
tracker.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
try {
  tracker.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
  console.log('   ERROR: stagnation not detected');
} catch (err) {
  console.log('   stagnation detected:', err instanceof StagnationError);
}

console.log('5. UAT human-judgment AC stays WAITING');
const uat = new UatManager();
const s = uat.start({ taskId: 'T-1', candidateDigest: 'cand-1', mode: 'both', humanJudgmentAcIds: ['AC-UX-1'] });
const r = uat.recordAc(s.id, { acId: 'AC-UX-1', method: 'auto', result: 'PASS', evaluatedBy: 'ai-qa' });
console.log('   AC result:', r.result, '(expected WAITING) | session:', uat.get(s.id).status);

console.log('demo complete');
