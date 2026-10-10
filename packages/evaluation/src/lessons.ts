/**
 * Failure analysis → Lesson (§58: Task → Evaluation → Failure Analysis →
 * Lesson → Memory).
 *
 * `analyzeFailures` turns a non-ideal evaluation into structured lessons
 * (what broke, why it matters, what evidence backs it). Lessons are then
 * persisted through the `LessonSink` interface — the engine deliberately
 * does NOT depend on @ai-factory/memory; callers supply their own sink
 * (in-memory, the real memory package, a database, …).
 */
import { randomUUID } from 'node:crypto';
import { EvaluationResult, Lesson, LessonSink } from './types';
import { clamp01, round2 } from './engine';

export interface AnalyzerOptions {
  /** Defaults to `Date.now`; inject a fake clock in tests/demos. */
  now?: () => number;
}

/**
 * Lesson confidence heuristic: a lesson from a metric we measured
 * directly (test failures, false completions, rejections) is fairly
 * trustworthy; repeated identical signals and clean evidence raise it.
 */
export function lessonConfidence(severity: Lesson['severity'], evidenceCount: number): number {
  let c = severity === 'critical' ? 0.7 : severity === 'warning' ? 0.6 : 0.5;
  c += Math.min(evidenceCount, 4) * 0.05;
  return round2(clamp01(c));
}

function truncate(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export class FailureAnalyzer {
  private readonly nowFn: () => number;

  constructor(options: AnalyzerOptions = {}) {
    this.nowFn = options.now ?? Date.now;
  }

  private mk(base: {
    result: EvaluationResult;
    title: string;
    content: string;
    severity: Lesson['severity'];
  }): Lesson {
    return {
      lessonId: `lesson_${randomUUID()}`,
      taskId: base.result.taskId,
      agentId: base.result.agentId,
      title: base.title,
      content: base.content,
      severity: base.severity,
      confidence: lessonConfidence(base.severity, base.result.evidenceIds.length),
      evidenceIds: [...base.result.evidenceIds],
      createdAt: this.nowFn(),
    };
  }

  /**
   * Analyze one evaluation. Returns lessons for every metric that shows a
   * problem; an all-clean evaluation returns an empty list (nothing failed,
   * nothing to learn). The caller persists via a `LessonSink`.
   */
  analyzeFailures(result: EvaluationResult): Lesson[] {
    const m = result.metrics;
    const lessons: Lesson[] = [];
    const summary = truncate(result.summary, 160);

    if (m.taskSuccess === 0) {
      lessons.push(
        this.mk({
          result,
          title: `Task ${result.taskId} failed`,
          content: `Task failed (${summary}). Treat the task description as suspect: re-verify acceptance criteria and evidence before retrying.`,
          severity: 'critical',
        }),
      );
    }
    if (m.testPassRate < 1) {
      const ratePct = Math.round(m.testPassRate * 100);
      lessons.push(
        this.mk({
          result,
          title: 'Not all tests pass before completion',
          content: `Test pass rate ${ratePct}% with regression rate ${Math.round(m.regressionRate * 100)}% (${summary}). Do not claim completion until the full suite is green; re-run regression checks after every fix.`,
          severity: m.regressionRate > 0 ? 'warning' : 'info',
        }),
      );
    }
    if (m.falseCompletionRate > 0) {
      lessons.push(
        this.mk({
          result,
          title: 'False completion claim detected',
          content: `Agent claimed completion falsely (${Math.round(m.falseCompletionRate * 100)}% of claims) (${summary}). Every "done" claim must cite passing checks; a false done is an integrity failure, not a shortcut.`,
          severity: 'critical',
        }),
      );
    }
    if (m.reviewRejectionRate > 0) {
      lessons.push(
        this.mk({
          result,
          title: 'Reviewer rejected the work',
          content: `Review rejection rate ${Math.round(m.reviewRejectionRate * 100)}% (${summary}). Capture the reviewer's objections verbatim and address each before resubmitting.`,
          severity: 'warning',
        }),
      );
    }
    if (m.toolErrorRate > 0.2) {
      lessons.push(
        this.mk({
          result,
          title: 'High tool error rate',
          content: `Tool error rate ${Math.round(m.toolErrorRate * 100)}% (${summary}). Validate tool inputs before calling; retry transient failures with backoff and stop hammering broken calls.`,
          severity: 'warning',
        }),
      );
    }
    if (m.rollbackRate > 0) {
      lessons.push(
        this.mk({
          result,
          title: 'Deployment was rolled back',
          content: `Rollback rate ${Math.round(m.rollbackRate * 100)}% (${summary}). Keep changes small, verify on staging, and never ship what the evaluation did not green-light.`,
          severity: 'warning',
        }),
      );
    }
    if (result.repairLoops > 3) {
      lessons.push(
        this.mk({
          result,
          title: 'Excessive repair loops',
          content: `${result.repairLoops} repair loops needed (${summary}). After 3 loops, stop and escalate: the task framing or the approach is wrong, not the details.`,
          severity: 'warning',
        }),
      );
    }
    return lessons;
  }
}

/**
 * Thin publisher: runs failure analysis for an evaluation and persists
 * every resulting lesson through the given sink. Sink-agnostic — the demo
 * wires it to the real @ai-factory/memory store.
 */
export class LessonPublisher {
  private readonly analyzer: FailureAnalyzer;
  private readonly sink: LessonSink;

  constructor(sink: LessonSink, options: AnalyzerOptions = {}) {
    this.sink = sink;
    this.analyzer = new FailureAnalyzer(options);
  }

  /** Analyze one evaluation and persist all lessons. Returns the lessons. */
  publish(result: EvaluationResult): Lesson[] {
    const lessons = this.analyzer.analyzeFailures(result);
    for (const lesson of lessons) this.sink.saveLesson(lesson);
    return lessons;
  }
}

/** Test/standalone sink that keeps lessons in memory. */
export class InMemoryLessonSink implements LessonSink {
  private lessons: Lesson[] = [];

  saveLesson(lesson: Lesson): void {
    this.lessons.push(lesson);
  }

  all(): Lesson[] {
    return [...this.lessons];
  }

  size(): number {
    return this.lessons.length;
  }
}
