/**
 * @ai-factory/knowledge — source priority + credibility (spec §51).
 *
 * Priority (high → low):
 *   official_spec > official_docs > official_release > primary_article
 *   > research > community
 *
 * Source credibility feeds the verification threshold: the less credible
 * the source, the more independent verifications a knowledge item needs
 * before it may leave the UNVERIFIED state.
 */
import type { SourceType } from './types';
import { SOURCE_PRIORITY } from './types';

/** Credibility score per source type, in [0, 1]. Higher = more trusted. */
export const SOURCE_CREDIBILITY: Record<SourceType, number> = {
  official_spec: 1.0,
  official_docs: 0.9,
  official_release: 0.8,
  primary_article: 0.6,
  research: 0.5,
  community: 0.3,
};

/** Priority rank: 0 = highest priority. */
export function sourceRank(type: SourceType): number {
  return SOURCE_PRIORITY.indexOf(type);
}

/**
 * Compare two source types by priority.
 * Returns negative when `a` outranks `b`, positive when `b` outranks `a`.
 */
export function compareSources(a: SourceType, b: SourceType): number {
  return sourceRank(a) - sourceRank(b);
}

/** True when `a` has strictly higher priority than `b`. */
export function outranks(a: SourceType, b: SourceType): boolean {
  return compareSources(a, b) < 0;
}

/**
 * Number of independent verifications required before an item from this
 * source may transition UNVERIFIED → VALIDATED [§51, §53].
 *
 * Low-credibility sources face a higher bar:
 *   official_spec (1.0)  → 1
 *   official_docs (0.9)  → 1
 *   official_release (0.8)→ 2
 *   primary_article (0.6)→ 3
 *   research (0.5)       → 3
 *   community (0.3)      → 4
 */
export function verificationThreshold(type: SourceType): number {
  const credibility = SOURCE_CREDIBILITY[type];
  return 1 + Math.round((1 - credibility) * 4);
}
