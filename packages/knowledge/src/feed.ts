/**
 * @ai-factory/knowledge — AI Engineering Update Feed (spec §44).
 *
 * Every FeedCard carries what §44 requires:
 *   - changeContent     the change itself
 *   - whyRelevant       why this update is relevant to this factory
 *   - officialSource    the official source backing the claim
 *   - affectedEmployees / affectedProjects  who/what it touches
 *   - risk              what could go wrong if ignored
 *   - recommendedAction concrete suggestion (e.g. bump a skill version)
 *   - evaluation        outcome of evaluating the claim
 *   - action            reader decision: Activate / Defer / Reject
 *
 * Source availability: a card whose source becomes unavailable is marked
 * `sourceAvailable: false` while KEEPING `lastVerifiedAt` (the last date the
 * source was verified) — old material must never pose as current [§44].
 *
 * Adoption is advisory only: recording a decision returns a NEW card object
 * and only records intent — it never modifies agents by itself. Feed
 * decisions Activate/Defer/Reject drive external workflows, not the feed.
 */

export type FeedCategory =
  | 'Models'
  | 'Agents'
  | 'Skills'
  | 'MCP'
  | 'Harness Engineering'
  | 'Loop Engineering'
  | 'Coding'
  | 'Testing'
  | 'Security'
  | 'DevOps'
  | 'Research';

/** All §88 Knowledge Center categories. */
export const FEED_CATEGORIES: FeedCategory[] = [
  'Models', 'Agents', 'Skills', 'MCP', 'Harness Engineering', 'Loop Engineering',
  'Coding', 'Testing', 'Security', 'DevOps', 'Research',
];

/** Reader decision on a feed card. */
export type FeedAction = 'Activate' | 'Defer' | 'Reject';

export const FEED_ACTIONS: readonly FeedAction[] = ['Activate', 'Defer', 'Reject'];

export interface FeedCard {
  id: string;
  category: FeedCategory;
  kind: 'NEW' | 'UPDATED' | 'VERIFIED' | 'DEPRECATED';
  title: string;
  /** The change itself (§44: 变更内容). */
  changeContent: string;
  /** Why this update is relevant to this factory (§44: 为何相关). */
  whyRelevant: string;
  /** Official source backing the claim (§44: 官方来源). */
  officialSource: string;
  /** Supporting evidence links/refs. */
  evidence: string[];
  /** Employees whose skills/workflows touch the topic (§44: 影响员工). */
  affectedEmployees: string[];
  /** Projects affected (§44: 影响项目). */
  affectedProjects: string[];
  /** What could go wrong if ignored (§44: 风险). */
  risk: string;
  /** Concrete suggestion (§44: 建议). */
  recommendedAction: string;
  /** Outcome of evaluating the claim (§44: 评测). */
  evaluation?: string;
  /** Reader decision: Activate / Defer / Reject. */
  action?: FeedAction;
  actionAt?: number;
  actionBy?: string;
  /** False when the source became unavailable; lastVerifiedAt is kept [§44]. */
  sourceAvailable: boolean;
  /** Last date the source was verified (ms epoch); kept even when unavailable. */
  lastVerifiedAt: number;
  publishedAt: string;
}

export interface FeedDecisionOptions {
  by: string;
  /** Defaults to wall time; inject a fake clock in tests/demos. */
  now?: () => number;
}

/**
 * Record an Activate/Defer/Reject decision on a feed card.
 * PURE: returns a new card object; the input is not mutated and no agent
 * state is touched. Adopting a card only records intent — activation is an
 * external, separately-governed step.
 */
export function recordFeedDecision(
  card: FeedCard,
  action: FeedAction,
  opts: FeedDecisionOptions,
): FeedCard {
  return {
    ...card,
    action,
    actionAt: (opts.now ?? Date.now)(),
    actionBy: opts.by,
  };
}

/**
 * Mark a card's source as unavailable. Keeps `lastVerifiedAt` — the last
 * date the source was verified — so stale material cannot pose as current.
 * PURE: returns a new card object.
 */
export function markSourceUnavailable(card: FeedCard): FeedCard {
  return { ...card, sourceAvailable: false };
}

/**
 * Mark a card's source as available again and refresh the verified date.
 * PURE: returns a new card object.
 */
export function refreshSource(
  card: FeedCard,
  opts: { now?: () => number } = {},
): FeedCard {
  return {
    ...card,
    sourceAvailable: true,
    lastVerifiedAt: (opts.now ?? Date.now)(),
  };
}

/**
 * Built-in sample cards (used when the feed store is empty).
 * Prototype data — in a real deployment these come from the scout pipeline.
 */
export function sampleFeedCards(): FeedCard[] {
  return [
    {
      id: 'feed-openai-codex',
      category: 'Models',
      kind: 'NEW',
      title: 'OpenAI: new Codex capability',
      changeContent:
        'Codex-class models now accept larger diffs per turn (up to 4x the previous per-turn diff budget).',
      whyRelevant:
        'Our Code Review and Loop Engineering agents routinely split diffs that would now fit in a single turn.',
      officialSource: 'OpenAI Codex release notes 2026-09',
      evidence: ['OpenAI release notes 2026-09', 'internal eval: diff-completion benchmark run #418'],
      affectedEmployees: ['Code Reviewer', 'Loop Orchestrator'],
      affectedProjects: ['ai-factory'],
      risk: 'MEDIUM — stale chunking heuristics waste context and turns without failing loudly.',
      recommendedAction: 'Re-run the diff-size evaluation on the review pipeline and widen the per-turn chunk budget if it passes.',
      evaluation: 'Benchmark uplift +18% on large-diff completion; no regression on small diffs.',
      sourceAvailable: true,
      lastVerifiedAt: Date.parse('2026-09-30T10:00:00Z'),
      publishedAt: '2026-09-30T10:00:00Z',
    },
    {
      id: 'feed-mcp-spec',
      category: 'MCP',
      kind: 'UPDATED',
      title: 'MCP: 2026-07-28 specification update',
      changeContent:
        'Capability negotiation in the MCP spec changed the handshake; servers announcing the old handshake may be dropped after the next client upgrade.',
      whyRelevant:
        'The MCP spec update changes capability negotiation; servers announcing the old handshake may be dropped after the next client upgrade.',
      officialSource: 'MCP specification changelog 2026-07-28',
      evidence: ['MCP specification changelog 2026-07-28', 'mcp package conformance suite'],
      affectedEmployees: ['MCP Gateway', 'Tool Integrator'],
      affectedProjects: ['ai-factory'],
      risk: 'HIGH — tools behind outdated MCP servers could silently disappear from agent tool lists.',
      recommendedAction: 'Run the MCP conformance suite against all registered servers and flag non-compliant ones.',
      evaluation: '3 of 12 registered servers fail the new handshake in dry-run.',
      sourceAvailable: true,
      lastVerifiedAt: Date.parse('2026-08-02T09:00:00Z'),
      publishedAt: '2026-08-02T09:00:00Z',
    },
    {
      id: 'feed-agent-pattern',
      category: 'Agents',
      kind: 'NEW',
      title: 'Agent Engineering: new long-running agent pattern',
      changeContent:
        'A checkpoint-and-resume pattern for long-running agents was published; it reduces lost work on preemption.',
      whyRelevant:
        'Our workforce agents currently restart from scratch on preemption; the pattern is directly applicable.',
      officialSource: 'Agent Engineering research digest #22 (official research publication)',
      evidence: ['Agent Engineering research digest #22'],
      affectedEmployees: ['Backend Engineer', 'Workforce Scheduler'],
      affectedProjects: ['ai-factory'],
      risk: 'LOW — the pattern is opt-in; ignoring it only forfeits resilience gains.',
      recommendedAction: 'Prototype checkpointing in one long-running worker before rolling it out.',
      sourceAvailable: false,
      lastVerifiedAt: Date.parse('2026-08-20T14:00:00Z'),
      publishedAt: '2026-08-20T14:00:00Z',
    },
  ];
}
