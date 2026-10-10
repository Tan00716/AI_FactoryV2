/**
 * The 10 deterministic dimension checkers (spec §35).
 *
 * Each checker is a pure function over the file's reviewed content and
 * emits Findings with file/line attribution. Heuristics are deliberately
 * simple and documented as such — a prototype static pass, not a compiler.
 */
import {
  Finding,
  ReviewDimension,
  ReviewFile,
  ReviewSeverity,
} from './types';

/** One file prepared for scanning. */
export interface ScannableFile {
  path: string;
  lines: string[];
  /** True when `before` was absent — a newly added file. */
  isNew: boolean;
  beforeLines: string[] | null;
}

export interface ReviewContext {
  files: ScannableFile[];
  byPath: Map<string, ScannableFile>;
  /** Lowercased project convention keywords. */
  conventions: string[];
}

export interface DiffFile {
  path: string;
  added: string[];
  removed: string[];
  isNew: boolean;
}

/**
 * Parse a unified diff into per-file added/removed lines.
 * Handles `diff --git` headers and `---`/`+++` (incl. `/dev/null`) headers.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldPath: string | null = null;

  const strip = (p: string): string =>
    p.replace(/^[ab]\//, '').replace(/^"(.*)"$/, '$1');

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git\s+(\S+)\s+(\S+)/);
      if (m) {
        current = { path: strip(m[2]), added: [], removed: [], isNew: false };
        out.push(current);
        oldPath = null;
      }
      continue;
    }
    if (raw.startsWith('--- ')) {
      oldPath = raw.slice(4).trim();
      if (current && oldPath === '/dev/null') current.isNew = true;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (current && p !== '/dev/null') current.path = strip(p);
      continue;
    }
    if (!current || raw.startsWith('@@')) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.added.push(raw.slice(1));
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      current.removed.push(raw.slice(1));
    }
  }
  return out;
}

function buildScannable(
  input: ReviewFile,
  diffFiles: Map<string, DiffFile>,
): ScannableFile {
  const beforeLines = input.before != null ? input.before.split('\n') : null;
  let content: string | null = input.after ?? null;
  if (content == null) {
    const df = diffFiles.get(input.path);
    if (df) content = df.added.join('\n');
  }
  return {
    path: input.path,
    lines: content != null ? content.split('\n') : [],
    isNew: input.before == null,
    beforeLines,
  };
}

export function buildContext(
  files: ReviewFile[],
  diff: string | undefined,
  conventions: string[] | undefined,
): ReviewContext {
  const parsed = diff ? parseUnifiedDiff(diff) : [];
  const diffFiles = new Map(parsed.map((d) => [d.path, d]));
  const scannable = files.map((f) => buildScannable(f, diffFiles));
  return {
    files: scannable,
    byPath: new Map(scannable.map((s) => [s.path, s])),
    conventions: (conventions ?? []).map((c) => c.toLowerCase()),
  };
}

function mk(
  dimension: ReviewDimension,
  severity: ReviewSeverity,
  message: string,
  file?: string,
  line?: number,
): Finding {
  return { dimension, severity, message, file, line };
}

/** Skip pure comment lines for token heuristics. */
function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\*|#)/.test(line);
}

/* ------------------------------------------------------------------ */
/* 1. correctness                                                      */
/* ------------------------------------------------------------------ */
function checkCorrectness(f: ScannableFile): Finding[] {
  const out: Finding[] = [];
  f.lines.forEach((raw, i) => {
    const line = raw;
    const lineNo = i + 1;
    if (isCommentLine(line)) return;
    if (/(?<![=!<>])==(?!=)/.test(line) || /!=(?!=)/.test(line)) {
      out.push(
        mk(
          'correctness',
          'warning',
          'Loose equality (==/!=) — use strict === / !==.',
          f.path,
          lineNo,
        ),
      );
    }
    if (/\bparseInt\s*\([^,)]*\)/.test(line)) {
      out.push(
        mk(
          'correctness',
          'info',
          'parseInt() without an explicit radix.',
          f.path,
          lineNo,
        ),
      );
    }
    if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) {
      out.push(
        mk(
          'correctness',
          'warning',
          'Empty catch block swallows errors silently.',
          f.path,
          lineNo,
        ),
      );
    }
  });
  // Multi-line empty catch: `catch {` ... next non-empty line is `}`.
  for (let i = 0; i < f.lines.length - 1; i++) {
    if (/\bcatch\s*(\([^)]*\))?\s*\{\s*$/.test(f.lines[i] as string)) {
      let j = i + 1;
      while (j < f.lines.length && /^\s*$/.test(f.lines[j] as string)) j++;
      if (j < f.lines.length && /^\s*\}\s*$/.test(f.lines[j] as string)) {
        out.push(
          mk(
            'correctness',
            'warning',
            'Empty catch block swallows errors silently.',
            f.path,
            i + 1,
          ),
        );
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. architecture                                                     */
/* ------------------------------------------------------------------ */
const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(fromPath: string, target: string): string | null {
  if (!target.startsWith('.')) return null; // external module — not tracked
  const dir = fromPath.split('/').slice(0, -1);
  const parts: string[] = [...dir];
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  let p = parts.join('/');
  p = p.replace(/\.(ts|tsx|js|jsx|mts|cts)$/, '');
  return p;
}

function checkArchitecture(f: ScannableFile, ctx: ReviewContext): Finding[] {
  const out: Finding[] = [];
  const targets = new Set<string>();
  const rawTargets: string[] = [];
  f.lines.forEach((line, i) => {
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(line)) !== null) {
      const target = m[1] as string;
      rawTargets.push(target);
      const resolved = resolveImport(f.path, target);
      if (resolved) targets.add(resolved);
      if (/^(\.\.\/){3,}/.test(target) || (target.match(/\.\.\//g) ?? []).length >= 3) {
        out.push(
          mk(
            'architecture',
            'warning',
            `Deep relative import '${target}' — consider a path alias or barrel.`,
            f.path,
            i + 1,
          ),
        );
      }
    }
  });
  void rawTargets;
  // Circular imports between reviewed files (A imports B and B imports A).
  const norm = (p: string): string => p.replace(/\.(ts|tsx|js|jsx|mts|cts)$/, '');
  const self = norm(f.path);
  for (const t of targets) {
    const other = ctx.byPath.get(t) ?? ctx.byPath.get(`${t}.ts`) ?? null;
    if (!other) {
      // Try extension-less match against reviewed paths.
      const match = ctx.files.find((c) => norm(c.path) === t);
      if (!match || match.path === f.path) continue;
      if (importsTarget(match, self)) {
        out.push(
          mk(
            'architecture',
            'error',
            `Circular import: '${f.path}' ↔ '${match.path}'.`,
            f.path,
          ),
        );
      }
      continue;
    }
    if (other.path !== f.path && importsTarget(other, self)) {
      out.push(
        mk(
          'architecture',
          'error',
          `Circular import: '${f.path}' ↔ '${other.path}'.`,
          f.path,
        ),
      );
    }
  }
  return out;
}

function importsTarget(f: ScannableFile, targetNorm: string): boolean {
  for (const line of f.lines) {
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(line)) !== null) {
      const r = resolveImport(f.path, m[1] as string);
      if (r === targetNorm) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 3. readability                                                      */
/* ------------------------------------------------------------------ */
const MAX_LINE = 120;

function checkReadability(f: ScannableFile): Finding[] {
  const out: Finding[] = [];
  let longCount = 0;
  let longMax = 0;
  f.lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (/\bTODO\b/.test(line) && !/#\d+|https?:\/\/|TODO\([^)]*\)/.test(line)) {
      out.push(
        mk(
          'readability',
          'info',
          'TODO without an issue reference (use TODO(#123) or a link).',
          f.path,
          lineNo,
        ),
      );
    }
    if (line.length > MAX_LINE) {
      longCount++;
      longMax = Math.max(longMax, line.length);
    }
  });
  if (longCount > 0) {
    out.push(
      mk(
        'readability',
        'info',
        `${longCount} line(s) exceed ${MAX_LINE} chars (longest ${longMax}) — consider wrapping.`,
        f.path,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. maintainability                                                  */
/* ------------------------------------------------------------------ */
const MAX_FILE_LINES = 500;
const MAX_FN_LINES = 80;

const FN_START_RE =
  /^\s*(export\s+default\s+)?(export\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/;
const ARROW_FN_RE =
  /^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\([^)]*\)\s*(?::[^=]+?)?=>/;

function functionNameAt(line: string): string | null {
  let m = FN_START_RE.exec(line);
  if (m) return (m[4] as string) || '(anonymous)';
  m = ARROW_FN_RE.exec(line);
  if (m) return m[3] as string;
  return null;
}

/** Count lines from the first `{` at/after startIdx to its matching `}`. */
function braceSpan(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] as string;
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (started && depth <= 0) return i - startIdx + 1;
  }
  return lines.length - startIdx;
}

function checkMaintainability(f: ScannableFile): Finding[] {
  const out: Finding[] = [];
  if (f.lines.length > MAX_FILE_LINES) {
    out.push(
      mk(
        'maintainability',
        'warning',
        `File is ${f.lines.length} lines (> ${MAX_FILE_LINES}) — consider splitting.`,
        f.path,
      ),
    );
  }
  f.lines.forEach((line, i) => {
    const name = functionNameAt(line);
    if (name == null) return;
    const span = braceSpan(f.lines, i);
    if (span > MAX_FN_LINES) {
      out.push(
        mk(
          'maintainability',
          'warning',
          `Function '${name}' spans ${span} lines (> ${MAX_FN_LINES}) — consider extracting helpers.`,
          f.path,
          i + 1,
        ),
      );
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 5. security                                                         */
/* ------------------------------------------------------------------ */
const PLACEHOLDER_RE = /^(x+|changeme|placeholder|test|example|todo|\*+)$/i;

function checkSecurity(f: ScannableFile): Finding[] {
  const out: Finding[] = [];
  f.lines.forEach((raw, i) => {
    const line = raw;
    const lineNo = i + 1;
    if (isCommentLine(line)) return;
    if (/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
      out.push(
        mk(
          'security',
          'blocker',
          'Private key material committed — must never be in source control.',
          f.path,
          lineNo,
        ),
      );
    }
    if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) {
      out.push(
        mk(
          'security',
          'blocker',
          'Hardcoded AWS access key ID — rotate and move to a secret store.',
          f.path,
          lineNo,
        ),
      );
    }
    const secretAssign =
      /\b(password|passwd|pwd|secret|api[_-]?key|apikey|client[_-]?secret|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*['"]([^'"]*)['"]/i.exec(
        line,
      );
    if (secretAssign) {
      const value = secretAssign[2] as string;
      if (
        value.length >= 4 &&
        !PLACEHOLDER_RE.test(value) &&
        !/\$\{/.test(value)
      ) {
        out.push(
          mk(
            'security',
            'error',
            `Hardcoded credential '${secretAssign[1]}' — read from env or a secret store instead.`,
            f.path,
            lineNo,
          ),
        );
      }
    }
    if (/\beval\s*\(/.test(line)) {
      out.push(
        mk('security', 'error', 'eval() executes arbitrary code — avoid.', f.path, lineNo),
      );
    }
    const execCall = /\b(exec|execSync|spawn|spawnSync)\s*\(/.exec(line);
    if (execCall && (/\+/.test(line) || /\$\{/.test(line))) {
      out.push(
        mk(
          'security',
          'error',
          `${execCall[1]}() with string concatenation/interpolation — command injection risk; use argv arrays.`,
          f.path,
          lineNo,
        ),
      );
    }
    if (
      /\b(SELECT\b|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)/i.test(line) &&
      (/\+/.test(line) || /\$\{/.test(line))
    ) {
      out.push(
        mk(
          'security',
          'error',
          'SQL built via string concatenation/interpolation — SQL injection risk; use parameterized queries.',
          f.path,
          lineNo,
        ),
      );
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 6. performance                                                      */
/* ------------------------------------------------------------------ */
function checkPerformance(f: ScannableFile): Finding[] {
  const out: Finding[] = [];
  f.lines.forEach((line, i) => {
    if (/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/.test(line)) {
      out.push(
        mk(
          'performance',
          'info',
          'Deep clone via JSON.parse(JSON.stringify()) — consider structuredClone().',
          f.path,
          i + 1,
        ),
      );
    }
  });
  // await inside a for-loop: brace-scan each for-loop for an await.
  for (let i = 0; i < f.lines.length; i++) {
    const line = f.lines[i] as string;
    if (!/^\s*for\s*\(/.test(line)) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < f.lines.length; j++) {
      const l = f.lines[j] as string;
      for (const ch of l) {
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') {
          depth--;
        }
      }
      if (started && /\bawait\b/.test(l)) {
        out.push(
          mk(
            'performance',
            'warning',
            'await inside a loop runs sequentially — consider Promise.all for independent work.',
            f.path,
            j + 1,
          ),
        );
        break;
      }
      if (started && depth <= 0) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 7. testCoverage                                                     */
/* ------------------------------------------------------------------ */
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mts|cts|py|go|java|rb|php|rs)$/;
const TEST_PATH_RE = /(\.test\.|\.spec\.|__tests__|[\\/]tests?[\\/])/;

function isSourceFile(path: string): boolean {
  return SOURCE_EXT_RE.test(path) && !TEST_PATH_RE.test(path);
}

function baseName(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function checkTestCoverage(f: ScannableFile, ctx: ReviewContext): Finding[] {
  if (!f.isNew || !isSourceFile(f.path)) return [];
  const base = baseName(f.path);
  const covered = ctx.files.some(
    (other) =>
      other.path !== f.path &&
      TEST_PATH_RE.test(other.path) &&
      other.path.includes(base),
  );
  if (!covered) {
    return [
      mk(
        'testCoverage',
        'warning',
        `New source file '${f.path}' has no corresponding test file in this change.`,
        f.path,
      ),
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 8. regressionRisk                                                   */
/* ------------------------------------------------------------------ */
const SHARED_DIR_RE = /(^|[\\/])(shared|common|core|utils?|lib)([\\/]|$)/;
const EXPORT_RE = /^\s*export\s+(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

function checkRegressionRisk(f: ScannableFile): Finding[] {
  const out: Finding[] = [];
  if (SHARED_DIR_RE.test(f.path)) {
    out.push(
      mk(
        'regressionRisk',
        'warning',
        `Change touches shared module '${f.path}' — higher blast radius; run the full suite.`,
        f.path,
      ),
    );
  }
  if (f.beforeLines) {
    const beforeExports = new Set<string>();
    for (const line of f.beforeLines) {
      const m = EXPORT_RE.exec(line);
      if (m) beforeExports.add(m[3] as string);
    }
    const afterExports = new Set<string>();
    for (const line of f.lines) {
      const m = EXPORT_RE.exec(line);
      if (m) afterExports.add(m[3] as string);
    }
    for (const name of beforeExports) {
      if (!afterExports.has(name)) {
        out.push(
          mk(
            'regressionRisk',
            'warning',
            `Public export '${name}' was removed — potential breaking change for consumers.`,
            f.path,
          ),
        );
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 9. projectConventions                                               */
/* ------------------------------------------------------------------ */
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function checkProjectConventions(
  f: ScannableFile,
  ctx: ReviewContext,
): Finding[] {
  const out: Finding[] = [];
  const conv = ctx.conventions;
  if (conv.length === 0) return out;

  const wantsNoConsole = conv.some(
    (c) => c.includes('no-console') || c.includes('no console'),
  );
  const wantsKebab = conv.some((c) => c.includes('kebab'));
  const wantsJsdoc = conv.some((c) => c.includes('jsdoc'));

  if (wantsNoConsole) {
    let count = 0;
    let firstLine = 0;
    f.lines.forEach((line, i) => {
      if (!isCommentLine(line) && /\bconsole\.(log|debug|info|warn|error)\s*\(/.test(line)) {
        count++;
        if (!firstLine) firstLine = i + 1;
      }
    });
    if (count > 0) {
      out.push(
        mk(
          'projectConventions',
          'warning',
          `console.* used ${count} time(s) — project convention forbids console output.`,
          f.path,
          firstLine,
        ),
      );
    }
  }
  if (wantsKebab) {
    const base = baseName(f.path);
    if (!KEBAB_RE.test(base)) {
      out.push(
        mk(
          'projectConventions',
          'warning',
          `File name '${base}' is not kebab-case per project convention.`,
          f.path,
        ),
      );
    }
  }
  if (wantsJsdoc) {
    f.lines.forEach((line, i) => {
      if (/^\s*export\s+(async\s+)?function\s+[A-Za-z_$]/.test(line)) {
        const prev = (f.lines[i - 1] ?? '').trim();
        const prev2 = (f.lines[i - 2] ?? '').trim();
        if (!prev.startsWith('/**') && !prev.endsWith('*/') && !prev2.startsWith('/**')) {
          out.push(
            mk(
              'projectConventions',
              'info',
              'Exported function lacks a JSDoc comment per project convention.',
              f.path,
              i + 1,
            ),
          );
        }
      }
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 10. dependencyChanges                                               */
/* ------------------------------------------------------------------ */
const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function majorOf(version: string): string {
  const m = version.replace(/^[\^~>=< ]+/, '').match(/^(\d+)/);
  return m ? (m[1] as string) : version;
}

function compareDepMaps(
  file: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Finding[] {
  const out: Finding[] = [];
  for (const section of DEP_SECTIONS) {
    const b = (before[section] as Record<string, string> | undefined) ?? {};
    const a = (after[section] as Record<string, string> | undefined) ?? {};
    for (const [name, ver] of Object.entries(a)) {
      if (!(name in b)) {
        out.push(
          mk(
            'dependencyChanges',
            'info',
            `Dependency added [${section}]: ${name}@${ver}.`,
            file,
          ),
        );
      } else if (b[name] !== ver) {
        const sev: ReviewSeverity =
          majorOf(b[name] as string) !== majorOf(ver) ? 'warning' : 'info';
        out.push(
          mk(
            'dependencyChanges',
            sev,
            `Dependency ${majorOf(b[name] as string) !== majorOf(ver) ? 'major-upgraded' : 'updated'} [${section}]: ${name} ${b[name]} → ${ver}.`,
            file,
          ),
        );
      }
    }
    for (const name of Object.keys(b)) {
      if (!(name in a)) {
        out.push(
          mk(
            'dependencyChanges',
            'warning',
            `Dependency removed [${section}]: ${name}.`,
            file,
          ),
        );
      }
    }
  }
  return out;
}

function checkDependencyChanges(f: ScannableFile, diff: DiffFile | null): Finding[] {
  const isPkg = /(^|[\\/])package\.json$/.test(f.path);
  if (!isPkg) return [];
  if (f.beforeLines) {
    try {
      const before = JSON.parse(f.beforeLines.join('\n')) as Record<string, unknown>;
      const after = JSON.parse(f.lines.join('\n')) as Record<string, unknown>;
      return compareDepMaps(f.path, before, after);
    } catch {
      return [
        mk(
          'dependencyChanges',
          'error',
          'package.json is not valid JSON after this change.',
          f.path,
        ),
      ];
    }
  }
  // Diff-only mode: list +/- "name": "version" lines.
  if (diff) {
    const out: Finding[] = [];
    const depLine = /^\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?\s*$/;
    for (const line of diff.added) {
      const m = depLine.exec(line);
      if (m) {
        out.push(
          mk(
            'dependencyChanges',
            'info',
            `Dependency added: ${m[1]}@${m[2]}.`,
            f.path,
          ),
        );
      }
    }
    for (const line of diff.removed) {
      const m = depLine.exec(line);
      if (m) {
        out.push(
          mk(
            'dependencyChanges',
            'warning',
            `Dependency removed: ${m[1]}.`,
            f.path,
          ),
        );
      }
    }
    return out;
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* checker registry                                                    */
/* ------------------------------------------------------------------ */
export type DimensionChecker = (
  file: ScannableFile,
  ctx: ReviewContext,
  diffFile: DiffFile | null,
) => Finding[];

export const DIMENSION_CHECKERS: Record<ReviewDimension, DimensionChecker> = {
  correctness: (f) => checkCorrectness(f),
  architecture: (f, ctx) => checkArchitecture(f, ctx),
  readability: (f) => checkReadability(f),
  maintainability: (f) => checkMaintainability(f),
  security: (f) => checkSecurity(f),
  performance: (f) => checkPerformance(f),
  testCoverage: (f, ctx) => checkTestCoverage(f, ctx),
  regressionRisk: (f) => checkRegressionRisk(f),
  projectConventions: (f, ctx) => checkProjectConventions(f, ctx),
  dependencyChanges: (f, _ctx, d) => checkDependencyChanges(f, d),
};
