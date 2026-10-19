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
 *  - OS sandbox (exec-sandbox.ts): when bwrap works on the host the
 *    command runs in a user-namespace sandbox (read-only /usr//opt,
 *    tmpfs /tmp, one writable bind = the cwd at its real path, fresh
 *    pid/ipc/uts namespaces, host network shared by default); when
 *    bwrap is unavailable the command runs directly as before and the
 *    run is marked `sandbox: 'none (fallback)'` in audit + response.
 *    The sandbox confines — it never permits; the policy above is
 *    unchanged.
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
import { PtyUnavailableError, runCommandPty, scrubCredentialEnv } from '@ai-factory/runtime';
import { SecretNotFoundError, redactSecretValues, redactSecretValuesCounted } from '@ai-factory/secrets';
import { recordRedactionHit } from '../redaction-monitor';
import { evaluateHooks } from '../hooks';
import {
  decideExecSandbox,
  execSandboxConfigFromEnv,
  type ExecSandboxDecision,
} from '../exec-sandbox';
import { NETWORK_OFFLINE_CODE, networkMode } from '../network-mode';

const execFileAsync = promisify(execFile);

/**
 * PostToolUse hooks (W-B): best-effort, never fatal. A hook failure is
 * audited but never changes the exec response — PostToolUse is an
 * observation point, not a gate (only PreToolUse vetoes).
 */
async function firePostToolUse(
  ctx: RouteContext,
  actor: string,
  payload: { command: string; cwd: string; exitCode: number; timedOut: boolean },
): Promise<void> {
  try {
    await evaluateHooks('PostToolUse', { tool: 'exec', actor, ...payload });
  } catch (e) {
    try {
      ctx.audit.record(actor, 'HOOK_POSTTOOLUSE_FAILED', 'exec', payload.command.slice(0, 80), {
        reason: (e as Error).message,
      });
    } catch {
      /* audit itself failed — nothing left to do */
    }
  }
}

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

/** Re-exported for the interactive terminal sessions (routes/terminal.ts). */
export const resolveExecCwd = resolveCwd;

/**
 * The execution safety policy as a reusable check (Batch 19): deny
 * patterns on the raw line + binary whitelist on the first token +
 * per-binary argv guards (W-C: node -e / npx fetch / git -c …).
 * Returns the tokenized argv. Throws ExecPolicyDenied (with `reason`)
 * when the line is refused — the SAME policy /api/exec enforces.
 *
 * opts.allowInlineEval: permit `node -e/--eval/-p/--print`. Only for
 * operator-configured commands (FACTORY_BUILD_COMMAND in the build
 * runner); human one-shots, agent tool calls and AI terminal lines
 * never get it — inline eval is unauditable arbitrary code execution.
 */
export class ExecPolicyDenied extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ExecPolicyDenied';
    this.reason = reason;
  }
}

export interface CheckCommandPolicyOptions {
  allowInlineEval?: boolean;
}

const NODE_INLINE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);

/** argv-level guards for binaries that are code executors themselves. */
function checkBinaryArgv(binary: string, tokens: string[], allowInlineEval: boolean): void {
  const args = tokens.slice(1);
  const deny = (reason: string, message: string): never => {
    throw new ExecPolicyDenied(reason, message);
  };
  if (binary === 'node') {
    if (!allowInlineEval && args.some((a) => NODE_INLINE_EVAL_FLAGS.has(a))) {
      deny(
        "node inline eval ('-e/--eval/-p/--print') is refused",
        "command refused: node inline eval is blocked by the execution safety policy " +
          "(write a script file and run `node <file>` instead)",
      );
    }
  }
  if (binary === 'npx') {
    // npx without --no-install/--offline fetches the package from the
    // registry and executes it: silent remote-code download+exec, the
    // same class curl/wget are denied for.
    if (!args.some((a) => a === '--no-install' || a === '--offline')) {
      deny(
        'npx may download and execute remote packages',
        'command refused: npx without --no-install/--offline may fetch remote code ' +
          '(re-run with --no-install to use only locally installed binaries)',
      );
    }
  }
  if (binary === 'git') {
    for (const a of args) {
      // -c/--config injects arbitrary git configuration: core.pager /
      // core.editor become command execution (CVE-class: `git -c
      // core.pager='evil' log`).
      if (a === '-c' || a === '--config') {
        deny(
          'git -c/--config is refused (config injection, e.g. core.pager)',
          'command refused: git -c/--config can inject executable configuration ' +
            '(core.pager/core.editor); set configuration through files instead',
        );
      }
      // --exec-path= redirects git to attacker-controlled subcommand binaries.
      if (a.startsWith('--exec-path=')) {
        deny(
          'git --exec-path= is refused (subcommand binary hijack)',
          'command refused: git --exec-path= redirects git to attacker-controlled binaries',
        );
      }
      // ext:: runs an arbitrary local command as the "remote".
      if (a.includes('ext::')) {
        deny(
          'git ext:: transport is refused (arbitrary command as remote)',
          'command refused: the git ext:: transport executes an arbitrary local command',
        );
      }
      if (a.includes('protocol.ext.allow')) {
        deny(
          'git protocol.ext.allow override is refused',
          'command refused: overriding protocol.ext.allow re-enables the ext:: transport',
        );
      }
    }
  }
}

export function checkCommandPolicy(command: string, opts?: CheckCommandPolicyOptions): string[] {
  for (const re of DENY_PATTERNS) {
    if (re.test(command)) {
      throw new ExecPolicyDenied(
        `matched deny pattern ${re.source}`,
        `command refused: blocked by the execution safety policy (${re.source})`,
      );
    }
  }
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    throw new ExecPolicyDenied('empty command', 'command is required');
  }
  const binary = tokens[0] as string;
  if (!ALLOWED_BINARIES.has(binary)) {
    throw new ExecPolicyDenied(
      `binary '${binary}' not in whitelist`,
      `command refused: '${binary}' is not in the allowed command list (${[...ALLOWED_BINARIES].sort().join(', ')})`,
    );
  }
  checkBinaryArgv(binary, tokens, opts?.allowInlineEval === true);
  return tokens;
}

/**
 * Shell-syntax-aware gate for interactive AI terminal lines (W-C).
 *
 * Background (H3-A2 probe, confirmed): the AI line gate used to run
 * the SAME checkCommandPolicy as /api/exec, but an interactive pty
 * runs a REAL shell (bash -i). checkCommandPolicy assumes no shell
 * interpretation, so `echo $(id)`, `echo a; id` and `echo x | evil`
 * all passed the gate while bash executed the smuggled commands —
 * a complete whitelist bypass for AI sessions.
 *
 * This gate closes it: it scans the raw line quote-aware and
 *   - denies command substitution / expansion outright: unquoted
 *     backtick, `$` (covers $(), ${}, $var), `<`, `>`, `(`, `)`,
 *     and single `&` (backgrounding);
 *   - splits pipelines/chains on unquoted `;`, `|`, `&&`, `||` and
 *     requires EVERY segment to pass checkCommandPolicy on its own
 *     (so `git log --oneline | head -5` still works, but neither
 *     side may smuggle anything the policy would refuse alone).
 * Quoted metacharacters are inert (`echo "a;b"` stays allowed).
 * Returns the per-segment token arrays for the control-dir check.
 */
export function checkAiShellLine(line: string): string[][] {
  const segments: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const denyShell = (what: string): never => {
    throw new ExecPolicyDenied(
      `shell syntax '${what}' is refused in AI terminal lines`,
      `command refused: shell metacharacter '${what}' is not allowed in AI terminal lines ` +
        `(no command substitution, expansion, redirection or backgrounding; ` +
        `use one whitelisted command per line, chain with ; | && ||)`,
    );
  };
  const pushSegment = (): void => {
    const s = cur.trim();
    cur = '';
    if (s) segments.push(s);
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (escaped) {
      cur += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      // A backslash inside the gate's view only escapes the next char
      // for scanning purposes; keep both so the segment text is intact.
      cur += ch;
      escaped = true;
      i++;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '`' || ch === '$' || ch === '<' || ch === '>' || ch === '(' || ch === ')') {
      denyShell(ch);
    }
    if (ch === '&') {
      if (line[i + 1] === '&') {
        pushSegment();
        i += 2;
        continue;
      }
      denyShell('&');
    }
    if (ch === '|') {
      pushSegment();
      // '||' is a chain operator; a lone '|' is a pipe — both split.
      i += line[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (ch === ';') {
      pushSegment();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  pushSegment();
  if (segments.length === 0) {
    throw new ExecPolicyDenied('empty command', 'command is required');
  }
  return segments.map((s) => checkCommandPolicy(s));
}

/**
 * §4.1 control-plane guard as a reusable check: true when the cwd or
 * any argument touches the control-plane data directory.
 */
export function commandHitsControlDir(cwd: string, tokens: string[]): boolean {
  const hitsForbidden = (p: string): boolean => {
    if (p.includes(CONTROL_DATA_DIR)) return true;
    const r = resolve(cwd, p);
    return r === CONTROL_DATA_DIR || r.startsWith(CONTROL_DATA_DIR + sep);
  };
  return hitsForbidden(cwd) || tokens.slice(1).some(hitsForbidden);
}

/** Structured error from secret-env resolution (HTTP-mappable). */
export class SecretEnvError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SecretEnvError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * §46.2 Secret Broker consumption as a reusable helper (Batch 19):
 * resolves { ENV_VAR: "secret-name" } in-process. Values go only into
 * the returned env map — never into logs or audit records. Throws
 * SecretEnvError carrying the HTTP status the caller should answer.
 */
export async function resolveSecretEnvRefs(
  secretEnv: unknown,
  ctx: RouteContext,
  actor: string,
  purpose: string,
): Promise<{ env: Record<string, string>; values: string[] }> {
  const injectedEnv: Record<string, string> = {};
  const injectedValues: string[] = [];
  if (secretEnv === undefined) return { env: injectedEnv, values: injectedValues };
  if (typeof secretEnv !== 'object' || secretEnv === null || Array.isArray(secretEnv)) {
    throw new SecretEnvError(400, 'BAD_SECRET_ENV', 'secretEnv must be an object mapping ENV_VAR -> secret name');
  }
  const entries = Object.entries(secretEnv as Record<string, unknown>);
  for (const [varName, ref] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) || typeof ref !== 'string' || !ref) {
      throw new SecretEnvError(
        400,
        'BAD_SECRET_ENV',
        `secretEnv entries must map a valid env var name to a secret name (bad entry: ${varName})`,
      );
    }
  }
  if (entries.length === 0) return { env: injectedEnv, values: injectedValues };
  if (!ctx.secretBroker) {
    throw new SecretEnvError(503, 'SECRET_BROKER_UNAVAILABLE', 'secret broker is not configured on this server');
  }
  for (const [varName, ref] of entries) {
    try {
      const value = await ctx.secretBroker.resolve(ref as string, { actor, purpose });
      injectedEnv[varName] = value;
      injectedValues.push(value);
    } catch (e) {
      if (e instanceof SecretNotFoundError) {
        throw new SecretEnvError(403, e.code, e.message, { ref: e.ref, envVar: varName });
      }
      throw new SecretEnvError(500, 'SECRET_BACKEND_ERROR', 'secret resolution failed', {
        error: (e as Error).name,
      });
    }
  }
  return { env: injectedEnv, values: injectedValues };
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

/**
 * Redact injected secret values from one exec output unit (Batch 42).
 * A hit (≥1 replacement) is recorded as a SECRET_REDACTED_HIT detection
 * event with the hit count and the command as source — never secret
 * content — and fed to the §81 'security-issue' aggregation (single
 * hits never escalate on their own).
 */
function redactExecOutput(
  raw: string,
  values: readonly string[],
  command: string,
  actor: string,
  ctx: RouteContext,
): string {
  const r = redactSecretValuesCounted(raw, values);
  if (r.hits > 0) {
    recordRedactionHit(ctx, actor, {
      source: command.slice(0, 80),
      sourceType: 'exec',
      hits: r.hits,
    });
  }
  return r.text;
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

  // §46.2 defense in depth (H4 audit): a secret pasted inline into the
  // command — instead of injected by reference via secretEnv — must not
  // reach the audit chain (viewer-readable, baked into DB backups) or
  // the echoed response in plaintext. The command still EXECUTES
  // verbatim (tokens come from `command` below); only the display/audit
  // copies use the redacted form. The same value set also redacts the
  // captured output below (one scan covers both). Redaction never breaks
  // execution: a broker failure degrades to the raw command and the
  // injection-scoped values rather than refusing the run.
  let displayCommand = command;
  let redactionValues: readonly string[] = [];
  if (ctx.secretBroker) {
    try {
      redactionValues = await ctx.secretBroker.knownValues({
        actor,
        purpose: 'exec redaction',
      });
      displayCommand = redactSecretValues(command, redactionValues);
    } catch {
      displayCommand = command;
      redactionValues = [];
    }
  }

  // §7.5 fail-closed: autonomous (non-human) shell execution requires a
  // verified isolation backend. This server runs commands on the host
  // directly, so no backend can prove confinement — refuse outright.
  // Human terminals are unaffected.
  if (actor !== 'human') {
    const report = new UnverifiedBackend().verifyConfinement();
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', displayCommand.slice(0, 80), {
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

  // 1)+2) the execution safety policy (deny patterns + whitelist),
  // shared with the interactive terminal sessions (Batch 19).
  let tokens: string[];
  try {
    tokens = checkCommandPolicy(command);
  } catch (err) {
    const denied = err as ExecPolicyDenied;
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', displayCommand.slice(0, 80), {
      reason: denied.reason,
    });
    ctx.json(res, 403, { error: denied.message });
    return true;
  }
  // 3) cwd confinement
  let cwd: string;
  try {
    cwd = resolveExecCwd(body['cwd'] as string | undefined);
  } catch (err) {
    ctx.json(res, 403, { error: (err as Error).message });
    return true;
  }

  // 3b) §4.1 — the control-plane data dir is off-limits: neither the cwd
  // nor any argument may resolve inside it (or even name it — catches
  // `node -e` DB reads, `cat data/factory.db`, absolute paths, etc.).
  if (commandHitsControlDir(cwd, tokens)) {
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', displayCommand.slice(0, 80), {
      reason: 'control-plane data directory is off-limits',
    });
    ctx.json(res, 403, {
      error: `command refused: the control-plane data directory (${CONTROL_DATA_DIR}) is off-limits`,
    });
    return true;
  }

  // 3c) Hooks (W-B) — PreToolUse deterministic checkpoint. Any enabled
  // PreToolUse hook may veto the call (non-zero exit or {"decision":"deny"}
  // verdict = deny; timeouts fail closed). A veto is audited and answered
  // 403 like the static policy gates above.
  try {
    const pre = await evaluateHooks('PreToolUse', {
      tool: 'exec',
      command: displayCommand,
      actor,
      cwd,
    });
    if (!pre.allowed) {
      ctx.audit.record(actor, 'EXEC_DENIED', 'exec', displayCommand.slice(0, 80), {
        reason: `PreToolUse hook veto (${pre.veto?.hookId})`,
        hookReason: pre.veto?.reason ?? '',
      });
      ctx.json(res, 403, {
        error: `denied by PreToolUse hook: ${pre.veto?.reason ?? 'hook veto'}`,
        code: 'HOOK_VETO',
        hookId: pre.veto?.hookId,
      });
      return true;
    }
  } catch (e) {
    // A broken hook registry must not silently disable the checkpoint —
    // fail closed.
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', displayCommand.slice(0, 80), {
      reason: `PreToolUse evaluation failed: ${(e as Error).message}`,
    });
    ctx.json(res, 500, { error: `PreToolUse hook evaluation failed: ${(e as Error).message}` });
    return true;
  }

  // 3d) §46.2 Secret Broker consumption: the caller may ask for
  // secrets to be injected into the child's environment by REFERENCE
  // ({ secretEnv: { ENV_VAR: "secret-name" } }). The broker resolves
  // each ref in-process; the value goes only into the child env —
  // never into the audit record, the response, or (via redaction of
  // the captured output below) the returned stdout/stderr. A missing
  // ref refuses the whole command with the broker's uniform
  // not-found error; nothing runs half-injected.
  let injectedEnv: Record<string, string> = {};
  let injectedValues: string[] = [];
  const secretEnv = body['secretEnv'];
  try {
    const resolved = await resolveSecretEnvRefs(secretEnv, ctx, actor, 'exec env injection');
    injectedEnv = resolved.env;
    injectedValues = resolved.values;
  } catch (err) {
    const se = err as SecretEnvError;
    if (se.status !== 400) {
      ctx.audit.record(actor, 'EXEC_DENIED', 'exec', displayCommand.slice(0, 80), {
        reason: se.code,
        ...se.detail,
      });
    }
    ctx.json(res, se.status, { error: se.message, code: se.code });
    return true;
  }

  // Output redaction covers every known value, not just this call's
  // injections: with credential env scrubbed from childEnv, the
  // remaining inline-paste risk is a value the command itself echoes
  // back — and the broker-wide set already includes the injected ones.
  const outputValues: readonly string[] =
    redactionValues.length > 0 ? redactionValues : injectedValues;

  // 3db) OS sandbox (exec-sandbox.ts): when bwrap works on the host the
  // command runs inside a user-namespace sandbox (read-only /usr//opt,
  // tmpfs /tmp, exactly one writable bind — the cwd at its real path,
  // fresh pid/ipc/uts namespaces). When bwrap is unavailable the
  // command runs directly as before, but the run is marked
  // `sandbox: 'none (fallback)'` with the probe's reason in the audit
  // record and the response — never a silent downgrade. The policy
  // above is unchanged: the sandbox confines, it never permits.
  //
  // Offline mode: force --unshare-net. And no fake offline — when bwrap
  // is unavailable (or disabled) there is no provable network isolation,
  // so the call is refused outright instead of running on the host.
  const offline = networkMode().isOffline();
  const sandboxCfg = execSandboxConfigFromEnv();
  if (offline) sandboxCfg.network = false;
  const sb: ExecSandboxDecision = await decideExecSandbox(cwd, sandboxCfg);
  if (offline && sb.mode !== 'bwrap') {
    const detail = sb.reason ? ` (${sb.reason})` : '';
    ctx.audit.record(actor, 'EXEC_DENIED', 'exec', displayCommand.slice(0, 80), {
      reason: NETWORK_OFFLINE_CODE,
      sandbox: sb.mode,
      ...(sb.reason ? { sandboxReason: sb.reason } : {}),
    });
    ctx.json(res, 403, {
      error:
        `${NETWORK_OFFLINE_CODE}: offline mode requires bwrap network isolation, ` +
        `but the sandbox is '${sb.mode}'${detail} — refusing to run unisolated`,
      code: NETWORK_OFFLINE_CODE,
    });
    return true;
  }
  const sandboxFields: Record<string, unknown> = {
    sandbox: sb.mode,
    ...(sb.reason ? { sandboxReason: sb.reason } : {}),
  };

  // 3e) opt-in real PTY (Batch 18) — identical policy, argv, secret
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
        argvPrefix: sb.prefix,
      });
      const { text, truncated } = truncate(
        redactExecOutput(r.stdout, outputValues, displayCommand, actor, ctx),
      );
      const isTruncated = truncated || r.truncated;
      if (r.timedOut) {
        ctx.audit.record(actor, 'EXEC_TIMEOUT', 'exec', displayCommand.slice(0, 80), {
          cwd,
          code: r.exitCode,
          pty: true,
          ...sandboxFields,
        });
      } else {
        ctx.audit.record(actor, 'EXEC_RUN', 'exec', displayCommand.slice(0, 80), {
          cwd,
          truncated: isTruncated,
          pty: true,
          ...sandboxFields,
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
        command: displayCommand,
        cwd,
        output: text,
        truncated: isTruncated,
        exitCode: r.exitCode ?? -1,
        timedOut: r.timedOut,
        pty: true,
        sandbox: sb.mode,
      });
      await firePostToolUse(ctx, actor, {
        command: displayCommand,
        cwd,
        exitCode: r.exitCode ?? -1,
        timedOut: r.timedOut,
      });
      return true;
    } catch (err) {
      if (err instanceof PtyUnavailableError) {
        ctx.audit.record(actor, 'EXEC_FAILED', 'exec', displayCommand.slice(0, 80), {
          reason: err.message,
          pty: true,
          ...sandboxFields,
        });
        ctx.json(res, 500, { error: err.message, code: err.code, sandbox: sb.mode });
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
    // Sandboxed when bwrap is available: the prefix ends in '--', so
    // this is still one execFile — same timeout, buffer and env
    // semantics; with an empty prefix the argv is byte-identical to
    // the pre-sandbox call.
    const argv = [...sb.prefix, ...tokens];
    const { stdout, stderr } = await execFileAsync(argv[0] as string, argv.slice(1), {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // §46.2 (H4): the child never inherits the server's own credential
      // env vars (FACTORY_API_TOKEN[S], FACTORY_SECRET_*) — secrets enter
      // only through explicit secretEnv injection, whose values the
      // output redaction below covers.
      env: { ...scrubCredentialEnv(process.env), ...injectedEnv },
    });
    const { text, truncated } = truncate(
      redactExecOutput(
        stdout + (stderr ? `\n[stderr]\n${stderr}` : ''),
        outputValues,
        displayCommand,
        actor,
        ctx,
      ),
    );
    ctx.audit.record(actor, 'EXEC_RUN', 'exec', displayCommand.slice(0, 80), {
      cwd,
      truncated,
      ...sandboxFields,
      ...(injectedValues.length
        ? {
            secretEnvVars: Object.keys(injectedEnv),
            secretRefs: Object.values(secretEnv as Record<string, unknown>),
          }
        : {}),
    });
    ctx.json(res, 200, { ok: true, command: displayCommand, cwd, output: text, truncated, exitCode: 0, sandbox: sb.mode });
    await firePostToolUse(ctx, actor, { command: displayCommand, cwd, exitCode: 0, timedOut: false });
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
      redactExecOutput(
        out.trim() || (timedOut ? `command timed out after ${TIMEOUT_MS / 1000}s` : (e.message ?? 'failed')),
        outputValues,
        displayCommand,
        actor,
        ctx,
      ),
    );
    ctx.audit.record(actor, timedOut ? 'EXEC_TIMEOUT' : 'EXEC_FAILED', 'exec', displayCommand.slice(0, 80), {
      cwd,
      code: e.code ?? null,
      ...sandboxFields,
    });
    ctx.json(res, 200, {
      ok: false,
      command: displayCommand,
      cwd,
      output: text,
      truncated,
      exitCode: e.code ?? -1,
      timedOut,
      sandbox: sb.mode,
    });
    await firePostToolUse(ctx, actor, {
      command: displayCommand,
      cwd,
      exitCode: e.code ?? -1,
      timedOut,
    });
    return true;
  }
}
