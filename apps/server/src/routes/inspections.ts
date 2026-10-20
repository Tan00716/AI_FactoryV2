/**
 * Inspection routes — operator surface for the team quality gate
 * (apps/server/src/inspections.ts).
 *
 *   GET  /api/inspections?projectId=&root=     profile + baseline + last run (viewer)
 *   PUT  /api/inspections/profile              {projectId, root?, profile} — save team profile (operator)
 *   POST /api/inspections/run                  {projectId, root?} — run now (operator)
 *   GET  /api/inspections/history?projectId=   run history for the trend board (viewer)
 *   POST /api/inspections/baseline             {projectId, root?} — re-baseline to current findings (operator)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET → viewer
 * and every other method → operator for this prefix — no auth.ts change
 * needed.
 *
 * Audit: INSPECTION_PROFILE_UPDATED / INSPECTION_RUN /
 * INSPECTION_BASELINE_UPDATED. The first-ever run for a root establishes
 * the baseline automatically and records INSPECTION_BASELINE_UPDATED.
 *
 * Honest boundary (mirrors inspections.ts): a passing gate means
 * "nothing new since the baseline", not "no problems".
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  baselineFilePath,
  findingSignature,
  historyEntryOf,
  InspectionConfigError,
  InspectionHistoryStore,
  InspectionRootError,
  loadBaseline,
  loadInspectionProfile,
  resolveInspectionRoot,
  runInspection,
  saveBaseline,
  saveInspectionProfile,
  type InspectionRunResult,
} from '../inspections';

const PREFIX = '/api/inspections';

let historyStore: InspectionHistoryStore | null = null;
export function inspectionHistoryStore(): InspectionHistoryStore {
  if (!historyStore) historyStore = new InspectionHistoryStore();
  return historyStore;
}
/** Test seam: swap the history store (hermetic tests point it at a temp file). */
export function setInspectionHistoryStore(s: InspectionHistoryStore | null): void {
  historyStore = s;
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

function rootOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const r = value.trim();
  return r ? r : undefined;
}

function summarizeRun(r: InspectionRunResult): Record<string, unknown> {
  return {
    runId: r.runId,
    projectId: r.projectId,
    root: r.root,
    profileName: r.profileName,
    profileSource: r.profileSource,
    profileNote: r.profileNote,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    filesScanned: r.filesScanned,
    totals: r.totals,
    newCount: r.newFindings.length,
    newFindings: r.newFindings,
    baselineEstablished: r.baselineEstablished,
    licenses: r.licenses
      ? {
          scanned: r.licenses.scanned,
          nodeModulesPresent: r.licenses.nodeModulesPresent,
          total: r.licenses.total,
          permissive: r.licenses.permissive,
          other: r.licenses.other,
          copyleft: r.licenses.copyleft,
          unknown: r.licenses.unknown,
          note: r.licenses.note,
        }
      : null,
  };
}

export async function handleInspectionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/inspections?projectId=&root= — profile + baseline status + last run.
  if (method === 'GET' && path === PREFIX) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId query parameter is required' });
      return true;
    }
    let root: string;
    try {
      root = resolveInspectionRoot(rootOf(url.searchParams.get('root')));
    } catch (e) {
      if (e instanceof InspectionRootError) {
        ctx.json(res, 403, { error: (e as Error).message, code: 'INSPECTION_ROOT_DENIED' });
        return true;
      }
      throw e;
    }
    try {
      const { profile, source, note } = loadInspectionProfile(root);
      const baseline = loadBaseline(root);
      const history = inspectionHistoryStore().list(projectId);
      ctx.json(res, 200, {
        projectId,
        root,
        profile,
        profileSource: source,
        profileNote: note,
        baseline: baseline
          ? { exists: true, establishedAt: baseline.establishedAt, signatures: baseline.signatures.length }
          : { exists: false },
        lastRun: history.length > 0 ? history[history.length - 1] : null,
      });
    } catch (e) {
      if (e instanceof InspectionConfigError) {
        ctx.json(res, 500, { error: (e as Error).message, code: 'INSPECTION_HISTORY_CORRUPT' });
        return true;
      }
      throw e;
    }
    return true;
  }

  // PUT /api/inspections/profile — replace the team profile in the root.
  if (method === 'PUT' && path === `${PREFIX}/profile`) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    let root: string;
    try {
      root = resolveInspectionRoot(rootOf(body['root']));
    } catch (e) {
      if (e instanceof InspectionRootError) {
        ctx.json(res, 403, { error: (e as Error).message, code: 'INSPECTION_ROOT_DENIED' });
        return true;
      }
      throw e;
    }
    if (body['profile'] === null || typeof body['profile'] !== 'object') {
      ctx.json(res, 400, { error: 'profile must be an object' });
      return true;
    }
    try {
      const profile = saveInspectionProfile(root, body['profile'] as Record<string, unknown>);
      ctx.audit.record('human', 'INSPECTION_PROFILE_UPDATED', 'inspections', projectId, { root, name: profile.name });
      ctx.json(res, 200, { projectId, root, profile });
    } catch (e) {
      if (e instanceof InspectionConfigError) {
        ctx.json(res, 400, { error: (e as Error).message, code: 'INSPECTION_PROFILE_INVALID' });
        return true;
      }
      throw e;
    }
    return true;
  }

  // POST /api/inspections/run — run the inspection now.
  if (method === 'POST' && path === `${PREFIX}/run`) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    let root: string;
    try {
      root = resolveInspectionRoot(rootOf(body['root']));
    } catch (e) {
      if (e instanceof InspectionRootError) {
        ctx.json(res, 403, { error: (e as Error).message, code: 'INSPECTION_ROOT_DENIED' });
        return true;
      }
      throw e;
    }
    const result = runInspection(root, projectId);
    try {
      inspectionHistoryStore().append(historyEntryOf(result));
    } catch (e) {
      if (e instanceof InspectionConfigError) {
        ctx.json(res, 500, { error: (e as Error).message, code: 'INSPECTION_HISTORY_CORRUPT' });
        return true;
      }
      throw e;
    }
    ctx.audit.record('human', 'INSPECTION_RUN', 'inspections', projectId, {
      root,
      runId: result.runId,
      total: result.totals.total,
      newCount: result.newFindings.length,
      filesScanned: result.filesScanned,
      durationMs: result.durationMs,
    });
    if (result.baselineEstablished) {
      ctx.audit.record('human', 'INSPECTION_BASELINE_UPDATED', 'inspections', projectId, {
        root,
        reason: 'first run established the baseline',
        signatures: result.findings.length,
      });
    }
    ctx.json(res, 200, summarizeRun(result));
    return true;
  }

  // POST /api/inspections/baseline — re-baseline to the current findings.
  if (method === 'POST' && path === `${PREFIX}/baseline`) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    let root: string;
    try {
      root = resolveInspectionRoot(rootOf(body['root']));
    } catch (e) {
      if (e instanceof InspectionRootError) {
        ctx.json(res, 403, { error: (e as Error).message, code: 'INSPECTION_ROOT_DENIED' });
        return true;
      }
      throw e;
    }
    const result = runInspection(root, projectId);
    const baseline = saveBaseline(root, result.findings.map(findingSignature));
    ctx.audit.record('human', 'INSPECTION_BASELINE_UPDATED', 'inspections', projectId, {
      root,
      reason: 'explicit re-baseline',
      signatures: baseline.signatures.length,
      at: baseline.establishedAt,
      baselineFile: baselineFilePath(root),
    });
    ctx.json(res, 200, {
      projectId,
      root,
      baseline: { exists: true, establishedAt: baseline.establishedAt, signatures: baseline.signatures.length },
    });
    return true;
  }

  // GET /api/inspections/history?projectId= — run history for the trend board.
  if (method === 'GET' && path === `${PREFIX}/history`) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId query parameter is required' });
      return true;
    }
    try {
      ctx.json(res, 200, { projectId, runs: inspectionHistoryStore().list(projectId) });
    } catch (e) {
      if (e instanceof InspectionConfigError) {
        ctx.json(res, 500, { error: (e as Error).message, code: 'INSPECTION_HISTORY_CORRUPT' });
        return true;
      }
      throw e;
    }
    return true;
  }

  return false;
}
