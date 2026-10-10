/**
 * Exec routes — spec §64 (integrated terminal; controlled execution
 * infrastructure shared by agents and humans with distinct identities).
 *
 *  POST /api/exec  {command, cwd?} → run one command, return its output.
 *
 * Prototype safety model (no real PTY — one-shot execution):
 *  - binary whitelist: only read-only / build-class commands may run
 *  - deny patterns: rm -rf /, curl/wget outbound, sudo, chmod, disk ops…
 *  - cwd is confined to the server workspace root (no path escape)
 *  - 30s timeout, output truncated to a fixed budget
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleExecRoutes } from './routes/exec';
 *   if (await handleExecRoutes(req, res, url, ctx)) return;
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { relative, resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';

const execFileAsync = promisify(execFile);

/**
 * Workspace root — the ai-factory project root (the server is started from
 * it). All execution is confined to this tree.
 */
const WORKSPACE_ROOT = resolve(process.cwd());

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 32 * 1024;

/** Read-only / build-class binaries only. */
const ALLOWED_BINARIES = new Set([
  'ls',
  'cat',
  'pwd',
  'echo',
  'git',
  'npm',
  'node',
  'npx',
  'tsc',
  'tree',
  'find',
  'grep',
  'head',
  'tail',
  'wc',
  'du',
  'df',
  'uname',
  'whoami',
  'date',
  'hostname',
  'printenv',
  'stat',
  'dirname',
  'basename',
]);

/** Anything matching one of these is refused outright. */
const DENY_PATTERNS: RegExp[] = [
  /\brm\b/, // no rm at all in the prototype
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bsudo\b/,
  /\bsu\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bmount\b/,
  /\bumount\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bkillall\b/,
  /:\(\)\s*\{/, // fork bomb
  /\/dev\/(sda|hda|nvme)/, // raw disk writes
];

/**
 * Minimal shell-style tokenizer (handles single/double quotes and
 * backslash escapes). execFile does NOT invoke a shell, so metacharacters
 * like `|`, `;` or `$()` are passed literally to the binary, not executed.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Confine a requested cwd to the workspace tree. Returns absolute dir. */
function resolveCwd(raw: string | undefined): string {
  const abs = resolve(WORKSPACE_ROOT, raw ?? '.');
  const rel = relative(WORKSPACE_ROOT, abs);
  if (rel === '..' || rel.startsWith(`..${'/'}`)) {
    throw new Error(`cwd must stay inside the workspace (${WORKSPACE_ROOT})`);
  }
  return abs;
}

function truncate(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_CHARS) return { text: output, truncated: false };
  const head = Math.ceil(MAX_OUTPUT_CHARS * 0.7);
  const tail = MAX_OUTPUT_CHARS - head;
  return {
    text:
      `${output.slice(0, head)}\n… [output truncated: ${(output.length - MAX_OUTPUT_CHARS).toLocaleString()} chars omitted] …\n` +
      output.slice(-tail),
    truncated: true,
  };
}

export async function handleExecRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/exec') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    ctx.json(res, 405, { error: 'POST /api/exec only' });
    return true;
  }

  const body = await ctx.readBody(req);
  const command = (body['command'] as string | undefined)?.trim();
  const actor = (body['actor'] as string | undefined) ?? 'human';
  if (!command) {
    ctx.json(res, 400, { error: 'command is required' });
    return true;
  }

  // 1) deny patterns on the raw command line
  for (const re of DENY_PATTERNS) {
    if (re.test(command)) {
      ctx.audit.record(actor, 'EXEC_DENIED', 'exec', command.slice(0, 80), {
        reason: `matched deny pattern ${re.source}`,
      });
      ctx.json(res, 403, {
        error: `command refused: blocked by the execution safety policy (${re.source})`,
      });
      return true;
    }
  }

  // 2) binary whitelist on the first token
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    ctx.json(res, 400, { error: 'command is required' });
    return true;
  }
  const binary = tokens[0] as string;
  if (!ALLOWED_BINARIES.has(binary)) {
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', command.slice(0, 80), {
      reason: `binary '${binary}' not in whitelist`,
    });
    ctx.json(res, 403, {
      error: `command refused: '${binary}' is not in the allowed command list (${[...ALLOWED_BINARIES].sort().join(', ')})`,
    });
    return true;
  }

  // 3) cwd confinement
  let cwd: string;
  try {
    cwd = resolveCwd(body['cwd'] as string | undefined);
  } catch (err) {
    ctx.json(res, 403, { error: (err as Error).message });
    return true;
  }

  // 4) execute with timeout; collect output, truncation at the end
  try {
    const { stdout, stderr } = await execFileAsync(binary, tokens.slice(1), {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    const { text, truncated } = truncate(stdout + (stderr ? `\n[stderr]\n${stderr}` : ''));
    ctx.audit.record(actor, 'EXEC_RUN', 'exec', command.slice(0, 80), { cwd, truncated });
    ctx.json(res, 200, { ok: true, command, cwd, output: text, truncated, exitCode: 0 });
    return true;
  } catch (err) {
    const e = err as {
      message?: string;
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    const out = `${e.stdout ?? ''}${e.stderr ? `\n[stderr]\n${e.stderr}` : ''}`;
    const timedOut = e.killed === true;
    const { text, truncated } = truncate(
      out.trim() || (timedOut ? `command timed out after ${TIMEOUT_MS / 1000}s` : (e.message ?? 'failed')),
    );
    ctx.audit.record(actor, timedOut ? 'EXEC_TIMEOUT' : 'EXEC_FAILED', 'exec', command.slice(0, 80), {
      cwd,
      code: e.code ?? null,
    });
    ctx.json(res, 200, {
      ok: false,
      command,
      cwd,
      output: text,
      truncated,
      exitCode: e.code ?? -1,
      timedOut,
    });
    return true;
  }
}
