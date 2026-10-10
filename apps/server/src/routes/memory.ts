/**
 * Memory routes — spec §54 (Memory Engine), §55 (structured entries),
 * §56 (confidence), §57–§58 (evaluation → lesson).
 *
 *   POST /api/memory                    write (dedup/merge) → 201
 *   GET  /api/memory?scope=&scopeId=&type=&minConfidence=
 *   GET  /api/memory/:id
 *   POST /api/memory/:id/verify         {verifier?} → refresh + confidence boost
 *   POST /api/memory/lessons            {taskId, projectId, employeeId?, summary, metrics, failures}
 *
 * Writes go through @ai-factory/memory's MemoryStore (dedup/merge, expiry,
 * decay) and are mirrored into the `memory_entries` SQL table for durability.
 * Reads use the in-memory store so lifecycle semantics (auto-expiry, decay)
 * apply.
 *
 * The coordinator wires this in: handleMemoryRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: the in-memory store resets on server restart (the SQL rows
 * remain as the durable record).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MemoryStore,
  lessonFromEvaluation,
  type MemoryEntry,
  type MemoryScope,
  type MemoryType,
} from '@ai-factory/memory';
import type { RouteContext } from './context';

const PREFIX = '/api/memory';
const SCOPES: MemoryScope[] = ['employee', 'project', 'organization', 'task', 'system'];
const TYPES: MemoryType[] = [
  'Fact', 'Decision', 'Pattern', 'Lesson', 'Failure',
  'Preference', 'Constraint', 'Solution', 'KnownIssue',
];

const store = new MemoryStore();

function persist(ctx: RouteContext, e: MemoryEntry): void {
  ctx.fdb.memory.upsert(e);
}

function isScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (SCOPES as string[]).includes(v);
}
function isType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (TYPES as string[]).includes(v);
}

export async function handleMemoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // POST /api/memory/lessons — before the :id matcher.
  if (method === 'POST' && path === `${PREFIX}/lessons`) {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'];
    const projectId = body['projectId'];
    const summary = body['summary'];
    if (typeof taskId !== 'string' || !taskId || typeof projectId !== 'string' || !projectId) {
      return ctx.json(res, 400, { error: 'taskId and projectId are required' }), true;
    }
    if (typeof summary !== 'string' || !summary) {
      return ctx.json(res, 400, { error: 'summary is required' }), true;
    }
    const metrics = (body['metrics'] as { success: boolean; testPassRate: number; repairLoops: number }) ?? {
      success: true, testPassRate: 1, repairLoops: 0,
    };
    const failures = Array.isArray(body['failures']) ? (body['failures'] as string[]) : [];
    const employeeId = typeof body['employeeId'] === 'string' ? body['employeeId'] : undefined;
    const created = lessonFromEvaluation({ taskId, projectId, employeeId, summary, metrics, failures })
      .map((n) => store.write(n));
    for (const e of created) persist(ctx, e);
    ctx.audit.record('evaluation-engine', 'MEMORY_LESSONS_RECORDED', 'task', taskId, {
      count: created.length,
    });
    return ctx.json(res, 201, { entries: created }), true;
  }

  // POST /api/memory
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    if (!isScope(body['scope'])) {
      return ctx.json(res, 400, { error: `scope must be one of ${SCOPES.join('|')}` }), true;
    }
    if (!isType(body['type'])) {
      return ctx.json(res, 400, { error: `type must be one of ${TYPES.join('|')}` }), true;
    }
    const title = body['title'];
    if (typeof title !== 'string' || !title) {
      return ctx.json(res, 400, { error: 'title is required' }), true;
    }
    const entry = store.write({
      scope: body['scope'],
      scopeId: typeof body['scopeId'] === 'string' ? body['scopeId'] : '',
      type: body['type'],
      title,
      content: typeof body['content'] === 'string' ? body['content'] : '',
      source: typeof body['source'] === 'string' ? body['source'] : 'human',
      confidence: typeof body['confidence'] === 'number' ? body['confidence'] : 0.8,
      createdBy: typeof body['createdBy'] === 'string' ? body['createdBy'] : 'human',
      evidenceIds: Array.isArray(body['evidenceIds']) ? (body['evidenceIds'] as string[]) : [],
      applicableScope: typeof body['applicableScope'] === 'string' ? body['applicableScope'] : '',
      expiresAt: typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null,
    });
    persist(ctx, entry);
    ctx.audit.record(entry.createdBy, 'MEMORY_WRITTEN', 'memory_entry', entry.id, {
      scope: entry.scope, type: entry.type,
    });
    return ctx.json(res, 201, { entry }), true;
  }

  // GET /api/memory?scope=&scopeId=&type=&minConfidence=
  if (method === 'GET' && path === PREFIX) {
    const q = url.searchParams;
    const scope = q.get('scope');
    const type = q.get('type');
    if (scope !== null && !isScope(scope)) {
      return ctx.json(res, 400, { error: `scope must be one of ${SCOPES.join('|')}` }), true;
    }
    if (type !== null && !isType(type)) {
      return ctx.json(res, 400, { error: `type must be one of ${TYPES.join('|')}` }), true;
    }
    const minConfidence = q.get('minConfidence');
    const scopes = scope ? [scope as MemoryScope] : SCOPES;
    const entries = scopes.flatMap((s) =>
      store.query({
        scope: s,
        scopeId: q.get('scopeId') ?? undefined,
        type: (type as MemoryType | null) ?? undefined,
        minConfidence: minConfidence !== null ? Number(minConfidence) : undefined,
      }),
    );
    entries.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt));
    return ctx.json(res, 200, { entries }), true;
  }

  const idMatch = path.match(/^\/api\/memory\/([^/]+)(\/.*)?$/);
  if (!idMatch) return false;
  const id = decodeURIComponent(idMatch[1]);
  const rest = idMatch[2] ?? '';

  // GET /api/memory/:id
  if (method === 'GET' && rest === '') {
    const entry = store.get(id) ?? ctx.fdb.memory.get(id);
    if (!entry) return ctx.json(res, 404, { error: `memory entry ${id} not found` }), true;
    return ctx.json(res, 200, { entry }), true;
  }

  // POST /api/memory/:id/verify
  if (method === 'POST' && rest === '/verify') {
    const body = await ctx.readBody(req);
    const verifier = typeof body['verifier'] === 'string' ? body['verifier'] : 'human';
    const entry = store.verify(id, verifier);
    if (!entry) return ctx.json(res, 404, { error: `memory entry ${id} not found` }), true;
    persist(ctx, entry);
    ctx.audit.record(verifier, 'MEMORY_VERIFIED', 'memory_entry', id, {
      confidence: entry.confidence,
    });
    return ctx.json(res, 200, { entry }), true;
  }

  return false;
}
