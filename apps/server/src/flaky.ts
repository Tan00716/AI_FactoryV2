/**
 * Flaky test detection (round-3 task 3) — Buildkite Test Engine style.
 *
 * What it is: a deterministic recorder + classifier for node `--test`
 * TAP output. Test outcomes (file + subtest path → pass/fail) are
 * appended to a per-project history file; a test that both passes and
 * fails within the configured lookback window is marked FLAKY, a test
 * that only fails is marked ALWAYS-FAILING. No model, no inference:
 * history either shows both outcomes or it does not.
 *
 * HONEST BOUNDARIES (read before extending):
 *  1. This only sees what the TAP text contains. `node --test` without
 *     `--test-reporter=tap` produces human-readable output, NOT TAP —
 *     such output parses to zero outcomes and the caller must say so
 *     (the routes do: "no TAP-parseable outcomes"). Parsing is never
 *     attempted on the pretty reporter.
 *  2. Multi-file `node --test` runs concatenate TAP streams with NO
 *     per-file marker. The `file` label therefore comes from the
 *     caller (one run per file, or one explicit label) — it is NOT
 *     recovered from the TAP text. Callers that batch files into one
 *     stream must pass a label that says so.
 *  3. A parent test whose children failed (failureType subtestsFailed)
 *     is a ROLLUP, not an independent failure — only leaf outcomes are
 *     recorded. Otherwise every nested failure would double-count.
 *  4. skip/todo outcomes are neutral: they update lastSeen but never
 *     enter the pass/fail window. A test that flips between pass and
 *     skip is NOT flaky.
 *  5. "Flaky" is an annotation, never a verdict. Nothing here turns a
 *     failing gate green; the quality-gate linkage (routes/flaky.ts)
 *     annotates and re-runs once at most, and the original verdict
 *     always stands.
 *  6. Test names are operator content (from test files). They are stored
 *     as plain text after stripping ANSI/control characters — deliberately
 *     NOT wrapped like problem-matcher diagnostics, because they are
 *     lookup keys and UI labels and the wrapper would make both
 *     unreadable. They are rendered as escaped text in the UI and must be
 *     quoted-as-data by any future model consumer.
 *  7. Names are redacted with diagpack `redactText` in recordRun before
 *     they reach the persisted history (R16 N3): a test name can carry
 *     a credential-shaped literal, and history is returned verbatim by
 *     GET /api/flaky. redactText does not mask `FACTORY_API_TOKEN=`
 *     lines — that shape needs the planned #6(h) value-aware
 *     redaction, not a silent pattern-table change here.
 *
 * This module is node builtins plus one package import (@ai-factory/
 * diagpack, resolved to its built dist), with no sibling value imports,
 * so server tests may import it straight from src under node's
 * type-stripping ESM loader (dual-mode import rule — see AGENTS.md).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { redactText } from '@ai-factory/diagpack';

// ---------------------------------------------------------------------------
// TAP parsing
// ---------------------------------------------------------------------------

/** Outcome of one leaf test in a TAP stream. */
export type TapTestStatus = 'pass' | 'fail' | 'skip' | 'todo';

export interface TapTestOutcome {
  /** Normalized key: file + ' › ' + subtest path (or path alone when no file). */
  key: string;
  /** Caller-supplied file label ('' when the caller gave none). */
  file: string;
  /** ' › '-joined subtest path, without the file. */
  name: string;
  status: TapTestStatus;
}

export interface TapParseStats {
  lines: number;
  /** Lines that matched an ok/not-ok result pattern. */
  resultLines: number;
  /** Leaf outcomes recorded (rollups excluded). */
  recorded: number;
  /** YAML diagnostic blocks skipped. */
  yamlBlocks: number;
  truncated: boolean;
}

export interface TapParseResult {
  outcomes: TapTestOutcome[];
  stats: TapParseStats;
}

/** Parse-input cap: TAP from a huge suite can be megabytes; cap + flag. */
const MAX_TAP_LINES = 100_000;
/** Test-name length cap (mirrors the problem-matcher line cap posture). */
const MAX_NAME_LEN = 500;

const SUBTEST_RE = /^(\s*)#\s*Subtest:\s*(.*?)\s*$/;
const RESULT_RE = /^(\s*)(not ok|ok)\s+(\d+)(?:\s*-\s*(.*?))?(?:\s+#\s*(SKIP|TODO)\b(.*))?\s*$/i;
const PLAN_RE = /^\s*\d+\.\.\d+\s*$/;
const YAML_OPEN_RE = /^\s*---\s*$/;
const YAML_CLOSE_RE = /^\s*\.\.\.\s*$/;

/** Normalized identity of a test: file + full subtest path. */
export function normalizeTestKey(file: string, path: string[]): string {
  const parts = path.map((s) => s.trim()).filter((s) => s.length > 0);
  const name = parts.join(' › ');
  const f = file.trim();
  return f ? `${f} › ${name}` : name;
}

function cleanTestName(raw: string): string {
  return (
    raw
      // ANSI SGR color codes (some runners colorize test names)
      .replace(/\u001b\[[0-9;]*m/g, '')
      // C0 control characters + DEL (names are single-line by construction)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_NAME_LEN)
  );
}

/**
 * Parse node `--test --test-reporter=tap` output. Only leaf results are
 * returned; rollup parents (a subtest whose own children were recorded)
 * are skipped so nested failures are not double-counted.
 */
export function parseTapOutput(text: string, opts: { file?: string } = {}): TapParseResult {
  const file = (opts.file ?? '').trim();
  const allLines = text.split('\n');
  const truncated = allLines.length > MAX_TAP_LINES;
  const lines = truncated ? allLines.slice(0, MAX_TAP_LINES) : allLines;

  interface Frame {
    name: string;
    indent: number;
    hasChildren: boolean;
  }
  const stack: Frame[] = [];
  const outcomes: TapTestOutcome[] = [];
  const dupCount = new Map<string, number>();
  let yaml = false;
  let resultLines = 0;
  let yamlBlocks = 0;

  const pushOutcome = (path: string[], status: TapTestStatus): void => {
    let key = normalizeTestKey(file, path);
    const n = dupCount.get(key) ?? 0;
    dupCount.set(key, n + 1);
    if (n > 0) key = `${key} (${n + 1})`;
    outcomes.push({ key, file, name: path.join(' › '), status });
  };

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (YAML_OPEN_RE.test(line)) {
      yaml = true;
      continue;
    }
    if (yaml) {
      if (YAML_CLOSE_RE.test(line)) {
        yaml = false;
        yamlBlocks += 1;
      }
      continue;
    }
    let m = SUBTEST_RE.exec(line);
    if (m) {
      const indent = m[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length > 0) stack[stack.length - 1].hasChildren = true;
      stack.push({ name: cleanTestName(m[2]), indent, hasChildren: false });
      continue;
    }
    m = RESULT_RE.exec(line);
    if (m) {
      const indent = m[1].length;
      const failed = m[2].toLowerCase() === 'not ok';
      const directive = (m[5] ?? '').toUpperCase();
      resultLines += 1;
      while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();
      const frame =
        stack.length > 0 && stack[stack.length - 1].indent === indent ? stack.pop()! : undefined;
      const status: TapTestStatus =
        directive === 'SKIP' ? 'skip' : directive === 'TODO' ? 'todo' : failed ? 'fail' : 'pass';
      if (frame && frame.hasChildren) {
        // Rollup parent (e.g. failureType subtestsFailed): children carry
        // the signal; recording the parent would double-count.
        continue;
      }
      const path = stack.map((f) => f.name);
      if (frame) path.push(frame.name || cleanTestName(m[4] ?? '') || `#${m[3]}`);
      else path.push(cleanTestName(m[4] ?? '') || `#${m[3]}`);
      pushOutcome(
        path.filter((s) => s.length > 0),
        status,
      );
      continue;
    }
    if (PLAN_RE.test(line)) continue;
    // 'TAP version 13', '# tests N' summaries and any other prose: ignored.
  }

  return {
    outcomes,
    stats: {
      lines: allLines.length,
      resultLines,
      recorded: outcomes.length,
      yamlBlocks,
      truncated,
    },
  };
}

// ---------------------------------------------------------------------------
// History store
// ---------------------------------------------------------------------------

export interface FlakyConfig {
  /** Lookback window in runs for the flaky verdict. */
  windowSize: number;
  /** Minimum runs observed before any verdict other than insufficient-data. */
  minRuns: number;
}

export const DEFAULT_FLAKY_CONFIG: FlakyConfig = { windowSize: 10, minRuns: 3 };
export const MIN_FLAKY_WINDOW = 2;
export const MAX_FLAKY_WINDOW = 50;
/** Per-test outcome ring cap (independent of the verdict window). */
const MAX_RECENT = 50;
/** Run summaries kept per project. */
const MAX_RUN_SUMMARIES = 30;

export function validateFlakyConfig(input: unknown): { config: FlakyConfig; errors: string[] } {
  const errors: string[] = [];
  if (input === undefined || input === null) return { config: { ...DEFAULT_FLAKY_CONFIG }, errors };
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push('flaky config must be an object');
    return { config: { ...DEFAULT_FLAKY_CONFIG }, errors };
  }
  const raw = input as { windowSize?: unknown; minRuns?: unknown };
  let windowSize = DEFAULT_FLAKY_CONFIG.windowSize;
  let minRuns = DEFAULT_FLAKY_CONFIG.minRuns;
  if (raw.windowSize !== undefined) {
    if (
      typeof raw.windowSize !== 'number' ||
      !Number.isInteger(raw.windowSize) ||
      raw.windowSize < MIN_FLAKY_WINDOW ||
      raw.windowSize > MAX_FLAKY_WINDOW
    ) {
      errors.push(`flaky.windowSize must be an integer ${MIN_FLAKY_WINDOW}..${MAX_FLAKY_WINDOW}`);
    } else {
      windowSize = raw.windowSize;
    }
  }
  if (raw.minRuns !== undefined) {
    if (
      typeof raw.minRuns !== 'number' ||
      !Number.isInteger(raw.minRuns) ||
      raw.minRuns < MIN_FLAKY_WINDOW ||
      raw.minRuns > MAX_FLAKY_WINDOW
    ) {
      errors.push(`flaky.minRuns must be an integer ${MIN_FLAKY_WINDOW}..${MAX_FLAKY_WINDOW}`);
    } else {
      minRuns = raw.minRuns;
    }
  }
  if (minRuns > windowSize) {
    errors.push('flaky.minRuns must not exceed flaky.windowSize');
  }
  return { config: { windowSize, minRuns }, errors };
}

export type FlakyStatus = 'flaky' | 'always-failing' | 'stable' | 'insufficient-data';

export interface FlakyTestEntry {
  key: string;
  file: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  /** Recent pass/fail outcomes, oldest → newest, capped at MAX_RECENT. */
  recent: Array<'pass' | 'fail'>;
  /** Pass/fail counts inside the configured verdict window. */
  passes: number;
  fails: number;
  /** Total runs this test was observed in. */
  runs: number;
  status: FlakyStatus;
}

export interface FlakyRunSummary {
  runId: string;
  at: string;
  label: string;
  file: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}

interface FlakyProjectData {
  config: FlakyConfig;
  tests: Record<string, FlakyTestEntry>;
  runs: FlakyRunSummary[];
}

export class FlakyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlakyStoreError';
  }
}

function atomicWriteJson(fp: string, value: unknown): void {
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, fp);
}

export function flakyHistoryPath(): string {
  const fromEnv = process.env.AI_FACTORY_FLAKY_HISTORY_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'flaky-history.json');
}

function classify(entry: FlakyTestEntry, config: FlakyConfig): FlakyStatus {
  const window = entry.recent.slice(-config.windowSize);
  if (window.length < config.minRuns) return 'insufficient-data';
  const fails = window.filter((r) => r === 'fail').length;
  const passes = window.length - fails;
  if (fails > 0 && passes > 0) return 'flaky';
  if (fails > 0) return 'always-failing';
  return 'stable';
}

export interface FlakyRecordResult {
  summary: FlakyRunSummary;
  newlyFlaky: string[];
  newlyStable: string[];
}

export class FlakyHistoryStore {
  private file: string;
  constructor(file?: string) {
    this.file = file ?? flakyHistoryPath();
  }

  private readAll(): Record<string, FlakyProjectData> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, FlakyProjectData>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad shape');
      return raw;
    } catch (e) {
      throw new FlakyStoreError(`flaky history store is corrupt: ${(e as Error).message}`);
    }
  }

  private readProject(projectId: string): FlakyProjectData {
    const all = this.readAll();
    const data = all[projectId] ?? {
      config: { ...DEFAULT_FLAKY_CONFIG },
      tests: {},
      runs: [],
    };
    // Tolerate hand-edited configs: re-validate, fall back to defaults.
    const { config } = validateFlakyConfig(data.config);
    data.config = config;
    return data;
  }

  private writeProject(projectId: string, data: FlakyProjectData): void {
    const all = this.readAll();
    all[projectId] = data;
    atomicWriteJson(this.file, all);
  }

  getConfig(projectId: string): FlakyConfig {
    return this.readProject(projectId).config;
  }

  setConfig(projectId: string, input: unknown): { config: FlakyConfig; errors: string[] } {
    const { config, errors } = validateFlakyConfig(input);
    if (errors.length > 0) return { config: this.getConfig(projectId), errors };
    const data = this.readProject(projectId);
    data.config = config;
    // Re-classify every test under the new window/thresholds.
    for (const entry of Object.values(data.tests)) {
      const window = entry.recent.slice(-config.windowSize);
      entry.passes = window.filter((r) => r === 'pass').length;
      entry.fails = window.length - entry.passes;
      entry.status = classify(entry, config);
    }
    this.writeProject(projectId, data);
    return { config, errors };
  }

  /**
   * Record one run's outcomes. skip/todo update lastSeen only — they are
   * neutral and never enter the pass/fail window.
   */
  recordRun(
    projectId: string,
    outcomes: TapTestOutcome[],
    meta: { label: string; file?: string },
  ): FlakyRecordResult {
    const data = this.readProject(projectId);
    const at = new Date().toISOString();
    const runId = randomUUID();
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let todo = 0;
    const newlyFlaky: string[] = [];
    const newlyStable: string[] = [];
    for (const raw of outcomes) {
      // R16 N3: test names are operator content and are stored as lookup
      // keys + UI labels, so redact them BEFORE they reach the persisted
      // history (flaky-history.json) and the GET readback. The scrub in
      // runTapFile stops env-derived values; this is defense-in-depth for
      // literal credential-shaped values in a test name (e.g. an sk-…
      // literal). The key and the name are redacted together so the
      // stored identity stays consistent across runs. Known boundary:
      // redactText does not mask `FACTORY_API_TOKEN=`-shaped lines, so a
      // literal of that shape in a name still survives — closing that
      // needs the value-aware output redaction of planned #6(h), not a
      // silent SECRET_PATTERNS change here. Gate-linkage lookups use the
      // raw parsed key, so a redacted entry is simply not matched there
      // (annotation-only, fail-closed).
      const o: TapTestOutcome = {
        ...raw,
        key: redactText(raw.key),
        name: redactText(raw.name),
      };
      let entry = data.tests[o.key];
      if (!entry) {
        entry = {
          key: o.key,
          file: o.file,
          name: o.name,
          firstSeen: at,
          lastSeen: at,
          recent: [],
          passes: 0,
          fails: 0,
          runs: 0,
          status: 'insufficient-data',
        };
        data.tests[o.key] = entry;
      }
      entry.lastSeen = at;
      entry.runs += 1;
      if (o.status === 'pass') passed += 1;
      else if (o.status === 'fail') failed += 1;
      else if (o.status === 'skip') skipped += 1;
      else todo += 1;
      if (o.status === 'pass' || o.status === 'fail') {
        const prev = entry.status;
        entry.recent.push(o.status);
        if (entry.recent.length > MAX_RECENT) entry.recent = entry.recent.slice(-MAX_RECENT);
        const window = entry.recent.slice(-data.config.windowSize);
        entry.passes = window.filter((r) => r === 'pass').length;
        entry.fails = window.length - entry.passes;
        entry.status = classify(entry, data.config);
        if (entry.status === 'flaky' && prev !== 'flaky') newlyFlaky.push(entry.key);
        if (entry.status === 'stable' && prev !== 'stable' && prev !== 'insufficient-data') {
          newlyStable.push(entry.key);
        }
      }
    }
    const summary: FlakyRunSummary = {
      runId,
      at,
      label: meta.label,
      file: meta.file ?? null,
      total: outcomes.length,
      passed,
      failed,
      skipped,
      todo,
    };
    data.runs.unshift(summary);
    data.runs = data.runs.slice(0, MAX_RUN_SUMMARIES);
    this.writeProject(projectId, data);
    return { summary, newlyFlaky, newlyStable };
  }

  get(projectId: string, key: string): FlakyTestEntry | undefined {
    return this.readProject(projectId).tests[key];
  }

  list(
    projectId: string,
    opts: { status?: FlakyStatus; limit?: number } = {},
  ): { config: FlakyConfig; tests: FlakyTestEntry[]; runs: FlakyRunSummary[]; total: number } {
    const data = this.readProject(projectId);
    let tests = Object.values(data.tests);
    if (opts.status) tests = tests.filter((t) => t.status === opts.status);
    const rank: Record<FlakyStatus, number> = {
      flaky: 0,
      'always-failing': 1,
      'insufficient-data': 2,
      stable: 3,
    };
    tests.sort((a, b) => rank[a.status] - rank[b.status] || b.lastSeen.localeCompare(a.lastSeen));
    const total = tests.length;
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
    return { config: data.config, tests: tests.slice(0, limit), runs: data.runs, total };
  }

  clear(projectId: string): void {
    const all = this.readAll();
    delete all[projectId];
    atomicWriteJson(this.file, all);
  }
}

/** Test seam: wipe the whole store file (tests only). */
export function resetFlakyHistoryForTests(file: string): void {
  if (existsSync(file)) writeFileSync(file, '{}\n', 'utf8');
}
