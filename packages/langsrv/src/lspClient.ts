/**
 * Minimal LSP client over stdio (JSON-RPC, Content-Length framing).
 *
 * Zero dependencies, no bundled server: the server command is supplied
 * by configuration (FACTORY_LANGSRV_LSP_COMMAND, e.g.
 * "typescript-language-server --stdio") and the client is inert when
 * unconfigured. It speaks only what langsrv needs: initialize,
 * textDocument/definition, textDocument/references, textDocument/hover,
 * textDocument/documentSymbol, shutdown/exit.
 *
 * This is the plug-in point the V3 audit asked for: a future configured
 * server (any language) can take over from the built-in semantic engine
 * without changing the route or panel layers. When the server cannot
 * start, times out, or errors, callers get LSP_UNAVAILABLE / LSP_TIMEOUT
 * and the route layer falls back to the semantic engine, then heuristic.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LangSrvError,
  type LangSrvHover,
  type LangSrvLocation,
  type LangSrvOutlineSymbol,
  type LangSrvReference,
} from './types.js';

export interface LspClientOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
}

function toLocation(root: string, loc: LspLocation): LangSrvLocation {
  const abs = uriToPath(loc.uri);
  const rel = abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
  return {
    file: rel,
    line: loc.range.start.line,
    character: loc.range.start.character,
    endLine: loc.range.end.line,
    endCharacter: loc.range.end.character,
  };
}

export class LspClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private proc: ChildProcess | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private started = false;

  constructor(opts: LspClientOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  /** Spawn + initialize. Idempotent; throws LSP_UNAVAILABLE on spawn failure. */
  async start(root: string): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      try {
        this.proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        reject(new LangSrvError('LSP_UNAVAILABLE', `cannot spawn LSP server: ${String(err)}`));
        return;
      }
      const proc = this.proc;
      proc.on('error', (err) => {
        if (!this.started) {
          reject(new LangSrvError('LSP_UNAVAILABLE', `LSP server spawn failed: ${err.message}`));
        }
        this.failAll(err);
      });
      proc.on('exit', () => {
        if (!this.started) reject(new LangSrvError('LSP_UNAVAILABLE', 'LSP server exited during initialize'));
        this.failAll(new Error('LSP server exited'));
      });
      proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
      proc.stderr?.on('data', () => {
        /* Server diagnostics are not surfaced; failures surface as timeouts/errors. */
      });
      const initId = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(initId);
        reject(new LangSrvError('LSP_TIMEOUT', 'LSP initialize timed out'));
      }, this.timeoutMs);
      this.pending.set(initId, {
        resolve: () => {
          clearTimeout(timer);
          this.started = true;
          this.sendNotification('initialized', {});
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      this.sendRequest(initId, 'initialize', {
        processId: null,
        rootUri: `file://${root}`,
        capabilities: {},
        workspaceFolders: [{ uri: `file://${root}`, name: 'root' }],
      });
    });
  }

  private sendRequest(id: number, method: string, params: unknown): void {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.proc?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private sendNotification(method: string, params: unknown): void {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(headerEnd + 4 + len);
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(body) as typeof msg;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new LangSrvError('LSP_UNAVAILABLE', `LSP error: ${msg.error.message ?? 'unknown'}`));
        else p.resolve(msg.result ?? null);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.started || !this.proc) {
      return Promise.reject(new LangSrvError('LSP_UNAVAILABLE', 'LSP client not started'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LangSrvError('LSP_TIMEOUT', `LSP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      this.sendRequest(id, method, params);
    });
  }

  private docParams(root: string, file: string, line: number, character: number): Record<string, unknown> {
    const abs = file.startsWith('/') ? file : `${root}/${file}`;
    return {
      textDocument: { uri: `file://${abs}` },
      position: { line, character },
    };
  }

  async definition(root: string, file: string, line: number, character: number): Promise<LangSrvLocation[]> {
    const res = await this.request<LspLocation | LspLocation[] | null>(
      'textDocument/definition',
      this.docParams(root, file, line, character),
    );
    if (!res) return [];
    const list = Array.isArray(res) ? res : [res];
    return list.map((l) => toLocation(root, l));
  }

  async references(root: string, file: string, line: number, character: number): Promise<LangSrvReference[]> {
    const res = await this.request<LspLocation[] | null>(
      'textDocument/references',
      { ...this.docParams(root, file, line, character), context: { includeDeclaration: true } },
    );
    if (!res) return [];
    return res.map((l) => ({ ...toLocation(root, l), isDefinition: false, isWriteAccess: false }));
  }

  async hover(root: string, file: string, line: number, character: number): Promise<LangSrvHover | null> {
    const res = await this.request<{ contents?: { value?: string } | string } | null>(
      'textDocument/hover',
      this.docParams(root, file, line, character),
    );
    if (!res || !res.contents) return null;
    const display = typeof res.contents === 'string' ? res.contents : (res.contents.value ?? '');
    return { display };
  }

  async outline(root: string, file: string): Promise<LangSrvOutlineSymbol[]> {
    const abs = file.startsWith('/') ? file : `${root}/${file}`;
    const res = await this.request<Array<{ name: string; kind: number; range: LspRange; selectionRange: LspRange }> | null>(
      'textDocument/documentSymbol',
      { textDocument: { uri: `file://${abs}` } },
    );
    if (!res) return [];
    const rel = file.startsWith('/') ? file : file;
    return res.map((s) => ({
      name: s.name,
      kind: String(s.kind),
      file: rel,
      line: s.range.start.line,
      character: s.range.start.character,
      endLine: s.range.end.line,
      endCharacter: s.range.end.character,
    }));
  }

  /** shutdown + exit; never throws. */
  async dispose(): Promise<void> {
    if (!this.proc) return;
    try {
      const id = this.nextId++;
      this.sendRequest(id, 'shutdown', null);
      await new Promise((r) => setTimeout(r, 200));
      this.sendNotification('exit', undefined);
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.started = false;
  }
}
