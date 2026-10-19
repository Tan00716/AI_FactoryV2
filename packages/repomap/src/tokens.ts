/**
 * Token estimator for the repo map budget.
 *
 * chars/4 is a rough heuristic, not a real tokenizer — documented as
 * such. It only needs to be deterministic and monotonic, which it is.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
