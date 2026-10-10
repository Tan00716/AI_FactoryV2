/**
 * Machine-readable test report + gate semantics — SPEC v2 §38.2.
 *
 * A trusted runner produces this report. The report is data; the gate
 * verdict is computed by code below — never by the runner's self-claim.
 *
 * Hard rules:
 *   - skipped / timeout / missing tool / infra error NEVER count as PASS;
 *   - a skipped MANDATORY test BLOCKS the gate (it does not "pass by absence");
 *   - a quarantined flaky test does not auto-PASS either (see flaky.ts).
 */
import { createHash } from 'node:crypto';
import type { CategoryResult } from './types';

/** One flaky test entry referenced by the report (detail lives in flaky.ts). */
export interface FlakyEntry {
  testId: string;
  attempts: number;
  quarantined: boolean;
}

/**
 * SPEC v2 §38.2 — the machine-readable report a trusted Runner generates:
 * total/passed/failed/skipped/errors, Exit Code, Duration, Flaky,
 * Environment Fingerprint, Artifact Refs.
 */
export interface TestReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Non-test errors: timeouts, missing tools, infra errors. Never PASS. */
  errors: number;
  exitCode: number | null;
  durationMs: number;
  flaky: FlakyEntry[];
  environmentFingerprint: string;
  artifactRefs: string[];
  categories: CategoryResult[];
  reportedAt: string;
  /** IDs of mandatory tests that were skipped (gate-relevant). */
  mandatorySkipped: string[];
}

/** Gate verdict derived from a report — computed here, not claimed by the runner. */
export type ReportGateVerdict = 'PASS' | 'FAIL' | 'BLOCKED';

/**
 * Build a stable environment fingerprint from the execution environment.
 * `labels` carries caller-supplied context (candidate digest, toolchain…).
 */
export function environmentFingerprint(labels: Record<string, string> = {}): string {
  const payload = JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ...labels,
  });
  return `env:${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
}

export interface BuildReportInput {
  categories: CategoryResult[];
  /** Runner-level errors: timeouts, missing tools, infra failures. */
  errors?: number;
  exitCode?: number | null;
  durationMs?: number;
  flaky?: FlakyEntry[];
  artifactRefs?: string[];
  environmentLabels?: Record<string, string>;
  mandatorySkipped?: string[];
  now?: () => number;
}

/** Assemble a TestReport from category results. Counts are recomputed, never trusted. */
export function buildTestReport(input: BuildReportInput): TestReport {
  const now = input.now ?? Date.now;
  const total = input.categories.reduce((n, c) => n + c.total, 0);
  const passed = input.categories.reduce((n, c) => n + c.passed, 0);
  const failed = input.categories.reduce((n, c) => n + c.failed, 0);
  const skipped = input.categories.reduce((n, c) => n + c.skipped, 0);
  return {
    total,
    passed,
    failed,
    skipped,
    errors: input.errors ?? 0,
    exitCode: input.exitCode ?? null,
    durationMs: input.durationMs ?? 0,
    flaky: input.flaky ?? [],
    environmentFingerprint: environmentFingerprint(input.environmentLabels),
    artifactRefs: input.artifactRefs ?? [],
    categories: input.categories,
    reportedAt: new Date(now()).toISOString(),
    mandatorySkipped: input.mandatorySkipped ?? [],
  };
}

/**
 * Compute the gate verdict for a report.
 *   FAIL    — any failed test or any runner error;
 *   BLOCKED — a mandatory test was skipped (or quarantined, see flaky.ts);
 *   PASS    — everything ran and passed.
 * Skipped optional tests alone never fail the run, but they never count as
 * passed either.
 */
export function reportGateVerdict(
  report: TestReport,
  opts: { quarantinedMandatory?: string[] } = {},
): ReportGateVerdict {
  if (report.failed > 0 || report.errors > 0) return 'FAIL';
  const blockedSkips = [...report.mandatorySkipped, ...(opts.quarantinedMandatory ?? [])];
  if (blockedSkips.length > 0) return 'BLOCKED';
  return 'PASS';
}

/** True when the report may be treated as "all green". */
export function isAllGreen(report: TestReport): boolean {
  return reportGateVerdict(report) === 'PASS';
}
