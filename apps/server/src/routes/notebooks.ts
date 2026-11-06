/**
 * Notebook routes (round-7 task R7-#2) — interactive cells: code cells
 * run, markdown cells render, outputs are stored with the notebook but
 * can be stripped on export or cleared in place.
 *
 * Endpoints:
 *   GET    /api/notebooks                       list metas (newest first)
 *   POST   /api/notebooks                       { name?, language? } -> create
 *   GET    /api/notebooks/:id                   full notebook
 *   PUT    /api/notebooks/:id                   { name?, language? } -> rename
 *   DELETE /api/notebooks/:id                   delete
 *   POST   /api/notebooks/:id/cells             { kind, language, source?, afterId? } -> add
 *   PUT    /api/notebooks/:id/cells/:cellId     { source } -> update source
 *   DELETE /api/notebooks/:id/cells/:cellId     delete cell
 *   POST   /api/notebooks/:id/cells/:cellId/move { direction } | { toIndex } -> reorder
 *   POST   /api/notebooks/:id/cells/:cellId/run run one code cell
 *   POST   /api/notebooks/:id/run-all           run code cells in order, continue on failure
 *   POST   /api/notebooks/:id/clear-outputs     clear all stored outputs
 *   GET    /api/notebooks/:id/export            full JSON; ?stripOutputs=1 drops outputs
 *
 * Execution safety (same channel as scratch runs, no new device): the
 * cell source is staged in an isolated temp dir OUTSIDE the control-plane
 * data dir, then executed as `node <file>` through checkCommandPolicy
 * (deny patterns + binary whitelist + argv guards) and the control-dir
 * guard. Only node-runnable languages (typescript/javascript) can run —
 * markdown cells return 400 on run. Env is credential-scrubbed; output
 * is capped at 64K chars per stream with truncated: true; the run is
 * synchronous with a 30s timeout. Running a cell executes arbitrary
 * code: it is explicit user action, never automatic.
 *
 * Honest non-properties (also rendered in the UI):
 *  - No Jupyter kernel: each code cell runs as its own `node` process.
 *    There is NO shared kernel state between cells — run-all is
 *    ordering, not a session.
 *  - Notebooks are NOT git-tracked, NOT indexed, NOT snapshotted;
 *  - they are NOT audited (no NOTEBOOK_* audit events by design);
 *  - notebook content is NOT covered by the pre-send prompt secret
 *    scan — the panel warns against pasting secrets.
 *
 * Dual-mode import rule (AGENTS.md): this module is imported by
 * index.ts (compiled) and may be imported straight from src by server
 * tests under node's type-stripping loader, so it value-imports ONLY
 * node builtins and @ai-factory/* packages. The data-dir root and the
 * exec policy cross via the setter injection below (wired in index.ts).
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  applyRunResult,
  deleteNotebook,
  getNotebook,
  languageById,
  LANGUAGES,
  listNotebooks,
  createNotebook,
  notebookAddCell,
  notebookClearOutputs,
  notebookDeleteCell,
  notebookMoveCell,
  notebookUpdateCell,
  saveNotebook,
  stripOutputs,
  updateNotebook,
  NotebookError,
  RUN_TIMEOUT_MS,
  type CellRunResult,
  type Notebook,
} from '@ai-factory/notebook';
import { redactText } from '@ai-factory/diagpack';
import { redactAmbientCredentialValues, scrubCredentialEnv, stripControlPlanePointerEnv } from '@ai-factory/runtime';
import type { RouteContext } from './context';
import type { ExecSandboxDecision } from '../exec-sandbox';

const PREFIX = '/api/notebooks';
const NOTEBOOKS_DIR = 'notebooks';
const RUN_OUTPUT_BUFFER = 512_000;

export interface NotebookDeps {
  /** Absolute user data dir (AI_FACTORY_DATA_DIR). */
  resolveDataDir: () => string;
  /** Exec safety policy: deny patterns + whitelist + argv guards. Throws on deny. */
  checkCommandPolicy: (command: string) => string[];
  /** Control-plane data-dir guard. */
  commandHitsControlDir: (cwd: string, tokens: string[]) => boolean;
  /**
   * OS sandbox decision for a cell run (V3R17 #6(k)(a)). Wired by
   * index.ts to decideExecSandbox; absent only when the module is
   * imported straight from src by a unit test, in which case runs
   * proceed without a sandbox (the 'disabled' tier) exactly as
   * before — production always wires it.
   */
  decideSandbox?: (cwd: string) => Promise<ExecSandboxDecision>;
}

let deps: NotebookDeps | null = null;

/** Installed once by index.ts at boot. */
export function setNotebookDeps(d: NotebookDeps | null): void {
  deps = d;
}

function needDeps(): NotebookDeps {
  if (!deps) throw new NotebookError('not-wired', 'notebook routes are not wired');
  return deps;
}

function storeRoot(): string {
  return join(needDeps().resolveDataDir(), NOTEBOOKS_DIR);
}

function notebookErrorToStatus(e: NotebookError): number {
  switch (e.code) {
    case 'not-found':
      return 404;
    case 'sandbox-unavailable':
      return 403;
    case 'bad-id':
    case 'bad-name':
    case 'bad-language':
    case 'too-large':
    case 'too-many':
    case 'too-many-cells':
    case 'bad-move':
    case 'exists':
      return 400;
    default:
      return 500;
  }
}

function defaultName(count: number): string {
  return `notebook${count + 1}`;
}

/**
 * Run one code cell through the SHARED exec safety policy. The source is
 * staged in an isolated temp dir outside the control-plane data dir
 * (so commandHitsControlDir never trips on the store itself), executed
 * as `node <file>`, and the temp dir is removed afterwards.
 */
async function runCell(d: NotebookDeps, nb: Notebook, cellId: string): Promise<CellRunResult> {
  const cell = nb.cells.find((c) => c.id === cellId);
  if (!cell) throw new NotebookError('not-found', `cell not found: ${cellId}`);
  if (cell.kind !== 'code') {
    throw new NotebookError('not-code', `cell ${cellId} is markdown and cannot run`);
  }
  const lang = languageById(cell.language);
  if (!lang || !lang.runnable) {
    throw new NotebookError(
      'runner-unsupported',
      `language "${cell.language}" is edit-only: only node-runnable languages ` +
        `(typescript, javascript) can be executed under the shared exec safety policy`,
    );
  }
  const runDir = mkdtempSync(join(tmpdir(), 'ai-factory-notebook-run-'));
  const started = Date.now();
  try {
    const staged = join(runDir, `cell.${lang.extension}`);
    writeFileSync(staged, cell.source, 'utf8');
    // Quote-aware policy check first: node inline eval is refused by the
    // policy itself; we always pass a file, never -e.
    const tokens = d.checkCommandPolicy(`node "${staged}"`);
    if (d.commandHitsControlDir(runDir, tokens)) {
      throw new NotebookError('control-dir', 'cell run touches the control-plane data dir (refused)');
    }
    // V3R17 #6(k)(a): a cell runs inside the same bwrap sandbox as
    // /api/exec (workspace-write, cwd = the isolated temp run dir).
    // Fail-closed: when bwrap is unavailable the cell does not run —
    // never silently unisolated. The vault shadowing for a cwd that
    // contains the control-plane data dir lives in decideExecSandbox
    // itself (#6(k)(a2)); the temp run dir never contains it.
    const sb: ExecSandboxDecision = d.decideSandbox
      ? await d.decideSandbox(runDir)
      : { mode: 'disabled', prefix: [], reason: null, sandboxed: false, refused: false, refuseCode: null };
    if (sb.refused) {
      throw new NotebookError(
        'sandbox-unavailable',
        `${sb.refuseCode ?? 'SANDBOX_UNAVAILABLE'}: cell runs require OS-enforced isolation (bwrap), ` +
          `but no working bwrap was found${sb.reason ? ` (${sb.reason})` : ''} — refusing to run unisolated`,
      );
    }
    const argv = [...sb.prefix, ...tokens];
    return await new Promise<CellRunResult>((resolve) => {
      execFile(
        argv[0] as string,
        argv.slice(1),
        {
          cwd: runDir,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: RUN_OUTPUT_BUFFER,
          // V3R17 #6(k)(b): control-plane pointer vars are stripped
          // from the child env on top of the credential scrub, so the
          // cell cannot locate the vault or the admin token file.
          env: { ...stripControlPlanePointerEnv(scrubCredentialEnv(process.env)) },
        },
        (err, stdout, stderr) => {
          // V3R17 #6(h): the cell result is stored in the notebook
          // AND returned, so ambient credential values are redacted
          // here, before applyRunResult persists anything.
          const out = redactAmbientCredentialValues(redactText(String(stdout ?? '')));
          const errOut = redactAmbientCredentialValues(redactText(String(stderr ?? '')));
          const durationMs = Date.now() - started;
          const bufferOverflow =
            (err as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const truncated = bufferOverflow || out.length > 64_000 || errOut.length > 64_000;
          if (err && !bufferOverflow) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
            const timedOut = e.killed === true && e.signal === 'SIGTERM';
            resolve({
              ok: false,
              exitCode: typeof e.code === 'number' ? e.code : null,
              stdout: out,
              stderr: errOut,
              timedOut,
              truncated,
              durationMs,
              runner: 'node',
              language: cell.language,
            });
            return;
          }
          resolve({
            ok: !err,
            exitCode: err ? null : 0,
            stdout: out,
            stderr: errOut,
            timedOut: false,
            truncated,
            durationMs,
            runner: 'node',
            language: cell.language,
          });
        },
      );
    });
  } finally {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; never fail the run result over it.
    }
  }
}

type Parsed =
  | { kind: 'collection' }
  | { kind: 'item'; id: string }
  | { kind: 'cells'; id: string }
  | { kind: 'cell'; id: string; cellId: string; action: string | null }
  | { kind: 'notebookAction'; id: string; action: string }
  | { kind: 'none' };

function parse(pathname: string): Parsed {
  if (pathname === PREFIX || pathname === PREFIX + '/') return { kind: 'collection' };
  if (!pathname.startsWith(PREFIX + '/')) return { kind: 'none' };
  const rest = pathname.slice(PREFIX.length + 1);
  const parts = rest.split('/').map((p) => decodeURIComponent(p));
  if (parts.length === 1) return { kind: 'item', id: parts[0]! };
  if (parts.length === 2 && parts[1] === 'cells') return { kind: 'cells', id: parts[0]! };
  if (parts.length === 2 && ['run-all', 'clear-outputs', 'export'].includes(parts[1]!)) {
    return { kind: 'notebookAction', id: parts[0]!, action: parts[1]! };
  }
  if (parts.length === 3 && parts[1] === 'cells') {
    return { kind: 'cell', id: parts[0]!, cellId: parts[2]!, action: null };
  }
  if (parts.length === 4 && parts[1] === 'cells' && ['move', 'run'].includes(parts[3]!)) {
    return { kind: 'cell', id: parts[0]!, cellId: parts[2]!, action: parts[3]! };
  }
  return { kind: 'none' };
}

function sendNotebookError(res: ServerResponse, ctx: RouteContext, e: NotebookError): boolean {
  const status = e.code === 'not-code' || e.code === 'runner-unsupported' ? 400 : notebookErrorToStatus(e);
  ctx.json(res, status, { error: e.message, code: e.code });
  return true;
}

async function handleCollection(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  if (req.method === 'GET') {
    ctx.json(res, 200, { notebooks: listNotebooks(storeRoot()), languages: LANGUAGES });
    return true;
  }
  if (req.method === 'POST') {
    const body = (await ctx.readBody(req)) as { name?: unknown; language?: unknown };
    const language = typeof body.language === 'string' && body.language ? body.language : 'typescript';
    const lang = languageById(language);
    if (!lang || lang.id === 'markdown') {
      ctx.json(res, 400, { error: `unknown notebook language: ${JSON.stringify(language)}`, code: 'bad-language' });
      return true;
    }
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : defaultName(listNotebooks(storeRoot()).length);
    try {
      const meta = createNotebook(storeRoot(), { id: randomUUID(), name, language });
      ctx.json(res, 201, { notebook: meta });
    } catch (e) {
      if (e instanceof NotebookError) return sendNotebookError(res, ctx, e);
      throw e;
    }
    return true;
  }
  return false;
}

async function handleItem(
  p: { kind: 'item'; id: string },
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  try {
    if (req.method === 'GET') {
      ctx.json(res, 200, { notebook: getNotebook(storeRoot(), p.id) });
      return true;
    }
    if (req.method === 'PUT') {
      const body = (await ctx.readBody(req)) as { name?: unknown; language?: unknown };
      const patch: { name?: string; language?: string } = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string') {
          ctx.json(res, 400, { error: 'name must be a string', code: 'bad-name' });
          return true;
        }
        patch.name = body.name.trim();
      }
      if (body.language !== undefined) {
        if (typeof body.language !== 'string') {
          ctx.json(res, 400, { error: 'language must be a string', code: 'bad-language' });
          return true;
        }
        patch.language = body.language;
      }
      ctx.json(res, 200, { notebook: updateNotebook(storeRoot(), p.id, patch) });
      return true;
    }
    if (req.method === 'DELETE') {
      deleteNotebook(storeRoot(), p.id);
      ctx.json(res, 200, { ok: true });
      return true;
    }
  } catch (e) {
    if (e instanceof NotebookError) return sendNotebookError(res, ctx, e);
    throw e;
  }
  return false;
}

async function handleCells(
  p: { kind: 'cells'; id: string },
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  try {
    const body = (await ctx.readBody(req)) as {
      kind?: unknown;
      language?: unknown;
      source?: unknown;
      afterId?: unknown;
    };
    const kind = body.kind === 'markdown' ? 'markdown' : body.kind === 'code' ? 'code' : '';
    if (!kind) {
      ctx.json(res, 400, { error: 'kind must be "code" or "markdown"', code: 'bad-kind' });
      return true;
    }
    const language =
      kind === 'markdown'
        ? 'markdown'
        : typeof body.language === 'string' && body.language
          ? body.language
          : getNotebook(storeRoot(), p.id).language;
    const source = typeof body.source === 'string' ? body.source : '';
    const afterId = typeof body.afterId === 'string' ? body.afterId : undefined;
    const { notebook, cellId } = notebookAddCell(storeRoot(), p.id, { kind, language, source, afterId });
    ctx.json(res, 201, { notebook, cellId });
    return true;
  } catch (e) {
    if (e instanceof NotebookError) return sendNotebookError(res, ctx, e);
    throw e;
  }
}

async function handleCell(
  p: { kind: 'cell'; id: string; cellId: string; action: string | null },
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const d = needDeps();
  try {
    if (p.action === null) {
      if (req.method === 'PUT') {
        const body = (await ctx.readBody(req)) as { source?: unknown };
        if (typeof body.source !== 'string') {
          ctx.json(res, 400, { error: 'source must be a string', code: 'bad-content' });
          return true;
        }
        ctx.json(res, 200, { notebook: notebookUpdateCell(storeRoot(), p.id, p.cellId, body.source) });
        return true;
      }
      if (req.method === 'DELETE') {
        ctx.json(res, 200, { notebook: notebookDeleteCell(storeRoot(), p.id, p.cellId) });
        return true;
      }
      return false;
    }
    if (req.method !== 'POST') return false;
    if (p.action === 'move') {
      const body = (await ctx.readBody(req)) as { direction?: unknown; toIndex?: unknown };
      let target: { direction: 'up' | 'down' } | { toIndex: number };
      if (body.direction === 'up' || body.direction === 'down') {
        target = { direction: body.direction };
      } else if (typeof body.toIndex === 'number') {
        target = { toIndex: body.toIndex };
      } else {
        ctx.json(res, 400, { error: 'move needs direction ("up"|"down") or toIndex', code: 'bad-move' });
        return true;
      }
      ctx.json(res, 200, { notebook: notebookMoveCell(storeRoot(), p.id, p.cellId, target) });
      return true;
    }
    // p.action === 'run'
    const nb = getNotebook(storeRoot(), p.id);
    const result = await runCell(d, nb, p.cellId);
    const updated = applyRunResult(nb, p.cellId, result);
    saveNotebook(storeRoot(), updated);
    ctx.json(res, 200, { notebook: updated, run: result });
    return true;
  } catch (e) {
    if (e instanceof NotebookError) return sendNotebookError(res, ctx, e);
    const denied = (e as Error).name === 'ExecPolicyDenied';
    ctx.json(res, denied ? 403 : 500, {
      error: (e as Error).message,
      code: denied ? 'exec-denied' : 'run-failed',
    });
    return true;
  }
}

async function handleNotebookAction(
  p: { kind: 'notebookAction'; id: string; action: string },
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<boolean> {
  const d = needDeps();
  try {
    if (p.action === 'export' && req.method === 'GET') {
      const nb = getNotebook(storeRoot(), p.id);
      const stripped = url.searchParams.get('stripOutputs') === '1';
      ctx.json(res, 200, { notebook: stripped ? stripOutputs(nb) : nb, stripped });
      return true;
    }
    if (req.method !== 'POST') return false;
    if (p.action === 'clear-outputs') {
      ctx.json(res, 200, { notebook: notebookClearOutputs(storeRoot(), p.id) });
      return true;
    }
    // run-all: code cells in order, one process each, continue on failure.
    let nb = getNotebook(storeRoot(), p.id);
    const results: Array<{ cellId: string; skipped?: boolean; ok?: boolean; exitCode?: number | null; timedOut?: boolean; truncated?: boolean }> = [];
    for (const cell of nb.cells) {
      if (cell.kind !== 'code') {
        results.push({ cellId: cell.id, skipped: true });
        continue;
      }
      try {
        const result = await runCell(d, nb, cell.id);
        nb = applyRunResult(nb, cell.id, result);
        results.push({
          cellId: cell.id,
          ok: result.ok,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        });
      } catch (e) {
        // Per-cell refusals (unsupported runner, control-dir touch,
        // sandbox unavailable) fail that cell and let the rest run;
        // a sandbox refusal fails every cell identically, but the
        // run-all envelope still reports per-cell results.
        if (e instanceof NotebookError && (e.code === 'runner-unsupported' || e.code === 'control-dir' || e.code === 'sandbox-unavailable')) {
          results.push({ cellId: cell.id, ok: false, exitCode: null });
          continue;
        }
        throw e;
      }
    }
    saveNotebook(storeRoot(), nb);
    ctx.json(res, 200, { notebook: nb, results });
    return true;
  } catch (e) {
    if (e instanceof NotebookError) return sendNotebookError(res, ctx, e);
    const denied = (e as Error).name === 'ExecPolicyDenied';
    ctx.json(res, denied ? 403 : 500, {
      error: (e as Error).message,
      code: denied ? 'exec-denied' : 'run-failed',
    });
    return true;
  }
}

/** Dispatch; returns true when the request was handled. */
export async function handleNotebookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const p = parse(url.pathname);
  switch (p.kind) {
    case 'collection':
      return handleCollection(req, res, ctx);
    case 'item':
      return handleItem(p, req, res, ctx);
    case 'cells':
      return handleCells(p, req, res, ctx);
    case 'cell':
      return handleCell(p, req, res, ctx);
    case 'notebookAction':
      return handleNotebookAction(p, req, res, ctx, url);
    default:
      return false;
  }
}
