/**
 * Shell execution with a REAL PTY — spec §33 (Shell tool), §50.1 / §64
 * (终端 xterm.js + 受控 PTY), closing audit gap G-11 (group-d §50.1:
 * "终端无真实 PTY").
 *
 * Until now the factory had NO concrete shell ToolImpl in the runtime:
 * the Harness runs host-injected ToolImpls, the command-spawning
 * machinery lived in @ai-factory/projects (pipe-based, policy-checked)
 * and the server's /api/exec ran one-shot execFile over pipes while its
 * own header admitted "no real PTY". This module ships the missing
 * concrete implementation in two modes that coexist:
 *
 *   - 'pipe' — child stdio on pipes; stdout and stderr stay separate.
 *   - 'pty'  — the child runs on a real pseudo-terminal: stdout and
 *     stderr are the SAME terminal stream (merged, as on any real
 *     terminal), `test -t 1` is true inside the command, the window
 *     size is set before exec, and stdin is forwarded to the terminal.
 *
 * PTY backend — why a python3 helper: Node has no built-in PTY and this
 * repo carries zero external dependencies (no node-pty native module).
 * The backend is a small embedded Python supervisor (PTY_HELPER_SOURCE
 * below) that allocates the pty with os.openpty(), sets the window
 * size with TIOCSWINSZ *before* spawning the child in its own session,
 * forwards stdin/stdout through the pty master, propagates the child's
 * exit status (128+signal for signal deaths, shell convention), and
 * forwards SIGTERM/SIGINT/SIGHUP it receives to the child's whole
 * process group (with a 1s SIGKILL escalation) — so the Node-side
 * timeout kills the entire command tree, not just the shell. The
 * helper's own diagnostics go to ITS stderr, which Node captures
 * separately (the child's stderr is on the pty, merged — there is no
 * confusion between the two).
 *
 * Honest boundaries (also in docs/KNOWN_LIMITATIONS.md):
 *   - POSIX only. Windows has no POSIX pty and no guaranteed python3;
 *     runCommandPty fails closed with PtyUnavailableError there, and
 *     whenever python3 (with its pty module) is not on PATH.
 *   - The window size is fixed at spawn time. There is no live resize
 *     (no SIGWINCH channel to the helper), unlike a native node-pty
 *     backend.
 *   - PTY output is one merged stream: stdout/stderr cannot be told
 *     apart afterwards, and line endings are the terminal's (\r\n).
 *     Input written to the terminal is echoed back by the line
 *     discipline, exactly as on a real terminal.
 *   - End of stdin does NOT terminate the child (a terminal has no
 *     EOF); commands that read until EOF run until they exit or the
 *     timeout kills the tree.
 *   - This is an execution mechanism, not an isolation boundary: §7
 *     confinement duties stay with the caller (the Harness permission
 *     gate, the server's exec policy). Nothing here grants permission.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { FactoryError, MissingBinaryError } from './types';
import type { ToolImpl } from './harness';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ShellRunMode = 'pipe' | 'pty';

export interface ShellRunOptions {
  /** Working directory for the child. Defaults to the process cwd. */
  cwd?: string;
  /** Extra environment, merged over the inherited environment. */
  env?: Record<string, string>;
  /** One-shot stdin payload, written once; the stream is then closed. */
  stdin?: string;
  /** Kill the whole process tree after this long. Default 30_000. */
  timeoutMs?: number;
  /**
   * Capture budget in BYTES per stream. Output past the budget is
   * drained and discarded (the child never blocks on a full pipe);
   * `truncated` reports that it happened. Default 1 MiB.
   */
  maxOutputBytes?: number;
  /** PTY only: terminal columns, fixed at spawn. Default 80. */
  cols?: number;
  /** PTY only: terminal rows, fixed at spawn. Default 24. */
  rows?: number;
  /**
   * PTY only: python3 interpreter used for the helper backend.
   * Default 'python3' (resolved on PATH). Exists so deployments — and
   * tests — can pin or probe a specific interpreter.
   */
  pythonPath?: string;
}

export interface ShellRunResult {
  mode: ShellRunMode;
  /** Exit code, or null when the child died by signal (see `signal`). */
  exitCode: number | null;
  /** Signal that killed the child (or the supervisor), if any. */
  signal: string | null;
  /**
   * Captured output. In PTY mode this is the merged terminal stream —
   * the child's stdout and stderr are indistinguishable in it.
   */
  stdout: string;
  /** Pipe mode: the child's stderr. PTY mode: always ''. */
  stderr: string;
  /** True exactly when `stderr` is merged into `stdout` (PTY mode). */
  merged: boolean;
  /** The timeout fired and the process tree was killed. */
  timedOut: boolean;
  /** Output exceeded maxOutputBytes and the excess was discarded. */
  truncated: boolean;
  durationMs: number;
  /**
   * PTY mode only: diagnostics from the helper backend itself (never
   * from the child — the child's output is the merged stream). Present
   * when the helper had something to say, e.g. the command binary does
   * not exist (the run then reports exitCode 127).
   */
  backendDiagnostics?: string;
}

/** The PTY backend cannot run here (platform or missing python3). */
export class PtyUnavailableError extends FactoryError {
  constructor(detail: string) {
    super('PTY_UNAVAILABLE', `PTY backend unavailable: ${detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* The embedded python3 PTY supervisor                                 */
/* ------------------------------------------------------------------ */

/**
 * The PTY supervisor, fed to `python3 -c`. Argument convention:
 * argv[1]=rows, argv[2]=cols, argv[3]='--', argv[4:]=command argv.
 * Behavior contract (pinned by tests/pty.test.ts):
 *   - window size is ioctl'd onto the slave BEFORE the child spawns;
 *   - the child runs in its own session (start_new_session) with the
 *     slave as stdin/stdout/stderr;
 *   - stdin is forwarded to the master, master output to stdout, both
 *     unbuffered; input EOF does not close anything (terminal rules);
 *   - SIGTERM/SIGINT/SIGHUP to the supervisor are forwarded to the
 *     child's process group, escalating to SIGKILL after 1s;
 *   - exit status is the child's, with signal deaths mapped to
 *     128+signal; a command that cannot be spawned exits 127 with the
 *     reason on the supervisor's own stderr.
 */
const PTY_HELPER_SOURCE = `
import fcntl
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
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
    os.write(2, ("pty-helper: cannot start %r: %s\\n" % (cmd[0], exc)).encode())
    sys.exit(127)
os.close(slave)

pending = []


def _on_signal(signum, _frame):
    pending.append(signum)


for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(_sig, _on_signal)

os.set_blocking(master, False)
stdin_fd = sys.stdin.fileno()
os.set_blocking(stdin_fd, False)
stdout_fd = sys.stdout.fileno()
stdin_open = True
master_eof = False
term_deadline = None

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
    if not read_set:
        time.sleep(0.02)
        continue
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
                stdin_open = False

rc = proc.wait()
if rc < 0:
    sys.exit(128 + (-rc))
sys.exit(rc)
`;

/* ------------------------------------------------------------------ */
/* Backend probe                                                       */
/* ------------------------------------------------------------------ */

const probeCache = new Map<string, boolean>();

/**
 * True when the PTY backend can run with the given interpreter:
 * POSIX platform and a python3 whose `pty` module imports. Probed
 * once per interpreter and cached. Never throws.
 */
export function ptyBackendAvailable(pythonPath = 'python3'): boolean {
  const cached = probeCache.get(pythonPath);
  if (cached !== undefined) return cached;
  let ok = false;
  if (process.platform !== 'win32') {
    try {
      const probe = spawnSync(pythonPath, ['-c', 'import pty, termios'], {
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

function assertPtyBackend(pythonPath: string): void {
  if (process.platform === 'win32') {
    throw new PtyUnavailableError(
      'Windows has no POSIX pseudo-terminal and this backend requires one ' +
        '(Linux/macOS only; verified on Linux)',
    );
  }
  if (!ptyBackendAvailable(pythonPath)) {
    throw new PtyUnavailableError(
      `'${pythonPath}' with an importable pty module was not found on PATH`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Shared spawn supervision (capture caps + tree-killing timeout)      */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 300;

class StreamCapture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.bytes >= this.cap) {
      this.truncated = true;
      return; // keep draining, discard the excess
    }
    const room = this.cap - this.bytes;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes += room;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

interface SupervisedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: Error;
}

/**
 * Wait for a detached child; on timeout, SIGTERM its whole process
 * group, then SIGKILL after a short grace. Resolves — never rejects —
 * with the exit facts (a spawn failure resolves with spawnError set).
 */
function supervise(child: ChildProcess, timeoutMs: number): Promise<SupervisedExit> {
  return new Promise((resolveExit) => {
    let timedOut = false;
    let settled = false;
    const finish = (r: SupervisedExit): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      const grace = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
      if (typeof grace.unref === 'function') grace.unref();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (err) =>
      finish({ code: null, signal: null, timedOut, spawnError: err }),
    );
    child.on('close', (code, signal) => finish({ code, signal, timedOut }));
  });
}

function normalizeOptions(opts: ShellRunOptions): Required<Omit<ShellRunOptions, 'cwd' | 'env' | 'stdin' | 'pythonPath'>> & {
  pythonPath: string;
} {
  const clampDim = (v: number | undefined, dflt: number): number => {
    if (v === undefined || !Number.isFinite(v)) return dflt;
    return Math.min(1000, Math.max(1, Math.floor(v)));
  };
  return {
    timeoutMs: opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxOutputBytes:
      opts.maxOutputBytes !== undefined && opts.maxOutputBytes > 0
        ? Math.floor(opts.maxOutputBytes)
        : DEFAULT_MAX_OUTPUT_BYTES,
    cols: clampDim(opts.cols, 80),
    rows: clampDim(opts.rows, 24),
    pythonPath: opts.pythonPath ?? 'python3',
  };
}

function childEnv(opts: ShellRunOptions, pty: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  // A real terminal session carries a TERM; without one, color- and
  // capability-aware programs cannot behave as they do on a terminal.
  // Only fill it in when nothing in the chain set one.
  if (pty && env['TERM'] === undefined) env['TERM'] = 'xterm-256color';
  return env;
}

function assertArgv(argv: string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || a === '')) {
    throw new Error('argv must be a non-empty array of non-empty strings');
  }
}

/* ------------------------------------------------------------------ */
/* Pipe mode                                                           */
/* ------------------------------------------------------------------ */

/**
 * Run a command with stdio on pipes: stdout and stderr are captured
 * separately, stdin (if given) is written once and closed — EOF is
 * real here, unlike on a terminal.
 */
export async function runCommandPipe(argv: string[], opts: ShellRunOptions = {}): Promise<ShellRunResult> {
  assertArgv(argv);
  const o = normalizeOptions(opts);
  const started = Date.now();
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: opts.cwd,
    env: childEnv(opts, false),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const outCap = new StreamCapture(o.maxOutputBytes);
  const errCap = new StreamCapture(o.maxOutputBytes);
  child.stdout?.on('data', (d: Buffer) => outCap.push(d));
  child.stderr?.on('data', (d: Buffer) => errCap.push(d));
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();
  const exit = await supervise(child, o.timeoutMs);
  if (exit.spawnError) {
    // Batch 40 — deterministic environment signal: the OS told us the
    // binary does not exist (spawn ENOENT), so say so with a
    // machine-readable code instead of a bare Error. Still an Error, so
    // existing catch behavior is unchanged; runAgent's reasonCode bridge
    // picks up the code. Other spawn failures keep their original error.
    const se = exit.spawnError as NodeJS.ErrnoException;
    if (se.code === 'ENOENT') {
      throw new MissingBinaryError(argv[0] as string, se.message);
    }
    throw exit.spawnError;
  }
  return {
    mode: 'pipe',
    exitCode: exit.code,
    signal: exit.signal,
    stdout: outCap.text(),
    stderr: errCap.text(),
    merged: false,
    timedOut: exit.timedOut,
    truncated: outCap.truncated || errCap.truncated,
    durationMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ */
/* PTY mode                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run a command on a real pseudo-terminal via the embedded python3
 * supervisor. stdout+stderr arrive merged in `stdout` (terminal
 * semantics — `merged: true`, `stderr: ''`); the window size is fixed
 * at spawn from opts.rows/opts.cols; stdin (if given) is forwarded to
 * the terminal and echoed by the line discipline, as on a real
 * terminal. Throws PtyUnavailableError when the backend cannot run.
 */
export async function runCommandPty(argv: string[], opts: ShellRunOptions = {}): Promise<ShellRunResult> {
  assertArgv(argv);
  const o = normalizeOptions(opts);
  assertPtyBackend(o.pythonPath);
  const started = Date.now();
  const child = spawn(
    o.pythonPath,
    ['-c', PTY_HELPER_SOURCE, String(o.rows), String(o.cols), '--', ...argv],
    {
      cwd: opts.cwd,
      env: childEnv(opts, true),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const outCap = new StreamCapture(o.maxOutputBytes);
  const diagCap = new StreamCapture(64 * 1024);
  child.stdout?.on('data', (d: Buffer) => outCap.push(d));
  child.stderr?.on('data', (d: Buffer) => diagCap.push(d));
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();
  const exit = await supervise(child, o.timeoutMs);
  if (exit.spawnError) {
    throw new PtyUnavailableError(`failed to spawn '${o.pythonPath}': ${exit.spawnError.message}`);
  }
  const diagnostics = diagCap.text().trim();
  return {
    mode: 'pty',
    exitCode: exit.code,
    signal: exit.signal,
    stdout: outCap.text(),
    stderr: '',
    merged: true,
    timedOut: exit.timedOut,
    truncated: outCap.truncated,
    durationMs: Date.now() - started,
    ...(diagnostics ? { backendDiagnostics: diagnostics } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Shell-string convenience + the Harness ToolImpl                     */
/* ------------------------------------------------------------------ */

/** Run a command line through a shell (`/bin/sh -c` by default). */
export async function runShellCommand(
  command: string,
  opts: ShellRunOptions & { mode?: ShellRunMode; shell?: string } = {},
): Promise<ShellRunResult> {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('command must be a non-empty string');
  }
  const argv = [opts.shell ?? '/bin/sh', '-c', command];
  return (opts.mode ?? 'pipe') === 'pty' ? runCommandPty(argv, opts) : runCommandPipe(argv, opts);
}

export interface ShellToolOptions extends ShellRunOptions {
  /** Default mode when a call does not say. Default 'pipe'. */
  mode?: ShellRunMode;
  /** Shell used for {command} calls. Default '/bin/sh'. */
  shell?: string;
}

export interface ShellToolArgs {
  /** Command line, run through the shell. Mutually exclusive with argv. */
  command?: string;
  /** Direct argv (no shell). Mutually exclusive with command. */
  argv?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  /** Per-call mode override: true → PTY, false → pipe. */
  pty?: boolean;
  rows?: number;
  cols?: number;
}

/**
 * The concrete shell ToolImpl for the Harness (§26 runTool / §33
 * shell.execute): `harness.runTool('shell', args, createShellTool())`.
 * The definition's `pty` option (packages/tools shell.execute) selects
 * the real-PTY backend per call; absent, the tool's default mode
 * ('pipe' unless configured) applies. Permission gating is the
 * Harness's job (shell → shell.execute) — this impl only executes.
 * Returns the ShellRunResult record (exit code, merged flag, streams),
 * never a bare "success" string: §33 — natural-language success must
 * not override the exit code.
 */
export function createShellTool(toolOpts: ShellToolOptions = {}): ToolImpl {
  return async (args: unknown): Promise<ShellRunResult> => {
    const a = (args ?? {}) as ShellToolArgs;
    const runOpts: ShellRunOptions = {
      cwd: a.cwd ?? toolOpts.cwd,
      env: toolOpts.env,
      stdin: a.stdin ?? toolOpts.stdin,
      timeoutMs: a.timeoutMs ?? toolOpts.timeoutMs,
      maxOutputBytes: toolOpts.maxOutputBytes,
      cols: a.cols ?? toolOpts.cols,
      rows: a.rows ?? toolOpts.rows,
      pythonPath: toolOpts.pythonPath,
    };
    const mode: ShellRunMode = a.pty !== undefined ? (a.pty ? 'pty' : 'pipe') : (toolOpts.mode ?? 'pipe');
    if (a.argv !== undefined) {
      return mode === 'pty' ? runCommandPty(a.argv, runOpts) : runCommandPipe(a.argv, runOpts);
    }
    if (typeof a.command === 'string' && a.command.trim() !== '') {
      return runShellCommand(a.command, { ...runOpts, mode, shell: toolOpts.shell });
    }
    throw new Error("shell tool requires args.command (string) or args.argv (string[])");
  };
}
