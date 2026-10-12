/**
 * Codex app-server transport — spec §27/§28.
 *
 * Minimal JSON-RPC transport for `codex app-server` (codex-cli ≥ 0.149),
 * zero external dependencies:
 *
 *  - StdioCodexTransport: spawns `codex app-server --stdio` and speaks
 *    NDJSON (one JSON message per line) over the child's stdio.
 *  - WebSocketCodexTransport: connects to an already-running server started
 *    with `codex app-server --listen ws://IP:PORT`, using Node's global
 *    WebSocket (Node ≥ 22). One JSON message per WebSocket frame.
 *
 * Fail-closed rules:
 *  - Server-initiated requests (messages carrying both `id` and `method`,
 *    e.g. approval requests) are always answered with a JSON-RPC error —
 *    this adapter never approves anything on the server's behalf.
 *  - When the process exits / the socket closes, every pending request is
 *    settled with a CodexAdapterError; nothing hangs and nothing is
 *    silently treated as success.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** Any failure talking to a Codex app-server. Never a fake success. */
export class CodexAdapterError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'CodexAdapterError';
  }
}

export type CodexNotificationHandler = (method: string, params: any) => void;

export interface CodexTransport {
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: CodexNotificationHandler): void;
  close(): void;
}

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (err: unknown) => void;
}

/**
 * Shared JSON-RPC plumbing: request/response correlation by incrementing
 * id, notification fan-out, and fail-closed handling of server requests.
 * (The app-server wire format carries no "jsonrpc" field; messages are
 * bare {id, method, params} / {id, result|error} / {method, params}.)
 */
abstract class JsonRpcPeer implements CodexTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers: CodexNotificationHandler[] = [];
  private closed = false;

  protected abstract sendRaw(text: string): void;
  protected abstract teardown(): void;

  request(method: string, params?: unknown): Promise<any> {
    if (this.closed) {
      return Promise.reject(
        new CodexAdapterError(`codex app-server connection is closed (request '${method}')`),
      );
    }
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.sendRaw(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (err) {
        this.pending.delete(id);
        reject(
          new CodexAdapterError(
            `codex app-server: failed to send request '${method}': ${err instanceof Error ? err.message : String(err)}`,
            err,
          ),
        );
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    try {
      this.sendRaw(JSON.stringify(msg));
    } catch {
      // A notification on a dying transport is not recoverable; the pending
      // requests will settle via failAll when the close/exit lands.
    }
  }

  onNotification(handler: CodexNotificationHandler): void {
    this.handlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.failAll(new CodexAdapterError('codex app-server connection closed'));
    this.teardown();
  }

  /** Settle every pending request with an error and mark the peer closed. */
  protected failAll(err: CodexAdapterError): void {
    this.closed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  protected get isClosed(): boolean {
    return this.closed;
  }

  /** Feed one raw inbound message (one NDJSON line / one WS frame). */
  protected handleMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // Not JSON — not a protocol message; ignore.
    }
    if (msg === null || typeof msg !== 'object') return;

    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string' && hasId) {
      // Server-initiated request (e.g. execCommandApproval). Fail closed:
      // refuse with a JSON-RPC error instead of hanging or approving.
      try {
        this.sendRaw(
          JSON.stringify({
            id: msg.id,
            error: {
              code: -32601,
              message: `AI Factory CodexAdapter does not handle server-initiated request '${msg.method}' (fail-closed)`,
            },
          }),
        );
      } catch {
        // Transport already dying; nothing more to do.
      }
      return;
    }
    if (typeof msg.method === 'string') {
      for (const h of this.handlers) {
        try {
          h(msg.method, msg.params);
        } catch {
          // A broken notification consumer must not break the transport.
        }
      }
      return;
    }
    if (hasId) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      if (msg.error) {
        pending.reject(
          new CodexAdapterError(
            `codex app-server error for '${pending.method}': ${msg.error.message ?? JSON.stringify(msg.error)}`,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}

/** Spawns `codex app-server --stdio` (or any command speaking NDJSON). */
export class StdioCodexTransport extends JsonRpcPeer {
  private readonly child: ChildProcess;
  private buffer = '';
  private stderrTail = '';

  constructor(command: string, args: string[]) {
    super();
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      throw new CodexAdapterError(
        `failed to spawn codex app-server ('${command} ${args.join(' ')}'): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    this.child = child;

    child.on('error', (err) => {
      this.failAll(
        new CodexAdapterError(
          `codex app-server spawn failed ('${command}'): ${err.message} — is the codex CLI installed and on PATH?`,
          err,
        ),
      );
    });
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim();
      this.failAll(
        new CodexAdapterError(
          `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` +
            (tail ? `: ${tail.slice(-500)}` : ''),
        ),
      );
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleMessage(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
  }

  protected sendRaw(text: string): void {
    if (!this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('codex app-server stdin is not writable (process gone?)');
    }
    this.child.stdin.write(text + '\n');
  }

  protected teardown(): void {
    try {
      this.child.stdin?.end();
    } catch {
      /* already gone */
    }
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Connects to an already-running `codex app-server --listen ws://…`. */
export class WebSocketCodexTransport extends JsonRpcPeer {
  private constructor(private readonly ws: any) {
    super();
    ws.addEventListener('message', (event: any) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      this.handleMessage(data);
    });
    ws.addEventListener('close', () => {
      this.failAll(new CodexAdapterError('codex app-server websocket closed'));
    });
    ws.addEventListener('error', () => {
      this.failAll(new CodexAdapterError('codex app-server websocket error'));
    });
  }

  static async connect(url: string): Promise<WebSocketCodexTransport> {
    const WS = (globalThis as any).WebSocket as (new (url: string) => any) | undefined;
    if (typeof WS !== 'function') {
      throw new CodexAdapterError(
        'global WebSocket is not available in this Node runtime (need Node ≥ 22) — cannot connect to codex app-server',
      );
    }
    const ws = new WS(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = (): void => {
        ws.removeEventListener('open', onOpen);
        reject(
          new CodexAdapterError(
            `cannot connect to codex app-server at ${url} — is 'codex app-server --listen ${url}' running?`,
          ),
        );
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
    return new WebSocketCodexTransport(ws);
  }

  protected sendRaw(text: string): void {
    this.ws.send(text);
  }

  protected teardown(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
