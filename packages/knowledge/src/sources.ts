/**
 * @ai-factory/knowledge — source priority + credibility (spec §44).
 *
 * Priority (high → low):
 *   official_spec/docs/changelog > source repo / primary article
 *   > research > trusted engineering publications > community
 *
 * Source credibility feeds the verification threshold: the less credible
 * the source, the more independent verifications a knowledge item needs
 * before it may leave the UNVERIFIED state. Community sources face a
 * deliberately doubled threshold (§44: 社区资料需更强验证).
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

/**
 * Numeric priority score for a source type, 0–100 (higher = more trusted).
 * Reflects the §44 priority order:
 *   official_spec (100) > official_docs (90) > official_release (80)
 *   > primary_article (60) > research (50) > community (20).
 */
export const SOURCE_SCORES: Record<SourceType, number> = {
  official_spec: 100,
  official_docs: 90,
  official_release: 80,
  primary_article: 60,
  research: 50,
  community: 20,
};

/**
 * Rank a source type by its §44 priority score. Higher score = higher
 * priority when sources disagree or when picking what to trust.
 */
export function rankSource(type: SourceType): number {
  return SOURCE_SCORES[type];
}

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
 * source may transition UNVERIFIED → VALIDATED [§44, §53].
 *
 * Community sources require DOUBLED verification (§44: 社区资料需更强验证):
 *   official_spec (1.0)  → 1
 *   official_docs (0.9)  → 1
 *   official_release (0.8)→ 2
 *   primary_article (0.6)→ 3
 *   research (0.5)       → 3
 *   community (0.3)      → 8  (base 4, doubled)
 */
export function verificationThreshold(type: SourceType): number {
  const credibility = SOURCE_CREDIBILITY[type];
  const base = 1 + Math.round((1 - credibility) * 4);
  // §44: community sources need strictly stronger verification.
  return type === 'community' ? base * 2 : base;
}
