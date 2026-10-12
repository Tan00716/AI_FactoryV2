/**
 * Final Report generator — SPEC_V2 §39 (FINAL_REPORT artifact) + Batch 9-4.
 *
 *  GET /api/projects/:id/final-report            → JSON report
 *  GET /api/projects/:id/final-report?format=md  → Markdown rendering
 *
 * Assembles a project's FINAL_REPORT artifact from REAL DB records only:
 * tasks (tasks table, scoped by project_id), evidence (evidence table,
 * incl. the Batch 8 requirement pin), approvals (approvals table) and the
 * audit trail (audit_logs). Waivers (§23.4) are counted from the
 * APPROVAL_GATE_WAIVED audit records and reported in their OWN section —
 * a WAIVED gate is a FAILED gate covered by an exception grant, never an
 * approval, so it is never folded into the APPROVED count.
 *
 * Honesty rules (same as the rest of the factory):
 *  - every number comes from an actual record; a section with no backing
 *    records says so (`available: false`, note '无数据：…'), never invents.
 *  - AOCR reuses @ai-factory/dashboard's §1.2 computation with the exact
 *    mapping the dashboard route documents: authorized := the task has an
 *    approval record with decision 'APPROVED'; completed := status DONE.
 *    No authorized outcomes → ratePercent null + 暂无数据, never faked.
 *  - Weighted progress plans (§20) live in route-local memory and are NOT
 *    persisted per project, so plan-based progress is reported as 无数据
 *    instead of being reconstructed from thin air.
 *
 * The JSON shape aligns with the artifacts FINAL_REPORT schema
 * (title / summary / outcomes / metrics / followUps); everything the
 * schema has no field for lives under `extensions` and says so there.
 * The report carries a sha256 content hash over its canonical form
 * (hash field itself excluded); the Markdown rendering shows the same
 * hash because both render the same generated object.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { computeAuthorizedOutcomeCompletionRate } from '@ai-factory/dashboard';
import { TERMINAL_STATES } from '@ai-factory/core';
import type { FactoryDatabase } from '@ai-factory/db';
import type { RouteContext } from './context';

// ------------------------------------------------------------------ types --

export interface FinalReportTaskItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  risk: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface FinalReportEvidenceItem {
  id: string;
  taskId: string;
  type: string;
  title: string;
  status: string;
  /** Batch 8 requirement pin ('REQ-001@1'); null = never recorded. */
  requirementVersion: string | null;
  createdAt: string;
  sealedAt: string | null;
}

export interface FinalReportApprovalItem {
  approvalId: string;
  taskId: string;
  action: string;
  status: string;
  decision: string;
  decidedBy: string;
  decisionReason: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface FinalReportWaiverItem {
  grantId: string;
  taskId: string;
  action: string;
  grantedBy: string;
  failureReason: string;
  ts: string;
}

export type SectionStatus = 'ok' | 'no-data';

export interface FinalReport {
  /** Aligns with the artifacts FINAL_REPORT artifact type (§39). */
  artifactType: 'FINAL_REPORT';
  // --- artifacts FINAL_REPORT schema fields -------------------------------
  title: string;
  summary: string;
  outcomes: string[];
  metrics: Record<string, number | string | null>;
  followUps: string[];
  // --- extension area (schema has no fields for these; see extensions.note)
  extensions: {
    note: string;
    project: {
      id: string;
      name: string;
      description: string;
      path: string;
      createdAt: string;
      updatedAt: string;
    };
    tasks: {
      available: boolean;
      note?: string;
      total: number;
      byStatus: Record<string, number>;
      terminal: number;
      open: number;
      items: FinalReportTaskItem[];
    };
    evidence: {
      available: boolean;
      note?: string;
      total: number;
      byType: Record<string, number>;
      byStatus: Record<string, number>;
      sealed: number;
      withRequirementPin: number;
      withoutRequirementPin: number;
      items: FinalReportEvidenceItem[];
    };
    approvals: {
      available: boolean;
      note?: string;
      total: number;
      /** Decision accounting: APPROVED / REJECTED / undecided. WAIVED is NOT
       *  a decision and never appears here — see `waived` below. */
      decisions: { approved: number; rejected: number; pending: number };
      byStatus: Record<string, number>;
      items: FinalReportApprovalItem[];
      /** §23.4 exception-grant waivers, accounted SEPARATELY from approvals. */
      waived: {
        count: number;
        note?: string;
        items: FinalReportWaiverItem[];
      };
    };
    progress: {
      /** DONE / total over the project's tasks; null when there are none. */
      taskCompletionPercent: number | null;
      aocr: {
        ratePercent: number | null;
        authorizedTotal: number;
        authorizedCompleted: number;
        note?: string;
      };
      /** §20 weight plans are runtime memory, not persisted per project. */
      planBased: { available: false; note: string };
    };
    auditSummary: {
      available: boolean;
      note?: string;
      /** Audit records scoped to this project (project, its tasks, their
       *  evidence/approvals, or records whose details name a project task). */
      totalEvents: number;
      byAction: Record<string, number>;
      recent: Array<{
        ts: string;
        actor: string;
        action: string;
        entityType: string;
        entityId: string;
      }>;
    };
    openItems: {
      openTasks: FinalReportTaskItem[];
      pendingApprovals: FinalReportApprovalItem[];
      rejectedApprovals: FinalReportApprovalItem[];
      draftEvidence: FinalReportEvidenceItem[];
      total: number;
    };
    /** Per-section completeness: 'ok' = backed by records, 'no-data' = none. */
    sectionStatus: Record<string, SectionStatus>;
  };
  meta: {
    generatedAt: string;
    /** Latest timestamp among the records this report was assembled from. */
    dataThrough: string | null;
    contentHash: string;
    hashAlgorithm: 'sha256';
  };
}

// --------------------------------------------------------------- helpers --

/** Canonical JSON: recursively sorted keys, undefined dropped (hash-stable). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const NO_DATA = '无数据';

// -------------------------------------------------------------- generator --

/**
 * Assemble the Final Report for a project from the DB. Returns null when
 * the project does not exist (route maps that to 404). `opts.now` is
 * injectable for deterministic tests.
 */
export function generateFinalReport(
  fdb: FactoryDatabase,
  projectId: string,
  opts?: { now?: () => Date },
): FinalReport | null {
  const project = fdb.getProject(projectId);
  if (!project) return null;
  const generatedAt = (opts?.now?.() ?? new Date()).toISOString();

  // ---- tasks -------------------------------------------------------------
  const taskRows = fdb.tasks.listByProject(projectId);
  const taskIds = new Set(taskRows.map((t) => t.id));
  const taskItems: FinalReportTaskItem[] = taskRows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    risk: t.risk,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt ?? null,
  }));
  const openTasks = taskItems.filter(
    (t) => !TERMINAL_STATES.has(t.status as never),
  );
  const doneTasks = taskItems.filter((t) => t.status === 'DONE');

  // ---- evidence ----------------------------------------------------------
  const evidenceRows = taskRows.flatMap((t) => fdb.evidence.listByTask(t.id));
  const evidenceItems: FinalReportEvidenceItem[] = evidenceRows.map((e) => ({
    id: e.id,
    taskId: e.taskId,
    type: e.type,
    title: e.title,
    status: e.status,
    requirementVersion: e.requirementVersion ?? null,
    createdAt: e.createdAt,
    sealedAt: e.sealedAt ?? null,
  }));
  const sealedEvidence = evidenceItems.filter((e) => e.status === 'SEALED');
  const draftEvidence = evidenceItems.filter((e) => e.status === 'DRAFT');
  const withPin = evidenceItems.filter((e) => e.requirementVersion !== null);

  // ---- approvals ---------------------------------------------------------
  const approvalRows = fdb.approvals
    .list()
    .filter((a) => taskIds.has(a.task_id));
  const approvalItems: FinalReportApprovalItem[] = approvalRows.map((a) => ({
    approvalId: a.approval_id,
    taskId: a.task_id,
    action: a.action,
    status: a.status,
    decision: a.decision,
    decidedBy: a.decided_by,
    decisionReason: a.decision_reason,
    createdAt: a.created_at,
    decidedAt: a.decided_at ?? null,
  }));
  const approvedCount = approvalItems.filter((a) => a.decision === 'APPROVED').length;
  const rejectedItems = approvalItems.filter((a) => a.decision === 'REJECTED');
  const pendingItems = approvalItems.filter((a) => a.decision === '');

  // ---- audit (scoped) + waivers ------------------------------------------
  const evidenceIds = new Set(evidenceItems.map((e) => e.id));
  const approvalIds = new Set(approvalItems.map((a) => a.approvalId));
  const allAudit = fdb.audit.list();
  const scopedAudit = allAudit.filter((r) => {
    if (r.entityType === 'project' && r.entityId === projectId) return true;
    if (taskIds.has(r.entityId) || evidenceIds.has(r.entityId) || approvalIds.has(r.entityId)) {
      return true;
    }
    const detailTask = (r.details as Record<string, unknown> | undefined)?.['task_id'];
    return typeof detailTask === 'string' && taskIds.has(detailTask);
  });
  // §23.4 waivers: the gate verdict WAIVED exists ONLY as the
  // APPROVAL_GATE_WAIVED audit record (entity = grant id, details.task_id
  // names the covered task). Counted here, never as approvals.
  const waiverItems: FinalReportWaiverItem[] = scopedAudit
    .filter((r) => r.action === 'APPROVAL_GATE_WAIVED')
    .map((r) => {
      const d = (r.details ?? {}) as Record<string, unknown>;
      return {
        grantId: typeof d['grant_id'] === 'string' ? d['grant_id'] : r.entityId,
        taskId: typeof d['task_id'] === 'string' ? d['task_id'] : '',
        action: typeof d['action'] === 'string' ? d['action'] : '',
        grantedBy: typeof d['granted_by'] === 'string' ? d['granted_by'] : '',
        failureReason: typeof d['failure_reason'] === 'string' ? d['failure_reason'] : '',
        ts: r.ts,
      };
    });

  // ---- progress + AOCR -----------------------------------------------------
  // Same documented mapping as the dashboard route (routes/dashboard.ts):
  // authorized := task has an approval record with decision 'APPROVED';
  // completed := status 'DONE'. Within-scope/budget/risk flags are NOT set:
  // no store records them, and inventing them would fabricate AOCR inputs.
  const approvedTaskIds = new Set(
    approvalItems.filter((a) => a.decision === 'APPROVED').map((a) => a.taskId),
  );
  const aocr = computeAuthorizedOutcomeCompletionRate(
    taskItems.map((t) => ({
      id: t.id,
      authorized: approvedTaskIds.has(t.id),
      completed: t.status === 'DONE',
    })),
  );
  const taskCompletionPercent =
    taskItems.length === 0 ? null : round1((doneTasks.length / taskItems.length) * 100);

  // ---- open items ----------------------------------------------------------
  const openItemsTotal =
    openTasks.length + pendingItems.length + rejectedItems.length + draftEvidence.length;

  // ---- section status ------------------------------------------------------
  const sectionStatus: Record<string, SectionStatus> = {
    tasks: taskItems.length > 0 ? 'ok' : 'no-data',
    evidence: evidenceItems.length > 0 ? 'ok' : 'no-data',
    approvals: approvalItems.length > 0 ? 'ok' : 'no-data',
    waivers: waiverItems.length > 0 ? 'ok' : 'no-data',
    progress: taskItems.length > 0 ? 'ok' : 'no-data',
    audit: scopedAudit.length > 0 ? 'ok' : 'no-data',
    openItems: openItemsTotal > 0 ? 'ok' : 'no-data',
  };

  // ---- dataThrough: latest timestamp among assembled records ---------------
  const stamps: string[] = [project.updated_at];
  for (const t of taskItems) stamps.push(t.updatedAt);
  for (const e of evidenceItems) stamps.push(e.createdAt);
  for (const a of approvalItems) stamps.push(a.decidedAt ?? a.createdAt);
  for (const r of scopedAudit) stamps.push(r.ts);
  const dataThrough = stamps.sort().at(-1) ?? null;

  // ---- schema fields ---------------------------------------------------------
  const outcomes = doneTasks.map((t) => `${t.title}（${t.id}）`);
  const followUps: string[] = [
    ...openTasks.map((t) => `未完成任务：${t.title}（${t.id}，状态 ${t.status}）`),
    ...pendingItems.map(
      (a) => `待决审批：${a.action}（${a.approvalId}，任务 ${a.taskId}）`,
    ),
    ...rejectedItems.map(
      (a) =>
        `被拒审批：${a.action}（${a.approvalId}，任务 ${a.taskId}，决定人 ${a.decidedBy || '—'}${a.decisionReason ? `，理由 ${a.decisionReason}` : ''}）`,
    ),
    ...draftEvidence.map((e) => `未封存证据：${e.title}（${e.id}，任务 ${e.taskId}）`),
  ];
  const summary =
    taskItems.length === 0
      ? `项目「${project.name}」暂无任务记录，无可汇编的交付数据；其余段落均为${NO_DATA}。`
      : `项目「${project.name}」共 ${taskItems.length} 个任务：${doneTasks.length} 已完成、` +
        `${openTasks.length} 未终结；证据 ${evidenceItems.length} 条（已封存 ${sealedEvidence.length}）；` +
        `审批通过 ${approvedCount}、拒绝 ${rejectedItems.length}、待决 ${pendingItems.length}；` +
        `豁免 WAIVED ${waiverItems.length} 条（§23.4 例外授权，单列，不计入通过）；` +
        `AOCR ${aocr.ratePercent === null ? `${NO_DATA}（无获准结果记录）` : `${aocr.ratePercent}%`}。`;

  const report: FinalReport = {
    artifactType: 'FINAL_REPORT',
    title: `Final Report — ${project.name}`,
    summary,
    outcomes,
    metrics: {
      totalTasks: taskItems.length,
      doneTasks: doneTasks.length,
      openTasks: openTasks.length,
      taskCompletionPercent,
      evidenceTotal: evidenceItems.length,
      evidenceSealed: sealedEvidence.length,
      evidenceWithRequirementPin: withPin.length,
      approvalsTotal: approvalItems.length,
      approvalsApproved: approvedCount,
      approvalsRejected: rejectedItems.length,
      approvalsPending: pendingItems.length,
      approvalsWaived: waiverItems.length,
      aocrPercent: aocr.ratePercent,
      auditEvents: scopedAudit.length,
      openItems: openItemsTotal,
    },
    followUps,
    extensions: {
      note:
        'Extension sections beyond the artifacts FINAL_REPORT schema ' +
        '(title/summary/outcomes/metrics/followUps). Every number is ' +
        'assembled from live DB records at generation time; sections ' +
        'without backing records are marked 无数据 instead of invented.',
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        path: project.path,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      },
      tasks: {
        available: taskItems.length > 0,
        ...(taskItems.length === 0
          ? { note: `${NO_DATA}：该项目在 tasks 表中暂无任务记录` }
          : {}),
        total: taskItems.length,
        byStatus: countBy(taskItems, (t) => t.status),
        terminal: taskItems.length - openTasks.length,
        open: openTasks.length,
        items: taskItems,
      },
      evidence: {
        available: evidenceItems.length > 0,
        ...(evidenceItems.length === 0
          ? { note: `${NO_DATA}：该项目暂无证据记录` }
          : {}),
        total: evidenceItems.length,
        byType: countBy(evidenceItems, (e) => e.type),
        byStatus: countBy(evidenceItems, (e) => e.status),
        sealed: sealedEvidence.length,
        withRequirementPin: withPin.length,
        withoutRequirementPin: evidenceItems.length - withPin.length,
        items: evidenceItems,
      },
      approvals: {
        available: approvalItems.length > 0,
        ...(approvalItems.length === 0
          ? { note: `${NO_DATA}：该项目暂无审批记录` }
          : {}),
        total: approvalItems.length,
        decisions: {
          approved: approvedCount,
          rejected: rejectedItems.length,
          pending: pendingItems.length,
        },
        byStatus: countBy(approvalItems, (a) => a.status),
        items: approvalItems,
        waived: {
          count: waiverItems.length,
          ...(waiverItems.length === 0
            ? { note: `${NO_DATA}：无 APPROVAL_GATE_WAIVED 审计记录` }
            : {}),
          items: waiverItems,
        },
      },
      progress: {
        taskCompletionPercent,
        aocr: {
          ratePercent: aocr.ratePercent,
          authorizedTotal: aocr.authorizedTotal,
          authorizedCompleted: aocr.authorizedCompleted,
          ...(aocr.ratePercent === null
            ? { note: `${NO_DATA}：无获准结果记录（没有任何任务带 APPROVED 审批决定）` }
            : {}),
        },
        planBased: {
          available: false,
          note: `${NO_DATA}：§20 权重进度计划为路由运行时内存状态，未按项目落库，无法从 DB 汇编`,
        },
      },
      auditSummary: {
        available: scopedAudit.length > 0,
        ...(scopedAudit.length === 0
          ? { note: `${NO_DATA}：无与该项目相关的审计记录` }
          : {}),
        totalEvents: scopedAudit.length,
        byAction: countBy(scopedAudit, (r) => r.action),
        recent: [...scopedAudit]
          .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
          .slice(0, 20)
          .map((r) => ({
            ts: r.ts,
            actor: r.actor,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
          })),
      },
      openItems: {
        openTasks,
        pendingApprovals: pendingItems,
        rejectedApprovals: rejectedItems,
        draftEvidence,
        total: openItemsTotal,
      },
      sectionStatus,
    },
    meta: {
      generatedAt,
      dataThrough,
      contentHash: '',
      hashAlgorithm: 'sha256',
    },
  };

  // Content hash over the canonical report (hash field itself excluded —
  // it is '' at this point and stripped before hashing). generatedAt is
  // part of the hashed content: the hash identifies THIS generated
  // instance, and the JSON + Markdown forms render the same instance.
  const { meta, ...rest } = report;
  const { contentHash: _excluded, ...metaRest } = meta;
  report.meta.contentHash = createHash('sha256')
    .update(canonicalJson({ ...rest, meta: metaRest }))
    .digest('hex');
  return report;
}

// --------------------------------------------------------- markdown render --

function cell(s: string | number | null | undefined): string {
  return String(s ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function noDataLine(note?: string): string {
  return note ?? `${NO_DATA}：无记录`;
}

export function renderFinalReportMarkdown(report: FinalReport): string {
  const x = report.extensions;
  const lines: string[] = [];
  lines.push(`# ${report.title}`);
  lines.push('');
  lines.push(`- 项目：${x.project.name}（${x.project.id}）`);
  lines.push(`- 生成时间：${report.meta.generatedAt}`);
  lines.push(`- 数据截止：${report.meta.dataThrough ?? NO_DATA}`);
  lines.push(`- 内容哈希（sha256）：${report.meta.contentHash}`);
  lines.push('');
  lines.push('## 摘要');
  lines.push('');
  lines.push(report.summary);
  lines.push('');
  lines.push('## 成果（已完成任务）');
  lines.push('');
  if (report.outcomes.length === 0) lines.push(`- ${NO_DATA}：暂无已完成任务`);
  for (const o of report.outcomes) lines.push(`- ${o}`);
  lines.push('');
  lines.push('## 指标');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(report.metrics)) {
    lines.push(`| ${cell(k)} | ${cell(v === null ? NO_DATA : v)} |`);
  }
  lines.push('');
  lines.push('## 任务');
  lines.push('');
  if (!x.tasks.available) {
    lines.push(noDataLine(x.tasks.note));
  } else {
    lines.push(
      `共 ${x.tasks.total} 个：终态 ${x.tasks.terminal}、未终结 ${x.tasks.open}。按状态：` +
        Object.entries(x.tasks.byStatus)
          .map(([k, v]) => `${k} ${v}`)
          .join('，'),
    );
    lines.push('');
    lines.push('| 任务 | 标题 | 状态 | 优先级 | 风险 | 完成时间 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const t of x.tasks.items) {
      lines.push(
        `| ${cell(t.id)} | ${cell(t.title)} | ${cell(t.status)} | ${cell(t.priority)} | ${cell(t.risk)} | ${cell(t.completedAt)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 证据');
  lines.push('');
  if (!x.evidence.available) {
    lines.push(noDataLine(x.evidence.note));
  } else {
    lines.push(
      `共 ${x.evidence.total} 条：已封存 ${x.evidence.sealed}，带 requirement pin ${x.evidence.withRequirementPin}，未记录 pin ${x.evidence.withoutRequirementPin}。`,
    );
    lines.push('');
    lines.push('| 证据 | 任务 | 类型 | 标题 | 状态 | Requirement Pin | 封存时间 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const e of x.evidence.items) {
      lines.push(
        `| ${cell(e.id)} | ${cell(e.taskId)} | ${cell(e.type)} | ${cell(e.title)} | ${cell(e.status)} | ${cell(e.requirementVersion)} | ${cell(e.sealedAt)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 审批');
  lines.push('');
  if (!x.approvals.available) {
    lines.push(noDataLine(x.approvals.note));
  } else {
    const d = x.approvals.decisions;
    lines.push('| 决定 | 数量 |');
    lines.push('| --- | --- |');
    lines.push(`| APPROVED | ${d.approved} |`);
    lines.push(`| REJECTED | ${d.rejected} |`);
    lines.push(`| PENDING（未决） | ${d.pending} |`);
    lines.push(`| WAIVED（豁免，单列） | ${x.approvals.waived.count} |`);
    lines.push('');
    lines.push('| 审批 | 任务 | 动作 | 状态 | 决定 | 决定人 | 决定时间 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const a of x.approvals.items) {
      lines.push(
        `| ${cell(a.approvalId)} | ${cell(a.taskId)} | ${cell(a.action)} | ${cell(a.status)} | ${cell(a.decision || 'PENDING')} | ${cell(a.decidedBy)} | ${cell(a.decidedAt)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 豁免（WAIVED，§23.4 例外授权）');
  lines.push('');
  lines.push('WAIVED 是被例外授权覆盖的 FAILED 门禁，不是审批通过，单列如下：');
  lines.push('');
  if (x.approvals.waived.count === 0) {
    lines.push(noDataLine(x.approvals.waived.note));
  } else {
    lines.push('| 授权 | 任务 | 动作 | 授权人 | 原失败原因 | 时间 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const w of x.approvals.waived.items) {
      lines.push(
        `| ${cell(w.grantId)} | ${cell(w.taskId)} | ${cell(w.action)} | ${cell(w.grantedBy)} | ${cell(w.failureReason)} | ${cell(w.ts)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 进度与 AOCR');
  lines.push('');
  lines.push(
    `- 任务完成率：${x.progress.taskCompletionPercent === null ? NO_DATA : `${x.progress.taskCompletionPercent}%`}`,
  );
  lines.push(
    `- AOCR（授权结果完成率）：${x.progress.aocr.ratePercent === null ? NO_DATA : `${x.progress.aocr.ratePercent}%`}` +
      `（获准 ${x.progress.aocr.authorizedTotal}，其中完成 ${x.progress.aocr.authorizedCompleted}）`,
  );
  if (x.progress.aocr.note) lines.push(`- AOCR 说明：${x.progress.aocr.note}`);
  lines.push(`- 权重计划进度：${x.progress.planBased.note}`);
  lines.push('');
  lines.push('## 审计摘要');
  lines.push('');
  if (!x.auditSummary.available) {
    lines.push(noDataLine(x.auditSummary.note));
  } else {
    lines.push(`共 ${x.auditSummary.totalEvents} 条与本项目相关的审计记录。按动作：`);
    lines.push('');
    lines.push('| 动作 | 数量 |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(x.auditSummary.byAction)) {
      lines.push(`| ${cell(k)} | ${v} |`);
    }
    lines.push('');
    lines.push('最近事件：');
    lines.push('');
    lines.push('| 时间 | 参与者 | 动作 | 实体 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of x.auditSummary.recent) {
      lines.push(
        `| ${cell(r.ts)} | ${cell(r.actor)} | ${cell(r.action)} | ${cell(`${r.entityType}:${r.entityId}`)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 未决事项');
  lines.push('');
  if (report.followUps.length === 0) lines.push(`- ${NO_DATA}：无未决事项`);
  for (const f of report.followUps) lines.push(`- ${f}`);
  lines.push('');
  return lines.join('\n');
}

// ------------------------------------------------------------------ route --

/**
 *  GET /api/projects/:id/final-report            → { report } (JSON)
 *  GET /api/projects/:id/final-report?format=md  → text/markdown
 *
 * Generation is audited (FINAL_REPORT_GENERATED) with the content hash
 * and per-section completeness — the audit write happens AFTER assembly,
 * so a report never contains its own generation event.
 */
export async function handleFinalReportRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/projects/')) return false;
  if ((req.method ?? 'GET') !== 'GET') return false;
  const seg = path.slice('/api/projects/'.length).split('/').filter(Boolean);
  if (seg.length !== 2 || seg[1] !== 'final-report') return false;
  const projectId = decodeURIComponent(seg[0]);

  const report = generateFinalReport(ctx.fdb, projectId);
  if (!report) {
    ctx.json(res, 404, { error: `project ${projectId} not found` });
    return true;
  }

  const headerActor = req.headers['x-actor'];
  const actor =
    (typeof headerActor === 'string' && headerActor.trim()) || 'api';
  const format = url.searchParams.get('format') === 'md' ? 'md' : 'json';
  ctx.audit.record(actor, 'FINAL_REPORT_GENERATED', 'project', projectId, {
    contentHash: report.meta.contentHash,
    format,
    dataThrough: report.meta.dataThrough,
    sections: report.extensions.sectionStatus,
    totalTasks: report.extensions.tasks.total,
    waived: report.extensions.approvals.waived.count,
  });

  if (format === 'md') {
    const md = renderFinalReportMarkdown(report);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': Buffer.byteLength(md),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(md);
    return true;
  }
  ctx.json(res, 200, { report });
  return true;
}
