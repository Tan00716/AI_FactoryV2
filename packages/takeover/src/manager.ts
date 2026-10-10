/**
 * Takeover manager — SPEC v2 §31.
 *
 * Orchestrates the full human-takeover flow. The old AI worker is fenced
 * out via @ai-factory/leases (generation + fencing token bump): any late
 * write from it fails lease validation and can never silently overwrite
 * human work. Overlapping AI/human changes go through an explicit
 * three-way merge — never a hard reset.
 *
 * All environment interactions (quiesce, external-write checks, snapshots,
 * merges, evidence revalidation) are injected hooks so tests stay
 * deterministic and the control plane can wire its real implementations.
 */
import { randomUUID } from 'node:crypto';
import { LeaseManager, StaleOwnerError, type Lease } from '@ai-factory/leases';
import {
  HumanEdit,
  IllegalTakeoverTransition,
  SilentOverwriteRefused,
  TAKEOVER_FLOW,
  TakeoverDisplay,
  TakeoverError,
  TakeoverRecord,
  TakeoverState,
  WriterNotQuiet,
} from './types';

export interface TakeoverHooks {
  /** Ask the AI worker to stop at a safe point. Returns when it acked. */
  quiesceWorker: (runId: string) => Promise<void>;
  /** True when no uncontrolled writes are in flight (checked after fencing). */
  noUncontrolledWrites: (resourceId: string) => Promise<boolean>;
  /** Capture a restorable snapshot; returns its reference. */
  snapshot: (runId: string, resourceId: string) => Promise<string>;
  /**
   * Three-way merge for overlapping changes. Must never discard the human
   * side silently; returns the merged file list.
   */
  threeWayMerge: (files: string[], baseRevision: string) => Promise<string[]>;
  /** Re-run / re-check the evidence affected by human edits. */
  revalidateEvidence: (evidenceIds: string[], edits: HumanEdit[]) => Promise<string[]>;
  now?: () => number;
}

const ALLOWED: Record<TakeoverState, readonly TakeoverState[]> = {
  REQUESTED: ['QUIESCING', 'CANCELLED', 'FAILED'],
  QUIESCING: ['QUIET_VERIFIED', 'FAILED', 'CANCELLED'],
  QUIET_VERIFIED: ['SNAPSHOTTED', 'FAILED'],
  SNAPSHOTTED: ['HUMAN_OWNED', 'FAILED'],
  HUMAN_OWNED: ['RETURN_REQUESTED', 'FAILED'],
  RETURN_REQUESTED: ['RECONCILING', 'FAILED'],
  RECONCILING: ['REVALIDATING', 'FAILED'],
  REVALIDATING: ['RESUMED', 'FAILED'],
  RESUMED: [],
  FAILED: [],
  CANCELLED: [],
};

export class TakeoverManager {
  private readonly leases: LeaseManager;
  private readonly hooks: TakeoverHooks;
  private readonly takeovers = new Map<string, TakeoverRecord>();
  private readonly now: () => number;

  constructor(leases: LeaseManager, hooks: TakeoverHooks) {
    this.leases = leases;
    this.hooks = hooks;
    this.now = hooks.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  requestTakeover(runId: string, resourceId: string, requestedBy: string): TakeoverRecord {
    const rec: TakeoverRecord = {
      id: randomUUID(),
      runId,
      resourceId,
      requestedBy,
      requestedAt: this.iso(),
      state: 'REQUESTED',
      fencedGeneration: null,
      snapshotRef: null,
      humanEdits: [],
      revalidatedEvidence: [],
      mergedFiles: [],
      completedAt: null,
    };
    this.takeovers.set(rec.id, rec);
    return this.copy(rec);
  }

  get(id: string): TakeoverRecord {
    const rec = this.takeovers.get(id);
    if (!rec) throw new TakeoverError('TAKEOVER_NOT_FOUND', `Takeover ${id} not found`);
    return this.copy(rec);
  }

  /** What the UI may display — TAKEOVER_PENDING until truly quiet. */
  display(id: string): TakeoverDisplay {
    const s = this.get(id).state;
    if (s === 'FAILED' || s === 'CANCELLED') return 'FAILED';
    if (s === 'RESUMED' || s === 'REVALIDATING' || s === 'RECONCILING' || s === 'RETURN_REQUESTED') {
      return 'RETURNED';
    }
    if (s === 'HUMAN_OWNED' || s === 'SNAPSHOTTED' || s === 'QUIET_VERIFIED') {
      return 'CONTROL_ACQUIRED';
    }
    return 'TAKEOVER_PENDING';
  }

  /**
   * Drive REQUESTED → HUMAN_OWNED: quiesce, fence the old worker out,
   * verify quiet, snapshot. Throws WriterNotQuiet when the worker will
   * not stop — the UI stays on TAKEOVER_PENDING.
   */
  async acquireControl(id: string): Promise<TakeoverRecord> {
    const rec = this.require(id);
    this.move(rec, 'QUIESCING');
    try {
      await this.hooks.quiesceWorker(rec.runId);
    } catch (err) {
      return this.fail(rec, `quiesce failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Fence the old worker out: bump generation + fencing token. From here
    // any late AI write fails lease validation (StaleOwnerError).
    const lease: Lease = this.leases.reassign(rec.resourceId, `takeover:${rec.id}`, 3_600_000);
    rec.fencedGeneration = lease.generation;
    const quiet = await this.hooks.noUncontrolledWrites(rec.resourceId);
    if (!quiet) {
      return this.fail(rec, 'external writes still in flight after fencing');
    }
    this.move(rec, 'QUIET_VERIFIED');
    rec.snapshotRef = await this.hooks.snapshot(rec.runId, rec.resourceId);
    this.move(rec, 'SNAPSHOTTED');
    this.move(rec, 'HUMAN_OWNED');
    return this.copy(rec);
  }

  /**
   * Record a human edit. The old AI lease token is dead (fenced), so the AI
   * cannot have written concurrently — but we still guard: an edit whose
   * baseRevision does not match the fenced snapshot is rejected rather than
   * silently merged.
   */
  applyHumanEdit(id: string, edit: Omit<HumanEdit, 'authorType' | 'timestamp'>): TakeoverRecord {
    const rec = this.require(id);
    if (rec.state !== 'HUMAN_OWNED') {
      throw new TakeoverError(
        'NOT_HUMAN_OWNED',
        `Human edits are only accepted in HUMAN_OWNED (current: ${rec.state})`,
      );
    }
    if (rec.snapshotRef !== null && edit.baseRevision !== rec.snapshotRef) {
      throw new TakeoverError(
        'STALE_EDIT_BASE',
        `Edit base ${edit.baseRevision} does not match takeover snapshot ${rec.snapshotRef}`,
      );
    }
    rec.humanEdits.push({ ...edit, authorType: 'HUMAN', timestamp: this.iso() });
    return this.copy(rec);
  }

  /**
   * Assert an AI write is still legitimate. After fencing, the old worker's
   * token is stale — this is the "no silent overwrite" enforcement point.
   */
  assertAiWriteAllowed(resourceId: string, fencingToken: number, file: string): void {
    try {
      this.leases.validate(resourceId, fencingToken);
    } catch (err) {
      if (err instanceof StaleOwnerError) {
        throw new SilentOverwriteRefused(file);
      }
      throw err;
    }
  }

  /**
   * Return control: diff human edits, three-way merge overlaps (never a hard
   * reset), revalidate affected evidence, issue the AI a fresh lease, resume.
   */
  async returnControl(
    id: string,
    opts: { overlappingFiles: string[]; affectedEvidenceIds: string[] },
  ): Promise<TakeoverRecord> {
    const rec = this.require(id);
    this.move(rec, 'RETURN_REQUESTED');
    this.move(rec, 'RECONCILING');
    if (opts.overlappingFiles.length > 0) {
      // The human side is never discarded: explicit merge, recorded.
      const base = rec.humanEdits[rec.humanEdits.length - 1]?.baseRevision ?? rec.snapshotRef ?? 'unknown';
      rec.mergedFiles = await this.hooks.threeWayMerge(opts.overlappingFiles, base);
    }
    this.move(rec, 'REVALIDATING');
    rec.revalidatedEvidence = await this.hooks.revalidateEvidence(
      opts.affectedEvidenceIds,
      rec.humanEdits,
    );
    // Fresh lease for the AI's new worker — the old token stays dead.
    this.leases.reassign(rec.resourceId, rec.runId, 3_600_000);
    this.move(rec, 'RESUMED');
    rec.completedAt = this.iso();
    return this.copy(rec);
  }

  cancel(id: string, reason: string): TakeoverRecord {
    const rec = this.require(id);
    if (rec.state === 'RESUMED') {
      throw new TakeoverError('ALREADY_RESUMED', 'Cannot cancel a completed takeover');
    }
    this.move(rec, 'CANCELLED');
    rec.failureReason = reason;
    return this.copy(rec);
  }

  /** The canonical flow, for docs/tests. */
  static flow(): readonly TakeoverState[] {
    return TAKEOVER_FLOW;
  }

  private require(id: string): TakeoverRecord {
    const rec = this.takeovers.get(id);
    if (!rec) throw new TakeoverError('TAKEOVER_NOT_FOUND', `Takeover ${id} not found`);
    return rec;
  }

  private move(rec: TakeoverRecord, to: TakeoverState): void {
    const allowed = ALLOWED[rec.state] as readonly TakeoverState[];
    if (!allowed.includes(to)) {
      throw new IllegalTakeoverTransition(rec.state, to);
    }
    rec.state = to;
  }

  private fail(rec: TakeoverRecord, reason: string): TakeoverRecord {
    try {
      this.move(rec, 'FAILED');
    } catch (err) {
      if (!(err instanceof IllegalTakeoverTransition)) throw err;
      // Already terminal — record the reason anyway.
    }
    rec.failureReason = reason;
    return this.copy(rec);
  }

  private copy(rec: TakeoverRecord): TakeoverRecord {
    return { ...rec, humanEdits: [...rec.humanEdits], revalidatedEvidence: [...rec.revalidatedEvidence], mergedFiles: [...rec.mergedFiles] };
  }
}

/** Guard for tests: an unwritable takeover must surface, never be swallowed. */
export function assertWriterQuiet(ok: boolean, detail: string): void {
  if (!ok) throw new WriterNotQuiet(detail);
}
