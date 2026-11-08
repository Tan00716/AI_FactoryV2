/**
 * Interactive terminal sessions — spec §50.1 (终端 xterm.js + 受控
 * PTY, Human 与 AI 独立 Session/Principal).
 *
 *   POST   /api/terminal/sessions            create a session
 *   GET    /api/terminal/sessions            list live sessions (+archive)
 *   GET    /api/terminal/sessions/:id/stream  SSE: terminal output stream
 *     (output events carry base64 frames: {"b64": "<base64 utf-8 text>"};
 *     'denied' and 'close' events carry plain JSON payloads)
 *   POST   /api/terminal/sessions/:id/input  write to the session's stdin
 *   POST   /api/terminal/sessions/:id/resize  live resize (SIGWINCH)
 *   DELETE /api/terminal/sessions/:id         close (whole-tree kill)
 *
 * Auth/RBAC follow the global gate (auth.ts): reads are viewer, writes
 * are operator. Principal isolation is structural — sessions are
 * separate PtySession objects with separate streams; nothing moves
 * bytes between principals.
 *
 * AI sessions: unlike POST /api/exec (which refuses actor != 'human'
 * outright per §7.5), interactive AI sessions are ALLOWED but their
 * input is LINE-GATED — every newline-terminated line must pass the
 * same safety policy /api/exec enforces (deny patterns + binary
 * whitelist + control-dir guard) before it reaches the pty. Denied
 * lines are dropped and reported (audit AI_LINE_DENIED + SSE 'denied'
 * event). This is a deliberate, documented difference from /api/exec:
 * §50.1 requires AI sessions to exist, so the gate — not a blanket
 * refusal — is the mechanism. The per-line approximation is stated in
 * the runtime module and in KNOWN_LIMITATIONS.
 *
 * OS sandbox tiers: the session shell spawns inside the bwrap sandbox
 * from exec-sandbox.ts for read-only / workspace-write (fail-closed
 * when bwrap is unavailable — the session is refused, never run
 * unisolated); danger-full-access runs directly by design but needs
 * the project allowDanger config plus a per-run human approval.
 *
 * Streaming transport: SSE over plain node:http (the repo is zero-dep;
 * no WebSocket library). The desktop reads it with fetch + a manual
 * frame parser so the Authorization header keeps working (EventSource
 * cannot send headers).
 *
 * Sessions are process-local: a restart drops them; closed sessions
 * leave a bounded archive record, not a resumable terminal. Idle
 * sessions (>30 min) are reaped on create/list. (The merge queue and
 * PrStore were process-local too, until Batch 20 made them durable —
 * sessions have no such backing yet.)
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleTerminalRoutes } from './routes/terminal';
 *   if (await handleTerminalRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { join, resolve } from 'node:path';
import type { RouteContext } from './context';
import {
  PtySessionManager,
  PtySessionUnavailableError,
  PtySessionError,
  redactAmbientCredentialValues,
  type PtySession,
} from '@ai-factory/runtime';
import {
  CommandTracker,
  HistoryStore,
  INTEGRATION_ENV_VAR,
  bashIntegrationWrapper,
  generateBashIntegrationRc,
} from '@ai-factory/termhistory';
import {
  redactCredentialAssignments,
  redactText,
  stripUserinfoFromText,
} from '@ai-factory/diagpack';
import {
  createCrossChunkRedactor,
  type CrossChunkRedactor,
} from '@ai-factory/secrets';
import { recordRedactionHit } from '../redaction-monitor';
import {
  checkAiShellLine,
  commandHitsControlDir,
  resolveExecCwd,
  resolveSecretEnvRefs,
  ExecPolicyDenied,
  SecretEnvError,
} from './exec';
import {
  decideExecSandbox,
  execSandboxConfigFromEnv,
  type ExecSandboxDecision,
} from '../exec-sandbox';
import {
  DANGER_APPROVAL_REQUIRED_CODE,
  SANDBOX_UNAVAILABLE_CODE,
  checkDangerExec,
  resolveSandboxMode,
} from '../sandbox-modes';
import { ApprovalManager } from '@ai-factory/approvals';
import { NETWORK_OFFLINE_CODE, networkMode } from '../network-mode';

const manager = new PtySessionManager({ maxSessions: 16, archiveDepth: 50 });

/**
 * 协同只读终端流（第三波任务⑩）：暴露同一 manager 实例，collab 只订阅
 * onOutput（只读），永远不写 stdin。session 的 createStreamRedactor
 * hook（创建时安装）保证与 SSE 流同一脱敏。
 */
export function terminalSessionManager(): PtySessionManager {
  return manager;
}
const IDLE_REAP_MS = 30 * 60 * 1000;
const MAX_INPUT_BYTES = 64 * 1024;

/**
 * R4-A8 shell integration: per-session OSC 133 command trackers (bash
 * sessions only) + one persistent cross-session history store.
 *
 * The store lives under <AI_FACTORY_DATA_DIR>/terminal-history — the
 * user's data dir, never the repo. History writes are best-effort: a
 * broken store degrades to in-memory/no history, it never breaks a
 * live terminal session.
 */
const commandTrackers = new Map<string, CommandTracker>();
let historyStore: HistoryStore | null = null;
let historyBroken = false;
function terminalHistoryStore(): HistoryStore | null {
  if (historyBroken) return null;
  if (!historyStore) {
    try {
      const dataDir = resolve(process.env.AI_FACTORY_DATA_DIR ?? 'data');
      historyStore = new HistoryStore(join(dataDir, 'terminal-history'));
    } catch {
      historyBroken = true;
      return null;
    }
  }
  return historyStore;
}

/**
 * R20 #6(v) N5/N6: desensitize terminal text (a denied AI line, its
 * policy reason, a history entry, a tracked command) with the (r)
 * four-layer composition (strip -> redactText -> value-aware ambient ->
 * credential-assignment), the same composition as routes/projects.ts
 * clean(). Exported so the R20 regression test can drive the exact
 * function wired into the AI_LINE_DENIED record() entry and the two
 * read endpoints below. Idempotent; benign text passes through
 * unchanged.
 */
export function cleanTerminalText(s: string): string {
  return redactCredentialAssignments(
    redactAmbientCredentialValues(redactText(stripUserinfoFromText(s))),
  );
}

/** True for the default interactive bash invocation (integration-safe). */
function isIntegrableBashShell(shell: string[]): boolean {
  return (
    /bash$/.test(shell[0] ?? '') &&
    (shell.length === 1 || (shell.length === 2 && shell[1] === '-i'))
  );
}

/** Shells a session may launch (server-configured, not user-typed). */
const ALLOWED_SESSION_SHELLS = new Set(['/bin/bash', '/bin/sh', '/usr/bin/bash']);

/**
 * Per-SSE-stream redactor (Batch 48): wraps a CrossChunkRedactor and
 * reports every hit batch through `onHit`. Exported as the test seam
 * for the terminal wiring — the cross-chunk algorithm itself is unit
 * tested in @ai-factory/secrets.
 */
export interface TerminalStreamRedactor {
  /** Feed one raw chunk; returns redacted text safe to emit now. */
  push(chunk: string): string;
  /** Commit and return the held tail; call once at stream end. */
  flush(): string;
}

export function createTerminalStreamRedactor(
  secretValues: readonly string[],
  onHit: (hits: number) => void,
): TerminalStreamRedactor {
  const inner: CrossChunkRedactor = createCrossChunkRedactor(secretValues);
  const emit = (r: { text: string; hits: number }): string => {
    if (r.hits > 0) onHit(r.hits);
    return r.text;
  };
  return {
    push: (chunk: string) => emit(inner.push(chunk)),
    flush: () => emit(inner.flush()),
  };
}

function sessionIdFrom(url: URL): { id: string; rest: string } | null {
  const m = /^\/api\/terminal\/sessions\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), rest: m[2] ?? '' };
}

function getSessionOr404(ctx: RouteContext, res: ServerResponse, id: string): PtySession | null {
  try {
    return manager.get(id);
  } catch {
    ctx.json(res, 404, { error: `unknown terminal session: ${id}`, code: 'SESSION_NOT_FOUND' });
    return null;
  }
}

/** The AI line gate: the shell-syntax-aware policy (W-C), applied per input line. */
function aiLineGate(cwd: string): (line: string) => void {
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return; // blank lines pass through
    let segments: string[][];
    try {
      // checkAiShellLine: denies unquoted shell metacharacters
      // ($, backtick, redirects, backgrounding) and requires every
      // ;- / |- / &&- / ||-separated segment to pass the command
      // policy on its own — a real shell interprets the line, so the
      // gate must too (H3-A2: `echo $(id)` used to sail through).
      segments = checkAiShellLine(trimmed);
    } catch (err) {
      throw new Error((err as ExecPolicyDenied).message);
    }
    for (const tokens of segments) {
      if (commandHitsControlDir(cwd, tokens)) {
        throw new Error('command refused: the control-plane data directory is off-limits');
      }
    }
  };
}

export async function handleTerminalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // ---- create ---------------------------------------------------------
  if (path === '/api/terminal/sessions' && method === 'POST') {
    const body = await ctx.readBody(req);
    const principal = body['principal'] === 'ai' ? 'ai' : 'human';
    const actor = (body['actor'] as string | undefined) ?? principal;

    let cwd: string;
    try {
      cwd = resolveExecCwd(body['cwd'] as string | undefined);
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }

    // Shell selection is server-configured: only known shells, no
    // user-typed command lines.
    let shell = ['/bin/bash', '-i'];
    const rawShell = body['shell'];
    if (rawShell !== undefined) {
      if (!Array.isArray(rawShell) || rawShell.length === 0 || rawShell.some((a) => typeof a !== 'string')) {
        ctx.json(res, 400, { error: 'shell must be a non-empty string array' });
        return true;
      }
      if (!ALLOWED_SESSION_SHELLS.has(rawShell[0] as string)) {
        ctx.json(res, 403, {
          error: `session shell refused: '${rawShell[0]}' is not an allowed session shell`,
        });
        return true;
      }
      shell = rawShell as string[];
    }

    // R4-A8 shell integration: bash sessions are wrapped so the shell
    // emits OSC 133 command markers (A/B/C/D/E/H — see
    // @ai-factory/termhistory). The integration script travels in an env
    // var and is materialized to /tmp inside the session: env survives
    // bwrap (which only binds /usr, /opt and the cwd), file paths do
    // not. /bin/sh has no equivalent hook — those sessions simply get
    // no command history (reported as integrated:false).
    let shellIntegration = false;
    if (isIntegrableBashShell(shell)) {
      const bashPath = shell[0];
      shell = bashIntegrationWrapper(bashPath);
      shellIntegration = true;
    }

    let secretEnv: Record<string, string> = {};
    let secretValues: string[] = [];
    try {
      const resolved = await resolveSecretEnvRefs(body['secretEnv'], ctx, actor, 'terminal session env');
      secretEnv = resolved.env;
      secretValues = resolved.values;
    } catch (err) {
      const se = err as SecretEnvError;
      if (se.status !== 400) {
        ctx.audit.record(actor, 'SESSION_DENIED', 'terminal', '(session create)', {
          reason: se.code,
          ...se.detail,
        });
      }
      ctx.json(res, se.status, { error: se.message, code: se.code });
      return true;
    }

    await manager.sweepIdle(IDLE_REAP_MS).catch(() => undefined);
    // OS sandbox tiers (exec-sandbox.ts + sandbox-modes.ts): the session
    // shell spawns inside the bwrap sandbox for read-only /
    // workspace-write (fail-closed when bwrap is unavailable — the
    // session is refused, never run unisolated); danger-full-access
    // runs directly BY DESIGN but requires the project allowDanger
    // config plus a per-run human approval (ApprovalManager).
    //
    // Offline mode: force --unshare-net; without a real bwrap prefix
    // there is no provable network isolation, so the session is
    // refused outright — no fake offline.
    const offline = networkMode().isOffline();
    const resolved = resolveSandboxMode(cwd);
    const effMode = resolved.mode;
    let sb: ExecSandboxDecision;
    if (effMode === 'danger-full-access') {
      const dangerManager = new ApprovalManager(ctx.fdb.approvals, {
        audit: (action, entityId, details) =>
          ctx.audit.record('danger-gate', action, 'approval', entityId, details),
      });
      const gate = checkDangerExec({
        manager: dangerManager,
        actor,
        command: `terminal session (${shell})`,
        allowDanger: resolved.allowDanger,
        approvalPolicy: resolved.approvalPolicy,
        dangerApprovalId:
          typeof body['dangerApprovalId'] === 'string' ? body['dangerApprovalId'] : undefined,
      });
      if (!gate.ok) {
        const auditAction =
          gate.code === DANGER_APPROVAL_REQUIRED_CODE ? 'DANGER_APPROVAL_REQUESTED' : 'SESSION_DENIED';
        ctx.audit.record(actor, auditAction, 'terminal', '(session create)', {
          reason: gate.code,
          sandbox: 'danger-full-access',
          ...(gate.approvalId ? { approvalId: gate.approvalId } : {}),
        });
        ctx.json(res, 403, {
          error: gate.message,
          code: gate.code,
          ...(gate.approvalId ? { approvalId: gate.approvalId } : {}),
          ...(gate.candidateDigest ? { candidateDigest: gate.candidateDigest } : {}),
        });
        return true;
      }
      ctx.audit.record(actor, 'DANGER_EXEC_CONSUMED', 'terminal', '(session create)', {
        approvalId: gate.approvalId,
        sandbox: 'danger-full-access',
      });
      sb = {
        mode: 'danger-full-access',
        prefix: [],
        reason: null,
        sandboxed: false,
        refused: false,
        refuseCode: null,
      };
    } else {
      const sandboxCfg = execSandboxConfigFromEnv();
      sandboxCfg.mode = effMode;
      if (offline) sandboxCfg.network = false;
      sb = await decideExecSandbox(cwd, sandboxCfg);
    }
    // Refusal precedence: offline mode's NETWORK_OFFLINE first (it
    // names the operator's own intent); SANDBOX_UNAVAILABLE when
    // online. Both fail closed — never create the session unisolated.
    if (offline && !sb.sandboxed) {
      const detail = sb.reason ? ` (${sb.reason})` : '';
      ctx.audit.record(actor, 'SESSION_DENIED', 'terminal', '(session create)', {
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
    if (sb.refused) {
      const detail = sb.reason ? ` (${sb.reason})` : '';
      ctx.audit.record(actor, 'SESSION_DENIED', 'terminal', '(session create)', {
        reason: sb.refuseCode,
        sandbox: sb.mode,
        sandboxReason: sb.reason,
      });
      ctx.json(res, 403, {
        error:
          `${sb.refuseCode}: tier '${sb.mode}' requires OS-enforced isolation (bwrap), ` +
          `but no working bwrap was found${detail} — refusing to create the session unisolated`,
        code: sb.refuseCode,
        sandbox: sb.mode,
      });
      return true;
    }
    let session: PtySession;
    try {
      session = manager.create({
        principal,
        shell,
        cwd,
        env: shellIntegration
          ? { ...secretEnv, [INTEGRATION_ENV_VAR]: generateBashIntegrationRc() }
          : secretEnv,
        rows: body['rows'] as number | undefined,
        cols: body['cols'] as number | undefined,
        argvPrefix: sb.prefix,
        ...(principal === 'ai' ? { aiLinePolicy: aiLineGate(cwd) } : {}),
      });
    } catch (err) {
      if (err instanceof PtySessionUnavailableError) {
        ctx.json(res, 500, { error: err.message, code: err.code });
        return true;
      }
      if (err instanceof PtySessionError) {
        ctx.json(res, 429, { error: err.message, code: err.code });
        return true;
      }
      throw err;
    }

    // Secret redaction (§50.1 输入 Secret 脱敏): injected values are
    // scrubbed from the streamed/transcript output. Cross-chunk safe
    // (Batch 48): each SSE stream gets its own CrossChunkRedactor,
    // which holds back the last (longestSecret-1) code points so a
    // value split across chunk boundaries is still caught BEFORE any
    // of its bytes are emitted. The holdback delays tail bytes until
    // more output arrives or the stream closes (flush) — the honest
    // price of not leaking; the backlog/live-chunk boundary is covered
    // too because the backlog goes through the same redactor instance.
    // A hit (≥1 replacement in a push/flush) is a SECRET_REDACTED_HIT
    // detection event (Batch 42) — hit count + session id, never secret
    // content — feeding the §81 'security-issue' aggregation.
    (
      session as PtySession & {
        createStreamRedactor?: (hitCtx: RouteContext) => TerminalStreamRedactor;
      }
    ).createStreamRedactor = (hitCtx: RouteContext) =>
      createTerminalStreamRedactor(secretValues, (hits) =>
        recordRedactionHit(hitCtx, actor, {
          source: session.id,
          sourceType: 'terminal',
          hits,
        }),
      );

    // AI line denials are audited. The refused line is redacted
    // against known secret values first (H4 audit), then with the (r)
    // four-layer composition inside record() below: the broker layer is
    // value-aware-only, so an operator-pasted marker would otherwise
    // survive it, and with no broker it never runs. The policy reason
    // gets the same treatment — a whitelist refusal embeds the line's
    // first token. (An earlier comment here claimed "values never";
    // that was wrong: the old code was value-aware-only, not
    // values-never.) Redact-then-slice: slicing first could leave a
    // partial secret visible.
    session.onDenied(({ line, reason }) => {
      const record = (safeLine: string) =>
        ctx.audit.record(actor, 'AI_LINE_DENIED', 'terminal', session.id, {
          principal,
          line: cleanTerminalText(safeLine).slice(0, 120),
          reason: cleanTerminalText(reason),
        });
      if (ctx.secretBroker) {
        ctx.secretBroker
          .redactKnownValues(line, { actor, purpose: 'terminal denied line audit' })
          .then(record, () => record(line));
      } else {
        record(line);
      }
    });

    ctx.audit.record(actor, 'SESSION_CREATE', 'terminal', session.id, {
      principal,
      rows: session.rows,
      cols: session.cols,
      cwd,
      shell: shell.join(' '),
      sandbox: sb.mode,
      ...(sb.reason ? { sandboxReason: sb.reason } : {}),
      ...(secretValues.length > 0 ? { secretEnvVars: Object.keys(secretEnv) } : {}),
      ...(shellIntegration ? { shellIntegration: true } : {}),
    });

    // R4-A8: attach the command tracker. The shell reports its own
    // command lines via 133;H, so no input sniffing is needed — output
    // markers only. Completed commands persist to the history store
    // (best-effort; failures never break the session).
    if (shellIntegration) {
      const tracker = new CommandTracker();
      tracker.onCommand((cmd) => {
        try {
          terminalHistoryStore()?.append({
            sessionId: session.id,
            principal,
            command: cmd.command,
            exitCode: cmd.exitCode,
            at: cmd.at,
          });
        } catch {
          /* history is best-effort */
        }
      });
      session.onOutput((chunk) => {
        try {
          tracker.feedOutput(chunk.toString('utf8'));
        } catch {
          /* ignore */
        }
      });
      commandTrackers.set(session.id, tracker);
      session.onClose(() => {
        commandTrackers.delete(session.id);
      });
    }

    ctx.json(res, 201, { ...session.toRecord(), cwd, sandbox: sb.mode });
    return true;
  }

  // ---- list -----------------------------------------------------------
  if (path === '/api/terminal/sessions' && method === 'GET') {
    await manager.sweepIdle(IDLE_REAP_MS).catch(() => undefined);
    const includeClosed = url.searchParams.get('includeClosed') === '1';
    ctx.json(res, 200, {
      sessions: manager.list(),
      ...(includeClosed ? { closed: manager.closedSessions() } : {}),
    });
    return true;
  }

  // ---- command history (R4-A8) ---------------------------------------
  // GET /api/terminal/history?q=&limit=&principal= — fuzzy search over the
  // persistent cross-session command history (viewer).
  if (path === '/api/terminal/history' && method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
    const principal = url.searchParams.get('principal');
    const store = terminalHistoryStore();
    let entries = store ? (q ? store.search(q, 1000) : store.recent(1000)) : [];
    if (principal === 'human' || principal === 'ai') {
      entries = entries.filter((e) => e.principal === principal);
    }
    // R20 #6(v) N6: read-time desensitization — entries written before
    // the append-entry fix still carry verbatim text on disk, so clean
    // on the way out (the N7 read-time-strip precedent). Copies, never
    // in place: the store's in-memory entries must not be rewritten.
    const cleaned = entries
      .slice(0, limit)
      .map((e) => ({ ...e, command: cleanTerminalText(e.command) }));
    ctx.json(res, 200, { entries: cleaned, total: store?.count ?? 0 });
    return true;
  }

  // ---- per-session ----------------------------------------------------
  const parsed = sessionIdFrom(url);
  if (!parsed) return false;
  const { id, rest } = parsed;

  // SSE output stream
  if (rest === '/stream' && method === 'GET') {
    const session = getSessionOr404(ctx, res, id);
    if (!session) return true;
    // One cross-chunk redactor per stream subscription: the backlog and
    // the live chunks share it, so the backlog/live boundary is covered
    // too. Sessions created before Batch 48 have no factory (in-memory
    // only — sessions never survive a restart) and degrade to identity.
    const factory = (
      session as PtySession & {
        createStreamRedactor?: (hitCtx: RouteContext) => TerminalStreamRedactor;
      }
    ).createStreamRedactor;
    const streamRedactor: TerminalStreamRedactor = factory
      ? factory(ctx)
      : { push: (s: string) => s, flush: () => '' };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (event: string, payload: string): boolean => {
      try {
        res.write(`event: ${event}\ndata: ${payload}\n\n`);
        return true;
      } catch {
        return false;
      }
    };
    const sendOutput = (text: string): boolean => {
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      return send('output', JSON.stringify({ b64 }));
    };

    res.write(': connected\n\n');
    const backlog = session.transcriptText();
    if (backlog) sendOutput(streamRedactor.push(backlog));

    const unsubOutput = session.onOutput((chunk) => {
      const out = streamRedactor.push(chunk.toString('utf8'));
      // '' means the whole chunk is held in the cross-chunk carry —
      // nothing safe to emit yet, and not a write failure.
      if (out === '') return;
      if (!sendOutput(out)) {
        cleanup();
      }
    });
    const unsubDenied = session.onDenied(({ line, reason }) => {
      send('denied', JSON.stringify({ line: line.slice(0, 200), reason }));
    });
    const unsubClose = session.onClose((exit) => {
      // Flush the held tail BEFORE the close event: output must precede it.
      const tail = streamRedactor.flush();
      if (tail !== '') sendOutput(tail);
      send('close', JSON.stringify(exit));
      cleanup(true);
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 20_000);
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === 'function') {
      (heartbeat as unknown as { unref: () => void }).unref();
    }

    let cleaned = false;
    const cleanup = (ended = false): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubOutput();
      unsubDenied();
      unsubClose();
      if (!ended) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    };
    req.on('close', () => cleanup());
    // If the session already died before we subscribed, report it.
    if (!session.alive && session.exit) {
      const tail = streamRedactor.flush();
      if (tail !== '') sendOutput(tail);
      send('close', JSON.stringify(session.exit));
      cleanup(true);
    }
    return true;
  }

  // stdin write
  if (rest === '/input' && method === 'POST') {
    const session = getSessionOr404(ctx, res, id);
    if (!session) return true;
    const body = await ctx.readBody(req);
    const data = body['data'];
    if (typeof data !== 'string') {
      ctx.json(res, 400, { error: 'data must be a string' });
      return true;
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
      ctx.json(res, 413, { error: `input exceeds ${MAX_INPUT_BYTES} bytes` });
      return true;
    }
    try {
      session.write(data);
    } catch (err) {
      ctx.json(res, 410, { error: (err as Error).message, code: 'SESSION_CLOSED' });
      return true;
    }
    ctx.audit.record('terminal', 'SESSION_INPUT', 'terminal', id, {
      bytes: Buffer.byteLength(data, 'utf8'),
    });
    ctx.json(res, 200, { ok: true });
    return true;
  }

  // resize
  if (rest === '/resize' && method === 'POST') {
    const session = getSessionOr404(ctx, res, id);
    if (!session) return true;
    const body = await ctx.readBody(req);
    const rows = body['rows'] as number | undefined;
    const cols = body['cols'] as number | undefined;
    if (rows === undefined && cols === undefined) {
      ctx.json(res, 400, { error: 'rows and/or cols are required' });
      return true;
    }
    try {
      session.resize(rows ?? session.rows, cols ?? session.cols);
    } catch (err) {
      ctx.json(res, 410, { error: (err as Error).message, code: 'SESSION_CLOSED' });
      return true;
    }
    ctx.audit.record('terminal', 'SESSION_RESIZE', 'terminal', id, {
      rows: session.rows,
      cols: session.cols,
    });
    ctx.json(res, 200, { ok: true, rows: session.rows, cols: session.cols });
    return true;
  }

  // session command list (R4-A8): in-memory per-session commands with
  // real exit codes — feeds the terminal's gutter decorations. Reports
  // integrated:false for non-bash sessions (honest: no markers there).
  if (rest === '/commands' && method === 'GET') {
    const session = getSessionOr404(ctx, res, id);
    if (!session) return true;
    const tracker = commandTrackers.get(id);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '200', 10) || 200));
    ctx.json(res, 200, {
      integrated: tracker !== undefined,
      // R20 #6(v) N6: read-time desensitization (same as the history
      // endpoint above); the tracker holds the shell's verbatim lines.
      commands: tracker
        ? tracker
            .getCommands()
            .slice(-limit)
            .reverse()
            .map((c) => ({ ...c, command: cleanTerminalText(c.command) }))
        : [],
    });
    return true;
  }

  // close
  if ((rest === '' || rest === '/') && method === 'DELETE') {
    const session = getSessionOr404(ctx, res, id);
    if (!session) return true;
    const exit = await session.close();
    ctx.audit.record('terminal', 'SESSION_CLOSE', 'terminal', id, {
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
    ctx.json(res, 200, { ok: true, exit });
    return true;
  }

  // session detail
  if ((rest === '' || rest === '/') && method === 'GET') {
    const session = getSessionOr404(ctx, res, id);
    if (!session) return true;
    ctx.json(res, 200, session.toRecord());
    return true;
  }

  return false;
}

/**
 * Task ⑥ seam — tail of a terminal session's transcript for the
 * @terminal context provider. Pure read: never creates a session.
 * Returns found:false with a note when there is nothing to attach —
 * an honest "nothing available", never an invented transcript.
 * Terminal sessions are process-local; closed sessions are gone.
 */
export function getTerminalTailForContext(
  sessionId: string | null,
  maxLines: number,
): { found: boolean; sessionId?: string; text?: string; note?: string } {
  const lines = Math.min(2000, Math.max(1, Math.floor(maxLines) || 200));
  try {
    let session;
    if (sessionId) {
      session = manager.get(sessionId); // throws PtySessionError on unknown id
    } else {
      const live = manager
        .list()
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      if (live.length === 0) {
        return { found: false, note: 'no live terminal sessions' };
      }
      session = manager.get(live[0].id);
    }
    const all = session.transcriptText().split('\n');
    const tail = all.slice(-lines).join('\n');
    return { found: true, sessionId: session.id, text: tail };
  } catch (e) {
    return { found: false, note: (e as Error).message };
  }
}
