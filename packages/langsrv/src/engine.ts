/**
 * Precise semantic engine for TypeScript/JavaScript, built on the
 * TypeScript compiler API (ts.LanguageService).
 *
 * Why the compiler API and not an LSP server process or tree-sitter
 * (selection conclusion, written before implementation per the V3 audit):
 *  - External language server (typescript-language-server): not installed
 *    in this repo, npm install is out of scope, and it adds a second
 *    process plus protocol-maintenance cost. The LSP *client* in
 *    lspClient.ts exists so a configured server can still plug in later.
 *  - tree-sitter: a native/wasm external dependency — rejected under the
 *    zero-new-dependency policy (would need a supply-chain exception).
 *  - Compiler API: `typescript` is already in this repo's root
 *    node_modules (root devDependency, used by every build). Zero NEW
 *    dependencies, a real parser + binder + checker, no subprocess.
 *
 * Degradation contract (never fail-closed to "no jump"):
 *  - If `typescript` cannot be resolved at runtime (e.g. a packaged
 *    build without devDependencies), every method throws
 *    TS_UNAVAILABLE and the route layer falls back to the codeindex
 *    heuristic with source 'heuristic' and an explicit warning.
 *  - The engine is on-demand only: no background full-repo scan, so it
 *    cannot slow repomap indexing (V3-#4 perf note: repomap medium
 *    already grows superlinearly; langsrv adds zero indexing passes).
 *  - File set is bounded (MAX_FILES); beyond it the engine throws
 *    TOO_MANY_FILES and the route layer falls back the same way.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as ts from 'typescript';
import {
  LangSrvError,
  type LangSrvHover,
  type LangSrvLocation,
  type LangSrvOutlineSymbol,
  type LangSrvReference,
  type LangSrvRenameEdit,
} from './types.js';

export const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
export const DEFAULT_MAX_FILES = 3000;

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

export interface EngineOptions {
  maxFiles?: number;
  /** Extra per-file exclusion (server passes the ignore gate here). */
  fileFilter?: (root: string, abs: string, isDir: boolean) => boolean;
}

interface CachedFile {
  version: number;
  mtimeMs: number;
  size: number;
  content: string;
}

type TsModule = typeof ts;

/** Lazy, cached dynamic import — a missing module is a soft fallback, never a crash. */
let tsMod: TsModule | null | undefined;
export async function loadTypeScript(): Promise<TsModule | null> {
  if (tsMod !== undefined) return tsMod;
  try {
    const mod = (await import('typescript')) as unknown as { default?: TsModule } & TsModule;
    tsMod = (mod.default ?? mod) as TsModule;
  } catch {
    tsMod = null;
  }
  return tsMod;
}

export function identifierAtPosition(text: string, line: number, character: number): string | null {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) return null;
  const row = lines[line].replace(/\r$/, '');
  if (character < 0 || character > row.length) return null;
  let start = character;
  while (start > 0 && /[\w$]/.test(row[start - 1])) start--;
  let end = character;
  while (end < row.length && /[\w$]/.test(row[end])) end++;
  if (start === end) return null;
  return row.slice(start, end);
}

export class SemanticEngine {
  readonly root: string;
  private readonly maxFiles: number;
  private readonly fileFilter?: EngineOptions['fileFilter'];
  private files = new Map<string, CachedFile>();
  private versionCounter = 0;
  private service: ts.LanguageService | null = null;
  private tsApi: TsModule | null = null;

  constructor(root: string, opts: EngineOptions = {}) {
    this.root = path.resolve(root);
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.fileFilter = opts.fileFilter;
  }

  private async ensureTs(): Promise<TsModule> {
    if (!this.tsApi) {
      const mod = await loadTypeScript();
      if (!mod) {
        throw new LangSrvError(
          'TS_UNAVAILABLE',
          'typescript module not resolvable at runtime; semantic engine unavailable (fallback to heuristic)',
        );
      }
      this.tsApi = mod;
    }
    return this.tsApi;
  }

  /** Resolve a root-relative file inside the root (symlink-safe). */
  private resolveFile(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new LangSrvError('FILE_OUTSIDE_ROOT', `file outside root: ${rel}`);
    }
    if (!SUPPORTED_EXTS.has(path.extname(abs).toLowerCase())) {
      throw new LangSrvError('UNSUPPORTED_EXT', `unsupported extension: ${path.extname(abs)}`);
    }
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw new LangSrvError('ROOT_NOT_FOUND', `file not found: ${rel}`);
    }
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(this.root);
    } catch {
      throw new LangSrvError('ROOT_NOT_FOUND', `root not found: ${this.root}`);
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new LangSrvError('FILE_OUTSIDE_ROOT', `file outside root (symlink): ${rel}`);
    }
    return real;
  }

  private walk(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (this.fileFilter && this.fileFilter(this.root, abs, true)) continue;
        this.walk(abs, out);
      } else if (e.isFile()) {
        if (!SUPPORTED_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        if (this.fileFilter && this.fileFilter(this.root, abs, false)) continue;
        out.push(abs);
      }
      if (out.length > this.maxFiles) return;
    }
  }

  /** Refresh versions for changed files; returns the LanguageService. */
  private async serviceFor(): Promise<{ tsApi: TsModule; service: ts.LanguageService }> {
    const tsApi = await this.ensureTs();
    const found: string[] = [];
    this.walk(this.root, found);
    if (found.length > this.maxFiles) {
      throw new LangSrvError(
        'TOO_MANY_FILES',
        `root has more than ${this.maxFiles} script files (${found.length}); semantic engine refuses, fallback applies`,
      );
    }
    const seen = new Set(found);
    for (const abs of found) {
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const prev = this.files.get(abs);
      if (!prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) {
        let content = '';
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        this.files.set(abs, {
          version: ++this.versionCounter,
          mtimeMs: st.mtimeMs,
          size: st.size,
          content,
        });
      }
    }
    for (const abs of [...this.files.keys()]) {
      if (!seen.has(abs)) this.files.delete(abs);
    }
    if (!this.service) {
      const options: ts.CompilerOptions = {
        allowJs: true,
        checkJs: false,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        target: tsApi.ScriptTarget.ESNext,
        module: tsApi.ModuleKind.ESNext,
        moduleResolution: tsApi.ModuleResolutionKind.Bundler,
        jsx: tsApi.JsxEmit.Preserve,
      };
      const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => options,
        getScriptFileNames: () => [...this.files.keys()],
        getScriptVersion: (f) => String(this.files.get(path.resolve(f))?.version ?? 0),
        getScriptSnapshot: (f) => {
          const c = this.files.get(path.resolve(f));
          if (c) return tsApi.ScriptSnapshot.fromString(c.content);
          try {
            const content = fs.readFileSync(f, 'utf8');
            return tsApi.ScriptSnapshot.fromString(content);
          } catch {
            return undefined;
          }
        },
        getCurrentDirectory: () => this.root,
        getDefaultLibFileName: (o) => tsApi.getDefaultLibFilePath(o),
        fileExists: (f) => {
          try {
            return fs.statSync(f).isFile();
          } catch {
            return false;
          }
        },
        readFile: (f) => {
          try {
            return fs.readFileSync(f, 'utf8');
          } catch {
            return undefined;
          }
        },
        directoryExists: (d) => {
          try {
            return fs.statSync(d).isDirectory();
          } catch {
            return false;
          }
        },
      };
      this.service = tsApi.createLanguageService(host);
    }
    return { tsApi, service: this.service };
  }

  private toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  private async position(
    service: ts.LanguageService,
    rel: string,
    line: number,
    character: number,
  ): Promise<{ abs: string; sf: ts.SourceFile; offset: number }> {
    const abs = this.resolveFile(rel);
    const program = service.getProgram();
    const sf = program?.getSourceFile(abs);
    if (!sf) {
      throw new LangSrvError('ROOT_NOT_FOUND', `file not in program: ${rel}`);
    }
    const starts = sf.getLineStarts();
    if (line < 0 || line >= starts.length) {
      throw new LangSrvError('POSITION_OUT_OF_RANGE', `line ${line} out of range in ${rel}`);
    }
    const lineText = sf.text.slice(starts[line], line + 1 < starts.length ? starts[line + 1] : sf.text.length).replace(/\r?\n$/, '');
    if (character < 0 || character > lineText.length) {
      throw new LangSrvError('POSITION_OUT_OF_RANGE', `character ${character} out of range on line ${line} in ${rel}`);
    }
    return { abs, sf, offset: sf.getPositionOfLineAndCharacter(line, character) };
  }

  private spanToLocation(
    sf: ts.SourceFile,
    abs: string,
    start: number,
    length: number,
    name?: string,
  ): LangSrvLocation {
    const s = sf.getLineAndCharacterOfPosition(start);
    const e = sf.getLineAndCharacterOfPosition(start + length);
    return {
      file: this.toRel(abs),
      line: s.line,
      character: s.character,
      endLine: e.line,
      endCharacter: e.character,
      ...(name ? { name } : {}),
    };
  }

  async definition(rel: string, line: number, character: number): Promise<LangSrvLocation[]> {
    const { service } = await this.serviceFor();
    const { abs, sf, offset } = await this.position(service, rel, line, character);
    const defs = service.getDefinitionAtPosition(abs, offset) ?? [];
    const program = service.getProgram();
    return defs.map((d) => {
      const dsf = program?.getSourceFile(d.fileName);
      if (!dsf) {
        return { file: this.toRel(d.fileName), line: 0, character: 0, endLine: 0, endCharacter: 0 };
      }
      return this.spanToLocation(dsf, d.fileName, d.textSpan.start, d.textSpan.length);
    });
  }

  async references(rel: string, line: number, character: number): Promise<LangSrvReference[]> {
    const { service } = await this.serviceFor();
    const { abs, sf, offset } = await this.position(service, rel, line, character);
    const entries = service.getReferencesAtPosition(abs, offset) ?? [];
    const defs = service.getDefinitionAtPosition(abs, offset) ?? [];
    const defKeys = new Set(defs.map((d) => `${d.fileName}:${d.textSpan.start}:${d.textSpan.length}`));
    const program = service.getProgram();
    const out: LangSrvReference[] = [];
    for (const e of entries) {
      const esf = program?.getSourceFile(e.fileName);
      if (!esf) continue;
      const loc = this.spanToLocation(esf, e.fileName, e.textSpan.start, e.textSpan.length);
      out.push({
        ...loc,
        isDefinition: defKeys.has(`${e.fileName}:${e.textSpan.start}:${e.textSpan.length}`),
        isWriteAccess: e.isWriteAccess,
      });
    }
    return out;
  }

  async hover(rel: string, line: number, character: number): Promise<LangSrvHover | null> {
    const { service } = await this.serviceFor();
    const { abs, sf, offset } = await this.position(service, rel, line, character);
    const info = service.getQuickInfoAtPosition(abs, offset);
    if (!info) return null;
    const display = (info.displayParts ?? []).map((p) => p.text).join('');
    const documentation = (info.documentation ?? []).map((p) => p.text).join('');
    return { display, ...(documentation ? { documentation } : {}) };
  }

  async outline(rel: string): Promise<LangSrvOutlineSymbol[]> {
    const { tsApi, service } = await this.serviceFor();
    const abs = this.resolveFile(rel);
    const program = service.getProgram();
    const sf = program?.getSourceFile(abs) ?? tsApi.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), tsApi.ScriptTarget.ESNext, true);
    const out: LangSrvOutlineSymbol[] = [];
    const visit = (node: ts.Node, inClass: boolean, topLevel: boolean): void => {
      const nameNode = (node as { name?: ts.Node }).name;
      const name = nameNode && tsApi.isIdentifier(nameNode) ? nameNode.text : undefined;
      let kind: string | undefined;
      if (tsApi.isFunctionDeclaration(node)) kind = 'function';
      else if (tsApi.isClassDeclaration(node)) kind = 'class';
      else if (tsApi.isInterfaceDeclaration(node)) kind = 'interface';
      else if (tsApi.isTypeAliasDeclaration(node)) kind = 'type';
      else if (tsApi.isEnumDeclaration(node)) kind = 'enum';
      else if (tsApi.isModuleDeclaration(node)) kind = 'namespace';
      else if (inClass && tsApi.isMethodDeclaration(node)) kind = 'method';
      else if (inClass && tsApi.isMethodSignature(node)) kind = 'method';
      if (kind && name) {
        const s = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const e = sf.getLineAndCharacterOfPosition(node.getEnd());
        out.push({ name, kind, file: this.toRel(abs), line: s.line, character: s.character, endLine: e.line, endCharacter: e.character });
      }
      const nextInClass = inClass || tsApi.isClassDeclaration(node) || tsApi.isInterfaceDeclaration(node);
      const childTop = tsApi.isSourceFile(node);
      if (topLevel && tsApi.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!tsApi.isIdentifier(decl.name)) continue;
          const s = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
          const e = sf.getLineAndCharacterOfPosition(decl.getEnd());
          out.push({ name: decl.name.text, kind: 'variable', file: this.toRel(abs), line: s.line, character: s.character, endLine: e.line, endCharacter: e.character });
        }
      }
      node.forEachChild((c) => visit(c, nextInClass, childTop));
    };
    visit(sf, false, false);
    return out;
  }

  async renamePreview(
    rel: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<{ oldName: string; edits: LangSrvRenameEdit[] }> {
    if (!IDENT_RE.test(newName)) {
      throw new LangSrvError('INVALID_IDENTIFIER', `not a valid identifier: ${newName}`);
    }
    const { service } = await this.serviceFor();
    const { abs, sf } = await this.position(service, rel, line, character);
    const text = fs.readFileSync(abs, 'utf8');
    const oldName = identifierAtPosition(text, line, character);
    if (!oldName) {
      throw new LangSrvError('POSITION_OUT_OF_RANGE', `no identifier at ${line}:${character} in ${rel}`);
    }
    const refs = await this.references(rel, line, character);
    const program = service.getProgram();
    const edits: LangSrvRenameEdit[] = [];
    for (const r of refs) {
      const rAbs = path.resolve(this.root, r.file);
      const rSf = program?.getSourceFile(rAbs);
      if (!rSf) continue;
      const start = rSf.getPositionOfLineAndCharacter(r.line, r.character);
      const end = rSf.getPositionOfLineAndCharacter(r.endLine, r.endCharacter);
      const oldText = rSf.text.slice(start, end);
      if (oldText !== oldName) continue;
      edits.push({ ...r, oldText, newText: newName });
    }
    void sf;
    return { oldName, edits };
  }

  /** Test/diagnostic hook: how many files the engine currently tracks. */
  trackedFiles(): number {
    return this.files.size;
  }
}
