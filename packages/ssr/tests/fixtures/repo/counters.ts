// Contrast fixture: two functions, each with a LOCAL variable named `count`.
// A text search for `count` hits both functions (6 code occurrences);
// a structural rename of the variable scoped to `alpha` must touch only 3.
export function alpha(): number {
  let count = 0;
  count += 1;
  return count;
}

export function beta(): number {
  let count = 100;
  return count - 1;
}

// A property access that must NOT be renamed by the structural rename.
export function gamma(obj: { count: number }): number {
  return obj.count + 1;
}
