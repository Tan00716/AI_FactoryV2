/**
 * V3-#7 timeline construction: chain result + plan -> TimelineRun steps.
 *
 * Step order is execution order (dependencies first, as the runner
 * recorded them). Planned steps the chain never reached are appended as
 * 'skipped' with an explicit note — the chain stopped fail-closed, so
 * they did not run and must not look as if they did.
 */
import { createHash } from 'node:crypto';
import {
  TIMELINE_OUTPUT_CAP_BYTES,
  type TimelineRun,
  type TimelineStep,
  type TimelineStepInput,
} from './types.ts';

export interface ChainResultInput {
  requested: string[];
  ok: boolean;
  stoppedAt: string | null;
  startedAt: string;
  finishedAt: string;
  results: TimelineStepInput[];
}

export interface PlannedStep {
  label: string;
  command: string;
}

export function digestOutput(stored: string): string {
  return createHash('sha256').update(stored, 'utf8').digest('hex');
}

/**
 * Build the step cards for one chain run. `planned` is the full flattened
 * plan (dependencies included, in plan order); `results` is what actually
 * ran, in execution order. Unknown-command steps and unrun planned steps
 * are both surfaced explicitly, never silently dropped.
 */
export function buildTimeline(
  id: string,
  chain: ChainResultInput,
  planned: PlannedStep[],
): TimelineRun {
  const commandByLabel = new Map(planned.map((p) => [p.label, p.command]));
  const executed = new Set(chain.results.map((r) => r.label));
  const steps: TimelineStep[] = [];
  const unknown: string[] = [];

  const toStep = (
    index: number,
    r: TimelineStepInput,
    skipped: boolean,
  ): TimelineStep => {
    const command = commandByLabel.get(r.label) ?? null;
    if (command === null) unknown.push(r.label);
    const stored = skipped ? '' : r.output.slice(0, TIMELINE_OUTPUT_CAP_BYTES);
    return {
      index,
      label: r.label,
      command,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      output: stored,
      outputBytes: skipped ? 0 : r.output.length,
      outputTruncated: skipped ? false : r.truncated || r.output.length > TIMELINE_OUTPUT_CAP_BYTES,
      outputDigest: digestOutput(stored),
      diagnosticsAdded: r.diagnosticsAdded,
      matchRate: r.matchRate,
      ...(r.error ? { error: r.error } : {}),
      ...(r.notes ? { notes: r.notes } : {}),
      supersededAt: null,
    };
  };

  for (const r of chain.results) {
    steps.push(toStep(steps.length, r, false));
  }
  // Planned but never reached: the chain stopped fail-closed before them.
  for (const p of planned) {
    if (executed.has(p.label)) continue;
    steps.push(
      toStep(
        steps.length,
        {
          label: p.label,
          status: 'skipped',
          exitCode: null,
          durationMs: 0,
          output: '',
          truncated: false,
          diagnosticsAdded: 0,
          matchRate: 1,
          notes: ['not run: the chain stopped before this step'],
        },
        true,
      ),
    );
  }

  const coverage = unknown.length > 0 ? 'partial' : 'full';
  return {
    id,
    label: chain.requested.join(','),
    ok: chain.ok,
    stoppedAt: chain.stoppedAt,
    startedAt: chain.startedAt,
    finishedAt: chain.finishedAt,
    steps,
    coverage,
    ...(coverage === 'partial'
      ? { coverageNote: `command unknown for step(s): ${unknown.join(', ')}` }
      : {}),
    supersededFrom: null,
    supersededAt: null,
    rollbackCount: 0,
    checkpointTaskId: chain.requested.join(','),
  };
}
