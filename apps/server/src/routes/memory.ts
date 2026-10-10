/**
 * Memory routes — SPEC v2 §43 (Structured Memory Engine).
 *
 *   POST /api/memory                    write (guards, dedup/merge) → 201
 *   GET  /api/memory?scope=&scopeId=&type=&minConfidence=
 *                                       legacy low-level query (no security filter;
 *                                       internal callers only)
 *   GET  /api/memory/retrieve?scope=&scopeId=&type=&minConfidence=
 *         + x-requestor-id / x-requestor-scopes / x-requestor-clearance headers
 *                                       §43.3 ACL-aware retrieval: ACL + data
 *                                       classification filter FIRST; unauthorized
 *                                       entries are never returned → 200
 *   GET  /api/memory/:id
 *   POST /api/memory/:id/verify         {verifier?} → refresh + confidence boost
 *   POST /api/memory/lessons            {taskId, projectId, employeeId?, summary, metrics, failures}
 *   POST /api/memory/contradictions     {contradictIds[], entry} → old entries
 *                                       CONTRADICTED, new entry PROPOSED → 201
 *   POST /api/memory/resolve            {winnerId, loserIds?[], byAuthority?, resolver?}
 *                                       → winner ACTIVE, losers RETIRED → 200
 *   POST /api/memory/purge              {scopeId} → removes entries + cleans
 *                                       index/cache/backup refs → 200 {report}
 *
 * Writes go through @ai-factory/memory's MemoryStore (§43.4 write guards,
 * dedup/merge, contradiction marking, expiry, decay) and are mirrored into
 * the `memory_entries` SQL table for durability. Reads use the in-memory
 * store so lifecycle semantics (auto-expiry, decay) apply.
 *
 * The coordinator wires this in: handleMemoryRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: the in-memory store resets on server restart (the SQL rows
 * remain as the durable record).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MemoryError,
  MemoryRefRegistry,
  MemoryStore,
  lessonFromEvaluation,
  type DataClassification,
  type MemoryEntry,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type NewMemoryEntry,
  type RequestorIdentity,
} from '@ai-factory/memory';
import type { RouteContext } from './context';

const PREFIX = '/api/memory';
const SCOPES: MemoryScope[] = ['employee', 'project', 'organization', 'task', 'system'];
const TYPES: MemoryType[] = [
  'Fact', 'Decision', 'Pattern', 'Lesson', 'Failure',
  'Preference', 'Constraint', 'Solution', 'KnownIssue',
];
const STATUSES: MemoryStatus[] = [
  'PROPOSED', 'VALIDATED', 'ACTIVE', 'STALE', 'CONTRADICTED', 'RETIRED',
];
const CLASSIFICATIONS: DataClassification[] = ['public', 'internal', 'confidential', 'secret'];

/**
 * Observable downstream-reference registry (§43.3): every write tracks
 * index/cache/backup references; purge() cleans them and the PurgeReport
 * proves nothing readable remains.
 */
const registry = new MemoryRefRegistry();
const store = new MemoryStore({ registry });

function persist(ctx: RouteContext, e: MemoryEntry): void {
  ctx.fdb.memory.upsert(e);
}

function isScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (SCOPES as string[]).includes(v);
}
function isType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (TYPES as string[]).includes(v);
}
function isClassification(v: unknown): v is DataClassification {
  return typeof v === 'string' && (CLASSIFICATIONS as string[]).includes(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];
}

/** Parse a NewMemoryEntry from a request body; throws MemoryError(INVALID_INPUT) on bad fields. */
function readNewEntry(body: Record<string, unknown>): NewMemoryEntry {
  if (!isScope(body['scope'])) {
    throw new MemoryError('INVALID_INPUT', `scope must be one of ${SCOPES.join('|')}`);
  }
  if (!isType(body['type'])) {
    throw new MemoryError('INVALID_INPUT', `type must be one of ${TYPES.join('|')}`);
  }
  const title = body['title'];
  if (typeof title !== 'string' || !title.trim()) {
    throw new MemoryError('INVALID_INPUT', 'title is required');
  }
  const classification = body['dataClassification'];
  if (classification !== undefined && !isClassification(classification)) {
    throw new MemoryError(
      'INVALID_INPUT',
      `dataClassification must be one of ${CLASSIFICATIONS.join('|')}`,
    );
  }
  const reuse = body['crossProjectReusable'];
  const entry: NewMemoryEntry = {
    scope: body['scope'],
    scopeId: typeof body['scopeId'] === 'string' ? body['scopeId'] : '',
    type: body['type'],
    title,
    content: typeof body['content'] === 'string' ? body['content'] : '',
    source: typeof body['source'] === 'string' ? body['source'] : 'human',
    confidence: typeof body['confidence'] === 'number' ? body['confidence'] : 0.8,
    createdBy: typeof body['createdBy'] === 'string' ? body['createdBy'] : 'human',
    evidenceIds: asStringArray(body['evidenceIds']),
    sourceRefs: asStringArray(body['sourceRefs']),
    taskRefs: asStringArray(body['taskRefs']),
    applicableScope: typeof body['applicableScope'] === 'string' ? body['applicableScope'] : '',
    accessScope: body['accessScope'] === undefined ? undefined : asStringArray(body['accessScope']),
    dataClassification: classification as DataClassification | undefined,
    crossProjectReusable:
      typeof reuse === 'object' && reuse !== null
        ? {
            allowed: (reuse as { allowed?: unknown }).allowed === true,
            conditions:
              typeof (reuse as { conditions?: unknown }).conditions === 'string'
                ? (reuse as { conditions: string }).conditions
                : undefined,
          }
        : undefined,
    confidenceKind:
      body['confidenceKind'] === 'evidence-backed' ||
      body['confidenceKind'] === 'human-verified' ||
      body['confidenceKind'] === 'evaluation-derived' ||
      body['confidenceKind'] === 'model-self-assessed'
        ? body['confidenceKind']
        : undefined,
    expiresAt: typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null,
    supersedes: asStringArray(body['supersedes']),
    contradicts: asStringArray(body['contradicts']),
  };
  return entry;
}

/** Build a RequestorIdentity from headers; returns an error string when the identity is incomplete. */
function readRequestor(req: IncomingMessage): RequestorIdentity | { error: string } {
  const id = req.headers['x-requestor-id'];
  const scopesHeader = req.headers['x-requestor-scopes'];
  const clearance = req.headers['x-requestor-clearance'];
  if (typeof id !== 'string' || !id.trim()) {
    return { error: 'x-requestor-id header is required' };
  }
  if (typeof scopesHeader !== 'string') {
    return { error: 'x-requestor-scopes header is required (comma-separated granted scopes)' };
  }
  if (!isClassification(clearance)) {
    return { error: `x-requestor-clearance header must be one of ${CLASSIFICATIONS.join('|')}` };
  }
  return {
    id: id.trim(),
    scopes: scopesHeader.split(',').map((s) => s.trim()).filter(Boolean),
    clearance,
  };
}

/** Map a MemoryError to an HTTP response (422 for guard/prohibition rejections). */
function memoryErrorToStatus(err: MemoryError): number {
  switch (err.code) {
    case 'SECRET_DETECTED':
    case 'PROHIBITED_CONCLUSION':
    case 'MANAGER_CLAIM_NEEDS_EVIDENCE':
    case 'AUTHORIZATION_FORBIDDEN':
      return 422;
    case 'ENTRY_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
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
    let created: MemoryEntry[];
    try {
      created = lessonFromEvaluation({ taskId, projectId, employeeId, summary, metrics, failures }).map(
        (n) => store.write(n),
      );
    } catch (err) {
      if (err instanceof MemoryError) {
        return ctx.json(res, memoryErrorToStatus(err), { error: err.message, code: err.code }), true;
      }
      throw err;
    }
    for (const e of created) persist(ctx, e);
    ctx.audit.record('evaluation-engine', 'MEMORY_LESSONS_RECORDED', 'task', taskId, {
      count: created.length,
    });
    return ctx.json(res, 201, { entries: created }), true;
  }

  // POST /api/memory/contradictions — { contradictIds: string[], entry: {...} }.
  if (method === 'POST' && path === `${PREFIX}/contradictions`) {
    const body = await ctx.readBody(req);
    const contradictIds = asStringArray(body['contradictIds']);
    if (contradictIds.length === 0) {
      return ctx.json(res, 400, { error: 'contradictIds must be a non-empty string array' }), true;
    }
    const entryBody = body['entry'];
    if (typeof entryBody !== 'object' || entryBody === null) {
      return ctx.json(res, 400, { error: 'entry object is required' }), true;
    }
    try {
      const entry = store.write({
        ...readNewEntry(entryBody as Record<string, unknown>),
        contradicts: contradictIds,
      });
      persist(ctx, entry);
      ctx.audit.record(entry.createdBy, 'MEMORY_CONTRADICTION_MARKED', 'memory_entry', entry.id, {
        contradictIds,
      });
      return ctx.json(res, 201, { entry, contradictedIds: contradictIds }), true;
    } catch (err) {
      if (err instanceof MemoryError) {
        return ctx.json(res, memoryErrorToStatus(err), { error: err.message, code: err.code }), true;
      }
      throw err;
    }
  }

  // POST /api/memory/resolve — { winnerId, loserIds?, byAuthority?, resolver? }.
  if (method === 'POST' && path === `${PREFIX}/resolve`) {
    const body = await ctx.readBody(req);
    const winnerId = body['winnerId'];
    if (typeof winnerId !== 'string' || !winnerId) {
      return ctx.json(res, 400, { error: 'winnerId is required' }), true;
    }
    const resolver = typeof body['resolver'] === 'string' ? body['resolver'] : 'human';
    try {
      const result =
        body['byAuthority'] === true
          ? store.resolveBySourceAuthority(
              [winnerId, ...asStringArray(body['loserIds'])],
              resolver,
            )
          : store.resolveContradiction(winnerId, asStringArray(body['loserIds']), resolver);
      for (const e of [result.winner, ...result.losers]) persist(ctx, e);
      ctx.audit.record(resolver, 'MEMORY_CONTRADICTION_RESOLVED', 'memory_entry', result.winner.id, {
        loserIds: result.losers.map((l) => l.id),
        byAuthority: body['byAuthority'] === true,
      });
      return ctx.json(res, 200, result), true;
    } catch (err) {
      if (err instanceof MemoryError) {
        return ctx.json(res, memoryErrorToStatus(err), { error: err.message, code: err.code }), true;
      }
      throw err;
    }
  }

  // POST /api/memory/purge — { scopeId }: §43.3 revocation/TTL/project-deletion cleanup.
  if (method === 'POST' && path === `${PREFIX}/purge`) {
    const body = await ctx.readBody(req);
    const scopeId = body['scopeId'];
    if (typeof scopeId !== 'string' || !scopeId) {
      return ctx.json(res, 400, { error: 'scopeId is required' }), true;
    }
    const report = store.purge(scopeId);
    // Keep the durable SQL mirror consistent with the purge.
    const sqlDeleted = ctx.fdb.memory.deleteByScopeId(scopeId);
    ctx.audit.record('human', 'MEMORY_PURGED', 'memory_scope', scopeId, {
      removedCount: report.removedCount,
      cleanedRefs: report.cleanedRefs,
      registryClean: report.registryClean,
      sqlDeleted,
    });
    return ctx.json(res, 200, { report, sqlDeleted }), true;
  }

  // POST /api/memory
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    try {
      const entry = store.write(readNewEntry(body));
      persist(ctx, entry);
      ctx.audit.record(entry.createdBy, 'MEMORY_WRITTEN', 'memory_entry', entry.id, {
        scope: entry.scope,
        type: entry.type,
        status: entry.status,
      });
      return ctx.json(res, 201, { entry }), true;
    } catch (err) {
      if (err instanceof MemoryError) {
        return ctx.json(res, memoryErrorToStatus(err), { error: err.message, code: err.code }), true;
      }
      throw err;
    }
  }

  // GET /api/memory/retrieve — §43.3 ACL-aware retrieval (before the legacy GET).
  if (method === 'GET' && path === `${PREFIX}/retrieve`) {
    const requestor = readRequestor(req);
    if ('error' in requestor) {
      return ctx.json(res, 400, { error: requestor.error }), true;
    }
    const q = url.searchParams;
    const scope = q.get('scope');
    const type = q.get('type');
    if (scope !== null && !isScope(scope)) {
      return ctx.json(res, 400, { error: `scope must be one of ${SCOPES.join('|')}` }), true;
    }
    if (type !== null && !isType(type)) {
      return ctx.json(res, 400, { error: `type must be one of ${TYPES.join('|')}` }), true;
    }
    const status = q.get('status');
    if (status !== null && !(STATUSES as string[]).includes(status)) {
      return ctx.json(res, 400, { error: `status must be one of ${STATUSES.join('|')}` }), true;
    }
    const minConfidence = q.get('minConfidence');
    let entries = store.retrieve(
      {
        scope: (scope as MemoryScope | null) ?? 'project',
        scopeId: q.get('scopeId') ?? undefined,
        type: (type as MemoryType | null) ?? undefined,
        minConfidence: minConfidence !== null ? Number(minConfidence) : undefined,
        includeRetired: q.get('includeRetired') === 'true',
        includeContradicted: q.get('includeContradicted') === 'true',
      },
      requestor,
    );
    if (status !== null) {
      entries = entries.filter((e) => e.status === status);
    }
    return ctx.json(res, 200, { entries, requestor: { id: requestor.id, clearance: requestor.clearance } }), true;
  }

  // GET /api/memory?scope=&scopeId=&type=&minConfidence=
  // Legacy low-level query: NO security filtering. Internal callers only;
  // external clients must use /api/memory/retrieve (§43.3).
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
      status: entry.status,
    });
    return ctx.json(res, 200, { entry }), true;
  }

  return false;
}
