/**
 * @ai-factory/knowledge — AI Knowledge Engine + AI Knowledge Scout (spec §44).
 *
 * Modules:
 *  - types      hierarchy scopes, lifecycle states, sources, items, errors    [§44]
 *  - sources    source priority (rankSource), credibility, verification
 *               thresholds — community sources need doubled verification [§44]
 *  - hierarchy  scope fallback queries: TASK → EMPLOYEE → PROJECT →
 *               ORGANIZATION → GLOBAL, most-specific first                   [§44]
 *  - lifecycle  lifecycle state machine with gates, timestamps + actors      [§44]
 *  - promotion  publish produces proposal/notice objects only; external
 *               approval + external applier before anything reaches agents    [§44]
 *  - scout      collect → normalize → compare → verify → evaluate → proposal;
 *               emits proposal CANDIDATES only (never mutates live objects),
 *               runs on an independent budget                                 [§44]
 *  - store      in-memory KnowledgeStore combining all of the above
 *  - feed       Update Feed cards: change/why-relevant/official-source/
 *               affected/risk/action/evaluation + Activate/Defer/Reject     [§44]
 *  - distribution license gate: external scripts without a license are
 *               refused from distribution                                    [§44]
 */
export * from './types';
export * from './sources';
export * from './hierarchy';
export * from './lifecycle';
export * from './promotion';
export * from './scout';
export * from './store';
export * from './feed';
export * from './distribution';
