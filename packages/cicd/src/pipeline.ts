/**
 * Pipeline runner — spec §39 (CI/CD ENGINE).
 *
 * Runs the eight stages in order with injectable stage handlers. The runner
 * only emits callbacks — onEvidence(type, payload) and onAudit(action, detail)
 * — so the server layer can attach evidence/audit records without this
 * package importing core.
 */

import { randomUUID } from 'node:crypto';
import { nowIso } from '@ai-factory/core';
import { PIPELINE_STAGE_ORDER } from './types';
import type {
  Artifact,
  EnvironmentName,
  Pipeline,
  PipelineStage,
  StageName,
  StageStatus,
} from './types';

/** Evidence hook: (type, payload). The caller wires it to the evidence engine. */
export type EvidenceFn = (
  type: string,
  payload: Record<string, unknown>,
) => void;

/** Audit hook: (action, detail). The caller wires it to ctx.audit.record. */
export type AuditFn = (action: string, detail: Record<string, unknown>) => void;

/** What a stage handler returns. */
export interface StageResult {
  success: boolean;
  logs?: string[];
  artifacts?: Artifact[];
  /** Human-readable failure message when success === false. */
  error?: string;
  /**
   * When true the stage is marked SKIPPED (nothing to do) and the pipeline
   * continues to the next stage.
   */
  skip?: boolean;
}

/** Context passed to every stage handler. */
export interface StageContext {
  pipeline: Pipeline;
  stage: StageName;
  evidence: EvidenceFn;
  audit: AuditFn;
}

export type StageHandler = (ctx: StageContext) => Promise<StageResult>;

export interface PipelineRunnerOptions {
  /** Per-stage handler overrides; missing stages use the default simulator. */
  handlers?: Partial<Record<StageName, StageHandler>>;
  onStageStart?: (stage: PipelineStage) => void;
  onStageEnd?: (stage: PipelineStage) => void;
  evidence?: EvidenceFn;
  audit?: AuditFn;
}

function noopEvidence(): EvidenceFn {
  return () => undefined;
}

function noopAudit(): AuditFn {
  return () => undefined;
}

/**
 * Default simulated stage handler: succeeds with a log line and a
 * `{stage}-result.json` artifact. Real handlers (shelling out to the build
 * system, test runner, scanners…) are injected via PipelineRunnerOptions.
 */
export function defaultStageHandler(stage: StageName): StageHandler {
  return async () => ({
    success: true,
    logs: [`[${stage}] simulated ${stage} step completed OK`],
    artifacts: [
      {
        name: `${stage}-result.json`,
        kind: `${stage}-report`,
        summary: `${stage} passed (simulated)`,
      },
    ],
  });
}

function newStage(name: StageName): PipelineStage {
  return {
    name,
    status: 'PENDING',
    logs: [],
    artifacts: [],
    startedAt: null,
    endedAt: null,
  };
}

export class PipelineRunner {
  private readonly handlers: Partial<Record<StageName, StageHandler>>;
  private readonly onStageStart?: (stage: PipelineStage) => void;
  private readonly onStageEnd?: (stage: PipelineStage) => void;
  private readonly evidence: EvidenceFn;
  private readonly audit: AuditFn;

  constructor(opts: PipelineRunnerOptions = {}) {
    this.handlers = opts.handlers ?? {};
    this.onStageStart = opts.onStageStart;
    this.onStageEnd = opts.onStageEnd;
    this.evidence = opts.evidence ?? noopEvidence();
    this.audit = opts.audit ?? noopAudit();
  }

  /** Create a QUEUED pipeline with all eight stages PENDING. */
  createPipeline(
    environment: EnvironmentName,
    commitSha: string = 'HEAD',
  ): Pipeline {
    const pipeline: Pipeline = {
      id: randomUUID(),
      commitSha,
      environment,
      stages: PIPELINE_STAGE_ORDER.map(newStage),
      status: 'QUEUED',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.audit('PIPELINE_CREATED', {
      pipelineId: pipeline.id,
      commitSha,
      environment,
    });
    return pipeline;
  }

  /** Run all stages in order. A failing stage stops the pipeline (FAILED). */
  async run(pipeline: Pipeline): Promise<Pipeline> {
    if (pipeline.status !== 'QUEUED') {
      throw new Error(
        `Pipeline ${pipeline.id} is ${pipeline.status}, only QUEUED pipelines can run`,
      );
    }
    pipeline.status = 'RUNNING';
    pipeline.updatedAt = nowIso();
    this.audit('PIPELINE_STARTED', { pipelineId: pipeline.id });

    for (const stage of pipeline.stages) {
      const ok = await this.runStage(pipeline, stage);
      if (!ok) {
        pipeline.status = 'FAILED';
        pipeline.updatedAt = nowIso();
        this.audit('PIPELINE_FAILED', {
          pipelineId: pipeline.id,
          failure: pipeline.failure,
        });
        return pipeline;
      }
    }

    pipeline.status = 'SUCCEEDED';
    pipeline.updatedAt = nowIso();
    this.audit('PIPELINE_SUCCEEDED', { pipelineId: pipeline.id });
    return pipeline;
  }

  /** Run one stage. Returns false when the stage failed (pipeline stops). */
  private async runStage(
    pipeline: Pipeline,
    stage: PipelineStage,
  ): Promise<boolean> {
    const setStatus = (status: StageStatus): void => {
      stage.status = status;
      pipeline.updatedAt = nowIso();
    };

    setStatus('RUNNING');
    stage.startedAt = nowIso();
    this.onStageStart?.(stage);
    this.audit('STAGE_STARTED', {
      pipelineId: pipeline.id,
      stage: stage.name,
    });

    const handler = this.handlers[stage.name] ?? defaultStageHandler(stage.name);
    const ctx: StageContext = {
      pipeline,
      stage: stage.name,
      evidence: this.evidence,
      audit: this.audit,
    };

    try {
      const result = await handler(ctx);
      stage.logs.push(...(result.logs ?? []));

      if (result.skip) {
        setStatus('SKIPPED');
        this.audit('STAGE_SKIPPED', {
          pipelineId: pipeline.id,
          stage: stage.name,
        });
      } else if (result.success) {
        setStatus('SUCCEEDED');
        stage.artifacts.push(...(result.artifacts ?? []));
        for (const artifact of result.artifacts ?? []) {
          // Stage artifacts are evidence for the gate (spec §42).
          this.evidence('stage-artifact', {
            pipelineId: pipeline.id,
            stage: stage.name,
            artifact,
          });
        }
        this.audit('STAGE_SUCCEEDED', {
          pipelineId: pipeline.id,
          stage: stage.name,
        });
      } else {
        return this.failStage(pipeline, stage, result.error ?? `${stage.name} failed`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failStage(pipeline, stage, message);
    } finally {
      stage.endedAt = nowIso();
      this.onStageEnd?.(stage);
    }

    return true;
  }

  private failStage(
    pipeline: Pipeline,
    stage: PipelineStage,
    message: string,
  ): boolean {
    stage.status = 'FAILED';
    stage.error = message;
    pipeline.failure = { stage: stage.name, message };
    pipeline.updatedAt = nowIso();
    this.audit('STAGE_FAILED', {
      pipelineId: pipeline.id,
      stage: stage.name,
      message,
    });
    return false;
  }
}
