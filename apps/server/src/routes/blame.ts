/**
 * Git blame + Timeline routes (round-5 task R5-A4).
 *
 *   GET /api/blame?path=&root=                  per-line blame (viewer)
 *   GET /api/timeline?path=&root=                fused git log x local-history timeline (viewer)
 *   GET /api/timeline/diff?path=&from=&to=&root= unified diff between two timeline points (viewer)
 *
 * `from`/`to` are `git:<hash>` | `snapshot:<id>` | `work`.
 *
 * Jail: paths are confined to the inspection root injected by the
 * coordinator (setter-injection pattern — routes must not value-import
 * ../inspections, AGENTS.md dual-mode rule). Git operations run with cwd
 * pinned to the resolved repo root via execFile argv arrays (no shell).
 *
 * RBAC: the default prefix rule gives GET -> viewer. All endpoints are
 * read-only; no audit records (same posture as the TODO scan GET).
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleBlameRoutes, setBlameInspectionRootResolver } from './routes/blame';
 *   if (await handleBlameRoutes(req, res, url, routeCtx)) return;
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Blame is a snapshot of the working tree at call time; edits after the
 *    call need a fresh request. Lines with no commit yet are marked
 *    `uncommitted` (author unknown).
 *  - Directories outside any git repository honestly answer 409
 *    NOT_A_GIT_REPO on /api/blame; /api/timeline still returns the
 *    local-history snapshots with `noGit: true` — never invented history.
 *  - Large files: blame is capped at 2000 lines (`truncated: true`);
 *    timeline diffs fail closed above 6000 total lines.
 *  - Snapshot timestamps come from snapshot file names (epoch ms); git
 *    timestamps are author-time epoch seconds.
 */
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import {
  blameFile,
  fuseTimeline,
  gitShowFile,
  logFile,
  repoRootOf,
  snapshotsToEntries,
  unifiedDiffText,
  BlameError,
  type TimelinePoint,
} from '@ai-factory/blame';
import { canonicalPathIsInside, canonicalizePathSync } from '@ai-factory/security';
import { listSnapshots, readSnapshot } from '../local-history';
import type { RouteContext } from './context';

const PREFIX = '/api/blame';
const TIMELINE_PREFIX = '/api/timeline';
export const BLAME_LINE_CAP = 2000;
const GIT_LOG_LIMIT = 100;
const DIFF_MAX_TOTAL_LINES = 6000;
const DIFF_MAX_BYTES = 512 * 1024;

/** Inspection-root resolver, injected by the coordinator (setter pattern). */
let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setBlameInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

export class BlameRouteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'BlameRouteError';
    this.status = status;
    this.code = code;
  }
}

function resolveRoot(rawRoot?: string): string {
  if (!inspectionRootResolver) {
    throw new BlameRouteError('inspection root resolver is not wired', 500, 'not-wired');
  }
  try {
    return inspectionRootResolver(rawRoot);
  } catch (e) {
    throw new BlameRouteError((e as Error).message, 403, 'bad-root');
  }
}

/** Confine a workspace-relative path to the root; fail-closed. */
function jailFile(root: string, raw: unknown): { abs: string; rel: string } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) {
    throw new BlameRouteError('path is required', 400, 'bad-path');
  }
  // V3R19 #6(p): decide on the canonical path — a symlink inside the
  // inspection root that points outside it must be refused exactly
  // like a direct path outside the root.
  const abs = canonicalizePathSync(resolve(root, raw));
  const realRoot = canonicalizePathSync(root);
  if (abs !== realRoot && !canonicalPathIsInside(abs, realRoot)) {
    throw new BlameRouteError(`path escapes the inspection root: ${raw.slice(0, 80)}`, 403, 'path-escaped');
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new BlameRouteError(`path does not exist: ${raw.slice(0, 80)}`, 404, 'path-missing');
  }
  if (!st.isFile()) throw new BlameRouteError(`path is not a file: ${raw.slice(0, 80)}`, 400, 'not-a-file');
  return { abs, rel: relative(realRoot, abs) };
}

function blameStatus(e: unknown): { status: number; code: string } {
  if (e instanceof BlameError) {
    switch (e.code) {
      case 'NOT_A_REPO':
        return { status: 409, code: 'NOT_A_GIT_REPO' };
      case 'BLAME_TIMEOUT':
      case 'LOG_TIMEOUT':
        return { status: 504, code: 'GIT_TIMEOUT' };
      case 'BAD_REF':
        return { status: 400, code: 'BAD_REF' };
      default:
        return { status: 502, code: 'GIT_FAILED' };
    }
  }
  return { status: 500, code: 'internal' };
}

function parsePoint(raw: string | null): TimelinePoint {
  const s = (raw ?? '').trim();
  if (s === 'work') return { type: 'work', ref: '' };
  const m = /^(git|snapshot):(.+)$/.exec(s);
  if (!m) {
    throw new BlameRouteError(
      `point must be git:<hash> | snapshot:<id> | work, got: ${s.slice(0, 60)}`,
      400,
      'bad-point',
    );
  }
  return { type: m[1] as 'git' | 'snapshot', ref: m[2] };
}

async function contentOf(
  point: TimelinePoint,
  root: string,
  abs: string,
  rel: string,
  repoRoot: string | null,
): Promise<{ label: string; content: string }> {
  if (point.type === 'work') {
    const content = readFileSync(abs, 'utf8');
    return { label: 'work (current)', content };
  }
  if (point.type === 'snapshot') {
    const content = readSnapshot(root, rel, point.ref);
    if (content === null) {
      throw new BlameRouteError(`unknown snapshot: ${point.ref.slice(0, 60)}`, 404, 'snapshot-missing');
    }
    return { label: `snapshot ${point.ref.slice(0, 19)}…`, content };
  }
  if (!repoRoot) {
    throw new BlameRouteError('git point requested outside a git repository', 409, 'NOT_A_GIT_REPO');
  }
  const repoRel = relative(repoRoot, abs);
  const content = await gitShowFile(repoRoot, point.ref, repoRel);
  return { label: `git ${point.ref.slice(0, 7)}`, content };
}

async function handleBlame(url: URL, ctx: RouteContext, res: ServerResponse): Promise<void> {
  const root = resolveRoot(url.searchParams.get('root') ?? undefined);
  const { abs, rel } = jailFile(root, url.searchParams.get('path'));
  let repoRoot: string;
  try {
    repoRoot = await repoRootOf(dirname(abs));
  } catch (e) {
    const { status, code } = blameStatus(e);
    ctx.json(res, status, {
      error: 'no git history: the file is not inside a git repository',
      code,
    });
    return;
  }
  const repoRel = relative(repoRoot, abs);
  try {
    // Blame cap+1 lines so the truncation flag is exact, not heuristic.
    const result = await blameFile(repoRoot, repoRel, { maxLines: BLAME_LINE_CAP + 1 });
    const truncated = result.lines.length > BLAME_LINE_CAP;
    ctx.json(res, 200, {
      repoRoot,
      file: rel,
      lines: truncated ? result.lines.slice(0, BLAME_LINE_CAP) : result.lines,
      truncated,
      lineCap: BLAME_LINE_CAP,
    });
  } catch (e) {
    const { status, code } = blameStatus(e);
    ctx.json(res, status, { error: (e as Error).message, code });
  }
}

async function handleTimeline(url: URL, ctx: RouteContext, res: ServerResponse): Promise<void> {
  const root = resolveRoot(url.searchParams.get('root') ?? undefined);
  const { abs, rel } = jailFile(root, url.searchParams.get('path'));
  let repoRoot: string | null = null;
  let git: Array<import('@ai-factory/blame').TimelineGitEntry> = [];
  let noGit = false;
  try {
    repoRoot = await repoRootOf(dirname(abs));
    const repoRel = relative(repoRoot, abs);
    git = await logFile(repoRoot, repoRel, GIT_LOG_LIMIT);
  } catch (e) {
    if (e instanceof BlameError && e.code === 'NOT_A_REPO') {
      noGit = true; // honest: snapshots only, no invented history
    } else {
      const { status, code } = blameStatus(e);
      ctx.json(res, status, { error: (e as Error).message, code });
      return;
    }
  }
  const snaps = snapshotsToEntries(listSnapshots(root, rel));
  ctx.json(res, 200, {
    repoRoot: repoRoot ?? '',
    file: rel,
    noGit,
    entries: fuseTimeline(git, snaps),
  });
}

async function handleTimelineDiff(url: URL, ctx: RouteContext, res: ServerResponse): Promise<void> {
  const root = resolveRoot(url.searchParams.get('root') ?? undefined);
  const { abs, rel } = jailFile(root, url.searchParams.get('path'));
  const from = parsePoint(url.searchParams.get('from'));
  const to = parsePoint(url.searchParams.get('to'));
  let repoRoot: string | null = null;
  try {
    repoRoot = await repoRootOf(dirname(abs));
  } catch {
    repoRoot = null; // git points will 409 honestly below
  }
  let a: { label: string; content: string };
  let b: { label: string; content: string };
  try {
    a = await contentOf(from, root, abs, rel, repoRoot);
    b = await contentOf(to, root, abs, rel, repoRoot);
  } catch (e) {
    if (e instanceof BlameRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
    } else {
      const { status, code } = blameStatus(e);
      ctx.json(res, status, { error: (e as Error).message, code });
    }
    return;
  }
  if (a.content.length > DIFF_MAX_BYTES || b.content.length > DIFF_MAX_BYTES) {
    ctx.json(res, 400, { error: 'diff inputs too large (512KB cap)', code: 'DIFF_TOO_LARGE' });
    return;
  }
  const totalLines = a.content.split('\n').length + b.content.split('\n').length;
  if (totalLines > DIFF_MAX_TOTAL_LINES) {
    ctx.json(res, 400, {
      error: `diff inputs too large (${totalLines} lines > ${DIFF_MAX_TOTAL_LINES} cap)`,
      code: 'DIFF_TOO_LARGE',
    });
    return;
  }
  ctx.json(res, 200, {
    from: a.label,
    to: b.label,
    diff: unifiedDiffText(a.content, b.content, a.label, b.label),
  });
}

export async function handleBlameRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (method !== 'GET') return false;
  try {
    if (path === TIMELINE_PREFIX + '/diff') {
      await handleTimelineDiff(url, ctx, res);
      return true;
    }
    if (path === TIMELINE_PREFIX) {
      await handleTimeline(url, ctx, res);
      return true;
    }
    if (path === PREFIX) {
      await handleBlame(url, ctx, res);
      return true;
    }
  } catch (e) {
    if (e instanceof BlameRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
    } else {
      const { status, code } = blameStatus(e);
      ctx.json(res, status, { error: (e as Error).message, code });
    }
    return true;
  }
  return false;
}

/** Test seam: reset the injected resolver. */
export function __setBlameResolverForTest(fn: ((root?: string) => string) | null): void {
  setBlameInspectionRootResolver(fn);
}
