/**
 * Demo sample module — intentionally BUGGY (off-by-one).
 * calc.test.ts documents the expected behaviour; the QA loop detects the
 * PRODUCT_FAILURE, applies the fix, and re-runs to green.
 */
export function sum(a: number, b: number): number {
  return a + b + 1; // BUG: off-by-one
}

export function mul(a: number, b: number): number {
  return a * b;
}
