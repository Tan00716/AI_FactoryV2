/**
 * Tests for the pipeline runner (spec §40: 12 stages).
 * Run: node --test dist/tests/pipeline.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_STAGE_ORDER,
  PipelineRunner,
  type StageName,
} from '../src/index';

describe('PipelineRunner', () => {
  it('runs a green pipeline through all 12 §40 stages in order', async () => {
    const started: StageName[] = [];
    const runner = new PipelineRunner({
      onStageStart: (s) => started.push(s.name),
    });
    const pipeline = runner.createPipeline('DEV', 'abc123');
    assert.equal(pipeline.status, 'QUEUED');
    assert.equal(pipeline.stages.length, 12);
    assert.deepEqual(PIPELINE_STAGE_ORDER, [
      'build',
      'test',
      'lint',
      'typecheck',
      'security',
      'package',
      'artifact',
      'review_gate',
      'uat',
      'release',
      'smoke',
      'recovery',
    ]);

    const done = await runner.run(pipeline);
    assert.equal(done.status, 'SUCCEEDED');
    assert.deepEqual(started, PIPELINE_STAGE_ORDER);
    for (const stage of done.stages) {
      assert.equal(stage.status, 'SUCCEEDED', `stage ${stage.name} should succeed`);
      assert.ok(stage.startedAt && stage.endedAt);
      assert.ok(stage.logs.length > 0);
      assert.ok(stage.artifacts.length > 0);
    }
  });

  it('a failing stage stops the pipeline and leaves later stages PENDING', async () => {
    const runner = new PipelineRunner({
      handlers: {
        test: async () => ({
          success: false,
          error: 'unit tests failed: 2 failed, 40 passed',
        }),
      },
    });
    const pipeline = runner.createPipeline('DEV');
    const done = await runner.run(pipeline);

    assert.equal(done.status, 'FAILED');
    assert.deepEqual(done.failure, {
      stage: 'test',
      message: 'unit tests failed: 2 failed, 40 passed',
    });
    const testStage = done.stages.find((s) => s.name === 'test')!;
    assert.equal(testStage.status, 'FAILED');
    // stages before 'test' succeeded, stages after never ran
    const idx = PIPELINE_STAGE_ORDER.indexOf('test');
    for (const s of done.stages.slice(0, idx)) assert.equal(s.status, 'SUCCEEDED');
    for (const s of done.stages.slice(idx + 1)) assert.equal(s.status, 'PENDING');
  });

  it('a throwing handler fails the stage with the thrown message', async () => {
    const runner = new PipelineRunner({
      handlers: {
        build: async () => {
          throw new Error('BUILD_ERROR: npm run build exited 1');
        },
      },
    });
    const done = await runner.run(runner.createPipeline('LOCAL'));
    assert.equal(done.status, 'FAILED');
    assert.equal(done.failure?.stage, 'build');
    assert.match(done.failure?.message ?? '', /BUILD_ERROR/);
  });

  it('a handler returning skip=true marks the stage SKIPPED and continues', async () => {
    const runner = new PipelineRunner({
      handlers: {
        lint: async () => ({ success: true, skip: true, logs: ['no files to lint'] }),
      },
    });
    const done = await runner.run(runner.createPipeline('DEV'));
    assert.equal(done.status, 'SUCCEEDED');
    const lint = done.stages.find((s) => s.name === 'lint')!;
    assert.equal(lint.status, 'SKIPPED');
    const pkg = done.stages.find((s) => s.name === 'package')!;
    assert.equal(pkg.status, 'SUCCEEDED');
  });

  it('emits audit + evidence callbacks the server can wire up', async () => {
    const auditActions: string[] = [];
    const evidenceTypes: string[] = [];
    const runner = new PipelineRunner({
      audit: (action) => auditActions.push(action),
      evidence: (type) => evidenceTypes.push(type),
    });
    const done = await runner.run(runner.createPipeline('UAT'));
    assert.equal(done.status, 'SUCCEEDED');
    assert.ok(auditActions.includes('PIPELINE_STARTED'));
    assert.ok(auditActions.includes('PIPELINE_SUCCEEDED'));
    assert.equal(auditActions.filter((a) => a === 'STAGE_SUCCEEDED').length, 12);
    assert.equal(evidenceTypes.filter((t) => t === 'stage-artifact').length, 12);
  });

  it('refuses to run a non-QUEUED pipeline', async () => {
    const runner = new PipelineRunner();
    const pipeline = runner.createPipeline('DEV');
    await runner.run(pipeline);
    await assert.rejects(runner.run(pipeline), /only QUEUED pipelines can run/);
  });
});
