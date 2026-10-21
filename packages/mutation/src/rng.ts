/**
 * @ai-factory/mutation — seeded deterministic RNG (mulberry32).
 *
 * Pure, tiny, dependency-free. Used for mutant sampling so a fixed seed
 * reproduces the exact same sample across runs and machines.
 */

/** 32-bit mulberry PRNG. Seed should be a 32-bit integer. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash → unsigned int, for string seeds. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalize a seed (number or string) to a 32-bit unsigned integer. */
export function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'string') return hashSeed(seed);
  if (!Number.isFinite(seed)) return 0;
  return Math.trunc(seed) >>> 0;
}

/** Deterministic Fisher–Yates shuffle; returns a new array. */
export function shuffleSeeded<T>(items: readonly T[], seed: number | string): T[] {
  const out = [...items];
  const rand = mulberry32(normalizeSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
