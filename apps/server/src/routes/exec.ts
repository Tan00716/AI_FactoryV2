/**
 * Exec routes — spec §64 (integrated terminal; controlled execution
 * infrastructure shared by agents and humans with distinct identities).
 *
 *  POST /api/exec  {command, cwd?, pty?} → run one command, return output.
 *
 * Safety model (one-shot execution; the SAME policy on both paths):
 *  - binary whitelist: only read-only / build-class commands may run
 *  - deny patterns: rm -rf /, curl/wget outbound, sudo, chmod, disk ops…
 *  - cwd is confined to the server workspace root (no path escape)
 *  - 30s timeout, output truncated to a fixed budget
 *
 * Execution device: by default the tokenized argv runs over pipes
 * (execFile, stdout/stderr apart). With `pty: true` the SAME argv —
 * same whitelist, same argv semantics, no shell interpretation added —
 * runs on a real pseudo-terminal instead (@ai-factory/runtime's
 * runCommandPty, Batch 18): the command sees a terminal (isatty,
 * colors), and stdout/stderr arrive as one merged stream. This is a
 * one-shot run on a PTY, not an interactive session: no stdin is
 * forwarded and the size is the backend default (80×24).
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleExecRoutes } from './routes/exec';
 *   if (await handleExecRoutes(req, res, url, ctx)) return;
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname, relative, resolve, sep } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import { UnverifiedBackend } from '@ai-factory/security';
import { PtyUnavailableError, runCommandPty } from '@ai-factory/runtime';
import { SecretNotFoundError, redactSecretValues } from '@ai-factory/secrets';

const execFileAsync = promisify(execFile);

/**
 * Workspace root — the ai-factory project root (the server is started from
 * it). All execution is confined to this tree.
 */
const WORKSPACE_ROOT = resolve(process.cwd());

/**
 * SPEC §4.1 — control-plane data directory. The control DB lives here
 * (same default as index.ts: DB_PATH ?? './data/factory.db'); agents must
 * never read or write it, even through `node -e`. Human terminals are only
 * barred from this one directory — everything else keeps working.
 */
const CONTROL_DATA_DIR = dirname(resolve(process.env.DB_PATH ?? './data/factory.db'));

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

  // §7.5 fail-closed: autonomous (non-human) shell execution requires a
  // verified isolation backend. This server runs commands on the host
  // directly, so no backend can prove confinement — refuse outright.
  // Human terminals are unaffected.
  if (actor !== 'human') {
    const report = new UnverifiedBackend().verifyConfinement();
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', command.slice(0, 80), {
      reason: 'CONFINEMENT_UNAVAILABLE',
    });
    ctx.json(res, 403, {
      error:
        `CONFINEMENT_UNAVAILABLE: autonomous shell execution requires a verified ` +
        `isolation backend (backend '${report.backend}' cannot prove confinement)`,
      code: 'CONFINEMENT_UNAVAILABLE',
    });
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

  // 3b) §4.1 — the control-plane data dir is off-limits: neither the cwd
  // nor any argument may resolve inside it (or even name it — catches
  // `node -e` DB reads, `cat data/factory.db`, absolute paths, etc.).
  const hitsForbidden = (p: string): boolean => {
    if (p.includes(CONTROL_DATA_DIR)) return true;
    const r = resolve(cwd, p);
    return r === CONTROL_DATA_DIR || r.startsWith(CONTROL_DATA_DIR + sep);
  };
  if (hitsForbidden(cwd) || tokens.slice(1).some(hitsForbidden)) {
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', command.slice(0, 80), {
      reason: 'control-plane data directory is off-limits',
    });
    ctx.json(res, 403, {
      error: `command refused: the control-plane data directory (${CONTROL_DATA_DIR}) is off-limits`,
    });
    return true;
  }

  // 3c) §46.2 Secret Broker consumption: the caller may ask for
  // secrets to be injected into the child's environment by REFERENCE
  // ({ secretEnv: { ENV_VAR: "secret-name" } }). The broker resolves
  // each ref in-process; the value goes only into the child env —
  // never into the audit record, the response, or (via redaction of
  // the captured output below) the returned stdout/stderr. A missing
  // ref refuses the whole command with the broker's uniform
  // not-found error; nothing runs half-injected.
  const injectedEnv: Record<string, string> = {};
  const injectedValues: string[] = [];
  const secretEnv = body['secretEnv'];
  if (secretEnv !== undefined) {
    if (typeof secretEnv !== 'object' || secretEnv === null || Array.isArray(secretEnv)) {
      ctx.json(res, 400, { error: 'secretEnv must be an object mapping ENV_VAR -> secret name' });
      return true;
    }
    const entries = Object.entries(secretEnv as Record<string, unknown>);
    for (const [varName, ref] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) || typeof ref !== 'string' || !ref) {
        ctx.json(res, 400, {
          error: `secretEnv entries must map a valid env var name to a secret name (bad entry: ${varName})`,
        });
        return true;
      }
    }
    if (entries.length > 0) {
      if (!ctx.secretBroker) {
        ctx.audit.record(actor, 'EXEC_DENIED', 'exec', command.slice(0, 80), {
          reason: 'SECRET_BROKER_UNAVAILABLE',
        });
        ctx.json(res, 503, {
          error: 'secret broker is not configured on this server',
          code: 'SECRET_BROKER_UNAVAILABLE',
        });
        return true;
      }
      for (const [varName, ref] of entries) {
        try {
          const value = await ctx.secretBroker.resolve(ref as string, {
            actor,
            purpose: 'exec env injection',
          });
          injectedEnv[varName] = value;
          injectedValues.push(value);
        } catch (e) {
          if (e instanceof SecretNotFoundError) {
            ctx.audit.record(actor, 'EXEC_DENIED', 'exec', command.slice(0, 80), {
              reason: 'SECRET_NOT_FOUND',
              ref: e.ref,
              envVar: varName,
            });
            ctx.json(res, 403, { error: e.message, code: e.code });
            return true;
          }
          ctx.audit.record(actor, 'EXEC_DENIED', 'exec', command.slice(0, 80), {
            reason: 'SECRET_BACKEND_ERROR',
            error: (e as Error).name,
          });
          ctx.json(res, 500, { error: 'secret resolution failed', code: 'SECRET_BACKEND_ERROR' });
          return true;
        }
      }
    }
  }

  // 3d) opt-in real PTY (Batch 18) — identical policy, argv, secret
  // injection and output redaction as the pipe path below; only the
  // device differs. The merged terminal stream is the output (there
  // is no separate stderr), redacted with the same injected values
  // before truncation (§46.2 applies to every execution path).
  if (body['pty'] === true) {
    try {
      const r = await runCommandPty(tokens, {
        cwd,
        env: injectedEnv,
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024,
      });
      const { text, truncated } = truncate(redactSecretValues(r.stdout, injectedValues));
      const isTruncated = truncated || r.truncated;
      if (r.timedOut) {
        ctx.audit.record(actor, 'EXEC_TIMEOUT', 'exec', command.slice(0, 80), {
          cwd,
          code: r.exitCode,
          pty: true,
        });
      } else {
        ctx.audit.record(actor, 'EXEC_RUN', 'exec', command.slice(0, 80), {
          cwd,
          truncated: isTruncated,
          pty: true,
          ...(injectedValues.length
            ? {
                secretEnvVars: Object.keys(injectedEnv),
                secretRefs: Object.values(secretEnv as Record<string, unknown>),
              }
            : {}),
        });
      }
      ctx.json(res, 200, {
        ok: r.exitCode === 0 && !r.timedOut,
        command,
        cwd,
        output: text,
        truncated: isTruncated,
        exitCode: r.exitCode ?? -1,
        timedOut: r.timedOut,
        pty: true,
      });
      return true;
    } catch (err) {
      if (err instanceof PtyUnavailableError) {
        ctx.audit.record(actor, 'EXEC_FAILED', 'exec', command.slice(0, 80), {
          reason: err.message,
          pty: true,
        });
        ctx.json(res, 500, { error: err.message, code: err.code });
        return true;
      }
      throw err;
    }
  }

  // 4) execute with timeout; collect output, truncation at the end.
  // Injected secret values are redacted from whatever the command
  // printed before the output is truncated or returned (§46.2:
  // stdout/stderr 统一脱敏).
  try {
    const { stdout, stderr } = await execFileAsync(binary, tokens.slice(1), {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...injectedEnv },
    });
    const { text, truncated } = truncate(
      redactSecretValues(stdout + (stderr ? `\n[stderr]\n${stderr}` : ''), injectedValues),
    );
    ctx.audit.record(actor, 'EXEC_RUN', 'exec', command.slice(0, 80), {
      cwd,
      truncated,
      ...(injectedValues.length
        ? {
            secretEnvVars: Object.keys(injectedEnv),
            secretRefs: Object.values(secretEnv as Record<string, unknown>),
          }
        : {}),
    });
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
      redactSecretValues(
        out.trim() || (timedOut ? `command timed out after ${TIMEOUT_MS / 1000}s` : (e.message ?? 'failed')),
        injectedValues,
      ),
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
