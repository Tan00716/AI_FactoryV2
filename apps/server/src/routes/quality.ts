/**
 * Quality gate routes — operator surface for the deterministic
 * lint/test gate (apps/server/src/quality-gate.ts).
 *
 *   GET  /api/quality?projectId=      config + last run (viewer)
 *   PUT  /api/quality                 {projectId, lintCmd, testCmd,
 *                                     timeoutMs, runOnEdit, blockOnFailure}
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
 * QUALITY_GATE_FAILED. A failing gate with blockOnFailure=true emits a
 * HIGH QUALITY_GATE_FAILED notification through the notification center
 * (packages/notifications) and the run response carries blocked: true.
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
  const blocked = !result.skipped && !result.ok && config.blockOnFailure;
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
    },
  );
  if (blocked) {
    try {
      ctx.notify.emit({
        type: 'QUALITY_GATE_FAILED',
        actor: 'system',
        entity: opts.runId
          ? { kind: 'run', id: opts.runId, label: `${kind} gate failed` }
          : { kind: 'project', id: projectId, label: `${kind} gate failed` },
        detail: {
          kind,
          projectId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          trigger: opts.trigger ?? 'manual',
        },
      });
    } catch (e) {
      // Notification delivery is best-effort: the audit record above is
      // the durable signal; a notification failure must not fail the run.
      console.error('[quality-gate] notification fan-out failed:', (e as Error).message);
    }
  }
  return { result: summarize(result), blocked };
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
