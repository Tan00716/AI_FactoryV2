/**
 * Seeded generic model catalog — spec §30.
 *
 * The catalog is deliberately provider-independent: entries describe
 * capability/cost/latency tiers, not vendor SKUs. `provider: 'local'` marks
 * models that draw nothing from the shared ChatGPT plan pool (spec §29).
 */
import type { ModelRef } from './types';

/** The generic seed catalog. Keep provider-independent; extend at runtime. */
export const MODEL_CATALOG: readonly ModelRef[] = [
  {
    provider: 'shared',
    model: 'fast-classifier',
    capabilities: { reasoning: false, vision: false, tools: true, maxContext: 'small' },
    costTier: 'low',
    latencyTier: 'low',
    availability: 'online',
    fallback: 'local:local-private',
  },
  {
    provider: 'shared',
    model: 'code-coder',
    capabilities: { reasoning: true, vision: false, tools: true, maxContext: 'large' },
    costTier: 'high',
    latencyTier: 'low',
    availability: 'online',
    fallback: 'shared:fast-classifier',
  },
  {
    provider: 'shared',
    model: 'reasoning-architect',
    capabilities: { reasoning: true, vision: false, tools: true, maxContext: 'large' },
    costTier: 'high',
    latencyTier: 'high',
    availability: 'degraded',
    fallback: 'shared:code-coder',
  },
  {
    provider: 'shared',
    model: 'vision-capable',
    capabilities: { reasoning: true, vision: true, tools: true, maxContext: 'medium' },
    costTier: 'high',
    latencyTier: 'low',
    availability: 'online',
    fallback: 'shared:code-coder',
  },
  {
    provider: 'local',
    model: 'local-private',
    capabilities: { reasoning: false, vision: false, tools: true, maxContext: 'medium' },
    costTier: 'low',
    latencyTier: 'low',
    availability: 'online',
    fallback: 'shared:fast-classifier',
  },
];

/** §29 — at/over this shared-pool usage the router treats the pool as exhausted. */
export const POOL_EXHAUSTED_PCT = 100;

/** Ordering helper: small < medium < large. */
export const CONTEXT_RANK: Record<'small' | 'medium' | 'large', number> = {
  small: 0,
  medium: 1,
  large: 2,
};
