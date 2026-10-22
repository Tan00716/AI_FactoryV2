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
 * Pure node builtins (+ type-only imports, plus the @ai-factory/security
 * secret-pattern table): tests may import it straight from src under node's
 * type-stripping ESM loader (the workspace package resolves to its dist).
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

/**
 * `nosec` exemption: a trailing `// nosec` (any comment style) suppresses
 * the security findings on that line. `// nosec:<rule-id>` scopes the
 * exemption to one rule, e.g. `// nosec:eval-call`. Plain `nosec`
 * suppresses every security rule on the line. This is a human-readable
 * annotation, not a signature — the line and file are still scanned.
 */
export function nosecKinds(line: string): Set<string> | 'all' | null {
  const m = /\bnosec\b(?::\s*([A-Za-z0-9_][A-Za-z0-9_,\- ]*))?/.exec(line);
  if (!m) return null;
  if (!m[1]) return 'all';
  return new Set(m[1].split(/[,\s]+/).filter(Boolean));
}

function suppressedByNosec(line: string, kind: string): boolean {
  const n = nosecKinds(line);
  return n === 'all' || (n instanceof Set && n.has(kind));
}

// ---------------------------------------------------------------------------
// secret-scan checker (gitleaks-style, deterministic pattern set)
// ---------------------------------------------------------------------------
// R4-S1: the pattern table lives in @ai-factory/security now (single source
// of truth shared with the runtime pre-send prompt gate). Re-exported here
// so existing importers of this module keep working.
import {
  SECRET_PATTERNS,
  isPlaceholderValue,
  maskSecret,
  type SecretPattern,
} from '@ai-factory/security';
export { SECRET_PATTERNS, isPlaceholderValue, maskSecret };
export type { SecretPattern };

/** secret-scan: hardcoded secrets, severity always 'error' (a match is definite enough to block on). */
export const secretScanChecker: Checker = {
  name: 'secret-scan',
  description: 'Flags hardcoded secrets and credentials (pattern-based; heuristic, not proof).',
  run({ file, lines }) {
    const out: Finding[] = [];
    const testFile = isTestFile(file);
    lines.forEach((ln, i) => {
      for (const p of SECRET_PATTERNS) {
        // Generic heuristics are skipped in test files — fixtures are
        // noisy; an explicit // nosec annotation is still honored below.
        if (p.kind === 'generic' && testFile) continue;
        if (suppressedByNosec(ln, p.name)) continue;
        const m = p.re.exec(ln);
        if (!m) continue;
        if (p.kind === 'generic' && isPlaceholderValue(m[0])) continue;
        const body = {
          checker: 'secret-scan',
          file,
          line: i + 1,
          message: `possible hardcoded secret (${p.name}): ${maskSecret(m[0])} — pattern match, verify manually`,
        };
        out.push({ ...body, id: findingId(body), severity: 'error', detail: p.name });
      }
    });
    return out;
  },
};

// ---------------------------------------------------------------------------
// sast-patterns checker (deterministic dangerous-pattern SAST)
// ---------------------------------------------------------------------------

export interface SastRule {
  id: string;
  severity: InspectionSeverity;
  message: string;
  test: (line: string) => boolean;
}

/** One-line-at-a-time rules — line-local by design (documented as heuristic). */
export const SAST_RULES: SastRule[] = [
  {
    id: 'eval-call',
    severity: 'error',
    message: 'eval() executes a string as code — a classic injection sink',
    test: (l) => /\beval\s*\(/.test(l),
  },
  {
    id: 'function-constructor',
    severity: 'error',
    message: 'new Function() builds code from a string — injection sink',
    test: (l) => /\bnew\s+Function\s*\(/.test(l),
  },
  {
    id: 'vm-context-execution',
    severity: 'warning',
    message: 'vm.runIn*Context() executes untrusted code when the context is tainted',
    test: (l) => /\bvm\.runIn\w*Context\s*\(/.test(l),
  },
  {
    id: 'sql-string-injection',
    severity: 'error',
    message: 'SQL query built by string interpolation/concatenation — use parameterized queries',
    test: (l) =>
      /\b(?:query|execute|raw)\s*\(/.test(l) && (/\$\{/.test(l) || /["'`]\s*\+/.test(l) || /\+\s*["'`]/.test(l)),
  },
  {
    id: 'sql-keyword-concat',
    severity: 'warning',
    message: 'SQL keyword with interpolated input nearby — check for string-built queries',
    test: (l) => /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(l) && (/\+\s*\w/.test(l) || /\$\{/.test(l)),
  },
  {
    id: 'shell-string-injection',
    severity: 'error',
    message: 'shell command built by string interpolation/concatenation — use argument arrays',
    test: (l) => {
      const m = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/.exec(l);
      if (!m) return false;
      let arg = l.slice(m.index + m[0].length);
      const cut = arg.search(/[,)]/);
      if (cut >= 0) arg = arg.slice(0, cut);
      return /`[^`]*\$\{/.test(arg) || /\+/.test(arg);
    },
  },
  {
    id: 'child-process-shell-true',
    severity: 'warning',
    message: 'child_process with shell:true — metacharacters in arguments become shell syntax',
    test: (l) => /\bshell\s*:\s*true\b/.test(l),
  },
  {
    id: 'unsafe-deserialization',
    severity: 'warning',
    message: 'unserialize()/pickle.loads() on untrusted data can execute code',
    test: (l) => /\b(?:unserialize|pickle\.loads?)\s*\(/.test(l),
  },
  {
    id: 'yaml-unsafe-load',
    severity: 'warning',
    message: 'yaml.load() without a safe loader can deserialize to arbitrary objects',
    test: (l) => /\byaml\.load\s*\(/.test(l) && !/SafeLoader|safe_load/i.test(l),
  },
  {
    id: 'dom-xss-sink',
    severity: 'warning',
    message: 'innerHTML=/document.write() with dynamic content is an XSS sink',
    test: (l) => /\.innerHTML\s*=[^=]/.test(l) || /\bdocument\.write(?:ln)?\s*\(/.test(l),
  },
  {
    id: 'tls-verification-disabled',
    severity: 'error',
    message: 'TLS verification disabled — man-in-the-middle becomes trivial',
    test: (l) => /rejectUnauthorized\s*:\s*false/.test(l) || /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0\b/.test(l),
  },
  {
    id: 'weak-crypto-hash',
    severity: 'warning',
    message: 'md5/sha1 used in a credential context — use a password-hashing function instead',
    test: (l) =>
      /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i.test(l) &&
      /(?:password|secret|token|auth|credential)/i.test(l),
  },
  {
    id: 'insecure-randomness',
    severity: 'warning',
    message: 'Math.random() used in a security context — use crypto.randomBytes/randomUUID',
    test: (l) => /\bMath\.random\s*\(\s*\)/.test(l) && /(?:token|password|secret|otp|session|nonce|auth)/i.test(l),
  },
  {
    id: 'cors-wildcard',
    severity: 'warning',
    message: 'Access-Control-Allow-Origin: * — any site can read the response',
    test: (l) => /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/.test(l),
  },
];

/** sast-patterns: deterministic dangerous-code-pattern scan. */
export const sastPatternsChecker: Checker = {
  name: 'sast-patterns',
  description: 'Flags dangerous code patterns (injection sinks, weak crypto, disabled TLS) — pattern-based, advisory.',
  run({ file, lines }) {
    const out: Finding[] = [];
    lines.forEach((ln, i) => {
      for (const r of SAST_RULES) {
        if (suppressedByNosec(ln, r.id)) continue;
        let hit = false;
        try {
          hit = r.test(ln);
        } catch {
          hit = false;
        }
        if (!hit) continue;
        const body = { checker: 'sast-patterns', file, line: i + 1, message: `SAST ${r.id}: ${r.message}` };
        out.push({ ...body, id: findingId(body), severity: r.severity, detail: r.id });
      }
    });
    return out;
  },
};

/** All built-in checkers by name (the extensible registry). */
/**
 * Extension hook for checkers that live outside this module (round-4 A4:
 * the SSR template checker in routes/ssr.ts). Setter-injected so this
 * module keeps zero value-imports of route code (dual-mode import rule).
 */
let extraCheckerProvider: ((root: string) => Checker[]) | null = null;

export function setExtraCheckerProvider(fn: ((root: string) => Checker[]) | null): void {
  extraCheckerProvider = fn;
}

export function builtinCheckers(profile: InspectionProfile, root?: string): Checker[] {
  const enabled = (name: string): boolean => profile.checkers[name] !== false;
  const out: Checker[] = [];
  if (enabled('todo-fixme')) out.push(todoFixmeChecker);
  if (enabled('long-file')) out.push(makeLongFileChecker(profile.maxFileLines));
  if (enabled('long-function')) out.push(makeLongFunctionChecker(profile.maxFunctionLines));
  if (enabled('console-log')) out.push(consoleLogChecker);
  // Security checkers (task wave2-④): appended, existing checkers untouched.
  if (enabled('secret-scan')) out.push(secretScanChecker);
  if (enabled('sast-patterns')) out.push(sastPatternsChecker);
  // SSR template checker (round-4 A4): only when a root is supplied, the
  // provider is wired (production index.ts), and the profile enables it.
  // Legacy coupling (documented, round-5 A5): 'ssr-template' and
  // 'unicode-trojan' share the 'ssr-template' gate. 'spell-check'
  // (round-5 A7) has its own gate so it can be toggled independently.
  if (root && extraCheckerProvider) {
    try {
      for (const c of extraCheckerProvider(root)) {
        const gate = c.name === 'spell-check' ? 'spell-check' : 'ssr-template';
        if (enabled(gate)) out.push(c);
      }
    } catch {
      // A broken provider must not abort the inspection run.
    }
  }
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
  /** When true, the run also audits lockfile dependencies against the vulnerable-version blacklist. */
  dependencyAudit: boolean;
}

export const KNOWN_CHECKERS = ['todo-fixme', 'long-file', 'long-function', 'console-log', 'secret-scan', 'sast-patterns', 'ssr-template', 'spell-check'] as const;

export function defaultInspectionProfile(): InspectionProfile {
  return {
    version: 1,
    name: 'default',
    maxFileLines: 1000,
    maxFunctionLines: 150,
    checkers: { 'todo-fixme': true, 'long-file': true, 'long-function': true, 'console-log': true, 'secret-scan': true, 'sast-patterns': true, 'ssr-template': true, 'spell-check': true },
    licenseAudit: true,
    dependencyAudit: true,
  };
}

export interface InspectionProfileInput {
  name?: unknown;
  maxFileLines?: unknown;
  maxFunctionLines?: unknown;
  checkers?: unknown;
  licenseAudit?: unknown;
  dependencyAudit?: unknown;
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
  if (input.dependencyAudit !== undefined) {
    if (typeof input.dependencyAudit !== 'boolean') errors.push('dependencyAudit must be a boolean');
    else p.dependencyAudit = input.dependencyAudit;
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
// Security rules file (.ai-factory/security-rules.json)
// ---------------------------------------------------------------------------

export interface VulnerableRule {
  /** npm package name. */
  package: string;
  /** Version range, e.g. "<4.17.21" or ">=1.0.0 <1.2.8". */
  range: string;
  severity: InspectionSeverity;
  /** Advisory id, e.g. 'CVE-2020-8203' or 'CUSTOM'. */
  id: string;
  note?: string;
}

/**
 * Hand-maintained blacklist snapshot from public CVE advisories
 * (mitre.org / GitHub Security Advisories).
 *
 * HONEST BOUNDARY: this is a snapshot, not a live feed. It lags the real
 * advisory stream, it covers only a handful of high-profile npm packages,
 * and it is NOT a substitute for a live advisory database (e.g. OSV).
 * The snapshot date is disclosed in every report; custom rules can be
 * appended per-project in .ai-factory/security-rules.json.
 */
export const SECURITY_BLACKLIST_SNAPSHOT = '2026-10-20';
export const SECURITY_BLACKLIST_SOURCE =
  'Hand-maintained snapshot of public CVE advisories (mitre.org / GitHub Security Advisories); not a live feed.';

export const BUILTIN_VULNERABLE: VulnerableRule[] = [
  { package: 'lodash', range: '<4.17.21', severity: 'error', id: 'CVE-2020-8203', note: 'Prototype pollution' },
  { package: 'minimist', range: '<1.2.8', severity: 'error', id: 'CVE-2021-44906', note: 'Prototype pollution' },
  { package: 'node-fetch', range: '<2.6.7', severity: 'error', id: 'CVE-2022-0235', note: 'Exposure of sensitive information' },
  { package: 'axios', range: '<0.21.2', severity: 'error', id: 'CVE-2020-28168', note: 'Credential leakage on redirect' },
  { package: 'glob-parent', range: '<5.1.2', severity: 'error', id: 'CVE-2020-28469', note: 'Regular expression denial of service' },
  { package: 'handlebars', range: '<4.7.7', severity: 'error', id: 'CVE-2021-20922', note: 'Remote code execution via template' },
  { package: 'yargs-parser', range: '<5.0.1', severity: 'error', id: 'CVE-2020-7608', note: 'Prototype pollution' },
  { package: 'json5', range: '<2.2.2', severity: 'error', id: 'CVE-2022-46175', note: 'Prototype pollution in parse' },
  { package: 'semver', range: '<7.5.2', severity: 'error', id: 'CVE-2022-25883', note: 'Regular expression denial of service' },
  { package: 'word-wrap', range: '<1.2.4', severity: 'error', id: 'CVE-2023-26115', note: 'Regular expression denial of service' },
  { package: 'tar', range: '<6.1.9', severity: 'warning', id: 'CVE-2021-37713', note: 'Arbitrary file creation/overwrite' },
  { package: 'qs', range: '<6.10.3', severity: 'warning', id: 'CVE-2022-24999', note: 'Prototype poisoning' },
  { package: 'async', range: '<2.6.4', severity: 'warning', id: 'CVE-2021-43138', note: 'Regular expression denial of service' },
  { package: 'follow-redirects', range: '<1.14.8', severity: 'warning', id: 'CVE-2022-0155', note: 'Header leak on cross-domain redirect' },
  { package: 'moment', range: '<2.29.4', severity: 'warning', id: 'CVE-2022-24785', note: 'Path traversal via locale' },
];

function parseVersionParts(v: string): { nums: number[]; prerelease: boolean } | null {
  const m = /^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: m[1].split('.').map(Number), prerelease: /[-]/.test(v.trim()) };
}

/** Compare two versions; NaN when either is unparseable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return Number.NaN;
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.prerelease !== pb.prerelease) return pa.prerelease ? -1 : 1;
  return 0;
}

const RANGE_ATOM_RE = /^(<=|>=|<|>|=)?(\d+(?:\.\d+){0,3})$/;
const RANGE_WILDCARD_RE = /^(\d+(?:\.\d+){0,2})\.x$/i;

/** Validate a range string without evaluating it. */
export function isValidRange(range: string): boolean {
  const atoms = range.trim().split(/\s+/).filter(Boolean);
  if (atoms.length === 0) return false;
  return atoms.every((a) => RANGE_ATOM_RE.test(a) || RANGE_WILDCARD_RE.test(a));
}

/**
 * Space-separated atoms are ANDed: "<4.17.21" or ">=1.0.0 <1.2.8".
 * Unparseable versions / invalid ranges return false (never throw).
 */
export function versionInRange(version: string, range: string): boolean {
  if (!isValidRange(range)) return false;
  const atoms = range.trim().split(/\s+/).filter(Boolean);
  for (const atom of atoms) {
    const wc = RANGE_WILDCARD_RE.exec(atom);
    let op: string;
    let ref: string;
    let prefixMatch = false;
    if (wc) {
      op = 'wildcard';
      ref = wc[1];
    } else {
      const m = RANGE_ATOM_RE.exec(atom)!;
      op = m[1] || '=';
      ref = m[2];
    }
    if (op === 'wildcard') {
      const vp = version.trim().split('.');
      const rp = ref.split('.');
      prefixMatch = rp.every((p, i) => vp[i] === p);
      if (!prefixMatch) return false;
      continue;
    }
    const cmp = compareVersions(version, ref);
    if (Number.isNaN(cmp)) return false;
    const ok = op === '<' ? cmp < 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : op === '>=' ? cmp >= 0 : cmp === 0;
    if (!ok) return false;
  }
  return true;
}

export interface SecuritySuppression {
  checker: string;
  /** Exact relative file path, or a prefix with a trailing '*' (e.g. "vendor/*"). */
  file?: string;
  note?: string;
}

export interface SecurityRules {
  version: 1;
  additionalVulnerable: VulnerableRule[];
  suppress: SecuritySuppression[];
}

export function securityRulesFilePath(root: string): string {
  return join(root, '.ai-factory', 'security-rules.json');
}

export function defaultSecurityRules(): SecurityRules {
  return { version: 1, additionalVulnerable: [], suppress: [] };
}

export function validateSecurityRules(input: unknown): { rules: SecurityRules; errors: string[] } {
  const errors: string[] = [];
  const rules = defaultSecurityRules();
  if (input === undefined || input === null) return { rules, errors };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { rules, errors: ['security rules must be an object'] };
  }
  const obj = input as Record<string, unknown>;
  const add = obj['additionalVulnerable'];
  if (add !== undefined) {
    if (!Array.isArray(add)) {
      errors.push('additionalVulnerable must be an array');
    } else {
      add.forEach((r, i) => {
        const label = `additionalVulnerable[${i}]`;
        if (!r || typeof r !== 'object') {
          errors.push(`${label} must be an object`);
          return;
        }
        const rec = r as Record<string, unknown>;
        const pkg = rec['package'];
        const range = rec['range'];
        const severity = rec['severity'];
        if (typeof pkg !== 'string' || !pkg.trim() || pkg.trim().length > 214) {
          errors.push(`${label}.package must be a non-empty string (max 214 chars)`);
          return;
        }
        if (typeof range !== 'string' || !isValidRange(range)) {
          errors.push(`${label}.range must be a valid range like "<4.17.21" or ">=1.0.0 <1.2.8"`);
          return;
        }
        let sev: InspectionSeverity = 'warning';
        if (severity !== undefined) {
          if (severity !== 'info' && severity !== 'warning' && severity !== 'error') {
            errors.push(`${label}.severity must be info|warning|error`);
            return;
          }
          sev = severity;
        }
        const id = typeof rec['id'] === 'string' && rec['id'].trim() ? rec['id'].trim().slice(0, 120) : 'CUSTOM';
        const note = typeof rec['note'] === 'string' ? rec['note'].slice(0, 500) : undefined;
        rules.additionalVulnerable.push({ package: pkg.trim(), range: range.trim(), severity: sev, id, ...(note ? { note } : {}) });
      });
    }
  }
  const sup = obj['suppress'];
  if (sup !== undefined) {
    if (!Array.isArray(sup)) {
      errors.push('suppress must be an array');
    } else {
      sup.forEach((s, i) => {
        const label = `suppress[${i}]`;
        if (!s || typeof s !== 'object') {
          errors.push(`${label} must be an object`);
          return;
        }
        const rec = s as Record<string, unknown>;
        if (typeof rec['checker'] !== 'string' || !rec['checker'].trim() || rec['checker'].trim().length > 60) {
          errors.push(`${label}.checker must be a non-empty string (max 60 chars)`);
          return;
        }
        const out: SecuritySuppression = { checker: rec['checker'].trim() };
        if (rec['file'] !== undefined) {
          if (typeof rec['file'] !== 'string' || !rec['file'].trim() || rec['file'].trim().length > 500) {
            errors.push(`${label}.file must be a non-empty string (max 500 chars)`);
            return;
          }
          out.file = rec['file'].trim().replace(/\\/g, '/');
        }
        if (typeof rec['note'] === 'string' && rec['note'].trim()) {
          out.note = rec['note'].trim().slice(0, 500);
        }
        rules.suppress.push(out);
      });
    }
  }
  return { rules, errors };
}

export type SecurityRulesSource = 'file' | 'default-missing' | 'default-corrupt';

/**
 * Load the project's security rules. Missing file → empty defaults
 * (source 'default-missing'). Unparseable/invalid → empty defaults with
 * a loud note (source 'default-corrupt') — never silent, never a 500.
 */
export function loadSecurityRules(root: string): { rules: SecurityRules; source: SecurityRulesSource; note: string } {
  const fp = securityRulesFilePath(root);
  if (!existsSync(fp)) {
    return { rules: defaultSecurityRules(), source: 'default-missing', note: 'no .ai-factory/security-rules.json; no custom rules or exemptions' };
  }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as unknown;
    const { rules, errors } = validateSecurityRules(raw);
    if (errors.length > 0) {
      return {
        rules: defaultSecurityRules(),
        source: 'default-corrupt',
        note: `security rules file invalid (${errors.join('; ')}); using empty defaults`,
      };
    }
    return {
      rules,
      source: 'file',
      note: `custom security rules from .ai-factory/security-rules.json (${rules.additionalVulnerable.length} custom rules, ${rules.suppress.length} exemptions)`,
    };
  } catch (e) {
    return {
      rules: defaultSecurityRules(),
      source: 'default-corrupt',
      note: `security rules file unreadable (${(e as Error).message}); using empty defaults`,
    };
  }
}

export function saveSecurityRules(root: string, input: unknown): SecurityRules {
  const { rules, errors } = validateSecurityRules(input);
  if (errors.length > 0) throw new InspectionConfigError(`invalid security rules: ${errors.join('; ')}`);
  atomicWriteJson(securityRulesFilePath(root), rules);
  return rules;
}

/** Drop security findings covered by the project's exemptions. */
export function applySecuritySuppressions(findings: Finding[], rules: SecurityRules): Finding[] {
  if (rules.suppress.length === 0) return findings;
  return findings.filter((f) => {
    if (f.checker !== 'secret-scan' && f.checker !== 'sast-patterns') return true;
    return !rules.suppress.some((s) => {
      if (s.checker !== f.checker) return false;
      if (!s.file) return true;
      if (s.file.endsWith('*')) return f.file.startsWith(s.file.slice(0, -1));
      return s.file === f.file;
    });
  });
}

// ---------------------------------------------------------------------------
// SCA — lockfile parsing + vulnerable-version matching
// ---------------------------------------------------------------------------

interface LockDep {
  name: string;
  version: string;
}

function parsePackageLockText(text: string): LockDep[] {
  const data = JSON.parse(text) as Record<string, unknown>;
  const out: LockDep[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: unknown): void => {
    if (typeof name !== 'string' || typeof version !== 'string' || !version) return;
    const key = `${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, version });
  };
  const pkgs = data['packages'];
  if (pkgs && typeof pkgs === 'object' && !Array.isArray(pkgs)) {
    for (const [key, entry] of Object.entries(pkgs as Record<string, Record<string, unknown>>)) {
      if (!key || !key.startsWith('node_modules/')) continue;
      const name = key.split('node_modules/').pop() ?? '';
      add(name, entry?.version);
    }
    return out;
  }
  // lockfileVersion 1: nested "dependencies".
  const walk = (deps: unknown): void => {
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return;
    for (const [name, entry] of Object.entries(deps as Record<string, Record<string, unknown>>)) {
      add(name, entry?.version);
      walk(entry?.dependencies);
    }
  };
  walk(data['dependencies']);
  return out;
}

/**
 * Minimal pnpm-lock reader (line-based, only the `packages:` section).
 * Understands v5 `/name/version:` and v6+/v9 `name@version:` (and the
 * `/`-prefixed v6 form). Anything fancier falls back to "not matched" —
 * the finding is then simply absent, and the skipped lockfile is disclosed.
 */
function parsePnpmLockText(text: string): LockDep[] {
  const out: LockDep[] = [];
  const seen = new Set<string>();
  let inPackages = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^[^ \t#]/.test(line)) break; // next top-level section
    if (!inPackages) continue;
    if (/^\s*#/.test(line)) continue;
    const m = /^  ([^ \t][^:]*):\s*$/.exec(line);
    if (!m) continue;
    let key = m[1].trim();
    const paren = key.indexOf('(');
    if (paren >= 0) key = key.slice(0, paren).trim();
    if (key.endsWith('/')) key = key.slice(0, -1);
    if (key.startsWith('/')) key = key.slice(1);
    let name = '';
    let version = '';
    const at = key.lastIndexOf('@');
    if (at > 0) {
      name = key.slice(0, at);
      version = key.slice(at + 1);
    } else {
      // v5 style: name/version
      const slash = key.lastIndexOf('/');
      if (slash > 0) {
        name = key.slice(0, slash);
        version = key.slice(slash + 1);
      }
    }
    if (name && /^\d/.test(version)) {
      const k = `${name}@${version}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ name, version });
      }
    }
  }
  return out;
}

export interface VulnerableDependency {
  name: string;
  version: string;
  /** Which lockfile declared it. */
  source: string;
  ruleId: string;
  range: string;
  severity: InspectionSeverity;
  /** False for project-custom rules from security-rules.json. */
  builtin: boolean;
  note?: string;
}

export interface DependencyAudit {
  scanned: boolean;
  lockfiles: string[];
  skipped: string[];
  /** Unique name@version pairs across all lockfiles. */
  total: number;
  vulnerable: VulnerableDependency[];
  /** Builtin blacklist snapshot date. */
  snapshot: string;
  snapshotNote: string;
  note: string;
}

/**
 * Audit declared dependencies against the vulnerable-version blacklist.
 * Mirrors the license audit's honest posture: lockfile-declared versions
 * only; no network; snapshot coverage lags the real advisory stream.
 */
export function auditDependencies(root: string, extraRules: VulnerableRule[] = []): DependencyAudit {
  const deps: Array<LockDep & { source: string }> = [];
  const lockfiles: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const consider = (file: string, parse: (text: string) => LockDep[]): void => {
    const fp = join(root, file);
    if (!existsSync(fp)) return;
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(fp);
    } catch {
      /* ignore */
    }
    if (!st || !st.isFile() || st.size > 20 * 1024 * 1024) {
      skipped.push(`${file}: too large or unreadable`);
      return;
    }
    try {
      for (const d of parse(readFileSync(fp, 'utf8'))) {
        const k = `${d.name}@${d.version}`;
        if (!seen.has(k)) {
          seen.add(k);
          deps.push({ ...d, source: file });
        }
      }
      lockfiles.push(file);
    } catch (e) {
      skipped.push(`${file}: ${(e as Error).message}`);
    }
  };
  consider('package-lock.json', parsePackageLockText);
  consider('npm-shrinkwrap.json', parsePackageLockText);
  consider('pnpm-lock.yaml', parsePnpmLockText);
  const rules: Array<VulnerableRule & { builtin: boolean }> = [
    ...BUILTIN_VULNERABLE.map((r) => ({ ...r, builtin: true })),
    ...extraRules.map((r) => ({ ...r, builtin: false })),
  ];
  const vulnerable: VulnerableDependency[] = [];
  for (const d of deps) {
    for (const r of rules) {
      if (r.package !== d.name) continue;
      let hit = false;
      try {
        hit = versionInRange(d.version, r.range);
      } catch {
        hit = false;
      }
      if (hit) {
        vulnerable.push({
          name: d.name,
          version: d.version,
          source: d.source,
          ruleId: r.id,
          range: r.range,
          severity: r.severity,
          builtin: r.builtin,
          ...(r.note ? { note: r.note } : {}),
        });
      }
    }
  }
  vulnerable.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    scanned: true,
    lockfiles,
    skipped,
    total: deps.length,
    vulnerable,
    snapshot: SECURITY_BLACKLIST_SNAPSHOT,
    snapshotNote: SECURITY_BLACKLIST_SOURCE,
    note: 'Lockfile-declared versions matched against a hand-maintained blacklist snapshot; coverage lags the real advisory stream — not a substitute for a live feed.',
  };
}

// ---------------------------------------------------------------------------
// Security scan entry point (no baseline / history side effects)
// ---------------------------------------------------------------------------

export interface SecurityScanResult {
  filesScanned: number;
  findings: Finding[];
  dependencies: DependencyAudit;
  rulesSource: SecurityRulesSource;
  rulesNote: string;
}

/**
 * Run the security scanners over a root without writing anything:
 * no baseline file, no history — safe to call from the quality gate.
 * Findings are baseline-independent (a secret is never "baselined away"
 * for triage purposes); the full inspection's baseline machinery still
 * applies to how they are counted as "new".
 */
export function runSecurityScan(root: string): SecurityScanResult {
  const { rules, source, note } = loadSecurityRules(root);
  const files = collectSourceFiles(root);
  const checkers: Checker[] = [secretScanChecker, sastPatternsChecker];
  const raw: Finding[] = [];
  for (const f of files) {
    const lines = readLines(f.abs);
    if (!lines) continue;
    for (const c of checkers) {
      try {
        raw.push(...c.run({ file: f.rel, lines }));
      } catch {
        // One bad checker/file must not abort the scan; mirrors runInspection.
      }
    }
  }
  const findings = sortFindings(applySecuritySuppressions(raw, rules));
  const dependencies = auditDependencies(root, rules.additionalVulnerable);
  return { filesScanned: files.length, findings, dependencies, rulesSource: source, rulesNote: note };
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
  /** Dependency vulnerability audit (null when profile.dependencyAudit is off). */
  dependencies: DependencyAudit | null;
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
  const checkers = builtinCheckers(profile, root);
  const files = collectSourceFiles(root);
  const collected: Finding[] = [];
  for (const f of files) {
    const lines = readLines(f.abs);
    if (!lines) continue;
    for (const c of checkers) {
      try {
        collected.push(...c.run({ file: f.rel, lines }));
      } catch {
        // One bad checker/file must not abort the run; it just yields
        // nothing for that file. Documented, deterministic.
      }
    }
  }
  // Security findings additionally honor the project's exemption list
  // (security-rules.json). Other checkers are unaffected.
  const secRules = loadSecurityRules(root).rules;
  const sorted = sortFindings(applySecuritySuppressions(collected, secRules));
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
  const dependencies = profile.dependencyAudit ? auditDependencies(root, secRules.additionalVulnerable) : null;

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
    dependencies,
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
  /** error-severity security findings + error-severity vulnerable deps; null when the dependency audit is off. */
  securityError: number | null;
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
  const secFindings = r.findings.filter(
    (f) => (f.checker === 'secret-scan' || f.checker === 'sast-patterns') && f.severity === 'error',
  );
  const depVuln = r.dependencies?.vulnerable.filter((v) => v.severity === 'error').length ?? 0;
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
    securityError: secFindings.length + depVuln,
  };
}
