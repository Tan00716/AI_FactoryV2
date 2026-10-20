/**
 * Declarative multi-repo Batch Changes (Sourcegraph Batch Changes style),
 * zero-model.
 *
 * An operator writes a batch spec (strict YAML subset — see parseBatchSpec)
 * naming registry repos and a list of steps; the engine then, per repo:
 *   1. `git checkout -b <branch>` (branch-exists policy: fail|skip|reuse)
 *   2. runs each step — `run:` shell commands, `edit:` deterministic
 *      string replacements — sequentially (onFailure: stop|continue)
 *   3. optionally attempts `git push` / `gh pr create` ONLY when a remote
 *      is configured AND reachable (default push:'skip')
 * A desktop dashboard tracks every batch and every repo's state.
 *
 * WHAT THIS IS, honestly:
 *
 *  - git plumbing (branch, push attempt, ls-remote reachability check)
 *    goes through execFile('git', …) directly — the deterministic,
 *    non-arbitrary part, same as worktrees.ts. git can only mutate the
 *    registered repo directory (its cwd); nothing else on the machine
 *    is in scope.
 *  - `run:` steps are OPERATOR-AUTHORED shell (sh -c, cwd = the repo).
 *    Trust posture = quality-gate hooks: they run with the operator's own
 *    privileges, every step is audit-recorded with exit code + truncated
 *    output, judgment is exit-code-only, and there is NO sandbox claim
 *    on machines without one. (bwrap is not installed here; claiming
 *    isolation would be a lie. See exec-sandbox.ts fail-closed docs.)
 *  - `edit:` steps are deterministic literal string replacement, NOT
 *    semantic refactoring. Same-named files with different content across
 *    repos will diverge — a failed `mustMatch` stops that step, and the
 *    dashboard flags it for a human. This is stated in the UI copy too.
 *  - push/PR are attempts, never promises: no remote → skipped with
 *    reason recorded; remote unreachable → skipped with reason; gh
 *    missing → PR skipped with reason. The batch never silently drops
 *    a push. Default is push:'skip' (local branches only).
 *  - registry path jail: a repo path must sit under FACTORY_REPO_ROOTS
 *    (comma-separated); empty = deny everything, fail-closed. A remote
 *    URL is recorded metadata only — batch changes NEVER clones.
 *
 * Persistence: AI_FACTORY_DATA_DIR/batch-changes.json, atomic temp+rename
 * writes, fail-closed on corrupt file (serve empty, refuse writes).
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class BatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchError';
    this.code = code;
  }
}

export function batchErrorStatus(e: unknown): number {
  if (e instanceof BatchError) {
    switch (e.code) {
      case 'BATCH_NOT_FOUND':
      case 'REPO_NOT_FOUND':
        return 404;
      case 'SPEC_INVALID':
      case 'BAD_REQUEST':
      case 'REGISTRY_INVALID':
      case 'PATH_ESCAPE':
        return 400;
      case 'REPO_CONFLICT':
      case 'BRANCH_EXISTS':
        return 409;
      case 'STORE_CORRUPT':
        return 503;
      default:
        return 500;
    }
  }
  return 500;
}

/* ------------------------------------------------------------------ */
/* Batch spec: types + strict YAML-subset parser                        */
/* ------------------------------------------------------------------ */

export interface EditRule {
  file: string;
  search: string;
  replace: string;
  /** How many matches to replace: 1 (default), N, or 'all'. */
  occurrences?: number | 'all';
  /** Fail the step when nothing matched (default true). */
  mustMatch?: boolean;
}

export type BatchStep =
  | { name: string; run: string; timeoutMs?: number }
  | { name: string; edit: EditRule };

export interface BatchSpec {
  name: string;
  /** Registry repo names. */
  repos: string[];
  /** Branch name (validated git ref-safe). */
  branch: string;
  /** What to do when a repo fails: 'stop' | 'continue' (default 'stop'). */
  onFailure: 'stop' | 'continue';
  /** Branch already exists: 'fail' (default) | 'skip' | 'reuse'. */
  branchExists: 'fail' | 'skip' | 'reuse';
  /** 'skip' (default) = local branches only; 'try' = push when possible. */
  push: 'skip' | 'try';
  /** Attempt `gh pr create` when a reachable github remote exists. */
  pr: boolean;
  steps: BatchStep[];
}

/**
 * Minimal strict YAML subset parser — no external dependency.
 * Supports: nested maps via indentation, lists of scalars, lists of
 * maps, plain / single-quoted / double-quoted scalars, `#` comments.
 * Rejects: anchors, aliases, tags, flow styles, duplicate keys,
 * inconsistent indentation, tabs.
 */
export function parseYamlSubset(text: string): unknown {
  const rawLines = text.split(/\r?\n/);
  type L = { indent: number; text: string };
  const lines: L[] = [];
  rawLines.forEach((raw, i) => {
    if (/^\s*(#.*)?$/.test(raw)) return; // blank / comment
    const m = raw.match(/^(\s*)(\S.*)$/);
    if (!m) throw new BatchError('SPEC_INVALID', `line ${i + 1}: empty content`);
    const indent = m[1].length;
    if (/\t/.test(m[1])) throw new BatchError('SPEC_INVALID', `line ${i + 1}: tabs are not allowed`);
    lines.push({ indent, text: m[2] });
  });
  if (lines.length === 0) throw new BatchError('SPEC_INVALID', 'empty spec');
  const [value, next] = parseBlock(lines, 0, -1);
  if (next !== lines.length) {
    throw new BatchError('SPEC_INVALID', `line ${next + 1}: unexpected content`);
  }
  return value;
}

function parseBlock(lines: { indent: number; text: string }[], i: number, parentIndent: number): [unknown, number] {
  const first = lines[i];
  if (first.indent <= parentIndent) {
    throw new BatchError('SPEC_INVALID', 'indentation error');
  }
  const indent = first.indent;
  if (first.text.startsWith('- ') || first.text === '-') {
    return parseList(lines, i, indent);
  }
  return parseMap(lines, i, indent);
}

function parseMap(lines: { indent: number; text: string }[], i: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let j = i;
  while (j < lines.length && lines[j].indent === indent && !lines[j].text.startsWith('-')) {
    const m = lines[j].text.match(/^([^:]+):(.*)$/);
    if (!m) throw new BatchError('SPEC_INVALID', `expected "key:" — got "${lines[j].text}"`);
    const key = m[1].trim();
    if (!key) throw new BatchError('SPEC_INVALID', 'empty key');
    if (key in out) throw new BatchError('SPEC_INVALID', `duplicate key "${key}"`);
    const rest = m[2].trim();
    j++;
    if (rest !== '') {
      if (rest.startsWith('#')) {
        out[key] = null;
      } else {
        out[key] = parseScalar(rest);
      }
    } else if (j < lines.length && lines[j].indent > indent) {
      const [v, nj] = parseBlock(lines, j, indent);
      out[key] = v;
      j = nj;
    } else {
      out[key] = null;
    }
  }
  return [out, j];
}

function parseList(lines: { indent: number; text: string }[], i: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let j = i;
  while (j < lines.length && lines[j].indent === indent && (lines[j].text.startsWith('- ') || lines[j].text === '-')) {
    const itemText = lines[j].text === '-' ? '' : lines[j].text.slice(2);
    j++;
    const itemIndent = indent + 2;
    // Collect continuation lines (deeper indent) belonging to this item.
    const cont: { indent: number; text: string }[] = [];
    let k = j;
    while (k < lines.length && lines[k].indent > indent) {
      cont.push(lines[k]);
      k++;
    }
    if (itemText === '') {
      if (cont.length === 0) {
        out.push(null);
      } else {
        const [v] = parseBlock(cont, 0, indent);
        out.push(v);
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_.-]*\s*:(\s|$)/.test(itemText)) {
      // List item is a map starting on the dash line: the key looks like
      // an identifier AND the colon is followed by whitespace/EOL. A
      // plain scalar containing a colon such as a URL
      // (`- http://example.com/x`) must NOT be misread as a map. Continuation lines
      // keep their original indents (all deeper than the dash indent), so
      // relative nesting is preserved under itemIndent = dash+2.
      const sub = [{ indent: itemIndent, text: itemText }].concat(cont);
      const [m] = parseMap(sub, 0, itemIndent);
      out.push(m);
    } else {
      if (cont.length > 0) {
        throw new BatchError('SPEC_INVALID', 'scalar list item cannot have nested content');
      }
      out.push(parseScalar(itemText));
    }
    j = k;
  }
  return [out, j];
}

function parseScalar(s: string): unknown {
  let t = s.trim();
  // Strip a trailing comment only when it sits OUTSIDE quotes.
  let end = t.length;
  let inS = false;
  let inD = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && i > 0 && /\s/.test(t[i - 1])) {
      end = i;
      break;
    }
  }
  t = t.slice(0, end).trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  return t;
}

/* ------------------------------------------------------------------ */
/* Spec validation: unknown YAML → BatchSpec                            */
/* ------------------------------------------------------------------ */

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new BatchError('SPEC_INVALID', `${what} must be a non-empty string`);
  }
  return v.trim();
}

function validateEditRule(raw: unknown, stepName: string): EditRule {
  if (!isPlainObject(raw)) throw new BatchError('SPEC_INVALID', `step "${stepName}": edit must be a map`);
  const allowed = new Set(['file', 'search', 'replace', 'occurrences', 'mustMatch']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new BatchError('SPEC_INVALID', `step "${stepName}": unknown edit key "${k}"`);
  }
  const file = asString(raw['file'], `step "${stepName}": edit.file`);
  if (isAbsolute(file) || file.split('/').includes('..')) {
    throw new BatchError('SPEC_INVALID', `step "${stepName}": edit.file must be a relative path without ".."`);
  }
  const search = typeof raw['search'] === 'string' ? raw['search'] : '';
  if (!search) throw new BatchError('SPEC_INVALID', `step "${stepName}": edit.search must be non-empty`);
  const replace = typeof raw['replace'] === 'string' ? raw['replace'] : '';
  let occurrences: number | 'all' | undefined;
  const occ = raw['occurrences'];
  if (occ !== undefined && occ !== null) {
    if (occ === 'all') occurrences = 'all';
    else if (typeof occ === 'string' && /^\d+$/.test(occ)) occurrences = parseInt(occ, 10);
    else throw new BatchError('SPEC_INVALID', `step "${stepName}": edit.occurrences must be a positive integer or "all"`);
    if (occurrences !== 'all' && occurrences < 1) {
      throw new BatchError('SPEC_INVALID', `step "${stepName}": edit.occurrences must be >= 1`);
    }
  }
  let mustMatch: boolean | undefined;
  const mm = raw['mustMatch'];
  if (mm !== undefined && mm !== null) {
    if (typeof mm !== 'boolean') throw new BatchError('SPEC_INVALID', `step "${stepName}": edit.mustMatch must be true/false`);
    mustMatch = mm;
  }
  return { file, search, replace, ...(occurrences !== undefined ? { occurrences } : {}), ...(mustMatch !== undefined ? { mustMatch } : {}) };
}

function validateStep(raw: unknown, idx: number): BatchStep {
  if (!isPlainObject(raw)) throw new BatchError('SPEC_INVALID', `steps[${idx}] must be a map`);
  const name = typeof raw['name'] === 'string' && raw['name'].trim() ? raw['name'].trim().slice(0, 120) : `step-${idx + 1}`;
  const hasRun = raw['run'] !== undefined && raw['run'] !== null;
  const hasEdit = raw['edit'] !== undefined && raw['edit'] !== null;
  if (hasRun === hasEdit) {
    throw new BatchError('SPEC_INVALID', `step "${name}": exactly one of run / edit is required`);
  }
  const allowed = new Set(['name', 'run', 'edit', 'timeoutMs']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new BatchError('SPEC_INVALID', `step "${name}": unknown key "${k}"`);
  }
  if (hasRun) {
    const run = asString(raw['run'], `step "${name}": run`);
    if (run.length > 8000) throw new BatchError('SPEC_INVALID', `step "${name}": run command too long (max 8000)`);
    let timeoutMs: number | undefined;
    const t: unknown = raw['timeoutMs'];
    if (t !== undefined && t !== null) {
      const n = typeof t === 'string' ? parseInt(t, 10) : (t as number);
      if (!Number.isInteger(n) || (n as number) < 1000 || (n as number) > 600000) {
        throw new BatchError('SPEC_INVALID', `step "${name}": timeoutMs must be 1000..600000`);
      }
      timeoutMs = n as number;
    }
    return { name, run, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  }
  return { name, edit: validateEditRule(raw['edit'], name) };
}

export function parseBatchSpecYaml(yamlText: string): BatchSpec {
  if (typeof yamlText !== 'string' || !yamlText.trim()) {
    throw new BatchError('SPEC_INVALID', 'spec is empty');
  }
  if (yamlText.length > 200_000) throw new BatchError('SPEC_INVALID', 'spec too large (max 200KB)');
  const doc = parseYamlSubset(yamlText);
  if (!isPlainObject(doc)) throw new BatchError('SPEC_INVALID', 'spec must be a mapping');
  const allowed = new Set(['name', 'repos', 'branch', 'onFailure', 'branchExists', 'push', 'pr', 'steps']);
  for (const k of Object.keys(doc)) {
    if (!allowed.has(k)) throw new BatchError('SPEC_INVALID', `unknown spec key "${k}"`);
  }
  const name = asString(doc['name'], 'spec.name').slice(0, 120);
  const reposRaw = doc['repos'];
  if (!Array.isArray(reposRaw) || reposRaw.length === 0) {
    throw new BatchError('SPEC_INVALID', 'spec.repos must be a non-empty list of registry names');
  }
  if (reposRaw.length > 50) throw new BatchError('SPEC_INVALID', 'spec.repos: at most 50 repos per batch');
  const repos = reposRaw.map((r, i) => {
    const n = asString(r, `spec.repos[${i}]`);
    if (!REPO_NAME_RE.test(n)) throw new BatchError('SPEC_INVALID', `spec.repos[${i}]: invalid repo name "${n}"`);
    return n;
  });
  if (new Set(repos).size !== repos.length) throw new BatchError('SPEC_INVALID', 'spec.repos: duplicate repo names');
  const branch = asString(doc['branch'], 'spec.branch');
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.includes('@{')) {
    throw new BatchError('SPEC_INVALID', `spec.branch "${branch}" is not a safe git ref name`);
  }
  const onFailure = doc['onFailure'] === undefined || doc['onFailure'] === null ? 'stop' : doc['onFailure'];
  if (onFailure !== 'stop' && onFailure !== 'continue') {
    throw new BatchError('SPEC_INVALID', 'spec.onFailure must be "stop" or "continue"');
  }
  const branchExists = doc['branchExists'] === undefined || doc['branchExists'] === null ? 'fail' : doc['branchExists'];
  if (branchExists !== 'fail' && branchExists !== 'skip' && branchExists !== 'reuse') {
    throw new BatchError('SPEC_INVALID', 'spec.branchExists must be "fail", "skip" or "reuse"');
  }
  const push = doc['push'] === undefined || doc['push'] === null ? 'skip' : doc['push'];
  if (push !== 'skip' && push !== 'try') {
    throw new BatchError('SPEC_INVALID', 'spec.push must be "skip" or "try"');
  }
  const pr = doc['pr'] === undefined || doc['pr'] === null ? false : doc['pr'];
  if (typeof pr !== 'boolean') throw new BatchError('SPEC_INVALID', 'spec.pr must be true/false');
  const stepsRaw = doc['steps'];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new BatchError('SPEC_INVALID', 'spec.steps must be a non-empty list');
  }
  if (stepsRaw.length > 30) throw new BatchError('SPEC_INVALID', 'spec.steps: at most 30 steps');
  const steps = stepsRaw.map((s, i) => validateStep(s, i));
  return { name, repos, branch, onFailure, branchExists, push, pr, steps };
}

/* ------------------------------------------------------------------ */
/* Repo registry: global + project-level, path-jail                     */
/* ------------------------------------------------------------------ */

export interface RepoRegistration {
  name: string;
  path: string;
  remoteUrl?: string;
  addedBy: string;
  addedAt: string;
  /** 'global' | 'project' — where it was registered. */
  scope: 'global' | 'project';
}

export function repoRootsFromEnv(): string[] {
  const raw = process.env.FACTORY_REPO_ROOTS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));
}

function assertInsideRoots(abs: string, roots: string[]): void {
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + sep)) return;
  }
  throw new BatchError(
    'PATH_ESCAPE',
    `repo path is outside the allowed roots (set FACTORY_REPO_ROOTS): ${abs}`,
  );
}

export function globalRegistryPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'ai-factory', 'repos.json');
}

export function projectRegistryPath(projectPath: string): string {
  return join(resolve(projectPath), '.ai-factory', 'repos.json');
}

function readRegistryFile(path: string): RepoRegistration[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new BatchError('REGISTRY_INVALID', `registry file is corrupt: ${path}`);
  }
  const list = (raw as { repos?: unknown[] }).repos ?? [];
  if (!Array.isArray(list)) throw new BatchError('REGISTRY_INVALID', `registry file malformed: ${path}`);
  const out: RepoRegistration[] = [];
  for (const r of list) {
    if (!isPlainObject(r) || typeof r['name'] !== 'string' || typeof r['path'] !== 'string') {
      throw new BatchError('REGISTRY_INVALID', `registry entry malformed in ${path}`);
    }
    const reg: RepoRegistration = {
      name: r['name'],
      path: r['path'],
      scope: 'global',
      addedBy: typeof r['addedBy'] === 'string' ? r['addedBy'] : 'unknown',
      addedAt: typeof r['addedAt'] === 'string' ? r['addedAt'] : '',
    };
    if (typeof r['remoteUrl'] === 'string' && r['remoteUrl']) reg.remoteUrl = r['remoteUrl'];
    out.push(reg);
  }
  return out;
}

function writeRegistryFile(path: string, repos: RepoRegistration[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ repos }, null, 2), 'utf8');
  renameSync(tmp, path);
}

export interface RepoRegistry {
  /** Merged view: project scope wins over global on name clash. */
  list(projectPath?: string): RepoRegistration[];
  get(name: string, projectPath?: string): RepoRegistration | undefined;
  register(input: { name: string; path: string; remoteUrl?: string; projectPath?: string; addedBy?: string }): RepoRegistration;
  unregister(name: string, projectPath?: string): boolean;
}

export function createRepoRegistry(): RepoRegistry {
  function fileFor(projectPath?: string): { path: string; scope: 'global' | 'project' } {
    if (projectPath) return { path: projectRegistryPath(projectPath), scope: 'project' };
    return { path: globalRegistryPath(), scope: 'global' };
  }

  function loadScoped(projectPath?: string): RepoRegistration[] {
    const { path, scope } = fileFor(projectPath);
    return readRegistryFile(path).map((r) => ({ ...r, scope }));
  }

  return {
    list(projectPath?: string) {
      const merged = new Map<string, RepoRegistration>();
      for (const r of loadScoped()) merged.set(r.name, r);
      if (projectPath) {
        for (const r of loadScoped(projectPath)) merged.set(r.name, r);
      }
      return [...merged.values()];
    },
    get(name: string, projectPath?: string) {
      return this.list(projectPath).find((r) => r.name === name);
    },
    register(input) {
      const name = (input.name ?? '').trim();
      if (!REPO_NAME_RE.test(name)) throw new BatchError('REGISTRY_INVALID', `invalid repo name "${input.name}"`);
      const rawPath = (input.path ?? '').trim();
      if (!rawPath) throw new BatchError('REGISTRY_INVALID', 'repo path is required');
      const abs = resolve(rawPath);
      assertInsideRoots(abs, repoRootsFromEnv());
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        throw new BatchError('REGISTRY_INVALID', `repo path does not exist: ${abs}`);
      }
      if (!existsSync(join(real, '.git'))) {
        throw new BatchError('REGISTRY_INVALID', `not a git repository (refusing to register): ${real}`);
      }
      const { path, scope } = fileFor(input.projectPath);
      const existing = readRegistryFile(path);
      if (existing.some((r) => r.name === name)) {
        throw new BatchError('REPO_CONFLICT', `repo "${name}" already registered in ${scope} scope`);
      }
      const reg: RepoRegistration = {
        name,
        path: real,
        scope,
        addedBy: input.addedBy ?? 'human',
        addedAt: new Date().toISOString(),
      };
      const remoteUrl = (input.remoteUrl ?? '').trim();
      if (remoteUrl) reg.remoteUrl = remoteUrl.slice(0, 500);
      existing.push(reg);
      writeRegistryFile(path, existing);
      return reg;
    },
    unregister(name: string, projectPath?: string) {
      const { path } = fileFor(projectPath);
      const existing = readRegistryFile(path);
      const idx = existing.findIndex((r) => r.name === name);
      if (idx < 0) return false;
      existing.splice(idx, 1);
      writeRegistryFile(path, existing);
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Batch store: atomic JSON, corrupt fail-closed                        */
/* ------------------------------------------------------------------ */

export function batchStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_BATCH_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'batch-changes.json');
}

export type RepoRunStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
export type PushResult = 'not-attempted' | 'pushed' | 'failed' | 'skipped-no-remote' | 'skipped-unreachable';
export type PrResult = 'not-attempted' | 'created' | 'failed' | 'skipped-no-gh' | 'skipped';

export interface StepResult {
  name: string;
  kind: 'run' | 'edit';
  ok: boolean;
  exitCode?: number;
  ms: number;
  /** Truncated stdout+stderr for run steps, match note for edit steps. */
  output?: string;
  error?: string;
}

export interface BatchRepoRun {
  name: string;
  path: string;
  status: RepoRunStatus;
  branch?: string;
  head?: string;
  stepResults: StepResult[];
  push: PushResult;
  pr: PrResult;
  error?: string;
}

export type BatchStatus = 'created' | 'running' | 'done';

export interface BatchRecord {
  id: string;
  name: string;
  status: BatchStatus;
  spec: BatchSpec;
  repos: BatchRepoRun[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class BatchStore {
  private readonly path: string;
  private batches: BatchRecord[] = [];
  private corrupt = false;

  constructor(path?: string) {
    this.path = path ?? batchStorePath();
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { batches?: unknown[] };
      for (const b of raw.batches ?? []) {
        if (isBatchRecord(b)) this.batches.push(b);
      }
    } catch {
      this.corrupt = true;
    }
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }

  private persist(): void {
    if (this.corrupt) throw new BatchError('STORE_CORRUPT', 'batch store is corrupt; writes refused');
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ batches: this.batches }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  list(): BatchRecord[] {
    return this.batches.map((b) => structuredClone(b));
  }

  get(id: string): BatchRecord | undefined {
    const b = this.batches.find((x) => x.id === id);
    return b ? structuredClone(b) : undefined;
  }

  save(batch: BatchRecord): void {
    const idx = this.batches.findIndex((x) => x.id === batch.id);
    if (idx < 0) this.batches.push(structuredClone(batch));
    else this.batches[idx] = structuredClone(batch);
    this.persist();
  }

  remove(id: string): boolean {
    const idx = this.batches.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    this.batches.splice(idx, 1);
    this.persist();
    return true;
  }
}

function isBatchRecord(b: unknown): b is BatchRecord {
  if (!isPlainObject(b)) return false;
  return (
    typeof b['id'] === 'string' &&
    typeof b['name'] === 'string' &&
    Array.isArray(b['repos']) &&
    isPlainObject(b['spec'])
  );
}

/* ------------------------------------------------------------------ */
/* Execution engine                                                     */
/* ------------------------------------------------------------------ */

export interface AuditHook {
  record(actor: string, event: string, entity: string, entityId: string, details?: Record<string, unknown>): void;
}

export interface GitRunner {
  /** Run git with cwd; returns stdout. Throws on failure. */
  (args: string[], cwd: string, timeoutMs?: number): string;
}

export function defaultGitRunner(args: string[], cwd: string, timeoutMs = 30_000): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = e as { message?: string; stdout?: string; stderr?: string; code?: unknown };
    throw new BatchError('GIT_FAILED', `git ${args.join(' ')} failed: ${err.stderr?.trim() || err.message || 'unknown'}`);
  }
}

export interface RunCommandResult {
  ok: boolean;
  exitCode: number;
  ms: number;
  output: string;
}

/**
 * Run an operator-authored shell step (sh -c, cwd = repo).
 * Trust posture = quality-gate / hooks: operator's own privileges,
 * exit-code-only judgment, 20KB-per-stream truncation disclosed,
 * no sandbox claim. Sync spawn would block the event loop on slow
 * commands; we use async spawn with a hard timeout kill.
 */
export function runShellCommand(cmd: string, cwd: string, timeoutMs: number): Promise<RunCommandResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RunCommandResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn('sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      done({ ok: false, exitCode: -1, ms: Date.now() - t0, output: `spawn failed: ${(e as Error).message}` });
      return;
    }
    let out = '';
    let err = '';
    const CAP = 20_480;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > CAP) out = out.slice(0, CAP);
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
      if (err.length > CAP) err = err.slice(0, CAP);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, exitCode: -1, ms: Date.now() - t0, output: `timed out after ${timeoutMs}ms (killed)` });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, exitCode: -1, ms: Date.now() - t0, output: `spawn error: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = (out + (err ? `\n[stderr]\n${err}` : '')).slice(0, 41_000);
      const truncated = out.length >= CAP || err.length >= CAP;
      done({
        ok: code === 0,
        exitCode: code ?? -1,
        ms: Date.now() - t0,
        output: truncated ? combined + '\n[output truncated at 20KB/stream — truncation does not affect the exit-code verdict]' : combined,
      });
    });
  });
}

function hasGhOnPath(): boolean {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return false;
  }
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export interface BatchExecutorOptions {
  registry: RepoRegistry;
  store: BatchStore;
  audit: AuditHook;
  git?: GitRunner;
  /** Overrideable clock for tests. */
  now?: () => string;
}

export class BatchExecutor {
  private readonly registry: RepoRegistry;
  private readonly store: BatchStore;
  private readonly audit: AuditHook;
  private readonly git: GitRunner;
  private readonly now: () => string;

  constructor(opts: BatchExecutorOptions) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.audit = opts.audit;
    this.git = opts.git ?? defaultGitRunner;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Parse + validate + persist a new batch (does not run it). */
  createBatch(specYaml: string, createdBy: string, projectPath?: string): BatchRecord {
    const spec = parseBatchSpecYaml(specYaml);
    const repos: BatchRepoRun[] = spec.repos.map((name) => {
      const reg = this.registry.get(name, projectPath);
      if (!reg) {
        throw new BatchError('REPO_NOT_FOUND', `repo "${name}" is not registered (check /api/batch-changes/repos)`);
      }
      return {
        name,
        path: reg.path,
        status: 'pending' as RepoRunStatus,
        stepResults: [],
        push: 'not-attempted' as PushResult,
        pr: 'not-attempted' as PrResult,
      };
    });
    const batch: BatchRecord = {
      id: randomUUID(),
      name: spec.name,
      status: 'created',
      spec,
      repos,
      createdBy: createdBy || 'human',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.store.save(batch);
    this.audit.record(batch.createdBy, 'BATCH_CREATED', 'batch', batch.id, {
      name: batch.name,
      repos: spec.repos,
      branch: spec.branch,
      steps: spec.steps.length,
    });
    return structuredClone(batch);
  }

  /** Run all pending repos of a batch, sequentially. Synchronous. */
  async runBatch(id: string, actor: string): Promise<BatchRecord> {
    const batch = this.store.get(id);
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `batch ${id} not found`);
    if (batch.status === 'running') throw new BatchError('BAD_REQUEST', 'batch is already running');
    batch.status = 'running';
    batch.updatedAt = this.now();
    this.store.save(batch);
    this.audit.record(actor, 'BATCH_RUN_STARTED', 'batch', id, { repos: batch.repos.map((r) => r.name) });

    for (const repo of batch.repos) {
      if (repo.status !== 'pending') continue;
      const ok = await this.runOneRepo(batch, repo, actor);
      this.store.save(batch);
      if (!ok && batch.spec.onFailure === 'stop') {
        for (const rest of batch.repos) {
          if (rest.status === 'pending') rest.status = 'skipped';
        }
        break;
      }
    }
    batch.status = 'done';
    batch.updatedAt = this.now();
    this.store.save(batch);
    this.audit.record(actor, 'BATCH_RUN_FINISHED', 'batch', id, {
      summary: batch.repos.map((r) => `${r.name}:${r.status}`).join(', '),
    });
    return structuredClone(batch);
  }

  /** Reset one repo to pending and run only it. */
  async retryRepo(id: string, repoName: string, actor: string): Promise<BatchRecord> {
    const batch = this.store.get(id);
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `batch ${id} not found`);
    const repo = batch.repos.find((r) => r.name === repoName);
    if (!repo) throw new BatchError('REPO_NOT_FOUND', `repo "${repoName}" not in batch`);
    repo.status = 'pending';
    repo.stepResults = [];
    repo.push = 'not-attempted';
    repo.pr = 'not-attempted';
    repo.error = undefined;
    repo.branch = undefined;
    repo.head = undefined;
    batch.updatedAt = this.now();
    this.store.save(batch);
    this.audit.record(actor, 'BATCH_REPO_RETRY', 'batch', id, { repo: repoName });
    const wasStatus = batch.status;
    batch.status = 'running';
    // Retry resumes the same logical run: if the branch already exists
    // (created by the earlier attempt of THIS batch), reuse it instead
    // of applying the fresh-run branchExists policy.
    await this.runOneRepo(batch, repo, actor, true);
    batch.status = wasStatus === 'created' ? 'created' : 'done';
    batch.updatedAt = this.now();
    this.store.save(batch);
    return structuredClone(batch);
  }

  private async runOneRepo(batch: BatchRecord, repo: BatchRepoRun, actor: string, isRetry = false): Promise<boolean> {
    repo.status = 'running';
    this.audit.record(actor, 'BATCH_REPO_STARTED', 'batch', batch.id, { repo: repo.name, path: repo.path });
    try {
      // 1. Verify still a git repo (fail-closed — the registry check was at create time).
      this.git(['rev-parse', '--git-dir'], repo.path);
    } catch (e) {
      return this.failRepo(batch, repo, actor, 'BATCH_REPO_FAILED', (e as Error).message);
    }

    // 2. Branch.
    const branch = batch.spec.branch;
    let branchExists = false;
    try {
      this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo.path);
      branchExists = true;
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      const policy = isRetry ? 'reuse' : batch.spec.branchExists;
      if (policy === 'fail') {
        return this.failRepo(batch, repo, actor, 'BATCH_REPO_FAILED', `branch "${branch}" already exists (branchExists: fail)`);
      }
      if (policy === 'skip') {
        repo.status = 'skipped';
        repo.error = `branch "${branch}" already exists (branchExists: skip)`;
        this.audit.record(actor, 'BATCH_REPO_SKIPPED', 'batch', batch.id, { repo: repo.name, reason: 'branch-exists' });
        return true; // skip is not a failure for onFailure purposes
      }
      // 'reuse': checkout the existing branch.
      try {
        this.git(['checkout', branch], repo.path);
      } catch (e) {
        return this.failRepo(batch, repo, actor, 'BATCH_REPO_FAILED', `checkout of existing branch failed: ${(e as Error).message}`);
      }
    } else {
      try {
        this.git(['checkout', '-b', branch], repo.path);
      } catch (e) {
        return this.failRepo(batch, repo, actor, 'BATCH_REPO_FAILED', `branch creation failed: ${(e as Error).message}`);
      }
    }
    repo.branch = branch;

    // 3. Steps.
    for (const step of batch.spec.steps) {
      const t0 = Date.now();
      if ('run' in step) {
        const r = await runShellCommand(step.run, repo.path, step.timeoutMs ?? 120_000);
        repo.stepResults.push({
          name: step.name,
          kind: 'run',
          ok: r.ok,
          exitCode: r.exitCode,
          ms: Date.now() - t0,
          ...(r.output ? { output: r.output } : {}),
          ...(!r.ok ? { error: `exit ${r.exitCode}` } : {}),
        });
        this.audit.record(actor, r.ok ? 'BATCH_STEP_DONE' : 'BATCH_STEP_FAILED', 'batch', batch.id, {
          repo: repo.name,
          step: step.name,
          exitCode: r.exitCode,
          ms: Date.now() - t0,
        });
        if (!r.ok) return this.failRepo(batch, repo, actor, 'BATCH_REPO_FAILED', `step "${step.name}" failed (exit ${r.exitCode})`);
      } else {
        const res = applyEditStep(repo.path, step.edit);
        repo.stepResults.push({
          name: step.name,
          kind: 'edit',
          ok: res.ok,
          ms: Date.now() - t0,
          ...(res.note ? { output: res.note } : {}),
          ...(!res.ok ? { error: res.note } : {}),
        });
        this.audit.record(actor, res.ok ? 'BATCH_STEP_DONE' : 'BATCH_STEP_FAILED', 'batch', batch.id, {
          repo: repo.name,
          step: step.name,
          matches: res.matches,
        });
        if (!res.ok) return this.failRepo(batch, repo, actor, 'BATCH_REPO_FAILED', `step "${step.name}" failed: ${res.note}`);
      }
    }

    // 4. Record head.
    try {
      repo.head = this.git(['rev-parse', 'HEAD'], repo.path);
    } catch {
      repo.head = undefined;
    }

    // 5. Push / PR attempts (default: skip).
    if (batch.spec.push === 'try') {
      await this.attemptPush(batch, repo, actor);
    } else {
      this.audit.record(actor, 'BATCH_PUSH_SKIPPED', 'batch', batch.id, {
        repo: repo.name,
        reason: 'push-disabled',
      });
    }

    repo.status = 'success';
    this.audit.record(actor, 'BATCH_REPO_DONE', 'batch', batch.id, {
      repo: repo.name,
      branch,
      head: repo.head,
      push: repo.push,
      pr: repo.pr,
    });
    return true;
  }

  private async attemptPush(batch: BatchRecord, repo: BatchRepoRun, actor: string): Promise<void> {
    // Discover remote.
    let remoteUrl = '';
    try {
      remoteUrl = this.git(['remote', 'get-url', 'origin'], repo.path);
    } catch {
      remoteUrl = '';
    }
    if (!remoteUrl) {
      repo.push = 'skipped-no-remote';
      this.audit.record(actor, 'BATCH_PUSH_SKIPPED', 'batch', batch.id, { repo: repo.name, reason: 'no-remote' });
      return;
    }
    // Reachability probe (never hang on a dead remote).
    try {
      this.git(['ls-remote', '--heads', 'origin', 'HEAD'], repo.path, 15_000);
    } catch {
      repo.push = 'skipped-unreachable';
      this.audit.record(actor, 'BATCH_PUSH_SKIPPED', 'batch', batch.id, {
        repo: repo.name,
        reason: 'remote-unreachable',
        remote: redactRemote(remoteUrl),
      });
      return;
    }
    try {
      this.git(['push', '-u', 'origin', repo.branch ?? batch.spec.branch], repo.path, 60_000);
      repo.push = 'pushed';
      this.audit.record(actor, 'BATCH_PUSHED', 'batch', batch.id, { repo: repo.name, branch: repo.branch });
    } catch (e) {
      repo.push = 'failed';
      this.audit.record(actor, 'BATCH_PUSH_FAILED', 'batch', batch.id, {
        repo: repo.name,
        error: (e as Error).message,
      });
      return;
    }
    // PR attempt only when asked, remote reachable, gh present, github remote.
    if (batch.spec.pr) {
      if (!/github\.com/i.test(remoteUrl)) {
        repo.pr = 'skipped';
        this.audit.record(actor, 'BATCH_PR_SKIPPED', 'batch', batch.id, { repo: repo.name, reason: 'not-github-remote' });
      } else if (!hasGhOnPath()) {
        repo.pr = 'skipped-no-gh';
        this.audit.record(actor, 'BATCH_PR_SKIPPED', 'batch', batch.id, { repo: repo.name, reason: 'gh-not-installed' });
      } else {
        try {
          execFileSync(
            'gh',
            ['pr', 'create', '--title', `[batch] ${batch.name}`, '--head', repo.branch ?? batch.spec.branch, '--body', `Automated batch change "${batch.name}" by AI Factory.`],
            { cwd: repo.path, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          repo.pr = 'created';
          this.audit.record(actor, 'BATCH_PR_CREATED', 'batch', batch.id, { repo: repo.name });
        } catch (e) {
          repo.pr = 'failed';
          this.audit.record(actor, 'BATCH_PR_FAILED', 'batch', batch.id, {
            repo: repo.name,
            error: (e as Error).message,
          });
        }
      }
    }
  }

  private failRepo(
    batch: BatchRecord,
    repo: BatchRepoRun,
    actor: string,
    event: string,
    message: string,
  ): boolean {
    repo.status = 'failed';
    repo.error = message;
    this.audit.record(actor, event, 'batch', batch.id, { repo: repo.name, error: message });
    return false;
  }
}

/** Never put full remote URLs (may embed tokens) into audit details. */
function redactRemote(url: string): string {
  return url.replace(/:\/\/[^@/]*@/, '://***@').slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* edit: step — deterministic literal string replacement               */
/* ------------------------------------------------------------------ */

export interface EditStepResult {
  ok: boolean;
  matches: number;
  note?: string;
}

/**
 * Deterministic literal string replacement. NO semantic understanding:
 * the same file name with different content across repos may match
 * differently — that is the operator's responsibility to review
 * (the dashboard surfaces match counts per repo). Path is jailed to
 * the repo directory; symlinks are not followed (fail-closed).
 */
export function applyEditStep(repoPath: string, rule: EditRule): EditStepResult {
  const abs = resolve(repoPath, rule.file);
  const root = resolve(repoPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, matches: 0, note: `PATH_ESCAPE: ${rule.file} is outside the repo` };
  }
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    const mustMatch = rule.mustMatch !== false;
    return { ok: !mustMatch, matches: 0, note: mustMatch ? `file not found: ${rule.file}` : `file not found (mustMatch:false): ${rule.file}` };
  }
  if (content.length > 5_000_000) {
    return { ok: false, matches: 0, note: `file too large for edit step: ${rule.file}` };
  }
  const want = rule.occurrences ?? 1;
  // Count literal occurrences.
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(rule.search, idx)) !== -1) {
    count++;
    idx += rule.search.length;
  }
  const mustMatch = rule.mustMatch !== false;
  if (count === 0) {
    return { ok: !mustMatch, matches: 0, note: mustMatch ? `no match for search string in ${rule.file}` : `no match (mustMatch:false), left unchanged: ${rule.file}` };
  }
  let replaced = 0;
  let out = content;
  if (want === 'all') {
    out = content.split(rule.search).join(rule.replace);
    replaced = count;
  } else {
    let rest = content;
    const parts: string[] = [];
    for (let n = 0; n < want && rest.includes(rule.search); n++) {
      const at = rest.indexOf(rule.search);
      parts.push(rest.slice(0, at), rule.replace);
      rest = rest.slice(at + rule.search.length);
      replaced++;
    }
    parts.push(rest);
    out = parts.join('');
    if (mustMatch && replaced < want) {
      return { ok: false, matches: count, note: `only ${replaced} of ${want} occurrences matched in ${rule.file}` };
    }
  }
  if (replaced === 0) {
    return { ok: !mustMatch, matches: count, note: `no replacement made in ${rule.file}` };
  }
  writeFileSync(abs, out, 'utf8');
  return { ok: true, matches: count, note: `replaced ${replaced} occurrence(s) in ${rule.file}` };
}
