/**
 * LangSrvService — per-root engine cache, optional LSP override, and the
 * auditable query log.
 *
 * Precedence for position queries (definition / references / hover /
 * outline): configured LSP server first, built-in semantic engine
 * second. The route layer adds the third tier (codeindex heuristic)
 * when both fail with TS_UNAVAILABLE / LSP_UNAVAILABLE / TOO_MANY_FILES.
 * Rename-preview is semantic-only: a heuristic cannot safely compute
 * edits, so it fails loudly (409) instead of guessing.
 *
 * LSP configuration is a single env var (no new config file):
 *   FACTORY_LANGSRV_LSP_COMMAND="typescript-language-server --stdio"
 * Unset = LSP inert, semantic engine is the only precise tier.
 */
import { SemanticEngine, type EngineOptions } from './engine.js';
import { LspClient } from './lspClient.js';
import {
  LangSrvError,
  type LangSrvHover,
  type LangSrvLocation,
  type LangSrvOutlineSymbol,
  type LangSrvQueryStat,
  type LangSrvReference,
  type LangSrvRenameEdit,
  type LangSrvSource,
} from './types.js';

export interface LangSrvServiceOptions extends EngineOptions {
  lspCommand?: string;
}

export interface LangSrvStatus {
  semantic: 'unknown' | 'available' | 'unavailable';
  lspConfigured: boolean;
  lspConnected: boolean;
  roots: string[];
  queries: number;
  recent: LangSrvQueryStat[];
}

const MAX_RECENT = 100;

function parseCommand(cmd: string): { command: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0], args: parts.slice(1) };
}

export class LangSrvService {
  private engines = new Map<string, SemanticEngine>();
  private lsp: LspClient | null = null;
  private lspStartedRoot: string | null = null;
  private semanticState: LangSrvStatus['semantic'] = 'unknown';
  private queries = 0;
  private recent: LangSrvQueryStat[] = [];
  private readonly opts: LangSrvServiceOptions;

  constructor(opts: LangSrvServiceOptions = {}) {
    this.opts = opts;
    const cmd = opts.lspCommand ?? process.env.FACTORY_LANGSRV_LSP_COMMAND ?? '';
    if (cmd.trim()) {
      const { command, args } = parseCommand(cmd);
      this.lsp = new LspClient({ command, args });
    }
  }

  private engineFor(root: string): SemanticEngine {
    let e = this.engines.get(root);
    if (!e) {
      e = new SemanticEngine(root, { maxFiles: this.opts.maxFiles, fileFilter: this.opts.fileFilter });
      this.engines.set(root, e);
    }
    return e;
  }

  private log(kind: LangSrvQueryStat['kind'], source: LangSrvSource, file: string, ms: number, results: number): void {
    this.queries++;
    this.recent.push({ at: Date.now(), kind, source, file, ms, results });
    if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
  }

  status(): LangSrvStatus {
    return {
      semantic: this.semanticState,
      lspConfigured: this.lsp !== null,
      lspConnected: this.lspStartedRoot !== null,
      roots: [...this.engines.keys()],
      queries: this.queries,
      recent: [...this.recent],
    };
  }

  /** Try the LSP tier; returns null when LSP is not configured. */
  private async tryLsp<T>(
    root: string,
    fn: (client: LspClient) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    if (!this.lsp) return { ok: false, reason: 'not configured' };
    try {
      if (this.lspStartedRoot !== root) {
        await this.lsp.start(root);
        this.lspStartedRoot = root;
      }
      const value = await fn(this.lsp);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async definition(
    root: string,
    file: string,
    line: number,
    character: number,
  ): Promise<{ source: LangSrvSource; locations: LangSrvLocation[]; warning?: string }> {
    const t0 = Date.now();
    const lsp = await this.tryLsp(root, (c) => c.definition(root, file, line, character));
    if (lsp.ok) {
      this.log('definition', 'lsp', file, Date.now() - t0, lsp.value.length);
      return { source: 'lsp', locations: lsp.value };
    }
    try {
      const locations = await this.engineFor(root).definition(file, line, character);
      this.semanticState = 'available';
      this.log('definition', 'semantic', file, Date.now() - t0, locations.length);
      return {
        source: 'semantic',
        locations,
        ...(this.lsp ? { warning: `LSP unavailable (${lsp.reason}); used semantic engine` } : {}),
      };
    } catch (err) {
      if (err instanceof LangSrvError && err.code === 'TS_UNAVAILABLE') this.semanticState = 'unavailable';
      throw err;
    }
  }

  async references(
    root: string,
    file: string,
    line: number,
    character: number,
  ): Promise<{ source: LangSrvSource; references: LangSrvReference[]; warning?: string }> {
    const t0 = Date.now();
    const lsp = await this.tryLsp(root, (c) => c.references(root, file, line, character));
    if (lsp.ok) {
      this.log('references', 'lsp', file, Date.now() - t0, lsp.value.length);
      return { source: 'lsp', references: lsp.value };
    }
    try {
      const references = await this.engineFor(root).references(file, line, character);
      this.semanticState = 'available';
      this.log('references', 'semantic', file, Date.now() - t0, references.length);
      return {
        source: 'semantic',
        references,
        ...(this.lsp ? { warning: `LSP unavailable (${lsp.reason}); used semantic engine` } : {}),
      };
    } catch (err) {
      if (err instanceof LangSrvError && err.code === 'TS_UNAVAILABLE') this.semanticState = 'unavailable';
      throw err;
    }
  }

  async hover(
    root: string,
    file: string,
    line: number,
    character: number,
  ): Promise<{ source: LangSrvSource; hover: LangSrvHover | null; warning?: string }> {
    const t0 = Date.now();
    const lsp = await this.tryLsp(root, (c) => c.hover(root, file, line, character));
    if (lsp.ok) {
      this.log('hover', 'lsp', file, Date.now() - t0, lsp.value ? 1 : 0);
      return { source: 'lsp', hover: lsp.value };
    }
    try {
      const hover = await this.engineFor(root).hover(file, line, character);
      this.semanticState = 'available';
      this.log('hover', 'semantic', file, Date.now() - t0, hover ? 1 : 0);
      return {
        source: 'semantic',
        hover,
        ...(this.lsp ? { warning: `LSP unavailable (${lsp.reason}); used semantic engine` } : {}),
      };
    } catch (err) {
      if (err instanceof LangSrvError && err.code === 'TS_UNAVAILABLE') this.semanticState = 'unavailable';
      throw err;
    }
  }

  async outline(
    root: string,
    file: string,
  ): Promise<{ source: LangSrvSource; symbols: LangSrvOutlineSymbol[]; warning?: string }> {
    const t0 = Date.now();
    const lsp = await this.tryLsp(root, (c) => c.outline(root, file));
    if (lsp.ok) {
      this.log('outline', 'lsp', file, Date.now() - t0, lsp.value.length);
      return { source: 'lsp', symbols: lsp.value };
    }
    try {
      const symbols = await this.engineFor(root).outline(file);
      this.semanticState = 'available';
      this.log('outline', 'semantic', file, Date.now() - t0, symbols.length);
      return {
        source: 'semantic',
        symbols,
        ...(this.lsp ? { warning: `LSP unavailable (${lsp.reason}); used semantic engine` } : {}),
      };
    } catch (err) {
      if (err instanceof LangSrvError && err.code === 'TS_UNAVAILABLE') this.semanticState = 'unavailable';
      throw err;
    }
  }

  async renamePreview(
    root: string,
    file: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<{ oldName: string; edits: LangSrvRenameEdit[] }> {
    const t0 = Date.now();
    try {
      const res = await this.engineFor(root).renamePreview(file, line, character, newName);
      this.semanticState = 'available';
      this.log('renamePreview', 'semantic', file, Date.now() - t0, res.edits.length);
      return res;
    } catch (err) {
      if (err instanceof LangSrvError && err.code === 'TS_UNAVAILABLE') this.semanticState = 'unavailable';
      throw err;
    }
  }
}
