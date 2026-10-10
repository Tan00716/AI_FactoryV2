/**
 * Knowledge routes — spec §50 (hierarchy), §51 (sources), §52 (scout),
 * §53 (lifecycle + promotion policy).
 *
 *   GET  /api/knowledge?q=&projectId=&taskId=   hierarchical query (§50)
 *   POST /api/knowledge                          {title, content, tags?, scope, source}
 *   GET  /api/knowledge/:id                      item + lifecycle history
 *   POST /api/knowledge/:id/transition           {to, actor, note?, evidence?}
 *   POST /api/knowledge/scout                    {candidate: ScoutCandidate}
 *   POST /api/knowledge/:id/publish              {actor, skillId, summary?} → proposal+notice only
 *
 * Publishing never modifies agents (§53): /publish returns a proposal and a
 * notice; applying them is an external, separately-approved step.
 * Every lifecycle transition writes an audit record.
 *
 *   GET  /api/knowledge/feed              Update Feed cards (spec §89)
 *   POST /api/knowledge/feed/:id/decision {decision: 'adopt'|'ignore', actor?}
 *                                          → audit record only; never touches agents
 *
 * The coordinator wires this in: handleKnowledgeRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: store is in-memory (lost on restart).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  KnowledgeStore,
  KnowledgeScout,
  sampleFeedCards,
  type LifecycleState,
  type NewKnowledgeInput,
  type QueryContext,
} from '@ai-factory/knowledge';
import type { RouteContext } from './context';

const PREFIX = '/api/knowledge';

const store = new KnowledgeStore();
const scout = new KnowledgeScout();

export async function handleKnowledgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/knowledge — hierarchical query with scope fallback.
  if (method === 'GET' && path === PREFIX) {
    const qctx: QueryContext = {
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      projectId: url.searchParams.get('projectId') ?? undefined,
      employeeId: url.searchParams.get('employeeId') ?? undefined,
      taskId: url.searchParams.get('taskId') ?? undefined,
    };
    const hits = store.query(qctx).filter((h) => {
      const needle = (url.searchParams.get('q') ?? '').toLowerCase();
      if (!needle) return true;
      return (
        h.item.title.toLowerCase().includes(needle) ||
        h.item.content.toLowerCase().includes(needle)
      );
    });
    return ctx.json(res, 200, { hits }), true;
  }

  // POST /api/knowledge — add a candidate item (starts at DISCOVERED).
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const title = body['title'];
    const content = body['content'];
    if (typeof title !== 'string' || typeof content !== 'string') {
      return ctx.json(res, 400, { error: 'title and content are required' }), true;
    }
    try {
      const item = store.add({
        title,
        content,
        tags: Array.isArray(body['tags']) ? (body['tags'] as string[]) : [],
        scope: (body['scope'] as NewKnowledgeInput['scope']) ?? {},
        source: (body['source'] as NewKnowledgeInput['source']) ?? { kind: 'community' },
      } as NewKnowledgeInput);
      ctx.audit.record('human', 'KNOWLEDGE_ADDED', 'knowledge', item.id, { title });
      return ctx.json(res, 201, { item }), true;
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  // POST /api/knowledge/scout — before the :id matcher.
  if (method === 'POST' && path === `${PREFIX}/scout`) {
    const body = await ctx.readBody(req);
    const candidate = body['candidate'] as Record<string, unknown> | undefined;
    if (!candidate || typeof candidate['title'] !== 'string' || typeof candidate['rawContent'] !== 'string') {
      return ctx.json(res, 400, { error: 'candidate {title, rawContent, topic, source, scope} is required' }), true;
    }
    try {
      const result = await scout.run(candidate as never);
      ctx.audit.record('system', 'KNOWLEDGE_SCOUT_RUN', 'knowledge_scout', String((result as { runId?: string }).runId ?? 'n/a'), {
        title: candidate['title'],
      });
      return ctx.json(res, 200, result), true;
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  const idMatch = path.match(/^\/api\/knowledge\/([^/]+)(\/.*)?$/);
  if (!idMatch) return false;
  const id = decodeURIComponent(idMatch[1]);
  const rest = idMatch[2] ?? '';

  // GET /api/knowledge/feed — Update Feed cards (spec §89). When the feed
  // store is empty the knowledge package provides built-in sample cards.
  if (method === 'GET' && id === 'feed' && rest === '') {
    const cards = sampleFeedCards();
    return ctx.json(res, 200, { cards, source: 'sample' }), true;
  }

  // POST /api/knowledge/feed/:id/decision — adopt/ignore a feed card.
  // Records an audit entry only; adopting never modifies agents (§53 policy).
  if (method === 'POST' && id === 'feed' && rest === '/decision') {
    const body = await ctx.readBody(req);
    const cardId = typeof body['cardId'] === 'string' ? body['cardId'] : null;
    const decision = body['decision'];
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    if (!cardId || (decision !== 'adopt' && decision !== 'ignore')) {
      return ctx.json(res, 400, { error: "cardId and decision 'adopt'|'ignore' are required" }), true;
    }
    const card = sampleFeedCards().find((c) => c.id === cardId);
    if (!card) return ctx.json(res, 404, { error: `feed card not found: ${cardId}` }), true;
    ctx.audit.record(actor, 'KNOWLEDGE_FEED_DECISION', 'knowledge_feed', cardId, {
      decision, title: card.title, recommendedAction: card.recommendedAction,
    });
    return ctx.json(res, 200, { ok: true, cardId, decision }), true;
  }

  // GET /api/knowledge/:id
  if (method === 'GET' && rest === '') {
    const item = store.get(id);
    if (!item) return ctx.json(res, 404, { error: `Knowledge item not found: ${id}` }), true;
    return ctx.json(res, 200, { item, history: store.history(id) }), true;
  }

  // POST /api/knowledge/:id/transition
  if (method === 'POST' && rest === '/transition') {
    const body = await ctx.readBody(req);
    const to = body['to'] as LifecycleState | undefined;
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    if (!to) return ctx.json(res, 400, { error: 'to (target lifecycle state) is required' }), true;
    try {
      const { item, transition } = store.transition(id, to, {
        actor,
        note: typeof body['note'] === 'string' ? body['note'] : undefined,
        evidence: (body['evidence'] as never) ?? undefined,
      });
      ctx.audit.record(actor, 'KNOWLEDGE_TRANSITION', 'knowledge', id, {
        from: transition.from, to: transition.to,
      });
      return ctx.json(res, 200, { item, transition }), true;
    } catch (e) {
      return ctx.json(res, 422, { error: (e as Error).message }), true;
    }
  }

  // POST /api/knowledge/:id/publish — proposal + notice only, never touches agents.
  if (method === 'POST' && rest === '/publish') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    const skillId = typeof body['skillId'] === 'string' ? body['skillId'] : 'external-skill-registry';
    try {
      const { proposal, notice } = store.publishForPromotion(id, {
        actor,
        skillId,
        summary: typeof body['summary'] === 'string' ? body['summary'] : undefined,
      });
      ctx.audit.record(actor, 'KNOWLEDGE_PUBLISH_PROPOSED', 'knowledge', id, { skillId });
      return ctx.json(res, 200, { proposal, notice }), true;
    } catch (e) {
      return ctx.json(res, 422, { error: (e as Error).message }), true;
    }
  }

  return false;
}
