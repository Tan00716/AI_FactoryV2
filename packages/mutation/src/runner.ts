/**
 * @ai-factory/mutation — mutant execution.
 *
 * Safety model: mutants NEVER touch the real tree. Each run copies the
 * target dir into a scratch dir (under os.tmpdir()/TMPDIR), applies the
 * mutant there, and runs the test command with the scratch as cwd.
 * node_modules / .git / dist are excluded from the copy (tests run via
 * node's type-stripping directly on .ts sources, so no build is needed).
 *
 * Verdicts:
 *  - killed   — tests failed (non-zero exit or TAP "not ok")
 *  - survived — tests passed with the mutant applied
 *  - timeout  — the test command exceeded timeoutMs (circuit breaker)
 *  - invalid  — the mutated file fails `node --check` (JS syntax error) or
 *               fails to parse at import (loader SyntaxError naming the
 *               file); excluded from the score, like Stryker's compile errors.
 *               For TypeScript targets the --check gate is skipped (Node's
 *               checkSyntax does not type-strip) and only the import-time
 *               classifier applies.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Mutant, MutantRunOptions, MutantRunResult } from './types';

const SKIP_COPY = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/**
 * Child-process environment for mutant test runs.
 *
 * `spawn` inherits the parent env by default. When the mutation run itself
 * executes inside `node --test` (package tests, CI), the runner context
 * vars NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID leak into the mutant's
 * test process and `node --test` grandchildren silently run in a degraded
 * mode (exit 0 without really running the tests) — every mutant would
 * "survive". Strip them so each mutant run is a fresh top-level runner.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

export interface ScratchPrep {
  scratchDir: string;
  mutatedFileAbs: string;
  cleanup: () => void;
}

/**
 * Copy targetDir → fresh scratch dir, apply the mutated source to the
 * mutant's file copy. Returns the scratch locations + cleanup.
 */
export function prepareScratch(
  targetDir: string,
  mutant: Mutant,
  mutatedSource: string,
  scratchRoot?: string,
): ScratchPrep {
  const root = scratchRoot ?? tmpdir();
  const scratchDir = mkdtempSync(join(root, 'mutation-'));
  const cleanup = (): void => {
    rmSync(scratchDir, { recursive: true, force: true });
  };
  try {
    cpSync(targetDir, scratchDir, {
      recursive: true,
      filter: (src) => !SKIP_COPY.has(basename(src)),
    });
    const mutatedFileAbs = join(scratchDir, mutant.file);
    writeFileSync(mutatedFileAbs, mutatedSource);
    return { scratchDir, mutatedFileAbs, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Default test command: node's built-in runner with TAP output. */
export function defaultTestCommand(testFiles: string[]): string[] {
  return ['node', '--test', '--test-reporter=tap', ...testFiles];
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

function tailBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const buf = Buffer.from(s, 'utf8').subarray(-max);
  return '…[truncated]…' + buf.toString('utf8');
}

function runNodeCheck(mutatedFileAbs: string): { ok: boolean; output: string } {
  // Node's --check path (checkSyntax) does not type-strip: on Node 24 it
  // rejects even a valid typed .ts file ("Unexpected token ':'"), so the
  // gate would misclassify every typed mutant as 'invalid'. Skip the gate
  // for TypeScript; genuinely broken mutants are still caught after the
  // test run by the loader-SyntaxError classifier in runMutantTests.
  if (/\.(mts|cts|ts)$/.test(mutatedFileAbs)) {
    return { ok: true, output: 'node --check skipped for TypeScript (checkSyntax does not type-strip)' };
  }
  try {
    const r = spawnSync(process.execPath, ['--check', mutatedFileAbs], {
      encoding: 'utf8',
      timeout: 15_000,
      env: childEnv(),
    });
    if (r.error) return { ok: true, output: `node --check unavailable (${(r.error as Error).message}); skipped` };
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return { ok: r.status === 0, output: out };
  } catch (e) {
    return { ok: true, output: `node --check unavailable (${(e as Error).message}); skipped` };
  }
}

export interface PreparedRun {
  scratchDir: string;
  mutatedFileAbs: string;
}

/**
 * Execute the test command in the scratch dir and classify the verdict.
 * Does not throw for test failures — those are verdicts, not errors.
 */
export async function runMutantTests(
  mutant: Mutant,
  prep: PreparedRun,
  opts: MutantRunOptions,
): Promise<Omit<MutantRunResult, 'mutant'>> {
  const started = Date.now();
  const maxOut = opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
  if (opts.nodeCheck) {
    const check = runNodeCheck(prep.mutatedFileAbs);
    if (!check.ok) {
      return {
        verdict: 'invalid',
        durationMs: Date.now() - started,
        exitCode: null,
        timedOut: false,
        outputTail: tailBytes(check.output, maxOut),
        note: 'node --check failed: mutant is not syntactically valid (excluded from score)',
      };
    }
  }
  const [cmd, ...args] = opts.testCommand;
  const outcome = await new Promise<{ exitCode: number | null; timedOut: boolean; output: string }>((resolve) => {
    let output = '';
    let settled = false;
    const finish = (r: { exitCode: number | null; timedOut: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: prep.scratchDir, timeout: opts.timeoutMs, env: childEnv() });
    } catch (e) {
      finish({ exitCode: null, timedOut: false, output: `spawn failed: ${(e as Error).message}` });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (output.length < maxOut * 2) output += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (output.length < maxOut * 2) output += d.toString('utf8');
    });
    child.on('error', (e) => finish({ exitCode: null, timedOut: false, output: `spawn error: ${e.message}` }));
    child.on('close', (code, signal) => {
      // SIGTERM after the full budget elapsed = our circuit breaker fired.
      const timedOut = signal === 'SIGTERM' && Date.now() - started >= opts.timeoutMs;
      finish({ exitCode: code, timedOut, output });
    });
  });
  const durationMs = Date.now() - started;
  if (outcome.timedOut) {
    return {
      verdict: 'timeout',
      durationMs,
      exitCode: outcome.exitCode,
      timedOut: true,
      outputTail: tailBytes(outcome.output, maxOut),
      note: `test command exceeded ${opts.timeoutMs}ms (circuit breaker)`,
    };
  }
  // A mutant that cannot even be parsed at import is not a meaningful test
  // of the assertions: 'invalid', excluded from the score (Stryker's
  // compile-error treatment). `node --check` is lenient on .ts (type
  // stripping), so also catch the loader's syntax error here — but only
  // when it names the mutated file, so an unrelated SyntaxError inside a
  // passing test body is never misclassified.
  const namesMutatedFile =
    outcome.output.includes(prep.mutatedFileAbs) || outcome.output.includes(mutant.file);
  if (/SyntaxError|ERR_INVALID_TYPESCRIPT_SYNTAX/.test(outcome.output) && namesMutatedFile) {
    return {
      verdict: 'invalid',
      durationMs,
      exitCode: outcome.exitCode,
      timedOut: false,
      outputTail: tailBytes(outcome.output, maxOut),
      note: 'mutant failed to parse at import (excluded from score)',
    };
  }
  const failed = outcome.exitCode !== 0 || /^\s*not ok\b/m.test(outcome.output);
  return {
    verdict: failed ? 'killed' : 'survived',
    durationMs,
    exitCode: outcome.exitCode,
    timedOut: false,
    outputTail: tailBytes(outcome.output, maxOut),
    note: failed ? 'tests failed with mutant applied' : 'tests passed with mutant applied',
  };
}

/** Read a target file's original source (for applying mutants). */
export function readTargetFile(targetDir: string, relFile: string): string {
  return readFileSync(join(targetDir, relFile), 'utf8');
}
