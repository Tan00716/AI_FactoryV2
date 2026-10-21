/**
 * @ai-factory/mutation — deterministic mutant sampling.
 *
 * Full mutation is infeasible (thousands of tests × hundreds of mutants);
 * sampling with a fixed seed keeps runs cheap AND reproducible.
 */
import type { Mutant, SamplingConfig } from './types';
import { hashSeed, shuffleSeeded } from './rng';

export const DEFAULT_SEED = 20261021;
export const DEFAULT_MAX_MUTANTS = 50;
export const DEFAULT_PER_FILE_CAP = 10;

export const DEFAULT_SAMPLING: SamplingConfig = {
  seed: DEFAULT_SEED,
  maxMutants: DEFAULT_MAX_MUTANTS,
  perFileCap: DEFAULT_PER_FILE_CAP,
};

export function validateSamplingConfig(input: unknown): { config: SamplingConfig; errors: string[] } {
  const errors: string[] = [];
  const config: SamplingConfig = { ...DEFAULT_SAMPLING };
  if (input === undefined || input === null) return { config, errors };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { config, errors: ['sampling config must be an object'] };
  }
  const raw = input as Record<string, unknown>;
  if (raw.seed !== undefined) {
    if (typeof raw.seed === 'number' && Number.isFinite(raw.seed)) config.seed = Math.trunc(raw.seed);
    else if (typeof raw.seed === 'string' && raw.seed.length > 0 && raw.seed.length <= 128) {
      config.seed = hashSeed(raw.seed);
    } else errors.push('seed must be a finite number or a non-empty string (max 128 chars)');
  }
  for (const key of ['maxMutants', 'perFileCap'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10_000) {
      errors.push(`${key} must be an integer 1..10000`);
    } else {
      config[key] = v;
    }
  }
  return { config, errors };
}

/**
 * Deterministic sample: sort mutants into a canonical order, seeded-shuffle,
 * then take up to maxMutants while respecting the per-file cap.
 * Same input + same seed ⇒ same output, always.
 */
export function sampleMutants(mutants: readonly Mutant[], config: SamplingConfig): Mutant[] {
  const ordered = [...mutants].sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.line !== b.line
        ? a.line - b.line
        : a.column !== b.column
          ? a.column - b.column
          : a.operator < b.operator
            ? -1
            : a.operator > b.operator
              ? 1
              : 0,
  );
  const shuffled = shuffleSeeded(ordered, config.seed);
  const perFile = new Map<string, number>();
  const out: Mutant[] = [];
  for (const m of shuffled) {
    if (out.length >= config.maxMutants) break;
    const used = perFile.get(m.file) ?? 0;
    if (used >= config.perFileCap) continue;
    perFile.set(m.file, used + 1);
    out.push(m);
  }
  return out;
}
