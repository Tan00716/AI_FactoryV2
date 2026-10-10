/**
 * In-memory artifact store — spec §23.
 *
 * Lifecycle (evidence-engine semantics): DRAFT → SEALED. Sealed artifacts
 * are immutable: update / delete / link attempts throw ArtifactSealedError.
 * seal() is idempotent.
 *
 * Artifacts are linkable: `relatedIds` form bidirectional edges, so a
 * task's evidence chain (e.g. CODE_CHANGE → TEST_RESULT → FINAL_REPORT)
 * can be traversed from either end via `related()`.
 *
 * The store keeps no I/O and takes an injectable clock, so a SQLite-backed
 * implementation can honor the same contract later.
 */
import { randomUUID } from 'node:crypto';
import {
  Artifact,
  ArtifactNotFoundError,
  ArtifactQuery,
  ArtifactSealedError,
  ArtifactStatus,
  ArtifactType,
  ArtifactUpdate,
  ArtifactValidationError,
  NewArtifact,
} from './types';
import { getSchema } from './schemas';
import { validateFields } from './validate';

export interface ArtifactStoreOptions {
  /** Defaults to `Date.now`; inject a fake clock in tests/demos. */
  now?: () => number;
}

export class ArtifactStore {
  private readonly now: () => number;
  private readonly map = new Map<string, Artifact>();

  constructor(opts: ArtifactStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Defensive copy: callers never hold a live reference. */
  private copy(a: Artifact): Artifact {
    return { ...a, fields: { ...a.fields }, relatedIds: [...a.relatedIds] };
  }

  private mustGet(id: string): Artifact {
    const a = this.map.get(id);
    if (!a) throw new ArtifactNotFoundError(id);
    return a;
  }

  /**
   * Create an artifact. Validates `fields` against the type schema and
   * refuses with ArtifactValidationError (naming the missing/mistyped
   * fields) when the payload is incomplete. `relatedIds`, when given,
   * must reference existing DRAFT artifacts and are linked bidirectionally.
   */
  create(input: NewArtifact): Artifact {
    if (!input.title || input.title.trim().length === 0) {
      throw new ArtifactValidationError(input.type, ['title'], []);
    }
    const schema = getSchema(input.type);
    validateFields(input.type, schema, input.fields);
    const t = this.nowIso();
    const artifact: Artifact = {
      id: randomUUID(),
      taskId: input.taskId,
      type: input.type,
      title: input.title,
      status: 'DRAFT',
      fields: { ...input.fields },
      relatedIds: [],
      createdBy: input.createdBy,
      createdAt: t,
      updatedAt: t,
      sealedAt: null,
    };
    this.map.set(artifact.id, artifact);
    for (const otherId of input.relatedIds ?? []) {
      this.link(artifact.id, otherId);
    }
    return this.copy(this.map.get(artifact.id)!);
  }

  /** Get one artifact by id, or undefined when unknown. */
  get(id: string): Artifact | undefined {
    const a = this.map.get(id);
    return a ? this.copy(a) : undefined;
  }

  /**
   * Query artifacts by taskId and/or type and/or status.
   * Results are ordered by creation time (oldest first).
   */
  query(filter: ArtifactQuery = {}): Artifact[] {
    return [...this.map.values()]
      .filter((a) => (filter.taskId === undefined || a.taskId === filter.taskId))
      .filter((a) => (filter.type === undefined || a.type === filter.type))
      .filter((a) => (filter.status === undefined || a.status === filter.status))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
      .map((a) => this.copy(a));
  }

  /** All artifacts for a task (any type). */
  listByTask(taskId: string): Artifact[] {
    return this.query({ taskId });
  }

  /** All artifacts of one type for a task. */
  listByTaskAndType(taskId: string, type: ArtifactType): Artifact[] {
    return this.query({ taskId, type });
  }

  /**
   * Update a DRAFT artifact's title and/or fields (merged over the
   * existing payload, then re-validated). Throws ArtifactSealedError
   * once sealed.
   */
  update(id: string, patch: ArtifactUpdate): Artifact {
    const a = this.mustGet(id);
    if (a.status === 'SEALED') throw new ArtifactSealedError(id, 'update');
    if (patch.title !== undefined) {
      if (patch.title.trim().length === 0) throw new ArtifactValidationError(a.type, ['title'], []);
      a.title = patch.title;
    }
    if (patch.fields !== undefined) {
      const merged = { ...a.fields, ...patch.fields };
      validateFields(a.type, getSchema(a.type), merged);
      a.fields = merged;
    }
    a.updatedAt = this.nowIso();
    return this.copy(a);
  }

  /**
   * Seal an artifact: DRAFT → SEALED, stamped with sealedAt.
   * Idempotent — sealing an already-SEALED artifact returns it unchanged.
   */
  seal(id: string): Artifact {
    const a = this.mustGet(id);
    if (a.status === 'SEALED') return this.copy(a);
    a.status = 'SEALED';
    a.sealedAt = this.nowIso();
    a.updatedAt = a.sealedAt;
    return this.copy(a);
  }

  /**
   * Delete a DRAFT artifact. Sealed artifacts cannot be deleted
   * (evidence-engine semantics). Link edges are cleaned up.
   */
  delete(id: string): void {
    const a = this.mustGet(id);
    if (a.status === 'SEALED') throw new ArtifactSealedError(id, 'delete');
    for (const otherId of a.relatedIds) {
      const other = this.map.get(otherId);
      if (other) other.relatedIds = other.relatedIds.filter((r) => r !== id);
    }
    this.map.delete(id);
  }

  /**
   * Link two artifacts bidirectionally (evidence chain edge).
   * Both must exist and be DRAFT; linking to a SEALED artifact throws.
   * Idempotent; linking an artifact to itself is a no-op.
   */
  link(aId: string, bId: string): void {
    if (aId === bId) return;
    const a = this.mustGet(aId);
    const b = this.mustGet(bId);
    if (a.status === 'SEALED') throw new ArtifactSealedError(aId, 'link');
    if (b.status === 'SEALED') throw new ArtifactSealedError(bId, 'link');
    if (!a.relatedIds.includes(bId)) a.relatedIds.push(bId);
    if (!b.relatedIds.includes(aId)) b.relatedIds.push(aId);
  }

  /** Resolve an artifact's `relatedIds` to full artifact records. */
  related(id: string): Artifact[] {
    const a = this.mustGet(id);
    return a.relatedIds.map((r) => this.copy(this.mustGet(r)));
  }

  /** Number of artifacts in the store. */
  size(): number {
    return this.map.size;
  }

  /** All artifact statuses (for diagnostics / tests). */
  statuses(): ArtifactStatus[] {
    return [...this.map.values()].map((a) => a.status);
  }
}
