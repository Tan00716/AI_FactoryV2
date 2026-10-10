/**
 * Activity stream + Run/Trace detail — spec §67 (Agent Activity) and §68
 * (Run / Trace System).
 *
 *  GET /api/activity?limit=   unified realtime stream: audit log records +
 *                             system event bus events, every item timestamped
 *                             (§67), newest first
 *  GET /api/runs              run summaries (aggregated from the runtime
 *                             in-memory run store, §68)
 *  GET /api/runs/:id          full run/trace detail with every §68 field;
 *                             sensitive values are redacted as *** (§68)
 *
 * Run data is aggregated from the existing runtime run store
 * (routes/runtime.ts) + audit log + agents/tasks registries — no separate
 * recorder needed.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleActivityRoutes } from './routes/activity';
 *   if (await handleActivityRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { redactSecrets } from '@ai-factory/events';
import { MODEL_CATALOG } from '@ai-factory/model-router';
import type { RouteContext } from './context';
import { getRuntimeRun, listRuntimeRuns } from './runtime';

/** One item of the §67 realtime stream — always timestamped. */
export interface ActivityItem {
  id: string;
  /** ISO-8601 timestamp (§67: every event must be timestamped). */
  ts: string;
  kind: 'audit' | 'event';
  source: string;
  /** Human-readable one-liner, e.g. "11:03 PM PM started Task #1042". */
  label: string;
  /** Redacted details. */
  detail: Record<string, unknown>;
  /** Set when the item belongs to an agent run — the UI opens the run drawer. */
  runId?: string;
}

function humanizeType(t: string): string {
  return t.toLowerCase().replace(/_/g, ' ');
}

function payloadSummary(payload: Record<string, unknown>): string {
  const bits: string[] = [];
  for (const k of ['taskId', 'runId', 'agentId', 'title', 'from', 'to', 'verdict', 'outcome', 'environment', 'action']) {
    const v = payload[k];
    if (typeof v === 'string' && v) bits.push(`${k}=${v.slice(0, 24)}`);
  }
  return bits.length > 0 ? ` (${bits.join(', ')})` : '';
}

export function buildActivity(ctx: RouteContext, limit: number): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const a of ctx.audit.list().slice(-limit)) {
    const item: ActivityItem = {
      id: `audit:${a.id}`,
      ts: a.ts,
      kind: 'audit',
      source: a.actor,
      label: `${a.actor} — ${humanizeType(a.action)} ${a.entityType} ${a.entityId.slice(0, 8)}`,
      detail: redactSecrets({ ...a.details, entityType: a.entityType, entityId: a.entityId }),
    };
    if (a.entityType === 'runtime_run') item.runId = a.entityId;
    items.push(item);
  }

  for (const e of ctx.bus.recent(limit)) {
    const runId = typeof e.payload['runId'] === 'string' ? (e.payload['runId'] as string) : undefined;
    items.push({
      id: `event:${e.seq}`,
      ts: e.ts,
      kind: 'event',
      source: e.source,
      label: `${e.source} — ${humanizeType(e.type)}${payloadSummary(e.payload)}`,
      detail: redactSecrets(e.payload),
      ...(runId ? { runId } : {}),
    });
  }

  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return items.slice(0, limit);
}

/** Every §68 field for one agent run. */
export interface RunDetail {
  runId: string;
  status: string;
  agent: { id: string; name: string; displayName: string; version: number } | null;
  agentVersion: number | null;
  task: { id: string; title: string } | null;
  model: string;
  modelProvider: string;
  startedAt: string;
  finishedAt: string | null;
  inputRefs: string[];
  toolsUsed: { at: string; name: string; result: string }[];
  commands: string[];
  filesChanged: { path: string; kind: string }[];
  artifacts: unknown[];
  errors: { at: string; message: string }[];
  retries: number;
  handoffs: string[];
  approvals: { id: string; action: string; status: string; decision: string; decidedBy: string }[];
  evidence: unknown[];
  trace: { at: string; phase: string; action: string; result: string }[];
  finalOutcome: string | null;
}

function providerForModel(model: string): string {
  const hit = MODEL_CATALOG.find((m) => m.model === model);
  return hit ? hit.provider : 'unknown';
}

export function buildRunDetail(ctx: RouteContext, runId: string): RunDetail | null {
  const rec = getRuntimeRun(runId);
  if (!rec) return null;

  let agent: RunDetail['agent'] = null;
  try {
    const a = ctx.agents.get(rec.agentId);
    agent = { id: a.id, name: a.name, displayName: a.displayName, version: a.version };
  } catch {
    /* agent may have been archived */
  }
  let task: RunDetail['task'] = null;
  try {
    const t = ctx.tasks.get(rec.taskId);
    task = { id: t.id, title: t.title };
  } catch {
    /* task may have been deleted */
  }

  // Model + provider: the routing decision is stored as evidence by runAgent.
  let model = '';
  for (const e of rec.evidence as Array<{ type?: string; payload?: Record<string, unknown> }>) {
    if (e?.type === 'model_routing' && typeof e.payload?.['primary'] === 'string') {
      model = e.payload['primary'] as string;
      break;
    }
  }
  if (!model) {
    try {
      model = ctx.agents.get(rec.agentId).model;
    } catch {
      model = 'unknown';
    }
  }

  const trace = (rec.trace as Array<{ t?: number; phase?: string; action?: string; result?: string }>).map(
    (s) => ({
      at: typeof s.t === 'number' ? new Date(s.t).toISOString() : rec.createdAt,
      phase: String(s.phase ?? ''),
      action: String(s.action ?? ''),
      result: String(s.result ?? ''),
    }),
  );

  const toolsUsed = trace
    .filter((s) => s.phase === 'HARNESS' && s.action.startsWith('tool:'))
    .map((s) => ({ at: s.at, name: s.action.slice('tool:'.length), result: s.result }));

  const retries = trace.filter((s) => /retry/i.test(s.action) || /retry/i.test(s.result)).length;

  const errors =
    rec.error != null
      ? [{ at: rec.finishedAt ?? rec.createdAt, message: rec.error }]
      : trace
          .filter((s) => /fail/i.test(s.result))
          .map((s) => ({ at: s.at, message: `${s.action}: ${s.result}` }));

  const approvals = task
    ? ctx.fdb.approvals.listByTask(task.id).map((a) => ({
        id: a.approval_id,
        action: a.action,
        status: a.status,
        decision: a.decision,
        decidedBy: a.decided_by,
      }))
    : [];

  return redactSecrets({
    runId: rec.id,
    status: rec.status,
    agent,
    agentVersion: agent?.version ?? null,
    task,
    model,
    modelProvider: providerForModel(model),
    startedAt: rec.createdAt,
    finishedAt: rec.finishedAt,
    inputRefs: [`task:${rec.taskId}`, `agent:${rec.agentId}`],
    toolsUsed,
    // Prototype runs use the scripted StubAdapter (echo/add tools); shell
    // commands and file mutations are recorded via audit RUNTIME_* entries.
    commands: [],
    filesChanged: [],
    artifacts: rec.evidence,
    errors,
    retries,
    handoffs: rec.handoffs,
    approvals,
    evidence: rec.evidence,
    trace,
    finalOutcome: rec.outcome,
  });
}

export function listRunSummaries() {
  return listRuntimeRuns().map((r) => ({
    runId: r.id,
    agentId: r.agentId,
    taskId: r.taskId,
    status: r.status,
    outcome: r.outcome,
    steps: r.steps,
    startedAt: r.createdAt,
    finishedAt: r.finishedAt,
  }));
}

export async function handleActivityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/activity') && !path.startsWith('/api/runs')) return false;

  if (method === 'GET' && path === '/api/activity') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    return ctx.json(res, 200, { items: buildActivity(ctx, limit) }), true;
  }

  if (method === 'GET' && path === '/api/runs') {
    return ctx.json(res, 200, { runs: listRunSummaries() }), true;
  }

  const one = path.match(/^\/api\/runs\/([^/]+)$/);
  if (method === 'GET' && one) {
    const detail = buildRunDetail(ctx, decodeURIComponent(one[1]));
    if (!detail) return ctx.json(res, 404, { error: 'run not found' }), true;
    return ctx.json(res, 200, detail), true;
  }

  return false;
}
