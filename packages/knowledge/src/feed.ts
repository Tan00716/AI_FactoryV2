/**
 * @ai-factory/knowledge — Update Feed cards (spec §89 AI Engineering Update Feed).
 *
 * Each FeedCard explains why a piece of new knowledge matters:
 *   - whyRelevant   why this update is relevant to this factory
 *   - evidence      links/sources backing the claim
 *   - affectedAgents agents whose skills/workflows touch the topic
 *   - risk          what could go wrong if ignored
 *   - recommendedAction concrete suggestion (e.g. bump a skill version)
 *   - evaluationResult optional outcome of evaluating the claim
 *
 * Adoption is advisory only: the UI's "adopt" button only records an audit
 * entry — it never modifies agents by itself (§53 policy carried over).
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

export interface FeedCard {
  id: string;
  category: FeedCategory;
  kind: 'NEW' | 'UPDATED' | 'VERIFIED' | 'DEPRECATED';
  title: string;
  whyRelevant: string;
  evidence: string[];
  affectedAgents: string[];
  risk: string;
  recommendedAction: string;
  evaluationResult?: string;
  publishedAt: string;
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
      whyRelevant:
        'Codex-class models now accept larger diffs per turn; our Code Review and Loop Engineering agents routinely split diffs that would now fit in a single turn.',
      evidence: ['OpenAI release notes 2026-09', 'internal eval: diff-completion benchmark run #418'],
      affectedAgents: ['Code Reviewer', 'Loop Orchestrator'],
      risk: 'MEDIUM — stale chunking heuristics waste context and turns without failing loudly.',
      recommendedAction: 'Re-run the diff-size evaluation on the review pipeline and widen the per-turn chunk budget if it passes.',
      evaluationResult: 'Benchmark uplift +18% on large-diff completion; no regression on small diffs.',
      publishedAt: '2026-09-30T10:00:00Z',
    },
    {
      id: 'feed-mcp-spec',
      category: 'MCP',
      kind: 'UPDATED',
      title: 'MCP: 2026-07-28 specification update',
      whyRelevant:
        'The MCP spec update changes capability negotiation; servers announcing the old handshake may be dropped after the next client upgrade.',
      evidence: ['MCP specification changelog 2026-07-28', 'mcp package conformance suite'],
      affectedAgents: ['MCP Gateway', 'Tool Integrator'],
      risk: 'HIGH — tools behind outdated MCP servers could silently disappear from agent tool lists.',
      recommendedAction: 'Run the MCP conformance suite against all registered servers and flag non-compliant ones.',
      evaluationResult: '3 of 12 registered servers fail the new handshake in dry-run.',
      publishedAt: '2026-08-02T09:00:00Z',
    },
    {
      id: 'feed-agent-pattern',
      category: 'Agents',
      kind: 'NEW',
      title: 'Agent Engineering: new long-running agent pattern',
      whyRelevant:
        'A checkpoint-and-resume pattern for long-running agents reduces lost work on preemption; our workforce agents currently restart from scratch.',
      evidence: ['Agent Engineering research digest #22'],
      affectedAgents: ['Backend Engineer', 'Workforce Scheduler'],
      risk: 'LOW — the pattern is opt-in; ignoring it only forfeits resilience gains.',
      recommendedAction: 'Prototype checkpointing in one long-running worker before rolling it out.',
      publishedAt: '2026-08-20T14:00:00Z',
    },
    {
      id: 'feed-debug-skill',
      category: 'Skills',
      kind: 'NEW',
      title: 'Skill: new debugging methodology',
      whyRelevant:
        'A hypothesis-driven debugging methodology (bisect → reproduce → minimal fix) scores higher on fault-localization benchmarks than our current retry-until-green skill.',
      evidence: ['debugging benchmark: fault-localization split', 'community skill review thread'],
      affectedAgents: ['Backend Engineer', 'QA Engineer'],
      risk: 'MEDIUM — engineers on the old skill keep burning turns on blind retries.',
      recommendedAction: '建议把 Backend Engineer 的 debugging skill 从 v1.2 → v1.3',
      evaluationResult: 'Pilot on 40 tasks: -31% mean time-to-fix vs v1.2.',
      publishedAt: '2026-09-15T11:30:00Z',
    },
    {
      id: 'feed-dep-scanner',
      category: 'Security',
      kind: 'VERIFIED',
      title: 'Dependency scanner rule pack v3 verified',
      whyRelevant:
        'The new rule pack catches transitive typosquatting that our current pack misses; verified against the security evaluation suite.',
      evidence: ['security evaluation suite run #77', 'rule pack changelog v2→v3'],
      affectedAgents: ['Security Auditor', 'CI Pipeline'],
      risk: 'HIGH — unverified packs previously produced false negatives on supply-chain attacks.',
      recommendedAction: 'Promote the v3 rule pack to the CI security gate after the scheduled evaluation window.',
      evaluationResult: 'Recall 0.97 on the typosquat corpus, +0.11 over v2, false-positive rate unchanged.',
      publishedAt: '2026-09-25T08:00:00Z',
    },
  ];
}
