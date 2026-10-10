/**
 * The review entry point: run all 10 dimension checkers (spec §35) over the
 * input and aggregate the verdict.
 */
import {
  ALL_DIMENSIONS,
  Finding,
  ReviewInput,
  ReviewResult,
  ReviewSeverity,
  ReviewVerdict,
} from './types';
import {
  buildContext,
  DIMENSION_CHECKERS,
  DiffFile,
  parseUnifiedDiff,
} from './dimensions';

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  blocker: 3,
};

export function summarizeVerdict(findings: Finding[]): ReviewVerdict {
  let worst: ReviewSeverity = 'info';
  let hasFinding = false;
  for (const f of findings) {
    hasFinding = true;
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  if (!hasFinding) return 'PASS';
  switch (worst) {
    case 'blocker':
      return 'BLOCK';
    case 'error':
      return 'CHANGES_REQUESTED';
    case 'warning':
      return 'PASS_WITH_WARNINGS';
    default:
      return 'PASS';
  }
}

/**
 * Run the deterministic code review. Throws on malformed input.
 */
export function reviewCode(input: ReviewInput): ReviewResult {
  if (!input || !Array.isArray(input.files)) {
    throw new Error('ReviewInput.files must be an array of {path, before?, after?}');
  }
  for (const f of input.files) {
    if (!f || typeof f.path !== 'string' || f.path.length === 0) {
      throw new Error('Every review file must have a non-empty string path');
    }
  }

  const ctx = buildContext(input.files, input.diff, input.projectConventions);
  const parsed: DiffFile[] = input.diff ? parseUnifiedDiff(input.diff) : [];
  const diffByPath = new Map(parsed.map((d) => [d.path, d]));

  const findings: Finding[] = [];
  for (const dimension of ALL_DIMENSIONS) {
    const checker = DIMENSION_CHECKERS[dimension];
    for (const file of ctx.files) {
      findings.push(...checker(file, ctx, diffByPath.get(file.path) ?? null));
    }
  }

  // Deterministic ordering: severity desc, then dimension, file, line.
  findings.sort((a, b) => {
    const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (s !== 0) return s;
    const d = a.dimension.localeCompare(b.dimension);
    if (d !== 0) return d;
    const f = (a.file ?? '').localeCompare(b.file ?? '');
    if (f !== 0) return f;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const summary = {
    total: findings.length,
    blocker: findings.filter((f) => f.severity === 'blocker').length,
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    filesReviewed: ctx.files.length,
  };

  return {
    verdict: summarizeVerdict(findings),
    findings,
    dimensions: ALL_DIMENSIONS,
    summary,
    reviewedAt: new Date().toISOString(),
  };
}
