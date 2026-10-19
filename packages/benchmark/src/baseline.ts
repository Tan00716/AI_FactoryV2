/**
 * Baseline persistence + comparison — task 10.
 *
 * Baselines are committed JSON files (one per adapter) so CI can diff the
 * current run against the last known-good state. Writes are atomic
 * (temp + rename); a corrupt baseline fails closed (treated as absent,
 * never as "everything regressed").
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Baseline,
  BaselineCaseEntry,
  BaselineComparison,
  BenchmarkReport,
  CaseDiff,
} from './types';

export function defaultBaselinePath(adapter: string, packageDir?: string): string {
  // NOTE: callers running from dist/ must pass the *package* dir —
  // __dirname inside dist/src is two levels below the package root.
  const base = packageDir ?? join(__dirname, '..', '..');
  return join(base, 'baselines', `${adapter}.json`);
}

export function reportToBaseline(report: BenchmarkReport): Baseline {
  const cases: Record<string, BaselineCaseEntry> = {};
  for (const r of report.cases) {
    cases[r.caseId] = {
      pass: r.pass,
      latencyMs: r.latencyMs,
      steps: r.steps,
      modelCalls: r.modelCalls,
      toolCalls: r.toolCalls,
      tokenEstimate: r.tokenEstimate,
    };
  }
  return {
    adapter: report.adapter,
    generatedAt: report.generatedAt,
    appVersion: report.appVersion,
    cases,
  };
}

/** Load a baseline; returns null when absent or corrupt (fail-closed). */
export function loadBaseline(path: string): Baseline | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    if (!parsed || typeof parsed !== 'object' || !parsed.cases || typeof parsed.cases !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half baseline. */
export function saveBaseline(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export interface DiffOptions {
  /**
   * Fractional latency drift that counts as a note (e.g. 1.0 = 2x slower).
   * Latency drift is a warning, never a gate failure — only success
   * regressions fail the gate.
   */
  latencyTolerance?: number;
}

export function diffBaseline(
  baseline: Baseline,
  report: BenchmarkReport,
  opts: DiffOptions = {},
): BaselineComparison {
  const tolerance = opts.latencyTolerance ?? 1.0;
  const diffs: CaseDiff[] = [];
  const regressions: string[] = [];
  const newCases: string[] = [];
  const removedCases: string[] = [];
  const current = reportToBaseline(report);

  for (const [caseId, entry] of Object.entries(current.cases)) {
    const base = baseline.cases[caseId];
    if (!base) {
      newCases.push(caseId);
      diffs.push({ caseId, status: 'new', notes: ['no baseline entry — will be recorded on --update-baseline'] });
      continue;
    }
    const notes: string[] = [];
    let status: CaseDiff['status'] = 'unchanged';
    if (base.pass && !entry.pass) {
      status = 'regression';
      regressions.push(caseId);
      notes.push('passed in baseline, fails now');
    } else if (!base.pass && entry.pass) {
      status = 'fixed';
      notes.push('failed in baseline, passes now');
    }
    if (base.latencyMs > 0) {
      const drift = (entry.latencyMs - base.latencyMs) / base.latencyMs;
      if (drift > tolerance) {
        notes.push(`latency drift: ${base.latencyMs}ms → ${entry.latencyMs}ms (+${Math.round(drift * 100)}%)`);
      }
    }
    if (entry.steps !== base.steps) {
      notes.push(`steps: ${base.steps} → ${entry.steps}`);
    }
    diffs.push({ caseId, status, notes });
  }

  for (const caseId of Object.keys(baseline.cases)) {
    if (!current.cases[caseId]) {
      removedCases.push(caseId);
      diffs.push({ caseId, status: 'removed', notes: ['in baseline but not in this run'] });
    }
  }

  return { diffs, regressions, newCases, removedCases };
}
