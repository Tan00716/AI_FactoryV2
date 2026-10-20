/**
 * Test coverage visualization data layer (Coverage Gutters-style).
 *
 * What it is: a deterministic *report reader*. Projects already produce
 * coverage reports (lcov from Istanbul/c8, cobertura XML from Jenkins
 * tooling, v8 JSON from Node's NODE_V8_COVERAGE); this module parses
 * them into one normalized line-level model, stores the latest report
 * per project, and serves it to the desktop Coverage panel.
 *
 * What it is NOT (honest boundary — also shown verbatim in the UI):
 *   - We do NOT instrument code and we do NOT run tests. Coverage data
 *     comes entirely from the project's own test tooling. If the
 *     report is stale, the numbers are stale.
 *   - A high coverage percentage does NOT mean strong assertions —
 *     lines can be executed without ever being checked. This is a
 *     visibility tool, not a quality proof.
 *   - v8 attribution is approximate: v8 reports block-level ranges,
 *     so per-line hits are the max hit count among ranges that
 *     intersect the line, and a line counts as covered when any
 *     executed range touches it. lcov/cobertura carry true per-line
 *     counts.
 *
 * Zero external dependencies; node builtins only, type-only imports —
 * tests may import this module straight from src under node's
 * type-stripping ESM loader (see AGENTS.md dual-mode import rule).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, resolve, sep } from 'node:path';

export type CoverageFormat = 'lcov' | 'cobertura' | 'v8';

/** One source file's line-level coverage. Line numbers are 1-based. */
export interface CoverageFile {
  path: string;
  totalLines: number;
  coveredLines: number;
  /** 0..1 fraction of instrumented lines with hits > 0. */
  coverage: number;
  /** line number (as string) -> hit count; only instrumented lines. */
  lines: Record<string, number>;
}

export interface CoverageSummary {
  files: number;
  totalLines: number;
  coveredLines: number;
  coverage: number;
}

export interface CoverageReport {
  format: CoverageFormat;
  /** Path of the report file the data came from (as configured). */
  reportPath: string;
  at: string;
  summary: CoverageSummary;
  files: CoverageFile[];
}

export interface CoverageHistoryEntry {
  at: string;
  format: CoverageFormat;
  trigger: string;
  summary: CoverageSummary;
}

/** Guard rails: coverage reports are operator/environment inputs. */
export const MAX_COVERAGE_REPORT_BYTES = 50 * 1024 * 1024;
export const MAX_COVERAGE_FILES = 100_000;
export const MAX_COVERAGE_HISTORY = 30;

export class CoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageError';
  }
}

export class CoveragePathError extends CoverageError {
  constructor(message: string) {
    super(message);
    this.name = 'CoveragePathError';
  }
}

export class CoverageParseError extends CoverageError {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageParseError';
  }
}

export class CoverageStoreError extends CoverageError {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageStoreError';
  }
}

/* ------------------------------------------------------------------ */
/* Path jail (FACTORY_COVERAGE_ROOTS — mirror of inspections jail)     */
/* ------------------------------------------------------------------ */

/**
 * Allowed roots for coverage report files. Relative report paths are
 * resolved against the first root (default: the server process cwd).
 * A report outside every root is fail-closed — the coverage routes
 * must never become a read-any-file oracle.
 */
export function coverageRoots(): string[] {
  const raw = (process.env.FACTORY_COVERAGE_ROOTS ?? '')
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const roots = raw.length ? raw : [process.cwd()];
  return roots.map((r) => resolve(r));
}

export function resolveCoverageReportPath(reportPath: string): string {
  const p = (reportPath ?? '').trim();
  if (!p) throw new CoveragePathError('coverage report path is empty');
  if (p.length > 4096) throw new CoveragePathError('coverage report path is too long');
  const roots = coverageRoots();
  const candidate = resolve(roots[0], p);
  for (const allowed of roots) {
    if (candidate === allowed || candidate.startsWith(allowed + sep)) return candidate;
  }
  throw new CoveragePathError(`coverage report path is outside the allowed roots: ${candidate}`);
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function summarize(files: CoverageFile[]): CoverageSummary {
  let totalLines = 0;
  let coveredLines = 0;
  for (const f of files) {
    totalLines += f.totalLines;
    coveredLines += f.coveredLines;
  }
  return {
    files: files.length,
    totalLines,
    coveredLines,
    coverage: totalLines > 0 ? coveredLines / totalLines : 0,
  };
}

function makeFile(path: string, hits: Map<number, number>): CoverageFile {
  const lines: Record<string, number> = {};
  let coveredLines = 0;
  for (const [line, count] of hits) {
    lines[String(line)] = count;
    if (count > 0) coveredLines += 1;
  }
  const totalLines = hits.size;
  return {
    path,
    totalLines,
    coveredLines,
    coverage: totalLines > 0 ? coveredLines / totalLines : 0,
    lines,
  };
}

/** Sort worst-first: the panel exists to show what is *not* covered. */
function sortFiles(files: CoverageFile[]): CoverageFile[] {
  return files.sort(
    (a, b) => a.coverage - b.coverage || b.totalLines - a.totalLines || a.path.localeCompare(b.path),
  );
}

/* ------------------------------------------------------------------ */
/* Format detection                                                    */
/* ------------------------------------------------------------------ */

export function detectCoverageFormat(text: string): CoverageFormat | null {
  const head = text.slice(0, 4096);
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{')) {
    // NODE_V8_COVERAGE files (and chrome inspector dumps) are JSON
    // objects with a `result` array of scripts carrying ranges.
    try {
      const parsed = JSON.parse(text) as { result?: unknown; url?: unknown };
      const result = Array.isArray(parsed) ? parsed : parsed.result;
      if (Array.isArray(result) && result.some((s) => s && typeof s === 'object' && 'functions' in (s as object))) {
        return 'v8';
      }
      if (Array.isArray(result) && result.some((s) => s && typeof s === 'object' && ('ranges' in (s as object) || Array.isArray((s as { functions?: unknown }).functions)))) {
        return 'v8';
      }
    } catch {
      /* not JSON — fall through */
    }
    return null;
  }
  if (/<coverage[\s>]/i.test(head) || /<coverage\s/i.test(text.slice(0, 8192))) return 'cobertura';
  if (/(^|\n)SF:/.test(text) || /(^|\n)TN:/.test(text)) return 'lcov';
  return null;
}

/* ------------------------------------------------------------------ */
/* lcov parser                                                          */
/*                                                                      */
/* SF:<path> starts a record; DA:<line>,<hits> carries line hits;      */
/* end_of_record closes it. Multiple records for the same path are     */
/* merged by summing hits (concatenated reports from several runs).    */
/* ------------------------------------------------------------------ */

export function parseLcovReport(text: string): CoverageFile[] {
  const byPath = new Map<string, Map<number, number>>();
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      current = line.slice(3).trim();
      if (current && !byPath.has(current)) byPath.set(current, new Map());
    } else if (line.startsWith('DA:') && current !== null) {
      const rest = line.slice(3);
      const comma = rest.indexOf(',');
      if (comma <= 0) continue;
      const lineNo = Number.parseInt(rest.slice(0, comma), 10);
      const hitsRaw = rest.slice(comma + 1).split(',')[0];
      const hits = Number.parseInt(hitsRaw, 10);
      if (!Number.isFinite(lineNo) || lineNo <= 0 || !Number.isFinite(hits)) continue;
      const map = byPath.get(current)!;
      map.set(lineNo, (map.get(lineNo) ?? 0) + Math.max(0, hits));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  const files: CoverageFile[] = [];
  for (const [path, hits] of byPath) {
    if (hits.size === 0) continue; // record with no DA lines: nothing to show
    files.push(makeFile(path, hits));
    if (files.length > MAX_COVERAGE_FILES) {
      throw new CoverageParseError(`lcov report exceeds ${MAX_COVERAGE_FILES} files`);
    }
  }
  if (files.length === 0) {
    throw new CoverageParseError('lcov report contains no line coverage data (no SF/DA records)');
  }
  return sortFiles(files);
}

/* ------------------------------------------------------------------ */
/* cobertura parser (hand-rolled, attribute-order tolerant)            */
/*                                                                      */
/* <class name=".." filename="src/x.ts" ..> ... <line number hits/>    */
/* <sources><source>/abs/root</source></sources> prefix relative       */
/* filenames. Only line hits are read (branches are deliberately       */
/* dropped: line coverage only, honest).                               */
/* ------------------------------------------------------------------ */

function xmlAttr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m ? m[1] : null;
}

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseCoberturaReport(text: string): CoverageFile[] {
  if (!/<coverage[\s>]/i.test(text)) {
    throw new CoverageParseError('not a cobertura document (missing <coverage> root)');
  }
  const sources: string[] = [];
  const sourcesMatch = /<sources>([\s\S]*?)<\/sources>/i.exec(text);
  if (sourcesMatch) {
    for (const m of sourcesMatch[1].matchAll(/<source>([^<]*)<\/source>/gi)) {
      const s = xmlDecode(m[1].trim());
      if (s) sources.push(s);
    }
  }
  const byPath = new Map<string, Map<number, number>>();
  const classRe = /<class\b[^>]*>([\s\S]*?)<\/class>/gi;
  let m: RegExpExecArray | null;
  let found = 0;
  while ((m = classRe.exec(text)) !== null) {
    found += 1;
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const filename = xmlAttr(openTag, 'filename');
    if (!filename) continue;
    const name = xmlDecode(filename);
    const path = sources.length && !name.startsWith('/')
      ? resolve(sources[0], name)
      : name;
    const hits = byPath.get(path) ?? new Map<number, number>();
    for (const lm of m[1].matchAll(/<line\b[^>]*>/gi)) {
      const numRaw = xmlAttr(lm[0], 'number');
      const hitsRaw = xmlAttr(lm[0], 'hits');
      if (numRaw === null || hitsRaw === null) continue;
      const lineNo = Number.parseInt(numRaw, 10);
      const count = Number.parseInt(hitsRaw, 10);
      if (!Number.isFinite(lineNo) || lineNo <= 0 || !Number.isFinite(count)) continue;
      hits.set(lineNo, (hits.get(lineNo) ?? 0) + Math.max(0, count));
    }
    if (hits.size > 0) byPath.set(path, hits);
  }
  if (found === 0) {
    throw new CoverageParseError('cobertura document contains no <class> elements');
  }
  const files: CoverageFile[] = [];
  for (const [path, hits] of byPath) {
    files.push(makeFile(path, hits));
    if (files.length > MAX_COVERAGE_FILES) {
      throw new CoverageParseError(`cobertura report exceeds ${MAX_COVERAGE_FILES} files`);
    }
  }
  if (files.length === 0) {
    throw new CoverageParseError('cobertura document contains no line hits');
  }
  return sortFiles(files);
}

/* ------------------------------------------------------------------ */
/* v8 JSON parser                                                       */
/*                                                                      */
/* NODE_V8_COVERAGE shape: { result: [ { scriptId, url, functions } ] }*/
/* url is a file:// URL; ranges carry char offsets + counts. Source   */
/* text is needed to translate offsets to lines — supplied by the     */
/* caller as a resolver (return null to skip a script). Line hit =     */
/* max count among ranges intersecting the line (approximate — see    */
/* the module header). Non-file URLs (node: internals etc.) skipped.  */
/* ------------------------------------------------------------------ */

interface V8Range { startOffset: number; endOffset: number; count: number }
interface V8Function { ranges: V8Range[] }
interface V8Script { url: string; functions: V8Function[] }

export function parseV8Report(text: string, readSource: (filePath: string) => string | null): CoverageFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CoverageParseError(`v8 coverage is not valid JSON: ${(e as Error).message}`);
  }
  const result = Array.isArray(parsed) ? parsed : (parsed as { result?: unknown }).result;
  if (!Array.isArray(result)) {
    throw new CoverageParseError('v8 coverage JSON has no `result` array');
  }
  const byPath = new Map<string, Map<number, number>>();
  for (const raw of result as V8Script[]) {
    if (!raw || typeof raw.url !== 'string' || !Array.isArray(raw.functions)) continue;
    const url = raw.url;
    if (!url.startsWith('file://')) continue;
    let filePath: string;
    try {
      filePath = decodeURIComponent(url.slice('file://'.length).replace(/^localhost/, ''));
    } catch {
      continue;
    }
    const source = readSource(filePath);
    if (source === null) continue;
    // Offset -> line index: lineStart[k] is the offset of line k+1.
    const lineStart: number[] = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) lineStart.push(i + 1);
    }
    const lineOf = (offset: number): number => {
      let lo = 0;
      let hi = lineStart.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStart[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const hits = byPath.get(filePath) ?? new Map<number, number>();
    // Only lines that contain non-whitespace can be "instrumented";
    // v8 counts a line as hit when any executed range covers it.
    const sourceLines = source.split('\n');
    const touched = new Set<number>();
    for (const fn of raw.functions) {
      for (const range of fn.ranges ?? []) {
        const start = Math.max(0, range.startOffset);
        const end = Math.min(source.length, range.endOffset);
        const firstLine = lineOf(start);
        const lastLine = lineOf(Math.max(start, end - 1));
        for (let ln = firstLine; ln <= lastLine; ln++) {
          if (ln <= sourceLines.length && (sourceLines[ln - 1] ?? '').trim() !== '') {
            touched.add(ln);
            if (range.count > 0) {
              hits.set(ln, Math.max(hits.get(ln) ?? 0, range.count));
            }
          }
        }
      }
    }
    for (const ln of touched) {
      if (!hits.has(ln)) hits.set(ln, 0);
    }
    if (hits.size > 0) byPath.set(filePath, hits);
    if (byPath.size > MAX_COVERAGE_FILES) {
      throw new CoverageParseError(`v8 report exceeds ${MAX_COVERAGE_FILES} files`);
    }
  }
  const files: CoverageFile[] = [];
  for (const [path, hits] of byPath) files.push(makeFile(path, hits));
  if (files.length === 0) {
    throw new CoverageParseError('v8 coverage contains no readable file:// scripts with ranges');
  }
  return sortFiles(files);
}

/* ------------------------------------------------------------------ */
/* Top-level parse entry point                                         */
/* ------------------------------------------------------------------ */

export function parseCoverageReport(
  text: string,
  opts: { format?: CoverageFormat | null; reportPath?: string; readSource?: (p: string) => string | null } = {},
): CoverageReport {
  if (text.length > MAX_COVERAGE_REPORT_BYTES) {
    throw new CoverageParseError(`coverage report exceeds ${MAX_COVERAGE_REPORT_BYTES} bytes`);
  }
  const format = opts.format ?? detectCoverageFormat(text);
  if (!format) {
    throw new CoverageParseError('unrecognized coverage report format (expected lcov, cobertura or v8 JSON)');
  }
  let files: CoverageFile[];
  if (format === 'lcov') files = parseLcovReport(text);
  else if (format === 'cobertura') files = parseCoberturaReport(text);
  else {
    const readSource =
      opts.readSource ??
      ((p: string) => {
        try {
          return existsSync(p) ? readFileSync(p, 'utf8') : null;
        } catch {
          return null;
        }
      });
    files = parseV8Report(text, readSource);
  }
  return {
    format,
    reportPath: opts.reportPath ?? '',
    at: new Date().toISOString(),
    summary: summarize(files),
    files,
  };
}

/* ------------------------------------------------------------------ */
/* Store (JSON file, atomic writes, corrupt = fail-closed)             */
/* ------------------------------------------------------------------ */

interface ProjectCoverageRecord {
  latest: CoverageReport | null;
  history: CoverageHistoryEntry[];
}

interface CoverageFile_ {
  version: 1;
  projects: Record<string, ProjectCoverageRecord>;
}

export function coverageStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_COVERAGE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'coverage-reports.json');
}

function isValidStoredFile(v: unknown): v is CoverageFile {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.path === 'string' &&
    typeof f.totalLines === 'number' &&
    typeof f.coveredLines === 'number' &&
    typeof f.coverage === 'number' &&
    typeof f.lines === 'object' &&
    f.lines !== null
  );
}

export class CoverageStore {
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? coverageStorePath();
  }

  private load(): CoverageFile_ {
    if (!existsSync(this.path)) return { version: 1, projects: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e) {
      throw new CoverageStoreError(
        `coverage store is corrupt (${this.path}): ${(e as Error).message}`,
      );
    }
    const projects: Record<string, ProjectCoverageRecord> = {};
    const list = (raw as { projects?: Record<string, unknown> }).projects ?? {};
    for (const [projectId, rec] of Object.entries(list)) {
      const r = rec as { latest?: unknown; history?: unknown } | null;
      if (!r || typeof r !== 'object') continue;
      const latest = (r.latest ?? null) as CoverageReport | null;
      projects[projectId] = {
        latest:
          latest && Array.isArray(latest.files) && latest.files.every(isValidStoredFile)
            ? latest
            : null,
        history: Array.isArray(r.history) ? (r.history as CoverageHistoryEntry[]) : [],
      };
    }
    return { version: 1, projects };
  }

  private save(file: CoverageFile_): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), 'utf8');
    renameSync(tmp, this.path);
  }

  /** Record a freshly parsed report as the project's latest + history entry. */
  record(projectId: string, report: CoverageReport, opts: { trigger?: string } = {}): void {
    const file = this.load();
    const rec = file.projects[projectId] ?? { latest: null, history: [] };
    rec.latest = report;
    rec.history = [
      ...rec.history,
      {
        at: report.at,
        format: report.format,
        trigger: opts.trigger ?? 'import',
        summary: report.summary,
      },
    ].slice(-MAX_COVERAGE_HISTORY);
    file.projects[projectId] = rec;
    this.save(file);
  }

  /** Latest report (full, incl. per-file line maps) or null. */
  get(projectId: string): ProjectCoverageRecord {
    return this.load().projects[projectId] ?? { latest: null, history: [] };
  }
}
