/**
 * @ai-factory/debugger — minimal Chrome DevTools Protocol client.
 *
 * JSON-RPC over the WebSocket from ws.ts: incrementing numeric ids,
 * a pending map with per-request timeouts (fail-closed), and method-based
 * event dispatch. Flat session only (no Target domain) — one node process.
 */
import { wsConnect, WsClient } from './ws';

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

export class CdpClient {
  private ws: WsClient;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private eventListeners: ((ev: CdpEvent) => void)[] = [];
  private closeListeners: ((code: number, reason: string) => void)[] = [];
  private dead = false;

  constructor(ws: WsClient) {
    this.ws = ws;
    ws.onMessage((text) => this.onText(text));
    ws.onClose((code, reason) => this.handleClose(code, reason));
  }

  static async connect(url: string, timeoutMs = 10000): Promise<CdpClient> {
    const ws = await wsConnect(url, timeoutMs);
    return new CdpClient(ws);
  }

  onEvent(cb: (ev: CdpEvent) => void): void {
    this.eventListeners.push(cb);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeListeners.push(cb);
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    if (this.dead) return Promise.reject(new CdpError('cdp connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`cdp request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.sendText(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  close(): void {
    this.ws.close();
  }

  get closed(): boolean {
    return this.dead || this.ws.closed;
  }

  private onText(text: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return; // not JSON — ignore, keep the connection alive
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(`cdp ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown error'}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const ev: CdpEvent = { method: msg.method, params: msg.params };
      for (const cb of this.eventListeners) {
        try {
          cb(ev);
        } catch {
          /* listener errors must not kill the connection */
        }
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.dead) return;
    this.dead = true;
    const err = new CdpError(`cdp connection closed (${code}): ${reason || 'no reason'}`);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const cb of this.closeListeners) {
      try {
        cb(code, reason);
      } catch {
        /* ignore */
      }
    }
  }
}
