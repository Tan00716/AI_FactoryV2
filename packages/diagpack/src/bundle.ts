/**
 * Diagnostics bundle assembly (V3-#10). Pure functions: the server
 * route gathers inputs, this module only assembles, redacts and
 * self-checks. Nothing here reads the filesystem, the database or the
 * network, so the bundle contents are exactly what the caller passed
 * in — no ambient secret can leak in through an unread input.
 */
import { redactText, selfCheckSecretPatterns } from './redact.js';
import { renderReportHtml } from './report.js';
import type {
  AuditSummaryRecord,
  BundleInputs,
  DiagnosticsBundle,
  PrivacyNotice,
} from './types.js';

export const BUNDLE_VERSION = 1 as const;

/** What a bundle contains, and what it never contains (preview + bundle). */
export function privacyNotice(): PrivacyNotice {
  return {
    includes: [
      'app and server version, platform, architecture, node version',
      'audit summary: record counts by action plus the newest records (id, time, actor, action, entity, result only)',
      'task evidence: project count, task count, tasks by status (no titles, no file contents)',
      'config snapshot: auth mode and egress summary (modes and counts only)',
      'error excerpt: recent failure-shaped audit records, same stripped fields',
      'perf baseline summary: per-task milliseconds from the V3-#4 baseline, when available',
    ],
    excludes: [
      'secret and token values in any form (redacted or raw)',
      'audit record details payloads',
      'task titles, descriptions and file contents',
      'environment variable names and values',
      'user file contents of any kind',
    ],
    noticeZh:
      '诊断包由你主动导出，不会自动上报。包内不含任何密钥、token、环境变量与用户文件内容；' +
      '审计记录仅含计数与 stripped 字段，任务证据仅含计数。导出前请先看预览清单，确认后再生成。' +
      '模型调用会把提示词与代码片段发送给模型厂商（数据出境），该提示目前为占位文案，模型接通后在调用前再次明示。',
    noticeEn:
      'This bundle is exported only when you ask for it; nothing is uploaded automatically. ' +
      'It contains no secret or token values, no environment variables, and no user file contents; ' +
      'audit records contribute counts and stripped fields only, and task evidence contributes counts only. ' +
      'Review the preview list before confirming the export. ' +
      'Model calls send prompts and code snippets to the model provider (data leaves this machine); ' +
      'this notice is a placeholder until a model is connected, at which point it will be shown again before each call.',
  };
}

/**
 * Failure-shaped audit records: an explicit non-ok result, or an action
 * naming a block/failure/denial. Heuristic by construction — the audit
 * log has no severity column — and documented as such in the bundle.
 */
export function isErrorShaped(r: AuditSummaryRecord): boolean {
  if (r.result !== null && r.result !== '' && r.result !== 'ok' && r.result !== 'success' && r.result !== 'allowed') {
    return true;
  }
  return /BLOCKED|FAILED|DENIED|ERROR|REJECTED/.test(r.action);
}

function stripRecord(r: AuditSummaryRecord): AuditSummaryRecord {
  return {
    id: r.id,
    ts: r.ts,
    actor: redactText(r.actor),
    action: redactText(r.action),
    entityType: redactText(r.entityType),
    entityId: redactText(r.entityId),
    result: r.result === null ? null : redactText(r.result),
  };
}

/**
 * Assemble a bundle from route-gathered inputs. The HTML report is
 * rendered from the redacted bundle, so it cannot reintroduce anything
 * the bundle removed. Throws when the self-check finds a remaining
 * secret pattern — the caller must refuse the export (409), not ship it.
 */
export function buildBundle(inputs: BundleInputs): DiagnosticsBundle {
  const records = inputs.auditRecords.map(stripRecord);
  const byAction = new Map<string, number>();
  for (const r of records) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  const sorted = [...records].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const bundle: DiagnosticsBundle = {
    meta: {
      bundleVersion: BUNDLE_VERSION,
      bundleId: inputs.meta.bundleId,
      exportedAt: inputs.meta.exportedAt,
      appVersion: inputs.meta.appVersion,
      serverVersion: inputs.meta.serverVersion,
      platform: inputs.meta.platform,
      arch: inputs.meta.arch,
      nodeVersion: inputs.meta.nodeVersion,
    },
    privacy: privacyNotice(),
    auditSummary: {
      totalRecords: inputs.auditTotal,
      fromTs: records.length ? records.reduce((m, r) => (r.ts < m ? r.ts : m), records[0].ts) : null,
      toTs: records.length ? records.reduce((m, r) => (r.ts > m ? r.ts : m), records[0].ts) : null,
      byAction: [...byAction.entries()]
        .map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count),
      recent: sorted.slice(0, inputs.recentLimit),
    },
    taskEvidence: inputs.taskEvidence,
    configSnapshot: inputs.configSnapshot,
    errorExcerpt: sorted.filter(isErrorShaped).slice(0, inputs.errorLimit),
    perfBaseline: inputs.perfBaseline,
    reportHtml: '',
  };
  bundle.reportHtml = renderReportHtml(bundle);
  const hits = selfCheckSecretPatterns(JSON.stringify(bundle));
  if (hits.length > 0) {
    throw new Error(`diagnostics bundle self-check failed: patterns still present: ${hits.join(', ')}`);
  }
  return bundle;
}

/** Preview manifest: what an export WOULD contain, without building it. */
export function previewManifest(input: {
  auditTotal: number;
  taskCount: number;
  projectCount: number;
  perfAvailable: boolean;
  errorCount: number;
}): PrivacyNotice & {
  estimatedSections: Array<{ section: string; detail: string }>;
  requiresConfirm: true;
} {
  const p = privacyNotice();
  return {
    ...p,
    estimatedSections: [
      { section: 'meta', detail: 'version, platform, export time' },
      { section: 'auditSummary', detail: `${input.auditTotal} records, counts by action` },
      { section: 'taskEvidence', detail: `${input.projectCount} projects, ${input.taskCount} tasks, by status` },
      { section: 'configSnapshot', detail: 'auth mode + egress summary (modes and counts only)' },
      { section: 'errorExcerpt', detail: `${input.errorCount} failure-shaped records (stripped fields)` },
      {
        section: 'perfBaseline',
        detail: input.perfAvailable ? 'V3-#4 baseline summary' : 'unavailable (no baseline file found)',
      },
    ],
    requiresConfirm: true,
  };
}
