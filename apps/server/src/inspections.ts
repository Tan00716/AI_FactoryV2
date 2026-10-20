/**
 * Team quality gates (deterministic static inspections, Qodana-style).
 *
 * What it is: a zero-model inspection runner for the project. A set of
 * small, fully deterministic checkers scans the inspected root and
 * reports findings; a committed profile (`.ai-factory/inspections.json`)
 * selects checkers and thresholds so the whole team shares one gate;
 * a baseline (`.ai-factory/inspections-baseline.json`) makes the gate
 * complain only about NEW findings; the server keeps a run history so
 * the desktop can draw a trend; and a license audit summarizes the
 * declared licenses of installed dependencies.
 *
 * What it is NOT (honest boundary — also surfaced in the desktop UI):
 *   - The checkers are heuristic static rules, not semantic analysis.
 *     "long-function" is brace-balance bookkeeping, not a parser;
 *     "todo-fixme" is a regex; "console-log" is a regex. They can miss
 *     and they can misfire; thresholds are tunable in the profile.
 *   - The license audit reads the `license` field of each installed
 *     package's package.json and classifies it against a small
 *     hand-maintained list. That field can be missing, stale, or wrong,
 *     so anything unrecognized is reported as "unknown" — never guessed.
 *   - The baseline only reports NEW findings relative to the last
 *     recorded baseline. A green gate means "nothing new since the
 *     baseline", not "no problems". Updating the baseline is an explicit,
 *     audited operator action.
 *
 * Independent of the task-1 lint/test quality gate: this module never
 * imports quality-gate.ts. The two solve different problems — that one
 * runs the project's own lint/test commands, this one runs built-in
 * static checks.
 *
 * Roots jail: the inspected root must resolve inside FACTORY_INSPECT_ROOTS
 * (path-delimiter separated; default: the server process cwd). Anything
 * outside is refused fail-closed (InspectionRootError → HTTP 403).
 *
 * History store: AI_FACTORY_DATA_DIR/inspections-history.json, atomic
 * temp+rename writes. A corrupt store is fail-closed (accessors throw,
 * routes answer 500) — never silently running with half a history.
 *
 * Pure node builtins (+ type-only imports): tests may import it straight
 * from src under node's type-stripping ESM loader.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { delimiter, join, relative, resolve, sep } from 'node:path';

export type InspectionSeverity = 'info' | 'warning' | 'error';

/** One deterministic finding. */
export interface Finding {
  /** Short deterministic id: sha1(signature).slice(0, 12). */
  id: string;
  checker: string;
  severity: InspectionSeverity;
  /** Path relative to the inspected root, forward slashes. */
  file: string;
  line: number | null;
  message: string;
  detail?: string;
}

/** Baseline-stable identity of a finding. */
export function findingSignature(f: Pick<Finding, 'checker' | 'file' | 'line' | 'message'>): string {
  const norm = f.message.trim().replace(/\s+/g, ' ');
  return [f.checker, f.file, f.line ?? '', norm].join('\0');
}

export function findingId(f: Pick<Finding, 'checker' | 'file' | 'line' | 'message'>): string {
  return createHash('sha1').update(findingSignature(f), 'utf8').digest('hex').slice(0, 12);
}

/** A named static checker. */
export interface Checker {
  /** Stable id, e.g. 'todo-fixme'. */
  name: string;
  /** One-line description for UI/docs. */
  description: string;
  /** Scan one file; return zero or more findings. */
  run(args: { file: string; lines: string[] }): Finding[];
}

export interface ScanContext {
  /** Absolute root being inspected. */
  root: string;
  /** Files as { rel, abs } pairs (relative uses forward slashes). */
  files: Array<{ rel: string; abs: string }>;
}

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor', '__pycache__', 'target', '.idea', '.vscode',
]);
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_SCAN_FILES = 20_000;

function readLines(abs: string): string[] | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = readFileSync(abs);
    // Binary sniff: NUL byte in the first 4KB.
    if (buf.subarray(0, 4096).includes(0)) return null;
    return buf.toString('utf8').split('\n');
  } catch {
    return null;
  }
}

/** Walk root, returning scannable source files (deterministic order). */
export function collectSourceFiles(root: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_SCAN_FILES) return;
    let entries: Dirent<string>[];
    try {
      // @types/node v24 types this overload as Dirent<NonSharedBuffer>[];
      // the runtime value has string names — cast keeps the declared type.
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent<string>[];
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.isDirectory() && e.name !== '.ai-factory') continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.isSymbolicLink()) walk(abs);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : '';
        if (SCAN_EXTS.has(ext)) {
          const rel = relative(root, abs).split(sep).join('/');
          out.push({ rel, abs });
          if (out.length >= MAX_SCAN_FILES) return;
        }
      }
    }
  };
  walk(root);
  return out;
}

const TODO_RE = /\b(TODO|FIXME|XXX|HACK)\b\s*:?\s*(.{0,120})/;

/** todo-fixme: one info finding per TODO/FIXME marker occurrence. */
export const todoFixmeChecker: Checker = {
  name: 'todo-fixme',
  description: 'Counts TODO / FIXME / XXX / HACK markers in comments and strings.',
  run({ file, lines }) {
    const out: Finding[] = [];
    lines.forEach((ln, i) => {
      const m = TODO_RE.exec(ln);
      if (m) {
        const body = { checker: 'todo-fixme', file, line: i + 1, message: `${m[1]}: ${m[2].trim() || '(no note)'}` };
        out.push({ ...body, id: findingId(body), severity: 'info' });
      }
    });
    return out;
  },
};

/** long-file: one warning per file over the line budget. */
export function makeLongFileChecker(maxFileLines: number): Checker {
  return {
    name: 'long-file',
    description: `Flags files longer than ${maxFileLines} lines (heuristic; tune in the profile).`,
    run({ file, lines }) {
      if (lines.length <= maxFileLines) return [];
      const body = {
        checker: 'long-file',
        file,
        line: null,
        message: `${lines.length} lines exceeds the ${maxFileLines}-line budget`,
      };
      return [{ ...body, id: findingId(body), severity: 'warning' }];
    },
  };
}

// Heuristic function-start patterns (brace balance does the rest).
const FUNC_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(/, // function foo(
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, // const f = (...) =>
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?function\s*\(/, // const f = function(
  /^\s*(?:public|private|protected|static|\s)*\s*(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*(?::\s*[\w$<>\[\]| ]+)?\s*\{\s*$/, // method foo() {
  /^\s*def\s+([\w$]+)\s*\(/, // python def
];

function isTestFile(rel: string): boolean {
  return /(^|\/)__tests__\//.test(rel) || /\.test\.[a-z]+$/.test(rel) || /\.spec\.[a-z]+$/.test(rel) || /(^|\/)tests?\//.test(rel);
}

/**
 * long-function: brace-balance heuristic. From each function-start line,
 * find the first `{` at/after it, then count lines until the matching
 * close brace. No parser — nested braces, strings with braces, and
 * comments can all throw the balance off; documented as heuristic.
 */
export function makeLongFunctionChecker(maxFunctionLines: number): Checker {
  return {
    name: 'long-function',
    description: `Flags functions longer than ${maxFunctionLines} lines (brace-balance heuristic, not a parser).`,
    run({ file, lines }) {
      const out: Finding[] = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        let name: string | null = null;
        for (const p of FUNC_PATTERNS) {
          const m = p.exec(ln);
          if (m) {
            name = m[1];
            break;
          }
        }
        if (!name) continue;
        // Find the opening brace (may be on a later line).
        let depth = 0;
        let opened = false;
        let end = -1;
        for (let j = i; j < lines.length; j++) {
          const s = lines[j];
          for (let k = 0; k < s.length; k++) {
            const ch = s[k];
            if (ch === '{') {
              depth++;
              opened = true;
            } else if (ch === '}') {
              depth--;
              if (opened && depth === 0) {
                end = j;
                break;
              }
            }
          }
          if (end >= 0) break;
          // Give up after a huge unbalanced region.
          if (j - i > maxFunctionLines * 4) break;
        }
        if (end >= 0) {
          const len = end - i + 1;
          if (len > maxFunctionLines) {
            const body = {
              checker: 'long-function',
              file,
              line: i + 1,
              message: `${name}() spans ${len} lines (budget ${maxFunctionLines}) — heuristic, verify by reading`,
            };
            out.push({ ...body, id: findingId(body), severity: 'warning' });
          }
        }
      }
      return out;
    },
  };
}

const CONSOLE_RE = /\bconsole\s*\.\s*(log|debug|info|warn|error|trace|dir|table)\s*\(/;

/** console-log: residual console.* calls outside test files. */
export const consoleLogChecker: Checker = {
  name: 'console-log',
  description: 'Flags console.* calls in non-test files (production-code smell).',
  run({ file, lines }) {
    if (isTestFile(file)) return [];
    const out: Finding[] = [];
    lines.forEach((ln, i) => {
      const m = CONSOLE_RE.exec(ln);
      if (m) {
        const body = { checker: 'console-log', file, line: i + 1, message: `console.${m[1]}() in non-test code` };
        out.push({ ...body, id: findingId(body), severity: 'warning' });
      }
    });
    return out;
  },
};

/** All built-in checkers by name (the extensible registry). */
export function builtinCheckers(profile: InspectionProfile): Checker[] {
  const enabled = (name: string): boolean => profile.checkers[name] !== false;
  const out: Checker[] = [];
  if (enabled('todo-fixme')) out.push(todoFixmeChecker);
  if (enabled('long-file')) out.push(makeLongFileChecker(profile.maxFileLines));
  if (enabled('long-function')) out.push(makeLongFunctionChecker(profile.maxFunctionLines));
  if (enabled('console-log')) out.push(consoleLogChecker);
  return out;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface InspectionProfile {
  version: 1;
  name: string;
  maxFileLines: number;
  maxFunctionLines: number;
  checkers: Record<string, boolean>;
  licenseAudit: boolean;
}

export const KNOWN_CHECKERS = ['todo-fixme', 'long-file', 'long-function', 'console-log'] as const;

export function defaultInspectionProfile(): InspectionProfile {
  return {
    version: 1,
    name: 'default',
    maxFileLines: 1000,
    maxFunctionLines: 150,
    checkers: { 'todo-fixme': true, 'long-file': true, 'long-function': true, 'console-log': true },
    licenseAudit: true,
  };
}

export interface InspectionProfileInput {
  name?: unknown;
  maxFileLines?: unknown;
  maxFunctionLines?: unknown;
  checkers?: unknown;
  licenseAudit?: unknown;
}

function intInRange(v: unknown, min: number, max: number): number | null {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v.trim());
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

export function validateInspectionProfile(input: InspectionProfileInput): { profile: InspectionProfile; errors: string[] } {
  const errors: string[] = [];
  const p = defaultInspectionProfile();
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) {
      errors.push('name must be a non-empty string (max 80 chars)');
    } else {
      p.name = input.name.trim();
    }
  }
  if (input.maxFileLines !== undefined) {
    const n = intInRange(input.maxFileLines, 10, 100_000);
    if (n === null) errors.push('maxFileLines must be an integer 10..100000');
    else p.maxFileLines = n;
  }
  if (input.maxFunctionLines !== undefined) {
    const n = intInRange(input.maxFunctionLines, 5, 10_000);
    if (n === null) errors.push('maxFunctionLines must be an integer 5..10000');
    else p.maxFunctionLines = n;
  }
  if (input.checkers !== undefined) {
    if (input.checkers === null || typeof input.checkers !== 'object' || Array.isArray(input.checkers)) {
      errors.push('checkers must be an object mapping checker name to boolean');
    } else {
      for (const [k, v] of Object.entries(input.checkers as Record<string, unknown>)) {
        if (!(KNOWN_CHECKERS as readonly string[]).includes(k)) {
          errors.push(`unknown checker: ${k}`);
          continue;
        }
        if (typeof v !== 'boolean') {
          errors.push(`checkers.${k} must be a boolean`);
          continue;
        }
        p.checkers[k] = v;
      }
    }
  }
  if (input.licenseAudit !== undefined) {
    if (typeof input.licenseAudit !== 'boolean') errors.push('licenseAudit must be a boolean');
    else p.licenseAudit = input.licenseAudit;
  }
  return { profile: p, errors };
}

export function profileFilePath(root: string): string {
  return join(root, '.ai-factory', 'inspections.json');
}

export function baselineFilePath(root: string): string {
  return join(root, '.ai-factory', 'inspections-baseline.json');
}

export type ProfileSource = 'file' | 'default-missing' | 'default-corrupt';

/**
 * Load the team's committed profile. Missing file → default (source
 * 'default-missing'). Unparseable/invalid file → default (source
 * 'default-corrupt') — a loudly-marked fallback, never silent, and never
 * a 500: a broken profile file must not wedge the whole gate.
 */
export function loadInspectionProfile(root: string): { profile: InspectionProfile; source: ProfileSource; note: string } {
  const fp = profileFilePath(root);
  if (!existsSync(fp)) {
    return { profile: defaultInspectionProfile(), source: 'default-missing', note: 'no .ai-factory/inspections.json; using defaults' };
  }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as InspectionProfileInput;
    const { profile, errors } = validateInspectionProfile(raw);
    if (errors.length > 0) {
      return {
        profile: defaultInspectionProfile(),
        source: 'default-corrupt',
        note: `profile file invalid (${errors.join('; ')}); using defaults`,
      };
    }
    return { profile, source: 'file', note: 'team profile from .ai-factory/inspections.json' };
  } catch (e) {
    return {
      profile: defaultInspectionProfile(),
      source: 'default-corrupt',
      note: `profile file unreadable (${(e as Error).message}); using defaults`,
    };
  }
}

function atomicWriteJson(fp: string, value: unknown): void {
  mkdirSync(join(fp, '..'), { recursive: true });
  const tmp = `${fp}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, fp);
}

export function saveInspectionProfile(root: string, input: InspectionProfileInput): InspectionProfile {
  const { profile, errors } = validateInspectionProfile(input);
  if (errors.length > 0) throw new InspectionConfigError(`invalid profile: ${errors.join('; ')}`);
  atomicWriteJson(profileFilePath(root), profile);
  return profile;
}

export class InspectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionConfigError';
  }
}

// ---------------------------------------------------------------------------
// Root jail
// ---------------------------------------------------------------------------

export class InspectionRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionRootError';
  }
}

/** Allowed inspection roots from FACTORY_INSPECT_ROOTS (default: process cwd). */
export function inspectRoots(): string[] {
  const raw = (process.env.FACTORY_INSPECT_ROOTS ?? '').split(delimiter).map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return [process.cwd()];
  return raw.map((r) => resolve(r));
}

/**
 * Resolve the requested root, jailed inside inspectRoots(). No root
 * given → the first allowed root. Throws InspectionRootError
 * fail-closed when the root escapes the jail.
 */
export function resolveInspectionRoot(root?: string): string {
  const roots = inspectRoots();
  const candidate = root && root.trim() ? resolve(root.trim()) : roots[0];
  for (const allowed of roots) {
    if (candidate === allowed || candidate.startsWith(allowed + sep)) return candidate;
  }
  throw new InspectionRootError(`inspection root is outside the allowed roots: ${candidate}`);
}

// ---------------------------------------------------------------------------
// License audit (declared licenses only — heuristic, never guessed)
// ---------------------------------------------------------------------------

const COPYLEFT_LICENSES = new Set(
  [
    'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
    'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
    'AGPL-1.0', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
    'LGPL-2.0', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
    'CDDL-1.0', 'EPL-1.0', 'EPL-2.0', 'MPL-2.0', 'MPL-1.1', 'OSL-3.0', 'CPL-1.0', 'EUPL-1.1', 'EUPL-1.2',
    'CC-BY-SA-4.0', 'CC-BY-SA-3.0', 'GPL', 'AGPL', 'LGPL',
  ].map((s) => s.toUpperCase()),
);

const PERMISSIVE_LICENSES = new Set(
  [
    'MIT', 'Apache-2.0', 'Apache 2.0', 'ISC', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear',
    '0BSD', 'CC0-1.0', 'Unlicense', 'WTFPL', 'Zlib', 'Artistic-2.0', 'Python-2.0', 'PostgreSQL',
    'CC-BY-4.0', 'CC-BY-3.0', 'BSL-1.0', 'NCSA', 'AFL-2.1', 'APSL-2.0',
  ].map((s) => s.toUpperCase()),
);

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
}

export interface LicenseAudit {
  scanned: boolean;
  /** node_modules present at the root? */
  nodeModulesPresent: boolean;
  total: number;
  permissive: number;
  other: number;
  copyleft: LicenseEntry[];
  /** Declared license missing / unparseable / explicitly "see license file". Never guessed. */
  unknown: Array<LicenseEntry & { reason: string }>;
  note: string;
}

function declaredLicense(pkg: Record<string, unknown>): { license: string; reason?: string } {
  const raw = pkg['license'];
  if (typeof raw === 'string') {
    const v = raw.trim();
    if (!v) return { license: '', reason: 'empty license field' };
    if (/^SEE LICENSE IN/i.test(v)) return { license: v, reason: 'points at a license file; field value not a license id' };
    if (v.toUpperCase() === 'UNLICENSED') return { license: v, reason: 'marked UNLICENSED' };
    return { license: v };
  }
  if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['type'] === 'string') {
    return { license: String((raw as Record<string, unknown>)['type']).trim() };
  }
  return { license: '', reason: 'no license field' };
}

export function auditLicenses(root: string): LicenseAudit {
  const nm = join(root, 'node_modules');
  const base: LicenseAudit = {
    scanned: true,
    nodeModulesPresent: existsSync(nm),
    total: 0,
    permissive: 0,
    other: 0,
    copyleft: [],
    unknown: [],
    note: 'Declared licenses only (package.json "license" field); heuristics — the field can be missing or wrong.',
  };
  if (!base.nodeModulesPresent) {
    base.note += ' No node_modules at the root; nothing audited.';
    return base;
  }
  let dirs: string[] = [];
  try {
    dirs = readdirSync(nm);
  } catch {
    return base;
  }
  const entries: LicenseEntry[] = [];
  const readPkg = (dir: string, name: string): void => {
    const fp = join(dir, 'package.json');
    if (!existsSync(fp)) return;
    try {
      const pkg = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>;
      const { license, reason } = declaredLicense(pkg);
      entries.push({
        name,
        version: typeof pkg['version'] === 'string' ? String(pkg['version']) : '',
        license,
        ...(reason ? { _reason: reason } : {}),
      } as LicenseEntry & { _reason?: string });
    } catch {
      entries.push({ name, version: '', license: '', _reason: 'package.json unreadable' } as LicenseEntry & { _reason?: string });
    }
  };
  for (const d of dirs.sort()) {
    if (d.startsWith('.')) continue;
    const abs = join(nm, d);
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (d.startsWith('@')) {
      let scoped: string[] = [];
      try {
        scoped = readdirSync(abs);
      } catch {
        continue;
      }
      for (const s of scoped.sort()) readPkg(join(abs, s), `${d}/${s}`);
    } else {
      readPkg(abs, d);
    }
  }
  for (const e of entries) {
    const reason = (e as LicenseEntry & { _reason?: string })._reason;
    delete (e as LicenseEntry & { _reason?: string })._reason;
    base.total++;
    if (reason || !e.license) {
      base.unknown.push({ ...e, reason: reason ?? 'no license field' });
      continue;
    }
    const up = e.license.toUpperCase();
    if (COPYLEFT_LICENSES.has(up)) {
      base.copyleft.push(e);
    } else if (PERMISSIVE_LICENSES.has(up)) {
      base.permissive++;
    } else {
      base.other++;
    }
  }
  base.copyleft.sort((a, b) => (a.name < b.name ? -1 : 1));
  base.unknown.sort((a, b) => (a.name < b.name ? -1 : 1));
  return base;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface InspectionTotals {
  total: number;
  info: number;
  warning: number;
  error: number;
  byChecker: Record<string, number>;
}

export interface InspectionRunResult {
  runId: string;
  projectId: string;
  root: string;
  profileName: string;
  profileSource: ProfileSource;
  profileNote: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  filesScanned: number;
  findings: Finding[];
  totals: InspectionTotals;
  /** Findings not present in the baseline. */
  newFindings: Finding[];
  /** True when this run established the baseline (first run). */
  baselineEstablished: boolean;
  baselineExists: boolean;
  licenses: LicenseAudit | null;
}

export interface BaselineData {
  version: 1;
  establishedAt: string;
  signatures: string[];
}

export function loadBaseline(root: string): BaselineData | null {
  const fp = baselineFilePath(root);
  if (!existsSync(fp)) return null;
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as Partial<BaselineData>;
    if (raw.version !== 1 || !Array.isArray(raw.signatures)) return null;
    return { version: 1, establishedAt: typeof raw.establishedAt === 'string' ? raw.establishedAt : '', signatures: raw.signatures.filter((s) => typeof s === 'string') };
  } catch {
    return null;
  }
}

export function saveBaseline(root: string, signatures: string[]): BaselineData {
  const data: BaselineData = { version: 1, establishedAt: new Date().toISOString(), signatures: [...signatures].sort() };
  atomicWriteJson(baselineFilePath(root), data);
  return data;
}

function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0) || (a.checker < b.checker ? -1 : 1),
  );
}

/** Run the inspection over an already-resolved absolute root. */
export function runInspection(root: string, projectId: string): InspectionRunResult {
  const started = Date.now();
  const { profile, source, note } = loadInspectionProfile(root);
  const checkers = builtinCheckers(profile);
  const files = collectSourceFiles(root);
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = readLines(f.abs);
    if (!lines) continue;
    for (const c of checkers) {
      try {
        findings.push(...c.run({ file: f.rel, lines }));
      } catch {
        // One bad checker/file must not abort the run; it just yields
        // nothing for that file. Documented, deterministic.
      }
    }
  }
  const sorted = sortFindings(findings);
  const byChecker: Record<string, number> = {};
  let info = 0;
  let warning = 0;
  let error = 0;
  for (const f of sorted) {
    byChecker[f.checker] = (byChecker[f.checker] ?? 0) + 1;
    if (f.severity === 'info') info++;
    else if (f.severity === 'warning') warning++;
    else error++;
  }
  const licenses = profile.licenseAudit ? auditLicenses(root) : null;

  const baseline = loadBaseline(root);
  let newFindings: Finding[] = [];
  let baselineEstablished = false;
  if (!baseline) {
    saveBaseline(root, sorted.map(findingSignature));
    baselineEstablished = true;
  } else {
    const known = new Set(baseline.signatures);
    newFindings = sorted.filter((f) => !known.has(findingSignature(f)));
  }
  const finished = Date.now();
  return {
    runId: createHash('sha1').update(`${projectId}:${root}:${started}`, 'utf8').digest('hex').slice(0, 16),
    projectId,
    root,
    profileName: profile.name,
    profileSource: source,
    profileNote: note,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    filesScanned: files.length,
    findings: sorted,
    totals: { total: sorted.length, info, warning, error, byChecker },
    newFindings,
    baselineEstablished,
    baselineExists: baseline !== null || baselineEstablished,
    licenses,
  };
}

// ---------------------------------------------------------------------------
// History store (server data dir)
// ---------------------------------------------------------------------------

export interface InspectionHistoryEntry {
  runId: string;
  projectId: string;
  root: string;
  at: string;
  durationMs: number;
  filesScanned: number;
  total: number;
  info: number;
  warning: number;
  error: number;
  newCount: number;
  byChecker: Record<string, number>;
  profileName: string;
  baselineEstablished: boolean;
  licenseTotal: number | null;
  licenseCopyleft: number | null;
  licenseUnknown: number | null;
}

const MAX_HISTORY = 60;

export function inspectionHistoryPath(): string {
  const fromEnv = process.env.AI_FACTORY_INSPECTIONS_HISTORY_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'inspections-history.json');
}

export class InspectionHistoryStore {
  private file: string;
  constructor(file?: string) {
    this.file = file ?? inspectionHistoryPath();
  }

  private readAll(): Record<string, InspectionHistoryEntry[]> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, InspectionHistoryEntry[]>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad shape');
      return raw;
    } catch (e) {
      throw new InspectionConfigError(`inspection history store is corrupt: ${(e as Error).message}`);
    }
  }

  append(entry: InspectionHistoryEntry): void {
    const all = this.readAll();
    const list = all[entry.projectId] ?? [];
    list.push(entry);
    all[entry.projectId] = list.slice(-MAX_HISTORY);
    atomicWriteJson(this.file, all);
  }

  list(projectId: string): InspectionHistoryEntry[] {
    return this.readAll()[projectId] ?? [];
  }
}

export function historyEntryOf(r: InspectionRunResult): InspectionHistoryEntry {
  return {
    runId: r.runId,
    projectId: r.projectId,
    root: r.root,
    at: r.finishedAt,
    durationMs: r.durationMs,
    filesScanned: r.filesScanned,
    total: r.totals.total,
    info: r.totals.info,
    warning: r.totals.warning,
    error: r.totals.error,
    newCount: r.newFindings.length,
    byChecker: r.totals.byChecker,
    profileName: r.profileName,
    baselineEstablished: r.baselineEstablished,
    licenseTotal: r.licenses ? r.licenses.total : null,
    licenseCopyleft: r.licenses ? r.licenses.copyleft.length : null,
    licenseUnknown: r.licenses ? r.licenses.unknown.length : null,
  };
}
