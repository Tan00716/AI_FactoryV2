/**
 * File conflict handling — spec §62.
 *
 * Pipeline: detect overlap → warn → coordinate → serialize or merge → run tests.
 *
 * Overlap means either the same file path or a directory-prefix overlap
 * (e.g. agent A edits `src/payment/` while agent B edits
 * `src/payment/service.ts`) — prefix edits can silently change what the
 * other agent's files resolve to, so they must be coordinated too.
 *
 * Rule: never silently overwrite another active agent's work. Merging
 * overlapping changes is gated on a test hook (mergeCheck).
 */

export type OverlapKind = 'same-file' | 'dir-prefix';

export interface OverlapMatch {
  pathA: string;
  pathB: string;
  kind: OverlapKind;
  /** The shared path (the file itself, or the directory side of a prefix overlap). */
  sharedPath: string;
}

export interface OverlapReport {
  overlaps: OverlapMatch[];
  filesA: string[];
  filesB: string[];
  hasOverlap: boolean;
}

export interface DetectOptions {
  /** Compare case-insensitively (Windows-style paths). Default: false. */
  caseInsensitive?: boolean;
}

/** Normalize a path for comparison: backslashes → /, strip ./ and trailing /. */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  out = out.replace(/\/{2,}/g, '/');
  if (out.startsWith('./')) out = out.slice(2);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function keyOf(p: string, opts: DetectOptions): string {
  const n = normalizePath(p);
  return opts.caseInsensitive ? n.toLowerCase() : n;
}

/**
 * Detect file-set overlap between two agents' change sets, including
 * directory-prefix overlap. Inputs are raw path lists (duplicates are
 * de-duplicated after normalization).
 */
export function detectOverlap(
  agentAFiles: string[],
  agentBFiles: string[],
  opts: DetectOptions = {},
): OverlapReport {
  const filesA = [...new Set(agentAFiles.map(normalizePath))];
  const filesB = [...new Set(agentBFiles.map(normalizePath))];
  const overlaps: OverlapMatch[] = [];
  const seen = new Set<string>();

  for (const a of filesA) {
    for (const b of filesB) {
      const ka = keyOf(a, opts);
      const kb = keyOf(b, opts);
      let match: OverlapMatch | null = null;
      if (ka === kb) {
        match = { pathA: a, pathB: b, kind: 'same-file', sharedPath: a };
      } else if (kb.startsWith(ka + '/')) {
        match = { pathA: a, pathB: b, kind: 'dir-prefix', sharedPath: a };
      } else if (ka.startsWith(kb + '/')) {
        match = { pathA: a, pathB: b, kind: 'dir-prefix', sharedPath: b };
      }
      if (match) {
        const sig = `${match.kind}|${match.pathA}|${match.pathB}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          overlaps.push(match);
        }
      }
    }
  }

  overlaps.sort((x, y) => x.pathA.localeCompare(y.pathA) || x.pathB.localeCompare(y.pathB));
  return { overlaps, filesA, filesB, hasOverlap: overlaps.length > 0 };
}

export type ResolutionStrategy = 'warn' | 'serialize' | 'partition' | 'merge_test';

export type PlanDecision = 'none' | 'serialize' | 'partition' | 'merge_then_test';

export interface CoordinationPlan {
  decision: PlanDecision;
  /** Human-readable warnings (the §62 "warn" step). */
  warnings: string[];
  /** Ordered coordination steps to execute. */
  steps: string[];
  /** Overlapped paths this plan governs. */
  blockedFiles: string[];
}

/**
 * Turn an overlap report into a coordination plan.
 *
 * - 'warn' (default): reports the overlap and picks a safe decision —
 *   'serialize' when the same file is touched, 'partition' when the
 *   overlap is only a directory prefix.
 * - 'serialize' / 'partition' / 'merge_test': force that decision.
 * - 'merge_then_test' requires a later mergeCheck(testHook) pass (§62
 *   "serialize or merge → run tests"); mergeCheck refuses to release
 *   overlapped files until the test hook succeeds.
 */
export function resolveOverlap(
  report: OverlapReport,
  strategy: ResolutionStrategy = 'warn',
): CoordinationPlan {
  const blockedFiles = [
    ...new Set(report.overlaps.map((o) => o.sharedPath)),
  ].sort();

  if (!report.hasOverlap) {
    return { decision: 'none', warnings: [], steps: [], blockedFiles: [] };
  }

  const sameFile = report.overlaps.filter((o) => o.kind === 'same-file');
  const prefix = report.overlaps.filter((o) => o.kind === 'dir-prefix');

  const warnings = [
    `Overlap detected between agents: ${blockedFiles.length} shared path(s). Never silently overwrite another agent's work.`,
    ...sameFile.map(
      (o) => `SAME FILE: agent A "${o.pathA}" vs agent B "${o.pathB}".`,
    ),
    ...prefix.map(
      (o) => `DIRECTORY PREFIX: "${o.sharedPath}" — one agent edits a file inside a tree the other agent modifies.`,
    ),
  ];

  let decision: PlanDecision;
  if (strategy === 'warn') {
    decision = sameFile.length > 0 ? 'serialize' : 'partition';
  } else {
    decision = strategy === 'merge_test' ? 'merge_then_test' : strategy;
  }

  const steps: string[] = [];
  if (decision === 'serialize') {
    steps.push(
      '1. Pause agent B\'s overlapping edits (hold the overlapping paths).',
      '2. Let agent A finish its edits on the shared file(s).',
      '3. Rebase: agent B replays its edits on top of A\'s result.',
      '4. Run the test suite; only release the files when tests pass.',
    );
  } else if (decision === 'partition') {
    steps.push(
      '1. Partition the tree: assign disjoint file groups to each agent.',
      '2. Agents work only inside their assigned group; cross-group edits are blocked.',
      '3. Re-run detectOverlap before integration; serialize anything new.',
      '4. Run the test suite after both agents finish.',
    );
  } else {
    steps.push(
      '1. Merge both agents\' changes with an explicit three-way merge.',
      '2. Flag every overlapped file for review (no silent overwrite).',
      '3. Run the full test suite — mergeCheck must pass before release.',
    );
  }

  return { decision, warnings, steps, blockedFiles };
}

export type TestHook = () => boolean;

export interface MergeVerdict {
  allowed: boolean;
  blockedFiles: string[];
  reason: string;
}

/**
 * Gate for releasing overlapped files after a merge (§62 "→ run tests").
 * Never returns allowed=true for overlapped files without a test hook —
 * that would be a silent overwrite.
 */
export function mergeCheck(report: OverlapReport, testHook?: TestHook): MergeVerdict {
  const blockedFiles = [
    ...new Set(report.overlaps.map((o) => o.sharedPath)),
  ].sort();

  if (!report.hasOverlap) {
    return { allowed: true, blockedFiles: [], reason: 'No overlap — nothing to gate.' };
  }
  if (!testHook) {
    return {
      allowed: false,
      blockedFiles,
      reason: 'Overlapped files require a test hook before merge — refusing to release without tests.',
    };
  }
  const passed = testHook();
  return passed
    ? {
        allowed: true,
        blockedFiles: [],
        reason: 'Test hook passed — overlapped files released.',
      }
    : {
        allowed: false,
        blockedFiles,
        reason: 'Test hook failed — overlapped files stay blocked.',
      };
}
