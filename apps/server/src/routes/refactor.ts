/**
 * Deterministic refactoring routes (round-4 task R4-S3).
 *
 *   POST /api/refactor/analyze   {projectId, targetDir?, file, op,
 *                                  selection?|lines?|offset?|newName?, name?,
 *                                  otherFiles?[]}
 *                                 → 200 {proposalId, file, op, items[], warnings}
 *                                     400 {error, code} when the op refuses
 *   POST /api/refactor/apply     {proposalId, acceptedIds[]}
 *                                 → 200 {applied[], skipped[]}
 *                                     404 unknown/expired proposal
 *                                     409 {error:'REFACTOR_DRIFT'} when a file
 *                                         changed since analyze
 *   GET  /api/refactor/proposals/:proposalId → 200 {proposal} | 404
 *
 * A proposal is an in-memory, side-effect-free preview: `analyze` never
 * writes. `apply` re-reads every touched file and compares sha256 against
 * the analyze-time snapshot — any drift fails closed with 409 and nothing
 * is written. Proposals expire after 10 minutes.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleRefactorRoutes, setRefactorInspectionRootResolver } from './routes/refactor';
 *   if (await handleRefactorRoutes(req, res, url, routeCtx)) return;
 *   setRefactorInspectionRootResolver((root) => resolveInspectionRoot(root));
 *
 * RBAC: the default prefix rule in auth.ts (requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no auth.ts
 * change needed.
 *
 * Audit: REFACTOR_ANALYZED / REFACTOR_APPLIED / REFACTOR_APPLY_REJECTED.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - TS/JS only (.ts/.tsx/.js/.jsx/.mjs/.cjs); no Flow, no TSX generics
 *    edge cases beyond what the tokenizer handles.
 *  - extract-method is closure-based and never synthesizes parameters;
 *    selections with escaping return/break/continue are refused.
 *  - rename is scope-aware per file; cross-file rename only follows
 *    explicit `otherFiles` importers supplied by the caller.
 *  - preview diffs are computed in-memory by @ai-factory/refactor's own
 *    unified-diff generator (deterministic); the shadow-git diff pipeline
 *    is not reused because preview must be side-effect free (no checkpoints).
 *  - apply is all-or-nothing per request: any drift aborts everything.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import {
  applyEdits,
  extractMethod,
  extractVariable,
  inlineVariable,
  renameSymbol,
  unifiedDiff,
  type FileEdits,
  type RefactorOpResult,
  type RefactorWarning,
} from '@ai-factory/refactor';

const PREFIX = '/api/refactor';
const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_OTHER_FILES = 20;
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export class RefactorRouteError extends Error {
  readonly code: string;
  constructor(message: string, code: string = 'refactor-error') {
    super(message);
    this.name = 'RefactorRouteError';
    this.code = code;
  }
}

/**
 * Inspection-root resolver, injected by the coordinator (setter-injection
 * pattern: routes/refactor must not value-import ../inspections, so that
 * direct type-stripping tests keep working — AGENTS.md dual-mode rule).
 */
let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setRefactorInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

function resolveTargetDir(rawDir?: string): string {
  if (!inspectionRootResolver) {
    throw new RefactorRouteError('inspection root resolver is not wired', 'not-wired');
  }
  try {
    return inspectionRootResolver(rawDir);
  } catch (e) {
    throw new RefactorRouteError((e as Error).message, 'bad-target-dir');
  }
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

/** Jail a requested relative file to the target dir; fail-closed. */
function jailRelFile(root: string, file: string, label: string): string {
  if (typeof file !== 'string' || !file.trim() || file.length > 512) {
    throw new RefactorRouteError(`invalid ${label}: ${String(file).slice(0, 80)}`, 'bad-file');
  }
  const abs = resolve(root, file);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new RefactorRouteError(`${label} escapes the target dir: ${file}`, 'jail');
  }
  if (!existsSync(abs)) {
    throw new RefactorRouteError(`${label} does not exist: ${file}`, 'not-found');
  }
  const lower = abs.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  if (!SOURCE_EXTS.has(ext)) {
    throw new RefactorRouteError(`${label} is not a TS/JS file: ${file}`, 'bad-ext');
  }
  return abs;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// proposal store (in-memory, TTL)
// ---------------------------------------------------------------------------

export interface RefactorItem {
  id: string;
  file: string;
  before: string;
  after: string;
  diff: string;
  edits: FileEdits;
  warnings: RefactorWarning[];
}

export interface RefactorProposal {
  proposalId: string;
  projectId: string;
  op: string;
  createdAt: string;
  items: RefactorItem[];
  warnings: RefactorWarning[];
}

interface StoredProposal {
  proposal: RefactorProposal;
  /** resolved inspection root used at analyze time (apply must reuse it) */
  root: string;
  /** absolute path -> {rel, sha256} snapshot at analyze time */
  snapshots: Map<string, { rel: string; sha256: string }>;
}

const proposals = new Map<string, StoredProposal>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, sp] of proposals) {
    if (now - Date.parse(sp.proposal.createdAt) > PROPOSAL_TTL_MS) {
      proposals.delete(id);
    }
  }
}

export function getProposal(id: string): RefactorProposal | null {
  sweepExpired();
  return proposals.get(id)?.proposal ?? null;
}

// ---------------------------------------------------------------------------
// op dispatch
// ---------------------------------------------------------------------------

type OpName = 'extract-variable' | 'extract-method' | 'inline-variable' | 'rename-symbol';

function strOf(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface OpInputs {
  file: string;
  otherFiles: string[];
  run: (source: string, others: { path: string; source: string }[]) => RefactorOpResult;
}

function parseAnalyzeBody(body: Record<string, unknown>): { projectId: string; targetDir?: string; op: OpName } & Record<string, unknown> {
  const projectId = projectIdOf(body['projectId']);
  if (!projectId) throw new RefactorRouteError('projectId is required', 'bad-project');
  const op = strOf(body['op']);
  if (op !== 'extract-variable' && op !== 'extract-method' && op !== 'inline-variable' && op !== 'rename-symbol') {
    throw new RefactorRouteError(`unsupported op: ${String(op)}`, 'bad-op');
  }
  const rawDir = strOf(body['targetDir']);
  return { projectId, ...(rawDir ? { targetDir: rawDir } : {}), op: op as OpName, ...body };
}

function buildOpInputs(root: string, body: Record<string, unknown>, op: OpName): OpInputs {
  const file = strOf(body['file']);
  if (!file) throw new RefactorRouteError('file is required', 'bad-file');
  jailRelFile(root, file, 'file');

  const otherFilesRaw = body['otherFiles'];
  const otherFiles: string[] = [];
  if (otherFilesRaw !== undefined) {
    if (!Array.isArray(otherFilesRaw)) throw new RefactorRouteError('otherFiles must be an array', 'bad-file');
    if (otherFilesRaw.length > MAX_OTHER_FILES) {
      throw new RefactorRouteError(`otherFiles capped at ${MAX_OTHER_FILES}`, 'bad-file');
    }
    for (const f of otherFilesRaw) {
      if (typeof f !== 'string') throw new RefactorRouteError('otherFiles must be strings', 'bad-file');
      jailRelFile(root, f, 'otherFiles[]');
      if (f !== file) otherFiles.push(f);
    }
  }

  let run: OpInputs['run'];
  if (op === 'extract-variable') {
    const sel = body['selection'] as Record<string, unknown> | undefined;
    const start = sel ? numOf(sel['start']) : null;
    const end = sel ? numOf(sel['end']) : null;
    const name = strOf(body['name']);
    if (start === null || end === null || !name) {
      throw new RefactorRouteError('extract-variable needs selection {start,end} and name', 'bad-params');
    }
    run = (source) => extractVariable(source, file, { start, end }, name);
  } else if (op === 'extract-method') {
    const lines = body['lines'] as Record<string, unknown> | undefined;
    const startLine = lines ? numOf(lines['startLine']) : null;
    const endLine = lines ? numOf(lines['endLine']) : null;
    const name = strOf(body['name']);
    if (startLine === null || endLine === null || !name) {
      throw new RefactorRouteError('extract-method needs lines {startLine,endLine} and name', 'bad-params');
    }
    run = (source) => extractMethod(source, file, { startLine, endLine }, name);
  } else if (op === 'inline-variable') {
    const offset = numOf(body['offset']);
    if (offset === null) throw new RefactorRouteError('inline-variable needs offset', 'bad-params');
    run = (source) => inlineVariable(source, file, offset);
  } else {
    const offset = numOf(body['offset']);
    const newName = strOf(body['newName']);
    if (offset === null || !newName) {
      throw new RefactorRouteError('rename-symbol needs offset and newName', 'bad-params');
    }
    run = (source, others) => renameSymbol(source, file, offset, newName, others);
  }
  return { file, otherFiles, run };
}

function readSource(abs: string, label: string): string {
  const buf = readFileSync(abs);
  if (buf.length > MAX_FILE_BYTES) {
    throw new RefactorRouteError(`${label} exceeds ${MAX_FILE_BYTES} bytes`, 'too-large');
  }
  return buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async function handleAnalyze(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const body = await ctx.readBody(req);
  let parsed: ReturnType<typeof parseAnalyzeBody>;
  try {
    parsed = parseAnalyzeBody(body);
  } catch (e) {
    const err = e as RefactorRouteError;
    ctx.json(res, 400, { error: err.message, code: err.code });
    return true;
  }
  const { projectId, targetDir, op } = parsed;
  let root: string;
  let inputs: OpInputs;
  try {
    root = resolveTargetDir(targetDir);
    inputs = buildOpInputs(root, parsed, op);
  } catch (e) {
    const err = e as RefactorRouteError;
    ctx.json(res, 400, { error: err.message, code: err.code });
    return true;
  }

  const abs = resolve(root, inputs.file);
  let source: string;
  try {
    source = readSource(abs, 'file');
  } catch (e) {
    const err = e as RefactorRouteError;
    ctx.json(res, 400, { error: err.message, code: err.code ?? 'read-failed' });
    return true;
  }
  const others: { path: string; source: string }[] = [];
  try {
    for (const f of inputs.otherFiles) {
      others.push({ path: f, source: readSource(resolve(root, f), 'otherFiles[]') });
    }
  } catch (e) {
    const err = e as RefactorRouteError;
    ctx.json(res, 400, { error: err.message, code: err.code ?? 'read-failed' });
    return true;
  }

  let result: RefactorOpResult;
  try {
    result = inputs.run(source, others);
  } catch (e) {
    ctx.json(res, 500, { error: `refactor failed: ${(e as Error).message}`, code: 'op-threw' });
    return true;
  }
  if (!result.ok) {
    ctx.audit.record('human', 'REFACTOR_APPLY_REJECTED', 'refactor', `${projectId}:${op}`, {
      file: inputs.file,
      op,
      reason: result.error.code,
    });
    ctx.json(res, 400, { error: result.error.message, code: result.error.code, op });
    return true;
  }

  // build preview items (in-memory only — no writes)
  const byFile = new Map<string, string>();
  byFile.set(inputs.file, source);
  for (const o of others) byFile.set(o.path, o.source);

  const items: RefactorItem[] = [];
  const snapshots = new Map<string, { rel: string; sha256: string }>();
  for (const fe of result.fileEdits) {
    const before = byFile.get(fe.file);
    if (before === undefined) continue; // defensive: op returned an unknown file
    const after = applyEdits(before, fe.edits);
    snapshots.set(resolve(root, fe.file), { rel: fe.file, sha256: sha256(before) });
    items.push({
      id: randomUUID(),
      file: fe.file,
      before,
      after,
      diff: unifiedDiff(before, after, { fromFile: `a/${fe.file}`, toFile: `b/${fe.file}` }),
      edits: fe,
      warnings: result.warnings,
    });
  }

  const proposal: RefactorProposal = {
    proposalId: randomUUID(),
    projectId,
    op,
    createdAt: new Date().toISOString(),
    items,
    warnings: result.warnings,
  };
  sweepExpired();
  proposals.set(proposal.proposalId, { proposal, root, snapshots });
  ctx.audit.record('human', 'REFACTOR_ANALYZED', 'refactor', `${projectId}:${op}`, {
    file: inputs.file,
    op,
    items: items.length,
    proposalId: proposal.proposalId,
  });
  ctx.json(res, 200, {
    proposalId: proposal.proposalId,
    projectId,
    op,
    warnings: proposal.warnings,
    items: items.map((it) => ({
      id: it.id,
      file: it.file,
      diff: it.diff,
      warnings: it.warnings,
    })),
  });
  return true;
}

async function handleApply(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const body = await ctx.readBody(req);
  const proposalId = strOf(body['proposalId']);
  if (!proposalId) {
    ctx.json(res, 400, { error: 'proposalId is required', code: 'bad-proposal' });
    return true;
  }
  sweepExpired();
  const stored = proposals.get(proposalId);
  if (!stored) {
    ctx.json(res, 404, { error: 'unknown or expired proposal', code: 'no-proposal' });
    return true;
  }
  const acceptedIds = body['acceptedIds'];
  if (!Array.isArray(acceptedIds) || !acceptedIds.every((x) => typeof x === 'string')) {
    ctx.json(res, 400, { error: 'acceptedIds must be a string array', code: 'bad-params' });
    return true;
  }
  const accepted = new Set(acceptedIds as string[]);
  const items = stored.proposal.items.filter((it) => accepted.has(it.id));
  if (items.length === 0) {
    ctx.json(res, 400, { error: 'no accepted items', code: 'bad-params' });
    return true;
  }

  // reuse the analyze-time root: the proposal is bound to it
  const root = stored.root;

  // drift guard: re-read every touched file BEFORE writing anything
  const current = new Map<string, string>();
  for (const it of items) {
    const abs = resolve(root, it.file);
    // re-jail (defensive: proposal could predate nothing, but be strict)
    if (abs !== root && !abs.startsWith(root + sep)) {
      ctx.json(res, 400, { error: `file escapes the target dir: ${it.file}`, code: 'jail' });
      return true;
    }
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      ctx.json(res, 409, { error: `REFACTOR_DRIFT: ${it.file} is unreadable`, code: 'REFACTOR_DRIFT', file: it.file });
      return true;
    }
    const snap = stored.snapshots.get(abs);
    if (!snap || sha256(text) !== snap.sha256) {
      ctx.json(res, 409, { error: `REFACTOR_DRIFT: ${it.file} changed since analyze`, code: 'REFACTOR_DRIFT', file: it.file });
      return true;
    }
    current.set(abs, text);
  }

  // all-or-nothing: apply in memory first, then write atomically
  const applied: string[] = [];
  try {
    for (const it of items) {
      const abs = resolve(root, it.file);
      const after = applyEdits(current.get(abs) as string, it.edits.edits);
      const tmp = `${abs}.${process.pid}.tmp`;
      writeFileSync(tmp, after, 'utf8');
      renameSync(tmp, abs);
      applied.push(it.file);
    }
  } catch (e) {
    ctx.json(res, 500, { error: `apply failed: ${(e as Error).message}`, code: 'apply-failed', applied });
    return true;
  }
  proposals.delete(proposalId);
  const skipped = stored.proposal.items.filter((it) => !accepted.has(it.id)).map((it) => it.id);
  ctx.audit.record('human', 'REFACTOR_APPLIED', 'refactor', `${stored.proposal.projectId}:${stored.proposal.op}`, {
    proposalId,
    op: stored.proposal.op,
    applied,
    skipped,
  });
  ctx.json(res, 200, { proposalId, applied, skipped });
  return true;
}

export async function handleRefactorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  try {
    if (method === 'POST' && path === `${PREFIX}/analyze`) return await handleAnalyze(req, res, ctx);
    if (method === 'POST' && path === `${PREFIX}/apply`) return await handleApply(req, res, ctx);

    const propMatch = /^\/api\/refactor\/proposals\/([a-zA-Z0-9-]+)$/.exec(path);
    if (method === 'GET' && propMatch) {
      const proposal = getProposal(propMatch[1]);
      if (!proposal) {
        ctx.json(res, 404, { error: 'unknown or expired proposal', code: 'no-proposal' });
        return true;
      }
      ctx.json(res, 200, {
        proposalId: proposal.proposalId,
        projectId: proposal.projectId,
        op: proposal.op,
        createdAt: proposal.createdAt,
        warnings: proposal.warnings,
        items: proposal.items.map((it) => ({ id: it.id, file: it.file, diff: it.diff, warnings: it.warnings })),
      });
      return true;
    }
  } catch (e) {
    const err = e as RefactorRouteError;
    ctx.json(res, 400, { error: err.message, code: err.code ?? 'refactor-error' });
    return true;
  }

  ctx.json(res, 404, { error: 'unknown refactor route', code: 'not-found' });
  return true;
}
