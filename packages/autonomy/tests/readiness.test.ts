/**
 * Tests for verifyProdReadiness — the independent §41 checklist.
 * Run: node --test dist/tests/readiness.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROD_CHECKS,
  ProdReadinessEvidence,
  verifyProdReadiness,
} from '../src/index';

const FIXED_NOW = 1728374400000;
const now = () => FIXED_NOW;

function fullEvidence(overrides: Partial<ProdReadinessEvidence> = {}): ProdReadinessEvidence {
  const ok = (id: string) => ({ passed: true as const, evidenceId: id });
  return {
    build: ok('ev-build-1'),
    tests: ok('ev-tests-1'),
    security: ok('ev-sec-1'),
    rollback: ok('ev-rollback-1'),
    healthCheck: ok('ev-health-1'),
    artifact: ok('ev-artifact-1'),
    environment: ok('ev-env-1'),
    commitSha: 'abc123',
    requestedBy: 'ai-agent-7',
    ...overrides,
  };
}

describe('verifyProdReadiness', () => {
  it('passes when all seven gates have concrete evidence', () => {
    const v = verifyProdReadiness(fullEvidence(), { now });
    assert.equal(v.ready, true);
    assert.deepEqual(v.missing, []);
    assert.equal(v.passed.length, 7);
    assert.equal(v.checkedAt, FIXED_NOW);
    assert.equal(v.commitSha, 'abc123');
    assert.ok(v.message.startsWith('PROD READY'));
  });

  it('covers the seven §41 checks in spec order', () => {
    assert.deepEqual([...PROD_CHECKS], [
      'build',
      'tests',
      'security',
      'rollback',
      'healthCheck',
      'artifact',
      'environment',
    ]);
  });

  for (const check of PROD_CHECKS) {
    it(`rejects when '${check}' is missing and names it`, () => {
      const ev = fullEvidence();
      delete ev[check];
      const v = verifyProdReadiness(ev, { now });
      assert.equal(v.ready, false);
      assert.deepEqual(v.missing, [check]);
      assert.ok(v.message.includes(check), `message should name ${check}`);
      assert.ok(v.message.startsWith('PROD BLOCKED'));
    });
  }

  it('rejects when a gate reports passed:false', () => {
    const v = verifyProdReadiness(
      fullEvidence({ tests: { passed: false, evidenceId: 'ev-tests-9' } }),
      { now },
    );
    assert.equal(v.ready, false);
    assert.deepEqual(v.missing, ['tests']);
  });

  it('never trusts an AI assertion alone — aiAssertedOnly without evidence is missing', () => {
    const v = verifyProdReadiness(
      fullEvidence({ security: { passed: true, aiAssertedOnly: true } }),
      { now },
    );
    assert.equal(v.ready, false);
    assert.deepEqual(v.missing, ['security']);
    assert.ok(v.message.includes('security'));
  });

  it('accepts a direct tool verdict without aiAssertedOnly', () => {
    const v = verifyProdReadiness(
      fullEvidence({ build: { passed: true, evidenceId: 'tool-run-42' } }),
      { now },
    );
    assert.equal(v.ready, true);
  });

  it('names every missing gate when several are absent', () => {
    const v = verifyProdReadiness(
      fullEvidence({ security: { passed: true, aiAssertedOnly: true }, rollback: { passed: false } }),
      { now },
    );
    assert.equal(v.ready, false);
    assert.deepEqual(v.missing, ['security', 'rollback']);
    assert.ok(v.message.includes('security') && v.message.includes('rollback'));
  });

  it('rejects completely empty evidence with all seven missing', () => {
    const v = verifyProdReadiness({}, { now });
    assert.equal(v.ready, false);
    assert.equal(v.missing.length, 7);
  });
});
