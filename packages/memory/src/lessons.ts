/**
 * Task-end evaluation → memory lessons — spec §57 (Evaluation Engine) and
 * the §58 improvement loop (Task → Evaluation → Failure Analysis → Lesson →
 * Memory).
 *
 * This is the evaluation placeholder: `lessonFromEvaluation` turns a
 * completed task's evaluation summary into structured `Lesson` / `Failure`
 * memory entries (task scope) that callers persist via `MemoryStore.write`.
 * Writing the same task's evaluation twice merges via the store's dedup
 * instead of duplicating.
 */
import { MemoryType, NewMemoryEntry } from './types';

/** Measurable outcome of one finished task (§57 metrics, minimal subset). */
export interface LessonMetrics {
  /** Overall task success. */
  success: boolean;
  /** 0..1 fraction of tests passing. */
  testPassRate: number;
  /** How many fix/retry loops the task needed. */
  repairLoops: number;
}

/** Input shape for `lessonFromEvaluation`. */
export interface EvaluationInput {
  taskId: string;
  projectId: string;
  /** Employee (agent) that ran the task; defaults to 'evaluation-engine'. */
  employeeId?: string;
  /** One-paragraph summary of what the task did and what was learned. */
  summary: string;
  metrics: LessonMetrics;
  /** Raw failure descriptions observed during the task. */
  failures: string[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Heuristic lesson confidence: successful, high-pass-rate tasks with few
 * failures produce trustworthy lessons; failures and many repair loops
 * erode it. Deliberately simple — the evaluation engine (§57) will refine
 * the weights once real agent profiles exist.
 */
export function lessonConfidence(metrics: LessonMetrics, failureCount: number): number {
  let c = metrics.success ? 0.8 : 0.5;
  c += (metrics.testPassRate - 0.5) * 0.2;
  c -= Math.min(failureCount, 5) * 0.05;
  if (metrics.repairLoops > 3) c -= 0.1;
  return round2(clamp01(c));
}

function truncate(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Build structured memory entries from a task evaluation:
 * one `Lesson` entry capturing the outcome + metrics, plus one `Failure`
 * entry per reported failure. All entries land in the `task` scope under
 * the task id, with `applicableScope` pointing at the project so project
 * queries can surface them.
 */
export function lessonFromEvaluation(input: EvaluationInput): NewMemoryEntry[] {
  const createdBy = input.employeeId ?? 'evaluation-engine';
  const source = `evaluation:${input.taskId}`;
  const applicableScope = `project:${input.projectId}`;
  const baseConfidence = lessonConfidence(input.metrics, input.failures.length);

  // §43.2 v2 fields: lessons are visible to the owning project (ACL),
  // classified internal, and not cross-project reusable by default.
  const accessScope = [`project:${input.projectId}`];
  const lesson: NewMemoryEntry = {
    scope: 'task',
    scopeId: input.taskId,
    type: 'Lesson' as MemoryType,
    title: `Lesson from task ${input.taskId}`,
    content: [
      input.summary.trim(),
      '',
      `Metrics: success=${input.metrics.success}, ` +
        `testPassRate=${input.metrics.testPassRate}, ` +
        `repairLoops=${input.metrics.repairLoops}, ` +
        `failures=${input.failures.length}`,
    ].join('\n'),
    source,
    sourceRefs: [source],
    taskRefs: [input.taskId],
    confidence: baseConfidence,
    confidenceKind: 'evaluation-derived',
    createdBy,
    evidenceIds: [],
    applicableScope,
    accessScope,
    dataClassification: 'internal',
    crossProjectReusable: { allowed: false },
    expiresAt: null,
  };

  const failures: NewMemoryEntry[] = input.failures.map((failure) => ({
    scope: 'task',
    scopeId: input.taskId,
    type: 'Failure' as MemoryType,
    title: `Failure in task ${input.taskId}: ${truncate(failure, 60)}`,
    content: failure.trim(),
    source,
    sourceRefs: [source],
    taskRefs: [input.taskId],
    confidence: round2(clamp01(baseConfidence - 0.1)),
    confidenceKind: 'evaluation-derived',
    createdBy,
    evidenceIds: [],
    applicableScope,
    accessScope,
    dataClassification: 'internal',
    crossProjectReusable: { allowed: false },
    expiresAt: null,
  }));

  return [lesson, ...failures];
}
