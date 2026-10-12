/**
 * Final Report generator — Batch 9-4 (§39 FINAL_REPORT artifact).
 *
 * Seeds a real FactoryDatabase (in-memory SQLite) with a hand-computed
 * dataset — completed / in-flight / rejected / waived / pending work —
 * and checks the assembled report against the hand math:
 *  - decisions APPROVED 2 / REJECTED 1 / PENDING 1, WAIVED 1 counted
 *    SEPARATELY (a waiver is a covered FAILED gate, never an approval);
 *  - AOCR 1/2 = 50% (authorized = tasks with an APPROVED decision);
 *  - a WAIVED record belonging to ANOTHER project must not leak in;
 *  - an empty project reports 无数据 per section, AOCR null, never faked;
 *  - unknown project → generator null / route 404;
 *  - the sha256 content hash is stable for fixed inputs and appears
 *    identically in the JSON report and its Markdown rendering;
 *  - generation is audited as FINAL_REPORT_GENERATED with that hash.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FactoryDatabase } from '@ai-factory/db';
import {
  generateFinalReport,
  handleFinalReportRoutes,
  renderFinalReportMarkdown,
} from '../src/routes/final-report.ts';

const FIXED_NOW = () => new Date('2026-10-12T00:00:00.000Z');

function seedProject(fdb: FactoryDatabase): void {
  const db = fdb.db;
  db.prepare(
    `INSERT INTO projects (id, name, description, path, created_at, updated_at)
     VALUES ('proj-final', 'Final Demo', 'demo project', '/tmp/final',
             '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  ).run();
  const task = db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority, risk,
                        created_at, updated_at, completed_at)
     VALUES (?, 'proj-final', ?, ?, ?, ?, '2026-10-01T00:00:00.000Z',
             '2026-10-02T00:00:00.000Z', ?)`,
  );
  task.run('t1', 'Build login', 'DONE', 'P1', 'LOW', '2026-10-02T00:00:00.000Z');
  task.run('t2', 'Build billing', 'IN_PROGRESS', 'P1', 'MEDIUM', null);
  task.run('t3', 'Deploy prod', 'TODO', 'P2', 'HIGH', null);
  task.run('t4', 'Old experiment', 'CANCELLED', 'P3', 'LOW', null);

  const appr = db.prepare(
    `INSERT INTO approvals (approval_id, task_id, action, status, decision,
                            decision_reason, decided_by, created_at, decided_at)
     VALUES (?, ?, 'deploy', ?, ?, ?, ?, '2026-10-03T00:00:00.000Z', ?)`,
  );
  appr.run('a1', 't1', 'APPROVED', 'APPROVED', '', 'human', '2026-10-04T00:00:00.000Z');
  appr.run('a2', 't2', 'APPROVED', 'APPROVED', '', 'human', '2026-10-04T00:00:00.000Z');
  appr.run('a3', 't3', 'REJECTED', 'REJECTED', 'insufficient evidence', 'human', '2026-10-04T00:00:00.000Z');
  appr.run('a4', 't4', 'PENDING', '', '', '', null);

  const ev = db.prepare(
    `INSERT INTO evidence (id, task_id, type, title, status, created_by,
                           created_at, sealed_at, requirement_version)
     VALUES (?, ?, ?, ?, ?, 'agent', '2026-10-03T00:00:00.000Z', ?, ?)`,
  );
  ev.run('e1', 't1', 'code_change', 'login diff', 'SEALED', '2026-10-03T00:00:00.000Z', 'REQ-001@1');
  ev.run('e2', 't1', 'qa_result', 'login qa', 'SEALED', '2026-10-03T00:00:00.000Z', null);
  ev.run('e3', 't2', 'code_review', 'billing review', 'DRAFT', null, null);

  const au = db.prepare(
    `INSERT INTO audit_logs (id, ts, actor, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  au.run('au1', '2026-10-01T00:00:00.000Z', 'human', 'TASK_CREATED', 'task', 't1', '{}');
  au.run('au2', '2026-10-04T00:00:00.000Z', 'human', 'APPROVAL_DECIDED', 'approval', 'a1', '{}');
  au.run(
    'au3', '2026-10-05T00:00:00.000Z', 'approval-service', 'APPROVAL_GATE_WAIVED',
    'approval', 'grant-1',
    JSON.stringify({
      action: 'deploy', task_id: 't3', grant_id: 'grant-1',
      granted_by: 'cto', failure_reason: 'no usable APPROVED approval',
    }),
  );
  // Another project's waiver — must NOT be scoped into this report.
  au.run(
    'au4', '2026-10-05T00:00:00.000Z', 'approval-service', 'APPROVAL_GATE_WAIVED',
    'approval', 'grant-9',
    JSON.stringify({ action: 'deploy', task_id: 't-other', grant_id: 'grant-9', granted_by: 'cto', failure_reason: 'x' }),
  );
  au.run('au5', '2026-09-01T00:00:00.000Z', 'human', 'PROJECT_CREATED', 'project', 'proj-final', '{}');
}

function seededDb(): FactoryDatabase {
  const fdb = new FactoryDatabase(':memory:');
  seedProject(fdb);
  return fdb;
}

describe('generateFinalReport (§39, Batch 9-4)', () => {
  it('assembles task/evidence/approval counts that match the seeded records', () => {
    const report = generateFinalReport(seededDb(), 'proj-final', { now: FIXED_NOW });
    assert.ok(report);
    assert.equal(report.artifactType, 'FINAL_REPORT');
    assert.equal(report.title, 'Final Report — Final Demo');

    const t = report.extensions.tasks;
    assert.equal(t.total, 4);
    assert.deepEqual(t.byStatus, { DONE: 1, IN_PROGRESS: 1, TODO: 1, CANCELLED: 1 });
    assert.equal(t.terminal, 2); // DONE + CANCELLED
    assert.equal(t.open, 2);

    const e = report.extensions.evidence;
    assert.equal(e.total, 3);
    assert.deepEqual(e.byType, { code_change: 1, qa_result: 1, code_review: 1 });
    assert.equal(e.sealed, 2);
    assert.equal(e.withRequirementPin, 1);
    assert.equal(e.withoutRequirementPin, 2);
    assert.equal(e.items.find((i) => i.id === 'e1')?.requirementVersion, 'REQ-001@1');

    const a = report.extensions.approvals;
    assert.equal(a.total, 4);
    assert.deepEqual(a.decisions, { approved: 2, rejected: 1, pending: 1 });
  });

  it('accounts WAIVED separately — never folded into APPROVED', () => {
    const report = generateFinalReport(seededDb(), 'proj-final', { now: FIXED_NOW });
    assert.ok(report);
    const w = report.extensions.approvals.waived;
    assert.equal(w.count, 1); // the other project's grant-9 must not leak in
    assert.equal(w.items[0].grantId, 'grant-1');
    assert.equal(w.items[0].taskId, 't3');
    assert.equal(w.items[0].grantedBy, 'cto');
    assert.equal(w.items[0].failureReason, 'no usable APPROVED approval');
    // APPROVED stays exactly the two real APPROVED decisions.
    assert.equal(report.metrics.approvalsApproved, 2);
    assert.equal(report.metrics.approvalsWaived, 1);
    assert.match(report.summary, /WAIVED 1/);
  });

  it('computes progress + AOCR from the real records (hand math: 25% done, AOCR 50%)', () => {
    const report = generateFinalReport(seededDb(), 'proj-final', { now: FIXED_NOW });
    assert.ok(report);
    assert.equal(report.extensions.progress.taskCompletionPercent, 25);
    const aocr = report.extensions.progress.aocr;
    assert.equal(aocr.authorizedTotal, 2); // t1 + t2 carry APPROVED decisions
    assert.equal(aocr.authorizedCompleted, 1); // only t1 is DONE
    assert.equal(aocr.ratePercent, 50);
    assert.equal(report.extensions.progress.planBased.available, false);
    assert.match(report.extensions.progress.planBased.note, /无数据/);
  });

  it('lists open items: unfinished tasks, pending + rejected approvals, draft evidence', () => {
    const report = generateFinalReport(seededDb(), 'proj-final', { now: FIXED_NOW });
    assert.ok(report);
    const o = report.extensions.openItems;
    assert.deepEqual(o.openTasks.map((t) => t.id), ['t2', 't3']);
    assert.deepEqual(o.pendingApprovals.map((a) => a.approvalId), ['a4']);
    assert.deepEqual(o.rejectedApprovals.map((a) => a.approvalId), ['a3']);
    assert.deepEqual(o.draftEvidence.map((e) => e.id), ['e3']);
    assert.equal(o.total, 5);
    assert.equal(report.followUps.length, 5);
    assert.deepEqual(report.outcomes, ['Build login（t1）']);
  });

  it('scopes the audit summary to the project and stamps dataThrough at the newest record', () => {
    const report = generateFinalReport(seededDb(), 'proj-final', { now: FIXED_NOW });
    assert.ok(report);
    const s = report.extensions.auditSummary;
    assert.equal(s.totalEvents, 4); // au1, au2, au3, au5 — au4 belongs elsewhere
    assert.equal(s.byAction['APPROVAL_GATE_WAIVED'], 1);
    assert.equal(s.byAction['TASK_CREATED'], 1);
    assert.equal(report.meta.dataThrough, '2026-10-05T00:00:00.000Z');
    assert.equal(report.meta.generatedAt, '2026-10-12T00:00:00.000Z');
  });

  it('content hash is a stable sha256 for fixed inputs and matches the Markdown rendering', () => {
    const fdb = seededDb();
    const r1 = generateFinalReport(fdb, 'proj-final', { now: FIXED_NOW });
    const r2 = generateFinalReport(fdb, 'proj-final', { now: FIXED_NOW });
    assert.ok(r1 && r2);
    assert.match(r1.meta.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(r1.meta.contentHash, r2.meta.contentHash);

    const md = renderFinalReportMarkdown(r1);
    assert.ok(md.includes(`内容哈希（sha256）：${r1.meta.contentHash}`));
    assert.match(md, /# Final Report — Final Demo/);
    assert.match(md, /## 豁免（WAIVED/);
    assert.match(md, /grant-1/);
    assert.match(md, /AOCR（授权结果完成率）：50%/);
    assert.match(md, /\| APPROVED \| 2 \|/);
    assert.match(md, /\| WAIVED（豁免，单列） \| 1 \|/);
  });

  it('empty project: every section says 无数据， AOCR null — nothing fabricated', () => {
    const fdb = new FactoryDatabase(':memory:');
    fdb.db
      .prepare(
        `INSERT INTO projects (id, name, description, path, created_at, updated_at)
         VALUES ('proj-empty', 'Empty', '', '', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    const report = generateFinalReport(fdb, 'proj-empty', { now: FIXED_NOW });
    assert.ok(report);
    assert.equal(report.extensions.tasks.available, false);
    assert.match(report.extensions.tasks.note ?? '', /无数据/);
    assert.equal(report.extensions.evidence.available, false);
    assert.equal(report.extensions.approvals.available, false);
    assert.equal(report.extensions.progress.aocr.ratePercent, null);
    assert.match(report.extensions.progress.aocr.note ?? '', /无数据/);
    assert.equal(report.metrics.aocrPercent, null);
    assert.equal(report.metrics.totalTasks, 0);
    assert.deepEqual(report.outcomes, []);
    assert.deepEqual(report.followUps, []);
    assert.match(report.summary, /暂无任务记录/);
    for (const status of Object.values(report.extensions.sectionStatus)) {
      assert.equal(status, 'no-data');
    }
    const md = renderFinalReportMarkdown(report);
    assert.match(md, /无数据/);
  });

  it('unknown project → null', () => {
    assert.equal(generateFinalReport(seededDb(), 'no-such-project'), null);
  });
});

// ------------------------------------------------------------- route level --

function makeCtx(fdb: FactoryDatabase) {
  const jsonCalls: Array<{ status: number; body: unknown }> = [];
  const auditCalls: Array<{ actor: string; action: string; entityId: string; details: Record<string, unknown> }> = [];
  const ctx = {
    fdb,
    audit: {
      record: (actor: string, action: string, _t: string, entityId: string, details: Record<string, unknown>) => {
        auditCalls.push({ actor, action, entityId, details });
      },
    },
    json: (_res: unknown, status: number, body: unknown) => {
      jsonCalls.push({ status, body });
    },
    readBody: async () => ({}),
  } as never;
  return { ctx, jsonCalls, auditCalls };
}

function mockRes() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(s: number, h: Record<string, string>) {
      this.status = s;
      this.headers = h;
    },
    end(d: string) {
      this.body = d;
    },
  };
}

describe('GET /api/projects/:id/final-report (Batch 9-4)', () => {
  it('returns the JSON report and audits FINAL_REPORT_GENERATED with the same hash', async () => {
    const { ctx, jsonCalls, auditCalls } = makeCtx(seededDb());
    const handled = await handleFinalReportRoutes(
      { method: 'GET', headers: {} } as never,
      {} as never,
      new URL('http://localhost/api/projects/proj-final/final-report'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0].status, 200);
    const report = (jsonCalls[0].body as { report: { meta: { contentHash: string } } }).report;
    assert.match(report.meta.contentHash, /^[0-9a-f]{64}$/);
    const gen = auditCalls.find((a) => a.action === 'FINAL_REPORT_GENERATED');
    assert.ok(gen);
    assert.equal(gen.entityId, 'proj-final');
    assert.equal(gen.details['contentHash'], report.meta.contentHash);
    assert.equal(gen.details['waived'], 1);
  });

  it('?format=md returns Markdown whose hash is the audited hash of that generation', async () => {
    const { ctx, auditCalls } = makeCtx(seededDb());
    const res = mockRes();
    const handled = await handleFinalReportRoutes(
      { method: 'GET', headers: {} } as never,
      res as never,
      new URL('http://localhost/api/projects/proj-final/final-report?format=md'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /text\/markdown/);
    const gen = auditCalls.find((a) => a.action === 'FINAL_REPORT_GENERATED');
    assert.ok(gen);
    assert.ok(res.body.includes(`内容哈希（sha256）：${gen.details['contentHash']}`));
    assert.match(res.body, /## 豁免（WAIVED/);
  });

  it('unknown project → 404 and no generation audit', async () => {
    const { ctx, jsonCalls, auditCalls } = makeCtx(seededDb());
    const handled = await handleFinalReportRoutes(
      { method: 'GET', headers: {} } as never,
      {} as never,
      new URL('http://localhost/api/projects/nope/final-report'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(jsonCalls[0].status, 404);
    assert.equal(auditCalls.filter((a) => a.action === 'FINAL_REPORT_GENERATED').length, 0);
  });

  it('does not claim other project paths', async () => {
    const { ctx } = makeCtx(seededDb());
    const handled = await handleFinalReportRoutes(
      { method: 'GET', headers: {} } as never,
      {} as never,
      new URL('http://localhost/api/projects/templates'),
      ctx,
    );
    assert.equal(handled, false);
  });
});
