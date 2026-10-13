/**
 * Interactive PTY sessions — spec §50.1 ("终端 xterm.js + 受控 PTY,
 * 有 Human 与 AI 独立 Session/Principal"), building on the one-shot
 * PTY backend from pty.ts (Batch 18).
 *
 * What this module is: a session manager that keeps a real
 * pseudo-terminal alive across many reads/writes. Each session spawns
 * the embedded python3 PTY supervisor (a session-oriented sibling of
 * pty.ts's one-shot helper) with an interactive shell on the slave.
 *
 * What this module is NOT: a permission layer. Gating is the caller's
 * job:
 *   - principal isolation is structural: every session is tagged
 *     'human' | 'ai' at creation, registries never mix streams, and
 *     the two principals get different input handling:
 *       · human — raw byte passthrough (the operator's own terminal);
 *       · ai    — LINE-GATED: each newline-terminated line is offered
 *         to an injected policy checker BEFORE it reaches the pty. A
 *         rejected line is dropped and reported via onDenied; it never
 *         touches the terminal. This is how an AI session "walks the
 *         permission gate" on an interactive channel.
 *   - creation-time policy (cwd confinement, command whitelist/deny,
 *     the §7.5 confinement stance) belongs to the embedding server
 *     (apps/server routes/terminal.ts reuses routes/exec.ts's policy).
 *
 * Resize: unlike the one-shot backend (Batch 18: size fixed at spawn,
 * "no SIGWINCH channel"), sessions carry a CONTROL PIPE — an extra
 * stdio pipe (child fd 3) on which Node sends newline-delimited JSON
 * commands ({op:'resize',rows,cols}). The helper applies TIOCSWINSZ
 * and delivers SIGWINCH to the child's process group, so `stty size`
 * inside the session reads the new size back. No escape-sequence
 * parsing on the terminal stream itself (user input can never be
 * mistaken for a control command).
 *
 * Honest boundaries:
 *   - POSIX only, same fail-closed probe as pty.ts.
 *   - Interactive sessions are long-lived processes: an idle sweeper
 *     (manager.sweepIdle) must be driven by the embedder; this module
 *     never reaps on its own.
 *   - Sessions live in-process: a server restart drops them (same as
 *     the merge queue / PrStore posture). Closed sessions leave an
 *     archived record (bounded), not a resumable terminal. A session
 *     can never outlive its controller: the supervisor watches its
 *     stdin pipe and SIGKILLs the whole process group when it sees
 *     EOF (the Node process died or close() was called), so even a
 *     SIGKILLed server leaves no orphaned shells behind.
 *   - AI line gating is per-LINE on the byte stream: a policy sees
 *     complete lines only; it cannot see terminal escape sequences the
 *     shell itself emits, and multi-line constructs (heredocs,
 *     continuations) are gated line-by-line — a deliberate,
 *     documented approximation, not a security boundary against a
 *     hostile model. The real boundary for AI stays where it was:
 *     the embedding server's confinement policy (§7).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FactoryError } from './types';

export type SessionPrincipal = 'human' | 'ai';

/** Thrown when a session operation is impossible (unknown id, closed…). */
export class PtySessionError extends FactoryError {
  constructor(message: string) {
    super('PTY_SESSION_ERROR', message);
  }
}

export class PtySessionUnavailableError extends FactoryError {
  constructor(detail: string) {
    super('PTY_UNAVAILABLE', `PTY session backend unavailable: ${detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* Embedded session supervisor (python3)                               */
/* ------------------------------------------------------------------ */

/**
 * Session supervisor. Argument convention:
 *   argv[1]=rows, argv[2]=cols, argv[3]='--', argv[4:]=shell argv.
 * stdio: 0=stdin pipe, 1=stdout pipe, 2=own diagnostics, 3=CONTROL pipe
 * (newline-delimited JSON from Node: {"op":"resize","rows":R,"cols":C}).
 *
 * Contract (pinned by tests/pty-session.test.ts):
 *   - real pty via os.openpty(); winsize ioctl'd before the child
 *     spawns; child in its own session with the slave as stdio;
 *   - stdin forwarded to the master, master output to stdout;
 *   - control commands on fd 3: resize applies TIOCSWINSZ on the pty
 *     master and sends SIGWINCH to the child process group;
 *   - signals to the supervisor are forwarded to the child pg with a
 *     1s SIGKILL escalation (same as the one-shot helper);
 *   - child exit → supervisor exits with the child's status
 *     (signal deaths mapped to 128+signal, as in pty.ts).
 */
const PTY_SESSION_HELPER_SOURCE = `
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

rows = int(sys.argv[1])
cols = int(sys.argv[2])
cmd = sys.argv[4:]

master, slave = os.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
try:
    proc = subprocess.Popen(
        cmd,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
except OSError as exc:
    os.write(2, ("pty-session: cannot start %r: %s\\n" % (cmd[0], exc)).encode())
    sys.exit(127)
os.close(slave)

ctl = os.fdopen(3, "rb", buffering=0)
pending = []


def _on_signal(signum, _frame):
    pending.append(signum)


for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(_sig, _on_signal)

os.set_blocking(master, False)
os.set_blocking(ctl.fileno(), False)
stdin_fd = sys.stdin.fileno()
os.set_blocking(stdin_fd, False)
stdout_fd = sys.stdout.fileno()
stdin_open = True
master_eof = False
ctl_buf = b""
term_deadline = None


def _handle_control(line):
    try:
        msg = json.loads(line.decode("utf-8"))
    except Exception:
        return
    if not isinstance(msg, dict):
        return
    if msg.get("op") == "resize":
        try:
            r = int(msg["rows"])
            c = int(msg["cols"])
        except Exception:
            return
        r = max(1, min(1000, r))
        c = max(1, min(1000, c))
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
            os.killpg(proc.pid, signal.SIGWINCH)
        except (OSError, ProcessLookupError, PermissionError):
            pass


while True:
    if pending and term_deadline is None:
        sig = pending.pop(0)
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        term_deadline = time.monotonic() + 1.0
    if term_deadline is not None and time.monotonic() >= term_deadline:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        term_deadline = None

    if master_eof and proc.poll() is not None:
        break

    read_set = []
    if not master_eof:
        read_set.append(master)
    if stdin_open:
        read_set.append(stdin_fd)
    read_set.append(ctl.fileno())
    try:
        ready, _, _ = select.select(read_set, [], [], 0.05)
    except (InterruptedError, OSError):
        continue
    for fd in ready:
        if fd == master:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if data:
                try:
                    os.write(stdout_fd, data)
                except OSError:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                    proc.wait()
                    sys.exit(1)
            else:
                master_eof = True
        elif fd == stdin_fd:
            try:
                data = os.read(stdin_fd, 65536)
            except OSError:
                data = b""
            if data:
                try:
                    os.write(master, data)
                except OSError:
                    stdin_open = False
            else:
                # The controller is gone (the Node process died or the
                # session was closed): a session must never outlive its
                # controller — take the whole tree down and exit. The
                # only writer of this pipe is PtySession itself, which
                # ends it exclusively in close().
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                proc.wait()
                sys.exit(137)
        else:
            try:
                data = os.read(ctl.fileno(), 65536)
            except OSError:
                data = b""
            if data:
                ctl_buf += data
                while b"\\n" in ctl_buf:
                    line, ctl_buf = ctl_buf.split(b"\\n", 1)
                    if line.strip():
                        _handle_control(line)
            # EOF on the control pipe is ignored: resize simply stops.

rc = proc.wait()
if rc < 0:
    sys.exit(128 + (-rc))
sys.exit(rc)
`;

const probeCache = new Map<string, boolean>();

function ptySessionBackendAvailable(pythonPath = 'python3'): boolean {
  const cached = probeCache.get(pythonPath);
  if (cached !== undefined) return cached;
  let ok = false;
  if (process.platform !== 'win32') {
    try {
      const probe = spawnSync(pythonPath, ['-c', 'import pty, termios, fcntl'], {
        timeout: 5_000,
      });
      ok = probe.status === 0;
    } catch {
      ok = false;
    }
  }
  probeCache.set(pythonPath, ok);
  return ok;
}

function assertSessionBackend(pythonPath: string): void {
  if (process.platform === 'win32') {
    throw new PtySessionUnavailableError(
      'Windows has no POSIX pseudo-terminal (Linux/macOS only; verified on Linux)',
    );
  }
  if (!ptySessionBackendAvailable(pythonPath)) {
    throw new PtySessionUnavailableError(
      `'${pythonPath}' with importable pty/termios modules was not found on PATH`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export interface PtySessionOptions {
  principal: SessionPrincipal;
  /** Shell argv, e.g. ['/bin/bash','-i']. Default ['/bin/bash']. */
  shell?: string[];
  cwd?: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  pythonPath?: string;
  /**
   * AI line gate: called with each newline-terminated input line for
   * 'ai' sessions BEFORE it reaches the pty. Throw to deny the line
   * (it is dropped; the throw's message becomes the denial reason).
   * Ignored for 'human' sessions.
   */
  aiLinePolicy?: (line: string) => void;
  /** Transcript backlog kept for late subscribers (bytes). Default 64 KiB. */
  transcriptBytes?: number;
}

export interface PtySessionExit {
  exitCode: number | null;
  signal: string | null;
}

export interface PtySessionRecord {
  id: string;
  principal: SessionPrincipal;
  rows: number;
  cols: number;
  createdAt: number;
  /** Last input/output activity. */
  lastActivityAt: number;
  alive: boolean;
  exit?: PtySessionExit;
}

export interface PtySessionArchiveEntry extends PtySessionRecord {
  endedAt: number;
}

const DEFAULT_TRANSCRIPT_BYTES = 64 * 1024;
const KILL_GRACE_MS = 500;

function clampDim(v: number | undefined, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.min(1000, Math.max(1, Math.floor(v)));
}

/**
 * One live interactive PTY session.
 */
export class PtySession {
  readonly id = randomUUID();
  readonly principal: SessionPrincipal;
  readonly createdAt = Date.now();
  readonly shell: string[];

  private child: ChildProcess;
  private ctl: NodeJS.WritableStream;
  private closed = false;
  private exitInfo: PtySessionExit | null = null;
  private exitWaiters: Array<(e: PtySessionExit) => void> = [];
  private outputListeners = new Set<(chunk: Buffer) => void>();
  private deniedListeners = new Set<(info: { line: string; reason: string }) => void>();
  private closeListeners = new Set<(exit: PtySessionExit) => void>();
  private transcript: Buffer[] = [];
  private transcriptBytes = 0;
  private readonly transcriptCap: number;
  private aiRemainder = '';
  lastActivityAt = Date.now();
  private _rows: number;
  private _cols: number;

  private constructor(
    principal: SessionPrincipal,
    shell: string[],
    child: ChildProcess,
    ctl: NodeJS.WritableStream,
    opts: { rows: number; cols: number; transcriptCap: number; aiLinePolicy?: (line: string) => void },
  ) {
    this.principal = principal;
    this.shell = shell;
    this.child = child;
    this.ctl = ctl;
    this._rows = opts.rows;
    this._cols = opts.cols;
    this.transcriptCap = opts.transcriptCap;
    const policy = opts.aiLinePolicy;

    child.stdout?.on('data', (d: Buffer) => {
      this.lastActivityAt = Date.now();
      this.pushTranscript(d);
      for (const cb of this.outputListeners) {
        try {
          cb(d);
        } catch {
          /* listener errors must not break the session */
        }
      }
    });
    const finish = (exit: PtySessionExit): void => {
      if (this.closed) return;
      this.closed = true;
      this.exitInfo = exit;
      for (const cb of this.closeListeners) {
        try {
          cb(exit);
        } catch {
          /* ignore */
        }
      }
      for (const w of this.exitWaiters) w(exit);
      this.exitWaiters = [];
    };
    child.on('error', () => finish({ exitCode: null, signal: null }));
    child.on('close', (code, signal) =>
      finish({ exitCode: code, signal: signal ?? null }),
    );

    this.aiLinePolicy = policy;
  }

  private aiLinePolicy?: (line: string) => void;

  static create(opts: PtySessionOptions): PtySession {
    const pythonPath = opts.pythonPath ?? 'python3';
    assertSessionBackend(pythonPath);
    const shell = opts.shell && opts.shell.length > 0 ? opts.shell : ['/bin/bash'];
    if (shell.some((a) => typeof a !== 'string' || a === '')) {
      throw new PtySessionError('shell must be a non-empty array of non-empty strings');
    }
    const rows = clampDim(opts.rows, 24);
    const cols = clampDim(opts.cols, 80);
    const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
    if (env['TERM'] === undefined) env['TERM'] = 'xterm-256color';
    const child = spawn(
      pythonPath,
      ['-c', PTY_SESSION_HELPER_SOURCE, String(rows), String(cols), '--', ...shell],
      {
        cwd: opts.cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const ctl = child.stdio[3] as NodeJS.WritableStream | undefined;
    if (!ctl) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      throw new PtySessionError('failed to open the session control pipe');
    }
    return new PtySession(opts.principal, shell, child, ctl, {
      rows,
      cols,
      transcriptCap:
        opts.transcriptBytes !== undefined && opts.transcriptBytes > 0
          ? Math.floor(opts.transcriptBytes)
          : DEFAULT_TRANSCRIPT_BYTES,
      aiLinePolicy: opts.principal === 'ai' ? opts.aiLinePolicy : undefined,
    });
  }

  get rows(): number {
    return this._rows;
  }
  get cols(): number {
    return this._cols;
  }
  get alive(): boolean {
    return !this.closed;
  }
  get exit(): PtySessionExit | null {
    return this.exitInfo;
  }
  /** Supervisor pid (for tests asserting whole-tree cleanup). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  private pushTranscript(d: Buffer): void {
    this.transcript.push(d);
    this.transcriptBytes += d.length;
    while (this.transcriptBytes > this.transcriptCap && this.transcript.length > 0) {
      const dropped = this.transcript.shift() as Buffer;
      this.transcriptBytes -= dropped.length;
    }
  }

  /** Output backlog for late subscribers (e.g. a fresh SSE stream). */
  transcriptText(): string {
    return Buffer.concat(this.transcript).toString('utf8');
  }

  onOutput(cb: (chunk: Buffer) => void): () => void {
    this.outputListeners.add(cb);
    return () => {
      this.outputListeners.delete(cb);
    };
  }

  onDenied(cb: (info: { line: string; reason: string }) => void): () => void {
    this.deniedListeners.add(cb);
    return () => {
      this.deniedListeners.delete(cb);
    };
  }

  onClose(cb: (exit: PtySessionExit) => void): () => void {
    if (this.closed && this.exitInfo) {
      cb(this.exitInfo);
      return () => {};
    }
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  /**
   * Write bytes to the session's stdin.
   * human: raw passthrough. ai: line-gated — complete lines pass
   * through aiLinePolicy first; denied lines are dropped and reported
   * via onDenied (never forwarded to the pty). A trailing partial line
   * is buffered until its newline arrives.
   */
  write(data: string | Buffer): void {
    if (this.closed) throw new PtySessionError(`session ${this.id} is closed`);
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (this.principal === 'ai' && this.aiLinePolicy) {
      this.aiRemainder += text;
      let idx: number;
      let forward = '';
      while ((idx = this.aiRemainder.indexOf('\n')) >= 0) {
        const rawLine = this.aiRemainder.slice(0, idx + 1);
        this.aiRemainder = this.aiRemainder.slice(idx + 1);
        const line = rawLine.replace(/\r?\n$/, '');
        try {
          this.aiLinePolicy(line);
          forward += rawLine;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          for (const cb of this.deniedListeners) {
            try {
              cb({ line, reason });
            } catch {
              /* ignore */
            }
          }
        }
      }
      if (forward) this.writeRaw(forward);
      // A partial line stays buffered: it has not been gated yet and
      // must not reach the terminal half-checked.
      return;
    }
    this.writeRaw(text);
  }

  private writeRaw(text: string): void {
    if (this.closed) return;
    this.lastActivityAt = Date.now();
    try {
      this.child.stdin?.write(text);
    } catch {
      /* the supervisor is going away; close() settles the state */
    }
  }

  /**
   * Live resize over the control pipe: the helper applies TIOCSWINSZ
   * and SIGWINCHes the child's process group. Node tracks the size;
   * the authoritative proof is `stty size` inside the session.
   */
  resize(rows: number, cols: number): void {
    if (this.closed) throw new PtySessionError(`session ${this.id} is closed`);
    const r = clampDim(rows, this._rows);
    const c = clampDim(cols, this._cols);
    this.lastActivityAt = Date.now();
    try {
      this.ctl.write(JSON.stringify({ op: 'resize', rows: r, cols: c }) + '\n');
    } catch {
      /* control pipe broken — the session is effectively dead */
    }
    this._rows = r;
    this._cols = c;
  }

  /** Resolve when the session's shell exits (naturally or via close()). */
  waitExit(): Promise<PtySessionExit> {
    if (this.closed && this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  /**
   * Close the session: SIGTERM the whole process group, SIGKILL after
   * a short grace — the entire command tree dies, not just the shell.
   * Resolves with the exit facts. Idempotent.
   */
  async close(): Promise<PtySessionExit> {
    if (this.closed && this.exitInfo) return this.exitInfo;
    const child = this.child;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    killTree('SIGTERM');
    setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref?.();
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    return this.waitExit();
  }

  toRecord(): PtySessionRecord {
    return {
      id: this.id,
      principal: this.principal,
      rows: this._rows,
      cols: this._cols,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      alive: this.alive,
      ...(this.exitInfo ? { exit: this.exitInfo } : {}),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

export interface PtySessionManagerOptions {
  /** Refuse new sessions past this many live ones. Default 16. */
  maxSessions?: number;
  /** Closed-session archive depth. Default 50. */
  archiveDepth?: number;
}

/**
 * In-process registry of live sessions + a bounded archive of closed
 * ones. Principals are isolated structurally: sessions are separate
 * objects with separate streams and separate input handling; there is
 * no API that moves bytes between sessions.
 */
export class PtySessionManager {
  private sessions = new Map<string, PtySession>();
  private archive: PtySessionArchiveEntry[] = [];
  private readonly maxSessions: number;
  private readonly archiveDepth: number;

  constructor(opts: PtySessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 16;
    this.archiveDepth = opts.archiveDepth ?? 50;
  }

  get liveCount(): number {
    return this.sessions.size;
  }

  create(opts: PtySessionOptions): PtySession {
    if (this.sessions.size >= this.maxSessions) {
      throw new PtySessionError(
        `session limit reached (${this.maxSessions} live sessions)`,
      );
    }
    const session = PtySession.create(opts);
    this.sessions.set(session.id, session);
    session.onClose(() => {
      this.sessions.delete(session.id);
      this.archive.unshift({ ...session.toRecord(), endedAt: Date.now() });
      if (this.archive.length > this.archiveDepth) {
        this.archive.length = this.archiveDepth;
      }
    });
    return session;
  }

  get(id: string): PtySession {
    const s = this.sessions.get(id);
    if (!s) throw new PtySessionError(`unknown session: ${id}`);
    return s;
  }

  list(): PtySessionRecord[] {
    return [...this.sessions.values()].map((s) => s.toRecord());
  }

  closedSessions(): PtySessionArchiveEntry[] {
    return [...this.archive];
  }

  async close(id: string): Promise<PtySessionExit> {
    return this.get(id).close();
  }

  /**
   * Close sessions idle longer than idleMs (no input or output).
   * Returns the ids that were reaped. The embedder drives this
   * (e.g. on session create/list) — nothing reaps by itself.
   */
  async sweepIdle(idleMs: number): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastActivityAt > idleMs) {
        reaped.push(s.id);
        await s.close().catch(() => undefined);
      }
    }
    return reaped;
  }
}
