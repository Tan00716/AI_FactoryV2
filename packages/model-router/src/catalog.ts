/**
 * Seeded generic model catalog — spec §30.
 *
 * The catalog is deliberately provider-independent: entries describe
 * capability/cost/latency tiers, not vendor SKUs. `provider: 'local'` marks
 * models that draw nothing from the shared ChatGPT plan pool (spec §29).
 *
 * HONESTY NOTE (§26.1 metadata): every capability value in this seed
 * catalog — including the Batch 8 additions (structuredOutput, streaming,
 * cancellation, resume, dataClasses, quotaBucket, supportedHosts) — is a
 * DECLARED value for a generic tier, NOT a measured or verified property
 * of a real provider model. Nothing here has been validated against a
 * live provider; runtime registration is expected to overwrite entries
 * with discovered metadata (§26.2 discoverCapabilities) before any
 * production reliance.
 */
import type { ModelRef } from './types';

/** The generic seed catalog. Keep provider-independent; extend at runtime. */
export const MODEL_CATALOG: readonly ModelRef[] = [
  {
    provider: 'shared',
    model: 'fast-classifier',
    capabilities: {
      reasoning: false,
      vision: false,
      tools: true,
      maxContext: 'small',
      structuredOutput: true,
      streaming: false,
      cancellation: true,
      resume: false,
      dataClasses: ['public', 'internal'],
      quotaBucket: 'shared-plan-5h',
      supportedHosts: ['shared-pool'],
    },
    costTier: 'low',
    latencyTier: 'low',
    availability: 'online',
    fallback: 'local:local-private',
  },
  {
    provider: 'shared',
    model: 'code-coder',
    capabilities: {
      reasoning: true,
      vision: false,
      tools: true,
      maxContext: 'large',
      structuredOutput: true,
      streaming: true,
      cancellation: true,
      resume: true,
      dataClasses: ['public', 'internal'],
      quotaBucket: 'shared-plan-5h',
      supportedHosts: ['shared-pool'],
    },
    costTier: 'high',
    latencyTier: 'low',
    availability: 'online',
    fallback: 'shared:fast-classifier',
  },
  {
    provider: 'shared',
    model: 'reasoning-architect',
    capabilities: {
      reasoning: true,
      vision: false,
      tools: true,
      maxContext: 'large',
      structuredOutput: true,
      streaming: true,
      cancellation: true,
      resume: true,
      dataClasses: ['public', 'internal'],
      quotaBucket: 'shared-plan-5h',
      supportedHosts: ['shared-pool'],
    },
    costTier: 'high',
    latencyTier: 'high',
    availability: 'degraded',
    fallback: 'shared:code-coder',
  },
  {
    provider: 'shared',
    model: 'vision-capable',
    capabilities: {
      reasoning: true,
      vision: true,
      tools: true,
      maxContext: 'medium',
      structuredOutput: false,
      streaming: true,
      cancellation: true,
      resume: false,
      dataClasses: ['public', 'internal'],
      quotaBucket: 'shared-plan-5h',
      supportedHosts: ['shared-pool'],
    },
    costTier: 'high',
    latencyTier: 'low',
    availability: 'online',
    fallback: 'shared:code-coder',
  },
  {
    provider: 'local',
    model: 'local-private',
    capabilities: {
      reasoning: false,
      vision: false,
      tools: true,
      maxContext: 'medium',
      structuredOutput: false,
      streaming: false,
      cancellation: true,
      resume: false,
      dataClasses: ['public', 'internal', 'sensitive'],
      quotaBucket: 'local',
      supportedHosts: ['local'],
    },
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
