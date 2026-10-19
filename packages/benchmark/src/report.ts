/**
 * Report rendering + CI gate — task 10.
 *
 * The gate is deliberately conservative: any success regression
 * (baseline-pass → now-fail) or a pass-rate drop fails CI. Latency drift
 * is surfaced as a warning, never a failure — wall-clock timings are
 * environment-sensitive and must not red-flag CI on a busy runner.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Baseline,
  BaselineComparison,
  BenchmarkReport,
  GateResult,
} from './types';

export interface GateOptions {
  /** Minimum acceptable pass rate (0..1). Defaults to the baseline's rate. */
  minPassRate?: number;
}

export function checkGate(
  report: BenchmarkReport,
  baseline: Baseline | null,
  comparison: BaselineComparison | null,
  opts: GateOptions = {},
): GateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let floor = opts.minPassRate;
  if (floor === undefined && baseline) {
    const entries = Object.values(baseline.cases);
    const passed = entries.filter((e) => e.pass).length;
    floor = entries.length === 0 ? 0 : passed / entries.length;
  }
  floor ??= 1.0;

  if (comparison && comparison.regressions.length > 0) {
    reasons.push(
      `success regressions vs baseline: ${comparison.regressions.join(', ')}`,
    );
  }
  if (report.summary.passRate < floor) {
    reasons.push(
      `pass rate ${(report.summary.passRate * 100).toFixed(1)}% below floor ${(floor * 100).toFixed(1)}%`,
    );
  }
  if (comparison) {
    for (const d of comparison.diffs) {
      for (const n of d.notes) {
        if (n.startsWith('latency drift')) warnings.push(`${d.caseId}: ${n}`);
      }
    }
    if (comparison.newCases.length > 0) {
      warnings.push(`new cases without baseline: ${comparison.newCases.join(', ')}`);
    }
    if (comparison.removedCases.length > 0) {
      warnings.push(`cases removed since baseline: ${comparison.removedCases.join(', ')}`);
    }
  }
  return { pass: reasons.length === 0, reasons, warnings };
}

/** Human-readable summary table for the console. */
export function formatSummaryTable(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`adapter: ${report.adapter}   app: ${report.appVersion}   generated: ${report.generatedAt}`);
  lines.push('');
  const head = ['case', 'pass', 'outcome', 'latency', 'steps', 'mCalls', 'tCalls', 'tokEst'];
  lines.push(head.map((h) => h.padEnd(12)).join(''));
  lines.push('-'.repeat(100));
  for (const r of report.cases) {
    lines.push(
      [
        r.caseId.slice(0, 12).padEnd(12),
        (r.pass ? 'PASS' : 'FAIL').padEnd(12),
        r.outcome.slice(0, 12).padEnd(12),
        `${r.latencyMs}ms`.padEnd(12),
        String(r.steps).padEnd(12),
        String(r.modelCalls).padEnd(12),
        String(r.toolCalls).padEnd(12),
        String(r.tokenEstimate).padEnd(12),
      ].join(''),
    );
    for (const reason of r.failReasons) {
      lines.push(`  ! ${reason}`);
    }
  }
  lines.push('-'.repeat(100));
  const s = report.summary;
  lines.push(
    `total ${s.total}  passed ${s.passed}  failed ${s.failed}  ` +
      `passRate ${(s.passRate * 100).toFixed(1)}%  ` +
      `avgLatency ${s.avgLatencyMs}ms  totalTokEst ${s.totalTokenEstimate}`,
  );
  lines.push(`token estimate method: ${report.cases[0]?.tokenEstimateMethod ?? 'n/a'}`);
  return lines.join('\n');
}

/** Write the machine-readable JSON report (CI artifact). Creates dirs as needed. */
export function writeReportJson(path: string, report: BenchmarkReport): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return path;
}
