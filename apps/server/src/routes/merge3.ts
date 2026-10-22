/**
 * Three-way merge conflict editor routes (round-5 task R5-S3).
 *
 *   GET  /api/merge/conflicts?repo=<abs path>
 *                                 → 200 {repo, files: [{path, status}]}
 *   POST /api/merge/analyze   {repo?, file}
 *                                 → 200 MergeAnalysis {file, sha256,
 *                                     markerHunks[], stages, chunks[], summary}
 *                                     404 not-a-git-repo / file-not-found
 *                                     409 {code:'NO_CONFLICT_MARKERS'} /
 *                                         {code:'MARKER_PARSE_ERROR'}
 *   POST /api/merge/resolve   {repo?, file, sha256, resolutions[],
 *                              stage?, taskId?}
 *                                 → 200 {file, resolved, staged, checkpointId}
 *                                     400 bad input / 403 SCOPE_LOCKED /
 *                                     404 / 409 {code:'MERGE_DRIFT'} /
 *                                     503 {code:'MERGE_CHECKPOINT_UNAVAILABLE'}
 *
 * Analyze is read-only and side-effect free. Resolve:
 *   1. verifies the working file sha256 matches analyze time (drift → 409);
 *   2. checks an optional taskId attribution against that task's scope
 *      lock (out-of-scope → 403 SCOPE_LOCKED, nothing written);
 *   3. takes a shadow checkpoint of the repo BEFORE writing — checkpoint
 *      failure refuses the write (fail-closed, same posture as design.ts);
 *   4. applies the per-hunk resolutions and writes the file;
 *   5. optionally `git add`s the file (stage=true); a staging failure is
 *      reported honestly (staged:false) — the resolved content is already
 *      on disk, so this is not rolled back, just reported.
 *
 * The diff3 alignment shown by analyze is a heuristic line alignment
 * (Myers diff over base→ours / base→theirs); shaky chunks carry
 * needsManual:true and the UI must render them as "needs manual review".
 * No semantic merge is ever attempted.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleMerge3Routes, setMerge3InspectionRootResolver,
 *            setMerge3ScopeLookup } from './routes/merge3';
 *   if (await handleMerge3Routes(req, res, url, routeCtx)) return;
 *   setMerge3InspectionRootResolver((root) => resolveInspectionRoot(root));
 *   setMerge3ScopeLookup((taskId) => tasks.get(taskId).scope ?? null);
 *
 * RBAC: the default prefix rule in auth.ts (requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no auth.ts
 * change needed.
 *
 * Audit: MERGE_ANALYZED / MERGE_RESOLVED / MERGE_STAGED /
 * MERGE_RESOLVE_REJECTED.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - diff3-style markers (|||||||) are rejected, not misread;
 *  - diff3 alignment is heuristic; needsManual chunks are flagged;
 *  - only one file per request; binary files are refused;
 *  - stage=true runs `git add` only — never commit/push;
 *  - conflicted files keep their markers until resolve writes.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import {
  parseConflictMarkers,
  applyResolutions,
  diff3,
  splitLines,
  joinLines,
  isGitRepo,
  listConflicted,
  readStage,
  stageFile,
  assertRelPath,
  Merge3Error,
  type ConflictHunk,
  type HunkResolution,
  type MergeAnalysis,
} from '@ai-factory/merge3';
import { createShadowCheckpoint } from '../shadow-checkpoints';
import { shadowCheckpointStore } from './shadow';
import { checkScopedWrite, hasScope, ScopeLockDeniedError, type TaskEditScope } from '../scope-lock';

const PREFIX = '/api/merge';
const MAX_FILE_BYTES = 512 * 1024;

let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setMerge3InspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

let merge3ScopeLookup: ((taskId: string) => TaskEditScope | null | undefined) | null = null;

export function setMerge3ScopeLookup(fn: ((taskId: string) => TaskEditScope | null | undefined) | null): void {
  merge3ScopeLookup = fn;
}

export class Merge3RouteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'Merge3RouteError';
    this.code = code;
    this.status = status;
  }
}

function resolveRepo(rawRepo: unknown): string {
  if (!inspectionRootResolver) {
    throw new Merge3RouteError('inspection root resolver is not wired', 'not-wired', 503);
  }
  let repo: string;
  try {
    repo =
      typeof rawRepo === 'string' && rawRepo.trim()
        ? inspectionRootResolver(rawRepo.trim())
        : inspectionRootResolver(undefined);
  } catch (e) {
    throw new Merge3RouteError((e as Error).message, 'bad-repo', 403);
  }
  if (!existsSync(repo)) {
    throw new Merge3RouteError(`repo does not exist: ${repo}`, 'repo-not-found', 404);
  }
  if (!isGitRepo(repo)) {
    throw new Merge3RouteError(`not a git repository: ${repo}`, 'not-a-git-repo', 404);
  }
  return repo;
}

function resolveFile(repo: string, rawFile: unknown): { rel: string; abs: string } {
  if (typeof rawFile !== 'string' || !rawFile.trim() || rawFile.length > 1024) {
    throw new Merge3RouteError('file is required', 'bad-file');
  }
  try {
    assertRelPath(rawFile.trim());
  } catch (e) {
    const m = e as Merge3Error;
    throw new Merge3RouteError(m.message, m.code, 403);
  }
  const rel = rawFile.trim();
  const abs = resolve(repo, rel);
  if (abs !== repo && !abs.startsWith(repo + sep)) {
    throw new Merge3RouteError(`file escapes the repo: ${rel}`, 'path-escape', 403);
  }
  if (!existsSync(abs)) {
    throw new Merge3RouteError(`file not found: ${rel}`, 'file-not-found', 404);
  }
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new Merge3RouteError(`refusing symlink: ${rel}`, 'symlink-refused', 403);
  }
  if (st.isDirectory()) {
    throw new Merge3RouteError(`not a file: ${rel}`, 'not-a-file');
  }
  if (st.size > MAX_FILE_BYTES) {
    throw new Merge3RouteError(`file too large (${st.size} bytes, cap ${MAX_FILE_BYTES})`, 'file-too-large', 413);
  }
  return { rel, abs };
}

function readWorkingFile(abs: string): { content: string; sha256: string } {
  const buf = readFileSync(abs);
  if (buf.includes(0)) {
    throw new Merge3RouteError('binary files are not supported', 'binary-file', 415);
  }
  const content = buf.toString('utf8');
  return { content, sha256: createHash('sha256').update(buf).digest('hex') };
}

function toAnalysis(repo: string, rel: string, content: string, sha256: string): MergeAnalysis {
  const split = splitLines(content);
  let hunks: ConflictHunk[];
  try {
    hunks = parseConflictMarkers(split.lines);
  } catch (e) {
    const m = e as Merge3Error;
    throw new Merge3RouteError(m.message, m.code === 'merge3-error' ? 'MARKER_PARSE_ERROR' : m.code, 409);
  }
  if (hunks.length === 0) {
    throw new Merge3RouteError(`no conflict markers in ${rel}`, 'NO_CONFLICT_MARKERS', 409);
  }
  const baseText = readStage(repo, rel, 1);
  const oursText = readStage(repo, rel, 2);
  const theirsText = readStage(repo, rel, 3);
  const stages = { base: baseText !== null, ours: oursText !== null, theirs: theirsText !== null };
  const chunks =
    baseText !== null && oursText !== null && theirsText !== null
      ? diff3(splitLines(baseText).lines, splitLines(oursText).lines, splitLines(theirsText).lines)
      : [];
  const summary = {
    markerHunks: hunks.length,
    cleanChunks: chunks.filter((c) => c.kind !== 'conflict' && c.kind !== 'stable').length,
    conflictChunks: chunks.filter((c) => c.kind === 'conflict').length,
    needsManual: chunks.filter((c) => c.needsManual).length,
  };
  return { file: rel, sha256, markerHunks: hunks, stages, chunks, summary };
}

function taskIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function handleMerge3Routes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith(PREFIX)) return false;
  const actor = 'human';

  const fail = (action: string, err: unknown): true => {
    if (err instanceof Merge3RouteError) {
      ctx.audit.record(actor, action, 'merge', path, {
        code: err.code,
        message: err.message,
      });
      ctx.json(res, err.status, { error: err.message, code: err.code });
    } else if (err instanceof Merge3Error) {
      ctx.audit.record(actor, action, 'merge', path, {
        code: err.code,
        message: err.message,
      });
      ctx.json(res, 400, { error: err.message, code: err.code });
    } else {
      ctx.json(res, 500, { error: (err as Error).message });
    }
    return true;
  };

  // Wrap the whole dispatch so every endpoint shares the fail-closed path.
  // The reject-audit action is chosen per endpoint so the audit log tells
  // analyze rejections apart from resolve rejections.
  const rejectAction =
    path === `${PREFIX}/analyze`
      ? 'MERGE_ANALYZE_REJECTED'
      : path === `${PREFIX}/resolve`
        ? 'MERGE_RESOLVE_REJECTED'
        : 'MERGE_REQUEST_REJECTED';
  try {
    // ---- list conflicted files --------------------------------------
    if (path === `${PREFIX}/conflicts` && method === 'GET') {
      const repo = resolveRepo(url.searchParams.get('repo'));
      const files = listConflicted(repo);
      ctx.json(res, 200, { repo, files });
      return true;
    }

    // ---- analyze ----------------------------------------------------
    if (path === `${PREFIX}/analyze` && method === 'POST') {
      const body = await ctx.readBody(req);
      const repo = resolveRepo(body['repo']);
      const { rel, abs } = resolveFile(repo, body['file']);
      const { content, sha256 } = readWorkingFile(abs);
      const analysis = toAnalysis(repo, rel, content, sha256);
      ctx.audit.record(actor, 'MERGE_ANALYZED', 'merge', rel, {
        repo,
        markerHunks: analysis.markerHunks.length,
        conflictChunks: analysis.summary.conflictChunks,
        needsManual: analysis.summary.needsManual,
      });
      ctx.json(res, 200, analysis);
      return true;
    }

    // ---- resolve ----------------------------------------------------
    if (path === `${PREFIX}/resolve` && method === 'POST') {
      const body = await ctx.readBody(req);
      const repo = resolveRepo(body['repo']);
      const { rel, abs } = resolveFile(repo, body['file']);
      const wantSha = body['sha256'];
      if (typeof wantSha !== 'string' || !/^[0-9a-f]{64}$/.test(wantSha)) {
        throw new Merge3RouteError('sha256 of the analyzed file is required', 'bad-sha256');
      }
      const resolutions = body['resolutions'];
      if (!Array.isArray(resolutions) || resolutions.length === 0) {
        throw new Merge3RouteError('resolutions must be a non-empty array', 'bad-resolutions');
      }
      const stage = body['stage'] === true;

      const { content, sha256 } = readWorkingFile(abs);
      if (sha256 !== wantSha) {
        throw new Merge3RouteError(
          'the file changed since analyze; re-analyze before resolving',
          'MERGE_DRIFT',
          409,
        );
      }

      // Scope Lock: a task-attributed resolve is checked against that
      // task's edit scope before anything is written.
      const taskId = taskIdOf(body['taskId']);
      if (taskId) {
        let taskScope: TaskEditScope | null | undefined;
        try {
          taskScope = merge3ScopeLookup ? merge3ScopeLookup(taskId) : null;
        } catch {
          throw new Merge3RouteError(`task not found: ${taskId}`, 'TASK_NOT_FOUND', 404);
        }
        if (taskScope && hasScope(taskScope)) {
          try {
            checkScopedWrite(taskScope, repo, rel);
          } catch (e) {
            if (e instanceof ScopeLockDeniedError) {
              ctx.audit.record(actor, 'SCOPE_VIOLATION', 'merge', rel, {
                taskId,
                reason: e.reason,
                path: e.relPath,
                code: 'SCOPE_LOCKED',
              });
              throw new Merge3RouteError(e.message, 'SCOPE_LOCKED', 403);
            }
            throw e;
          }
        }
      }

      const split = splitLines(content);
      let hunks: ConflictHunk[];
      try {
        hunks = parseConflictMarkers(split.lines);
      } catch (e) {
        const m = e as Merge3Error;
        throw new Merge3RouteError(m.message, 'MARKER_PARSE_ERROR', 409);
      }
      if (hunks.length === 0) {
        throw new Merge3RouteError(`no conflict markers in ${rel}`, 'NO_CONFLICT_MARKERS', 409);
      }
      const typed: HunkResolution[] = resolutions as HunkResolution[];
      const resolvedLines = applyResolutions(split.lines, hunks, typed);

      // Undo first: shadow checkpoint BEFORE the write (fail-closed).
      let checkpointId: string;
      try {
        const cp = createShadowCheckpoint(shadowCheckpointStore(), {
          workspaceId: 'merge-conflict',
          workspacePath: repo,
          label: `merge resolve ${rel}`,
        });
        checkpointId = cp.id;
      } catch (err) {
        ctx.audit.record(actor, 'MERGE_RESOLVE_REJECTED', 'merge', rel, {
          reason: `checkpoint failed: ${(err as Error).message}`,
        });
        throw new Merge3RouteError(
          `shadow checkpoint unavailable; write refused: ${(err as Error).message}`,
          'MERGE_CHECKPOINT_UNAVAILABLE',
          503,
        );
      }

      writeFileSync(abs, joinLines(split, resolvedLines), 'utf8');

      let staged = false;
      let stageError: string | null = null;
      if (stage) {
        try {
          stageFile(repo, rel);
          staged = true;
        } catch (e) {
          stageError = (e as Error).message;
        }
      }
      ctx.audit.record(actor, 'MERGE_RESOLVED', 'merge', rel, {
        repo,
        hunks: hunks.length,
        staged,
        checkpointId,
      });
      if (staged) {
        ctx.audit.record(actor, 'MERGE_STAGED', 'merge', rel, { repo });
      }
      ctx.json(res, 200, {
        file: rel,
        resolved: true,
        staged,
        stageError,
        checkpointId,
        sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
      });
      return true;
    }
  } catch (err) {
    return fail(rejectAction, err);
  }
  return false;
}
