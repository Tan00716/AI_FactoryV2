/**
 * @ai-factory/knowledge — AI Knowledge Engine + AI Knowledge Scout (spec §50–§53).
 *
 * Modules:
 *  - types      hierarchy scopes, lifecycle states, sources, items, errors    [§50, §51, §53]
 *  - sources    source priority, credibility, verification thresholds         [§51]
 *  - hierarchy  scope fallback queries: TASK → EMPLOYEE → PROJECT →
 *               ORGANIZATION → GLOBAL, most-specific first                   [§50]
 *  - lifecycle  lifecycle state machine with gates, timestamps + actors      [§53]
 *  - promotion  publish produces proposal/notice objects only; external
 *               approval + external applier before anything reaches agents    [§53]
 *  - scout      discover → collect → verify → normalize → compare → evaluate
 *               → store → skill_proposal → publish, injectable hooks,
 *               retry/skip with recorded log                                [§52]
 *  - store      in-memory KnowledgeStore combining all of the above
 *  - feed       Update Feed cards: why-relevant/evidence/affected/risk/action (§89)
 */
export * from './types';
export * from './sources';
export * from './hierarchy';
export * from './lifecycle';
export * from './promotion';
export * from './scout';
export * from './store';
export * from './feed';
