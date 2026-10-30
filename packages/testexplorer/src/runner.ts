/**
 * node:test runner child (Round 7 #3).
 *
 * Invoked by run.ts as: `node runner.js --file <abs> [--file ...]
 * [--pattern <regex> ...]`. Uses the programmatic `run()` API so each
 * leaf test reports its own status, duration and failure output —
 * something TAP text cannot give per case.
 *
 * Results go to file descriptor 3 as one JSON object per line (test
 * stdout/stderr stay on their own pipes, so test output can never
 * corrupt the result stream). A final `__summary` line closes the
 * stream. If fd 3 is unavailable, lines fall back to stdout prefixed
 * with `__TESTEXPLORER__ `.
 *
 * Name matching: node:test patterns match a test's own name only, NOT
 * the describe chain, so a single-case run passes the leaf name
 * (`^leaf$`). Duplicate leaf names in one file all run; run.ts reports
 * that count honestly instead of pretending the run was singular.
 */
import { run } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface LeafEvent {
  name: string;
  nesting: number;
  testId: number;
  parentId: number;
  /** Enqueue/start events carry the kind at top level. */
  type?: string;
  details?: {
    type?: string;
    passed?: boolean;
    duration_ms?: number;
    classname?: string;
    error?: unknown;
  };
  skip?: boolean;
  todo?: boolean;
  file?: string;
  entryFile?: string;
}

function emit(obj: unknown): void {
  const line = `${JSON.stringify(obj)}\n`;
  try {
    fs.writeSync(3, line);
  } catch {
    process.stdout.write(`__TESTEXPLORER__ ${line}`);
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' ? err.stack : '';
    const msg = err.message || String(err);
    return stack.includes(msg) ? stack : `${msg}\n${stack}`;
  }
  return String(err ?? '');
}

function main(): void {
  const args = process.argv.slice(2);
  const files: string[] = [];
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === '--file') {
      const v = args[i + 1] as string | undefined;
      if (v) files.push(v);
      i += 1;
    } else if (a === '--pattern') {
      const v = args[i + 1] as string | undefined;
      if (v) patterns.push(v);
      i += 1;
    }
  }
  if (files.length === 0) {
    emit({ __summary: { pass: 0, fail: 0, skip: 0, todo: 0, total: 0, error: 'no --file given' } });
    process.exitCode = 2;
    return;
  }

  // testId -> { name, parentId, isSuite } for fullName reconstruction.
  const nodes = new Map<number, { name: string; parentId: number; isSuite: boolean }>();
  const summary = { pass: 0, fail: 0, skip: 0, todo: 0, total: 0 };
  // Files that produced at least one leaf case, and per-file stderr
  // (where load failures like MODULE_NOT_FOUND actually surface).
  const leafFiles = new Set<string>();
  const fileFailed = new Map<string, boolean>();
  const fileStderr = new Map<string, string>();

  const runner = run({
    files,
    testNamePatterns: patterns.length > 0 ? patterns : undefined,
  });

  runner.on('test:enqueue', (t: LeafEvent) => {
    nodes.set(t.testId, {
      name: t.name,
      parentId: t.parentId,
      // Enqueue carries the kind at top level; the file entry and its
      // first suite share a testId, and last-write-wins keeps the suite,
      // which is exactly what fullName reconstruction needs.
      isSuite: t.type === 'suite',
    });
  });
  // test:start carries the same identity for nodes enqueued before we
  // subscribed; harmless to overwrite.
  runner.on('test:start', (t: LeafEvent) => {
    if (!nodes.has(t.testId)) {
      nodes.set(t.testId, { name: t.name, parentId: t.parentId, isSuite: false });
    }
  });

  runner.on('test:stderr', (m: { file?: string; message?: string }) => {
    const f = m.file;
    if (!f || typeof m.message !== 'string') return;
    const prev = fileStderr.get(f) ?? '';
    if (prev.length < 4000) fileStderr.set(f, (prev + m.message).slice(0, 4000));
  });

  runner.on('test:complete', (t: LeafEvent) => {
    const details = t.details ?? {};
    if (details.type !== 'test') return; // suites report separately; skip them
    const file = t.entryFile ?? t.file ?? files[0] ?? '';
    // The file-level entry itself (nesting 0, parent of nothing) is not
    // a case: its name is the file basename for real files, the absolute
    // path for files that failed to load. Record its failure instead.
    if (t.nesting === 0 && t.parentId === 0) {
      if (t.name === file || t.name === path.basename(file)) {
        fileFailed.set(file, details.passed !== true);
        return;
      }
    }
    leafFiles.add(file);
    const chain: string[] = [];
    let cur = nodes.get(t.parentId);
    const guard = new Set<number>();
    while (cur && cur.parentId !== 0 && !guard.has(cur.parentId)) {
      guard.add(cur.parentId);
      if (cur.isSuite) chain.unshift(cur.name);
      cur = nodes.get(cur.parentId);
    }
    // Fallback: node:test reports the immediate suite as `classname`.
    // When a name pattern filters the run, ancestor suites never enqueue,
    // so the chain is empty and classname is the best available prefix;
    // the route layer replaces this with the discovery fullName when it
    // can match the case uniquely.
    const classname = (details as { classname?: unknown }).classname;
    const fullName = chain.length > 0
      ? [...chain, t.name].join(' > ')
      : typeof classname === 'string' && classname
        ? `${classname} > ${t.name}`
        : t.name;
    const status = t.skip ? 'skip' : t.todo ? 'todo' : details.passed ? 'pass' : 'fail';
    summary[status] += 1;
    summary.total += 1;
    const out: Record<string, unknown> = {
      file,
      name: t.name,
      fullName,
      status,
      durationMs: typeof details.duration_ms === 'number' ? details.duration_ms : 0,
    };
    if (status === 'fail' && details.error !== undefined) {
      out['error'] = errorText(details.error);
    }
    emit(out);
  });

  runner.on('test:diagnostic', (m: unknown) => {
    // Diagnostics carry only totals; the summary line below is authoritative.
    void m;
  });

  // TestsStream only ends once consumed: attach a no-op data handler so
  // 'end' fires when all test files settle, then close with a summary.
  let summarySent = false;
  const sendSummary = (extra?: Record<string, unknown>): void => {
    if (summarySent) return;
    summarySent = true;
    // Files with no leaf cases still deserve a verdict: a failed load
    // (missing file, syntax error) otherwise vanishes into "0 results".
    for (const f of files) {
      if (leafFiles.has(f)) continue;
      const errText = fileStderr.get(f) ?? '';
      emit({
        __file: f,
        cases: 0,
        failed: fileFailed.get(f) === true,
        error: errText ? errText.split('\n').filter(Boolean).slice(0, 3).join(' | ') : undefined,
      });
    }
    emit({ __summary: { ...summary, ...(extra ?? {}) } });
  };
  runner.on('data', () => {});
  runner.on('end', () => sendSummary());
  runner.on('error', (err: unknown) => sendSummary({ error: errorText(err) }));
}

try {
  main();
} catch (err) {
  emit({ __summary: { pass: 0, fail: 0, skip: 0, todo: 0, total: 0, error: errorText(err) } });
  process.exitCode = 2;
}
