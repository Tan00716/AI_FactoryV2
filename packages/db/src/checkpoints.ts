/**
 * SQLite-backed CheckpointStore — SPEC v2 §28.3 (G-59).
 *
 * The runtime's CheckpointV2 used to be a bare value: createCheckpointV2
 * built it, validateCheckpointV2 checked it, and nothing could persist
 * it — a checkpoint (the §28.3 resumption contract) vanished with the
 * process that captured it, so checkpoint-level resume after a crash
 * was impossible even though step intents and external operations
 * already survived. This store keeps the CheckpointStore contract on
 * top of the checkpoints table: same record shape, same (runId,
 * stepPosition) identity and replace semantics — only the backing
 * changes.
 *
 * Why `implements CheckpointStore` (not `extends` anything): the seam's
 * runtime-side consumer, CheckpointLog, takes the store as an
 * interface — exactly like OperationLedger / SqliteOperationStore — so
 * no subclassing is needed and the runtime keeps sole ownership of
 * creation, validation, and resume semantics.
 *
 * Serialization fidelity: captured_at is epoch milliseconds stored as
 * INTEGER; the optional fields (modelSessionRef, workspaceSnapshotHash,
 * gitBase, gitCandidate) exist on the record only when a capture set
 * them, so a NULL column reads back as an ABSENT key — never as an
 * invented value and never as an explicit undefined. Composite fields
 * (activeTools, activeProcesses, pendingApprovals, pendingSideEffects,
 * resumePreconditions, budgetUsage) are JSON text, which is lossless
 * for string[] / number[] / Record<string, number>; JSON round-trips
 * also make every read a fresh deep copy, so the store's copy contract
 * holds structurally.
 */

import { DatabaseSync } from 'node:sqlite';
import type { CheckpointStore, CheckpointV2 } from '@ai-factory/runtime';

function rowToCheckpoint(r: Record<string, unknown>): CheckpointV2 {
  const c: CheckpointV2 = {
    schemaVersion: r['schema_version'] as CheckpointV2['schemaVersion'],
    runId: r['run_id'] as string,
    stepPosition: Number(r['step_position']),
    workflowVersion: r['workflow_version'] as string,
    taskVersion: r['task_version'] as string,
    contextManifestHash: r['context_manifest_hash'] as string,
    activeTools: JSON.parse(r['active_tools'] as string) as string[],
    activeProcesses: JSON.parse(r['active_processes'] as string) as number[],
    leaseGeneration: Number(r['lease_generation']),
    fencingToken: Number(r['fencing_token']),
    pendingApprovals: JSON.parse(r['pending_approvals'] as string) as string[],
    budgetUsage: JSON.parse(r['budget_usage'] as string) as Record<string, number>,
    pendingSideEffects: JSON.parse(r['pending_side_effects'] as string) as string[],
    resumePreconditions: JSON.parse(r['resume_preconditions'] as string) as string[],
    capturedAt: Number(r['captured_at']),
  };
  if (typeof r['model_session_ref'] === 'string') c.modelSessionRef = r['model_session_ref'];
  if (typeof r['workspace_snapshot_hash'] === 'string') {
    c.workspaceSnapshotHash = r['workspace_snapshot_hash'];
  }
  if (typeof r['git_base'] === 'string') c.gitBase = r['git_base'];
  if (typeof r['git_candidate'] === 'string') c.gitCandidate = r['git_candidate'];
  return c;
}

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly db: DatabaseSync) {}

  get(runId: string, stepPosition: number): CheckpointV2 | undefined {
    const r = this.db
      .prepare('SELECT * FROM checkpoints WHERE run_id = ? AND step_position = ?')
      .get(runId, stepPosition) as Record<string, unknown> | undefined;
    return r ? rowToCheckpoint(r) : undefined;
  }

  put(checkpoint: CheckpointV2): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints
           (run_id, step_position, schema_version, workflow_version, task_version,
            context_manifest_hash, model_session_ref, workspace_snapshot_hash,
            git_base, git_candidate, active_tools, active_processes,
            lease_generation, fencing_token, pending_approvals, budget_usage,
            pending_side_effects, resume_preconditions, captured_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, step_position) DO UPDATE SET
           schema_version=excluded.schema_version,
           workflow_version=excluded.workflow_version,
           task_version=excluded.task_version,
           context_manifest_hash=excluded.context_manifest_hash,
           model_session_ref=excluded.model_session_ref,
           workspace_snapshot_hash=excluded.workspace_snapshot_hash,
           git_base=excluded.git_base, git_candidate=excluded.git_candidate,
           active_tools=excluded.active_tools,
           active_processes=excluded.active_processes,
           lease_generation=excluded.lease_generation,
           fencing_token=excluded.fencing_token,
           pending_approvals=excluded.pending_approvals,
           budget_usage=excluded.budget_usage,
           pending_side_effects=excluded.pending_side_effects,
           resume_preconditions=excluded.resume_preconditions,
           captured_at=excluded.captured_at`,
      )
      .run(
        checkpoint.runId, checkpoint.stepPosition, checkpoint.schemaVersion,
        checkpoint.workflowVersion, checkpoint.taskVersion,
        checkpoint.contextManifestHash,
        checkpoint.modelSessionRef ?? null, checkpoint.workspaceSnapshotHash ?? null,
        checkpoint.gitBase ?? null, checkpoint.gitCandidate ?? null,
        JSON.stringify(checkpoint.activeTools), JSON.stringify(checkpoint.activeProcesses),
        checkpoint.leaseGeneration, checkpoint.fencingToken,
        JSON.stringify(checkpoint.pendingApprovals), JSON.stringify(checkpoint.budgetUsage),
        JSON.stringify(checkpoint.pendingSideEffects),
        JSON.stringify(checkpoint.resumePreconditions),
        checkpoint.capturedAt,
      );
  }

  list(runId?: string): CheckpointV2[] {
    // rowid order = first-capture order: ON CONFLICT DO UPDATE keeps
    // the original rowid, so a replaced capture keeps its position —
    // matching the in-memory store's Map semantics (set on an existing
    // key keeps its insertion slot).
    const rows = (
      runId === undefined
        ? this.db.prepare('SELECT * FROM checkpoints ORDER BY rowid').all()
        : this.db
            .prepare('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY rowid')
            .all(runId)
    ) as Record<string, unknown>[];
    return rows.map(rowToCheckpoint);
  }

  delete(runId: string, stepPosition: number): boolean {
    const res = this.db
      .prepare('DELETE FROM checkpoints WHERE run_id = ? AND step_position = ?')
      .run(runId, stepPosition);
    return Number(res.changes) > 0;
  }
}
