/**
 * JSON report persistence + markdown summary (V3-#4).
 * Writes are atomic (temp file + rename) so a killed run never leaves
 * a half-written baseline behind.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GateVerdict, PerfResult } from './types.js';

export function writeReportAtomic(path: string, result: PerfResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
  renameSync(tmp, path);
}

export function renderMarkdown(result: PerfResult, gate?: GateVerdict): string {
  const lines: string[] = [
    `# IDE performance benchmark — ${result.generatedAt}`,
    '',
    `Scale: ${result.scale} | seed: ${result.seed} | synthetic: ${result.synthetic} | ` +
      `node ${result.env.node} | ${result.env.platform}/${result.env.arch} | ` +
      `${result.env.cpus} cpus | git ${result.env.gitRev ?? 'unknown'}`,
    '',
    '| task | ms | extra |',
    '|---|---|---|',
  ];
  for (const t of result.tasks) {
    const extra = t.skipped
      ? `skipped (${t.skipReason ?? 'n/a'})`
      : [t.value !== undefined ? `${t.value.toFixed(1)} ${t.unit ?? ''}`.trim() : '',
         t.p95Ms !== undefined ? `p95 ${t.p95Ms.toFixed(2)}ms` : '']
          .filter(Boolean).join(', ');
    lines.push(`| ${t.task} | ${t.skipped ? '-' : t.ms.toFixed(0)} | ${extra} |`);
  }
  if (gate) {
    lines.push('', `Gate (${gate.mode}, threshold ${gate.thresholdPct}%): ${gate.passed ? 'PASS' : 'FAIL'}`);
    for (const w of gate.warnings) lines.push(`- WARN: ${w}`);
    for (const f of gate.failures) lines.push(`- FAIL: ${f}`);
  }
  if (result.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const n of result.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n') + '\n';
}
