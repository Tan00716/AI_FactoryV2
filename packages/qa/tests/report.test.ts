/**
 * Tests for v2 §38.2: machine-readable report, gate verdict, skipped≠PASS.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTestReport,
  environmentFingerprint,
  isAllGreen,
  reportGateVerdict,
  CategoryResult,
} from '../src/index';

function cat(over: Partial<CategoryResult> = {}): CategoryResult {
  return {
    category: 'unit',
    verdict: 'PASS',
    total: 10,
    passed: 10,
    failed: 0,
    skipped: 0,
    durationMs: 100,
    ...over,
  };
}

describe('buildTestReport', () => {
  it('recomputes counts and carries the §38.2 field set', () => {
    const r = buildTestReport({
      categories: [cat(), cat({ category: 'api', total: 5, passed: 4, skipped: 1 })],
      errors: 0,
      exitCode: 0,
      durationMs: 250,
      artifactRefs: ['art-1'],
      environmentLabels: { candidate: 'abc123' },
    });
    assert.equal(r.total, 15);
    assert.equal(r.passed, 14);
    assert.equal(r.skipped, 1);
    assert.equal(r.errors, 0);
    assert.equal(r.exitCode, 0);
    assert.ok(r.environmentFingerprint.startsWith('env:'));
    assert.deepEqual(r.artifactRefs, ['art-1']);
    assert.ok(r.reportedAt.length > 0);
  });

  it('environment fingerprint is stable for identical labels', () => {
    const a = environmentFingerprint({ candidate: 'x' });
    const b = environmentFingerprint({ candidate: 'x' });
    const c = environmentFingerprint({ candidate: 'y' });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('reportGateVerdict — skipped/timeout/missing-tool/infra ≠ PASS', () => {
  it('all green → PASS', () => {
    const r = buildTestReport({ categories: [cat()], exitCode: 0 });
    assert.equal(reportGateVerdict(r), 'PASS');
    assert.equal(isAllGreen(r), true);
  });

  it('any failure → FAIL', () => {
    const r = buildTestReport({
      categories: [cat({ verdict: 'FAIL', total: 3, passed: 2, failed: 1 })],
    });
    assert.equal(reportGateVerdict(r), 'FAIL');
  });

  it('runner errors (timeout/missing tool/infra) → FAIL, never PASS', () => {
    const r = buildTestReport({ categories: [cat()], errors: 2, exitCode: 1 });
    assert.equal(r.failed + r.errors > 0, true);
    assert.equal(reportGateVerdict(r), 'FAIL');
    assert.equal(isAllGreen(r), false);
  });

  it('mandatory test skipped → BLOCKED, not PASS', () => {
    const r = buildTestReport({
      categories: [cat({ skipped: 1, total: 10, passed: 9 })],
      mandatorySkipped: ['unit:login-flow'],
    });
    assert.equal(reportGateVerdict(r), 'BLOCKED');
    assert.equal(isAllGreen(r), false);
  });

  it('optional skipped tests alone do not fail, but are not "green" either', () => {
    const r = buildTestReport({ categories: [cat({ skipped: 2, total: 10, passed: 8 })] });
    assert.equal(reportGateVerdict(r), 'PASS'); // skipped optional ≠ fail
    assert.equal(r.skipped, 2); // …but the count is honestly reported
  });

  it('quarantined mandatory test still BLOCKED', () => {
    const r = buildTestReport({ categories: [cat()] });
    assert.equal(
      reportGateVerdict(r, { quarantinedMandatory: ['unit:flaky-login'] }),
      'BLOCKED',
    );
  });
});
