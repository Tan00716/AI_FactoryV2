/**
 * Quality gate routes — operator surface for the deterministic
 * lint/test gate (apps/server/src/quality-gate.ts).
 *
 *   GET  /api/quality?projectId=      config + last run (viewer)
 *   PUT  /api/quality                 {projectId, lintCmd, testCmd,
 *                                     timeoutMs, runOnEdit, blockOnFailure,
 *                                     coverage?: {report, failOnDropBelow},
 *                                     security?: {failOn: ['secret'|'sast'|'sca']}}
 *                                     (operator; invalid input → 400)
 *   POST /api/quality/run            {projectId, kind: 'lint'|'test',
 *                                     runId?} — run one gate step now
 *                                     (operator)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no
 * auth.ts change needed.
 *
 * Audit: QUALITY_GATE_CONFIG_UPDATED / QUALITY_GATE_RUN /
 * QUALITY_GATE_FAILED (+ QUALITY_GATE_COVERAGE_PARSED /
 * QUALITY_GATE_COVERAGE_FAILED / QUALITY_GATE_COVERAGE_BLOCKED from
 * the coverage linkage; QUALITY_GATE_COVERAGE_IMPORTED from
 * routes/coverage.ts; SECURITY_SCAN_RUN / SECURITY_SCAN_BLOCKED from
 * the security linkage).
 *
 * Coverage linkage: after a successful test run, a configured
 * coverage.report is parsed into the coverage store (coverage.ts).
 * Coverage below failOnDropBelow blocks only when blockOnFailure is
 * on. A broken/missing report is audited, never silently ignored,
 * and never fails the gate the tests already passed.
 * HIGH QUALITY_GATE_FAILED notification through the notification center
 * (packages/notifications) and the run response carries blocked: true.
 *
 * Security linkage (wave2-④): when security.failOn is non-empty, the
 * gate also runs the deterministic security scanners (secret-scan +
 * sast-patterns over the inspection root, plus the lockfile dependency
 * audit) after the gate step. Error-severity findings in any failOn
 * category block the run with SECURITY_SCAN_BLOCKED — independent of
 * blockOnFailure, because failOn itself is the operator's blocking
 * switch. The scan writes nothing (no baseline, no history); a scan
 * that cannot run (root jail refusal) is audited but never blocks —
 * blocking on an absent scan would misreport findings that were never
 * looked for.
 *
 * Honest boundary — "needs-fix" semantics: the gate never mutates run
 * state. There is no "needs-fix" run state in the run state machine, and
 * inventing one here would be fake. The signal is the HIGH notification
 * (entity kind 'run' when a runId is supplied, else 'project') plus the
 * blocked flag and the audit trail. Fixing is model/human work — the
 * gate only runs, judges, and reports.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  QUALITY_GATE_KINDS,
  QualityGateConfigError,
  QualityGateStore,
  runQualityGate,
  validateQualityGateConfig,
  type QualityGateKind,
  type QualityGateRunResult,
} from '../quality-gate';
import { CoverageError } from '../coverage';
import { importCoverageReport } from './coverage';
import { resolveInspectionRoot, runSecurityScan } from '../inspections';

const PREFIX = '/api/quality';

/** Re-exported for the /lint /test /run slash commands (routes/commands.ts). */
export type { QualityGateKind };

/** One store per process, like the other JSON-backed config stores. */
let store: QualityGateStore | null = null;
export function qualityGateStore(): QualityGateStore {
  if (!store) store = new QualityGateStore();
  return store;
}
/** Test seam: swap the store (hermetic tests point it at a temp file). */
export function setQualityGateStore(s: QualityGateStore | null): void {
  store = s;
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

function kindOf(value: unknown): QualityGateKind | null {
  return value === 'lint' || value === 'test' ? value : null;
}

function corruptBody(): { error: string; code: string } {
  return {
    error: 'quality gate store is corrupt; fix or remove the file, then retry',
    code: 'QUALITY_GATE_STORE_CORRUPT',
  };
}

/**
 * Problem-matcher sink (task ③): installed once by index.ts, receives
 * every gate run's raw stdout+stderr so the problem matchers can turn
 * lint/test output into structured diagnostics. Fire-and-forget
 * observer — never affects the gate run itself. Setter injection (not
 * a direct import) because route modules must not value-import siblings
 * (dual-mode import rule).
 */
let qualityGateOutputSink:
  | ((projectId: string, kind: QualityGateKind, stdout: string, stderr: string) => void)
  | null = null;

export function setQualityGateOutputSink(
  fn: ((projectId: string, kind: QualityGateKind, stdout: string, stderr: string) => void) | null,
): void {
  qualityGateOutputSink = fn;
}

function summarize(result: QualityGateRunResult): Record<string, unknown> {
  return {
    kind: result.kind,
    projectId: result.projectId,
    skipped: result.skipped,
    skipReason: result.skipReason,
    ok: result.ok,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    truncated: result.truncated,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    // Output tails only — the full capture is in the audit detail and
    // would bloat the API response. Truncation is always disclosed.
    stdoutTail: result.stdout.slice(-2000),
    stderrTail: result.stderr.slice(-2000),
  };
}

/**
 * Shared run path: runs the gate, audits the outcome, and — on failure
 * with blockOnFailure — raises the HIGH notification. Returns the API
 * payload. Never throws for gate failures (they are results, not
 * errors); throws only for corrupt store / bad input, which the caller
 * turns into 500/400.
 */
/**
 * Coverage linkage after a successful test run: when the project has
 * `coverage.report` configured, parse the report the test command just
 * produced into the coverage store and audit it. A below-threshold
 * result blocks only when the gate's blockOnFailure is on (it rides
 * the existing blocked mechanism). Parse failures are audited
 * (QUALITY_GATE_COVERAGE_FAILED) but NEVER fail the gate itself: the
 * tests passed; a broken/missing report is a reporting problem, not a
 * test failure — and it is never silently ignored either.
 */
function runCoverageLinkage(
  ctx: RouteContext,
  projectId: string,
  actor: string,
  opts: { runId?: string },
): { coverage: Record<string, unknown> | null; blocked: boolean } {
  const config = qualityGateStore().get(projectId);
  const cov = config.coverage;
  if (!cov || !cov.report) return { coverage: null, blocked: false };
  let imported: ReturnType<typeof importCoverageReport>;
  try {
    imported = importCoverageReport(projectId, cov.report, { trigger: 'gate' });
  } catch (e) {
    if (e instanceof CoverageError) {
      ctx.audit.record(actor, 'QUALITY_GATE_COVERAGE_FAILED', 'coverage', projectId, {
        runId: opts.runId ?? null,
        report: cov.report,
        reason: e.message,
      });
      return { coverage: { error: e.message, report: cov.report }, blocked: false };
    }
    throw e;
  }
  ctx.audit.record(actor, 'QUALITY_GATE_COVERAGE_PARSED', 'coverage', projectId, {
    runId: opts.runId ?? null,
    format: imported.format,
    coverage: imported.summary.coverage,
    totalLines: imported.summary.totalLines,
    coveredLines: imported.summary.coveredLines,
    files: imported.summary.files,
    report: cov.report,
  });
  const threshold = cov.failOnDropBelow;
  const blocked =
    threshold > 0 && config.blockOnFailure && imported.summary.coverage < threshold;
  if (blocked) {
    ctx.audit.record(actor, 'QUALITY_GATE_COVERAGE_BLOCKED', 'coverage', projectId, {
      runId: opts.runId ?? null,
      coverage: imported.summary.coverage,
      failOnDropBelow: threshold,
      format: imported.format,
    });
  }
  return {
    coverage: {
      format: imported.format,
      coverage: imported.summary.coverage,
      totalLines: imported.summary.totalLines,
      coveredLines: imported.summary.coveredLines,
      files: imported.summary.files,
      failOnDropBelow: threshold,
      blocked,
      at: imported.at,
    },
    blocked,
  };
}

/**
 * Security linkage (wave2-④): when the project opted in via
 * security.failOn, run the deterministic scanners over the inspection
 * root (jailed by FACTORY_INSPECT_ROOTS, default cwd) and count
 * error-severity findings per category:
 *   secret → secret-scan findings (always severity 'error')
 *   sast   → sast-patterns findings with severity 'error'
 *   sca    → dependency audit entries with severity 'error'
 * Any failOn category with count > 0 blocks (SECURITY_SCAN_BLOCKED),
 * with its own HIGH notification — independent of blockOnFailure.
 * A scan that cannot run (jail refusal, unreadable root) is audited
 * and disclosed in the response but NEVER blocks: blocking on findings
 * that were never looked for would be a false report.
 */
function runSecurityLinkage(
  ctx: RouteContext,
  projectId: string,
  actor: string,
  opts: { runId?: string; trigger?: string },
): { security: Record<string, unknown> | null; blocked: boolean } {
  const config = qualityGateStore().get(projectId);
  const failOn = config.security?.failOn ?? [];
  if (failOn.length === 0) return { security: null, blocked: false };
  let root: string;
  let scan: ReturnType<typeof runSecurityScan>;
  try {
    root = resolveInspectionRoot();
    scan = runSecurityScan(root);
  } catch (e) {
    ctx.audit.record(actor, 'SECURITY_SCAN_RUN', 'security-scan', projectId, {
      runId: opts.runId ?? null,
      trigger: opts.trigger ?? 'manual',
      error: (e as Error).message,
      blocked: false,
    });
    return {
      security: {
        failOn: [...failOn],
        secret: 0,
        sast: 0,
        sca: 0,
        blocked: false,
        note: `security scan could not run: ${(e as Error).message}`,
      },
      blocked: false,
    };
  }
  const secret = scan.findings.filter((f) => f.checker === 'secret-scan' && f.severity === 'error').length;
  const sast = scan.findings.filter((f) => f.checker === 'sast-patterns' && f.severity === 'error').length;
  const sca = scan.dependencies.vulnerable.filter((v) => v.severity === 'error').length;
  const blocked =
    (failOn.includes('secret') && secret > 0) ||
    (failOn.includes('sast') && sast > 0) ||
    (failOn.includes('sca') && sca > 0);
  ctx.audit.record(actor, 'SECURITY_SCAN_RUN', 'security-scan', projectId, {
    runId: opts.runId ?? null,
    trigger: opts.trigger ?? 'manual',
    root,
    filesScanned: scan.filesScanned,
    secret,
    sast,
    sca,
    vulnerable: scan.dependencies.vulnerable.length,
    rulesSource: scan.rulesSource,
    failOn: [...failOn],
    blocked,
  });
  if (blocked) {
    ctx.audit.record(actor, 'SECURITY_SCAN_BLOCKED', 'security-scan', projectId, {
      runId: opts.runId ?? null,
      trigger: opts.trigger ?? 'manual',
      secret,
      sast,
      sca,
      failOn: [...failOn],
    });
    try {
      ctx.notify.emit({
        type: 'SECURITY_SCAN_BLOCKED',
        actor: 'system',
        entity: opts.runId
          ? { kind: 'run', id: opts.runId, label: 'security scan blocked' }
          : { kind: 'project', id: projectId, label: 'security scan blocked' },
        detail: { projectId, secret, sast, sca, failOn: [...failOn] },
      });
    } catch (e) {
      // Notification delivery is best-effort; the audit record is durable.
      console.error('[quality-gate] security notification fan-out failed:', (e as Error).message);
    }
  }
  return {
    security: {
      failOn: [...failOn],
      root,
      filesScanned: scan.filesScanned,
      secret,
      sast,
      sca,
      vulnerable: scan.dependencies.vulnerable.length,
      rulesSource: scan.rulesSource,
      blocked,
      note: 'error-severity findings only; pattern-based scanners are advisory, not proof',
    },
    blocked,
  };
}

export async function executeQualityGate(
  ctx: RouteContext,
  projectId: string,
  kind: QualityGateKind,
  opts: { actor?: string; runId?: string; trigger?: string } = {},
): Promise<{ result: Record<string, unknown>; blocked: boolean }> {
  const st = qualityGateStore();
  const config = st.get(projectId);
  const actor = opts.actor ?? 'human';
  let result: QualityGateRunResult;
  try {
    result = await runQualityGate(st, projectId, kind);
  } catch (e) {
    ctx.audit.record(actor, 'QUALITY_GATE_RUN', 'quality-gate', `${projectId}:${kind}`, {
      trigger: opts.trigger ?? 'manual',
      error: (e as Error).message,
    });
    throw e;
  }
  let exitBlocked = !result.skipped && !result.ok && config.blockOnFailure;
  // Coverage linkage runs only after a *successful* test step; the
  // threshold block rides the same `blocked` flag as an exit failure.
  let coverage: Record<string, unknown> | null = null;
  let coverageBlocked = false;
  if (kind === 'test' && result.ok) {
    const link = runCoverageLinkage(ctx, projectId, actor, { runId: opts.runId });
    coverage = link.coverage;
    coverageBlocked = link.blocked;
  }
  // Security linkage (wave2-④): runs alongside the gate step whenever
  // the operator opted in via security.failOn — regardless of kind and
  // regardless of the lint/test outcome. failOn itself is the blocking
  // switch; blockOnFailure only governs lint/test failures.
  let security: Record<string, unknown> | null = null;
  let securityBlocked = false;
  const failOn = config.security?.failOn ?? [];
  if (failOn.length > 0) {
    const link = runSecurityLinkage(ctx, projectId, actor, { runId: opts.runId, trigger: opts.trigger });
    security = link.security;
    securityBlocked = link.blocked;
  }
  const blocked = exitBlocked || coverageBlocked || securityBlocked;
  // Problem matchers (task ③): turn gate output into structured
  // diagnostics automatically. Observer — must never affect the gate.
  if (qualityGateOutputSink && !result.skipped) {
    try {
      qualityGateOutputSink(projectId, kind, result.stdout, result.stderr);
    } catch (e) {
      console.error('[quality-gate] problem-matcher sink failed:', (e as Error).message);
    }
  }
  ctx.audit.record(
    actor,
    result.ok || result.skipped ? 'QUALITY_GATE_RUN' : 'QUALITY_GATE_FAILED',
    'quality-gate',
    `${projectId}:${kind}`,
    {
      trigger: opts.trigger ?? 'manual',
      runId: opts.runId ?? null,
      ok: result.ok,
      skipped: result.skipped,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      truncated: result.truncated,
      blocked,
      coverageBlocked,
      securityBlocked,
    },
  );
  if (blocked) {
    const label = securityBlocked && !exitBlocked && !coverageBlocked
      ? 'security scan blocked'
      : coverageBlocked && !exitBlocked
        ? 'coverage below threshold'
        : `${kind} gate failed`;
    try {
      ctx.notify.emit({
        type: 'QUALITY_GATE_FAILED',
        actor: 'system',
        entity: opts.runId
          ? { kind: 'run', id: opts.runId, label }
          : { kind: 'project', id: projectId, label },
        detail: {
          kind,
          projectId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          trigger: opts.trigger ?? 'manual',
          coverageBlocked,
          securityBlocked,
          coverage: coverage && typeof coverage['coverage'] === 'number' ? coverage['coverage'] : null,
        },
      });
    } catch (e) {
      // Notification delivery is best-effort: the audit record above is
      // the durable signal; a notification failure must not fail the run.
      console.error('[quality-gate] notification fan-out failed:', (e as Error).message);
    }
  }
  const payload = { ...summarize(result), ...(coverage ? { coverage } : {}), ...(security ? { security } : {}) };
  return { result: payload, blocked };
}

/**
 * runOnEdit trigger — wired into the exec PostToolUse observation point
 * (routes/exec.ts). Fire-and-forget by design: the gate must never slow
 * down or break the tool call it observes. Swallows everything; the
 * audit trail (and the HIGH notification on blocked failure) is the
 * durable record.
 */
export function maybeFireEditGate(ctx: RouteContext, projectId: string | null): void {
  if (!projectId) return;
  let config;
  try {
    config = qualityGateStore().get(projectId);
  } catch {
    return;
  }
  if (!config.runOnEdit || !config.lintCmd) return;
  void executeQualityGate(ctx, projectId, 'lint', { actor: 'system', trigger: 'on-edit' }).catch(
    (e) => {
      console.error('[quality-gate] on-edit run failed:', (e as Error).message);
    },
  );
}

export async function handleQualityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/quality?projectId= — config + last run.
  if (method === 'GET' && path === PREFIX) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId query parameter is required' });
      return true;
    }
    try {
      const st = qualityGateStore();
      ctx.json(res, 200, { config: st.get(projectId), lastRun: st.getLastRun(projectId) });
    } catch (e) {
      if (e instanceof QualityGateConfigError) {
        ctx.json(res, 500, corruptBody());
        return true;
      }
      throw e;
    }
    return true;
  }

  // PUT /api/quality — replace the project config.
  if (method === 'PUT' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const { config, errors } = validateQualityGateConfig(body);
    if (errors.length > 0) {
      ctx.json(res, 400, { error: `invalid quality gate config: ${errors.join('; ')}` });
      return true;
    }
    try {
      qualityGateStore().set(projectId, body);
      ctx.audit.record('human', 'QUALITY_GATE_CONFIG_UPDATED', 'quality-gate', projectId, {
        lintConfigured: config.lintCmd !== '',
        testConfigured: config.testCmd !== '',
        coverageReportConfigured: config.coverage !== null && config.coverage.report !== '',
        coverageFailOnDropBelow: config.coverage?.failOnDropBelow ?? 0,
        securityFailOn: [...config.security.failOn],
        timeoutMs: config.timeoutMs,
        runOnEdit: config.runOnEdit,
        blockOnFailure: config.blockOnFailure,
      });
      const st = qualityGateStore();
      ctx.json(res, 200, { config: st.get(projectId) });
    } catch (e) {
      if (e instanceof QualityGateConfigError) {
        // Distinguish validation (400, already handled) from store
        // corruption (500).
        ctx.json(res, 500, corruptBody());
        return true;
      }
      throw e;
    }
    return true;
  }

  // POST /api/quality/run — run one gate step now.
  if (method === 'POST' && path === `${PREFIX}/run`) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const kind = kindOf(body['kind']);
    if (!kind) {
      ctx.json(res, 400, { error: `kind must be one of ${QUALITY_GATE_KINDS.join('|')}` });
      return true;
    }
    const runId = typeof body['runId'] === 'string' && body['runId'].trim()
      ? body['runId'].trim().slice(0, 128)
      : undefined;
    const actor = typeof body['actor'] === 'string' && body['actor'].trim()
      ? body['actor'].trim().slice(0, 64)
      : 'human';
    try {
      const { result, blocked } = await executeQualityGate(ctx, projectId, kind, {
        actor,
        runId,
        trigger: 'manual',
      });
      ctx.json(res, 200, { ...result, blocked });
    } catch (e) {
      if (e instanceof QualityGateConfigError) {
        ctx.json(res, 500, corruptBody());
        return true;
      }
      throw e;
    }
    return true;
  }

  return false;
}
