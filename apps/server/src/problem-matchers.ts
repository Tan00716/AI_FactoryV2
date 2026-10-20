/**
 * Problem matchers (task ③, second strengthening wave) — VS Code Tasks
 * `problemMatcher`-style declarative output parsing.
 *
 * What it is: named, declarative regex matchers that turn arbitrary
 * command output (terminal sessions, quality-gate lint/test runs,
 * scheduler job output) into STRUCTURED diagnostics —
 * { file, line, column, severity, message } — that feed the @problems
 * context provider and the desktop Problems panel. No model, no
 * inference: a line either matches a pattern or it is skipped.
 *
 * HONEST BOUNDARIES (read before extending):
 *  1. This is NOT an LSP. Regexes do not understand code. Non-standard
 *     output formats WILL produce false positives and false negatives;
 *     every parse reports its line-level match rate so consumers can see
 *     how much of the output was actually recognized. A low rate means
 *     "unparsed prose", not "no problems".
 *  2. Regexes come from the operator (project config). They run inside
 *     the server process with no ReDoS sandbox: a pathological pattern
 *     can block the event loop. Patterns are therefore length-capped,
 *     lines are length-capped, and the parse input is capped — but a
 *     hostile pattern is still the operator's own foot-gun, exactly
 *     like a hostile quality-gate command string (same trust posture).
 *  3. Diagnostics are snapshots of text that was actually produced.
 *     Nothing here "checks" code; if a command never ran, there is
 *     nothing to parse and the store is empty — the UI says so.
 *  4. file/line/column are REPORTED positions from the output text,
 *     not verified positions. A stale or mangled path is the tool's
 *     fault, not something this layer corrects.
 *  5. All message/file text is quarantined through sanitizeUntrusted()
 *     before it is stored: command output is untrusted external content
 *     and may contain directive-looking lines.
 *
 * This module is pure node builtins (+ @ai-factory/security, a real
 * package dep) with no sibling value imports, so server tests may
 * import it straight from src under node's type-stripping ESM loader
 * (dual-mode import rule — see AGENTS.md).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeUntrusted } from '@ai-factory/security';

export type ProblemSeverity = 'error' | 'warning' | 'info';

export type ProblemSource = 'terminal' | 'quality-gate' | 'scheduler' | 'manual';

/** One structured diagnostic produced from command output. */
export interface ProblemDiagnostic {
  /** Where the output came from. */
  source: ProblemSource;
  /** Reported file path (verbatim from the output, sanitized). */
  file: string;
  /** 1-based line; 0 when the matcher did not capture one. */
  line: number;
  /** 1-based column; 0 when the matcher did not capture one. */
  column: number;
  severity: ProblemSeverity;
  /** Sanitized, single-line message (loop continuations appended). */
  message: string;
  /** Name of the matcher that produced this diagnostic. */
  matcher: string;
  /** ISO timestamp of the parse that produced it. */
  at: string;
}

/** A group reference: named-group name (string) or 1-based group index. */
export type GroupRef = string | number;

/** One line-pattern of a matcher. */
export interface MatcherPattern {
  /** RegExp source, applied per line (no flags; `^`/`$` anchor per line). */
  regexp: string;
  file: GroupRef;
  line: GroupRef;
  /** Optional; missing → column 0. */
  column?: GroupRef;
  /** Optional; missing → severity defaults to 'error'. */
  severity?: GroupRef;
  /** Optional; missing → the whole matched line is the message. */
  message?: GroupRef;
  /**
   * When true, following lines that fail the pattern but are indented
   * (leading space/tab) are appended to this diagnostic's message
   * (tsc/eslint-style multi-paragraph output).
   */
  loop?: boolean;
  /**
   * Optional secondary pattern applied to continuation lines of the
   * current diagnostic (node --test style: the diagnostic line carries
   * the message, a later indented line carries the position). When it
   * matches, it OVERWRITES file/line/column of the current diagnostic.
   */
  continuation?: {
    regexp: string;
    file: GroupRef;
    line: GroupRef;
    column?: GroupRef;
  };
}

/** A named problem matcher: one or more line patterns tried in order. */
export interface ProblemMatcherDef {
  name: string;
  description: string;
  patterns: MatcherPattern[];
  builtin?: boolean;
}

export interface ParseStats {
  /** Lines examined (after caps). */
  lines: number;
  /** Lines that matched a pattern (incl. continuation/loop lines). */
  matchedLines: number;
  /** Lines skipped because nothing matched (unparsed prose). */
  skippedLines: number;
  /** Diagnostics produced. */
  diagnostics: number;
  /** Names of matchers that ran, in order. */
  matchers: string[];
  /** matchedLines / lines, 0..1 (1 when there was no input at all). */
  matchRate: number;
  /** True when input or lines exceeded the caps and were cut. */
  truncated: boolean;
}

/** Parse input cap — output beyond this is not parsed, and stats say so. */
export const MAX_MATCH_INPUT = 200 * 1024;
/** Lines longer than this are skipped (single-line regex guard). */
export const MAX_MATCH_LINE = 4096;
/** Pattern sources longer than this are rejected at config time. */
export const MAX_MATCHER_PATTERN = 2000;
/** Diagnostics kept per project in the in-memory store. */
export const MAX_DIAGNOSTICS_PER_PROJECT = 500;

const SEVERITY_MAP: Record<string, ProblemSeverity> = {
  error: 'error',
  err: 'error',
  fail: 'error',
  failed: 'error',
  failure: 'error',
  warning: 'warning',
  warn: 'warning',
  info: 'info',
  information: 'info',
  note: 'info',
  hint: 'info',
  problem: 'info',
};

export function normalizeSeverity(raw: string | undefined): ProblemSeverity {
  if (!raw) return 'error';
  return SEVERITY_MAP[raw.trim().toLowerCase()] ?? 'error';
}

/**
 * Hard-clean a reported file path. Paths are single-line tokens, not
 * prose: the blockquote quarantine wrap would destroy them, so instead
 * we strip control characters/newlines outright and cap the length.
 * The result is rendered as escaped text by the UI and only ever used
 * as a URL-encoded query parameter — it cannot become instructions.
 */
function cleanPathField(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function groupValue(m: RegExpExecArray, ref: GroupRef | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === 'number') return m[ref];
  const groups = (m as RegExpExecArray & { groups?: Record<string, string | undefined> }).groups;
  return groups?.[ref];
}

function compilePattern(p: MatcherPattern): RegExp {
  return new RegExp(p.regexp);
}

/**
 * Parse text with ONE matcher. Line-oriented: the text is split into
 * lines and each line is tried against the matcher's patterns in
 * order. Loop patterns absorb following indented lines into the
 * current diagnostic's message. Nothing throws: a pattern that fails
 * to compile simply matches nothing (config-time validation is where
 * bad patterns are rejected loudly).
 */
export function parseWithMatcher(
  text: string,
  matcher: ProblemMatcherDef,
  source: ProblemSource,
  at: string = new Date().toISOString(),
): { diagnostics: ProblemDiagnostic[]; stats: ParseStats } {
  const truncated = text.length > MAX_MATCH_INPUT;
  const body = truncated ? text.slice(0, MAX_MATCH_INPUT) : text;
  const lines = body === '' ? [] : body.split(/\r?\n/);
  const compiled: Array<{ def: MatcherPattern; re: RegExp; cont: RegExp | null }> = [];
  for (const p of matcher.patterns) {
    try {
      compiled.push({
        def: p,
        re: compilePattern(p),
        cont: p.continuation ? new RegExp(p.continuation.regexp) : null,
      });
    } catch {
      /* invalid pattern — validation rejects it at config time */
    }
  }
  const diagnostics: ProblemDiagnostic[] = [];
  let matchedLines = 0;
  let current: ProblemDiagnostic | null = null;
  let currentPattern: (typeof compiled)[number] | null = null;
  // A continuation-bearing pattern (node --test style) may have prose
  // lines (---, error:, code:, stack: |) between the diagnostic line and
  // the position line. Keep the current diagnostic "open" for a bounded
  // window instead of dropping it at the first non-matching line.
  const CONTINUATION_WINDOW = 12;
  let linesSinceCurrent = 0;
  for (const rawLine of lines) {
    const line = rawLine.length > MAX_MATCH_LINE ? rawLine.slice(0, MAX_MATCH_LINE) : rawLine;
    let hit: { entry: (typeof compiled)[number]; m: RegExpExecArray } | null = null;
    for (const entry of compiled) {
      const m = entry.re.exec(line);
      if (m) {
        hit = { entry, m };
        break;
      }
    }
    if (hit) {
      matchedLines += 1;
      const p = hit.entry.def;
      const msgRaw = groupValue(hit.m, p.message) ?? line.trim();
      current = {
        source,
        file: cleanPathField(groupValue(hit.m, p.file) ?? ''),
        line: Number.parseInt(groupValue(hit.m, p.line) ?? '0', 10) || 0,
        column:
          p.column !== undefined
            ? Number.parseInt(groupValue(hit.m, p.column) ?? '0', 10) || 0
            : 0,
        severity: normalizeSeverity(groupValue(hit.m, p.severity)),
        message: sanitizeUntrusted(msgRaw.trim()).sanitized,
        matcher: matcher.name,
        at,
      };
      diagnostics.push(current);
      currentPattern = hit.entry;
      linesSinceCurrent = 0;
      continue;
    }
    if (current) linesSinceCurrent += 1;
    // Continuation: position-carrying line for the current diagnostic.
    if (current && currentPattern?.cont && linesSinceCurrent <= CONTINUATION_WINDOW) {
      const cm = currentPattern.cont.exec(line);
      if (cm && currentPattern.def.continuation) {
        matchedLines += 1;
        const c = currentPattern.def.continuation;
        const f = groupValue(cm, c.file);
        if (f) current.file = cleanPathField(f);
        const ln = groupValue(cm, c.line);
        if (ln) current.line = Number.parseInt(ln, 10) || current.line;
        const col = c.column !== undefined ? groupValue(cm, c.column) : undefined;
        if (col) current.column = Number.parseInt(col, 10) || current.column;
        continue;
      }
    }
    // Loop: indented non-matching lines extend the current message.
    if (current && currentPattern?.def.loop && /^\s+\S/.test(line)) {
      matchedLines += 1;
      const extra = sanitizeUntrusted(line.trim()).sanitized;
      if (extra && !current.message.includes(extra)) {
        current.message = `${current.message} ${extra}`.slice(0, 2000);
      }
      continue;
    }
    if (!currentPattern?.cont || linesSinceCurrent > CONTINUATION_WINDOW) {
      current = null;
      currentPattern = null;
    }
  }
  const total = lines.length;
  return {
    diagnostics,
    stats: {
      lines: total,
      matchedLines,
      skippedLines: total - matchedLines,
      diagnostics: diagnostics.length,
      matchers: [matcher.name],
      matchRate: total === 0 ? 1 : matchedLines / total,
      truncated,
    },
  };
}

/**
 * Parse text with a set of matchers in order. A diagnostic line is
 * claimed by the FIRST matcher that matches it — specific presets run
 * before generic ones. Dedupe: identical (source, file, line, column,
 * message) diagnostics collapse to one.
 */
export function parseOutput(
  text: string,
  matchers: ProblemMatcherDef[],
  source: ProblemSource,
): { diagnostics: ProblemDiagnostic[]; stats: ParseStats } {
  const at = new Date().toISOString();
  const all: ProblemDiagnostic[] = [];
  const seen = new Set<string>();
  let stats: ParseStats = {
    lines: 0,
    matchedLines: 0,
    skippedLines: 0,
    diagnostics: 0,
    matchers: [],
    matchRate: 1,
    truncated: false,
  };
  for (const matcher of matchers) {
    const r = parseWithMatcher(text, matcher, source, at);
    for (const d of r.diagnostics) {
      const key = `${d.source}|${d.file}|${d.line}|${d.column}|${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(d);
    }
  }
  // Aggregate stats across matchers: total lines from the first parse;
  // matchedLines is per-matcher double counting by design — recompute
  // honestly as "diagnostics + loop/continuation hits" is not derivable,
  // so report the MAX single-matcher coverage as the headline rate.
  if (matchers.length > 0) {
    const parts = matchers.map((m) => parseWithMatcher(text, m, source, at).stats);
    stats = {
      lines: parts[0].lines,
      matchedLines: Math.max(...parts.map((p) => p.matchedLines)),
      skippedLines: parts[0].lines - Math.max(...parts.map((p) => p.matchedLines)),
      diagnostics: all.length,
      matchers: matchers.map((m) => m.name),
      matchRate: parts[0].lines === 0 ? 1 : Math.max(...parts.map((p) => p.matchedLines)) / parts[0].lines,
      truncated: parts.some((p) => p.truncated),
    };
  }
  return { diagnostics: all, stats };
}

// ---------------------------------------------------------------------------
// Built-in presets (VS Code problemMatcher names: $tsc $eslint $go …)
// ---------------------------------------------------------------------------

export const BUILTIN_MATCHERS: ProblemMatcherDef[] = [
  {
    name: '$tsc',
    description: 'TypeScript compiler: file(line,col): error TS1234: message',
    builtin: true,
    patterns: [
      {
        regexp:
          '^(?<file>[^()\\s][^()]*?)\\((?<line>\\d+),(?<col>\\d+)\\):\\s*(?<severity>error|warning)\\s+TS\\d+:\\s*(?<message>.*)$',
        file: 'file',
        line: 'line',
        column: 'col',
        severity: 'severity',
        message: 'message',
        loop: true,
      },
    ],
  },
  {
    name: '$eslint',
    description: 'ESLint compact format: file: line N, col N, Error - message (rule)',
    builtin: true,
    patterns: [
      {
        regexp:
          '^(?<file>.+?):\\s*line\\s+(?<line>\\d+),\\s*col\\s+(?<col>\\d+),\\s*(?<severity>Error|Warning|Problem)\\s*-\\s*(?<message>.*)$',
        file: 'file',
        line: 'line',
        column: 'col',
        severity: 'severity',
        message: 'message',
      },
    ],
  },
  {
    name: '$go',
    description: 'Go toolchain: file.go:line[:col]: message',
    builtin: true,
    patterns: [
      {
        regexp: '^(?<file>\\S+\\.go):(?<line>\\d+)(?::(?<col>\\d+))?:\\s*(?<message>.*)$',
        file: 'file',
        line: 'line',
        column: 'col',
        message: 'message',
      },
    ],
  },
  {
    name: '$node-test',
    description: 'node --test TAP output: "not ok N - name" + following stack position',
    builtin: true,
    patterns: [
      {
        regexp: '^not ok\\s+\\d+\\s*-\\s*(?<message>.*)$',
        file: 'file',
        line: 'line',
        message: 'message',
        continuation: {
          regexp: '^\\s*(?:at\\s+)?.*\\((?<file>[^()]+):(?<line>\\d+):(?<col>\\d+)\\)',
          file: 'file',
          line: 'line',
          column: 'col',
        },
      },
    ],
  },
  {
    name: '$vitest',
    description: 'Vitest: FAIL file > suite > test, plus "❯ file (n)" headers',
    builtin: true,
    patterns: [
      {
        regexp: '^\\s*FAIL\\s+(?<file>\\S+?)(?:\\s+>\\s*(?<message>.*))?$',
        file: 'file',
        line: 'line',
        message: 'message',
        continuation: {
          regexp: '^\\s*at\\s+.*\\((?<file>[^()]+):(?<line>\\d+):(?<col>\\d+)\\)',
          file: 'file',
          line: 'line',
          column: 'col',
        },
      },
      {
        regexp: '^\\s*[❯×✗]\\s+(?<file>\\S+?)\\s*\\(\\d+(?:\\s*test)?',
        file: 'file',
        line: 'line',
      },
    ],
  },
  {
    name: '$stacktrace',
    description: 'Generic V8-style stack frame: "at fn (file:line:col)" — lowest priority fallback',
    builtin: true,
    patterns: [
      {
        regexp:
          '^\\s*at\\s+(?:.*?\\s+)?\\(?(?<file>[^()\\s]+\\.(?:[cm]?[jt]sx?|go|py|rs|java)):(?<line>\\d+):(?<col>\\d+)\\)?\\s*$',
        file: 'file',
        line: 'line',
        column: 'col',
      },
    ],
  },
];

/** Enabled-by-default matcher order: specific presets before generic ones. */
export const DEFAULT_ENABLED_MATCHERS: string[] = [
  '$tsc',
  '$eslint',
  '$go',
  '$node-test',
  '$vitest',
  '$stacktrace',
];

export function builtinMatcher(name: string): ProblemMatcherDef | null {
  return BUILTIN_MATCHERS.find((m) => m.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Custom matcher validation
// ---------------------------------------------------------------------------

const MATCHER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_$-]{0,63}$/;

function countCaptureGroups(source: string): number {
  try {
    return new RegExp(`${source}|`).exec('')?.length !== undefined
      ? (new RegExp(`${source}|`).exec('') as RegExpExecArray).length - 1
      : 0;
  } catch {
    return -1;
  }
}

function checkGroupRef(
  label: string,
  ref: GroupRef | undefined,
  source: string,
  errors: string[],
): void {
  if (ref === undefined) return;
  if (typeof ref === 'number') {
    const count = countCaptureGroups(source);
    if (count >= 0 && (ref < 1 || ref > count)) {
      errors.push(`${label}: group index ${ref} out of range (pattern has ${count} groups)`);
    }
    return;
  }
  if (typeof ref !== 'string' || ref === '') {
    errors.push(`${label}: group reference must be a name or a 1-based index`);
    return;
  }
  if (!source.includes(`(?<${ref}>`)) {
    errors.push(`${label}: named group "${ref}" does not exist in the pattern`);
  }
}

/** Validate a custom matcher definition. Returns human-readable errors ([] = valid). */
export function validateMatcherDef(name: string, raw: unknown): { def: ProblemMatcherDef | null; errors: string[] } {
  const errors: string[] = [];
  if (!MATCHER_NAME_RE.test(name)) {
    errors.push(`matcher name "${name}" is invalid (letters/digits/_-$ only, max 64 chars)`);
  }
  if (!raw || typeof raw !== 'object') {
    return { def: null, errors: [...errors, 'matcher definition must be an object'] };
  }
  const r = raw as { description?: unknown; patterns?: unknown };
  const description = typeof r.description === 'string' ? r.description.slice(0, 500) : '';
  if (!Array.isArray(r.patterns) || r.patterns.length === 0) {
    return { def: null, errors: [...errors, 'patterns must be a non-empty array'] };
  }
  if (r.patterns.length > 8) errors.push('at most 8 patterns per matcher');
  const patterns: MatcherPattern[] = [];
  for (let i = 0; i < Math.min(r.patterns.length, 8); i++) {
    const p = r.patterns[i] as Partial<MatcherPattern> | null;
    const label = `patterns[${i}]`;
    if (!p || typeof p !== 'object') {
      errors.push(`${label}: must be an object`);
      continue;
    }
    if (typeof p.regexp !== 'string' || p.regexp === '') {
      errors.push(`${label}.regexp: required string`);
      continue;
    }
    if (p.regexp.length > MAX_MATCHER_PATTERN) {
      errors.push(`${label}.regexp: too long (max ${MAX_MATCHER_PATTERN} chars)`);
      continue;
    }
    try {
      new RegExp(p.regexp);
    } catch (e) {
      errors.push(`${label}.regexp: does not compile: ${(e as Error).message}`);
      continue;
    }
    checkGroupRef(`${label}.file`, p.file, p.regexp, errors);
    checkGroupRef(`${label}.line`, p.line, p.regexp, errors);
    checkGroupRef(`${label}.column`, p.column, p.regexp, errors);
    checkGroupRef(`${label}.severity`, p.severity, p.regexp, errors);
    checkGroupRef(`${label}.message`, p.message, p.regexp, errors);
    if (p.continuation !== undefined) {
      const c = p.continuation as MatcherPattern['continuation'];
      if (!c || typeof c.regexp !== 'string') {
        errors.push(`${label}.continuation.regexp: required string`);
      } else {
        try {
          new RegExp(c.regexp);
          checkGroupRef(`${label}.continuation.file`, c.file, c.regexp, errors);
          checkGroupRef(`${label}.continuation.line`, c.line, c.regexp, errors);
          checkGroupRef(`${label}.continuation.column`, c.column, c.regexp, errors);
        } catch (e) {
          errors.push(`${label}.continuation.regexp: does not compile: ${(e as Error).message}`);
        }
      }
    }
    patterns.push({
      regexp: p.regexp,
      file: p.file as GroupRef,
      line: p.line as GroupRef,
      ...(p.column !== undefined ? { column: p.column as GroupRef } : {}),
      ...(p.severity !== undefined ? { severity: p.severity as GroupRef } : {}),
      ...(p.message !== undefined ? { message: p.message as GroupRef } : {}),
      ...(p.loop === true ? { loop: true } : {}),
      ...(p.continuation ? { continuation: p.continuation } : {}),
    });
  }
  if (errors.length > 0) return { def: null, errors };
  return { def: { name, description, patterns }, errors: [] };
}

// ---------------------------------------------------------------------------
// Per-project matcher configuration store
// ---------------------------------------------------------------------------

export interface ProblemMatcherConfig {
  /** Matcher names to run, in order. */
  enabled: string[];
  /** Custom (or overriding) matcher definitions by name. */
  customs: Record<string, ProblemMatcherDef>;
}

export class ProblemMatcherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProblemMatcherConfigError';
  }
}

export function problemMatcherStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_PROBLEM_MATCHERS_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'problem-matchers.json');
}

interface ProblemMatcherFile {
  version: 1;
  projects: Record<string, ProblemMatcherConfig>;
}

function defaultConfig(): ProblemMatcherConfig {
  return { enabled: [...DEFAULT_ENABLED_MATCHERS], customs: {} };
}

export class ProblemMatcherStore {
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? problemMatcherStorePath();
  }

  private load(): ProblemMatcherFile {
    if (!existsSync(this.path)) return { version: 1, projects: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e) {
      throw new ProblemMatcherConfigError(
        `problem matcher store is corrupt (${this.path}): ${(e as Error).message}`,
      );
    }
    const projects: Record<string, ProblemMatcherConfig> = {};
    const list = (raw as { projects?: Record<string, unknown> }).projects ?? {};
    for (const [projectId, rec] of Object.entries(list)) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as { enabled?: unknown; customs?: unknown };
      const enabled = Array.isArray(r.enabled)
        ? r.enabled.filter((x): x is string => typeof x === 'string')
        : [...DEFAULT_ENABLED_MATCHERS];
      const customs: Record<string, ProblemMatcherDef> = {};
      if (r.customs && typeof r.customs === 'object') {
        for (const [name, def] of Object.entries(r.customs as Record<string, unknown>)) {
          const v = validateMatcherDef(name, def);
          if (v.def) customs[name] = v.def; // invalid stored defs are dropped, not served
        }
      }
      projects[projectId] = { enabled, customs };
    }
    return { version: 1, projects };
  }

  private save(file: ProblemMatcherFile): void {
    mkdirSync(resolve(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  get(projectId: string): ProblemMatcherConfig {
    return this.load().projects[projectId] ?? defaultConfig();
  }

  set(projectId: string, config: ProblemMatcherConfig): ProblemMatcherConfig {
    const file = this.load();
    file.projects[projectId] = config;
    this.save(file);
    return config;
  }
}

let storeSingleton: ProblemMatcherStore | null = null;

export function problemMatcherStore(): ProblemMatcherStore {
  if (!storeSingleton) storeSingleton = new ProblemMatcherStore();
  return storeSingleton;
}

/** Test seam: replace the singleton (pass null to reset to env default). */
export function setProblemMatcherStore(s: ProblemMatcherStore | null): void {
  storeSingleton = s;
}

/**
 * Resolve the executable matcher set for a project: enabled order,
 * custom definitions win over same-named built-ins. Unknown enabled
 * names are dropped (config validation reports them at PUT time).
 */
export function resolveMatchers(projectId: string): ProblemMatcherDef[] {
  const cfg = problemMatcherStore().get(projectId);
  const out: ProblemMatcherDef[] = [];
  for (const name of cfg.enabled) {
    const def = cfg.customs[name] ?? builtinMatcher(name);
    if (def) out.push(def);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structured diagnostics store (in-memory ring, per project)
// ---------------------------------------------------------------------------

export interface DiagnosticsView {
  diagnostics: ProblemDiagnostic[];
  /** Last parse stats per source for this project. */
  lastStats: Partial<Record<ProblemSource, ParseStats>>;
  /** True when older diagnostics were evicted by the ring cap. */
  evicted: boolean;
}

class ProblemDiagnosticsStoreImpl {
  private byProject = new Map<string, { items: ProblemDiagnostic[]; stats: Partial<Record<ProblemSource, ParseStats>>; evicted: boolean }>();

  record(projectId: string, diagnostics: ProblemDiagnostic[], stats: ParseStats, source: ProblemSource): number {
    let slot = this.byProject.get(projectId);
    if (!slot) {
      slot = { items: [], stats: {}, evicted: false };
      this.byProject.set(projectId, slot);
    }
    // A fresh parse of a source REPLACES that source's previous
    // diagnostics (it is the latest snapshot of that source's output),
    // but never touches other sources.
    slot.items = slot.items.filter((d) => d.source !== source);
    const seen = new Set(slot.items.map((d) => `${d.source}|${d.file}|${d.line}|${d.column}|${d.message}`));
    let added = 0;
    for (const d of diagnostics) {
      const key = `${d.source}|${d.file}|${d.line}|${d.column}|${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slot.items.push(d);
      added += 1;
    }
    if (slot.items.length > MAX_DIAGNOSTICS_PER_PROJECT) {
      slot.items = slot.items.slice(-MAX_DIAGNOSTICS_PER_PROJECT);
      slot.evicted = true;
    }
    slot.stats[source] = stats;
    return added;
  }

  list(projectId: string, source?: ProblemSource): DiagnosticsView {
    const slot = this.byProject.get(projectId);
    if (!slot) return { diagnostics: [], lastStats: {}, evicted: false };
    return {
      diagnostics: source ? slot.items.filter((d) => d.source === source) : [...slot.items],
      lastStats: { ...slot.stats },
      evicted: slot.evicted,
    };
  }

  clear(projectId: string): void {
    this.byProject.delete(projectId);
  }

  /** Seam for @problems: all diagnostics for a project (may be empty). */
  all(projectId: string): ProblemDiagnostic[] {
    return this.byProject.get(projectId)?.items ?? [];
  }
}

export const problemDiagnosticsStore = new ProblemDiagnosticsStoreImpl();

/** Test seam: wipe all stored diagnostics. */
export function resetProblemDiagnostics(): void {
  (problemDiagnosticsStore as unknown as { byProject: Map<string, unknown> }).byProject.clear();
}

/**
 * Parse output text with the project's matchers and store the result
 * as the latest snapshot for its source. Returns what was added plus
 * the parse stats (the honest match-rate record).
 */
export function parseAndStoreProblems(
  projectId: string,
  source: ProblemSource,
  text: string,
): { added: number; total: number; stats: ParseStats } {
  const matchers = resolveMatchers(projectId);
  const { diagnostics, stats } = parseOutput(text, matchers, source);
  const added = problemDiagnosticsStore.record(projectId, diagnostics, stats, source);
  return { added, total: problemDiagnosticsStore.all(projectId).length, stats };
}
