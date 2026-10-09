/**
 * Tests for suite runners, TAP parsing and aggregation (spec §37).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceEngine } from '@ai-factory/core';
import {
  aggregate,
  qaEvidencePayload,
  runQa,
  shellRunner,
  skippedRunner,
  CategoryResult,
  SuiteRunner,
} from '../src/index';

function fake(category: CategoryResult['category'], verdict: CategoryResult['verdict'], counts = { total: 2, passed: 2, failed: 0, skipped: 0 }): SuiteRunner {
  return {
    category,
    name: `${category}-suite`,
    async run(): Promise<CategoryResult> {
      return { category, verdict, ...counts, durationMs: 7 };
    },
  };
}

describe('runQa aggregation', () => {
  it('fails the run when any category fails and sums counts', async () => {
    const payload = await runQa('t1', [
      fake('unit', 'PASS', { total: 10, passed: 10, failed: 0, skipped: 0 }),
      fake('api', 'FAIL', { total: 4, passed: 3, failed: 1, skipped: 0 }),
      fake('e2e', 'SKIPPED'),
    ]);
    assert.equal(payload.verdict, 'FAIL');
    assert.equal(payload.total, 16);
    assert.equal(payload.passed, 15);
    assert.equal(payload.failed, 1);
    assert.equal(payload.categories.length, 3);
  });

  it('passes when every category passes or is skipped', async () => {
    const payload = await runQa('t1', [fake('unit', 'PASS'), fake('smoke', 'SKIPPED')]);
    assert.equal(payload.verdict, 'PASS');
  });

  it('passes an empty suite list (nothing to fail)', async () => {
    const payload = await runQa('t1', []);
    assert.equal(payload.verdict, 'PASS');
    assert.equal(payload.total, 0);
  });
});

describe('shellRunner TAP parsing', () => {
  it('counts ok / not ok lines from node --test TAP output', async () => {
    const script = `console.log('TAP version 13');
console.log('ok 1 - sums');
console.log('not ok 2 - multiplies');
console.log('1..2');`;
    const r = shellRunner('unit', 'tap-sample', process.execPath, ['-e', script], process.cwd());
    const c = await r.run();
    assert.equal(c.verdict, 'FAIL');
    assert.equal(c.total, 2);
    assert.equal(c.passed, 1);
    assert.equal(c.failed, 1);
    assert.ok(c.output && c.output.length > 0, 'failure output is captured');
  });

  it('reports FAIL with captured output on nonzero exit', async () => {
    const r = shellRunner('unit', 'boom', process.execPath, ['-e', 'process.exit(3)'], process.cwd());
    const c = await r.run();
    assert.equal(c.verdict, 'FAIL');
    assert.equal(c.failed, 1);
  });

  it('reports FAIL when no TAP lines were produced', async () => {
    const r = shellRunner('unit', 'silent', process.execPath, ['-e', "console.log('hello')"], process.cwd());
    const c = await r.run();
    assert.equal(c.verdict, 'FAIL');
    assert.equal(c.total, 1);
  });

  it('passes on clean TAP with exit 0', async () => {
    const script = `console.log('TAP version 13');
console.log('ok 1 - a');
console.log('ok 2 - b');
console.log('1..2');`;
    const r = shellRunner('unit', 'green', process.execPath, ['-e', script], process.cwd());
    const c = await r.run();
    assert.equal(c.verdict, 'PASS');
    assert.equal(c.passed, 2);
    assert.equal(c.output, undefined);
  });
});

describe('skippedRunner', () => {
  it('reports SKIPPED with zero counts', async () => {
    const c = await skippedRunner('security', 'no-security-suite').run();
    assert.equal(c.verdict, 'SKIPPED');
    assert.equal(c.total, 0);
  });
});

describe('qaEvidencePayload', () => {
  it('produces the §37 machine-readable shape and attaches as qa_result', async () => {
    const payload = await runQa('t1', [fake('unit', 'PASS', { total: 5, passed: 5, failed: 0, skipped: 0 })]);
    const obj = qaEvidencePayload(payload);
    assert.equal(obj['verdict'], 'PASS');
    assert.equal(obj['total'], 5);
    assert.equal(obj['passed'], 5);
    assert.equal(obj['failed'], 0);
    assert.equal(obj['skipped'], 0);
    assert.ok(Array.isArray(obj['categories']));
    assert.ok(Array.isArray(obj['failures']));

    const evidence = new EvidenceEngine();
    const ev = evidence.create({
      taskId: 't1',
      type: 'qa_result',
      title: 'QA run',
      payload: obj,
      createdBy: 'qa-lead',
    });
    assert.equal(ev.type, 'qa_result');
    assert.equal((ev.payload['verdict'] as string), 'PASS');
  });
});

describe('aggregate()', () => {
  it('merges category results and failure records', () => {
    const p = aggregate(
      [{ category: 'unit', verdict: 'FAIL', total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 1 }],
      [{ attempt: 1, category: 'unit', classification: 'PRODUCT_FAILURE', owner: 'coder', message: 'x', at: 't' }],
    );
    assert.equal(p.verdict, 'FAIL');
    assert.equal(p.failures.length, 1);
  });
});
