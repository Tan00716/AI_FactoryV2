/**
 * Quota routes — SPEC_V2 §27 (lives in @ai-factory/quota) + V3.0 #8
 * cost-governance budgets (same package, no new package).
 *
 *  POST /api/quota/buckets                         record a provider bucket
 *  GET  /api/quota/buckets                         list buckets (usage display)
 *  POST /api/quota/limit-signal                    {signal, bucket, retryAfterSec?}
 *  POST /api/quota/decide                          {policy?, event, affectedRunIds}
 *  POST /api/quota/handoffs                        seal a handoff package
 *  POST /api/quota/handoffs/verify                 verify a received package
 *
 *  V3-#8 budgets (policy layer, zero real-model keys):
 *  GET  /api/quota/budgets                         current-window usage per budget
 *  POST /api/quota/budgets                         create a budget (operator)
 *  DELETE /api/quota/budgets/:id                   delete a budget (operator)
 *  GET  /api/quota/budgets/defaults                default policy + conversion table
 *  POST /api/quota/budgets/apply-defaults          {projectId} idempotent defaults
 *  POST /api/quota/budgets/usage                   record simulated/reported usage
 *  POST /api/quota/budgets/check                   {taskId?, personId?, projectId?}
 *  POST /api/quota/budgets/:id/usage               usage attributed to one budget
 *  POST /api/quota/budgets/:id/release             {reason} one-window override
 *  GET  /api/quota/budgets/overrides               release records
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET → viewer
 * and other methods → operator for this prefix — no auth.ts change.
 *
 * Persistence: <AI_FACTORY_DATA_DIR|data>/budgets.json, version-stamped,
 * atomic temp+rename write. Migration rule: budgets.json is new in
 * V3-#8, so no legacy files exist in the wild; a file with an unknown
 * shape fails closed (500, never silently overwritten) and the operator
 * renames it away explicitly. Budgets never overwrite each other: a
 * duplicate scope+key+unit+period is 409, and apply-defaults skips
 * existing budgets verbatim.
 *
 * Breaker → shadow checkpoint: when a PROJECT-scoped budget trips, the
 * route best-effort snapshots that project's working directory into a
 * shadow checkpoint (label budget-breaker:<id>) so the paused work can
 * resume from a known state. Checkpoint failure never blocks the trip
 * (the trip is the safety action); the response reports created:false
 * with the reason. Task/person budgets have no workspace, so no
 * checkpoint is attempted for them.
 *
 * HONEST BOUNDARY: cost/token figures are ESTIMATES unless the usage
 * row says source 'provider-reported'. Simulated usage proves the
 * breaker logic under the StubAdapter path, not a real bill. The
 * conversion table rows are all unmeasured placeholders.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  COST_CONVERSION_TABLE,
  CostGovernor,
  DEFAULT_BUDGET_POLICY,
  createHandoffPackage,
  QuotaMonitor,
  verifyHandoffPackage,
  type BudgetInput,
  type LimitEvent,
  type QuotaBucket,
  type TripEvent,
  type UsageRecord,
} from '@ai-factory/quota';
import type { RouteContext } from './context';
import { createShadowCheckpoint } from '../shadow-checkpoints';
import { shadowCheckpointStore } from './shadow';

const monitor = new QuotaMonitor();

function budgetsFile(): string {
  const dir = process.env['AI_FACTORY_DATA_DIR'] ?? 'data';
  return resolve(dir, 'budgets.json');
}

function loadGovernor(): CostGovernor {
  const file = budgetsFile();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new CostGovernor();
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('budgets.json is corrupt JSON; refusing to overwrite it (rename it away explicitly)');
  }
  return CostGovernor.fromJSON(parsed);
}

function saveGovernor(g: CostGovernor): void {
  const file = budgetsFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(g.toJSON(), null, 2), 'utf8');
  renameSync(tmp, file);
}

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function numField(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') throw new Error(`"${key}" must be a number`);
  return v;
}

function strField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  return v;
}

function actorOf(body: Record<string, unknown>): string {
  const a = body['actor'];
  return typeof a === 'string' && a.trim() ? a.trim() : 'operator';
}

/** Best-effort shadow checkpoint for a tripped project budget. */
function attemptCheckpoint(
  ctx: RouteContext,
  trip: TripEvent,
): { created: boolean; checkpointId?: string; reason?: string } {
  if (trip.scope !== 'project') return { created: false, reason: 'no-workspace-for-scope' };
  let project: { path?: string | null } | undefined;
  try {
    project = ctx.fdb.getProject(trip.scopeKey);
  } catch {
    return { created: false, reason: 'project-lookup-failed' };
  }
  const dir = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!dir) return { created: false, reason: 'no-project-path' };
  try {
    const cp = createShadowCheckpoint(shadowCheckpointStore(), {
      workspaceId: trip.scopeKey,
      workspacePath: dir,
      label: `budget-breaker:${trip.budgetId}`,
    });
    return { created: true, checkpointId: cp.id };
  } catch (e) {
    return { created: false, reason: (e as Error).message };
  }
}

function handleTripSideEffects(
  ctx: RouteContext,
  actor: string,
  trips: TripEvent[],
  warns: { budgetId: string; scope: string; scopeKey: string; windowId: string; used: number; limit: number }[],
): { checkpoints: Record<string, { created: boolean; checkpointId?: string; reason?: string }> } {
  const checkpoints: Record<string, { created: boolean; checkpointId?: string; reason?: string }> = {};
  for (const w of warns) {
    ctx.audit.record(actor, 'BUDGET_BREAKER_WARNED', 'budget', w.budgetId, {
      scope: w.scope, scopeKey: w.scopeKey, windowId: w.windowId, used: w.used, limit: w.limit,
    });
  }
  for (const t of trips) {
    ctx.audit.record(actor, 'BUDGET_BREAKER_TRIPPED', 'budget', t.budgetId, {
      scope: t.scope, scopeKey: t.scopeKey, windowId: t.windowId, used: t.used, limit: t.limit,
    });
    checkpoints[t.budgetId] = attemptCheckpoint(ctx, t);
    if (checkpoints[t.budgetId].created) {
      ctx.audit.record(actor, 'BUDGET_BREAKER_CHECKPOINT', 'budget', t.budgetId, {
        checkpointId: checkpoints[t.budgetId].checkpointId,
      });
    }
  }
  return { checkpoints };
}

export async function handleQuotaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/quota')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/quota'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg[0] === 'buckets' && seg.length === 1) {
    const body = await ctx.readBody(req);
    try {
      monitor.recordBucket(body['bucket'] as QuotaBucket);
      ctx.audit.record('api', 'QUOTA_BUCKET_RECORDED', 'quota', 'bucket', {});
      ctx.json(res, 201, { ok: true });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'limit-signal') {
    const body = await ctx.readBody(req);
    try {
      const event = monitor.recordLimitSignal(
        body['signal'] as string,
        body['bucket'] as QuotaBucket,
        body['retryAfterSec'] as number | undefined,
      );
      ctx.json(res, 201, { event });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'decide') {
    const body = await ctx.readBody(req);
    try {
      if (body['policy']) monitor.setPolicy(body['policy'] as never);
      const decision = monitor.decide(
        body['event'] as LimitEvent,
        (body['affectedRunIds'] as string[]) ?? [],
      );
      ctx.json(res, 200, { decision });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'handoffs' && seg.length === 1) {
    const body = await ctx.readBody(req);
    try {
      const pkg = createHandoffPackage(body['package'] as never);
      ctx.audit.record('api', 'HANDOFF_SEALED', 'handoff', pkg.handoffId, {});
      ctx.json(res, 201, { handoff: pkg });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'handoffs' && seg[1] === 'verify') {
    const body = await ctx.readBody(req);
    try {
      verifyHandoffPackage(body['package'] as never);
      ctx.json(res, 200, { ok: true });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // GET /api/quota/buckets — list buckets (usage display, §29.1 quota strip).
  if (method === 'GET' && seg[0] === 'buckets' && seg.length === 1) {
    ctx.json(res, 200, { buckets: monitor.listBuckets() });
    return true;
  }

  // ---- V3-#8 budgets -------------------------------------------------
  if (seg[0] === 'budgets') {
    // GET /api/quota/budgets/defaults — policy + placeholder conversion table.
    if (method === 'GET' && seg[1] === 'defaults' && seg.length === 2) {
      ctx.json(res, 200, {
        policy: DEFAULT_BUDGET_POLICY,
        conversionTable: COST_CONVERSION_TABLE,
        basis: 'estimates only: every conversion row is an unmeasured placeholder until a real model reports usage',
      });
      return true;
    }

    // GET /api/quota/budgets/overrides — release records.
    if (method === 'GET' && seg[1] === 'overrides' && seg.length === 2) {
      try {
        const g = loadGovernor();
        ctx.json(res, 200, { overrides: g.listOverrides() });
      } catch (err) {
        ctx.json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // GET /api/quota/budgets — current-window usage per budget.
    if (method === 'GET' && seg.length === 1) {
      try {
        const g = loadGovernor();
        const budgets = g.usageSummary();
        ctx.json(res, 200, {
          budgets,
          counts: {
            total: budgets.length,
            tripped: budgets.filter((b) => b.status === 'tripped').length,
            warned: budgets.filter((b) => b.status === 'warned').length,
            released: budgets.filter((b) => b.status === 'released').length,
          },
          basis: 'current window only; cost/token figures are estimates unless the usage row is provider-reported',
        });
      } catch (err) {
        ctx.json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/quota/budgets — create a budget.
    if (method === 'POST' && seg.length === 1) {
      const body = await ctx.readBody(req);
      try {
        if (!isRec(body)) throw new Error('body must be an object');
        const g = loadGovernor();
        const budget = g.createBudget({
          scope: body['scope'] as BudgetInput['scope'],
          scopeKey: body['scopeKey'] as string,
          unit: body['unit'] as BudgetInput['unit'],
          limit: body['limit'] as number,
          period: body['period'] as BudgetInput['period'],
          autoRenew: body['autoRenew'] as boolean | undefined,
          enabled: body['enabled'] as boolean | undefined,
        });
        saveGovernor(g);
        ctx.audit.record(actorOf(body), 'BUDGET_CREATED', 'budget', budget.id, {
          scope: budget.scope, scopeKey: budget.scopeKey, unit: budget.unit, limit: budget.limit, period: budget.period,
        });
        ctx.json(res, 201, { budget });
      } catch (err) {
        const msg = (err as Error).message;
        const status = /already exists/.test(msg) ? 409 : 400;
        ctx.json(res, status, { error: msg });
      }
      return true;
    }

    // POST /api/quota/budgets/apply-defaults — idempotent, never overwrites.
    if (method === 'POST' && seg[1] === 'apply-defaults' && seg.length === 2) {
      const body = await ctx.readBody(req);
      try {
        const projectId = strField(isRec(body) ? body : {}, 'projectId');
        if (!projectId) throw new Error('"projectId" is required');
        const g = loadGovernor();
        const result = g.applyDefaults(projectId);
        saveGovernor(g);
        ctx.audit.record(actorOf(isRec(body) ? body : {}), 'BUDGET_DEFAULTS_APPLIED', 'budget', projectId, {
          created: result.created.map((b) => b.id),
          existing: result.existing.map((b) => b.id),
        });
        ctx.json(res, 200, result);
      } catch (err) {
        ctx.json(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/quota/budgets/check — may a NEW model call start?
    if (method === 'POST' && seg[1] === 'check' && seg.length === 2) {
      const body = await ctx.readBody(req);
      try {
        const g = loadGovernor();
        const verdict = g.checkAllowed({
          taskId: strField(isRec(body) ? body : {}, 'taskId'),
          personId: strField(isRec(body) ? body : {}, 'personId'),
          projectId: strField(isRec(body) ? body : {}, 'projectId'),
        });
        ctx.json(res, 200, verdict);
      } catch (err) {
        ctx.json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/quota/budgets/usage — general simulated/reported usage.
    if (method === 'POST' && seg[1] === 'usage' && seg.length === 2) {
      const body = await ctx.readBody(req);
      try {
        if (!isRec(body)) throw new Error('body must be an object');
        const rec: UsageRecord = {
          taskId: strField(body, 'taskId'),
          personId: strField(body, 'personId'),
          projectId: strField(body, 'projectId'),
          calls: numField(body, 'calls'),
          inputTokens: numField(body, 'inputTokens'),
          outputTokens: numField(body, 'outputTokens'),
          costUsd: numField(body, 'costUsd'),
          source: (body['source'] as UsageRecord['source']) ?? 'simulated',
          note: strField(body, 'note'),
        };
        const g = loadGovernor();
        const result = g.recordUsage(rec);
        saveGovernor(g);
        const { checkpoints } = handleTripSideEffects(ctx, actorOf(body), result.tripped, result.warned);
        ctx.json(res, 201, { ...result, checkpoints });
      } catch (err) {
        ctx.json(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/quota/budgets/:id/usage — usage attributed to one budget.
    if (method === 'POST' && seg.length === 3 && seg[2] === 'usage') {
      const body = await ctx.readBody(req);
      try {
        if (!isRec(body)) throw new Error('body must be an object');
        const g = loadGovernor();
        const budget = g.getBudget(seg[1]);
        if (!budget) {
          ctx.json(res, 404, { error: `no budget with id ${seg[1]}` });
          return true;
        }
        const rec: UsageRecord = {
          calls: numField(body, 'calls'),
          inputTokens: numField(body, 'inputTokens'),
          outputTokens: numField(body, 'outputTokens'),
          costUsd: numField(body, 'costUsd'),
          source: (body['source'] as UsageRecord['source']) ?? 'simulated',
          note: strField(body, 'note'),
        };
        if (budget.scope === 'task') rec.taskId = budget.scopeKey;
        else if (budget.scope === 'person') rec.personId = budget.scopeKey;
        else rec.projectId = budget.scopeKey;
        const result = g.recordUsage(rec);
        saveGovernor(g);
        const { checkpoints } = handleTripSideEffects(ctx, actorOf(body), result.tripped, result.warned);
        ctx.json(res, 201, { ...result, checkpoints });
      } catch (err) {
        ctx.json(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/quota/budgets/:id/release — one-window override, reason required.
    if (method === 'POST' && seg.length === 3 && seg[2] === 'release') {
      const body = await ctx.readBody(req);
      try {
        if (!isRec(body)) throw new Error('body must be an object');
        const g = loadGovernor();
        const release = g.releaseBudget(seg[1], strField(body, 'reason') ?? '');
        saveGovernor(g);
        ctx.audit.record(actorOf(body), 'BUDGET_RELEASED', 'budget', seg[1], {
          windowId: release.windowId, reason: release.reason,
        });
        ctx.json(res, 200, { release });
      } catch (err) {
        const msg = (err as Error).message;
        const status = /no budget with id/.test(msg) ? 404 : 400;
        ctx.json(res, status, { error: msg });
      }
      return true;
    }

    // DELETE /api/quota/budgets/:id
    if (method === 'DELETE' && seg.length === 2) {
      try {
        const g = loadGovernor();
        const ok = g.deleteBudget(seg[1]);
        if (!ok) {
          ctx.json(res, 404, { error: `no budget with id ${seg[1]}` });
          return true;
        }
        saveGovernor(g);
        ctx.audit.record('operator', 'BUDGET_DELETED', 'budget', seg[1], {});
        ctx.json(res, 200, { deleted: seg[1] });
      } catch (err) {
        ctx.json(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  }

  return false;
}
