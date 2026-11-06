/**
 * @ai-factory/debugger — DAP client: spawns a debug adapter subprocess and
 * speaks DAP to it over stdio.
 *
 * Fail-closed contract (also asserted by tests):
 *   - adapter spawn failure  → start() rejects with ADAPTER_SPAWN_FAILED
 *     (stderr tail attached when available)
 *   - adapter exits early    → pending requests reject with ADAPTER_EXITED,
 *     late requests reject immediately
 *   - no response in time    → request rejects with DAP_TIMEOUT (default 20s)
 *   - adapter answers success:false → request rejects with DAP_ERROR
 *   - child env always has credential material scrubbed (R15 #6(f):
 *     scrubCredentialEnv, same rule as pty.ts childEnv) and
 *     NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID stripped
 *     (a debugged `node --test` child must never silently no-op)
 */
import { spawn, ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { scrubCredentialEnv } from '@ai-factory/runtime';
import { DapFramer, encodeMessage } from './framer';
import type {
  DapBreakpoint,
  DapEvent,
  DapResponse,
  DapScope,
  DapSource,
  DapSourceBreakpoint,
  DapStackFrame,
  DapThread,
  DapVariable,
} from './types';

export class DebugError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DebugError';
    this.code = code;
  }
}

export interface SpawnedProcess {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'error' | 'exit', cb: (...args: unknown[]) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string },
) => SpawnedProcess;

function scrubEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  // R15 #6(f): scrub credential material from the ambient env first (same
  // scrubCredentialEnv as pty.ts childEnv / R13 #6(d)); explicit env still
  // overrides afterwards, as before.
  for (const [k, v] of Object.entries(scrubCredentialEnv(process.env))) {
    if (v !== undefined) env[k] = v;
  }
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) env[k] = v;
  }
  return env;
}

function defaultSpawn(command: string, args: string[], opts: { env: Record<string, string>; cwd?: string }): SpawnedProcess {
  const child: ChildProcess = spawn(command, args, {
    env: scrubEnv(opts.env),
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event: 'error' | 'exit', cb: (...args: unknown[]) => void) => {
      child.on(event, cb as (...a: any[]) => void);
    },
    kill: (signal?: NodeJS.Signals) => {
      try {
        child.kill(signal ?? 'SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

export interface DebugClientOptions {
  /** Test seam: replace the adapter spawn (default: real child_process). */
  spawnFn?: SpawnFn;
  /** Per-request timeout in ms (default 20000). */
  requestTimeoutMs?: number;
  /** node binary used to run the adapter script (default 'node'). */
  nodePath?: string;
}

const MAX_STDERR_KEPT = 16 * 1024;

export class DebugClient {
  private adapterScript: string;
  private opts: Required<Pick<DebugClientOptions, 'requestTimeoutMs'>> &
    Pick<DebugClientOptions, 'spawnFn' | 'nodePath'>;
  private child: SpawnedProcess | null = null;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; command: string }
  >();
  private eventListeners = new Map<string, ((body: unknown) => void)[]>();
  private framer = new DapFramer();
  private stderrTail = '';
  private exitedFlag = false;
  private exitCodeValue: number | null = null;
  private started = false;

  constructor(adapterScript: string, opts?: DebugClientOptions) {
    this.adapterScript = adapterScript;
    this.opts = {
      requestTimeoutMs: opts?.requestTimeoutMs ?? 20000,
      spawnFn: opts?.spawnFn,
      nodePath: opts?.nodePath,
    };
  }

  /** Subscribe to a DAP event: initialized|stopped|continued|terminated|exited|output|breakpoint */
  on(event: string, cb: (body: unknown) => void): void {
    const arr = this.eventListeners.get(event) ?? [];
    arr.push(cb);
    this.eventListeners.set(event, arr);
  }

  get exited(): boolean {
    return this.exitedFlag;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get stderrLog(): string {
    return this.stderrTail;
  }

  async start(): Promise<void> {
    if (this.started) throw new DebugError('ALREADY_STARTED', 'debug client already started');
    this.started = true;
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    const nodePath = this.opts.nodePath ?? 'node';
    await new Promise<void>((resolve, reject) => {
      let child: SpawnedProcess;
      try {
        child = spawnFn(nodePath, [this.adapterScript], { env: scrubEnv() });
      } catch (e) {
        reject(new DebugError('ADAPTER_SPAWN_FAILED', `adapter spawn threw: ${(e as Error).message}`));
        return;
      }
      this.child = child;
      const onSpawnError = (e: unknown): void => {
        this.markExited(null);
        reject(
          new DebugError(
            'ADAPTER_SPAWN_FAILED',
            `adapter process failed to spawn: ${(e as Error)?.message ?? String(e)}`,
          ),
        );
      };
      const onEarlyExit = (code: unknown): void => {
        this.markExited(typeof code === 'number' ? code : null);
        reject(
          new DebugError(
            'ADAPTER_EXITED',
            `adapter exited before start completed (code ${String(code)}); stderr: ${this.stderrTail.slice(-500)}`,
          ),
        );
      };
      child.on('error', onSpawnError);
      child.on('exit', onEarlyExit);
      // If we get here on the next tick without error/exit, the spawn held.
      setImmediate(() => {
        if (this.exitedFlag) return; // already rejected
        child.on('error', () => undefined);
        resolve();
      });
      child.stderr?.on('data', (d: Buffer) => {
        this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-MAX_STDERR_KEPT);
      });
      const framer = this.framer;
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const raw of framer.push(chunk)) this.onMessage(raw as Record<string, unknown>);
      });
      child.on('exit', (code: unknown) => {
        this.markExited(typeof code === 'number' ? code : null);
      });
    });
  }

  private markExited(code: number | null): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    this.exitCodeValue = code;
    const err = new DebugError(
      'ADAPTER_EXITED',
      `adapter exited (code ${code}); stderr: ${this.stderrTail.slice(-500)}`,
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('terminated', { restart: false });
  }

  private emit(event: string, body: unknown): void {
    for (const cb of this.eventListeners.get(event) ?? []) {
      try {
        cb(body);
      } catch {
        /* listener errors must not break the client */
      }
    }
  }

  private onMessage(raw: Record<string, unknown>): void {
    const type = raw.type;
    if (type === 'response') {
      const r = raw as unknown as DapResponse;
      const p = this.pending.get(r.request_seq);
      if (!p) return;
      this.pending.delete(r.request_seq);
      clearTimeout(p.timer);
      if (r.success) p.resolve(r.body);
      else p.reject(new DebugError('DAP_ERROR', `${p.command}: ${r.message ?? 'adapter reported failure'}`));
      return;
    }
    if (type === 'event') {
      const ev = raw as unknown as DapEvent;
      this.emit(ev.event, ev.body);
    }
    // inbound requests are not expected on the client side
  }

  request(command: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.exitedFlag) {
      return Promise.reject(
        new DebugError('ADAPTER_EXITED', `adapter already exited (code ${this.exitCodeValue})`),
      );
    }
    if (!this.child?.stdin) {
      return Promise.reject(new DebugError('NOT_STARTED', 'debug client is not started'));
    }
    const seq = ++this.seq;
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DebugError('DAP_TIMEOUT', `${command} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(seq, { resolve, reject, timer, command });
      try {
        this.child?.stdin?.write(encodeMessage({ seq, type: 'request', command, arguments: args ?? {} }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(new DebugError('ADAPTER_EXITED', `failed to write to adapter: ${(e as Error).message}`));
      }
    });
  }

  // -- high-level API -------------------------------------------------------

  async initialize(clientId = 'ai-factory'): Promise<Record<string, unknown>> {
    return (await this.request('initialize', {
      clientID: clientId,
      adapterID: 'node',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
    })) as Record<string, unknown>;
  }

  async launch(args: Record<string, unknown>): Promise<void> {
    await this.request('launch', args, 45000);
  }

  async attach(args: Record<string, unknown>): Promise<void> {
    await this.request('attach', args, 45000);
  }

  async setBreakpoints(source: DapSource, breakpoints: DapSourceBreakpoint[]): Promise<DapBreakpoint[]> {
    const body = (await this.request('setBreakpoints', { source, breakpoints })) as {
      breakpoints?: DapBreakpoint[];
    };
    return body.breakpoints ?? [];
  }

  async setExceptionBreakpoints(filters: string[]): Promise<void> {
    await this.request('setExceptionBreakpoints', { filters });
  }

  async configurationDone(): Promise<void> {
    await this.request('configurationDone');
  }

  async threads(): Promise<DapThread[]> {
    const body = (await this.request('threads')) as { threads?: DapThread[] };
    return body.threads ?? [];
  }

  async stackTrace(
    threadId: number,
    startFrame?: number,
    levels?: number,
  ): Promise<{ stackFrames: DapStackFrame[]; totalFrames: number }> {
    const args: Record<string, unknown> = { threadId };
    if (startFrame !== undefined) args.startFrame = startFrame;
    if (levels !== undefined) args.levels = levels;
    return (await this.request('stackTrace', args)) as { stackFrames: DapStackFrame[]; totalFrames: number };
  }

  async scopes(frameId: number): Promise<DapScope[]> {
    const body = (await this.request('scopes', { frameId })) as { scopes?: DapScope[] };
    return body.scopes ?? [];
  }

  async variables(variablesReference: number): Promise<DapVariable[]> {
    const body = (await this.request('variables', { variablesReference })) as {
      variables?: DapVariable[];
    };
    return body.variables ?? [];
  }

  async continue(threadId = 1): Promise<void> {
    await this.request('continue', { threadId });
  }

  async next(threadId = 1): Promise<void> {
    await this.request('next', { threadId });
  }

  async stepIn(threadId = 1): Promise<void> {
    await this.request('stepIn', { threadId });
  }

  async stepOut(threadId = 1): Promise<void> {
    await this.request('stepOut', { threadId });
  }

  async pause(threadId = 1): Promise<void> {
    await this.request('pause', { threadId });
  }

  async evaluate(
    expression: string,
    opts?: { frameId?: number; context?: string },
  ): Promise<{ result: string; type?: string; variablesReference: number }> {
    const args: Record<string, unknown> = { expression, context: opts?.context ?? 'repl' };
    if (opts?.frameId !== undefined) args.frameId = opts.frameId;
    return (await this.request('evaluate', args)) as {
      result: string;
      type?: string;
      variablesReference: number;
    };
  }

  async disconnect(terminateDebuggee = true): Promise<void> {
    try {
      await this.request('disconnect', { terminateDebuggee }, 10000);
    } catch {
      /* best effort */
    }
  }

  async terminate(): Promise<void> {
    try {
      await this.request('terminate', {}, 10000);
    } catch {
      /* best effort */
    }
  }

  /** Terminate the session and kill the adapter as a fallback. Never throws. */
  async stop(): Promise<void> {
    if (!this.exitedFlag) {
      try {
        await this.terminate();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!this.exitedFlag) {
      try {
        this.child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
