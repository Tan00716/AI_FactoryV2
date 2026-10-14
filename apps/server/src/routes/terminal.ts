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
import type { RouteContext } from './context';
import {
  PtySessionManager,
  PtySessionUnavailableError,
  PtySessionError,
  type PtySession,
} from '@ai-factory/runtime';
import {
  createCrossChunkRedactor,
  type CrossChunkRedactor,
} from '@ai-factory/secrets';
import { recordRedactionHit } from '../redaction-monitor';
import {
  checkCommandPolicy,
  commandHitsControlDir,
  resolveExecCwd,
  resolveSecretEnvRefs,
  ExecPolicyDenied,
  SecretEnvError,
} from './exec';

const manager = new PtySessionManager({ maxSessions: 16, archiveDepth: 50 });
const IDLE_REAP_MS = 30 * 60 * 1000;
const MAX_INPUT_BYTES = 64 * 1024;

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

/** The AI line gate: the /api/exec policy, applied per input line. */
function aiLineGate(cwd: string): (line: string) => void {
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return; // blank lines pass through
    let tokens: string[];
    try {
      tokens = checkCommandPolicy(trimmed);
    } catch (err) {
      throw new Error((err as ExecPolicyDenied).message);
    }
    if (commandHitsControlDir(cwd, tokens)) {
      throw new Error('command refused: the control-plane data directory is off-limits');
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
    let session: PtySession;
    try {
      session = manager.create({
        principal,
        shell,
        cwd,
        env: secretEnv,
        rows: body['rows'] as number | undefined,
        cols: body['cols'] as number | undefined,
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

    // AI line denials are audited (values never: only the caller's own
    // refused line and the policy reason).
    session.onDenied(({ line, reason }) => {
      ctx.audit.record(actor, 'AI_LINE_DENIED', 'terminal', session.id, {
        principal,
        line: line.slice(0, 120),
        reason,
      });
    });

    ctx.audit.record(actor, 'SESSION_CREATE', 'terminal', session.id, {
      principal,
      rows: session.rows,
      cols: session.cols,
      cwd,
      shell: shell.join(' '),
      ...(secretValues.length > 0 ? { secretEnvVars: Object.keys(secretEnv) } : {}),
    });
    ctx.json(res, 201, { ...session.toRecord(), cwd });
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
