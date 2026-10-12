/**
 * Model Registry view — spec §90.
 *
 * The UI shows one row per model with the §90 columns:
 *   Provider · Model · Capability · Context · Reasoning · Cost · Latency ·
 *   Availability · Fallback
 *
 * The router itself (§30) uses this capability metadata rather than
 * hard-coded model names.
 */
import { MODEL_CATALOG } from './catalog';
import type { ContextSize, DataClass, ModelRef } from './types';

/** One §90 registry row. */
export interface ModelRegistryRow {
  provider: string;
  model: string;
  /** Capability tags, e.g. ['reasoning', 'vision', 'tools', 'streaming']. */
  capability: string[];
  context: ContextSize;
  reasoning: boolean;
  cost: 'low' | 'high';
  latency: 'low' | 'high';
  /** 'unknown' when the catalog entry carries no availability metadata. */
  availability: 'online' | 'degraded' | 'offline' | 'unknown';
  /** Fallback model reference, e.g. 'local:local-private'. */
  fallback: string | null;
  /**
   * §26.1 — data classes the model is cleared to see; null when the
   * catalog entry declares none (the router then applies the legacy
   * provider rule — the view must not invent a clearance).
   */
  dataClasses: DataClass[] | null;
  /** §26.1 — quota bucket the model draws from; null when undeclared. */
  quotaBucket: string | null;
  /** §26.1 — supported deployment hosts; empty when undeclared. */
  supportedHosts: string[];
}

export function toRegistryRow(m: ModelRef): ModelRegistryRow {
  const capability: string[] = [];
  if (m.capabilities.reasoning) capability.push('reasoning');
  if (m.capabilities.vision) capability.push('vision');
  if (m.capabilities.tools) capability.push('tools');
  if (m.capabilities.structuredOutput) capability.push('structured-output');
  if (m.capabilities.streaming) capability.push('streaming');
  if (m.capabilities.cancellation) capability.push('cancellation');
  if (m.capabilities.resume) capability.push('resume');
  return {
    provider: m.provider,
    model: m.model,
    capability,
    context: m.capabilities.maxContext,
    reasoning: m.capabilities.reasoning,
    cost: m.costTier,
    latency: m.latencyTier,
    availability: m.availability ?? 'unknown',
    fallback: m.fallback ?? null,
    dataClasses: m.capabilities.dataClasses ? [...m.capabilities.dataClasses] : null,
    quotaBucket: m.capabilities.quotaBucket ?? null,
    supportedHosts: m.capabilities.supportedHosts ? [...m.capabilities.supportedHosts] : [],
  };
}

/** Registry rows for a catalog (defaults to the seeded catalog). */
export function registryRows(
  catalog: readonly ModelRef[] = MODEL_CATALOG,
): ModelRegistryRow[] {
  return catalog.map(toRegistryRow);
}
