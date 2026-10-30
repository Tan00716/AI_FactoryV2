/**
 * diagpack bundle assembly tests (V3-#10). Run compiled:
 *   node --test packages/diagpack/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle, previewManifest, isErrorShaped } from '../src/bundle.js';
import { selfCheckSecretPatterns } from '../src/redact.js';
import type { BundleInputs } from '../src/types.js';

const GHP = 'ghp_' + 'a'.repeat(36);

function inputs(): BundleInputs {
  return {
    meta: {
      bundleId: 'bundle-1',
      exportedAt: '2026-10-30T00:00:00.000Z',
      appVersion: '0.2.0',
      serverVersion: '0.1.0',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.0.0',
    },
    auditRecords: [
      { id: 'r1', ts: '2026-10-30T00:00:01.000Z', actor: 'human', action: 'TASK_CREATED', entityType: 'task', entityId: 't1', result: 'ok' },
      { id: 'r2', ts: '2026-10-30T00:00:02.000Z', actor: 'human', action: 'EGRESS_BLOCKED', entityType: 'egress', entityId: 'global', result: 'denied' },
      { id: 'r3', ts: '2026-10-30T00:00:03.000Z', actor: 'human', action: 'NOTE_WITH_SECRET', entityType: 'note', entityId: 'n1', result: `leaked ${GHP} here` },
    ],
    auditTotal: 3,
    taskEvidence: { projectCount: 2, taskCount: 5, byStatus: [{ status: 'open', count: 5 }] },
    configSnapshot: { authMode: 'token', egress: { enabled: true, defaultPolicy: 'deny', ruleCount: 3 }, egressUnavailableReason: null },
    perfBaseline: { available: true, reason: null, tasks: [{ name: 'server-boot', ms: 2760 }], taskCount: 1 },
    recentLimit: 20,
    errorLimit: 50,
  };
}

test('bundle assembles sections, strips details, redacts free text', () => {
  const b = buildBundle(inputs());
  assert.equal(b.meta.bundleVersion, 1);
  assert.equal(b.auditSummary.totalRecords, 3);
  assert.equal(b.auditSummary.byAction.find((a) => a.action === 'TASK_CREATED')?.count, 1);
  assert.equal(b.taskEvidence.taskCount, 5);
  assert.equal(b.configSnapshot.authMode, 'token');
  const serialized = JSON.stringify(b);
  assert.ok(!serialized.includes(GHP), 'raw secret shape must not survive');
  assert.ok(!serialized.includes('ghp_'), 'no token prefix anywhere');
  assert.deepEqual(selfCheckSecretPatterns(serialized), []);
  assert.ok(b.reportHtml.includes('AI Factory diagnostics bundle'));
  assert.ok(b.reportHtml.includes('2760'));
});

test('error excerpt picks failure-shaped records only', () => {
  const b = buildBundle(inputs());
  const actions = b.errorExcerpt.map((r) => r.action);
  assert.ok(actions.includes('EGRESS_BLOCKED'));
  assert.ok(!actions.includes('TASK_CREATED'));
});

test('isErrorShaped: explicit non-ok result counts, ok does not', () => {
  const base = { id: 'x', ts: '2026-10-30T00:00:00.000Z', actor: 'human', entityType: 't', entityId: '1' };
  assert.equal(isErrorShaped({ ...base, action: 'SOMETHING', result: 'failed' }), true);
  assert.equal(isErrorShaped({ ...base, action: 'SOMETHING', result: 'ok' }), false);
  assert.equal(isErrorShaped({ ...base, action: 'X_FAILED', result: null }), true);
  assert.equal(isErrorShaped({ ...base, action: 'X_DONE', result: null }), false);
});

test('bundle with no records has null range and empty sections', () => {
  const inp = inputs();
  inp.auditRecords = [];
  inp.auditTotal = 0;
  const b = buildBundle(inp);
  assert.equal(b.auditSummary.fromTs, null);
  assert.equal(b.auditSummary.toTs, null);
  assert.deepEqual(b.auditSummary.recent, []);
  assert.deepEqual(b.errorExcerpt, []);
});

test('preview manifest lists includes/excludes and requires confirm', () => {
  const p = previewManifest({ auditTotal: 42, taskCount: 7, projectCount: 2, perfAvailable: false, errorCount: 3 });
  assert.equal(p.requiresConfirm, true);
  assert.ok(p.includes.length > 0);
  assert.ok(p.excludes.some((e) => /secret/i.test(e)));
  assert.ok(p.estimatedSections.some((s) => s.section === 'perfBaseline' && /unavailable/i.test(s.detail)));
  assert.ok(p.noticeZh.length > 0 && p.noticeEn.length > 0);
});

test('html report escapes injected markup from record fields', () => {
  const inp = inputs();
  inp.auditRecords = [
    { id: 'r9', ts: '2026-10-30T00:00:09.000Z', actor: '<script>alert(1)</script>', action: 'X', entityType: 't', entityId: '1', result: null },
  ];
  inp.auditTotal = 1;
  const b = buildBundle(inp);
  assert.ok(!b.reportHtml.includes('<script>alert(1)</script>'));
  assert.ok(b.reportHtml.includes('&lt;script&gt;'));
});
