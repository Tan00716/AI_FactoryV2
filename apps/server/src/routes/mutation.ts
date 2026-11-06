/**
 * Mutation-testing routes (round-3 task R3-T2) — StrykerJS style.
 *
 *   POST /api/mutation/run          {projectId, targetDir?, files[], testFiles[], seed?, maxMutants?, perFileCap?, timeoutMs?, maxTotalMs?}
 *                                    → 202 {runId, status:'running', generated, sampled} (operator)
 *   GET  /api/mutation/runs/:runId  → {runId, status, progress, report?} (viewer)
 *   GET  /api/mutation/latest?projectId= → {projectId, report: summary|null} (viewer)
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleMutationRoutes, runMutationGateLinkage } from './routes/mutation';
 *   if (await handleMutationRoutes(req, res, url, routeCtx)) return;
 *   setMutationGateLinkage((args) => runMutationGateLinkage(args));
 *
 * RBAC: the default prefix rule in auth.ts (requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no auth.ts
 * change needed.
 *
 * Audit: MUTATION_RUN_STARTED / MUTATION_RUN_FINISHED /
 * QUALITY_GATE_MUTATION_REPORT.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Sampling only: full-repo full-mutation is deliberately unsupported.
 *    maxMutants caps at 200 per run; a run-wide maxTotalMs熔断 stops early
 *    and marks the report truncated (attempted mutants still reported).
 *  - Mutants NEVER touch the real tree: each mutant runs in a scratch copy
 *    under the OS temp dir; node_modules/.git/dist are excluded from copies.
 *  - Timeouts and syntax-invalid mutants are reported separately and never
 *    counted as killed — like Stryker's treatment of compile errors.
 *  - The quality-gate linkage is annotation-only: it reads the latest
 *    stored report, never triggers a run, and can never block the gate.
 *  - Test execution goes through scripts/run-tests-tmp.mjs (TMPDIR wrapper)
 *    when present, so mutant test runs don't fill the 512MB /tmp tmpfs.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import {
  applyMutant,
  buildReport,
  generateMutants,
  prepareScratch,
  readTargetFile,
  runMutantTests,
  sampleMutants,
  stripReportForPersist,
  validateSamplingConfig,
  type Mutant,
  type MutantRunResult,
  type MutationReport,
  type SamplingConfig,
} from '@ai-factory/mutation';

const PREFIX = '/api/mutation';
/** Hard caps for one operator-triggered run. */
const MAX_RUN_FILES = 20;
const MAX_RUN_TEST_FILES = 20;
const MAX_RUN_MUTANTS = 200;
const MAX_TIMEOUT_MS = 120_000;
const MAX_TOTAL_MS = 900_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_MS = 600_000;
const MAX_FILE_BYTES = 200 * 1024;
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export class MutationRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationRouteError';
  }
}

/**
 * Inspection-root resolver, injected by the coordinator (setter-injection
 * pattern: routes/mutation must not value-import ../inspections, so that
 * direct type-stripping tests keep working — AGENTS.md dual-mode rule).
 * The coordinator wires the real resolveInspectionRoot in index.ts.
 */
let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setMutationInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

function resolveTargetDir(rawDir?: string): string {
  if (!inspectionRootResolver) {
    throw new MutationRouteError('inspection root resolver is not wired');
  }
  try {
    return inspectionRootResolver(rawDir);
  } catch (e) {
    // The real resolver throws InspectionRootError on jail refusal;
    // normalize to a 400-class route error either way.
    throw new MutationRouteError((e as Error).message);
  }
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

function safeFileToken(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

/** Jail a requested relative file to the target dir; fail-closed. */
function jailRelFile(root: string, file: string, label: string): string {
  if (typeof file !== 'string' || !file.trim() || file.length > 512) {
    throw new MutationRouteError(`invalid ${label}: ${String(file).slice(0, 80)}`);
  }
  const abs = resolve(root, file);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new MutationRouteError(`${label} escapes the target dir: ${file}`);
  }
  if (!existsSync(abs)) {
    throw new MutationRouteError(`${label} does not exist: ${file}`);
  }
  return abs;
}

function dataDir(): string {
  return process.env.AI_FACTORY_DATA_DIR ?? 'data';
}

function runsDir(): string {
  const dir = join(dataDir(), 'mutation-runs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Atomic JSON write (tmp + rename). */
function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function latestPath(projectId: string): string {
  return join(runsDir(), `latest-${safeFileToken(projectId)}.json`);
}

export function loadLatestMutationReport(projectId: string): MutationReport | null {
  try {
    const raw = readFileSync(latestPath(projectId), 'utf8');
    const parsed = JSON.parse(raw) as MutationReport;
    if (!parsed || typeof parsed.runId !== 'string' || !parsed.totals) return null;
    return parsed;
  } catch {
    return null;
  }
}

type RunStatus = 'running' | 'done' | 'failed';

interface MutationRunState {
  runId: string;
  projectId: string;
  actor: string;
  status: RunStatus;
  generated: number;
  sampled: number;
  done: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  report: MutationReport | null;
}

const runs = new Map<string, MutationRunState>();

function reportSummary(r: MutationReport): Record<string, unknown> {
  return {
    runId: r.runId,
    seed: r.seed,
    generatedAt: r.generatedAt,
    target: r.target,
    sampling: r.sampling,
    timeoutMs: r.timeoutMs,
    truncated: r.truncated,
    truncateReason: r.truncateReason,
    totals: r.totals,
  };
}

interface ValidatedRunRequest {
  projectId: string;
  targetDir: string;
  files: string[];
  testFiles: string[];
  sampling: SamplingConfig;
  timeoutMs: number;
  maxTotalMs: number;
}

function validateRunRequest(body: Record<string, unknown>): ValidatedRunRequest {
  const projectId = projectIdOf(body['projectId']);
  if (!projectId) throw new MutationRouteError('projectId is required');
  let targetDir: string;
  const rawDir = typeof body['targetDir'] === 'string' && body['targetDir'].trim() ? body['targetDir'] : undefined;
  targetDir = resolveTargetDir(rawDir);
  const files = body['files'];
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_RUN_FILES) {
    throw new MutationRouteError(`files must be a non-empty array (max ${MAX_RUN_FILES})`);
  }
  const testFiles = body['testFiles'];
  if (!Array.isArray(testFiles) || testFiles.length === 0 || testFiles.length > MAX_RUN_TEST_FILES) {
    throw new MutationRouteError(`testFiles must be a non-empty array (max ${MAX_RUN_TEST_FILES})`);
  }
  const relFiles: string[] = [];
  for (const f of files) {
    const abs = jailRelFile(targetDir, f as string, 'file');
    const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) throw new MutationRouteError(`file is not a JS/TS source: ${f}`);
    const st = readFileSync(abs);
    if (st.length > MAX_FILE_BYTES) throw new MutationRouteError(`file too large (>200KB): ${f}`);
    relFiles.push(typeof f === 'string' ? f.trim() : String(f));
  }
  const relTests: string[] = [];
  for (const f of testFiles) {
    jailRelFile(targetDir, f as string, 'testFile');
    relTests.push(typeof f === 'string' ? f.trim() : String(f));
  }
  const { config: sampling, errors } = validateSamplingConfig({
    seed: body['seed'],
    maxMutants: body['maxMutants'],
    perFileCap: body['perFileCap'],
  });
  if (errors.length > 0) throw new MutationRouteError(`invalid sampling: ${errors.join('; ')}`);
  if (sampling.maxMutants > MAX_RUN_MUTANTS) {
    throw new MutationRouteError(`maxMutants capped at ${MAX_RUN_MUTANTS}`);
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (body['timeoutMs'] !== undefined) {
    const t = body['timeoutMs'];
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1000 || t > MAX_TIMEOUT_MS) {
      throw new MutationRouteError(`timeoutMs must be an integer 1000..${MAX_TIMEOUT_MS}`);
    }
    timeoutMs = t;
  }
  let maxTotalMs = DEFAULT_TOTAL_MS;
  if (body['maxTotalMs'] !== undefined) {
    const t = body['maxTotalMs'];
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 10_000 || t > MAX_TOTAL_MS) {
      throw new MutationRouteError(`maxTotalMs must be an integer 10000..${MAX_TOTAL_MS}`);
    }
    maxTotalMs = t;
  }
  return { projectId, targetDir, files: relFiles, testFiles: relTests, sampling, timeoutMs, maxTotalMs };
}

/** Resolve the test command: TMPDIR wrapper when present, plain node --test otherwise. */
function resolveTestCommand(targetDir: string, testFiles: string[]): { command: string[]; viaWrapper: boolean } {
  const wrapper = join(targetDir, 'scripts', 'run-tests-tmp.mjs');
  if (existsSync(wrapper)) {
    return { command: [process.execPath, wrapper, '--test', '--test-reporter=tap', ...testFiles], viaWrapper: true };
  }
  return { command: [process.execPath, '--test', '--test-reporter=tap', ...testFiles], viaWrapper: false };
}

async function executeRun(
  state: MutationRunState,
  req: ValidatedRunRequest,
  ctx: RouteContext,
  sampled: Mutant[],
  generated: number,
): Promise<void> {
  const startedAt = Date.now();
  const results: MutantRunResult[] = [];
  let truncated = false;
  let truncateReason: string | null = null;
  try {
    const sources = new Map(req.files.map((f) => [f, readTargetFile(req.targetDir, f)]));
    const { command: testCommand, viaWrapper } = resolveTestCommand(req.targetDir, req.testFiles);
    const scratchRoot = join(tmpdir(), `mutation-run-${state.runId}`);
    mkdirSync(scratchRoot, { recursive: true });
    try {
      for (const mutant of sampled) {
        if (Date.now() - startedAt > req.maxTotalMs) {
          truncated = true;
          truncateReason = `run budget ${req.maxTotalMs}ms exceeded after ${results.length}/${sampled.length} mutants`;
          break;
        }
        const prep = prepareScratch(req.targetDir, mutant, applyMutant(sources.get(mutant.file)!, mutant), scratchRoot);
        try {
          const r = await runMutantTests(
            mutant,
            { scratchDir: prep.scratchDir, mutatedFileAbs: prep.mutatedFileAbs },
            { testCommand, timeoutMs: req.timeoutMs, maxOutputBytes: 256 * 1024, nodeCheck: true },
          );
          results.push({ mutant, ...r });
        } finally {
          prep.cleanup();
        }
        state.done = results.length;
      }
    } finally {
      // best-effort scratch cleanup; the wrapper's TMPDIR root is separate
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    const report = buildReport(
      {
        runId: state.runId,
        seed: req.sampling.seed,
        targetDir: req.targetDir,
        files: req.files,
        testFiles: req.testFiles,
        sampling: { maxMutants: req.sampling.maxMutants, perFileCap: req.sampling.perFileCap },
        timeoutMs: req.timeoutMs,
      },
      results,
      generated,
    );
    report.truncated = truncated;
    report.truncateReason = truncateReason;
    state.report = report;
    state.status = 'done';
    state.finishedAt = new Date().toISOString();
    // Persist the stripped copy only: child output tails are never stored
    // on disk (R16 N2 — persisted reports are readable back through
    // codesearch/todo-scan). The in-memory state.report keeps the real
    // tails; the API only ever returns reportSummary (no results).
    const persisted = stripReportForPersist(report);
    atomicWriteJson(join(runsDir(), `${state.runId}.json`), persisted);
    atomicWriteJson(latestPath(state.projectId), persisted);
    ctx.audit.record(state.actor, 'MUTATION_RUN_FINISHED', 'mutation', `${state.projectId}:run`, {
      runId: state.runId,
      ...report.totals,
      truncated,
      viaWrapper,
    });
  } catch (e) {
    state.status = 'failed';
    state.error = (e as Error).message;
    state.finishedAt = new Date().toISOString();
    ctx.audit.record(state.actor, 'MUTATION_RUN_FINISHED', 'mutation', `${state.projectId}:run`, {
      runId: state.runId,
      failed: true,
      error: state.error,
    });
  }
}

export async function handleMutationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const actor = 'human';

  // GET /api/mutation/latest?projectId=
  if (method === 'GET' && path === `${PREFIX}/latest`) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const latest = loadLatestMutationReport(projectId);
    ctx.json(res, 200, { projectId, report: latest ? reportSummary(latest) : null });
    return true;
  }

  // GET /api/mutation/runs/:runId
  const runMatch = /^\/api\/mutation\/runs\/([a-zA-Z0-9-]+)$/.exec(path);
  if (method === 'GET' && runMatch) {
    const state = runs.get(runMatch[1]);
    if (!state) {
      ctx.json(res, 404, { error: 'unknown run id' });
      return true;
    }
    ctx.json(res, 200, {
      runId: state.runId,
      projectId: state.projectId,
      status: state.status,
      progress: { done: state.done, total: state.sampled },
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      error: state.error,
      report: state.report ? reportSummary(state.report) : null,
    });
    return true;
  }

  // POST /api/mutation/run
  if (method === 'POST' && path === `${PREFIX}/run`) {
    const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
    let validated: ValidatedRunRequest;
    try {
      validated = validateRunRequest(body);
    } catch (e) {
      const code = e instanceof MutationRouteError ? 400 : 500;
      ctx.json(res, code, { error: (e as Error).message });
      return true;
    }
    // Pre-generate + sample synchronously so the caller learns the counts now.
    const sources = new Map(validated.files.map((f) => [f, readTargetFile(validated.targetDir, f)]));
    const all = validated.files.flatMap((f) => generateMutants(sources.get(f)!, f));
    const sampled = sampleMutants(all, validated.sampling);
    if (sampled.length === 0) {
      ctx.json(res, 400, { error: 'no mutants generated for the given files (operators found no sites)' });
      return true;
    }
    const runId = randomUUID();
    const state: MutationRunState = {
      runId,
      projectId: validated.projectId,
      actor,
      status: 'running',
      generated: all.length,
      sampled: sampled.length,
      done: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      report: null,
    };
    runs.set(runId, state);
    ctx.audit.record(actor, 'MUTATION_RUN_STARTED', 'mutation', `${validated.projectId}:run`, {
      runId,
      files: validated.files,
      testFiles: validated.testFiles,
      generated: all.length,
      sampled: sampled.length,
      seed: validated.sampling.seed,
    });
    // Background: do not await in the request path.
    void executeRun(state, validated, ctx, sampled, all.length);
    ctx.json(res, 202, { runId, status: 'running', generated: all.length, sampled: sampled.length });
    return true;
  }

  ctx.json(res, 404, { error: 'unknown mutation route' });
  return true;
}

// ---------------------------------------------------------------------------
// Quality-gate linkage (annotation-only)
// ---------------------------------------------------------------------------

export interface MutationGateLinkageArgs {
  ctx: RouteContext;
  projectId: string;
  actor: string;
  runId?: string;
}

/**
 * Advisory linkage: attach the latest stored mutation report (if any) to
 * the gate payload. Never triggers a run, never blocks, never throws for
 * a missing report.
 */
export async function runMutationGateLinkage(args: MutationGateLinkageArgs): Promise<Record<string, unknown>> {
  const latest = loadLatestMutationReport(args.projectId);
  if (!latest) {
    return { attempted: false, reason: 'no mutation report yet — run POST /api/mutation/run first' };
  }
  args.ctx.audit.record(args.actor, 'QUALITY_GATE_MUTATION_REPORT', 'quality-gate', `${args.projectId}:test`, {
    runId: args.runId ?? null,
    mutationRunId: latest.runId,
    score: latest.totals.score,
    killed: latest.totals.killed,
    survived: latest.totals.survived,
  });
  return {
    attempted: true,
    advisory: true,
    blocks: false,
    runId: latest.runId,
    generatedAt: latest.generatedAt,
    score: latest.totals.score,
    totals: latest.totals,
  };
}
