/**
 * @ai-factory/debugger — breakpoint classification + validation (round-7 R7-#7).
 *
 * Pure functions, no FS access. Shared by the server route (fail-closed
 * validation before anything reaches an adapter) and the desktop panel
 * (kind labels). Semantics mirror the Node adapter's CDP mapping
 * (node-adapter.ts): a logMessage wins over a condition — a breakpoint
 * with both is a logpoint, not a conditional breakpoint.
 *
 * Condition evaluation contract (honest boundary):
 *   - Syntax is validated here (parse-only via `new Function`, never
 *     executed): a syntactically invalid condition is a 400, not a
 *     session failure.
 *   - Runtime evaluation happens in the target (V8 for Node). An
 *     evaluation error at hit time (e.g. ReferenceError for a name that
 *     does not exist in that scope) does NOT break the session: the
 *     breakpoint simply does not pause and the target keeps running.
 *     The route documents this; the smoke test proves it end to end.
 */
import type { DapSourceBreakpoint } from './types';

export type BreakpointKind = 'plain' | 'conditional' | 'logpoint';

export const MAX_CONDITION_CHARS = 2000;
export const MAX_LOG_MESSAGE_CHARS = 2000;

export interface BreakpointInput {
  file?: unknown;
  line?: unknown;
  column?: unknown;
  condition?: unknown;
  logMessage?: unknown;
}

/** Logpoint wins over conditional (matches the Node adapter's mapping). */
export function classifyBreakpoint(bp: {
  condition?: string;
  logMessage?: string;
}): BreakpointKind {
  if (typeof bp.logMessage === 'string' && bp.logMessage.length > 0) return 'logpoint';
  if (typeof bp.condition === 'string' && bp.condition.length > 0) return 'conditional';
  return 'plain';
}

/**
 * Parse-check a condition expression WITHOUT executing it. Returns null
 * when syntactically valid, else a human-readable error. `new Function`
 * compiles but does not run the body, so target-scope names are fine.
 */
export function validateConditionSyntax(condition: string): string | null {
  if (condition.includes('\0')) return 'condition must not contain NUL characters';
  try {
    // Wrap in parens so object literals / assignments parse as expressions.
    new Function(`return (${condition});`);
    return null;
  } catch (e) {
    return `invalid condition syntax: ${(e as Error).message}`;
  }
}

/** Full breakpoint validation; returns a list of error strings (empty = ok). */
export function validateBreakpoint(bp: BreakpointInput): string[] {
  const errors: string[] = [];
  if (typeof bp.file !== 'string' || !bp.file.trim() || bp.file.length > 1024) {
    errors.push('file is required (max 1024 chars)');
  }
  if (typeof bp.line !== 'number' || !Number.isFinite(bp.line) || Math.floor(bp.line) < 1) {
    errors.push('line must be an integer >= 1');
  }
  if (bp.column !== undefined && (typeof bp.column !== 'number' || !Number.isFinite(bp.column) || Math.floor(bp.column) < 1)) {
    errors.push('column must be an integer >= 1 when present');
  }
  if (bp.condition !== undefined && typeof bp.condition !== 'string') {
    errors.push('condition must be a string when present');
  } else if (typeof bp.condition === 'string') {
    if (bp.condition.length > MAX_CONDITION_CHARS) {
      errors.push(`condition exceeds ${MAX_CONDITION_CHARS} chars`);
    } else if (bp.condition.length > 0) {
      const err = validateConditionSyntax(bp.condition);
      if (err) errors.push(err);
    }
  }
  if (bp.logMessage !== undefined && typeof bp.logMessage !== 'string') {
    errors.push('logMessage must be a string when present');
  } else if (typeof bp.logMessage === 'string') {
    if (bp.logMessage.length > MAX_LOG_MESSAGE_CHARS) {
      errors.push(`logMessage exceeds ${MAX_LOG_MESSAGE_CHARS} chars`);
    } else if (bp.logMessage.includes('\0')) {
      errors.push('logMessage must not contain NUL characters');
    }
  }
  return errors;
}

export interface BreakpointSummary {
  total: number;
  plain: number;
  conditional: number;
  logpoint: number;
}

export function summarizeBreakpoints(
  bps: Array<{ condition?: string; logMessage?: string }>,
): BreakpointSummary {
  const out: BreakpointSummary = { total: bps.length, plain: 0, conditional: 0, logpoint: 0 };
  for (const bp of bps) out[classifyBreakpoint(bp)] += 1;
  return out;
}

/** Narrow a DAP source breakpoint to its kind (for route responses). */
export function kindOf(bp: DapSourceBreakpoint): BreakpointKind {
  return classifyBreakpoint(bp);
}
