/**
 * Scratch files (round-5 task R5-B10) — temporary draft buffers that live
 * OUTSIDE any project tree, in <AI_FACTORY_DATA_DIR>/scratches/.
 *
 * Endpoints:
 *   GET    /api/scratches            list metas (newest first)
 *   POST   /api/scratches            { language, name? } -> create
 *   GET    /api/scratches/:id        meta + content
 *   PUT    /api/scratches/:id        { name?, content? } -> rename / save
 *   DELETE /api/scratches/:id        delete
 *   POST   /api/scratches/:id/run    run through the SHARED exec policy
 *
 * Execution safety (same channel as the R5-S2 task runner, no new device):
 * the scratch content is copied to an isolated temp dir OUTSIDE the
 * control-plane data dir, then executed with execFile through
 * checkCommandPolicy (deny patterns + binary whitelist + argv guards) and
 * the control-dir guard. Only languages whose runner binary is whitelisted
 * can run — currently node for javascript/typescript; everything else is
 * edit-only (declared honestly in the language registry).
 * Env is credential-scrubbed; output is capped; the run is synchronous
 * with a 30s timeout. Running a scratch executes arbitrary code: it is
 * explicit user action, never automatic.
 *
 * Declared non-properties (also rendered in the UI):
 *  - scratches are NOT git-tracked, NOT indexed, NOT snapshotted;
 *  - they are NOT audited (no SCRATCH_* audit events by design);
 *  - scratch content is NOT covered by the pre-send prompt secret scan —
 *    the panel warns against pasting secrets;
 *  - closing the IDE never deletes scratches; there is no cloud sync.
 *
 * Dual-mode import rule (AGENTS.md): this module is imported straight from
 * src by unit tests under node's type-stripping loader, so it value-imports
 * ONLY node builtins and @ai-factory/scratch. The data-dir root and the
 * exec policy cross via the setter injection below (wired in index.ts).
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createScratch,
  deleteScratch,
  getScratch,
  languageById,
  LANGUAGES,
  listScratches,
  updateScratch,
  ScratchError,
} from '@ai-factory/scratch';
import { scrubCredentialEnv } from '@ai-factory/runtime';
import type { RouteContext } from './context';

const PREFIX = '/api/scratches';
const SCRATCHES_DIR = 'scratches';
const RUN_TIMEOUT_MS = 30_000;
const RUN_OUTPUT_CAP = 512_000;

/** All policy seams, injected once by index.ts at boot. */
export interface ScratchDeps {
  /** Absolute user data dir (AI_FACTORY_DATA_DIR). */
  resolveDataDir: () => string;
  /** Exec safety policy: deny patterns + whitelist + argv guards. Throws on deny. */
  checkCommandPolicy: (command: string) => string[];
  /** Control-plane data-dir guard. */
  commandHitsControlDir: (cwd: string, tokens: string[]) => boolean;
}

let deps: ScratchDeps | null = null;

/** Installed once by index.ts at boot. */
export function setScratchDeps(d: ScratchDeps | null): void {
  deps = d;
}

function needDeps(): ScratchDeps {
  if (!deps) throw new ScratchError('not-wired', 'scratch routes are not wired');
  return deps;
}

function storeRoot(): string {
  return join(needDeps().resolveDataDir(), SCRATCHES_DIR);
}

function scratchErrorToStatus(e: ScratchError): number {
  switch (e.code) {
    case 'not-found':
      return 404;
    case 'bad-id':
    case 'bad-name':
    case 'bad-language':
    case 'too-large':
    case 'too-many':
    case 'exists':
      return 400;
    default:
      return 500;
  }
}

function defaultName(lang: { extension: string }, count: number): string {
  return `scratch${count + 1}.${lang.extension}`;
}

interface RunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  runner: string;
  language: string;
}

/**
 * Run a scratch through the SHARED exec safety policy. The content is
 * staged in an isolated temp dir outside the control-plane data dir
 * (so commandHitsControlDir never trips on the store itself), executed
 * as `node <file>`, and the temp dir is removed afterwards.
 */
async function runScratch(d: ScratchDeps, id: string): Promise<RunResult> {
  const scratch = getScratch(storeRoot(), id);
  const lang = languageById(scratch.language);
  if (!lang || !lang.runnable) {
    throw new ScratchError(
      'runner-unsupported',
      `language "${scratch.language}" is edit-only: only node-runnable languages ` +
        `(typescript, javascript) can be executed under the shared exec safety policy`,
    );
  }
  const runDir = mkdtempSync(join(tmpdir(), 'ai-factory-scratch-run-'));
  try {
    const staged = join(runDir, `scratch.${lang.extension}`);
    writeFileSync(staged, scratch.content, 'utf8');
    // Quote-aware policy check first: node inline eval is refused by the
    // policy itself; we always pass a file, never -e.
    const tokens = d.checkCommandPolicy(`node "${staged}"`);
    if (d.commandHitsControlDir(runDir, tokens)) {
      throw new ScratchError('control-dir', 'scratch run touches the control-plane data dir (refused)');
    }
    return await new Promise<RunResult>((resolve) => {
      execFile(
        tokens[0] as string,
        tokens.slice(1),
        {
          cwd: runDir,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: RUN_OUTPUT_CAP,
          env: { ...scrubCredentialEnv(process.env) },
        },
        (err, stdout, stderr) => {
          const out = String(stdout ?? '');
          const errOut = String(stderr ?? '');
          const truncated = out.length >= RUN_OUTPUT_CAP || errOut.length >= RUN_OUTPUT_CAP;
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
            const timedOut = e.killed === true && e.signal === 'SIGTERM';
            resolve({
              ok: false,
              exitCode: typeof e.code === 'number' ? e.code : null,
              stdout: out.slice(0, RUN_OUTPUT_CAP),
              stderr: errOut.slice(0, RUN_OUTPUT_CAP),
              timedOut,
              truncated,
              runner: 'node',
              language: scratch.language,
            });
            return;
          }
          resolve({
            ok: true,
            exitCode: 0,
            stdout: out.slice(0, RUN_OUTPUT_CAP),
            stderr: errOut.slice(0, RUN_OUTPUT_CAP),
            timedOut: false,
            truncated,
            runner: 'node',
            language: scratch.language,
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

function parseId(pathname: string): { id: string | null; action: string | null } {
  const m = /^\/api\/scratches\/([^/]+)(\/run)?$/.exec(pathname);
  if (!m) return { id: null, action: null };
  return { id: decodeURIComponent(m[1]), action: m[2] ? 'run' : null };
}

async function handleList(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  ctx.json(res, 200, { scratches: listScratches(storeRoot()), languages: LANGUAGES });
  return true;
}

async function handleCreate(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const body = (await ctx.readBody(req)) as { language?: unknown; name?: unknown };
  const language = typeof body.language === 'string' ? body.language : '';
  const lang = languageById(language);
  if (!lang) {
    ctx.json(res, 400, {
      error: `unknown language: ${JSON.stringify(language)}`,
      code: 'bad-language',
      languages: LANGUAGES.map((l) => l.id),
    });
    return true;
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  try {
    const meta = createScratch(storeRoot(), {
      id: randomUUID(),
      name: name ?? defaultName(lang, listScratches(storeRoot()).length),
      language,
    });
    ctx.json(res, 201, { scratch: meta });
  } catch (e) {
    if (e instanceof ScratchError) {
      ctx.json(res, scratchErrorToStatus(e), { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return true;
}

async function handleGet(id: string, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    ctx.json(res, 200, { scratch: getScratch(storeRoot(), id) });
  } catch (e) {
    if (e instanceof ScratchError) {
      ctx.json(res, scratchErrorToStatus(e), { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return true;
}

async function handleUpdate(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const body = (await ctx.readBody(req)) as { name?: unknown; content?: unknown };
  const patch: { name?: string; content?: string } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      ctx.json(res, 400, { error: 'name must be a string', code: 'bad-name' });
      return true;
    }
    patch.name = body.name.trim();
  }
  if (body.content !== undefined) {
    if (typeof body.content !== 'string') {
      ctx.json(res, 400, { error: 'content must be a string', code: 'bad-content' });
      return true;
    }
    patch.content = body.content;
  }
  try {
    ctx.json(res, 200, { scratch: updateScratch(storeRoot(), id, patch) });
  } catch (e) {
    if (e instanceof ScratchError) {
      ctx.json(res, scratchErrorToStatus(e), { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return true;
}

async function handleDelete(id: string, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    deleteScratch(storeRoot(), id);
    ctx.json(res, 200, { ok: true });
  } catch (e) {
    if (e instanceof ScratchError) {
      ctx.json(res, scratchErrorToStatus(e), { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return true;
}

async function handleRun(id: string, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const d = needDeps();
  try {
    const result = await runScratch(d, id);
    ctx.json(res, 200, { run: result });
  } catch (e) {
    if (e instanceof ScratchError) {
      const status = e.code === 'runner-unsupported' ? 400 : scratchErrorToStatus(e);
      ctx.json(res, status, { error: e.message, code: e.code });
      return true;
    }
    const denied = (e as Error).name === 'ExecPolicyDenied';
    ctx.json(res, denied ? 403 : 500, {
      error: (e as Error).message,
      code: denied ? 'exec-denied' : 'run-failed',
    });
    return true;
  }
  return true;
}

/** Dispatch; returns true when the request was handled. */
export async function handleScratchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const pathname = url.pathname;
  if (pathname === PREFIX || pathname === PREFIX + '/') {
    if (req.method === 'GET') return handleList(res, ctx);
    if (req.method === 'POST') return handleCreate(req, res, ctx);
    return false;
  }
  if (!pathname.startsWith(PREFIX + '/')) return false;
  const { id, action } = parseId(pathname);
  if (!id) return false;
  if (action === 'run') {
    if (req.method !== 'POST') return false;
    return handleRun(id, res, ctx);
  }
  if (req.method === 'GET') return handleGet(id, res, ctx);
  if (req.method === 'PUT') return handleUpdate(id, req, res, ctx);
  if (req.method === 'DELETE') return handleDelete(id, res, ctx);
  return false;
}
