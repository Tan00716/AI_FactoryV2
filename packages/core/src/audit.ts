/**
 * Audit log — spec §70.
 * Append-only and immutable: high-impact actions (agent created, permission
 * granted, file changed, deployment, approval, …) are recorded here and can
 * never be updated or deleted.
 */

import { randomUUID } from 'crypto';
import { AuditRecord, nowIso } from './types';

export interface AuditStore {
  append(r: AuditRecord): void;
  list(): AuditRecord[];
}

export class InMemoryAuditStore implements AuditStore {
  private records: AuditRecord[] = [];
  append(r: AuditRecord): void {
    this.records.push(structuredClone(r));
  }
  list(): AuditRecord[] {
    return this.records.map((r) => structuredClone(r));
  }
}

export class AuditLog {
  constructor(private store: AuditStore = new InMemoryAuditStore()) {}

  /** Record a high-impact action. There is intentionally no update/delete API. */
  record(
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ): AuditRecord {
    const r: AuditRecord = {
      id: randomUUID(),
      ts: nowIso(),
      actor,
      action,
      entityType,
      entityId,
      details: structuredClone(details),
    };
    this.store.append(r);
    return r;
  }

  list(): AuditRecord[] {
    return this.store.list();
  }
}
