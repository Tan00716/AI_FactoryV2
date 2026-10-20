/**
 * IgnoreSet — the two-tier ignore-file gate (Cursor-style, zero model).
 *
 * Two layers, loaded from the project root:
 *
 *   <root>/.ai-factory/ignore            HARD tier — invisible to every AI
 *                                         surface: index, @-providers, code
 *                                         search, repo map, backups.
 *   <root>/.ai-factory/indexing-ignore   INDEX tier — excluded from the
 *                                         code index / repo map only; the
 *                                         file can still be referenced
 *                                         explicitly (@diff(file), search
 *                                         of its name, ...).
 *
 * Rules (deterministic, documented):
 *  - A missing file = an empty layer (fine, not an error).
 *  - A present-but-unreadable / invalid-UTF-8 / NUL-containing file =
 *    that LAYER IS LOUDLY SKIPPED (not fail-closed — a broken ignore file
 *    must never silently swallow the whole gate; the caller audits the
 *    skip via errors()). Parsing itself never throws: gitignore is
 *    line-forgiving by design.
 *  - Hot reload: refreshIfChanged() re-stats both files and reloads the
 *    ones whose mtime changed. The server gate calls it on every access
 *    (statSync is cheap; the files are tiny).
 *  - Absolute-path safety: a path outside the root is NOT our
 *    jurisdiction — verdict() returns ignored:false for it. Callers that
 *    must jail paths do so before calling us.
 *
 * HONEST BOUNDARY (also in module doc of matcher.ts): the gate only
 * constrains the tool surfaces that consult it. It cannot stop the OS,
 * another tool, or the operator's own `exec`/`cat` from reading a file —
 * that is by design (the user's own actions are not the AI's context).
 */

import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  evaluateIgnore,
  parseIgnoreText,
  type CompiledIgnorePattern,
} from './matcher.js';

export type IgnoreLayerName = 'hard' | 'indexing';

export const HARD_IGNORE_FILE = '.ai-factory/ignore';
export const INDEXING_IGNORE_FILE = '.ai-factory/indexing-ignore';

/** Ignore files are config — cap them so a runaway file can't DOS us. */
export const MAX_IGNORE_FILE_BYTES = 256 * 1024;
export const MAX_IGNORE_LINES = 10_000;

export interface IgnoreLayerError {
  layer: IgnoreLayerName;
  file: string;
  message: string;
  /** mtime of the file when the error was observed (for audit dedupe). */
  mtimeMs: number | null;
}

export interface IgnoreLayerState {
  name: IgnoreLayerName;
  file: string;
  present: boolean;
  ok: boolean;
  error?: string;
  patternCount: number;
}

export interface IgnoreVerdict {
  ignored: boolean;
  layer?: IgnoreLayerName;
  pattern?: string;
  line?: number;
}

/**
 * A suggested starting template for the hard tier (used by the desktop
 * UI's "insert template" button — never auto-written by the server).
 */
export const DEFAULT_HARD_IGNORE_TEMPLATE = [
  '# AI Factory hard ignore — files matched here are invisible to every',
  '# AI surface: code index, @-context providers, code search, repo map,',
  '# and backups. Glob syntax: * (one segment), ** (any depth),',
  '# ? (one char), ! negates, trailing / = directories only.',
  '',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '**/secrets/**',
  '**/credentials/**',
  'credentials.json',
  'service-account*.json',
  '',
].join('\n');

interface LoadedLayer {
  name: IgnoreLayerName;
  file: string;
  present: boolean;
  mtimeMs: number | null;
  patterns: CompiledIgnorePattern[];
  error: string | null;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function loadLayer(root: string, name: IgnoreLayerName, fileName: string): LoadedLayer {
  const file = join(root, fileName);
  const base: LoadedLayer = {
    name,
    file,
    present: false,
    mtimeMs: null,
    patterns: [],
    error: null,
  };
  let st;
  try {
    st = statSync(file);
  } catch {
    return base; // Missing — an empty layer, not an error.
  }
  if (!st.isFile()) {
    return { ...base, present: true, error: `${fileName} exists but is not a regular file` };
  }
  base.present = true;
  base.mtimeMs = st.mtimeMs;
  if (st.size > MAX_IGNORE_FILE_BYTES) {
    return {
      ...base,
      error: `${fileName} exceeds the ${MAX_IGNORE_FILE_BYTES}-byte cap and was skipped`,
    };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch (e) {
    return { ...base, error: `could not read ${fileName}: ${(e as Error).message}` };
  }
  if (buf.includes(0)) {
    return { ...base, error: `${fileName} contains NUL bytes and was skipped` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ...base, error: `${fileName} is not valid UTF-8 and was skipped` };
  }
  const lineCount = text.split('\n').length;
  if (lineCount > MAX_IGNORE_LINES) {
    return {
      ...base,
      error: `${fileName} exceeds the ${MAX_IGNORE_LINES}-line cap and was skipped`,
    };
  }
  base.patterns = parseIgnoreText(text);
  return base;
}

export class IgnoreSet {
  private constructor(
    readonly root: string,
    private layers: LoadedLayer[],
  ) {}

  /** Load both layers from <root> (synchronous — files are tiny). */
  static loadSync(root: string): IgnoreSet {
    const abs = resolve(root);
    return new IgnoreSet(abs, [
      loadLayer(abs, 'hard', HARD_IGNORE_FILE),
      loadLayer(abs, 'indexing', INDEXING_IGNORE_FILE),
    ]);
  }

  /** Build from raw texts (tests / dry-run editors). null = absent. */
  static fromTexts(
    root: string,
    hard: string | null,
    indexing: string | null,
  ): IgnoreSet {
    const mk = (name: IgnoreLayerName, file: string, text: string | null): LoadedLayer => {
      const base: LoadedLayer = {
        name,
        file,
        present: text !== null,
        mtimeMs: null,
        patterns: [],
        error: null,
      };
      if (text === null) return base;
      if (text.includes('\0')) {
        return { ...base, error: 'contains NUL bytes' };
      }
      base.patterns = parseIgnoreText(text);
      return base;
    };
    const abs = resolve(root);
    return new IgnoreSet(abs, [
      mk('hard', join(abs, HARD_IGNORE_FILE), hard),
      mk('indexing', join(abs, INDEXING_IGNORE_FILE), indexing),
    ]);
  }

  /**
   * Re-stat both files; reload any whose mtime changed. Returns true when
   * at least one layer was reloaded (callers use this to know the gate is
   * hot-reloaded — a loud skip that disappears also disappears from
   * errors()).
   */
  refreshIfChanged(): boolean {
    let changed = false;
    const next = this.layers.map((l) => {
      const fileName = l.name === 'hard' ? HARD_IGNORE_FILE : INDEXING_IGNORE_FILE;
      let mtime: number | null = null;
      try {
        mtime = statSync(l.file).mtimeMs;
      } catch {
        mtime = null; // Absent (or gone since the last load).
      }
      if (mtime === l.mtimeMs) return l;
      changed = true;
      return loadLayer(this.root, l.name, fileName);
    });
    if (changed) this.layers = next;
    return changed;
  }

  /** Loud skips: layers that failed to load (audited by the caller). */
  errors(): IgnoreLayerError[] {
    return this.layers
      .filter((l) => l.error !== null)
      .map((l) => ({
        layer: l.name,
        file: l.file,
        message: l.error as string,
        mtimeMs: l.mtimeMs,
      }));
  }

  layerStates(): IgnoreLayerState[] {
    return this.layers.map((l) => ({
      name: l.name,
      file: l.file,
      present: l.present,
      ok: l.error === null,
      error: l.error ?? undefined,
      patternCount: l.patterns.length,
    }));
  }

  hardPatternCount(): number {
    return this.layers[0]?.patterns.length ?? 0;
  }

  indexingPatternCount(): number {
    return this.layers[1]?.patterns.length ?? 0;
  }

  /**
   * Full verdict for an absolute path. `forIndex=true` additionally
   * consults the indexing tier (the hard tier always applies). Returns
   * which layer/pattern/line matched so UIs can surface it instead of
   * staying silent.
   */
  verdict(absPath: string, forIndex = false, isDir = false): IgnoreVerdict {
    const rel = toPosix(relative(this.root, absPath));
    if (rel === '' || rel.startsWith('..') || rel === '..') {
      return { ignored: false }; // Outside the root — not our jurisdiction.
    }
    const order: LoadedLayer[] = forIndex
      ? [this.layers[0] as LoadedLayer, this.layers[1] as LoadedLayer]
      : [this.layers[0] as LoadedLayer];
    for (const layer of order) {
      if (layer.error !== null) continue; // Loud-skipped layers match nothing.
      const hit = evaluateIgnore(rel, isDir, layer.patterns);
      if (hit.ignored && hit.pattern) {
        return {
          ignored: true,
          layer: layer.name,
          pattern: (hit.pattern.negated ? '!' : '') + hit.pattern.source,
          line: hit.pattern.line,
        };
      }
    }
    return { ignored: false };
  }

  /** Boolean shorthand over verdict(). */
  isIgnored(absPath: string, forIndex = false, isDir = false): boolean {
    return this.verdict(absPath, forIndex, isDir).ignored;
  }

  /**
   * Directory verdict for walk pruning: a directory whose own path is
   * excluded prunes its whole subtree (sticky semantics from
   * evaluateIgnore).
   */
  isDirIgnored(absDir: string, forIndex = false): boolean {
    const rel = toPosix(relative(this.root, absDir));
    if (rel === '' || rel.startsWith('..')) return false;
    const order: LoadedLayer[] = forIndex
      ? [this.layers[0] as LoadedLayer, this.layers[1] as LoadedLayer]
      : [this.layers[0] as LoadedLayer];
    for (const layer of order) {
      if (layer.error !== null) continue;
      const hit = evaluateIgnore(rel, true, layer.patterns);
      if (hit.ignored && hit.pattern) return true;
    }
    return false;
  }
}
