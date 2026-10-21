/**
 * Fixture target for mutation-testing flow tests.
 *
 * Deliberately small and pure. `isPositive` is only exercised with positive
 * inputs (weak test) so its boundary mutant survives; everything else is
 * strongly tested so its mutants are killed.
 */
export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

export function isPositive(n: number): boolean {
  return n > 0;
}

export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function both(a: boolean, b: boolean): boolean {
  return a && b;
}

export function label(ok: boolean): string {
  return ok ? 'yes' : 'no';
}

export function alwaysEnabled(): boolean {
  return true;
}

export function isEqual(a: number, b: number): boolean {
  return a === b;
}
