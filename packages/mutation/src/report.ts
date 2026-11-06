/**
 * @ai-factory/mutation — report aggregation and rendering.
 */
import type { Mutant, MutantRunResult, MutationReport, MutationTotals, SamplingConfig } from './types';

/** killed / (killed + survived); null when no decisive verdicts. */
export function mutationScore(t: Pick<MutationTotals, 'killed' | 'survived'>): number | null {
  const decisive = t.killed + t.survived;
  if (decisive === 0) return null;
  return t.killed / decisive;
}

export function summarize(
  results: readonly MutantRunResult[],
  generated: number,
  sampled: number,
): MutationTotals {
  const t: MutationTotals = {
    generated,
    sampled,
    killed: 0,
    survived: 0,
    timeout: 0,
    invalid: 0,
    score: null,
  };
  for (const r of results) {
    if (r.verdict === 'killed') t.killed++;
    else if (r.verdict === 'survived') t.survived++;
    else if (r.verdict === 'timeout') t.timeout++;
    else t.invalid++;
  }
  t.score = mutationScore(t);
  return t;
}

export interface FlowInput {
  runId: string;
  seed: number;
  targetDir: string;
  files: string[];
  testFiles: string[];
  sampling: Pick<SamplingConfig, 'maxMutants' | 'perFileCap'>;
  timeoutMs: number;
}

export function buildReport(input: FlowInput, results: MutantRunResult[], generated: number): MutationReport {
  return {
    runId: input.runId,
    seed: input.seed,
    generatedAt: new Date().toISOString(),
    target: { dir: input.targetDir, files: input.files, testFiles: input.testFiles },
    sampling: { maxMutants: input.sampling.maxMutants, perFileCap: input.sampling.perFileCap },
    timeoutMs: input.timeoutMs,
    truncated: false,
    truncateReason: null,
    totals: summarize(results, generated, results.length),
    results: [...results],
  };
}

/**
 * Marker put in place of a result's outputTail in persisted reports.
 * Persisted reports are plain JSON under the server data dir and are
 * readable back through cross-feature file readers (codesearch,
 * todo-scan), so child output must never be stored on disk.
 */
export const PERSISTED_OUTPUT_TAIL_NOTE =
  '[omitted from persisted report: child output tails are not stored on disk]';

/**
 * Strip child output tails for the persisted copy of a report (R16 N2).
 *
 * The in-memory report keeps the real tails (the API only ever returns
 * reportSummary, which excludes results, so they are not API-visible).
 * The persisted copy — `data/mutation-runs/<runId>.json` and
 * `latest-<project>.json` — replaces every result's outputTail with
 * PERSISTED_OUTPUT_TAIL_NOTE. This is a deliberate field-value change,
 * not a silent schema change: the `outputTail` key stays present with
 * the note as its value, so readers see why the tail is absent.
 * Redacting instead of stripping was rejected: diagpack `redactText`
 * does not mask `FACTORY_API_TOKEN=` lines, and a planted test can
 * print a literal credential line that no key-shape redactor would
 * catch. Stripping is the only shape that closes the readback for
 * arbitrary literal output. Returns a copy; the input is untouched.
 */
export function stripReportForPersist(report: MutationReport): MutationReport {
  return {
    ...report,
    results: report.results.map((r) => ({ ...r, outputTail: PERSISTED_OUTPUT_TAIL_NOTE })),
  };
}

function pct(score: number | null): string {
  return score === null ? 'n/a' : `${(score * 100).toFixed(1)}%`;
}

/** Human-readable markdown rendering of a report. */
export function renderMarkdown(report: MutationReport): string {
  const t = report.totals;
  const lines: string[] = [
    `# Mutation report \`${report.runId}\``,
    '',
    `- target: \`${report.target.dir}\` (${report.target.files.length} file(s), ${report.target.testFiles.length} test file(s))`,
    `- seed: \`${report.seed}\` · sampling: max ${report.sampling.maxMutants}/file-cap ${report.sampling.perFileCap} · timeout ${report.timeoutMs}ms`,
    `- generated: ${t.generated} · sampled: ${t.sampled}${report.truncated ? ` · TRUNCATED (${report.truncateReason})` : ''}`,
    `- killed: ${t.killed} · survived: ${t.survived} · timeout: ${t.timeout} · invalid: ${t.invalid}`,
    `- **mutation score: ${pct(t.score)}** (killed / (killed + survived); timeouts and invalid mutants excluded)`,
    '',
    '## Results',
    '',
    '| file | line | operator | change | verdict | ms |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of report.results) {
    lines.push(
      `| \`${r.mutant.file}\` | ${r.mutant.line} | ${r.mutant.operator} | \`${r.mutant.description}\` | ${r.verdict} | ${r.durationMs} |`,
    );
  }
  return lines.join('\n');
}

/** Group results by file for UI display. */
export function resultsByFile(
  results: readonly MutantRunResult[],
): Array<{ file: string; results: MutantRunResult[] }> {
  const map = new Map<string, MutantRunResult[]>();
  for (const r of results) {
    const arr = map.get(r.mutant.file) ?? [];
    arr.push(r);
    map.set(r.mutant.file, arr);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([file, rs]) => ({ file, results: rs }));
}
