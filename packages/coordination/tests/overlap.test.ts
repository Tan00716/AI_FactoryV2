/**
 * Tests for file-overlap detection & coordination — spec §62.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOverlap,
  mergeCheck,
  normalizePath,
  resolveOverlap,
} from '../src/index';

describe('detectOverlap', () => {
  it('detects the exact same file in both sets', () => {
    const r = detectOverlap(['src/payment/service.ts'], ['src/payment/service.ts']);
    assert.equal(r.hasOverlap, true);
    assert.equal(r.overlaps.length, 1);
    assert.equal(r.overlaps[0].kind, 'same-file');
    assert.equal(r.overlaps[0].sharedPath, 'src/payment/service.ts');
  });

  it('detects directory-prefix overlap (dir vs file inside it)', () => {
    const r = detectOverlap(['src/payment/'], ['src/payment/service.ts']);
    assert.equal(r.hasOverlap, true);
    assert.equal(r.overlaps[0].kind, 'dir-prefix');
    assert.equal(r.overlaps[0].sharedPath, 'src/payment');
  });

  it('detects directory-prefix overlap in the other direction too', () => {
    const r = detectOverlap(['src/payment/service.ts'], ['src/payment']);
    assert.equal(r.hasOverlap, true);
    assert.equal(r.overlaps[0].kind, 'dir-prefix');
  });

  it('reports no overlap for disjoint file sets', () => {
    const r = detectOverlap(['src/payment/service.ts'], ['src/auth/login.ts']);
    assert.equal(r.hasOverlap, false);
    assert.deepEqual(r.overlaps, []);
  });

  it('does not treat a sibling prefix as overlap (payment vs payment-v2)', () => {
    const r = detectOverlap(['src/payment-v2/x.ts'], ['src/payment']);
    assert.equal(r.hasOverlap, false);
  });

  it('normalizes separators, ./ and trailing slashes before comparing', () => {
    assert.equal(normalizePath('.\\src\\a\\'), 'src/a');
    const r = detectOverlap(['.\\src\\payment\\service.ts'], ['src/payment/service.ts']);
    assert.equal(r.hasOverlap, true);
    assert.equal(r.overlaps[0].kind, 'same-file');
  });

  it('supports case-insensitive comparison when asked', () => {
    const strict = detectOverlap(['SRC/A.ts'], ['src/a.ts']);
    assert.equal(strict.hasOverlap, false);
    const loose = detectOverlap(['SRC/A.ts'], ['src/a.ts'], { caseInsensitive: true });
    assert.equal(loose.hasOverlap, true);
  });
});

describe('resolveOverlap', () => {
  it('warns and serializes when the same file is touched', () => {
    const report = detectOverlap(['src/x.ts'], ['src/x.ts']);
    const plan = resolveOverlap(report, 'warn');
    assert.equal(plan.decision, 'serialize');
    assert.ok(plan.warnings.some((w) => w.includes('Never silently overwrite')));
    assert.ok(plan.steps.length > 0);
    assert.deepEqual(plan.blockedFiles, ['src/x.ts']);
  });

  it('partitions when the overlap is directory-prefix only', () => {
    const report = detectOverlap(['src/payment'], ['src/payment/service.ts']);
    const plan = resolveOverlap(report); // default 'warn'
    assert.equal(plan.decision, 'partition');
  });

  it('honors an explicit serialize strategy', () => {
    const report = detectOverlap(['src/payment'], ['src/payment/service.ts']);
    const plan = resolveOverlap(report, 'serialize');
    assert.equal(plan.decision, 'serialize');
  });

  it('returns a merge_then_test plan for merge_test', () => {
    const report = detectOverlap(['src/x.ts'], ['src/x.ts']);
    const plan = resolveOverlap(report, 'merge_test');
    assert.equal(plan.decision, 'merge_then_test');
    assert.ok(plan.steps.join('\n').toLowerCase().includes('test'));
  });

  it('returns decision none when there is no overlap', () => {
    const report = detectOverlap(['a.ts'], ['b.ts']);
    const plan = resolveOverlap(report);
    assert.equal(plan.decision, 'none');
    assert.deepEqual(plan.blockedFiles, []);
  });
});

describe('mergeCheck', () => {
  it('refuses to release overlapped files without a test hook', () => {
    const report = detectOverlap(['src/x.ts'], ['src/x.ts']);
    const v = mergeCheck(report);
    assert.equal(v.allowed, false);
    assert.deepEqual(v.blockedFiles, ['src/x.ts']);
  });

  it('releases when the test hook passes', () => {
    const report = detectOverlap(['src/x.ts'], ['src/x.ts']);
    const v = mergeCheck(report, () => true);
    assert.equal(v.allowed, true);
    assert.deepEqual(v.blockedFiles, []);
  });

  it('stays blocked when the test hook fails', () => {
    const report = detectOverlap(['src/x.ts'], ['src/x.ts']);
    const v = mergeCheck(report, () => false);
    assert.equal(v.allowed, false);
    assert.deepEqual(v.blockedFiles, ['src/x.ts']);
  });

  it('allows non-overlapping changes without tests', () => {
    const report = detectOverlap(['a.ts'], ['b.ts']);
    const v = mergeCheck(report);
    assert.equal(v.allowed, true);
  });
});
