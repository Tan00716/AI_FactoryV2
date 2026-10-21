/**
 * Change impact / blast-radius analysis (second-round suggestion ⑥,
 * Augment Code Microservices Impact Analysis-style).
 *
 * What it is: a deterministic, model-free analysis with two parts:
 *   1. Reverse-reference impact: given a set of changed files, walk the
 *      codeindex reference graph BACKWARDS (who references the changed
 *      files' symbols, then who references those referrers, …) and
 *      report the affected files in BFS hop layers with edge evidence.
 *   2. API contract diff: extract the export surface of each changed
 *      file (heuristically) from the baseline (git ref) and the new
 *      content, and classify changes as breaking (removed / renamed /
 *      signature-changed / kind-changed) or non-breaking (added).
 *
 * HONEST BOUNDARIES (documented, not hidden):
 *   - The reference graph is NAME-BASED, not semantic (same heuristic
 *     as @ai-factory/repomap): same-named symbols in different scopes
 *     are conflated, which produces noise. The analysis is ADVISORY,
 *     not a proof — and "not listed" never means "proven unaffected".
 *   - Dynamic imports, reflection (`getattr`, `eval`), and generated
 *     code are invisible to the graph.
 *   - Export extraction is regex-based and compares only the first
 *     declaration line of each export; multi-line signatures compare
 *     on their first line. A signature edited only on line 2+ is
 *     MISSED — the UI says so explicitly.
 *   - Scanning the graph never proves "no downstream effect".
 *
 * This module is pure node builtins (+ a type-only import of the
 * codeindex IndexData shape): tests may import it straight from src
 * under node's type-stripping ESM loader (AGENTS.md dual-mode import
 * rule). Git access is via `git -C` subprocesses — read-only commands
 * (`show`, `diff --name-only`, `ls-files`) only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { IndexData } from '@ai-factory/codeindex';

// ---------------------------------------------------------------------------
// Export surface extraction
// ---------------------------------------------------------------------------

/** One extracted export declaration. */
export interface ExportDecl {
  /** Exported name ('default' when anonymous). */
  name: string;
  /** Symbol kind (function/class/variable/interface/type/enum/method/export). */
  kind: string;
  /** Normalized first-line signature (contract text). */
  signature: string;
  /** 1-based declaration line. */
  line: number;
}

/** Languages the heuristic extractor supports. */
export function supportedImpactExts(): string[] {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.go'];
}

export function isImpactSupportedExt(rel: string): boolean {
  const dot = rel.lastIndexOf('.');
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  return supportedImpactExts().includes(ext);
}

interface ExportPattern {
  re: RegExp;
  kind: string;
  nameGroup: number;
  /** Capture group holding the signature text (undefined → signatureFromLine). */
  sigGroup?: number;
}

const TS_JS_EXPORTS: ExportPattern[] = [
  {
    re: /^\s*export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    kind: 'function',
    nameGroup: 1,
  },
  {
    re: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
    nameGroup: 1,
  },
  {
    re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    kind: 'variable',
    nameGroup: 1,
  },
  {
    re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/,
    kind: 'interface',
    nameGroup: 1,
  },
  {
    re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/,
    kind: 'type',
    nameGroup: 1,
  },
  {
    re: /^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/,
    kind: 'enum',
    nameGroup: 1,
  },
  {
    re: /^\s*export\s+default\s+function\s*(?:([A-Za-z_$][\w$]*))?/,
    kind: 'function',
    nameGroup: 1,
  },
];

const PY_EXPORTS: ExportPattern[] = [
  { re: /^def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function', nameGroup: 1 },
  { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class', nameGroup: 1 },
  { re: /^([A-Z][A-Z0-9_]+)\s*=/, kind: 'variable', nameGroup: 1 },
];

const GO_EXPORTS: ExportPattern[] = [
  { re: /^func\s+([A-Z]\w*)\s*\(/, kind: 'function', nameGroup: 1 },
  { re: /^func\s+\([^)]*\)\s+([A-Z]\w*)\s*\(/, kind: 'method', nameGroup: 1 },
  { re: /^type\s+([A-Z]\w*)\b/, kind: 'type', nameGroup: 1 },
  { re: /^(?:var|const)\s+([A-Z]\w*)\b/, kind: 'variable', nameGroup: 1 },
];

function patternsFor(rel: string): ExportPattern[] | null {
  const dot = rel.lastIndexOf('.');
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) return TS_JS_EXPORTS;
  if (ext === '.py') return PY_EXPORTS;
  if (ext === '.go') return GO_EXPORTS;
  return null;
}

/** Collapse whitespace runs and drop a trailing `{`. */
function normalizeSignature(s: string): string {
  return s
    .replace(/\{[\s\{]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const MAX_EXTRACT_BYTES = 2 * 1024 * 1024;

export interface ExtractedExports {
  supported: boolean;
  exports: ExportDecl[];
}

/**
 * Extract the export surface of a file (heuristic, first-line
 * signatures only). Returns supported=false for unhandled languages
 * instead of pretending.
 */
export function extractExports(rel: string, text: string): ExtractedExports {
  const patterns = patternsFor(rel);
  if (!patterns) return { supported: false, exports: [] };
  if (text.length > MAX_EXTRACT_BYTES) return { supported: false, exports: [] };
  const out: ExportDecl[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trimStart();
    // Cheap guard against comment-sourced false positives.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) continue;
    let matched = false;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m) {
        matched = true;
        let name = m[p.nameGroup] ?? '';
        if (!name) name = 'default';
        // Python dunder/underscore privacy: skip _private names (heuristic).
        if (patterns === PY_EXPORTS && name.startsWith('_')) break;
        const key = `${name}:${p.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            name,
            kind: p.kind,
            signature: normalizeSignature(line),
            line: i + 1,
          });
        }
        break;
      }
    }
    // `export { a, b as c }` / `export { x } from "./m"` list exports
    // (no signature info beyond the exported name).
    if (!matched && patterns === TS_JS_EXPORTS) {
      const lm = /^\s*export\s*\{([^}]*)\}/.exec(line);
      if (lm) {
        for (const part of lm[1].split(',')) {
          const nm = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
          if (nm) {
            const name = nm[2] ?? nm[1];
            const key = `${name}:export`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ name, kind: 'export', signature: `export { ${name} }`, line: i + 1 });
            }
          }
        }
      }
    }
  }
  return { supported: true, exports: out };
}

// ---------------------------------------------------------------------------
// API contract diff
// ---------------------------------------------------------------------------

export type ContractChangeKind = 'removed' | 'added' | 'signature-changed' | 'kind-changed';

export interface ContractChange {
  name: string;
  kind: string;
  change: ContractChangeKind;
  /** True when consumers of this export can break. */
  breaking: boolean;
  before: string | null;
  after: string | null;
  /** Human-readable reason (carries the heuristic caveats). */
  reason: string;
}

/**
 * Diff two export surfaces. Deterministic (sorted by name). Renames are
 * reported as a removed+added pair; when an added export carries an
 * identical signature to a removed one a "possible rename" hint is
 * attached — still breaking for importers, so it stays breaking.
 */
export function diffContracts(
  before: ExportDecl[],
  after: ExportDecl[],
): ContractChange[] {
  const bMap = new Map<string, ExportDecl>();
  for (const e of before) {
    if (!bMap.has(e.name)) bMap.set(e.name, e);
  }
  const aMap = new Map<string, ExportDecl>();
  for (const e of after) {
    if (!aMap.has(e.name)) aMap.set(e.name, e);
  }
  const removed: ExportDecl[] = [];
  const added: ExportDecl[] = [];
  for (const [name, b] of bMap) {
    if (!aMap.has(name)) removed.push(b);
  }
  for (const [name, a] of aMap) {
    if (!bMap.has(name)) added.push(a);
  }
  // Rename hint: removed + added with identical normalized signatures.
  const renameHint = new Map<string, string>(); // removedName → addedName
  for (const r of removed) {
    for (const a of added) {
      if (r.signature === a.signature && r.name !== a.name) {
        if (!renameHint.has(r.name)) renameHint.set(r.name, a.name);
      }
    }
  }
  const out: ContractChange[] = [];
  for (const r of removed) {
    const hint = renameHint.get(r.name);
    out.push({
      name: r.name,
      kind: r.kind,
      change: 'removed',
      breaking: true,
      before: r.signature,
      after: null,
      reason: hint
        ? `export removed; an added export '${hint}' has an identical signature — possible rename (still breaking for importers)`
        : 'export removed — every importer breaks',
    });
  }
  for (const a of added) {
    out.push({
      name: a.name,
      kind: a.kind,
      change: 'added',
      breaking: false,
      before: null,
      after: a.signature,
      reason: 'new export — additive, non-breaking',
    });
  }
  for (const [name, b] of bMap) {
    const a = aMap.get(name);
    if (!a) continue;
    if (a.kind !== b.kind) {
      out.push({
        name,
        kind: `${b.kind}→${a.kind}`,
        change: 'kind-changed',
        breaking: true,
        before: b.signature,
        after: a.signature,
        reason: `export kind changed (${b.kind} → ${a.kind}) — breaking`,
      });
    } else if (a.signature !== b.signature) {
      out.push({
        name,
        kind: b.kind,
        change: 'signature-changed',
        breaking: true,
        before: b.signature,
        after: a.signature,
        reason:
          'signature changed (first declaration line) — heuristic, verify manually; callers may break',
      });
    }
  }
  out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Report shape (server route + gate summary assembly in routes/impact.ts)
// ---------------------------------------------------------------------------

/** Contract diff for one changed file. */
export interface FileContractReport {
  file: string;
  /** False when the extension is unsupported or the file is too large —
   * the contract diff is skipped (never pretended). */
  supported: boolean;
  /** True when the baseline (git ref) had no such file. */
  baselineMissing: boolean;
  beforeCount: number;
  afterCount: number;
  changes: ContractChange[];
  note?: string;
}

/** Full impact report returned by the API. */
export interface ImpactReport {
  root: string;
  source: 'files' | 'pr' | 'working-tree';
  changedFiles: string[];
  affectedFiles: string[];
  layers: ImpactLayer[];
  edges: ImpactEdge[];
  contracts: FileContractReport[];
  breakingCount: number;
  nonBreakingCount: number;
  truncated: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Reverse-reference impact (BFS over the codeindex graph, backwards)
// ---------------------------------------------------------------------------

export interface ImpactEdge {
  /** The changed file whose symbol is referenced. */
  changedFile: string;
  /** The file doing the referencing. */
  fromFile: string;
  /** The referenced symbol name. */
  symbol: string;
  /** Referencing line (from the inverted index), null when unknown. */
  line: number | null;
  /** BFS hop distance from the change (1 = direct reference). */
  hop: number;
}

export interface ImpactLayer {
  hop: number;
  files: string[];
}

export interface RefsImpact {
  changedFiles: string[];
  layers: ImpactLayer[];
  edges: ImpactEdge[];
  /** Every affected file across all layers, sorted. */
  affectedFiles: string[];
  truncated: boolean;
}

export interface RefsImpactOptions {
  /** BFS depth cap (default 3). */
  maxDepth?: number;
  /** Max affected files collected (default 500). */
  maxFiles?: number;
  /** Max evidence edges collected (default 2000). */
  maxEdges?: number;
  /**
   * Symbols the changed files defined in the BASELINE (e.g. removed
   * exports, extracted from the git-ref content). The index is built
   * from the current working tree, where those symbols no longer exist
   * — so they are merged into the frontier by name, and the file is
   * treated as their definer. rel → symbol names.
   */
  extraSymbols?: Record<string, string[]>;
}

export const REFS_HONEST_NOTES = [
  'reference graph is name-based (not semantic): same-named symbols in different scopes are conflated — expect some noise',
  'files that are NOT listed are not proven unaffected: dynamic imports, reflection and generated code are invisible to the graph',
  'analysis is advisory — it never proves (no) downstream effect',
];

/** Normalize a user-supplied path to the index's posix-relative form. */
function normRel(p: string): string {
  let rel = p.trim().replace(/\\/g, '/');
  while (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

/**
 * Walk the reference graph backwards from the changed files:
 * hop 1 = files referencing any symbol defined in a changed file;
 * hop 2 = files referencing symbols defined in hop-1 files; …
 * A file is never its own downstream (changed files are seeded as
 * visited). Deterministic: same index in, same report out.
 */
export function analyzeRefs(
  index: IndexData,
  changedFiles: string[],
  opts: RefsImpactOptions = {},
): RefsImpact {
  const maxDepth = Math.max(1, Math.min(10, Math.floor(opts.maxDepth ?? 3)));
  const maxFiles = Math.max(1, Math.min(10000, Math.floor(opts.maxFiles ?? 500)));
  const maxEdges = Math.max(1, Math.min(50000, Math.floor(opts.maxEdges ?? 2000)));

  // name (lowercase) → files defining it.
  const defFiles = new Map<string, Set<string>>();
  // file → names defined in it (index symbols + baseline extras).
  const fileNames = new Map<string, string[]>();
  const addDef = (file: string, name: string) => {
    const key = name.toLowerCase();
    let set = defFiles.get(key);
    if (!set) {
      set = new Set();
      defFiles.set(key, set);
    }
    set.add(file);
    const arr = fileNames.get(file);
    if (arr) {
      if (!arr.includes(name)) arr.push(name);
    } else {
      fileNames.set(file, [name]);
    }
  };
  for (const s of index.symbols) addDef(s.file, s.name);
  for (const [rel, names] of Object.entries(opts.extraSymbols ?? {})) {
    for (const n of names) addDef(normRel(rel), n);
  }

  const changed = changedFiles.map(normRel).filter(Boolean);
  const visited = new Set<string>(changed);
  const layers: ImpactLayer[] = [];
  const edges: ImpactEdge[] = [];
  let truncated = false;
  let frontier = changed;

  for (let hop = 1; hop <= maxDepth; hop++) {
    const next = new Map<string, { edge: ImpactEdge }>();
    for (const file of frontier) {
      const names = fileNames.get(file) ?? [];
      for (const name of names) {
        const key = name.toLowerCase();
        const postings = index.inverted[key] ?? [];
        const definers = defFiles.get(key) ?? new Set<string>();
        for (const [fi, ln] of postings) {
          const rel = index.files[fi]?.rel;
          if (!rel) continue;
          // A defining file does not "reference" itself.
          if (definers.has(rel)) continue;
          if (visited.has(rel)) continue;
          if (!next.has(rel)) {
            next.set(rel, {
              edge: {
                changedFile: file,
                fromFile: rel,
                symbol: name,
                line: typeof ln === 'number' ? ln : null,
                hop,
              },
            });
          }
        }
      }
    }
    if (next.size === 0) break;
    // Cap affected files (deterministic: sorted before slicing).
    let layerFiles = [...next.keys()].sort();
    if (visited.size + layerFiles.length > maxFiles) {
      layerFiles = layerFiles.slice(0, Math.max(0, maxFiles - visited.size));
      truncated = true;
    }
    const hopEdges: ImpactEdge[] = [];
    for (const f of layerFiles) {
      const e = next.get(f)!.edge;
      hopEdges.push(e);
      visited.add(f);
    }
    hopEdges.sort((a, b) =>
      a.fromFile < b.fromFile ? -1 : a.fromFile > b.fromFile ? 1 : a.symbol < b.symbol ? -1 : 1,
    );
    for (const e of hopEdges) {
      if (edges.length >= maxEdges) {
        truncated = true;
        break;
      }
      edges.push(e);
    }
    layers.push({ hop, files: layerFiles });
    if (truncated) break;
    frontier = layerFiles;
  }

  const affectedFiles = layers.flatMap((l) => l.files).sort();
  return { changedFiles: changed, layers, edges, affectedFiles, truncated };
}

// ---------------------------------------------------------------------------
// Git helpers (read-only: show / diff --name-only / ls-files)
// ---------------------------------------------------------------------------

const GIT_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function isValidGitRef(ref: string): boolean {
  return GIT_REF_RE.test(ref);
}

/** Reject absolute paths, '..' escapes, and git-magic characters. */
function isSafeRel(rel: string): boolean {
  if (!rel || rel.includes('\0') || rel.includes(':')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  const parts = rel.replace(/\\/g, '/').split('/');
  return parts.every((p) => p !== '..' && p !== '');
}

/**
 * Read `ref:rel` content from a git repo. Null on any failure
 * (not a repo, bad ref, path not in ref, too large).
 */
export function readGitFile(
  repoDir: string,
  ref: string,
  rel: string,
): string | null {
  if (!isValidGitRef(ref) || !isSafeRel(rel)) return null;
  try {
    const out = execFileSync('git', ['-C', repoDir, 'show', `${ref}:${rel}`], {
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out as string;
  } catch {
    return null;
  }
}

/**
 * Changed files vs `ref`: tracked modifications plus untracked new
 * files (a new file's whole export surface is "added"). Null when git
 * cannot answer (not a repo, missing ref).
 */
export function workingTreeChangedFiles(
  repoDir: string,
  ref = 'HEAD',
): string[] | null {
  if (!isValidGitRef(ref)) return null;
  try {
    const set = new Set<string>();
    const diffOut = execFileSync(
      'git',
      ['-C', repoDir, 'diff', '--name-only', '-z', ref, '--'],
      { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ) as string;
    const untrackedOut = execFileSync(
      'git',
      ['-C', repoDir, 'ls-files', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ) as string;
    for (const raw of diffOut.split('\0').concat(untrackedOut.split('\0'))) {
      const f = raw.trim();
      if (f && isSafeRel(f)) set.add(f);
    }
    return [...set].sort();
  } catch {
    return null;
  }
}

/**
 * Read the working-tree file inside a jailed root. Null when missing,
 * escaping the root (incl. symlink escape), or unreadable.
 */
export function readRootFile(rootAbs: string, rel: string): string | null {
  if (!isSafeRel(rel)) return null;
  try {
    const abs = resolve(rootAbs, rel);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_EXTRACT_BYTES) return null;
    const real = realpathSync(abs);
    if (real !== rootAbs && !real.startsWith(rootAbs + sep)) return null;
    return readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}
