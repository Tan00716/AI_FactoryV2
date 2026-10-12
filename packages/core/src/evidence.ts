/**
 * Evidence Engine — spec §42.
 *
 * Rule: evidence is immutable once it has been consumed by a gate
 * ("Evidence should be immutable once a gate is completed").
 * Lifecycle: DRAFT → (gate consumes it) → SEALED. Sealed evidence
 * cannot be updated or deleted; attempts throw.
 */

import { randomUUID } from 'crypto';
import { Evidence, EvidenceStatus, EvidenceType, nowIso } from './types';

export class EvidenceSealedError extends Error {
  constructor(id: string) {
    super(`Evidence ${id} is SEALED and immutable`);
    this.name = 'EvidenceSealedError';
  }
}

export class EvidenceNotFoundError extends Error {
  constructor(id: string) {
    super(`Evidence ${id} not found`);
    this.name = 'EvidenceNotFoundError';
  }
}

/** Minimal storage contract — in-memory here, SQLite-backed in @ai-factory/db. */
export interface EvidenceStore {
  save(ev: Evidence): void;
  get(id: string): Evidence | undefined;
  listByTask(taskId: string): Evidence[];
  delete(id: string): void;
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private map = new Map<string, Evidence>();
  save(ev: Evidence): void {
    this.map.set(ev.id, { ...ev });
  }
  get(id: string): Evidence | undefined {
    const e = this.map.get(id);
    return e ? { ...e } : undefined;
  }
  listByTask(taskId: string): Evidence[] {
    return [...this.map.values()]
      .filter((e) => e.taskId === taskId)
      .map((e) => ({ ...e }));
  }
  delete(id: string): void {
    this.map.delete(id);
  }
}

export interface CreateEvidenceInput {
  taskId: string;
  type: EvidenceType;
  title: string;
  payload: Record<string, unknown>;
  createdBy: string;
  /**
   * §16/§18.2 — pin ref ('REQ-001@1') of the requirement version this
   * evidence is collected against, when the caller has a real requirement
   * context. Omitted/null = not recorded (gates treat it as not stale).
   */
  requirementVersion?: string | null;
}

export class EvidenceEngine {
  constructor(private store: EvidenceStore = new InMemoryEvidenceStore()) {}

  /** Create a new DRAFT evidence record. */
  create(input: CreateEvidenceInput): Evidence {
    const ev: Evidence = {
      id: randomUUID(),
      taskId: input.taskId,
      type: input.type,
      title: input.title,
      payload: { ...input.payload },
      status: 'DRAFT',
      createdBy: input.createdBy,
      createdAt: nowIso(),
      sealedAt: null,
      requirementVersion: input.requirementVersion ?? null,
    };
    this.store.save(ev);
    return ev;
  }

  /**
   * Update a DRAFT evidence record. Throws EvidenceSealedError when sealed —
   * this is the immutability guarantee of §42.
   */
  update(id: string, patch: Partial<Pick<Evidence, 'title' | 'payload'>>): Evidence {
    const ev = this.store.get(id);
    if (!ev) throw new EvidenceNotFoundError(id);
    if (ev.status === 'SEALED') throw new EvidenceSealedError(id);
    const next: Evidence = {
      ...ev,
      title: patch.title ?? ev.title,
      payload: patch.payload ? { ...patch.payload } : ev.payload,
    };
    this.store.save(next);
    return next;
  }

  /** Delete a DRAFT evidence record. Sealed records cannot be deleted. */
  delete(id: string): void {
    const ev = this.store.get(id);
    if (!ev) throw new EvidenceNotFoundError(id);
    if (ev.status === 'SEALED') throw new EvidenceSealedError(id);
    this.store.delete(id);
  }

  /**
   * Seal evidence consumed by a gate. Called by the workflow engine after a
   * transition is approved. Idempotent.
   */
  seal(id: string): Evidence {
    const ev = this.store.get(id);
    if (!ev) throw new EvidenceNotFoundError(id);
    if (ev.status === 'SEALED') return ev;
    const sealed: Evidence = { ...ev, status: 'SEALED', sealedAt: nowIso() };
    this.store.save(sealed);
    return sealed;
  }

  get(id: string): Evidence {
    const ev = this.store.get(id);
    if (!ev) throw new EvidenceNotFoundError(id);
    return ev;
  }

  listByTask(taskId: string): Evidence[] {
    return this.store.listByTask(taskId);
  }

  statusOf(id: string): EvidenceStatus {
    return this.get(id).status;
  }
}
