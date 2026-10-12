/**
 * Review route independence tests — SPEC v2 §37 (Batch 5).
 *
 * POST /api/review must run through reviewWithIndependence(): the identity
 * quadruple is required (400 when missing, fail-closed), a failed
 * independence precondition is a 422 gate denial carrying the §49
 * reasonCode, and a genuinely independent review keeps the original
 * response shape — with the reviewer named in the sealed evidence/audit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, EvidenceEngine, TaskManager } from '@ai-factory/core';
import { handleReviewRoutes } from '../src/routes/review.ts';

const FILES = [{ path: 'src/a.ts', after: 'export const x = 1;\n' }];
const IDENTITY = {
  reviewerId: 'agent-reviewer',
  reviewerRunId: 'run-review-1',
  implementerId: 'agent-coder',
  implementerRunId: 'run-impl-1',
};

function makeCtx(body: Record<string, unknown>, full?: { tasks: TaskManager; evidence: EvidenceEngine; audit: AuditLog }) {
  const calls: Array<{ status: number; body: unknown }> = [];
  const ctx = {
    tasks: full?.tasks ?? { get: () => undefined },
    evidence: full?.evidence ?? { create: () => ({ id: 'ev-stub' }) },
    audit: full?.audit ?? { record: () => {} },
    notify: { emit: () => {} },
    readBody: async () => body,
    json: (_res: unknown, status: number, b: unknown) => {
      calls.push({ status, body: b });
    },
  } as never;
  return { ctx, calls };
}

async function post(body: Record<string, unknown>, full?: { tasks: TaskManager; evidence: EvidenceEngine; audit: AuditLog }) {
  const { ctx, calls } = makeCtx(body, full);
  const handled = await handleReviewRoutes(
    { method: 'POST' } as never,
    {} as never,
    new URL('http://localhost/api/review'),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0]!;
}

describe('review route independence (§37)', () => {
  it('missing identity → 400 naming every missing field (fail-closed)', async () => {
    const r = await post({ files: FILES });
    assert.equal(r.status, 400);
    const err = (r.body as { error: string }).error;
    assert.match(err, /§37 independence/);
    for (const f of ['reviewerId', 'reviewerRunId', 'implementerId', 'implementerRunId']) {
      assert.ok(err.includes(f), `error should name missing ${f}: ${err}`);
    }
  });

  it('partial identity → 400 naming only the missing fields', async () => {
    const r = await post({ files: FILES, reviewerId: 'agent-reviewer' });
    assert.equal(r.status, 400);
    const err = (r.body as { error: string }).error;
    assert.ok(!err.includes('missing reviewerId,'), err);
    assert.ok(err.includes('implementerId'), err);
  });

  it('missing files still → 400 with the original message (files checked first)', async () => {
    const r = await post({ ...IDENTITY });
    assert.equal(r.status, 400);
    assert.equal(
      (r.body as { error: string }).error,
      'files is required: array of {path, before?, after?}',
    );
  });

  it('self-review (reviewer === implementer) → 422 INDEPENDENCE_REQUIRED', async () => {
    const r = await post({
      files: FILES,
      ...IDENTITY,
      reviewerId: 'agent-coder',
    });
    assert.equal(r.status, 422);
    const b = r.body as { error: string; reasonCode: string; failedChecks: string[] };
    assert.equal(b.reasonCode, 'INDEPENDENCE_REQUIRED');
    assert.ok(b.failedChecks.some((c) => /self-review is forbidden/.test(c)), JSON.stringify(b.failedChecks));
    assert.match(b.error, /Self-review is not allowed/);
  });

  it('same Run (different people) → 422 INDEPENDENCE_REQUIRED', async () => {
    const r = await post({ files: FILES, ...IDENTITY, reviewerRunId: 'run-impl-1' });
    assert.equal(r.status, 422);
    const b = r.body as { reasonCode: string; failedChecks: string[] };
    assert.equal(b.reasonCode, 'INDEPENDENCE_REQUIRED');
    assert.ok(b.failedChecks.some((c) => /independent Run/.test(c)));
  });

  it('implementer can write the Gate Store → 422 INDEPENDENCE_REQUIRED', async () => {
    const r = await post({ files: FILES, ...IDENTITY, gateStoreWritableByImplementer: true });
    assert.equal(r.status, 422);
    assert.equal((r.body as { reasonCode: string }).reasonCode, 'INDEPENDENCE_REQUIRED');
  });

  it('independent review → 200 with the original response shape', async () => {
    const r = await post({ files: FILES, ...IDENTITY });
    assert.equal(r.status, 200);
    const b = r.body as { verdict: string; summary: unknown; meetsGate: boolean; evidenceId: unknown };
    assert.equal(typeof b.verdict, 'string');
    assert.equal(typeof b.meetsGate, 'boolean');
    assert.equal(b.evidenceId, null); // no taskId → nothing sealed
  });

  it('with taskId: evidence is sealed naming the reviewer; audit carries reviewerId', async () => {
    const tasks = new TaskManager();
    const evidence = new EvidenceEngine();
    const audit = new AuditLog();
    const task = tasks.create({ projectId: 'p1', title: 'review me', creator: 'human' });

    const r = await post(
      { files: FILES, ...IDENTITY, taskId: task.id, actor: 'human' },
      { tasks, evidence, audit },
    );
    assert.equal(r.status, 200);
    const evidenceId = (r.body as { evidenceId: string }).evidenceId;
    assert.ok(evidenceId);
    const sealed = evidence.get(evidenceId);
    assert.ok(sealed);
    assert.equal(sealed!.payload['reviewerId'], 'agent-reviewer');
    assert.equal(sealed!.payload['implementerId'], 'agent-coder');
    const rec = audit.list().find((x) => x.action === 'CODE_REVIEW_COMPLETED');
    assert.ok(rec);
    assert.equal(rec!.details['reviewerId'], 'agent-reviewer');
  });

  it('a denied review is audit-logged as CODE_REVIEW_INDEPENDENCE_DENIED', async () => {
    const tasks = new TaskManager();
    const evidence = new EvidenceEngine();
    const audit = new AuditLog();
    const task = tasks.create({ projectId: 'p1', title: 'self review attempt', creator: 'human' });

    const r = await post(
      { files: FILES, ...IDENTITY, reviewerId: 'agent-coder', taskId: task.id },
      { tasks, evidence, audit },
    );
    assert.equal(r.status, 422);
    const rec = audit.list().find((x) => x.action === 'CODE_REVIEW_INDEPENDENCE_DENIED');
    assert.ok(rec);
    assert.equal(rec!.details['reasonCode'], 'INDEPENDENCE_REQUIRED');
    // And nothing was sealed as gate evidence for the denied review.
    assert.equal(evidence.listByTask(task.id).length, 0);
  });
});
