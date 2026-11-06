/**
 * Flaky-test routes (round-3 task 3) — Buildkite Test Engine style.
 *
 *   GET  /api/flaky?projectId=        config + classified tests + recent runs (viewer)
 *   PUT  /api/flaky                   {projectId, windowSize?, minRuns?} (operator)
 *   POST /api/flaky/record            {projectId, tap, file?, label?} — parse TAP text and record (operator)
 *   POST /api/flaky/runs              {projectId, files: string[]} — run test files through the
 *                                       TMPDIR wrapper with --test-reporter=tap and record (operator)
 *   POST /api/flaky/clear             {projectId} — wipe the project's history (operator)
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleFlakyRoutes, runFlakyGateLinkage } from './routes/flaky';
 *   if (await handleFlakyRoutes(req, res, url, routeCtx)) return;
 *   setFlakyGateLinkage((args) => runFlakyGateLinkage(args));
 *
 * RBAC: the default prefix rule in auth.ts (requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no auth.ts
 * change needed.
 *
 * Audit: FLAKY_CONFIG_UPDATED / FLAKY_RUN_RECORDED / FLAKY_HISTORY_CLEARED /
 * QUALITY_GATE_FLAKY_RERUN.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - History only contains runs that were explicitly recorded here.
 *    Quality-gate runs are NEVER auto-recorded — the gate linkage is
 *    read-only on history plus one explicit rerun.
 *  - POST /api/flaky/runs executes test files on the server. Files are
 *    jailed to the server repo root, capped in count, and each file runs
 *    with a wall-clock timeout. This is an operator action, not a
 *    background automation.
 *  - "Flaky" is an annotation, never a verdict: the gate linkage cannot
 *    turn a failure green.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import { scrubCredentialEnv } from '@ai-factory/runtime';
import { redactText } from '@ai-factory/diagpack';
import type { RouteContext } from './context';
import type { QualityGateRunResult } from '../quality-gate';
import {
  DEFAULT_FLAKY_CONFIG,
  FlakyHistoryStore,
  FlakyStoreError,
  parseTapOutput,
} from '../flaky';

const PREFIX = '/api/flaky';
/** Per-file wall-clock budget for POST /api/flaky/runs. */
const FLAKY_RUN_TIMEOUT_MS = 300_000;
/** Per-file stdout cap (TAP from a big suite can be megabytes). */
const MAX_FLAKY_RUN_OUTPUT = 2 * 1024 * 1024;
/** Max files per /api/flaky/runs call. */
const MAX_RUN_FILES = 20;
/** Max TAP text accepted by /api/flaky/record. */
const MAX_TAP_TEXT = 8 * 1024 * 1024;

export class FlakyRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlakyRouteError';
  }
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

/**
 * Strip the node --test runner context vars from a child env (see
 * runTapFile): without this, a `node --test` grandchild inherits
 * NODE_TEST_CONTEXT and silently runs in degraded mode.
 */
function stripTestRunnerContext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

function storeOf(): FlakyHistoryStore {
  return new FlakyHistoryStore();
}

/** Repo root = cwd when the server boots from the repo (fail-closed otherwise). */
function repoRoot(): string {
  const cwd = process.cwd();
  if (!existsSync(resolve(cwd, 'scripts/run-tests-tmp.mjs'))) {
    throw new FlakyRouteError('test runner wrapper not found under the server working directory');
  }
  return cwd;
}

/** Jail a requested test file to the repo root; fail-closed. */
function jailTestFile(root: string, file: string): string {
  if (typeof file !== 'string' || !file.trim() || file.length > 512) {
    throw new FlakyRouteError(`invalid test file: ${String(file).slice(0, 80)}`);
  }
  const abs = resolve(root, file);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new FlakyRouteError(`test file escapes the repo root: ${file}`);
  }
  if (!existsSync(abs)) {
    throw new FlakyRouteError(`test file does not exist: ${file}`);
  }
  return abs;
}

interface TapRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

function runTapFile(root: string, file: string, timeoutMs: number): Promise<TapRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [resolve(root, 'scripts/run-tests-tmp.mjs'), '--test', '--test-reporter=tap', file],
      // R16 N3: scrub the ambient credential env — without `env`, spawn
      // inherits the full parent env, and a test name built from
      // process.env.FACTORY_API_TOKEN lands verbatim in tests[].key/name.
      // Also strip the node --test runner context vars (same reason as
      // the mutation runner's childEnv): a `node --test` grandchild that
      // inherits NODE_TEST_CONTEXT silently degrades — exit 0 without
      // really running the tests — so a flaky run triggered while the
      // server itself runs under a test harness would record nothing.
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: stripTestRunnerContext(scrubCredentialEnv(process.env)),
      },
    );
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, timedOut, truncated });
    };
    const onData = (chunk: Buffer, which: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length + text.length > MAX_FLAKY_RUN_OUTPUT) {
          stdout += text.slice(0, MAX_FLAKY_RUN_OUTPUT - stdout.length);
          truncated = true;
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length < 64 * 1024) stderr += text.slice(0, 64 * 1024 - stderr.length);
      }
    };
    child.stdout?.on('data', (c: Buffer) => onData(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => onData(c, 'err'));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

export async function handleFlakyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const actor = 'human';

  // GET /api/flaky?projectId=
  if (method === 'GET' && path === PREFIX) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    try {
      const store = storeOf();
      const { config, tests, runs, total } = store.list(projectId);
      const counts = {
        flaky: tests.filter((t) => t.status === 'flaky').length,
        alwaysFailing: tests.filter((t) => t.status === 'always-failing').length,
        stable: tests.filter((t) => t.status === 'stable').length,
        insufficientData: tests.filter((t) => t.status === 'insufficient-data').length,
      };
      ctx.json(res, 200, {
        projectId,
        config,
        defaults: { ...DEFAULT_FLAKY_CONFIG },
        tests,
        runs,
        total,
        counts,
        note: 'History only contains explicitly recorded runs; quality-gate runs are never auto-recorded.',
      });
    } catch (e) {
      const code = e instanceof FlakyStoreError ? 500 : 500;
      ctx.json(res, code, { error: (e as Error).message });
    }
    return true;
  }

  // PUT /api/flaky {projectId, windowSize?, minRuns?}
  if (method === 'PUT' && path === PREFIX) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    try {
      const store = storeOf();
      const { config, errors } = store.setConfig(projectId, {
        windowSize: body['windowSize'],
        minRuns: body['minRuns'],
      });
      if (errors.length > 0) {
        ctx.json(res, 400, { error: errors.join('; ') });
        return true;
      }
      ctx.audit.record(actor, 'FLAKY_CONFIG_UPDATED', 'flaky', projectId, { config });
      ctx.json(res, 200, { projectId, config });
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/flaky/record {projectId, tap, file?, label?}
  if (method === 'POST' && path === `${PREFIX}/record`) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const tap = body['tap'];
    if (typeof tap !== 'string' || !tap.trim()) {
      ctx.json(res, 400, { error: 'tap (TAP output text) is required' });
      return true;
    }
    if (tap.length > MAX_TAP_TEXT) {
      ctx.json(res, 400, { error: `tap text exceeds the ${MAX_TAP_TEXT} byte cap` });
      return true;
    }
    const file = typeof body['file'] === 'string' ? body['file'].trim().slice(0, 512) : '';
    const label =
      typeof body['label'] === 'string' && body['label'].trim()
        ? body['label'].trim().slice(0, 200)
        : 'manual TAP ingest';
    try {
      const store = storeOf();
      const parsed = parseTapOutput(tap, { file });
      if (parsed.outcomes.length === 0) {
        ctx.json(res, 400, {
          error:
            'no test outcomes parsed — input is not node --test TAP (use --test-reporter=tap); nothing was recorded',
          stats: parsed.stats,
        });
        return true;
      }
      const result = store.recordRun(projectId, parsed.outcomes, { label, file: file || undefined });
      ctx.audit.record(actor, 'FLAKY_RUN_RECORDED', 'flaky', projectId, {
        runId: result.summary.runId,
        // R17 N4: the label is operator-supplied free text and can carry a
        // literal credential shape; redact it before it enters the
        // append-only audit chain (viewer-readable via GET /api/audit),
        // same as the runhistory side already does (store.ts record()).
        // Known boundary: redactText does NOT mask a literal
        // `FACTORY_API_TOKEN=`-shaped value — that shape needs the planned
        // #6(h) value-aware redaction, so it is deliberately not asserted.
        label: redactText(label),
        file: file || null,
        total: result.summary.total,
        passed: result.summary.passed,
        failed: result.summary.failed,
        newlyFlaky: result.newlyFlaky,
        newlyStable: result.newlyStable,
      });
      ctx.json(res, 200, {
        projectId,
        summary: result.summary,
        stats: parsed.stats,
        newlyFlaky: result.newlyFlaky,
        newlyStable: result.newlyStable,
      });
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/flaky/runs {projectId, files: string[]}
  if (method === 'POST' && path === `${PREFIX}/runs`) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const files = body['files'];
    if (!Array.isArray(files) || files.length === 0) {
      ctx.json(res, 400, { error: 'files (non-empty array of repo-relative test paths) is required' });
      return true;
    }
    if (files.length > MAX_RUN_FILES) {
      ctx.json(res, 400, { error: `at most ${MAX_RUN_FILES} files per call` });
      return true;
    }
    try {
      const root = repoRoot();
      const jailed = files.map((f) => jailTestFile(root, f));
      const store = storeOf();
      const perFile: Array<{
        file: string;
        exitCode: number | null;
        timedOut: boolean;
        truncated: boolean;
        total: number;
        passed: number;
        failed: number;
        newlyFlaky: string[];
      }> = [];
      for (let i = 0; i < jailed.length; i++) {
        const rel = files[i] as string;
        const run = await runTapFile(root, jailed[i], FLAKY_RUN_TIMEOUT_MS);
        const parsed = parseTapOutput(run.stdout, { file: rel });
        let newlyFlaky: string[] = [];
        let summary: { total: number; passed: number; failed: number } = {
          total: 0,
          passed: 0,
          failed: 0,
        };
        if (parsed.outcomes.length > 0) {
          const result = store.recordRun(projectId, parsed.outcomes, {
            label: `server run ${rel}`,
            file: rel,
          });
          summary = result.summary;
          newlyFlaky = result.newlyFlaky;
        }
        perFile.push({
          file: rel,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          truncated: run.truncated,
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          newlyFlaky,
        });
        ctx.audit.record(actor, 'FLAKY_RUN_RECORDED', 'flaky', projectId, {
          // R17 N4, second call site: the label embeds the operator-supplied
          // file path, so it gets the same redactText treatment as the
          // record route's label above (same action, same field).
          label: redactText(`server run ${rel}`),
          file: rel,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          parsedOutcomes: parsed.outcomes.length,
          newlyFlaky,
        });
      }
      const allNewlyFlaky = [...new Set(perFile.flatMap((f) => f.newlyFlaky))];
      ctx.json(res, 200, { projectId, files: perFile, newlyFlaky: allNewlyFlaky });
    } catch (e) {
      const status = e instanceof FlakyRouteError ? 400 : 500;
      ctx.json(res, status, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/flaky/clear {projectId}
  if (method === 'POST' && path === `${PREFIX}/clear`) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    try {
      storeOf().clear(projectId);
      ctx.audit.record(actor, 'FLAKY_HISTORY_CLEARED', 'flaky', projectId, {});
      ctx.json(res, 200, { projectId, cleared: true });
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Quality-gate linkage: "quarantine + rerun once" (round-3 ③, optional)
// ---------------------------------------------------------------------------

export interface FlakyGateLinkageArgs {
  ctx: RouteContext;
  projectId: string;
  actor: string;
  runId?: string;
  /** The failed gate run's stdout (expected to be TAP when rerunFlakyOnce is useful). */
  stdout: string;
  testCmd: string;
  /** Runs the gate test command once more; provided by routes/quality.ts. */
  rerun: () => Promise<QualityGateRunResult>;
}

/**
 * Quarantine known-flaky failures and run the test command once more.
 * Annotation only: the returned payload never flips the gate verdict —
 * a flaky test is never auto-passed. Gate runs are not recorded into
 * flaky history (history is explicit-record only).
 */
export async function runFlakyGateLinkage(args: FlakyGateLinkageArgs): Promise<Record<string, unknown>> {
  const { ctx, projectId, actor, runId, stdout, testCmd, rerun } = args;
  const store = storeOf();
  const audited = (payload: Record<string, unknown>): Record<string, unknown> => {
    ctx.audit.record(actor, 'QUALITY_GATE_FLAKY_RERUN', 'quality-gate', `${projectId}:test`, {
      runId: runId ?? null,
      ...payload,
    });
    return payload;
  };
  let tap;
  try {
    tap = parseTapOutput(stdout, { file: testCmd });
  } catch (e) {
    return audited({ attempted: false, reason: `TAP parse failed: ${(e as Error).message}` });
  }
  if (tap.outcomes.length === 0) {
    return audited({
      attempted: false,
      reason:
        'gate output has no TAP-parseable test outcomes (needs node --test --test-reporter=tap); flaky rerun skipped',
    });
  }
  const failing = tap.outcomes.filter((o) => o.status === 'fail');
  if (failing.length === 0) {
    return audited({ attempted: false, reason: 'gate failed but no failing test lines were parsed' });
  }
  const knownFlaky = failing
    .filter((o) => store.get(projectId, o.key)?.status === 'flaky')
    .map((o) => o.key);
  const otherFailing = failing.map((o) => o.key).filter((k) => !knownFlaky.includes(k));
  let second: QualityGateRunResult;
  try {
    second = await rerun();
  } catch (e) {
    return audited({
      attempted: true,
      firstRun: { failing: failing.map((o) => o.key), knownFlaky, otherFailing },
      rerun: { error: (e as Error).message },
      note: 'Rerun failed to execute; original gate verdict stands.',
    });
  }
  const tap2 = parseTapOutput(second.stdout, { file: testCmd });
  const rerunFailing = tap2.outcomes.filter((o) => o.status === 'fail').map((o) => o.key);
  return audited({
    attempted: true,
    firstRun: { failing: failing.map((o) => o.key), knownFlaky, otherFailing },
    rerun: {
      ok: second.ok,
      exitCode: second.exitCode,
      timedOut: second.timedOut,
      parsedOutcomes: tap2.outcomes.length,
      failing: rerunFailing,
    },
    note: 'Flaky matches are annotated only — the original gate verdict stands; a flaky test is never auto-passed.',
  });
}
