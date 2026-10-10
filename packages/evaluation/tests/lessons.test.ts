/**
 * Tests for §58 failure analysis → Lesson and sink persistence:
 * lessons are generated for failing metrics and land in the sink via the
 * LessonSink interface (no hard dependency on @ai-factory/memory).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvaluationEngine,
  EvaluationResult,
  FailureAnalyzer,
  InMemoryLessonSink,
  lessonConfidence,
  Lesson,
  LessonPublisher,
  LessonSink,
} from '../src/index';

let now = 1_000;
function engine(): EvaluationEngine {
  return new EvaluationEngine({ now: () => now });
}

function evalFor(taskId: string, overrides = {}): EvaluationResult {
  return engine().evaluateTask({
    taskId,
    agentId: 'backend-01',
    summary: 'Implemented the endpoint.',
    evidenceIds: ['ev-1', 'ev-2'],
    success: true,
    tests: { passed: 10, total: 10 },
    regressions: 0,
    reviewRounds: 1,
    reviewRejections: 0,
    fixLoops: 1,
    durationMs: 1000,
    tokensUsed: 1000,
    toolCalls: 10,
    toolErrors: 0,
    completionClaims: 1,
    falseCompletions: 0,
    deployments: 0,
    rollbacks: 0,
    decisions: 1,
    escalations: 0,
    ...overrides,
  });
}

describe('FailureAnalyzer', () => {
  it('produces no lessons for a clean evaluation', () => {
    const lessons = new FailureAnalyzer().analyzeFailures(evalFor('t1'));
    assert.deepEqual(lessons, []);
  });

  it('produces a critical lesson for a failed task', () => {
    const lessons = new FailureAnalyzer().analyzeFailures(evalFor('t2', { success: false }));
    const titles = lessons.map((l) => l.title);
    assert.ok(titles.some((t) => t.includes('failed')), `got: ${titles}`);
    const failure = lessons.find((l) => l.title.includes('failed'))!;
    assert.equal(failure.severity, 'critical');
    assert.equal(failure.taskId, 't2');
    assert.equal(failure.agentId, 'backend-01');
    assert.ok(failure.lessonId.startsWith('lesson_'));
    assert.deepEqual(failure.evidenceIds, ['ev-1', 'ev-2']);
  });

  it('produces a critical lesson for false completions', () => {
    const lessons = new FailureAnalyzer().analyzeFailures(
      evalFor('t3', { completionClaims: 2, falseCompletions: 1 }),
    );
    const lesson = lessons.find((l) => l.title.includes('False completion'))!;
    assert.equal(lesson.severity, 'critical');
    assert.ok(lesson.content.includes('50%'));
  });

  it('produces warning lessons for regressions, rejections, tool errors, rollbacks, excess loops', () => {
    const lessons = new FailureAnalyzer().analyzeFailures(
      evalFor('t4', {
        tests: { passed: 8, total: 10 },
        regressions: 1,
        reviewRejections: 1,
        toolCalls: 10,
        toolErrors: 3,
        deployments: 1,
        rollbacks: 1,
        fixLoops: 5,
      }),
    );
    const severities = lessons.map((l) => l.severity);
    assert.ok(lessons.length >= 5, `expected >= 5 lessons, got ${lessons.length}`);
    assert.ok(severities.every((s) => s === 'warning' || s === 'info' || s === 'critical'));
    assert.ok(lessons.some((l) => l.title.includes('Excessive repair loops')));
    assert.ok(lessons.some((l) => l.title.includes('rolled back')));
  });

  it('uses the injected clock for createdAt', () => {
    now = 42_000;
    const [lesson] = new FailureAnalyzer({ now: () => now }).analyzeFailures(
      evalFor('t5', { success: false }),
    );
    assert.equal(lesson.createdAt, 42_000);
  });
});

describe('lessonConfidence', () => {
  it('ranks critical above warning above info and rewards evidence', () => {
    assert.ok(lessonConfidence('critical', 2) > lessonConfidence('warning', 2));
    assert.ok(lessonConfidence('warning', 2) > lessonConfidence('info', 2));
    assert.ok(lessonConfidence('info', 4) > lessonConfidence('info', 0));
    assert.ok(lessonConfidence('critical', 100) <= 1);
  });
});

describe('LessonPublisher', () => {
  it('persists every lesson through the LessonSink interface', () => {
    const saved: Lesson[] = [];
    const sink: LessonSink = { saveLesson: (l) => saved.push(l) };
    const publisher = new LessonPublisher(sink);
    const lessons = publisher.publish(evalFor('t6', { success: false }));
    assert.ok(lessons.length > 0);
    assert.deepEqual(
      saved.map((l) => l.lessonId),
      lessons.map((l) => l.lessonId),
    );
  });

  it('calls the sink zero times for a clean evaluation', () => {
    let calls = 0;
    const publisher = new LessonPublisher({ saveLesson: () => calls++ });
    const lessons = publisher.publish(evalFor('t7'));
    assert.deepEqual(lessons, []);
    assert.equal(calls, 0);
  });
});

describe('InMemoryLessonSink', () => {
  it('collects saved lessons', () => {
    const sink = new InMemoryLessonSink();
    const lesson: Lesson = {
      lessonId: 'lesson_1',
      taskId: 't8',
      agentId: 'backend-01',
      title: 'title',
      content: 'content',
      severity: 'info',
      confidence: 0.5,
      evidenceIds: [],
      createdAt: 1,
    };
    sink.saveLesson(lesson);
    assert.equal(sink.size(), 1);
    assert.deepEqual(sink.all(), [lesson]);
  });
});
