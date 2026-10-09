/**
 * Suite runners — spec §37. A SuiteRunner executes one test category and
 * returns a machine-readable CategoryResult. `runQa` aggregates multiple
 * suites into a QaResultPayload (§37 example shape).
 */

import { spawnSync } from 'child_process';
import {
  CategoryResult,
  FailureRecord,
  QaResultPayload,
  QaVerdict,
  TestCategory,
} from './types';

/** One test suite for a single category. */
export interface SuiteRunner {
  category: TestCategory;
  name: string;
  run(): Promise<CategoryResult>;
}

const TAP_OK_RE = /^ok\s+\d+/;
const TAP_NOT_OK_RE = /^not\s+ok\s+\d+/;
const TAP_SKIP_RE = /#\s*SKIP/i;

interface TapCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

function parseTap(output: string): TapCounts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (TAP_NOT_OK_RE.test(t)) {
      failed++;
      if (TAP_SKIP_RE.test(t)) skipped++;
    } else if (TAP_OK_RE.test(t)) {
      passed++;
      if (TAP_SKIP_RE.test(t)) skipped++;
    }
  }
  return { total: passed + failed, passed, failed, skipped };
}

function tail(s: string, max = 4000): string {
  return s.length > max ? `…${s.slice(s.length - max)}` : s;
}

/**
 * Spawns `command args...` and parses `node --test --test-reporter=tap`
 * output. TAP `ok`/`not ok` lines become the counts; a nonzero exit or
 * unparseable output is a FAIL with the captured output attached so the
 * Failure Analyzer (§38) can classify it.
 */
export function shellRunner(
  category: TestCategory,
  name: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): SuiteRunner {
  return {
    category,
    name,
    async run(): Promise<CategoryResult> {
      const started = Date.now();
      const base: Omit<CategoryResult, 'verdict'> = {
        category,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
      };
      let proc;
      try {
        proc = spawnSync(command, args, {
          cwd,
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch (err) {
        return {
          ...base,
          verdict: 'FAIL',
          failed: 1,
          total: 1,
          durationMs: Date.now() - started,
          output: tail(`spawn failed: ${(err as Error).message}`),
        };
      }
      const stdout = proc.stdout ?? '';
      const stderr = proc.stderr ?? '';
      const counts = parseTap(stdout);
      const verdict: QaVerdict =
        proc.status !== 0 || counts.total === 0 || counts.failed > 0
          ? 'FAIL'
          : 'PASS';
      const output =
        verdict === 'FAIL'
          ? tail([stderr, stdout].filter(Boolean).join('\n\n'))
          : undefined;
      return {
        ...base,
        total: counts.total || (verdict === 'FAIL' ? 1 : 0),
        passed: counts.passed,
        failed: counts.failed || (verdict === 'FAIL' && counts.total === 0 ? 1 : 0),
        skipped: counts.skipped,
        verdict,
        durationMs: Date.now() - started,
        output,
      };
    },
  };
}

/** A runner that simply reports SKIPPED — for categories with no suite. */
export function skippedRunner(category: TestCategory, name: string): SuiteRunner {
  return {
    category,
    name,
    async run(): Promise<CategoryResult> {
      return {
        category,
        verdict: 'SKIPPED',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
      };
    },
  };
}

/**
 * Execute suites sequentially and aggregate into a machine-readable
 * QaResultPayload (§37). Overall verdict is FAIL if any category failed;
 * SKIPPED categories never fail the run.
 */
export async function runQa(
  _taskId: string,
  runners: SuiteRunner[],
  _opts?: { actor?: string },
): Promise<QaResultPayload> {
  const categories: CategoryResult[] = [];
  for (const r of runners) {
    categories.push(await r.run());
  }
  return aggregate(categories, []);
}

/** Merge per-category results + any failure records into a payload. */
export function aggregate(
  categories: CategoryResult[],
  failures: FailureRecord[],
): QaResultPayload {
  const total = categories.reduce((n, c) => n + c.total, 0);
  const passed = categories.reduce((n, c) => n + c.passed, 0);
  const failed = categories.reduce((n, c) => n + c.failed, 0);
  const skipped = categories.reduce((n, c) => n + c.skipped, 0);
  const verdict: QaVerdict = categories.some((c) => c.verdict === 'FAIL')
    ? 'FAIL'
    : 'PASS';
  return { verdict, total, passed, failed, skipped, categories, failures };
}

/**
 * Build the §37 machine-readable payload object attached as a 'qa_result'
 * evidence record (spec example: { verdict, total, passed, failed, skipped }).
 */
export function qaEvidencePayload(result: QaResultPayload): Record<string, unknown> {
  return {
    verdict: result.verdict,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    categories: result.categories.map((c) => ({
      category: c.category,
      verdict: c.verdict,
      total: c.total,
      passed: c.passed,
      failed: c.failed,
      skipped: c.skipped,
      durationMs: c.durationMs,
    })),
    failures: result.failures.map((f) => ({
      attempt: f.attempt,
      category: f.category,
      classification: f.classification,
      owner: f.owner,
      message: f.message,
      at: f.at,
    })),
  };
}
