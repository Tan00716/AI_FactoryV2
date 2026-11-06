/**
 * Quality gate (deterministic lint/test runner).
 *
 * What it is: an Aider-style `--auto-lint` / `--auto-test` equivalent for
 * AI Factory — after code changes, run the project's configured linter and
 * test commands, judge the exit code, and report. Pure subprocess +
 * exit-code logic; zero model involvement.
 *
 * What it is NOT (honest boundary):
 *   - It does NOT fix anything. A failing gate reports; the fix is the
 *     model's (or the human's) job. "Run + judge + report" is the whole
 *     scope.
 *   - Commands are operator-authored and run via `sh -c` with the same
 *     trust posture as lifecycle hooks (hooks.ts): the command string is
 *     trusted, but the child never inherits the server's own credential
 *     env vars — FACTORY_API_TOKEN / FACTORY_API_TOKENS /
 *     FACTORY_SECRET_* are scrubbed from the ambient env before spawn
 *     (V3.0 audit round 14, item #6 sub-item (e) — same fail-closed
 *     scrub as the pty/tasks/projects paths), and captured output is
 *     passed through redactText before it is returned. Do not point a
 *     gate at a command you would not run yourself.
 *   - Commands run with cwd = the server process's working directory and
 *     inherit its environment. There is deliberately no per-project
 *     workspace-root resolution — the server has no such concept.
 *
 * Configuration (per project):
 *   AI_FACTORY_DATA_DIR/quality-gates.json (atomic temp+rename writes).
 *   A corrupt store file is fail-closed: every accessor throws and the
 *   routes answer 500 until the operator repairs or deletes the file —
 *   never silently running with half a config.
 *
 * Team contract: the PUT /api/quality payload IS the committable document
 * format. Export it (GET /api/quality), commit it as
 * `.ai-factory/quality.json` in the repo, and re-apply with PUT — the
 * store is the runtime source of truth; the committed file is the
 * versioned contract.
 *
 * This module is pure node builtins (+ type-only imports): tests may
 * import it straight from src under node's type-stripping ESM loader.
 *
 * Coverage linkage (task ①, second strengthening round): the config
 * carries an optional `coverage` field ({ report, failOnDropBelow }).
 * Only the shape lives here; parsing/storage live in coverage.ts and
 * the run-time linkage in routes/quality.ts (they are dist-only
 * modules, so this src-importable module stays import-free).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactText } from '@ai-factory/diagpack';
import { redactAmbientCredentialValues, scrubCredentialEnv, stripControlPlanePointerEnv } from '@ai-factory/runtime';

export type QualityGateKind = 'lint' | 'test';

export const QUALITY_GATE_KINDS: QualityGateKind[] = ['lint', 'test'];

/** Coverage linkage (Coverage Gutters-style; see coverage.ts). */
export interface QualityGateCoverageConfig {
  /** Report file path (lcov/cobertura/v8); '' = coverage linkage disabled. */
  report: string;
  /** 0..1 — after a successful test run, line coverage below this blocks
   * the run (rides the existing blockOnFailure flag). 0 = never blocks. */
  failOnDropBelow: number;
}

/** Security-scan categories that can block a gate run (wave2-④). */
export type SecurityFailOnCategory = 'secret' | 'sast' | 'sca';

export const SECURITY_FAIL_ON_CATEGORIES: SecurityFailOnCategory[] = ['secret', 'sast', 'sca'];

/** Security scan linkage (deterministic scanners in inspections.ts). */
export interface QualityGateSecurityConfig {
  /** Categories whose error-severity findings block the run.
   * Empty array = security scan not run by the gate. */
  failOn: SecurityFailOnCategory[];
}

/** Change-impact linkage (deterministic; see impact.ts). */
export interface QualityGateImpactConfig {
  /** When true, the gate analyzes working-tree changes vs HEAD after
   * each run and blocks on breaking API-contract changes
   * (removed/renamed/signature-changed exports). False = advisory only
   * via the /api/impact API; the gate never runs the analysis. */
  failOnBreaking: boolean;
}

/** Flaky-test linkage (deterministic; see flaky.ts). */
export interface QualityGateFlakyConfig {
  /** When true, a failed test step is parsed for TAP outcomes and, when
   * parseable, the command is run once more with known-flaky failures
   * quarantined in the report. Annotation only — the original verdict
   * always stands; a flaky test is never auto-passed. False (default)
   * = the gate never runs the extra pass. Same inline-validation +
   * import-free rationale as coverage above. */
  rerunFlakyOnce: boolean;
}

/** Mutation-testing linkage (deterministic; see routes/mutation.ts). */
export interface QualityGateMutationConfig {
  /** When true, the gate attaches the latest stored mutation-testing
   * report summary (if any) as an annotation on test-kind runs.
   * The gate never runs mutation testing itself and the annotation can
   * never block or flip the verdict. False (default) = no annotation.
   * Same inline-validation + import-free rationale as coverage above. */
  report: boolean;
}

/** Per-project gate configuration. */
export interface QualityGateConfig {
  /** Shell command for the lint step; '' = disabled. */
  lintCmd: string;
  /** Shell command for the test step; '' = disabled. */
  testCmd: string;
  /** Per-command wall-clock budget. */
  timeoutMs: number;
  /** When true, a lint run fires (best-effort) after code-writing exec calls. */
  runOnEdit: boolean;
  /** When true, a failing gate emits a HIGH notification + marks the API response blocked. */
  blockOnFailure: boolean;
  /** Test coverage report linkage; null = no coverage parsing after runs.
   * Validated inline here (not via coverage.ts) so this module stays
   * free of value imports — tests import it from src under node's
   * type-stripping loader (AGENTS.md dual-mode import rule). */
  coverage: QualityGateCoverageConfig | null;
  /** Security scan linkage; failOn empty = no security gate. Same
   * inline-validation + import-free rationale as coverage above. */
  security: QualityGateSecurityConfig;
  /** Change-impact linkage; failOnBreaking=false (default) = the gate
   * never runs impact analysis. Same inline-validation + import-free
   * rationale as coverage above. */
  impact: QualityGateImpactConfig;
  /** Flaky-test linkage; rerunFlakyOnce=false (default) = the gate never
   * runs the extra pass. Same inline-validation + import-free rationale
   * as coverage above. */
  flaky: QualityGateFlakyConfig;
  /** Mutation-testing linkage; report=false (default) = no annotation.
   * Same inline-validation + import-free rationale as coverage above. */
  mutation: QualityGateMutationConfig;
}

export interface QualityGateConfigInput {
  lintCmd?: unknown;
  testCmd?: unknown;
  timeoutMs?: unknown;
  runOnEdit?: unknown;
  blockOnFailure?: unknown;
  coverage?: unknown;
  security?: unknown;
  impact?: unknown;
  flaky?: unknown;
  mutation?: unknown;
}

export const DEFAULT_QUALITY_TIMEOUT_MS = 120_000;
export const MAX_QUALITY_TIMEOUT_MS = 600_000;
export const MAX_QUALITY_COMMAND_LEN = 8000;
/** Per-stream capture cap (stdout / stderr each). */
export const MAX_QUALITY_OUTPUT = 20 * 1024;

export class QualityGateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualityGateConfigError';
  }
}

export function qualityGateStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_QUALITY_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'quality-gates.json');
}

export function defaultQualityGateConfig(): QualityGateConfig {
  return {
    lintCmd: '',
    testCmd: '',
    timeoutMs: DEFAULT_QUALITY_TIMEOUT_MS,
    runOnEdit: false,
    blockOnFailure: false,
    coverage: null,
    security: { failOn: [] },
    impact: { failOnBreaking: false },
    flaky: { rerunFlakyOnce: false },
    mutation: { report: false },
  };
}

/** Structural validation for the coverage linkage (kept inline: no imports). */
function checkCoverageConfig(input: unknown, errors: string[]): QualityGateCoverageConfig | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push('coverage must be an object');
    return null;
  }
  const raw = input as { report?: unknown; failOnDropBelow?: unknown };
  let report = '';
  if (raw.report !== undefined && raw.report !== null) {
    if (typeof raw.report !== 'string') {
      errors.push('coverage.report must be a string');
    } else {
      report = raw.report.trim();
      if (report.length > 4096) errors.push('coverage.report too long (max 4096 chars)');
    }
  }
  let failOnDropBelow = 0;
  if (raw.failOnDropBelow !== undefined && raw.failOnDropBelow !== null) {
    if (
      typeof raw.failOnDropBelow !== 'number' ||
      !Number.isFinite(raw.failOnDropBelow) ||
      raw.failOnDropBelow < 0 ||
      raw.failOnDropBelow > 1
    ) {
      errors.push('coverage.failOnDropBelow must be a number between 0 and 1');
    } else {
      failOnDropBelow = raw.failOnDropBelow;
    }
  }
  return errors.length > 0 ? null : { report, failOnDropBelow };
}

/** Structural validation for the security linkage (kept inline: no imports). */
function checkSecurityConfig(input: unknown, errors: string[]): QualityGateSecurityConfig {
  if (input === undefined || input === null) return { failOn: [] };
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push('security must be an object');
    return { failOn: [] };
  }
  const raw = input as { failOn?: unknown };
  const fo = raw.failOn;
  if (fo === undefined || fo === null) return { failOn: [] };
  if (!Array.isArray(fo)) {
    errors.push('security.failOn must be an array');
    return { failOn: [] };
  }
  const out: SecurityFailOnCategory[] = [];
  for (const c of fo) {
    if (typeof c !== 'string' || !SECURITY_FAIL_ON_CATEGORIES.includes(c as SecurityFailOnCategory)) {
      errors.push(`security.failOn entries must be one of ${SECURITY_FAIL_ON_CATEGORIES.join('|')}`);
      return { failOn: [] };
    }
    if (!out.includes(c as SecurityFailOnCategory)) out.push(c as SecurityFailOnCategory);
  }
  return { failOn: out };
}

/** Structural validation for the impact linkage (kept inline: no imports). */
function checkImpactConfig(input: unknown, errors: string[]): QualityGateImpactConfig {
  if (input === undefined || input === null) return { failOnBreaking: false };
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push('impact must be an object');
    return { failOnBreaking: false };
  }
  const raw = input as { failOnBreaking?: unknown };
  const fo = raw.failOnBreaking;
  if (fo === undefined || fo === null) return { failOnBreaking: false };
  if (typeof fo !== 'boolean') {
    errors.push('impact.failOnBreaking must be a boolean');
    return { failOnBreaking: false };
  }
  return { failOnBreaking: fo };
}

/** Structural validation for the flaky linkage (kept inline: no imports). */
function checkFlakyConfig(input: unknown, errors: string[]): QualityGateFlakyConfig {
  if (input === undefined || input === null) return { rerunFlakyOnce: false };
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push('flaky must be an object');
    return { rerunFlakyOnce: false };
  }
  const raw = input as { rerunFlakyOnce?: unknown };
  const ro = raw.rerunFlakyOnce;
  if (ro === undefined || ro === null) return { rerunFlakyOnce: false };
  if (typeof ro !== 'boolean') {
    errors.push('flaky.rerunFlakyOnce must be a boolean');
    return { rerunFlakyOnce: false };
  }
  return { rerunFlakyOnce: ro };
}

/** Structural validation for the mutation linkage (kept inline: no imports). */
function checkMutationConfig(input: unknown, errors: string[]): QualityGateMutationConfig {
  if (input === undefined || input === null) return { report: false };
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push('mutation must be an object');
    return { report: false };
  }
  const raw = input as { report?: unknown };
  const ro = raw.report;
  if (ro === undefined || ro === null) return { report: false };
  if (typeof ro !== 'boolean') {
    errors.push('mutation.report must be a boolean');
    return { report: false };
  }
  return { report: ro };
}

function checkCommand(label: string, v: unknown, errors: string[]): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') {
    errors.push(`${label} must be a string`);
    return '';
  }
  const cmd = v.trim();
  if (cmd.length > MAX_QUALITY_COMMAND_LEN) {
    errors.push(`${label} too long (max ${MAX_QUALITY_COMMAND_LEN} chars)`);
    return '';
  }
  return cmd;
}

/**
 * Validate raw input into a QualityGateConfig. Returns the config plus a
 * list of human-readable errors (empty = valid). Empty commands are legal:
 * they mean "this step is disabled", not "misconfigured".
 */
export function validateQualityGateConfig(input: QualityGateConfigInput): {
  config: QualityGateConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const lintCmd = checkCommand('lintCmd', input.lintCmd, errors);
  const testCmd = checkCommand('testCmd', input.testCmd, errors);
  let timeoutMs = DEFAULT_QUALITY_TIMEOUT_MS;
  if (input.timeoutMs !== undefined) {
    if (
      typeof input.timeoutMs !== 'number' ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > MAX_QUALITY_TIMEOUT_MS
    ) {
      errors.push(`timeoutMs must be 1..${MAX_QUALITY_TIMEOUT_MS}`);
    } else {
      timeoutMs = Math.floor(input.timeoutMs);
    }
  }
  for (const [label, v] of [['runOnEdit', input.runOnEdit], ['blockOnFailure', input.blockOnFailure]] as const) {
    if (v !== undefined && typeof v !== 'boolean') errors.push(`${label} must be a boolean`);
  }
  const coverage = checkCoverageConfig(input.coverage, errors);
  const security = checkSecurityConfig(input.security, errors);
  const impact = checkImpactConfig(input.impact, errors);
  const flaky = checkFlakyConfig(input.flaky, errors);
  const mutation = checkMutationConfig(input.mutation, errors);
  return {
    config: {
      lintCmd,
      testCmd,
      timeoutMs,
      runOnEdit: input.runOnEdit === true,
      blockOnFailure: input.blockOnFailure === true,
      coverage,
      security,
      impact,
      flaky,
      mutation,
    },
    errors,
  };
}

export interface QualityGateLastRun {
  kind: QualityGateKind;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  truncated: boolean;
  durationMs: number;
  at: string;
}

interface ProjectQualityRecord {
  config: QualityGateConfig;
  lastRun: Record<QualityGateKind, QualityGateLastRun | null>;
}

interface QualityGateFile {
  version: 1;
  projects: Record<string, ProjectQualityRecord>;
}

function blankRecord(): ProjectQualityRecord {
  return { config: defaultQualityGateConfig(), lastRun: { lint: null, test: null } };
}

function isValidRecord(r: unknown): r is ProjectQualityRecord {
  if (!r || typeof r !== 'object') return false;
  const rec = r as { config?: unknown; lastRun?: unknown };
  if (!rec.config || typeof rec.config !== 'object') return false;
  const c = rec.config as Record<string, unknown>;
  if (
    typeof c.lintCmd !== 'string' ||
    typeof c.testCmd !== 'string' ||
    typeof c.timeoutMs !== 'number' ||
    typeof c.runOnEdit !== 'boolean' ||
    typeof c.blockOnFailure !== 'boolean'
  ) {
    return false;
  }
  const cov = c.coverage;
  if (cov !== null && cov !== undefined) {
    if (typeof cov !== 'object') return false;
    const o = cov as Record<string, unknown>;
    if (
      typeof o.report !== 'string' ||
      typeof o.failOnDropBelow !== 'number' ||
      o.failOnDropBelow < 0 ||
      o.failOnDropBelow > 1
    ) {
      return false;
    }
  }
  return true;
}

export class QualityGateStore {
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? qualityGateStorePath();
  }

  private load(): QualityGateFile {
    const p = this.path;
    if (!existsSync(p)) return { version: 1, projects: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new QualityGateConfigError(
        `quality gate store is corrupt (${p}): ${(e as Error).message}`,
      );
    }
    const projects: Record<string, ProjectQualityRecord> = {};
    const list = (raw as { projects?: Record<string, unknown> }).projects ?? {};
    for (const [projectId, rec] of Object.entries(list)) {
      if (isValidRecord(rec)) projects[projectId] = rec;
      // Invalid records are dropped, not served — fail-closed on shape.
    }
    return { version: 1, projects };
  }

  private save(file: QualityGateFile): void {
    mkdirSync(resolve(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  /** Config for a project; defaults (everything disabled) when unset. */
  get(projectId: string): QualityGateConfig {
    const config = this.load().projects[projectId]?.config;
    if (!config) return defaultQualityGateConfig();
    // Backward compatibility: stores written before the coverage/security
    // fields existed have no keys for them — normalize to disabled.
    if (config.coverage === undefined) config.coverage = null;
    if (config.security === undefined) config.security = { failOn: [] };
    if (config.impact === undefined || typeof config.impact.failOnBreaking !== 'boolean') {
      config.impact = { failOnBreaking: false };
    }
    if (config.flaky === undefined || typeof config.flaky.rerunFlakyOnce !== 'boolean') {
      config.flaky = { rerunFlakyOnce: false };
    }
    return config;
  }

  getLastRun(projectId: string): Record<QualityGateKind, QualityGateLastRun | null> {
    return this.load().projects[projectId]?.lastRun ?? { lint: null, test: null };
  }

  set(projectId: string, input: QualityGateConfigInput): QualityGateConfig {
    const { config, errors } = validateQualityGateConfig(input);
    if (errors.length > 0) {
      throw new QualityGateConfigError(`invalid quality gate config: ${errors.join('; ')}`);
    }
    const file = this.load();
    const rec = file.projects[projectId] ?? blankRecord();
    rec.config = config;
    file.projects[projectId] = rec;
    this.save(file);
    return config;
  }

  remove(projectId: string): boolean {
    const file = this.load();
    if (!file.projects[projectId]) return false;
    delete file.projects[projectId];
    this.save(file);
    return true;
  }

  /** Best-effort: a last-run write must never break the gate run itself. */
  recordLastRun(projectId: string, summary: QualityGateLastRun): void {
    try {
      const file = this.load();
      const rec = file.projects[projectId] ?? blankRecord();
      rec.lastRun[summary.kind] = summary;
      file.projects[projectId] = rec;
      this.save(file);
    } catch {
      /* persistence failure is logged by the caller, not thrown */
    }
  }
}

export interface QualityGateRunResult {
  kind: QualityGateKind;
  projectId: string;
  command: string;
  /** True when the step is not configured — nothing ran, nothing failed. */
  skipped: boolean;
  skipReason: string | null;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  startedAt: string;
}

/**
 * Run one shell command with a wall-clock timeout. The child is killed on
 * timeout (fail-closed: a hung linter is a failed gate, not a pass).
 *
 * Judgment is ALWAYS by exit code — never by output content. Output is
 * streamed and captured per-stream up to MAX_QUALITY_OUTPUT; anything
 * beyond is discarded with `truncated: true` disclosed. A chatty but
 * passing command still passes; a failing command still fails even when
 * its output was cut. (An execFile maxBuffer approach would lose the real
 * exit code on overflow — deliberately not used.)
 */
export function runQualityCommand(
  command: string,
  opts: { timeoutMs: number; cwd?: string },
): Promise<Omit<QualityGateRunResult, 'kind' | 'projectId' | 'command' | 'skipped' | 'skipReason'>> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  return new Promise((resolve) => {
    const finish = (partial: {
      ok: boolean;
      timedOut: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
      spawnError?: string;
    }) => {
      // V3R14 #6(e): redact secret-shaped values from captured output
      // before returning, so a credential can never be echoed back
      // verbatim in the gate result (runhistory precedent: redactText).
      // V3R17 #6(h): ambient credential VALUES are redacted too —
      // redactText's key-shape matching is blind to a bare value.
      resolve({
        ...partial,
        stdout: redactAmbientCredentialValues(redactText(partial.stdout)),
        stderr: partial.spawnError
          ? redactAmbientCredentialValues(redactText(`${partial.spawnError}${partial.stderr ? '\n' + partial.stderr : ''}`.slice(0, MAX_QUALITY_OUTPUT)))
          : redactAmbientCredentialValues(redactText(partial.stderr)),
        durationMs: Date.now() - start,
        startedAt,
      });
    };

    let child;
    try {
      // V3R14 #6(e): scrub the server's own credential env vars from the
      // ambient inheritance (same rule as pty.ts childEnv). V3R17
      // #6(k)(b): control-plane pointer vars are stripped as well, so
      // the gate command cannot locate the vault or the admin token file.
      child = spawn('sh', ['-c', command], { cwd: opts.cwd ?? process.cwd(), env: stripControlPlanePointerEnv(scrubCredentialEnv(process.env)) });
    } catch (e) {
      finish({
        ok: false,
        timedOut: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        spawnError: `failed to spawn: ${(e as Error).message}`,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > MAX_QUALITY_OUTPUT) truncated = true;
      if (stdout.length < MAX_QUALITY_OUTPUT) {
        stdout += d.toString('utf8').slice(0, MAX_QUALITY_OUTPUT - stdout.length);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      errBytes += d.length;
      if (errBytes > MAX_QUALITY_OUTPUT) truncated = true;
      if (stderr.length < MAX_QUALITY_OUTPUT) {
        stderr += d.toString('utf8').slice(0, MAX_QUALITY_OUTPUT - stderr.length);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
    // The timer must not hold the event loop open by itself.
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({
        ok: false,
        timedOut,
        exitCode: null,
        stdout,
        stderr,
        truncated,
        spawnError: `process error: ${(e as Error).message}`,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({
        ok: !timedOut && code === 0,
        timedOut,
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

/**
 * Run one gate step for a project. Resolves config from the store;
 * an unconfigured step returns { skipped: true } — skipping is not
 * failure, and must never be presented as a pass either.
 */
export async function runQualityGate(
  store: QualityGateStore,
  projectId: string,
  kind: QualityGateKind,
  opts: { cwd?: string } = {},
): Promise<QualityGateRunResult> {
  const config = store.get(projectId);
  const command = kind === 'lint' ? config.lintCmd : config.testCmd;
  if (!command) {
    return {
      kind,
      projectId,
      command: '',
      skipped: true,
      skipReason: `${kind} command is not configured for this project`,
      ok: false,
      timedOut: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
      startedAt: new Date().toISOString(),
    };
  }
  const run = await runQualityCommand(command, { timeoutMs: config.timeoutMs, cwd: opts.cwd });
  const result: QualityGateRunResult = {
    kind,
    projectId,
    command,
    skipped: false,
    skipReason: null,
    ...run,
  };
  store.recordLastRun(projectId, {
    kind,
    ok: result.ok,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    truncated: result.truncated,
    durationMs: result.durationMs,
    at: result.startedAt,
  });
  return result;
}
