/**
 * Change impact routes (second-round suggestion ⑥):
 *
 *   POST /api/impact/analyze
 *     { root?, repo?, files?, prId?, ref?, maxDepth? } → ImpactReport
 *
 * Two source modes:
 *   files: explicit changed rel-paths; `before` content comes from the
 *          `ref` git ref (default HEAD), `after` content from the working
 *          tree.
 *   prId:  a ctx.fdb.prStore PR record; changed files come from
 *          `git diff targetBranch...sourceBranch`, `before` from the
 *          target branch, `after` from the source branch.
 *
 * The index is built (incrementally, via the shared codeindex service —
 * so the task ② ignore gate applies) for the jailed root, then the
 * pure engine in ../impact.ts does the rest. Path jail: the root is
 * realpath-resolved through the codeindex service (FACTORY_CODEINDEX_ROOTS,
 * empty = deny everything, fail-closed). Baseline file reads are
 * additionally path-checked inside impact.ts.
 *
 * RBAC: POST → operator by the default rule in auth.ts (no auth.ts
 * change needed).
 *
 * Audit: IMPACT_ANALYZED (per analysis, incl. the quality-gate usage);
 * the gate writes IMPACT_GATE_BLOCKED itself (routes/quality.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { CodeIndexError, extractSymbols } from '@ai-factory/codeindex';
import { GitRepo, GitError, parseUnifiedDiff } from '@ai-factory/git';
import {
  REFS_HONEST_NOTES,
  analyzeRefs,
  diffContracts,
  extractExports,
  isImpactSupportedExt,
  isValidGitRef,
  readGitFile,
  readRootFile,
  workingTreeChangedFiles,
} from '../impact';
import type { ContractChange, FileContractReport, ImpactReport } from '../impact';
import { getCodeIndexService } from './codeindex';
import type { RouteContext } from './context';

const PREFIX = '/api/impact';

export type { ImpactReport };

export interface ImpactGateSummary {
  changedFiles: number;
  affected: number;
  breaking: number;
  /** Set when the analysis could not run (not a repo, jail denied, …). */
  error?: string;
}

/**
 * Gate-facing analysis: working-tree changes vs HEAD in a jailed root.
 * Never throws — infrastructure failures are returned as { error },
 * and the caller (routes/quality.ts) treats them as "could not run",
 * never as a reason to block.
 */
export async function analyzeGateWorkingTree(
  root: string,
  beforeRef = 'HEAD',
): Promise<ImpactGateSummary> {
  let svcRoot: string;
  try {
    svcRoot = await getCodeIndexService().resolveRoot(root);
  } catch (e) {
    return {
      changedFiles: 0,
      affected: 0,
      breaking: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (!isValidGitRef(beforeRef)) {
    return { changedFiles: 0, affected: 0, breaking: 0, error: `invalid ref: ${beforeRef}` };
  }
  let report: ImpactReport;
  try {
    report = await analyzeImpact({
      root: svcRoot,
      source: 'working-tree',
      changedFiles: null,
      beforeRef,
      afterRef: null,
      maxDepth: 3,
    });
  } catch (e) {
    return {
      changedFiles: 0,
      affected: 0,
      breaking: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  return {
    changedFiles: report.changedFiles.length,
    affected: report.affectedFiles.length,
    breaking: report.breakingCount,
  };
}

/**
 * Full impact analysis. `changedFiles: null` means "derive from the
 * working tree vs beforeRef". `afterRef: null` means "after = working
 * tree files".
 */
export async function analyzeImpact(opts: {
  root: string;
  source: 'files' | 'pr' | 'working-tree';
  changedFiles: string[] | null;
  beforeRef: string | null;
  afterRef: string | null;
  maxDepth?: number;
}): Promise<ImpactReport> {
  const svc = getCodeIndexService();
  const realRoot = await svc.resolveRoot(opts.root);
  const maxDepth = Math.max(1, Math.min(10, Math.floor(opts.maxDepth ?? 3)));

  if (opts.beforeRef !== null && !isValidGitRef(opts.beforeRef)) {
    throw new Error(`invalid git ref: ${opts.beforeRef}`);
  }
  if (opts.afterRef !== null && !isValidGitRef(opts.afterRef)) {
    throw new Error(`invalid git ref: ${opts.afterRef}`);
  }

  // Changed files: explicit list or working-tree diff vs beforeRef.
  let changed: string[];
  if (opts.changedFiles === null) {
    const derived = workingTreeChangedFiles(realRoot, opts.beforeRef ?? 'HEAD');
    if (derived === null) {
      throw new Error('git could not list working-tree changes (not a git repository or missing ref)');
    }
    changed = derived;
  } else {
    changed = [...new Set(opts.changedFiles.map((f) => String(f).trim()))]
      .filter((f) => f && f.length <= 1024 && !f.includes('..'))
      .slice(0, 200);
  }

  // Incremental index (ignore gate installed on the shared service).
  await svc.buildIndex(realRoot);
  const index = await svc.getIndex(realRoot);

  // Per-file texts first: the reverse graph must know what the BASELINE
  // files defined. The index is built from the current working tree,
  // where removed exports no longer exist — so baseline symbol names
  // (extracted from the git-ref content) are merged into the BFS
  // frontier as extras.
  const texts = new Map<string, { beforeText: string | null; afterText: string | null }>();
  const extraSymbols: Record<string, string[]> = {};
  for (const rel of changed) {
    const beforeText = opts.beforeRef !== null ? readGitFile(realRoot, opts.beforeRef, rel) : null;
    const afterText =
      opts.afterRef !== null ? readGitFile(realRoot, opts.afterRef, rel) : readRootFile(realRoot, rel);
    texts.set(rel, { beforeText, afterText });
    if (beforeText !== null) {
      const names = extractSymbols(rel, extname(rel), beforeText).map((s) => s.name);
      if (names.length > 0) extraSymbols[rel] = names;
    }
  }

  const refs = analyzeRefs(index, changed, { maxDepth, extraSymbols });

  const contracts: FileContractReport[] = [];
  for (const rel of refs.changedFiles) {
    if (!isImpactSupportedExt(rel)) {
      contracts.push({
        file: rel,
        supported: false,
        baselineMissing: false,
        beforeCount: 0,
        afterCount: 0,
        changes: [],
        note: 'extension not supported for export extraction — contract diff skipped (not proven unchanged)',
      });
      continue;
    }
    const { beforeText, afterText } = texts.get(rel) ?? { beforeText: null, afterText: null };
    const beforeEx = beforeText !== null ? extractExports(rel, beforeText).exports : [];
    const afterEx = afterText !== null ? extractExports(rel, afterText).exports : [];
    const changes: ContractChange[] = diffContracts(beforeEx, afterEx);
    contracts.push({
      file: rel,
      supported: true,
      baselineMissing: opts.beforeRef !== null && beforeText === null,
      beforeCount: beforeEx.length,
      afterCount: afterEx.length,
      changes,
      note:
        opts.beforeRef !== null && beforeText === null
          ? `no baseline found at ref '${opts.beforeRef}' — compared against an empty baseline (new file, or ref lacks this path)`
          : undefined,
    });
  }
  contracts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const breakingCount = contracts.reduce(
    (acc, c) => acc + c.changes.filter((ch) => ch.breaking).length,
    0,
  );
  const nonBreakingCount = contracts.reduce(
    (acc, c) => acc + c.changes.filter((ch) => !ch.breaking).length,
    0,
  );

  return {
    root: realRoot,
    source: opts.source,
    changedFiles: refs.changedFiles,
    affectedFiles: refs.affectedFiles,
    layers: refs.layers,
    edges: refs.edges,
    contracts,
    breakingCount,
    nonBreakingCount,
    truncated: refs.truncated,
    notes: [...REFS_HONEST_NOTES],
  };
}

function impactError(res: ServerResponse, ctx: RouteContext, err: unknown): boolean {
  if (err instanceof CodeIndexError) {
    const status = err.code === 'ROOT_DENIED' ? 403 : err.code === 'NOT_INDEXED' ? 409 : 400;
    ctx.json(res, status, { error: err.code, detail: err.message });
    return true;
  }
  if (err instanceof GitError) {
    ctx.json(res, 400, { error: 'git error', detail: err.message });
    return true;
  }
  ctx.json(res, 500, { error: 'impact analysis failed', detail: err instanceof Error ? err.message : String(err) });
  return true;
}

export async function handleImpactRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // POST /api/impact/analyze
  if (method === 'POST' && (path === `${PREFIX}/analyze` || path === PREFIX)) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const prId = typeof body['prId'] === 'string' ? body['prId'].trim() : '';
    const repo = typeof body['repo'] === 'string' ? body['repo'].trim() : '';
    const ref = typeof body['ref'] === 'string' ? body['ref'].trim() : '';
    const rootParam = typeof body['root'] === 'string' ? body['root'].trim() : '';
    const maxDepth = Math.max(1, Math.min(10, Math.floor(Number(body['maxDepth']) || 3)));
    const actor = typeof body['actor'] === 'string' && body['actor'].trim()
      ? body['actor'].trim().slice(0, 64)
      : 'human';

    try {
      let source: 'files' | 'pr';
      let root: string;
      let changedFiles: string[] | null = null;
      let beforeRef: string | null = null;
      let afterRef: string | null = null;

      if (prId) {
        source = 'pr';
        if (!repo) {
          ctx.json(res, 400, { error: 'repo is required when prId is given' });
          return true;
        }
        root = rootParam || repo;
        let pr: { sourceBranch: string; targetBranch: string } | null;
        try {
          pr = ctx.fdb.prStore.get(prId) as
            | { sourceBranch: string; targetBranch: string }
            | null;
        } catch {
          pr = null;
        }
        if (!pr) {
          ctx.json(res, 404, { error: `PR not found: ${prId}` });
          return true;
        }
        const raw = await new GitRepo(repo).diffRange(pr.targetBranch, pr.sourceBranch);
        const parsed = parseUnifiedDiff(raw);
        const names = new Set<string>();
        for (const f of parsed.files) {
          if (f.binary) continue;
          const rel = f.change === 'deleted' ? f.from : f.to;
          if (rel && rel !== 'dev/null') names.add(rel);
        }
        changedFiles = [...names];
        beforeRef = pr.targetBranch;
        afterRef = pr.sourceBranch;
      } else {
        source = 'files';
        const files = body['files'];
        if (!Array.isArray(files)) {
          ctx.json(res, 400, { error: 'files (string[]) or prId is required' });
          return true;
        }
        root = rootParam || repo;
        if (!root) {
          ctx.json(res, 400, { error: 'root (or repo) is required when files are given' });
          return true;
        }
        changedFiles = files.filter((f) => typeof f === 'string').slice(0, 200);
        if (ref && !isValidGitRef(ref)) {
          ctx.json(res, 400, { error: `invalid git ref: ${ref}` });
          return true;
        }
        beforeRef = ref || 'HEAD';
        afterRef = null; // working tree
      }

      const report = await analyzeImpact({
        root,
        source,
        changedFiles,
        beforeRef,
        afterRef,
        maxDepth,
      });
      ctx.audit.record(actor, 'IMPACT_ANALYZED', 'impact', report.root, {
        source,
        prId: prId || null,
        changedFiles: report.changedFiles.length,
        affectedFiles: report.affectedFiles.length,
        breaking: report.breakingCount,
        nonBreaking: report.nonBreakingCount,
        truncated: report.truncated,
        maxDepth,
      });
      ctx.json(res, 200, { report });
      return true;
    } catch (err) {
      return impactError(res, ctx, err);
    }
  }

  return false;
}
