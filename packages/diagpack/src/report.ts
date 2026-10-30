/**
 * Portable HTML report for a diagnostics bundle (V3-#10).
 * Rendered ONLY from the redacted bundle, so the HTML cannot contain
 * anything the bundle removed. All interpolated values are escaped.
 */
import type { DiagnosticsBundle } from './types.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rows(rs: Array<Record<string, string | null>>): string {
  if (rs.length === 0) return '<p><em>none</em></p>';
  const keys = Object.keys(rs[0]);
  const head = keys.map((k) => `<th>${esc(k)}</th>`).join('');
  const body = rs
    .map((r) => `<tr>${keys.map((k) => `<td>${esc(r[k] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderReportHtml(b: DiagnosticsBundle): string {
  const m = b.meta;
  const sections: string[] = [];
  sections.push(`<h1>AI Factory diagnostics bundle</h1><p>Bundle ${esc(m.bundleId)} exported ${esc(m.exportedAt)}. ` +
    `App ${esc(m.appVersion)} / server ${esc(m.serverVersion)} on ${esc(m.platform)}-${esc(m.arch)} (${esc(m.nodeVersion)}).</p>`);
  sections.push(`<h2>Privacy notice</h2><p>${esc(b.privacy.noticeEn)}</p>` +
    `<p>Includes: ${esc(b.privacy.includes.join('; '))}.</p>` +
    `<p>Never includes: ${esc(b.privacy.excludes.join('; '))}.</p>`);
  sections.push(`<h2>Audit summary</h2><p>${b.auditSummary.totalRecords} records` +
    `${b.auditSummary.fromTs ? ` from ${esc(b.auditSummary.fromTs)} to ${esc(b.auditSummary.toTs ?? '')}` : ''}.</p>` +
    rows(b.auditSummary.byAction.map((a) => ({ action: a.action, count: String(a.count) }))));
  sections.push(`<h2>Recent audit records (stripped fields)</h2>` +
    rows(b.auditSummary.recent.map((r) => ({
      ts: r.ts, actor: r.actor, action: r.action, entity: `${r.entityType}:${r.entityId}`, result: r.result,
    }))));
  sections.push(`<h2>Task evidence (counts only)</h2><p>${b.taskEvidence.projectCount} projects, ` +
    `${b.taskEvidence.taskCount} tasks.</p>` +
    rows(b.taskEvidence.byStatus.map((s) => ({ status: s.status, count: String(s.count) }))));
  sections.push(`<h2>Config snapshot</h2><p>Auth mode: ${esc(b.configSnapshot.authMode)}.</p>` +
    (b.configSnapshot.egress
      ? `<p>Egress: enabled=${b.configSnapshot.egress.enabled}, default=${esc(b.configSnapshot.egress.defaultPolicy)}, rules=${b.configSnapshot.egress.ruleCount}.</p>`
      : `<p>Egress: unavailable (${esc(b.configSnapshot.egressUnavailableReason ?? 'unknown')}).</p>`));
  sections.push(`<h2>Error excerpt (failure-shaped audit records)</h2>` +
    rows(b.errorExcerpt.map((r) => ({
      ts: r.ts, actor: r.actor, action: r.action, entity: `${r.entityType}:${r.entityId}`, result: r.result,
    }))));
  sections.push(`<h2>Perf baseline summary</h2>` +
    (b.perfBaseline.available
      ? `<p>${b.perfBaseline.taskCount} tasks.</p>` +
        rows(b.perfBaseline.tasks.map((t) => ({ task: t.name, ms: t.ms === null ? '' : String(t.ms) })))
      : `<p>Unavailable: ${esc(b.perfBaseline.reason ?? 'no baseline file found')}.</p>`));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>AI Factory diagnostics bundle</title>` +
    `<style>body{font-family:system-ui,sans-serif;margin:2em}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>` +
    `</head><body>${sections.join('')}</body></html>`;
}
