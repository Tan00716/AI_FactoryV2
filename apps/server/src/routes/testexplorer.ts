/**
 * Test explorer routes (Round 7 #3).
 *
 *   GET  /api/testexplorer/discover?root=<path>
 *   POST /api/testexplorer/run          { root, scope, timeoutMs? }
 *   POST /api/testexplorer/rerun-failed  { root }
 *
 * Scopes: { kind: 'case', file, name } | { kind: 'file', file } |
 * { kind: 'package', package } | { kind: 'all' } |
 * { kind: 'cases', cases: [{ file, name }] }.
 *
 * `file` is root-relative; `package` is a discovery package name or rel
 * path. Every root goes through the codeindex allowlist jail and every
 * file must resolve inside it. Runs are operator-gated by the default
 * gate (GET viewer, POST operator) and additionally pass through the
 * exec safety policy (binary allowlist, deny patterns, no inline eval)
 * before spawn; the actual spawn uses argv directly, never a shell, so
 * the policy string is a decision input, not a command line. A test path
 * containing a deny word (e.g. `kill.test.mjs`) is therefore refused
 * fail-closed by policy, not by this route.
 *
 * Runner fullNames are replaced with discovery fullNames when the case
 * matches uniquely (file + leaf name): single-case runs filter by leaf
 * name, so the runner may only know the immediate suite.
 *
 * Last-run failed cases are kept process-local per root (for
 * rerun-failed); a restart clears them, same as the timeline ring.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeIndexError } from '@ai-factory/codeindex';
import {
  discoverTests,
  runTests,
  getRunnerPath,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type CaseResult,
  type Discovery,
  type RunOutcome,
} from '@ai-factory/testexplorer';
import { getCodeIndexService } from './codeindex';
import { checkCommandPolicy, ExecPolicyDenied } from './exec';
import type { RouteContext } from './context';

const PREFIX = '/api/testexplorer';
const MAX_RUN_FILES = 200;

type Scope =
  | { kind: 'case'; file: string; name: string }
  | { kind: 'file'; file: string }
  | { kind: 'package'; package: string }
  | { kind: 'all' }
  | { kind: 'cases'; cases: Array<{ file: string; name: string }> };

interface LastRun {
  cases: Array<{ file: string; name: string; fullName: string }>;
}

const lastRuns = new Map<string, LastRun>();

function rememberLastRun(root: string, outcome: RunOutcome): void {
  const failed = outcome.results
    .filter((r) => r.status === 'fail')
    .map((r) => ({ file: r.file, name: r.name, fullName: r.fullName }));
  lastRuns.set(root, { cases: failed });
  while (lastRuns.size > 20) {
    const first = lastRuns.keys().next().value as string | undefined;
    if (first === undefined) break;
    lastRuns.delete(first);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveInside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function readScope(body: Record<string, unknown>): Scope | string {
  const scope = body['scope'];
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    return 'scope is required';
  }
  const s = scope as Record<string, unknown>;
  const kind = s['kind'];
  if (kind === 'case') {
    if (typeof s['file'] !== 'string' || !s['file']) return 'scope.file is required';
    if (typeof s['name'] !== 'string' || !s['name']) return 'scope.name is required';
    return { kind: 'case', file: s['file'], name: s['name'] };
  }
  if (kind === 'file') {
    if (typeof s['file'] !== 'string' || !s['file']) return 'scope.file is required';
    return { kind: 'file', file: s['file'] };
  }
  if (kind === 'package') {
    if (typeof s['package'] !== 'string' || !s['package']) return 'scope.package is required';
    return { kind: 'package', package: s['package'] };
  }
  if (kind === 'all') return { kind: 'all' };
  if (kind === 'cases') {
    if (!Array.isArray(s['cases']) || s['cases'].length === 0) return 'scope.cases must be a non-empty array';
    const cases: Array<{ file: string; name: string }> = [];
    for (const c of s['cases'] as Array<Record<string, unknown>>) {
      if (typeof c?.['file'] !== 'string' || !c['file'] || typeof c?.['name'] !== 'string' || !c['name']) {
        return 'each scope case needs file and name';
      }
      cases.push({ file: c['file'] as string, name: c['name'] as string });
    }
    return { kind: 'cases', cases };
  }
  return 'unknown scope kind';
}

/** Resolve a scope to per-file run groups. Returns an error string on failure. */
export interface RunGroup {
  file: string;
  patterns?: string[];
  /** Extra files run in the same runner invocation as `file`. */
  extraFiles?: string[];
}

function resolveScope(
  discovery: Discovery,
  scope: Scope,
): { groups: RunGroup[]; note?: string } | string {
  const allFiles = discovery.packages.flatMap((p) => p.files);
  const byRel = new Map(allFiles.map((f) => [f.rel, f]));
  if (scope.kind === 'case') {
    const f = byRel.get(scope.file);
    if (!f || !isFile(f.path)) return `file not found in discovery: ${scope.file}`;
    const matches = f.cases.filter((c) => c.name === scope.name);
    if (matches.length === 0) return `case not found in ${scope.file}: ${scope.name}`;
    return {
      groups: [{ file: f.path, patterns: [`^${escapeRegExp(scope.name)}$`] }],
      note: matches.length > 1
        ? `duplicate leaf name in ${scope.file}: ${matches.length} cases matched and all ran`
        : undefined,
    };
  }
  if (scope.kind === 'file') {
    const f = byRel.get(scope.file);
    if (!f || !isFile(f.path)) return `file not found in discovery: ${scope.file}`;
    return { groups: [{ file: f.path }] };
  }
  if (scope.kind === 'package') {
    const pkg = discovery.packages.find((p) => p.name === scope.package || p.rel === scope.package);
    if (!pkg) return `package not found: ${scope.package}`;
    if (pkg.files.length === 0) return `package has no test files: ${scope.package}`;
    if (pkg.files.length > MAX_RUN_FILES) return `package has ${pkg.files.length} files, over the ${MAX_RUN_FILES} run cap`;
    return { groups: [{ file: pkg.files[0]?.path as string, extraFiles: pkg.files.slice(1).map((x) => x.path) }] };
  }
  if (scope.kind === 'all') {
    if (allFiles.length === 0) return 'no test files discovered';
    if (allFiles.length > MAX_RUN_FILES) {
      return `discovery has ${allFiles.length} files, over the ${MAX_RUN_FILES} run cap; run a single package instead`;
    }
    return { groups: [{ file: allFiles[0]?.path as string, extraFiles: allFiles.slice(1).map((x) => x.path) }] };
  }
  // cases: group by file, one pattern list per file.
  const byFile = new Map<string, string[]>();
  for (const c of scope.cases) {
    const f = byRel.get(c.file);
    if (!f || !isFile(f.path)) return `file not found in discovery: ${c.file}`;
    const list = byFile.get(f.path) ?? [];
    list.push(`^${escapeRegExp(c.name)}$`);
    byFile.set(f.path, list);
  }
  return { groups: [...byFile.entries()].map(([file, patterns]) => ({ file, patterns })) };
}

async function executeGroups(
  root: string,
  groups: RunGroup[],
  timeoutMs: number,
): Promise<RunOutcome> {
  const merged: RunOutcome = {
    results: [],
    summary: { pass: 0, fail: 0, skip: 0, todo: 0, total: 0, durationMs: 0 },
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    exitCode: 0,
  };
  const runErrors: string[] = [];
  const fileErrors: Array<{ file: string; error: string }> = [];
  for (const g of groups) {
    const files = [g.file, ...(g.extraFiles ?? [])];
    // Exec-policy gate on the fixed command shape (decision only; the
    // spawn below uses argv, never a shell).
    const cmd = ['node', getRunnerPath(), ...files.flatMap((f) => ['--file', f]), ...(g.patterns ?? []).flatMap((p) => ['--pattern', p])].join(' ');
    checkCommandPolicy(cmd);
    const out = await runTests({ root, files, patterns: g.patterns, timeoutMs });
    merged.results.push(...out.results);
    merged.summary.pass += out.summary.pass;
    merged.summary.fail += out.summary.fail;
    merged.summary.skip += out.summary.skip;
    merged.summary.todo += out.summary.todo;
    merged.summary.total += out.summary.total;
    merged.summary.durationMs += out.summary.durationMs;
    merged.stdout += out.stdout;
    merged.stderr += out.stderr;
    merged.truncated = merged.truncated || out.truncated;
    merged.timedOut = merged.timedOut || out.timedOut;
    if (out.exitCode !== 0) merged.exitCode = out.exitCode;
    if (out.runError) runErrors.push(out.runError);
    if (out.fileErrors) fileErrors.push(...out.fileErrors);
  }
  if (runErrors.length > 0) merged.runError = runErrors.join('; ');
  if (fileErrors.length > 0) merged.fileErrors = fileErrors;
  return merged;
}

/** Replace runner fullNames with discovery fullNames on unique matches. */
function enrich(discovery: Discovery, results: CaseResult[]): CaseResult[] {
  const byKey = new Map<string, string[]>();
  for (const pkg of discovery.packages) {
    for (const f of pkg.files) {
      for (const c of f.cases) {
        const key = `${f.path}\n${c.name}`;
        const list = byKey.get(key) ?? [];
        list.push(c.fullName);
        byKey.set(key, list);
      }
    }
  }
  return results.map((r) => {
    const list = byKey.get(`${r.file}\n${r.name}`);
    if (list && list.length === 1) return { ...r, fullName: list[0] as string };
    return r;
  });
}

export async function handleTestExplorerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const pathName = url.pathname;
  if (pathName !== PREFIX && !pathName.startsWith(PREFIX + '/')) return false;

  try {
    if (method === 'GET' && pathName === `${PREFIX}/discover`) {
      const root = url.searchParams.get('root');
      if (!root) {
        ctx.json(res, 400, { error: 'root query param is required' });
        return true;
      }
      const realRoot = await getCodeIndexService().resolveRoot(root.trim());
      ctx.json(res, 200, discoverTests(realRoot));
      return true;
    }

    if (method === 'POST' && pathName === `${PREFIX}/run`) {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const root = body['root'];
      if (typeof root !== 'string' || !root.trim()) {
        ctx.json(res, 400, { error: 'root is required' });
        return true;
      }
      const scope = readScope(body);
      if (typeof scope === 'string') {
        ctx.json(res, 400, { error: scope });
        return true;
      }
      const rawTimeout = body['timeoutMs'];
      const timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(rawTimeout)))
        : DEFAULT_TIMEOUT_MS;
      const realRoot = await getCodeIndexService().resolveRoot(root.trim());
      const discovery = discoverTests(realRoot);
      const resolved = resolveScope(discovery, scope);
      if (typeof resolved === 'string') {
        ctx.json(res, resolved.startsWith('file not found') || resolved.startsWith('case not found') || resolved.startsWith('package not found') ? 404 : 400, { error: resolved });
        return true;
      }
      const outcome = await executeGroups(realRoot, resolved.groups, timeoutMs);
      const results = enrich(discovery, outcome.results);
      const enriched: RunOutcome = { ...outcome, results };
      rememberLastRun(realRoot, enriched);
      try {
        ctx.audit.record('operator', 'TESTEXPLORER_RUN', 'test', scope.kind, {
          root: realRoot,
          scope: scope.kind,
          pass: enriched.summary.pass,
          fail: enriched.summary.fail,
          total: enriched.summary.total,
        });
      } catch {
        // Audit must not mask run results.
      }
      ctx.json(res, 200, {
        runId: randomUUID(),
        root: realRoot,
        scope: scope.kind,
        results,
        summary: enriched.summary,
        truncated: enriched.truncated,
        timedOut: enriched.timedOut,
        runError: enriched.runError,
        fileErrors: enriched.fileErrors,
        note: resolved.note,
        degraded: discovery.degraded,
        degradedReason: discovery.degradedReason,
      });
      return true;
    }

    if (method === 'POST' && pathName === `${PREFIX}/rerun-failed`) {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const root = body['root'];
      if (typeof root !== 'string' || !root.trim()) {
        ctx.json(res, 400, { error: 'root is required' });
        return true;
      }
      const realRoot = await getCodeIndexService().resolveRoot(root.trim());
      const last = lastRuns.get(realRoot);
      if (!last || last.cases.length === 0) {
        ctx.json(res, 409, { error: 'NO_FAILED_RUN', detail: 'no failed cases from a previous run for this root' });
        return true;
      }
      const rawTimeout = body['timeoutMs'];
      const timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(rawTimeout)))
        : DEFAULT_TIMEOUT_MS;
      const discovery = discoverTests(realRoot);
      const groups = new Map<string, string[]>();
      for (const c of last.cases) {
        const list = groups.get(c.file) ?? [];
        list.push(`^${escapeRegExp(c.name)}$`);
        groups.set(c.file, list);
      }
      const outcome = await executeGroups(
        realRoot,
        [...groups.entries()].map(([file, patterns]) => ({ file, patterns })),
        timeoutMs,
      );
      const results = enrich(discovery, outcome.results);
      const enriched: RunOutcome = { ...outcome, results };
      rememberLastRun(realRoot, enriched);
      ctx.json(res, 200, {
        runId: randomUUID(),
        root: realRoot,
        scope: 'rerun-failed',
        reran: last.cases.length,
        results,
        summary: enriched.summary,
        truncated: enriched.truncated,
        timedOut: enriched.timedOut,
        runError: enriched.runError,
        fileErrors: enriched.fileErrors,
      });
      return true;
    }
  } catch (err) {
    if (err instanceof CodeIndexError) {
      ctx.json(res, err.code === 'ROOT_DENIED' ? 403 : 404, { error: err.code, detail: err.message });
      return true;
    }
    if (err instanceof ExecPolicyDenied) {
      ctx.json(res, 403, { error: 'EXEC_POLICY_DENIED', detail: err.message });
      return true;
    }
    ctx.json(res, 500, { error: 'testexplorer failed', detail: err instanceof Error ? err.message : String(err) });
    return true;
  }

  return false;
}
