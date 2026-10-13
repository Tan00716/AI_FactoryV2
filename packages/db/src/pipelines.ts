/**
 * Durable pipeline records + stage definitions — SPEC v2 §39 (CI/CD
 * ENGINE), §40 (ENVIRONMENT MANAGEMENT), Batch 31-2.
 *
 * Pipeline records and stage definitions used to be pure process
 * memory: a server restart turned every pipeline into a 404 (or, for
 * pipelines with persisted deployments, an honest REHYDRATED stub
 * with no stages). This store persists the full record — pipeline
 * fields plus all stage definitions (name, status, logs, artifacts,
 * timestamps) — so a restarted server can REBUILD the record instead
 * of mourning it.
 *
 * The deliberate split, pinned by tests:
 *  - what is persisted is the RECORD, not the run: stage HANDLERS
 *    are host closures and can never be persisted (same seam as
 *    Batch 19's deployFn/smokeFn — by design, not loss). A rebuilt
 *    record is read-only history: /run on it keeps 409ing;
 *  - a pipeline left RUNNING in the store (process died mid-run) is
 *    demoted to INTERRUPTED on rebuild — a first-class lifecycle
 *    state, never presented as still running, never resumable;
 *  - statuses mirror packages/cicd's vocabulary (PipelineStatus /
 *    StageStatus, including the Batch-31 INTERRUPTED state); the row
 *    is a faithful projection of the pipeline record plus its stages.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects from JSON in SQLite).
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type PersistedPipelineStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'CANCELLED';

export type PersistedStageStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED';

export interface PersistedStageArtifact {
  name: string;
  kind: string;
  summary?: string;
}

/** One persisted stage definition within a pipeline. */
export interface PersistedPipelineStage {
  pipelineId: string;
  /** 0-based position in the canonical stage order. */
  position: number;
  name: string;
  status: PersistedStageStatus;
  logs: string[];
  artifacts: PersistedStageArtifact[];
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

/** One persisted pipeline record (stages travel with it). */
export interface PersistedPipeline {
  id: string;
  commitSha: string;
  environment: string;
  status: PersistedPipelineStatus;
  /** Task the pipeline is bound to (evidence hangs here). */
  taskId: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO time of a post-restart rebuild; null when never rebuilt. */
  rehydratedAt: string | null;
  stages: PersistedPipelineStage[];
}

export interface PipelineRecordStore {
  /**
   * Insert or replace the record AND its stages atomically (one
   * transaction: a reader never sees a half-written record).
   */
  save(record: PersistedPipeline): void;
  get(id: string): PersistedPipeline | undefined;
  list(): PersistedPipeline[];
  /** Stamp the rebuild marker; no-op when the row is unknown. */
  markRehydrated(id: string, at: string): void;
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryPipelineRecordStore implements PipelineRecordStore {
  private readonly map = new Map<string, PersistedPipeline>();

  save(record: PersistedPipeline): void {
    this.map.set(record.id, copy(record));
  }

  get(id: string): PersistedPipeline | undefined {
    const row = this.map.get(id);
    return row === undefined ? undefined : copy(row);
  }

  list(): PersistedPipeline[] {
    return [...this.map.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(copy);
  }

  markRehydrated(id: string, at: string): void {
    const row = this.map.get(id);
    if (row) row.rehydratedAt = at;
  }
}

function stageOf(
  pipelineId: string,
  r: Record<string, unknown>,
): PersistedPipelineStage {
  let logs: string[];
  let artifacts: PersistedStageArtifact[];
  try {
    logs = JSON.parse(r['logs_json'] as string) as string[];
    artifacts = JSON.parse(r['artifacts_json'] as string) as PersistedStageArtifact[];
  } catch (e) {
    // Batch 25 philosophy: a corrupted row is never guessed at —
    // fail loudly so the corruption is visible, not silently
    // normalized into a wrong pipeline.
    throw new Error(
      `corrupted pipeline_stages row for pipeline ${pipelineId}: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(logs) || !Array.isArray(artifacts)) {
    throw new Error(
      `corrupted pipeline_stages row for pipeline ${pipelineId}: logs/artifacts are not arrays`,
    );
  }
  return {
    pipelineId,
    position: r['position'] as number,
    name: r['name'] as string,
    status: r['status'] as PersistedStageStatus,
    logs,
    artifacts,
    startedAt: (r['started_at'] as string | null) ?? null,
    endedAt: (r['ended_at'] as string | null) ?? null,
    error: (r['error'] as string | null) ?? null,
  };
}

/** SQLite implementation, pinned against the in-memory reference. */
export class SqlitePipelineRecordStore implements PipelineRecordStore {
  // The pipeline_records / pipeline_stages tables live in schema.ts
  // (exec'd on open); this constructor assumes the open-path
  // migration already ran.
  constructor(private readonly db: DatabaseSync) {}

  save(record: PersistedPipeline): void {
    // One atomic unit: a reader never sees a half-written record
    // (record row without its stages, or a mix of old and new
    // stages). BEGIN IMMEDIATE takes the write lock up front so
    // cross-process writers serialize here.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO pipeline_records
             (id, commit_sha, environment, status, task_id,
              failure_stage, failure_message, created_at, updated_at,
              rehydrated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             commit_sha=excluded.commit_sha, environment=excluded.environment,
             status=excluded.status, task_id=excluded.task_id,
             failure_stage=excluded.failure_stage,
             failure_message=excluded.failure_message,
             created_at=excluded.created_at, updated_at=excluded.updated_at,
             rehydrated_at=excluded.rehydrated_at`,
        )
        .run(
          record.id,
          record.commitSha,
          record.environment,
          record.status,
          record.taskId,
          record.failureStage,
          record.failureMessage,
          record.createdAt,
          record.updatedAt,
          record.rehydratedAt,
        );
      // Stage rows are fully replaced: the record is the whole truth,
      // there is no such thing as a partial stage update.
      this.db
        .prepare('DELETE FROM pipeline_stages WHERE pipeline_id = ?')
        .run(record.id);
      const insert = this.db.prepare(
        `INSERT INTO pipeline_stages
           (pipeline_id, position, name, status, logs_json,
            artifacts_json, started_at, ended_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of record.stages) {
        insert.run(
          record.id,
          s.position,
          s.name,
          s.status,
          JSON.stringify(s.logs),
          JSON.stringify(s.artifacts),
          s.startedAt,
          s.endedAt,
          s.error,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* Already rolled back — the original error is what matters. */
      }
      throw e;
    }
  }

  get(id: string): PersistedPipeline | undefined {
    const row = this.db
      .prepare('SELECT * FROM pipeline_records WHERE id = ?')
      .get(id) as unknown as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      id: row['id'] as string,
      commitSha: row['commit_sha'] as string,
      environment: row['environment'] as string,
      status: row['status'] as PersistedPipelineStatus,
      taskId: (row['task_id'] as string | null) ?? null,
      failureStage: (row['failure_stage'] as string | null) ?? null,
      failureMessage: (row['failure_message'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      rehydratedAt: (row['rehydrated_at'] as string | null) ?? null,
      stages: this.stagesOf(id),
    };
  }

  list(): PersistedPipeline[] {
    const rows = this.db
      .prepare('SELECT * FROM pipeline_records ORDER BY created_at')
      .all() as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row['id'] as string,
      commitSha: row['commit_sha'] as string,
      environment: row['environment'] as string,
      status: row['status'] as PersistedPipelineStatus,
      taskId: (row['task_id'] as string | null) ?? null,
      failureStage: (row['failure_stage'] as string | null) ?? null,
      failureMessage: (row['failure_message'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      rehydratedAt: (row['rehydrated_at'] as string | null) ?? null,
      stages: this.stagesOf(row['id'] as string),
    }));
  }

  markRehydrated(id: string, at: string): void {
    this.db
      .prepare('UPDATE pipeline_records SET rehydrated_at = ? WHERE id = ?')
      .run(at, id);
  }

  private stagesOf(pipelineId: string): PersistedPipelineStage[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position',
        )
        .all(pipelineId) as unknown as Record<string, unknown>[]
    ).map((r) => stageOf(pipelineId, r));
  }
}

/** Test helper: build a minimal valid pipeline record. */
export function makePersistedPipeline(
  overrides: Partial<PersistedPipeline> = {},
): PersistedPipeline {
  const stamp = new Date().toISOString();
  const stages: PersistedPipelineStage[] = [
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
  ].map((name, position) => ({
    pipelineId: 'pipe-x',
    position,
    name,
    status: 'PENDING' as PersistedStageStatus,
    logs: [],
    artifacts: [],
    startedAt: null,
    endedAt: null,
    error: null,
  }));
  return {
    id: randomUUID(),
    commitSha: 'HEAD',
    environment: 'DEV',
    status: 'QUEUED',
    taskId: null,
    failureStage: null,
    failureMessage: null,
    createdAt: stamp,
    updatedAt: stamp,
    rehydratedAt: null,
    stages,
    ...overrides,
  };
}
